import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { CLOTH_SECONDS, ClothBake, sampleCloth } from "./blanketCloth.ts";
import { SLEEP_DROP, buildLadybug } from "./ladybugModel.ts";
import type { LadybugRig } from "./ladybugModel.ts";

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
  /**
   * While idle, look this way (yaw in radians; positive turns the face to the
   * right of the screen) instead of glancing around at random.
   */
  look?: number;
  /**
   * While sniffing and standing still: a close inspection, holding the
   * magnifying glass up to one eye with only short breaks, instead of an
   * occasional peek.
   */
  inspect?: boolean;
  /**
   * 0 to 1: grooming. Standing still, it rubs its head and antennae with its
   * front legs, faster and more thoroughly as this rises.
   */
  groom?: number;
  /**
   * 0 to 1: eating. Standing still, it turns the way it's heading, puts its
   * head down to what's on the ground in front of it and nibbles, faster as
   * this rises.
   */
  eat?: number;
  /**
   * 0 to 1: how far the wing cases are held open, with the wings buzzing
   * underneath. Adds to whatever the mood and reactions already do.
   */
  wings?: number;
  /**
   * Bedtime. Drowsy: heavy-eyed. Asleep (best
   * while idle): lies down under a blanket and snores until this is unset,
   * then throws the blanket off.
   */
  sleep?: "drowsy" | "asleep";
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
const SPIN_SECONDS = 0.7;
const FLARE_SECONDS = 1.4;
const FLASH_SECONDS = 2.6;
const ALARM_TINT = new THREE.Color("#ff2414");
/** Sideways offset of the magnifying glass from the bug's nose. */
const LENS_X = 0.2;
/** How far in front of the eye (toward the camera) the lens sits while peeking. */
const PEEK_GAP = 0.1;
/** How much the eye behind the lens swells while peeking. */
const PEEK_ZOOM = 0.45;
/** Grooming strokes per second for each front leg, at the lowest and highest intensity. */
const GROOM_RATE = [1.6, 3.4] as const;
/** Grooming intensity at which the front legs are fully raised; below it they ease down. */
const GROOM_RAISED = 0.2;
/** How far (radians) the head dips while grooming. */
const GROOM_DIP = 0.12;
/** How far the front hips shift out, up and forward to reach the face, and the legs stretch. */
const GROOM_HIP = new THREE.Vector3(0.02, 0.05, 0.12);
const GROOM_STRETCH = 0.3;
/** Nibbles per second while eating, at the lowest and highest appetite. */
const NIBBLE_RATE = [3.5, 6.5] as const;
/** How far (radians) the head goes down to the food, and bobs with each nibble. */
const EAT_DIP = 0.34;
const EAT_NIBBLE = 0.07;
/** One snore: a breath in, then a long breath out. */
const SNORE_SECONDS = 3.4;
/** The part of each snore spent breathing in. */
const INHALE = 0.4;
/** Yaw while asleep, a three-quarter view so the blanket shows. */
const SLEEP_YAW = 0.6;
/** How long the blanket takes to fade in at the start of its fall. */
const BLANKET_FADE_SECONDS = 0.5;
/** Time per frame spent baking the blanket's fall while the bug gets drowsy. */
const BAKE_BUDGET_MS = 3;
const TOSS_SECONDS = 0.55;

