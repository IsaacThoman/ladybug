// The fly's eyes, as the pet drives them: the wall's picture, what each facet
// sees of it each frame, and what has to be kept out of a captured screen.
import type { EyeMap } from "@ladybug/brain";
import type { Point, Rect } from "../ladybug-api.ts";
import { BODY_DEPTH, CURSOR_BOUNDS, Retina, headPose } from "./eyes.ts";
import type { Ball, Scene } from "./eyes.ts";
import { FLAT_WALL, Wall } from "./wall.ts";

/**
 * Things the overlay moves every frame are kept out of a captured frame
 * wherever they were this long before it was read: a frame shows the screen
 * as it was a little while ago, up to a capture interval plus the time it
 * takes to arrive.
 */
export const MASK_MS = 300;
/** Margin (px) around them, for what the history misses between frames. */
export const MASK_MARGIN = 6;
/** Frames of history kept; at 60 Hz, a little over MASK_MS. */
const HISTORY = 32;
/** A sudden darkening in one eye, for jumping away from it, fades over this long (s). */
const DARKENING_FADE = 0.3;
/** A look's darkening is full when a facet's worth goes from white to black since the last one. */
const DARKENING_FULL = 1;

/**
 * - flat: the plain wall
 * - starting: the screen capture is starting; meanwhile, the plain wall
 * - screen: the captured screen
 * - failed: the screen couldn't be captured, so the plain wall
 */
export type WallSource = "flat" | "starting" | "screen" | "failed";

/** What the bug is in the middle of, as the eyes need it. */
export type ViewInput = {
  /** performance.now() time of this frame. */
  now: number;
  /** The screen, px. */
  width: number;
  height: number;
  /** Where the ledge meets the wall, px down the screen. */
  ledgeY: number;
  /** The middle of the bug's feet. */
  centreX: number;
  feetY: number;
  /** Which way it faces as drawn; see HeadPose. */
  yaw: number;
  /** Where the overlay draws the bug, and its berry (or null). */
  sprite: Rect;
  berry: Rect | null;
  /** The berry as a ball on the ledge, or null. */
  ball: Omit<Ball, "depth"> | null;
  cursor: Point | null;
};

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

export class Vision {
  readonly wall = new Wall();
  source: WallSource = "flat";
  /** When the eyes last looked (performance.now()), so an unused capture can stop. */
  lastLook = -Infinity;
  private retina: Retina | null = null;
  /** What each facet saw the time before, and how suddenly each eye darkened since. */
  private before = { left: new Float32Array(0), right: new Float32Array(0) };
  private darkening = { left: 0, right: 0 };
  private scene: Scene = { wall: this.wall, ledgeY: 0, cursor: null, berry: null };
  private ball: Ball = { x: 0, y: 0, depth: BODY_DEPTH, radius: 0 };
  /** Per frame: time, cursor (x, y, or NaN), sprite (x, y, w, h), berry (x, y, w, h, or NaN). */
  private history = new Float64Array(HISTORY * 11).fill(Number.NaN);
  private next = 0;
  private rects: Rect[] = [];

  /** What each facet saw last, in the order of the brain's eyes, or null before the eyes have looked. */
  get light() {
    return this.retina?.light ?? null;
  }

  /** The eyes it's looking through, or null before it has. */
  get eyes(): EyeMap | null {
    return this.retina?.map ?? null;
  }

  /** How suddenly each eye's view darkened lately, 0 to 1: what to jump away from. */
  get startle() {
    return { left: this.darkening.left, right: this.darkening.right };
  }

  /** Back to the plain wall, as for a new brain. */
  reset() {
    this.wall.fill(FLAT_WALL);
    this.before.left = this.before.right = new Float32Array(0);
    this.darkening.left = this.darkening.right = 0;
    this.history.fill(Number.NaN);
    this.lastLook = -Infinity;
  }

