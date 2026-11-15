import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** Preferences picked from the tray menu, kept across restarts. */
export type Settings = {
  /** The fly brain decides how the pet moves. */
  flyBrain: boolean;
  /** Show the brain activity panel while the fly brain is on. */
  brainActivity: boolean;
  /** Fly Eyes: the fly brain sees the screen. Only while it's on. */
  flyEyes: boolean;
};

export const DEFAULT_SETTINGS: Settings = { flyBrain: false, brainActivity: false, flyEyes: false };

/** Known keys with the right type; anything else falls back to the default. */
export function parseSettings(text: string): Settings {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { ...DEFAULT_SETTINGS }; }
  const input = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const settings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    if (typeof input[key] === "boolean") settings[key] = input[key];
  }
  return settings;
}

/**
 * A small JSON file of settings. Reads once, synchronously, so the first menu
 * already reflects them; writes go out in order, each replacing the file
 * whole so a crash mid-write can't leave it half written.
 */
export class SettingsStore {
  private file: string;
  private values: Settings;
  private writes: Promise<void> = Promise.resolve();
  private onError: (error: unknown) => void;

  constructor(file: string, { onError = (error: unknown) => console.error("[settings] could not save", error) } = {}) {
    this.file = file;
    this.onError = onError;
    let text = "";
    try { text = readFileSync(file, "utf8"); } catch { /* missing: defaults */ }
    this.values = text ? parseSettings(text) : { ...DEFAULT_SETTINGS };
  }

  get(): Settings {
    return { ...this.values };
  }

  /** Updates the settings now and saves them in the background. Resolves once saved. */
  set(patch: Partial<Settings>): Promise<void> {
    this.values = parseSettings(JSON.stringify({ ...this.values, ...patch }));
    const text = `${JSON.stringify(this.values, null, 2)}\n`;
    const temp = `${this.file}.tmp`;
    this.writes = this.writes.then(async () => {
      try {
        await mkdir(path.dirname(this.file), { recursive: true });
        await writeFile(temp, text, "utf8");
        await rename(temp, this.file);
      } catch (error) {
        this.onError(error);
      }
    });
    return this.writes;
  }
}