/** The blanket's fall, baked once (the bug is the same everywhere) and shared. */
let clothBake: ClothBake | null = null;

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
  /** The yaw last drawn, spins included. */
  private drawnYaw = 0;
  private gait = 0;
  private phase = 0;
  private open = 0;
  private buzz = 0;
  private vx = 0;
  private tilt = 0;
  private headTilt = 0;
  private squash = 0;
  private squashVelocity = 0;
  private blinkIn = randomBetween(1.5, 4);
  private blink = 0;
  private startleLeft = 0;

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
  /** 0–1: the magnifying glass is held up in front of one eye for a closer look. */
  private peek = 0;
  private peekLeft = 0;
  private peekIn = randomBetween(1.2, 2.5);
  /** Smoothed 0–1 grooming intensity, and its stroke phase in cycles. */
  private groom = 0;
  private groomPhase = 0;
  /** Smoothed 0–1: head down at the food. Then the appetite, and the nibbling phase in cycles. */
  private eat = 0;
  private appetite = 0;
  private nibblePhase = 0;
  private readonly hips: THREE.Vector3[];
  private readonly reach = new THREE.Vector3();
  private readonly bend = new THREE.Vector3();
  private readonly femur = new THREE.Vector3();
  private readonly shin = new THREE.Vector3();
  private readonly hipTurn = new THREE.Quaternion();
  private readonly kneeTurn = new THREE.Quaternion();
  private readonly eyePoint = new THREE.Vector3();
  private readonly otherEyePoint = new THREE.Vector3();
  private readonly toCamera = new THREE.Vector3();

  private sleep: LadybugPose["sleep"];
  /** 0–1: heavy eyelids, from drowsy on. */
  private drowse = 0;
  /** 0–1: lying down asleep. */
  private rest = 0;
  /** 0–1: the blanket falling and settling over the bug. */
  private tuck = 0;
  /** The fall progress the blanket's mesh last showed. */
  private drawnTuck = -1;
  private blanketOpacity = 1;
  /** 0–1 progress of throwing the blanket off on waking, or -1. */
  private toss = -1;
  /** Seconds of snoring so far, timing the breaths. */
  private snoreTime = 0;
  private snores = 0;
  /** A breath out has started and hasn't been collected by takeSnore. */
  private snorePending = false;
  private readonly snorePoint = new THREE.Vector3();

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
    this.hips = this.rig.legs.map((leg) => leg.pivot.position.clone());
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

  /** Call when the canvas changes size. */
  resize(viewport: LadybugViewport) {
    this.viewport = viewport;
    this.renderer.setSize(viewport.width, viewport.height, false);
    this.framedAnchorZ = Number.NaN;
  }

  /** Startled: antennae go frantic and the body shivers for a moment. */
  /**
   * Which way the bug faced in the last frame drawn, in radians: 0 is facing
   * the viewer, positive turns its face toward the right of the screen.
   */
  get facing() {
    return this.drawnYaw;
  }

  startle(seconds = 2.5) {
    this.startleLeft = Math.max(this.startleLeft, seconds);
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
    this.startleLeft = Math.max(0, this.startleLeft - dt);
    const startled = this.startleLeft > 0;

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

    // Bedtime: lie down, blanket on, snore. Waking throws the blanket off.
    const sleep = pose.sleep;
    if (sleep !== this.sleep) {
      if (sleep === undefined && this.tuck > 0) {
        this.toss = 0;
        // Eyes fly open and the bug perks up with a little stretch.
        this.startle(0.9);
        this.squashVelocity += 2.6;
      }
      if (sleep === "asleep") {
        this.snoreTime = 0;
        this.snores = 0;
      }
      this.sleep = sleep;
    }
    const asleep = sleep === "asleep";
    this.drowse = approach(this.drowse, sleep ? 1 : 0, sleep ? 1.5 : 10, dt);
    this.rest = approach(this.rest, asleep && mode === "idle" ? 1 : 0, asleep ? 1.8 : 9, dt);
    // Bake the blanket's fall a little each frame from when the bug gets
    // drowsy, so it's ready by the time it lies down (or finish it then).
    if (sleep) {
      clothBake ??= new ClothBake(rig.blanketShape);
      if (!clothBake.result) {
        if (asleep && this.rest > 0.65) clothBake.finish();
        else clothBake.advance(BAKE_BUDGET_MS);
      }
    }
    if (asleep && this.toss < 0 && this.rest > 0.65) this.tuck = Math.min(1, this.tuck + dt / CLOTH_SECONDS);
    if (this.toss >= 0) {
      this.toss = Math.min(1, this.toss + dt / TOSS_SECONDS);
      if (this.toss >= 1) {
        this.toss = -1;
        this.tuck = 0;
      }
    }
    // Breathing: in, then a long, slow out. Gets going once tucked in.
    const snoring = asleep && this.tuck >= 1;
    let breath = 0;
    if (snoring) {
      const before = this.snoreTime / SNORE_SECONDS;
      this.snoreTime += dt;
      const after = this.snoreTime / SNORE_SECONDS;
      // A new breath out each time the cycle crosses the end of the inhale.
      if (Math.floor(after - INHALE) > Math.floor(before - INHALE)) {
        this.snores++;
        this.snorePending = true;
      }
      const p = after % 1;
      breath = p < INHALE
        ? THREE.MathUtils.smootherstep(p, 0, INHALE)
        : 1 - THREE.MathUtils.smootherstep(p, INHALE, 1);
    } else {
      this.snorePending = false;
      this.snores = 0;
    }
    const sleepWeight = this.rest;
    // Now and then while sniffing, hold the magnifying glass up to one eye.
    // Inspecting, it's up most of the time.
    const inspecting = mood === "sniffing" && mode === "idle" && pose.inspect === true;
    if (inspecting) this.peekIn = Math.min(this.peekIn, 0.9);
    if (mood === "sniffing" && (mode === "idle" || walking) && this.lens > 0.9) {
      if (this.peekLeft > 0) {
        this.peekLeft -= dt;
        if (this.peekLeft <= 0) this.peekIn = inspecting ? randomBetween(0.5, 0.9) : randomBetween(2.5, 5.5);
      } else {
        this.peekIn -= dt;
        if (this.peekIn <= 0) this.peekLeft = inspecting ? randomBetween(2.4, 4) : randomBetween(1.4, 2.2);
      }
    } else {
      this.peekLeft = 0;
      if (mood !== "sniffing") this.peekIn = randomBetween(1.2, 2.5);
    }
    this.peek = approach(this.peek, this.peekLeft > 0 ? 1 : 0, 6, dt);
    const peeking = THREE.MathUtils.smootherstep(this.peek, 0, 1);
    // Reactions are loudest right after the verdict and settle down after.
    const fresh = 0.3 + 0.7 * Math.exp(-this.moodTime / 2.5);
    // Grooming: only standing still, and not while searching with the glass.
    // Each front leg loops over its side of the face, half a stroke apart.
    const groomGoal =
      mode === "idle" ? THREE.MathUtils.clamp(pose.groom ?? 0, 0, 1) * (1 - this.lens) : 0;
    this.groom = approach(this.groom, groomGoal, groomGoal > this.groom ? 4 : 12, dt);
    if (groomGoal === 0 && this.groom < 0.001) this.groom = 0;
    const grooming = THREE.MathUtils.smootherstep(this.groom, 0, GROOM_RAISED);
    this.groomPhase =
      this.groom > 0
        ? this.groomPhase + THREE.MathUtils.lerp(GROOM_RATE[0], GROOM_RATE[1], this.groom) * dt
        : 0;
    /** 0 = foot at the top of the face, then down across the eye and back up clear of it. */
    const stroke = (side: 1 | -1) => (this.groomPhase + (side === 1 ? 0 : 0.5)) * Math.PI * 2;
    /** 0–1: this side's foot is rubbing down over the eye. */
    const rubbing = (side: 1 | -1) => grooming * Math.max(0, Math.sin(stroke(side))) ** 2;

    // Eating: only standing still, and not while searching with the glass.
    const eatGoal = mode === "idle" ? THREE.MathUtils.clamp(pose.eat ?? 0, 0, 1) * (1 - this.lens) : 0;
    this.eat = approach(this.eat, eatGoal > 0 ? 1 : 0, eatGoal > 0 ? 7 : 10, dt);
    if (eatGoal === 0 && this.eat < 0.001) this.eat = 0;
    this.appetite = approach(this.appetite, eatGoal, 6, dt);
    const eating = THREE.MathUtils.smootherstep(this.eat, 0, 1);
    this.nibblePhase =
      this.eat > 0
        ? this.nibblePhase + THREE.MathUtils.lerp(NIBBLE_RATE[0], NIBBLE_RATE[1], this.appetite) * dt
        : 0;
    const nibble = eating * Math.sin(this.nibblePhase * Math.PI * 2);

    // Facing: three-quarter view while moving, straight ahead while idle
    // (unless asked to look somewhere). Looking up at a dragged link, or
    // celebrating, it faces the viewer.
    const facesViewer = mood === "expectant" || mood === "happy";
    const glance =
      mode === "idle" && !facesViewer && pose.look !== undefined
        ? THREE.MathUtils.clamp(pose.look, -0.7, 0.7)
        : 0;
    // Eating, it stays side-on to the food it walked up to.
    const targetYaw =
      mode === "idle"
        ? asleep ? pose.heading * SLEEP_YAW : eatGoal > 0 ? pose.heading * WALK_YAW : glance
        : held ? pose.heading * 0.3 : pose.heading * WALK_YAW;
    this.yaw += (targetYaw - this.yaw) * ease(walking || eatGoal > 0 ? 8 : asleep ? 2.5 : 5, dt);
    let spinYaw = 0;
    if (this.spin >= 0) {
      this.spin = Math.min(1, this.spin + dt / SPIN_SECONDS);
      spinYaw = this.spinDirection * Math.PI * 2 * THREE.MathUtils.smootherstep(this.spin, 0, 1);
      if (this.spin >= 1) this.spin = -1;
    }
    const yaw = this.yaw + spinYaw;
    this.drawnYaw = yaw;
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

    // Under the blanket the folded legs are out of sight (and would poke through it).
    const legsCovered = this.tuck > 0.45 && this.toss < 0;
    for (const leg of rig.legs) {
      leg.pivot.visible = !legsCovered;
      const p = this.phase + leg.tripod * Math.PI;
      const swing = Math.sin(p) * 0.5 * this.gait;
      const lift = Math.max(0, Math.cos(p)) * 0.4 * this.gait;
      const dangle = airborne ? -0.35 + Math.sin(p) * 0.15 : 0;
      // Lying down, the legs fold up under the body.
      const fold = this.rest * (0.95 - leg.tripod * 0.15);
      leg.pivot.rotation.set(0, -leg.side * swing * (1 - this.rest), leg.side * (lift + dangle + fold));
    }

    // Body: bob and waddle while walking, breathe while idle. Happy: a
    // bouncy butt wiggle. Nervous or alarmed: lean back. Pitch pivots on
    // whichever feet stay down, so the others don't sink into the ground.
    const stepBob = Math.abs(Math.sin(this.phase)) * this.gait;
    const wiggle = this.happy * fresh * (airborne || held ? 0.3 : 1);
    const pitch =
      this.sniff * 0.07 -
      this.nervous * 0.13 -
      this.alarmed * 0.1 -
      this.expect * 0.05 -
      grooming * 0.05 +
      eating * 0.09;
    rig.body.position.y =
      (walking ? stepBob * 0.012 : 0) +
      Math.abs(Math.sin(t * 7.5)) * 0.025 * wiggle +
      Math.abs(pitch) * 0.2 -
      SLEEP_DROP * this.rest;
    rig.body.rotation.x = pitch;
    rig.body.rotation.y = Math.sin(t * 7.5) * 0.14 * wiggle;
    rig.body.rotation.z =
      Math.sin(this.phase) * 0.05 * this.gait + Math.sin(t * 15) * 0.1 * wiggle;
    // Asleep, each breath in swells the body (and the blanket over it).
    rig.body.scale.y =
      1 + Math.sin(t * 2.4) * 0.012 * (1 - this.rest) + this.expect * 0.03 + breath * 0.045 * sleepWeight;
    rig.body.scale.x = rig.body.scale.z = 1 + breath * 0.018 * sleepWeight;

    // Head: curious tilt when idle, nod while walking. Sniffing: nose to the
    // ground in quick bursts of little nods. Expectant: looks up.
    // Asleep: head tipped over to one side, nodding with each breath.
    const tiltTarget =
      mode === "idle"
        ? THREE.MathUtils.lerp(Math.sin(t * 0.6) * (0.14 - this.expect * 0.08), -pose.heading * 0.26, this.rest) * (1 - eating)
        : 0;
    this.headTilt += (tiltTarget - this.headTilt) * ease(3, dt);
    rig.head.rotation.z = this.headTilt;
    const sniffBurst = Math.max(0, Math.sin(t * 1.9)) ** 2;
    // Peeking through the glass, the head comes up and holds still.
    const sniffNod = Math.sin(t * 17) * 0.08 * sniffBurst * (1 - peeking);
    rig.head.rotation.x =
      Math.sin(this.phase * 2) * 0.05 * this.gait +
      this.sniff * (0.3 * (1 - peeking * 0.85) + sniffNod) -
      this.expect * 0.45 -
      this.alarmed * 0.12 +
      this.drowse * 0.06 * (1 - this.rest) -
      this.rest * (0.16 - breath * 0.06) +
      grooming * (GROOM_DIP + Math.sin(this.groomPhase * Math.PI * 4) * 0.04) +
      eating * EAT_DIP +
      nibble * EAT_NIBBLE;
    // Grooming: leans into whichever leg is rubbing.
    rig.head.rotation.z += (rubbing(-1) - rubbing(1)) * 0.07;

    // Antennae: lazy sway, springy when moving, frantic when held or startled. Sniffing
    // makes them twitch; nervous sweeps them back; alarmed stands them up
    // stiff and quivering; expectant perks them forward. Grooming bends them
    // down in front of the face, and each stroke combs one down further.
    for (const { pivot, side } of rig.antennae) {
      const comb = grooming * 0.35 + rubbing(side) * 0.5;
      const frantic = held || startled ? Math.sin(t * 22 + side) * 0.25 : 0;
      const twitch =
        this.sniff * Math.max(0, Math.sin(t * 2.6 + side * 1.3)) ** 3 * Math.sin(t * 34 + side);
      const quiver = this.alarmed * Math.sin(t * 41 + side) * 0.07;
      // Drowsy, they wilt; asleep, they flop out and rise and fall with each breath.
      const limp = this.drowse * 0.25 + this.rest * (0.4 - breath * 0.12);
      pivot.rotation.z =
        side * (Math.sin(t * 2.2 + side) * 0.1 * (1 - this.rest * 0.8) + stepBob * 0.12 + limp) +
        frantic +
        twitch * 0.3 +
        quiver +
        side * (this.nervous * 0.15 - this.alarmed * 0.3 + Math.sin(t * 15) * 0.08 * wiggle);
      pivot.rotation.x =
        Math.sin(t * 1.7 + side * 2) * 0.12 -
        (airborne ? 0.3 : 0) +
        twitch * 0.2 -
        this.nervous * 0.4 +
        this.expect * 0.25 -
        this.rest * 0.2 +
        comb +
        // Eating: they reach down to the food and tap at it between nibbles.
        eating * 0.55 +
        nibble * 0.1 * side;
      pivot.rotation.z -= side * comb * 0.5;
    }

    // Grooming: the front legs reach up to the face (two-bone IK from hip to
    // foot) and blend in over whatever the legs were doing.
    rig.head.updateMatrix();
    rig.legs.forEach((leg, i) => {
      if (!leg.front) return;
      const { pivot, knee, side } = leg;
      pivot.position.copy(this.hips[i]);
      if (grooming === 0) {
        pivot.scale.setScalar(1);
        knee.rotation.set(0, 0, 0);
        return;
      }
      pivot.position.x += side * GROOM_HIP.x * grooming;
      pivot.position.y += GROOM_HIP.y * grooming;
      pivot.position.z += GROOM_HIP.z * grooming;
      const stretch = 1 + GROOM_STRETCH * grooming;
      pivot.scale.setScalar(stretch);
      // Foot target on a loop around the eye: pressed close on the way down,
      // lifted clear on the way back up. Reach grows with intensity.
      const angle = stroke(side);
      const span = 0.55 + 0.45 * this.groom;
      const { center, radius } = rig.skull;
      const target = this.reach
        .set(
          side * (0.5 - 0.22 * Math.sin(angle) * span),
          0.18 + 0.55 * Math.cos(angle) * span,
          0.85,
        )
        .normalize()
        .multiplyScalar(radius + 0.03 + 0.05 * Math.max(0, -Math.sin(angle)))
        .add(center)
        .applyMatrix4(rig.head.matrix)
        .sub(pivot.position);
      const upper = knee.position.length() * stretch;
      const lower = leg.foot.length() * stretch;
      const d = THREE.MathUtils.clamp(
        target.length(),
        Math.abs(upper - lower) + 1e-4,
        (upper + lower) * 0.999,
      );
      target.normalize();
      // The knee points out to the side, so the leg shows beside the head.
      const bend = this.bend.set(side, -0.3, 0.2);
      bend.addScaledVector(target, -bend.dot(target)).normalize();
      const cos = (upper * upper + d * d - lower * lower) / (2 * upper * d);
      const femur = this.femur
        .copy(target)
        .multiplyScalar(cos)
        .addScaledVector(bend, Math.sqrt(Math.max(0, 1 - cos * cos)));
      const shin = this.shin
        .copy(target)
        .multiplyScalar(d)
        .addScaledVector(femur, -upper)
        .normalize();
      this.hipTurn.setFromUnitVectors(bend.copy(knee.position).normalize(), femur);
      shin.applyQuaternion(this.kneeTurn.copy(this.hipTurn).invert());
      this.kneeTurn.setFromUnitVectors(bend.copy(leg.foot).normalize(), shin);
      pivot.quaternion.slerp(this.hipTurn, grooming);
      knee.quaternion.identity().slerp(this.kneeTurn, grooming);
    });

    // Blinking.
    this.blinkIn -= dt;
    if (this.blinkIn <= 0) {
      this.blink = 0.14;
      this.blinkIn = randomBetween(2, 5.5);
    }
    this.blink = Math.max(0, this.blink - dt);
    // Drowsy, the blinks come slow and heavy.
    if (this.blink > 0 && this.drowse > 0.5 && !asleep) this.blink = Math.max(this.blink, 0.1);
    // Happy squints into ^ ^; alarm and anticipation open the eyes wide.
    const wide = 1 + 0.2 * Math.max(this.alarmed, this.expect);
    // Asleep, the eyes give way to closed ∪ ∪ lids.
    const closed = THREE.MathUtils.smoothstep(this.rest, 0.25, 0.7);
    const eyeOpen =
      (this.blink > 0 ? 0.1 : 1) *
      (1 - 0.45 * this.happy) *
      (1 - 0.45 * this.drowse * (1 - this.rest)) *
      (1 - closed) *
      wide;
    // Which eye the glass is on: the viewer's side, following the lens over
    // when the bug turns around (rig.eyes is [right, left]).
    const lensOnLeft = THREE.MathUtils.clamp((1 - this.lensX / LENS_X) / 2, 0, 1);
    rig.eyes.forEach((eye, i) => {
      const zoom = 1 + PEEK_ZOOM * peeking * (i === 1 ? lensOnLeft : 1 - lensOnLeft);
      // Squints as a foot rubs over it.
      const rubbed = 1 - 0.6 * rubbing(i === 0 ? 1 : -1);
      eye.scale.y += (eyeOpen * zoom * rubbed - eye.scale.y) * ease(40, dt);
      eye.scale.x = wide * zoom;
      eye.scale.z = zoom;
      eye.visible = eye.scale.y > 0.03;
    });
    for (const lid of rig.lids) {
      lid.visible = closed > 0.01;
      lid.scale.setScalar(closed);
    }

    // Wing cases pop open and the wings buzz while in the air, or flare in
    // alarm. `pose.wings` holds them at least that far open.
    this.flare = Math.max(0, this.flare - dt);
    const flaring = this.flare > 0;
    const wings = THREE.MathUtils.clamp(pose.wings ?? 0, 0, 1);
    const openTarget = Math.max(airborne || flaring ? 1 : 0, wings);
    const opening = airborne || flaring || wings > this.open;
    this.open += (openTarget - this.open) * ease(opening ? 12 : 7, dt);
    for (const { pivot, side } of rig.elytra) {
      pivot.rotation.set(this.open * 0.5, -side * this.open * 0.25, side * this.open * 0.4);
    }
    // Held partly open, the wings still spread out far enough to be seen buzzing.
    this.buzz = approach(this.buzz, Math.min(1, wings * 1.6), 12, dt);
    const spread = Math.max(this.open, this.buzz);
    for (const { pivot, side } of rig.wings) {
      pivot.visible = spread > 0.05;
      const flap = Math.sin(t * Math.PI * 2 * 13 + (side === 1 ? 0 : 0.4));
      pivot.rotation.set(
        spread * 0.25,
        -side * spread * 0.9,
        side * spread * (0.75 + flap * 0.4),
      );
      pivot.scale.setScalar(Math.max(spread, 0.001));
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
    const tremble =
      this.nervous * 0.7 +
      this.alarmed * (0.3 + flashing * 0.7) +
      (startled ? 1.6 * Math.min(1, this.startleLeft) : 0);
    this.sway.rotation.z = this.tilt + Math.sin(t * 53) * 0.03 * tremble;
    this.sway.position.x = (Math.sin(t * 61) * 0.006 + Math.sin(t * 37) * 0.004) * tremble;

    // Squash and stretch spring.
    const stiffness = 320;
    const damping = 14;
    this.squashVelocity += (-stiffness * this.squash - damping * this.squashVelocity) * dt;
    this.squash += this.squashVelocity * dt;
    const s = THREE.MathUtils.clamp(this.squash, -0.3, 0.3);
    rig.root.scale.set(1 - s * 0.6, 1 + s, 1 - s * 0.6);

    // Magnifying glass: floats ahead of the nose on the viewer's side of the
    // head (local -x when heading right, since yaw turns +x away), turned
    // toward the viewer, bobbing with each sniff. While peeking it's raised
    // between the camera and the eye on that side, so the eye looks zoomed.
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
      if (peeking > 0.001) {
        this.sway.updateMatrixWorld(true);
        const eye = rig.eyes[1].getWorldPosition(this.eyePoint);
        eye.lerp(rig.eyes[0].getWorldPosition(this.otherEyePoint), 1 - lensOnLeft);
        eye.addScaledVector(this.toCamera.subVectors(this.camera.position, eye).normalize(), PEEK_GAP);
        rig.root.worldToLocal(eye);
        eye.y += Math.sin(t * 3.1) * 0.006;
        magnifier.position.lerp(eye, peeking);
      }
      magnifier.rotation.set(
        (0.12 + sniffNod * 0.6) * (1 - peeking),
        -yaw * 0.85,
        Math.sin(t * 1.3) * 0.06 * (1 - peeking * 0.5),
      );
    }

    // The blanket drops and drapes itself over the bug (played back from the
    // baked cloth simulation); on waking it's flung up and off.
    const blanket = rig.blanket;
    const baked = clothBake?.result;
    blanket.visible = this.tuck > 0 && baked !== undefined && baked !== null;
    if (blanket.visible && baked) {
      if (this.tuck !== this.drawnTuck) {
        this.drawnTuck = this.tuck;
        const positions = rig.blanketCloth.getAttribute("position") as THREE.BufferAttribute;
        sampleCloth(baked, this.tuck * CLOTH_SECONDS, positions.array as Float32Array);
        positions.needsUpdate = true;
        rig.blanketCloth.computeVertexNormals();
      }
      // It fades in as it falls, solid by the time it lands on the shell.
      const opacity = THREE.MathUtils.smootherstep(this.tuck * CLOTH_SECONDS, 0, BLANKET_FADE_SECONDS);
      if (opacity !== this.blanketOpacity) {
        this.blanketOpacity = opacity;
        rig.setBlanketOpacity(opacity);
      }
      const flung = this.toss >= 0 ? 1 - (1 - this.toss) ** 2 : 0;
      blanket.position.set(0, flung * 0.55, -flung * 0.3);
      blanket.rotation.set(-flung * 1.3, 0, flung * 0.6 * pose.heading);
      blanket.scale.setScalar(1 - flung);
    }

    // Contact shadow only while on the ground, wider under the blanket.
    const grounded = mode === "idle" || walking;
    const covered = blanket.visible ? THREE.MathUtils.smootherstep(this.tuck, 0, 1) : 0;
    this.shadow.scale.set(0.85 + covered * 0.55, 1, 0.6 + covered * 0.45);
    const material = this.shadow.material;
    material.opacity += ((grounded ? 1 : 0) - material.opacity) * ease(12, dt);
    this.shadow.visible = material.opacity > 0.01;

    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Once per snore, as the breath out starts: where a floating "z" should
   * start, in canvas CSS px (just above the bug's head). Otherwise null.
   */
  takeSnore(): { x: number; y: number } | null {
    if (!this.snorePending) return null;
    this.snorePending = false;
    const point = this.rig.head.localToWorld(this.snorePoint.set(0, 0.2, 0.12)).project(this.camera);
    return {
      x: ((point.x + 1) / 2) * this.viewport.width,
      y: ((1 - point.y) / 2) * this.viewport.height,
    };
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
