/** Visible part of a video frame, as fractions of its width and height. */
export type Crop = { x: number; y: number; width: number; height: number };

export const FULL_FRAME: Crop = { x: 0, y: 0, width: 1, height: 1 };

/** Luma at or below this counts as bar black (video black is ~16, plus compression noise). */
const DARK_LUMA = 32;
/** A row or column is bar if at most this share of its pixels is brighter. */
const BAR_BRIGHT_SHARE = 0.02;
/** Bars thinner than this (per side) aren't worth cropping. */
const MIN_BAR = 0.01;
/** Never keep less than this much of an axis: a frame that dark is a dark scene, not bars. */
const MIN_KEEP = 0.2;
/** Opposite bars further apart than this aren't trusted separately; both get the thinner one. */
const MAX_BAR_SKEW = 0.04;

/** Bar thickness on each side of one axis, in pixels, or null if it's all bar. */
function bars(length: number, isBar: (index: number) => boolean): [number, number] | null {
  let start = 0;
  while (start < length && isBar(start)) start++;
  if (start === length) return null;
  let end = 0;
  while (end < length - start && isBar(length - 1 - end)) end++;
  return [start, end];
}

/** Bars on one axis as fractions, made symmetric when the two sides disagree. Null if inconclusive. */
function axis(length: number, isBar: (index: number) => boolean): [number, number] | null {
  const found = bars(length, isBar);
  if (!found) return null;
  let [start, end] = found.map((n) => n / length);
  if (Math.abs(start - end) > MAX_BAR_SKEW) start = end = Math.min(start, end);
  if (start < MIN_BAR) start = 0;
  if (end < MIN_BAR) end = 0;
  if (1 - start - end < MIN_KEEP) return null;
  return [start, end];
}

/**
 * Finds black letterbox (above and below) or pillarbox (left and right) bars
 * in an RGBA frame and returns the part between them. Returns null when the
 * frame is too dark to tell bars from picture, e.g. while the camera starts.
 */
export function detectCrop(pixels: Uint8ClampedArray, width: number, height: number): Crop | null {
  if (width === 0 || height === 0) return null;
  const bright = new Uint8Array(width * height);
  for (let i = 0; i < bright.length; i++) {
    const p = i * 4;
    bright[i] = 0.299 * pixels[p] + 0.587 * pixels[p + 1] + 0.114 * pixels[p + 2] > DARK_LUMA ? 1 : 0;
  }
  const rowIsBar = (y: number) => {
    let count = 0;
    for (let x = 0; x < width; x++) count += bright[y * width + x];
    return count <= width * BAR_BRIGHT_SHARE;
  };
  const columnIsBar = (x: number) => {
    let count = 0;
    for (let y = 0; y < height; y++) count += bright[y * width + x];
    return count <= height * BAR_BRIGHT_SHARE;
  };
  const vertical = axis(height, rowIsBar);
  const horizontal = axis(width, columnIsBar);
  if (!vertical || !horizontal) return null;
  const [top, bottom] = vertical;
  const [left, right] = horizontal;
  return { x: left, y: top, width: 1 - left - right, height: 1 - top - bottom };
}

/** Whether two crops are close enough to be the same bars, give or take noise. */
export function sameCrop(a: Crop, b: Crop, tolerance = 0.015) {
  return (
    Math.abs(a.x - b.x) <= tolerance &&
    Math.abs(a.y - b.y) <= tolerance &&
    Math.abs(a.width - b.width) <= tolerance &&
    Math.abs(a.height - b.height) <= tolerance
  );
}

/** Largest size with the given aspect ratio (width / height) that fits the box. */
export function fitAspect(aspect: number, maxWidth: number, maxHeight: number) {
  const width = Math.max(0, Math.min(maxWidth, maxHeight * aspect));
  return { width: Math.round(width), height: Math.round(width / aspect) };
}
