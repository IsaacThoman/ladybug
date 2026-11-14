import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { SandboxFile } from "@ladybug/shared";
import type { Config } from "./config.ts";

const execFileAsync = promisify(execFile);

const MAX_DEPTH = 6;
const MAX_FILES = 1000;

type Root = { prefix: "downloads" | "work"; dir: string; source: SandboxFile["source"] };

function roots(config: Config): Root[] {
  return [
    { prefix: "downloads", dir: config.downloadsDir, source: "download" },
    { prefix: "work", dir: config.workDir, source: "workspace" },
  ];
}

function sha256File(file: string) {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

async function fileType(file: string) {
  try {
    const { stdout } = await execFileAsync("file", ["--brief", "--", file], { timeout: 5_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function listFiles(config: Config): Promise<SandboxFile[]> {
  const files: SandboxFile[] = [];

  const walk = async (root: Root, dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || files.length >= MAX_FILES) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      const full = path.join(dir, entry.name);
      // Dirent types come from lstat semantics: symlinks are neither files nor directories here.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(root, full, depth + 1);
      } else if (entry.isFile()) {
        try {
          const stat = await fs.lstat(full);
          if (!stat.isFile()) continue;
          const rel = path.relative(root.dir, full).split(path.sep).join("/");
          files.push({
            path: `${root.prefix}/${rel}`,
            size: stat.size,
            sha256: await sha256File(full),
            type: await fileType(full),
            source: root.source,
          });
        } catch {
          // vanished or unreadable
        }
      }
    }
  };

  for (const root of roots(config)) await walk(root, root.dir, 0);
  return files;
}

function inside(parent: string, child: string) {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Maps "downloads/x" or "work/y" to a real regular file inside that root, or
 * null. Rejects traversal, absolute paths and symlinks anywhere in the path.
 */
export async function resolveSandboxFile(config: Config, relPath: string): Promise<string | null> {
  if (relPath.includes("\0")) return null;
  const parts = relPath.split("/").filter(Boolean);
  const prefix = parts.shift();
  const root = roots(config).find((r) => r.prefix === prefix);
  if (!root || parts.length === 0) return null;
  if (parts.some((p) => p === "." || p === "..")) return null;

  const target = path.resolve(root.dir, ...parts);
  if (!inside(root.dir, target)) return null;

  try {
    const realRoot = await fs.realpath(root.dir);
    const real = await fs.realpath(target);
    if (!inside(realRoot, real)) return null;
    // Every component under the root must be a plain dir/file, not a symlink.
    let current = root.dir;
    for (const part of parts) {
      current = path.join(current, part);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) return null;
    }
    const stat = await fs.stat(real);
    return stat.isFile() ? real : null;
  } catch {
    return null;
  }
}
