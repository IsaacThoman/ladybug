import { execFile } from "node:child_process";

/** Fixed process names only; scoped to the OS user running Computerbug. */
export async function killChrome(options: {
  platform?: NodeJS.Platform;
  uid?: () => number;
  execute?: typeof execFile;
  log?: () => void;
} = {}): Promise<void> {
  const platform = options.platform ?? process.platform;
  const name = platform === "linux" ? "chrome" : platform === "darwin" ? "Google Chrome" : null;
  const uid = options.uid ?? process.getuid;
  if (!name || !uid) return;
  await new Promise<void>((resolve) => {
    const failed = () => (options.log ?? (() => console.error("[support] browser termination failed")))();
    try {
      (options.execute ?? execFile)("/usr/bin/pkill", ["-KILL", "-u", String(uid()), "-x", name], { shell: false, timeout: 5000 }, (error) => {
        // pkill exits 1 when Chrome is already closed.
        if (error && error.code !== 1) failed();
        resolve();
      });
    } catch { failed(); resolve(); }
  });
}
