// What each facet of the fly's eyes sees.
//
// The pet is a small animal standing on a ledge just in front of the screen,
// and the screen's surface is a luminous wall behind it. World coordinates are
// the overlay's: x to the right of the screen and y down it, in px, plus z,
// the distance out of the screen toward the viewer. The ledge is the plane
// y = ledgeY, from the wall out toward the viewer. Everything a facet can look
// at is the wall, the ledge, the room beyond them, or the berry on the ledge.
//
// The head frame is the brain's: x toward the fly's right, y straight ahead, z
// up. Facing the viewer (yaw 0), its right is the left of the screen.
import type { Eye, EyeMap } from "@ladybug/brain";
import type { Point, Rect } from "../ladybug-api.ts";
import type { Wall } from "./wall.ts";

/**
 * How high its eyes are above the ledge, px: the hit box is 60 px tall, most
 * of it the domed wing cases, and the head hangs low in front of them.
 */
export const EYE_HEIGHT = 20;
/**
 * How far out from the wall the middle of the bug stands, px: a little over
 * half its length (100 px), so it can turn round without touching the screen.
 */
export const BODY_DEPTH = 60;
/** How far ahead of the middle of its body its eyes are, px. */
export const HEAD_REACH = 35;
/** The room beyond the screen, out toward the viewer or past the screen's edges: dimmer than the screen. */
export const ROOM = 0.3;
/** The ledge it stands on, below its feet: in its own shade. */
export const LEDGE = 0.2;
/** The cursor: a black arrow with a thin white rim. */
export const CURSOR = 0.05;
/** The berry: a deep blue. */
export const BERRY = 0.3;
/**
 * The arrow cursor at its real size, as boxes stacked from its tip (the
 * hotspot) down and to the right, px: its head, then its tail.
 */
export const CURSOR_SHAPE: readonly Rect[] = [
  { x: 0, y: 0, width: 3, height: 3 },
  { x: 0, y: 3, width: 5, height: 3 },
  { x: 0, y: 6, width: 7, height: 3 },
  { x: 0, y: 9, width: 9, height: 3 },
  { x: 0, y: 12, width: 11, height: 3 },
  { x: 5, y: 15, width: 4, height: 6 },
];
/** The box the cursor covers, from its hotspot, px. */
export const CURSOR_BOUNDS: Rect = { x: 0, y: 0, width: 11, height: 21 };

/** Rays averaged per facet: one down the middle of its cone and a ring of six. */
export const RAYS = 7;
/**
 * The ring's angle from the middle, as a fraction of the cone's half-angle,
 * and each ray's own half-angle: seven rays share the cone's area equally,
 * so the middle one takes the inner 1/√7 of its radius and the ring the rest,
 * centred at about 0.7 of it.
 */
const RING = 0.7;
const RAY_SHARE = 1 / Math.sqrt(RAYS);
/** A footprint at a grazing angle is stretched at most this much: beyond it, it is mostly room anyway. */
const MAX_STRETCH = 20;

/** Where the eyes are and which way they face: yaw 0 faces the viewer, positive turns the face toward the right of the screen. */
export type HeadPose = { x: number; y: number; depth: number; yaw: number };

/** A ball on the ledge, in world px: the berry. */
export type Ball = { x: number; y: number; depth: number; radius: number };

export type Scene = {
  wall: Wall;
  /** The line the ledge meets the wall at, px down the screen. */
  ledgeY: number;
  /** The cursor's hotspot on the wall, or null when unknown. */
  cursor: Point | null;
  berry: Ball | null;
};

/** Where the eyes are for a bug whose feet are at (`centreX`, `feetY`), facing `yaw`. */
export function headPose(centreX: number, feetY: number, yaw: number): HeadPose {
  return {
    x: centreX + HEAD_REACH * Math.sin(yaw),
    y: feetY - EYE_HEIGHT,
    depth: BODY_DEPTH + HEAD_REACH * Math.cos(yaw),
    yaw,
  };
}

/** The rays of every facet of one eye, in the head frame: RAYS × (x, y, z) per facet. */
function raysOf(eye: Eye, acceptance: number) {
  const { directions } = eye;
  const facets = Math.floor(directions.length / 3);
  const rays = new Float32Array(facets * RAYS * 3);
  const cosRing = Math.cos(RING * acceptance);
  const sinRing = Math.sin(RING * acceptance);
  for (let f = 0; f < facets; f++) {
    let x = directions[f * 3], y = directions[f * 3 + 1], z = directions[f * 3 + 2];
    const length = Math.hypot(x, y, z) || 1;
    x /= length; y /= length; z /= length;
    // Two directions across the facet's axis.
    const [ax, ay, az] = Math.abs(z) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    let ux = ay * z - az * y, uy = az * x - ax * z, uz = ax * y - ay * x;
    const u = Math.hypot(ux, uy, uz);
    ux /= u; uy /= u; uz /= u;
    const vx = y * uz - z * uy, vy = z * ux - x * uz, vz = x * uy - y * ux;
    const at = f * RAYS * 3;
    rays[at] = x; rays[at + 1] = y; rays[at + 2] = z;
    for (let k = 1; k < RAYS; k++) {
      const angle = ((k - 1) * 2 * Math.PI) / (RAYS - 1);
      const c = Math.cos(angle) * sinRing, s = Math.sin(angle) * sinRing;
      rays[at + k * 3] = x * cosRing + ux * c + vx * s;
      rays[at + k * 3 + 1] = y * cosRing + uy * c + vy * s;
      rays[at + k * 3 + 2] = z * cosRing + uz * c + vz * s;
    }
  }
  return { facets, rays };
}

