import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { buildLadybug } from "./ladybugModel";
import type { LadybugRig } from "./ladybugModel";

export type LadybugMode = "idle" | "walking" | "airborne" | "dragging";

/**
 * Emotional overlay on top of the movement mode:
 * - sniffing: scanning, nose down with a magnifying glass
 * - expectant: a link is being dragged over it, looking up
 * - happy / nervous / alarmed: reactions to a verdict
 */
export type LadybugMood = "calm" | "sniffing" | "expectant" | "happy" | "nervous" | "alarmed";

export type LadybugPose = {
  mode: LadybugMode;
  /** Horizontal on-screen velocity in px/s (positive = right). */
  vx: number;
  /** Which way the bug should face while it moves. */
  heading: 1 | -1;
  /** Defaults to "calm". */
  mood?: LadybugMood;
};

export type LadybugViewport = {
  /** Canvas size in CSS px. */
  width: number;
  height: number;
  /** CSS px per model unit, at the bug. */
  unitPx: number;
  /** Distance from the bottom of the canvas to the ground line, in CSS px. */
  groundPx: number;
};

/** Yaw (radians) while walking: a three-quarter view so the face stays visible. */
const WALK_YAW = 1.1;
/** Model units travelled per full gait cycle. */
const STRIDE = 0.22;
const CAMERA_DISTANCE = 6;
const CAMERA_PITCH = THREE.MathUtils.degToRad(15);
/** How far forward (model units) the front feet reach; they're kept on the ground line. */
const FRONT_FEET_Z = 0.22;
const IDLE_GLANCES = [0, 0, 0, 0.45, -0.45, 0.25, -0.25];
const SPIN_SECONDS = 0.7;
const FLARE_SECONDS = 1.4;
const FLASH_SECONDS = 2.6;
const ALARM_TINT = new THREE.Color("#ff2414");
/** Sideways offset of the magnifying glass from the bug's nose. */
const LENS_X = 0.2;

const randomBetween = (min: number, max: number) => min + Math.random() * (max - min);
/** Frame-rate independent smoothing factor. */
const ease = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);
const approach = (value: number, target: number, rate: number, dt: number) =>
  value + (target - value) * ease(rate, dt);

function createShadowTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, "rgba(40, 18, 10, 0.4)");
  gradient.addColorStop(0.6, "rgba(40, 18, 10, 0.18)");
  gradient.addColorStop(1, "rgba(40, 18, 10, 0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(canvas);
}

