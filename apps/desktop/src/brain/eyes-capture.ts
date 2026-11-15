// The screen, captured for the bug's eyes. The stream is only ever drawn to a
// canvas the size of the wall's picture (a few hundred px across) and read
// back as brightness; nothing is kept but that picture, and it goes back to a
// plain wall when the capture stops. Only the facets' brightness goes on to
// the brain's worker.
import type { Rect } from "../ladybug-api.ts";
import type { ScreenCapture } from "./fly-brain.ts";
import { FLAT_WALL } from "./wall.ts";

/** Frames a second asked of the capture. */
export const CAPTURE_FPS = 10;
/** How often the newest frame is read into the wall, ms. The cursor and berry are drawn into the scene every frame, so the wall can lag. */
export const READ_MS = 125;
/** A capture nothing has looked through for this long (the pet is hidden, say) stops; the next look starts it again. */
export const IDLE_MS = 3000;
/** Everything the overlay draws on top of the screen: its top-level elements, and the bug's canvas, which overhangs its hit box. */
export const OVERLAY_SELECTOR = "#root > *, .pet-canvas";

/** Where the overlay draws on top of the screen right now, px. */
function overlayRects(): Rect[] {
  const rects: Rect[] = [];
  for (const element of document.querySelectorAll(OVERLAY_SELECTOR)) {
    const { x, y, width, height } = element.getBoundingClientRect();
    if (width > 0 && height > 0) rects.push({ x, y, width, height });
  }
  return rects;
}

/**
 * The screen capture, from a stream `open` returns: in the app, the primary
 * display at about twice the wall's resolution (`size`).
 */
export function captureScreen(open: (size: { width: number; height: number }) => Promise<MediaStream>): ScreenCapture {
  return (vision, ended) => {
    const startedAt = performance.now();
    let stopped = false;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
    vision.source = "starting";

    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      stream?.getTracks().forEach((track) => track.stop());
      video.pause();
      video.srcObject = null;
      vision.wall.fill(FLAT_WALL);
    };
    const end = (failed: boolean) => {
      if (stopped) return;
      stop();
      vision.source = failed ? "failed" : "flat";
      ended(failed);
    };

    const read = () => {
      const now = performance.now();
      if (now - Math.max(vision.lastLook, startedAt) > IDLE_MS) { end(false); return; }
      if (!context || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
      const { cols, rows } = vision.wall;
      if (canvas.width !== cols || canvas.height !== rows) {
        canvas.width = cols;
        canvas.height = rows;
      }
      try {
        context.drawImage(video, 0, 0, cols, rows);
        vision.capture(context.getImageData(0, 0, cols, rows).data, overlayRects(), now);
        vision.source = "screen";
      } catch {
        end(true);
      }
    };

    const { cols, rows } = vision.wall;
    open({ width: cols * 2, height: rows * 2 }).then((opened) => {
      if (stopped) { opened.getTracks().forEach((track) => track.stop()); return; }
      stream = opened;
      const track = opened.getVideoTracks()[0];
      if (!track || track.readyState !== "live" || !context) { end(true); return; }
      track.addEventListener("ended", () => end(true), { once: true });
      video.srcObject = opened;
      video.play().catch(() => end(true));
      timer = setInterval(read, READ_MS);
    }, () => end(true));

    return () => {
      stop();
      vision.source = "flat";
    };
  };
}

/** The primary display, through the main process's allowance for the bug's eyes. */
export async function openScreen({ width, height }: { width: number; height: number }) {
  const { id } = await window.ladybug.brain.getEyesSource();
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: id, maxWidth: width, maxHeight: height, maxFrameRate: CAPTURE_FPS },
    } as MediaTrackConstraints,
  });
}