/** Area (px²) of the overlap of the box [x0, x1] × [y0, y1] with the cursor at `cursor`. */
function cursorCover(cursor: Point, x0: number, y0: number, x1: number, y1: number) {
  if (x1 <= cursor.x + CURSOR_BOUNDS.x || x0 >= cursor.x + CURSOR_BOUNDS.x + CURSOR_BOUNDS.width) return 0;
  if (y1 <= cursor.y + CURSOR_BOUNDS.y || y0 >= cursor.y + CURSOR_BOUNDS.y + CURSOR_BOUNDS.height) return 0;
  let area = 0;
  for (const part of CURSOR_SHAPE) {
    const w = Math.min(x1, cursor.x + part.x + part.width) - Math.max(x0, cursor.x + part.x);
    const h = Math.min(y1, cursor.y + part.y + part.height) - Math.max(y0, cursor.y + part.y);
    if (w > 0 && h > 0) area += w * h;
  }
  return area;
}

/**
 * The eyes of one brain, ready to look: each facet's cone as RAYS rays, built
 * once. `look` then fills in what every facet sees, without allocating.
 */
export class Retina {
  readonly map: EyeMap;
  /** What each facet saw at the last look, in the order of `map`. */
  readonly light: { left: Float32Array; right: Float32Array };
  private rays: { left: Float32Array; right: Float32Array };
  /** tan of each ray's half-angle: how fast its footprint grows with distance. */
  private spread: number;

  constructor(map: EyeMap) {
    this.map = map;
    const left = raysOf(map.left, map.acceptance);
    const right = raysOf(map.right, map.acceptance);
    this.rays = { left: left.rays, right: right.rays };
    this.light = { left: new Float32Array(left.facets), right: new Float32Array(right.facets) };
    this.spread = Math.tan(map.acceptance * RAY_SHARE);
  }

  /** What each facet of both eyes sees from `pose`, into `light`. */
  look(pose: HeadPose, scene: Scene) {
    this.lookWith(this.rays.left, this.light.left, pose, scene);
    this.lookWith(this.rays.right, this.light.right, pose, scene);
  }

  private lookWith(rays: Float32Array, out: Float32Array, pose: HeadPose, scene: Scene) {
    const cos = Math.cos(pose.yaw), sin = Math.sin(pose.yaw);
    for (let f = 0; f < out.length; f++) {
      let sum = 0;
      for (let k = f * RAYS * 3, end = k + RAYS * 3; k < end; k += 3) {
        const hx = rays[k], hy = rays[k + 1], hz = rays[k + 2];
        // Head to world: its right is (-cos, 0, sin), ahead is (sin, 0, cos), up is -y.
        sum += this.ray(-hx * cos + hy * sin, -hz, hx * sin + hy * cos, pose, scene);
      }
      out[f] = sum / RAYS;
    }
  }

  /** How bright the world is down one ray from the eyes (a unit vector in world coordinates). */
  private ray(wx: number, wy: number, wz: number, pose: HeadPose, scene: Scene) {
    const { wall, ledgeY } = scene;
    // The nearest of the ledge and the wall, if the ray meets either.
    let t = Infinity;
    let onWall = false;
    if (wy > 1e-9) t = Math.max(0, ledgeY - pose.y) / wy;
    if (wz < -1e-9 && pose.depth / -wz < t) {
      t = pose.depth / -wz;
      onWall = true;
    }
    const { berry } = scene;
    if (berry) {
      const ox = pose.x - berry.x, oy = pose.y - berry.y, oz = pose.depth - berry.depth;
      const b = wx * ox + wy * oy + wz * oz;
      const disc = b * b - (ox * ox + oy * oy + oz * oz - berry.radius * berry.radius);
      if (disc >= 0) {
        const near = -b - Math.sqrt(disc);
        if (near > 0 && near < t) return BERRY;
      }
    }
    if (!onWall) return t === Infinity ? ROOM : LEDGE;

    // The ray's footprint on the wall: a circle seen square on, stretched
    // along the ray's slant at a grazing angle. Averaged over the box around it.
    const cx = pose.x + t * wx, cy = pose.y + t * wy;
    const minor = t * this.spread;
    const major = minor / Math.max(-wz, 1 / MAX_STRETCH);
    const slant = Math.hypot(wx, wy);
    const ux = slant > 1e-9 ? wx / slant : 1, uy = slant > 1e-9 ? wy / slant : 0;
    const halfW = Math.sqrt(major * major * ux * ux + minor * minor * uy * uy);
    const halfH = Math.sqrt(major * major * uy * uy + minor * minor * ux * ux);
    const x0 = cx - halfW, x1 = cx + halfW, y0 = cy - halfH, y1 = cy + halfH;
    const area = (x1 - x0) * (y1 - y0);
    if (!(area > 0)) return ROOM;
    // What of the box falls below the ledge line is the ledge; past the
    // screen's edges, the room.
    const below = Math.max(0, y1 - Math.max(y0, ledgeY)) * (x1 - x0);
    const wx0 = Math.max(x0, 0), wx1 = Math.min(x1, wall.width);
    const wy0 = Math.max(y0, 0), wy1 = Math.min(y1, ledgeY, wall.height);
    const wallArea = wx1 > wx0 && wy1 > wy0 ? (wx1 - wx0) * (wy1 - wy0) : 0;
    let light = 0;
    if (wallArea > 0) {
      light = wall.integral(wx0, wy0, wx1, wy1);
      if (scene.cursor) {
        const cover = cursorCover(scene.cursor, wx0, wy0, wx1, wy1);
        if (cover > 0) light += cover * (CURSOR - light / wallArea);
      }
    }
    const room = Math.max(0, area - wallArea - below);
    return (light + below * LEDGE + room * ROOM) / area;
  }
}
