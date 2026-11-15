import type { ScreenAccess } from "../src/ladybug-api";

/** How long a capture source handed to the eyes stays good for opening its stream, ms. */
export const EYES_ARM_MS = 10_000;

/**
 * Whether the bug's eyes can see the screen. On macOS that takes the Screen
 * Recording permission (`status`, from getMediaAccessStatus("screen")).
 * Under Wayland every capture goes through the desktop portal's picker, which
 * would pop up whenever the capture starts, so the eyes don't capture there.
 */
export function screenAccess({ platform, windowed, wayland, status }: {
  platform: string;
  /** The development window, which isn't the screen. */
  windowed: boolean;
  wayland: boolean;
  status: string;
}): ScreenAccess {
  if (windowed || (platform === "linux" && wayland)) return "unavailable";
  if (platform === "darwin" && status !== "granted") return "not-allowed";
  return "allowed";
}

/**
 * The one allowance for screen capture outside a support call: while Fly Eyes
 * is on, a source handed to the eyes lets the page open one video-only stream
 * within EYES_ARM_MS. The call's CapturePolicy is separate and unchanged.
 */
export class EyesCapturePolicy {
  private armedUntil = 0;
  private claimed = true;
  private on: () => boolean;
  private now: () => number;

  constructor(on: () => boolean, now = () => Date.now()) {
    this.on = on;
    this.now = now;
  }

  /** A source was just handed to the eyes. */
  arm() {
    if (!this.on()) throw new Error("Fly Eyes is off.");
    this.armedUntil = this.now() + EYES_ARM_MS;
    this.claimed = false;
  }

  /** Fly Eyes went off, or the page reloaded. */
  disarm() {
    this.armedUntil = 0;
    this.claimed = true;
  }

  private armed() {
    return this.on() && this.now() < this.armedUntil;
  }

  /** A permission check: media, from the trusted page, while a source is out. */
  allows(trustedMainFrame: boolean, permission: string) {
    return trustedMainFrame && permission === "media" && this.armed();
  }

  /** A permission request: the one video-only stream the source was handed out for. */
  claim(trustedMainFrame: boolean, permission: string, mediaTypes: readonly string[] | undefined) {
    if (!this.allows(trustedMainFrame, permission) || this.claimed) return false;
    if (mediaTypes?.length !== 1 || mediaTypes[0] !== "video") return false;
    this.claimed = true;
    return true;
  }
}
