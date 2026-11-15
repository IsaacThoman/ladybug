import { execFile } from "node:child_process";

/** Fixed commands only. Noninteractive sudo never asks the desktop user for a password. */
export async function shutdownDevice(options: {
  platform?: NodeJS.Platform;
  execute?: typeof execFile;
  log?: () => void;
} = {}): Promise<void> {
  const platform = options.platform ?? process.platform;
  const args = platform === "linux" ? ["-n", "/usr/bin/systemctl", "poweroff", "--force"]
    : platform === "darwin" ? ["-n", "/sbin/shutdown", "-h", "now"] : null;
  if (!args) return;
  await new Promise<void>((resolve) => {
    const failed = () => (options.log ?? (() => console.error("[support] device shutdown failed; check administrator shutdown setup")))();
    try {
      (options.execute ?? execFile)("/usr/bin/sudo", args, { shell: false, timeout: 10_000 }, (error) => {
        if (error) failed();
        resolve();
      });
    } catch { failed(); resolve(); }
  });
}