  /**
   * Notes where things are this frame, so a captured frame can be cleaned of
   * them. Cheap: called every frame, whether or not the eyes look.
   */
  track(input: ViewInput) {
    this.wall.resize(input.width, input.height);
    const at = this.next * 11;
    this.next = (this.next + 1) % HISTORY;
    const h = this.history;
    h[at] = input.now;
    h[at + 1] = input.cursor?.x ?? Number.NaN;
    h[at + 2] = input.cursor?.y ?? Number.NaN;
    h[at + 3] = input.sprite.x; h[at + 4] = input.sprite.y; h[at + 5] = input.sprite.width; h[at + 6] = input.sprite.height;
    h[at + 7] = input.berry?.x ?? Number.NaN; h[at + 8] = input.berry?.y ?? Number.NaN;
    h[at + 9] = input.berry?.width ?? Number.NaN; h[at + 10] = input.berry?.height ?? Number.NaN;
  }

  /** What every facet of `eyes` sees this frame. The arrays are reused: send or copy them before the next look. */
  look(eyes: EyeMap, input: ViewInput) {
    if (this.retina?.map !== eyes) {
      this.retina = new Retina(eyes);
      this.before.left = this.before.right = new Float32Array(0);
    }
    const dt = Number.isFinite(this.lastLook) ? Math.min(0.1, Math.max(0, input.now - this.lastLook) / 1000) : 0;
    this.lastLook = input.now;
    const { scene, ball } = this;
    scene.ledgeY = input.ledgeY;
    scene.cursor = input.cursor;
    // The berry sits on the ledge beside the bug, as far out from the wall.
    if (input.ball) {
      ball.x = input.ball.x;
      ball.y = input.ball.y;
      ball.radius = input.ball.radius;
    }
    scene.berry = input.ball ? ball : null;
    this.retina.look(headPose(input.centreX, input.feetY, input.yaw), scene);
    this.darken("left", this.retina.light.left, dt);
    this.darken("right", this.retina.light.right, dt);
    return this.retina.light;
  }

  /**
   * A frame of the captured screen, `wall.cols` × `wall.rows` RGBA pixels,
   * read at `now`. Everything in `overlay` (screen px) and everything the
   * overlay moved through in the last MASK_MS is kept out of it.
   */
  capture(rgba: ArrayLike<number>, overlay: readonly Rect[], now: number) {
    const rects = this.rects;
    rects.length = 0;
    for (const rect of overlay) rects.push(rect);
    const h = this.history;
    const m = MASK_MARGIN;
    for (let at = 0; at < h.length; at += 11) {
      if (!(now - h[at] <= MASK_MS)) continue;
      if (Number.isFinite(h[at + 1])) {
        rects.push({ x: h[at + 1] + CURSOR_BOUNDS.x - m, y: h[at + 2] + CURSOR_BOUNDS.y - m, width: CURSOR_BOUNDS.width + 2 * m, height: CURSOR_BOUNDS.height + 2 * m });
      }
      rects.push({ x: h[at + 3] - m, y: h[at + 4] - m, width: h[at + 5] + 2 * m, height: h[at + 6] + 2 * m });
      if (Number.isFinite(h[at + 7])) rects.push({ x: h[at + 7] - m, y: h[at + 8] - m, width: h[at + 9] + 2 * m, height: h[at + 10] + 2 * m });
    }
    this.wall.capture(rgba, rects);
  }

  private darken(side: "left" | "right", light: Float32Array, dt: number) {
    let before = this.before[side];
    let drop = 0;
    if (before.length === light.length) {
      for (let i = 0; i < light.length; i++) drop += Math.max(0, before[i] - light[i]);
    } else {
      before = this.before[side] = new Float32Array(light.length);
    }
    before.set(light);
    this.darkening[side] = Math.max(clamp01(drop / DARKENING_FULL), this.darkening[side] - dt / DARKENING_FADE);
  }
}
