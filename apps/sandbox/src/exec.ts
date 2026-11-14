import { spawn } from "node:child_process";
import type { ExecRequest, ExecResponse } from "@ladybug/shared";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const STREAM_CAP = 64 * 1024;
/** How long to wait for stdio to close after the shell exits (background children may hold it). */
const DRAIN_GRACE_MS = 1_000;

type Capture = { chunks: Buffer[]; size: number; truncated: boolean };

function capture(): Capture {
  return { chunks: [], size: 0, truncated: false };
}

function append(c: Capture, chunk: Buffer) {
  if (c.size >= STREAM_CAP) {
    c.truncated = true;
    return;
  }
  const room = STREAM_CAP - c.size;
  if (chunk.length > room) {
    c.chunks.push(chunk.subarray(0, room));
    c.size = STREAM_CAP;
    c.truncated = true;
  } else {
    c.chunks.push(chunk);
    c.size += chunk.length;
  }
}

function killGroup(pid: number | undefined) {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}

export function clampTimeout(timeoutMs: unknown) {
  const n = typeof timeoutMs === "number" && Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.round(n), 1), MAX_TIMEOUT_MS);
}

export function runExec(req: ExecRequest, cwd: string, env: NodeJS.ProcessEnv): Promise<ExecResponse> {
  const timeoutMs = clampTimeout(req.timeoutMs);
  return new Promise((resolve) => {
    const stdout = capture();
    const stderr = capture();
    let timedOut = false;
    let exitCode: number | null = null;
    let settled = false;

    // detached: the shell leads its own process group, so a timeout kills everything it started.
    const child = spawn("bash", ["-lc", req.cmd], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });

    const finish = (error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      const errText = Buffer.concat(stderr.chunks).toString("utf8");
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout.chunks).toString("utf8"),
        stderr: error ? `${errText}${errText ? "\n" : ""}${error}` : errText,
        timedOut,
        truncated: stdout.truncated || stderr.truncated,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
      setTimeout(() => finish(), DRAIN_GRACE_MS);
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
    child.on("error", (error) => finish(`spawn failed: ${error.message}`));
    child.on("exit", (code) => {
      exitCode = code;
      setTimeout(() => finish(), DRAIN_GRACE_MS);
    });
    child.on("close", () => finish());
  });
}
