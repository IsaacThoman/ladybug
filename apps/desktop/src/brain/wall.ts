// The wall behind the bug: the screen's surface, as a small picture of how
// bright it is. The eyes average it over each facet's footprint (eyes.ts).
import type { Rect } from "../ladybug-api.ts";

/** About how many px of the screen each cell of the picture covers. */
export const WALL_CELL = 6;
/** The plain wall, when the screen itself can't be seen: mid-grey. */
export const FLAT_WALL = 0.5;

/** How bright a pixel looks, 0 to 1: Rec. 709 luma of its sRGB values. */
export const luminance = (r: number, g: number, b: number) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/**
 * The picture, in cells of about WALL_CELL px, with a summed-area table so the
 * eyes can average any box of it in constant time.
 */
export class Wall {
  /** The screen it covers, px. */
  width = 0;
  height = 0;
  cols = 0;
  rows = 0;
  private cellWidth = 1;
  private cellHeight = 1;
  private cells = new Float32Array(0);
  /** sums[j * (cols + 1) + i]: the cells above and left of corner (i, j). Doubles, so small boxes far down the table keep their precision. */
  private sums = new Float64Array(0);
  private masked = new Uint8Array(0);

  /** Covers a screen of this size, as a plain wall. Nothing changes if it already does. */
  resize(width: number, height: number) {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.cols = Math.max(1, Math.round(width / WALL_CELL));
    this.rows = Math.max(1, Math.round(height / WALL_CELL));
    this.cellWidth = width / this.cols || 1;
    this.cellHeight = height / this.rows || 1;
    this.cells = new Float32Array(this.cols * this.rows);
    this.sums = new Float64Array((this.cols + 1) * (this.rows + 1));
    this.masked = new Uint8Array(this.cols * this.rows);
    this.fill(FLAT_WALL);
  }

  /** The whole wall one brightness. */
  fill(value: number) {
    this.cells.fill(value);
    this.summarize();
  }

  /**
   * A frame of the screen, `cols` × `rows` RGBA pixels. Cells under `masks`
   * (screen px) keep what they showed before: the overlay draws the bug, its
   * berry, bubbles and panels on top of the screen, and the cursor is drawn
   * into the scene separately, so none of them belong to the wall.
   */
  capture(rgba: ArrayLike<number>, masks: readonly Rect[]) {
    const { cols, rows, masked } = this;
    if (rgba.length < cols * rows * 4) return;
    masked.fill(0);
    for (const rect of masks) {
      const i0 = Math.max(0, Math.floor(rect.x / this.cellWidth));
      const i1 = Math.min(cols, Math.ceil((rect.x + rect.width) / this.cellWidth));
      const j0 = Math.max(0, Math.floor(rect.y / this.cellHeight));
      const j1 = Math.min(rows, Math.ceil((rect.y + rect.height) / this.cellHeight));
      for (let j = j0; j < j1; j++) masked.fill(1, j * cols + i0, Math.max(j * cols + i0, j * cols + i1));
    }
    for (let k = 0; k < cols * rows; k++) {
      if (!masked[k]) this.cells[k] = luminance(rgba[k * 4], rgba[k * 4 + 1], rgba[k * 4 + 2]);
    }
    this.summarize();
  }

  /** Total brightness over a box of the screen (px, inside the wall), in px². */
  integral(x0: number, y0: number, x1: number, y1: number) {
    const u0 = x0 / this.cellWidth, u1 = x1 / this.cellWidth;
    const v0 = y0 / this.cellHeight, v1 = y1 / this.cellHeight;
    const cells = this.sum(u1, v1) - this.sum(u0, v1) - this.sum(u1, v0) + this.sum(u0, v0);
    return cells * this.cellWidth * this.cellHeight;
  }

  /**
   * The table at a fractional corner. Within a cell the integral of a
   * piecewise constant picture is bilinear, so interpolating the table is exact.
   */
  private sum(u: number, v: number) {
    const stride = this.cols + 1;
    const i = Math.min(Math.max(Math.floor(u), 0), this.cols - 1);
    const j = Math.min(Math.max(Math.floor(v), 0), this.rows - 1);
    const fu = Math.min(Math.max(u - i, 0), 1);
    const fv = Math.min(Math.max(v - j, 0), 1);
    const k = j * stride + i;
    const { sums } = this;
    const top = sums[k] + (sums[k + 1] - sums[k]) * fu;
    const bottom = sums[k + stride] + (sums[k + stride + 1] - sums[k + stride]) * fu;
    return top + (bottom - top) * fv;
  }

  private summarize() {
    const { cols, rows, cells, sums } = this;
    const stride = cols + 1;
    for (let j = 0; j < rows; j++) {
      let row = 0;
      for (let i = 0; i < cols; i++) {
        row += cells[j * cols + i];
        sums[(j + 1) * stride + i + 1] = sums[j * stride + i + 1] + row;
      }
    }
  }
}
