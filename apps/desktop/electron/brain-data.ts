import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

/** Where the packed connectome lives, relative to the app's resources or the repository. */
const PACKAGED_PATH = ["brain", "connectome.bin"];
const DEVELOPMENT_PATH = ["packages", "brain", "data", "connectome.bin"];

/**
 * The packed connectome: `LADYBUG_BRAIN_DATA` if set, else the copy shipped in
 * the app's resources, else the one `npm run brain:pack` writes in the repository.
 */
export function brainDataPath({ env, packaged, resourcesPath, appRoot }: {
  env: Record<string, string | undefined>;
  packaged: boolean;
  resourcesPath: string;
  /** apps/desktop */
  appRoot: string;
}) {
  if (env.LADYBUG_BRAIN_DATA) return path.resolve(env.LADYBUG_BRAIN_DATA);
  if (packaged) return path.join(resourcesPath, ...PACKAGED_PATH);
  return path.join(appRoot, "..", "..", ...DEVELOPMENT_PATH);
}

export const hasBrainData = (file: string) => existsSync(file);

/** The connectome's bytes, or null when it isn't installed or can't be read. */
export async function readBrainData(file: string, log: (message: string) => void = console.warn): Promise<Uint8Array | null> {
  try {
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") log(`[brain] could not read ${file}: ${String(error)}`);
    return null;
  }
}
