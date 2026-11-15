// What the background worker and the warning page (warning.html) say to each
// other. The page only gets a random token in its URL; everything it shows
// comes from the background, so a site can't frame warning.html with made-up
// text, or click "Continue" on a warning it didn't get.

/** A page Computerbug is warning about, shown over that page. */
export type Warning = {
  token: string;
  tabId: number;
  /** The URL as the tab reported it. */
  url: string;
  host: string;
  /** Why the server flagged it. */
  reason: string;
  /** Whether the verdict arrived while the user was already on the page. */
  late: boolean;
  /** What "Continue anyway" allows for the rest of the browser session. */
  allowKey: string;
  /**
   * "overlay": over the page. "page": the tab was sent to warning.html instead,
   * because the page kept removing the overlay.
   */
  mode: "overlay" | "page";
};

export type WarningMessage =
  | { type: "warning:get"; token: string }
  | { type: "warning:continue"; token: string }
  | { type: "warning:exit"; token: string }
  /** From the overlay in the page: the page keeps removing it. */
  | { type: "warning:tampered"; token: string };

/** What the page shows. null when the token is stale (the warning was dismissed). */
export type WarningDetails = Pick<Warning, "url" | "host" | "reason" | "late"> | null;

export const isWarningMessage = (message: unknown): message is WarningMessage =>
  typeof message === "object" &&
  message !== null &&
  typeof (message as { type?: unknown }).type === "string" &&
  (message as { type: string }).type.startsWith("warning:") &&
  typeof (message as { token?: unknown }).token === "string";