export class LadybugRenderer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera();
  private readonly rig: LadybugRig;
  /** Screen-plane tilt, pivoting around the middle of the body. */
  private readonly sway = new THREE.Group();
  private readonly shadow: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly environment: THREE.Texture;

  private viewport: LadybugViewport;
  private framedAnchorZ = Number.NaN;
  private time = 0;
  private yaw = 0;
  private gait = 0;
  private phase = 0;
  private open = 0;
  private vx = 0;
  private tilt = 0;
  private headTilt = 0;
  private squash = 0;
  private squashVelocity = 0;
  private blinkIn = randomBetween(1.5, 4);
  private blink = 0;
  private glance = 0;
  private glanceIn = randomBetween(2, 5);

  private mood: LadybugMood = "calm";
  /** Seconds since the mood last changed. */
  private moodTime = 0;
  /** Smoothed 0–1 weight of each non-calm mood. */
  private sniff = 0;
  private expect = 0;
  private happy = 0;
  private nervous = 0;
  private alarmed = 0;
  /** 0–1 progress of a celebration spin, or -1 when not spinning. */
  private spin = -1;
  private spinDirection: 1 | -1 = 1;
  private flare = 0;
  private flash = 0;
  private tint = 0;
  private lens = 0;
  private lensSide: 1 | -1 = 1;
  private lensX = -LENS_X;

  constructor(canvas: HTMLCanvasElement, viewport: LadybugViewport) {
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.toneMapping = THREE.NeutralToneMapping;

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.environment = pmrem.fromScene(room, 0.04).texture;
    room.dispose();
    pmrem.dispose();
    this.scene.environment = this.environment;
    this.scene.environmentIntensity = 0.55;

    this.scene.add(new THREE.HemisphereLight("#fff4e6", "#7a5a4a", 1.1));
    const key = new THREE.DirectionalLight("#fff1dc", 2.2);
    key.position.set(-1.5, 3, 2.5);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight("#cfe2ff", 1.2);
    rim.position.set(2, 1.5, -2);
    this.scene.add(rim);

    this.rig = buildLadybug();
    this.sway.position.y = 0.22;
    this.rig.root.position.y = -0.22;
    this.sway.add(this.rig.root);
    this.scene.add(this.sway);

    const shadowTexture = createShadowTexture();
    this.shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false }),
    );
    this.shadow.scale.set(0.85, 1, 0.6);
    this.shadow.position.y = 0.001;
    this.scene.add(this.shadow);

    this.viewport = viewport;
    this.renderer.setSize(viewport.width, viewport.height, false);
    this.frameCamera(0);
  }

  /**
   * Frames the camera so that `unitPx` CSS px = 1 model unit at the bug and the
   * ground point (0, 0, anchorZ) lands exactly `groundPx` above the bottom of
   * the canvas. The camera looks down, so ground in front of the bug projects
   * lower on screen; anchoring at the front feet keeps them on the ground line.
   */
  private frameCamera(anchorZ: number) {
    if (Math.abs(anchorZ - this.framedAnchorZ) < 0.002) return;
    this.framedAnchorZ = anchorZ;
    const { width, height, unitPx, groundPx } = this.viewport;
    const d = CAMERA_DISTANCE;
    const halfFov = Math.atan(height / (2 * d * unitPx));
    const tanHalf = Math.tan(halfFov);
    const cos = Math.cos(CAMERA_PITCH);
    const sin = Math.sin(CAMERA_PITCH);
    // Desired NDC height of the anchor, then solve for the look-at height.
    const g = (2 * groundPx) / height - 1;
    const targetY =
      -(g * tanHalf * (d - anchorZ * cos) + anchorZ * sin) / (cos + g * tanHalf * sin);

    this.camera.fov = THREE.MathUtils.radToDeg(halfFov * 2);
    this.camera.aspect = width / height;
    this.camera.near = 0.1;
    this.camera.far = 50;
    this.camera.position.set(0, targetY + d * sin, d * cos);
    this.camera.lookAt(0, targetY, 0);
    this.camera.updateProjectionMatrix();
  }

  /** Squash on landing. `impact` is the downward speed in px/s. */
  land(impact: number) {
    this.squashVelocity -= Math.min(impact / 260, 7);
  }

  /** A full happy spin, best started together with a hop. */
  celebrate(direction: 1 | -1 = 1) {
    this.spin = 0;
    this.spinDirection = direction;
  }

  /** Wings flare open and the body flashes red. */
  alarm() {
    this.flare = FLARE_SECONDS;
    this.flash = FLASH_SECONDS;
  }

  render(pose: LadybugPose, dt: number) {
    this.time += dt;
    const t = this.time;
    const { mode } = pose;
    const mood = pose.mood ?? "calm";
    const walking = mode === "walking";
    const held = mode === "dragging";
    const airborne = mode === "airborne";
    const rig = this.rig;

    this.vx += (pose.vx - this.vx) * ease(10, dt);

    if (mood !== this.mood) {
      this.mood = mood;
      this.moodTime = 0;
    } else {
      this.moodTime += dt;
    }
    this.sniff = approach(this.sniff, mood === "sniffing" ? 1 : 0, 5, dt);
    this.expect = approach(this.expect, mood === "expectant" ? 1 : 0, 9, dt);
    this.happy = approach(this.happy, mood === "happy" ? 1 : 0, 5, dt);
    this.nervous = approach(this.nervous, mood === "nervous" ? 1 : 0, 5, dt);
    this.alarmed = approach(this.alarmed, mood === "alarmed" ? 1 : 0, 8, dt);
    // Reactions are loudest right after the verdict and settle down after.
    const fresh = 0.3 + 0.7 * Math.exp(-this.moodTime / 2.5);

    // Facing: three-quarter view while moving, glance around while idle.
    // Looking up at a dragged link, or celebrating, it faces the viewer.
    const facesViewer = mood === "expectant" || mood === "happy";
    if (mode === "idle" && !facesViewer) {
      this.glanceIn -= dt;
      if (this.glanceIn <= 0) {
        this.glance =
          IDLE_GLANCES[Math.floor(Math.random() * IDLE_GLANCES.length)] *
          (mood === "sniffing" ? 0.5 : 1);
        this.glanceIn = randomBetween(1.5, 4.5);
      }
    } else {
      this.glance = 0;
    }
    const targetYaw =
      mode === "idle" ? this.glance : held ? pose.heading * 0.3 : pose.heading * WALK_YAW;
    this.yaw += (targetYaw - this.yaw) * ease(walking ? 8 : 5, dt);
    let spinYaw = 0;
    if (this.spin >= 0) {
      this.spin = Math.min(1, this.spin + dt / SPIN_SECONDS);
      spinYaw = this.spinDirection * Math.PI * 2 * THREE.MathUtils.smootherstep(this.spin, 0, 1);
      if (this.spin >= 1) this.spin = -1;
    }
    const yaw = this.yaw + spinYaw;
    rig.root.rotation.y = yaw;
    this.frameCamera(FRONT_FEET_Z * Math.cos(yaw));

    // Gait phase. Walking cadence follows ground speed so feet don't skate.
    const gaitTarget = walking || held ? 1 : 0;
    this.gait += (gaitTarget - this.gait) * ease(8, dt);
    const cadence = walking
      ? Math.abs(pose.vx) / (this.viewport.unitPx * STRIDE)
      : held
        ? 4.5
        : airborne
          ? 2.5
          : 0;
    this.phase += cadence * Math.PI * 2 * dt;

    for (const leg of rig.legs) {
      const p = this.phase + leg.tripod * Math.PI;
      const swing = Math.sin(p) * 0.5 * this.gait;
      const lift = Math.max(0, Math.cos(p)) * 0.4 * this.gait;
      const dangle = airborne ? -0.35 + Math.sin(p) * 0.15 : 0;
      leg.pivot.rotation.set(0, -leg.side * swing, leg.side * (lift + dangle));
    }

    // Body: bob and waddle while walking, breathe while idle. Happy: a
    // bouncy butt wiggle. Nervous or alarmed: lean back. Pitch pivots on
    // whichever feet stay down, so the others don't sink into the ground.
    const stepBob = Math.abs(Math.sin(this.phase)) * this.gait;
    const wiggle = this.happy * fresh * (airborne || held ? 0.3 : 1);
    const pitch = this.sniff * 0.07 - this.nervous * 0.13 - this.alarmed * 0.1 - this.expect * 0.05;
    rig.body.position.y =
      (walking ? stepBob * 0.012 : 0) +
      Math.abs(Math.sin(t * 7.5)) * 0.025 * wiggle +
      Math.abs(pitch) * 0.2;
    rig.body.rotation.x = pitch;
    rig.body.rotation.y = Math.sin(t * 7.5) * 0.14 * wiggle;
    rig.body.rotation.z =
      Math.sin(this.phase) * 0.05 * this.gait + Math.sin(t * 15) * 0.1 * wiggle;
    rig.body.scale.y = 1 + Math.sin(t * 2.4) * 0.012 + this.expect * 0.03;

    // Head: curious tilt when idle, nod while walking. Sniffing: nose to the
    // ground in quick bursts of little nods. Expectant: looks up.
    const tiltTarget = mode === "idle" ? Math.sin(t * 0.6) * (0.14 - this.expect * 0.08) : 0;
    this.headTilt += (tiltTarget - this.headTilt) * ease(3, dt);
    rig.head.rotation.z = this.headTilt;
    const sniffBurst = Math.max(0, Math.sin(t * 1.9)) ** 2;
    const sniffNod = Math.sin(t * 17) * 0.08 * sniffBurst;
    rig.head.rotation.x =
      Math.sin(this.phase * 2) * 0.05 * this.gait +
      this.sniff * (0.3 + sniffNod) -
      this.expect * 0.45 -
      this.alarmed * 0.12;

    // Antennae: lazy sway, springy when moving, frantic when held. Sniffing
    // makes them twitch; nervous sweeps them back; alarmed stands them up
    // stiff and quivering; expectant perks them forward.
    for (const { pivot, side } of rig.antennae) {
      const frantic = held ? Math.sin(t * 22 + side) * 0.25 : 0;
      const twitch =
        this.sniff * Math.max(0, Math.sin(t * 2.6 + side * 1.3)) ** 3 * Math.sin(t * 34 + side);
      const quiver = this.alarmed * Math.sin(t * 41 + side) * 0.07;
      pivot.rotation.z =
        side * (Math.sin(t * 2.2 + side) * 0.1 + stepBob * 0.12) +
        frantic +
        twitch * 0.3 +
        quiver +
        side * (this.nervous * 0.15 - this.alarmed * 0.3 + Math.sin(t * 15) * 0.08 * wiggle);
      pivot.rotation.x =
        Math.sin(t * 1.7 + side * 2) * 0.12 -
        (airborne ? 0.3 : 0) +
        twitch * 0.2 -
        this.nervous * 0.4 +
        this.expect * 0.25;
    }

    // Blinking.
    this.blinkIn -= dt;
    if (this.blinkIn <= 0) {
      this.blink = 0.14;
      this.blinkIn = randomBetween(2, 5.5);
    }
    this.blink = Math.max(0, this.blink - dt);
    // Happy squints into ^ ^; alarm and anticipation open the eyes wide.
    const wide = 1 + 0.2 * Math.max(this.alarmed, this.expect);
    const eyeOpen = (this.blink > 0 ? 0.1 : 1) * (1 - 0.45 * this.happy) * wide;
    for (const eye of rig.eyes) {
      eye.scale.y += (eyeOpen - eye.scale.y) * ease(40, dt);
      eye.scale.x = wide;
    }
    // The smile flattens, then turns into a frown.
    rig.mouth.scale.y = 1 - 2 * Math.max(this.nervous, this.alarmed) * 0.85;

    // Wing cases pop open and the wings buzz while in the air, or flare in alarm.
    this.flare = Math.max(0, this.flare - dt);
    const flaring = this.flare > 0;
    const openTarget = airborne || flaring ? 1 : 0;
    this.open += (openTarget - this.open) * ease(airborne || flaring ? 12 : 7, dt);
    for (const { pivot, side } of rig.elytra) {
      pivot.rotation.set(this.open * 0.5, -side * this.open * 0.25, side * this.open * 0.4);
    }
    for (const { pivot, side } of rig.wings) {
      pivot.visible = this.open > 0.05;
      const flap = Math.sin(t * Math.PI * 2 * 13 + (side === 1 ? 0 : 0.4));
      pivot.rotation.set(
        this.open * 0.25,
        -side * this.open * 0.9,
        side * this.open * (0.75 + flap * 0.4),
      );
      pivot.scale.setScalar(Math.max(this.open, 0.001));
    }

    // Alarm: a hard red flash that settles into a slow warning pulse.
    this.flash = Math.max(0, this.flash - dt);
    const flashing = Math.min(1, this.flash / 0.6);
    const tint =
      flashing * (0.5 + 0.5 * Math.sin(t * 20)) * 0.9 +
      this.alarmed * (0.12 + 0.1 * Math.sin(t * 4.5));
    if (Math.abs(tint - this.tint) > 0.002) {
      this.tint = tint;
      rig.setTint(ALARM_TINT, tint);
    }

    // Tilt with horizontal motion when held or flung. Nervous or freshly
    // alarmed: trembling.
    const tiltGoal = held || airborne ? THREE.MathUtils.clamp(-this.vx / 2400, -0.45, 0.45) : 0;
    this.tilt += (tiltGoal - this.tilt) * ease(8, dt);
    const tremble = this.nervous * 0.7 + this.alarmed * (0.3 + flashing * 0.7);
    this.sway.rotation.z = this.tilt + Math.sin(t * 53) * 0.03 * tremble;
    this.sway.position.x = (Math.sin(t * 61) * 0.006 + Math.sin(t * 37) * 0.004) * tremble;

    // Magnifying glass: floats ahead of the nose on the viewer's side of the
    // head (local -x when heading right, since yaw turns +x away), turned
    // toward the viewer, bobbing with each sniff.
    this.lens = approach(this.lens, mood === "sniffing" ? 1 : 0, 7, dt);
    const magnifier = rig.magnifier;
    magnifier.visible = this.lens > 0.01;
    if (magnifier.visible) {
      if (walking || held) this.lensSide = pose.heading;
      this.lensX = approach(this.lensX, -this.lensSide * LENS_X, 5, dt);
      const pop = THREE.MathUtils.smootherstep(this.lens, 0, 1);
      // Handle toward the bug's back; squashing x through 0 reads as the glass
      // turning over.
      const flip = THREE.MathUtils.clamp(this.lensX / LENS_X, -1, 1);
      magnifier.scale.set(pop * flip, pop, pop);
      magnifier.position.set(
        this.lensX,
        0.27 + Math.sin(t * 2.1) * 0.015 - sniffNod * 0.12,
        0.52,
      );
      magnifier.rotation.set(0.12 + sniffNod * 0.6, -yaw * 0.85, Math.sin(t * 1.3) * 0.06);
    }

    // Squash and stretch spring.
    const stiffness = 320;
    const damping = 14;
    this.squashVelocity += (-stiffness * this.squash - damping * this.squashVelocity) * dt;
    this.squash += this.squashVelocity * dt;
    const s = THREE.MathUtils.clamp(this.squash, -0.3, 0.3);
    rig.root.scale.set(1 - s * 0.6, 1 + s, 1 - s * 0.6);

    // Contact shadow only while on the ground.
    const grounded = mode === "idle" || walking;
    const material = this.shadow.material;
    material.opacity += ((grounded ? 1 : 0) - material.opacity) * ease(12, dt);
    this.shadow.visible = material.opacity > 0.01;

    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.rig.dispose();
    this.shadow.geometry.dispose();
    this.shadow.material.map?.dispose();
    this.shadow.material.dispose();
    this.environment.dispose();
    this.renderer.dispose();
  }
}
