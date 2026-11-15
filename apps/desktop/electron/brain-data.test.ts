import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { brainDataPath, hasBrainData, readBrainData } from "./brain-data.ts";

const base = { resourcesPath: "/app/resources", appRoot: "/repo/apps/desktop" };

test("the connectome comes from the environment, the app's resources, or the repository", () => {
  assert.equal(brainDataPath({ ...base, env: { LADYBUG_BRAIN_DATA: "/data/brain.bin" }, packaged: true }), path.resolve("/data/brain.bin"));
  assert.equal(brainDataPath({ ...base, env: {}, packaged: true }), path.join("/app/resources", "brain", "connectome.bin"));
  assert.equal(brainDataPath({ ...base, env: {}, packaged: false }), path.join("/repo", "packages", "brain", "data", "connectome.bin"));
  assert.equal(brainDataPath({ ...base, env: { LADYBUG_BRAIN_DATA: "" }, packaged: false }), path.join("/repo", "packages", "brain", "data", "connectome.bin"));
});

test("a missing connectome reads as null quietly; other failures are logged", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "computerbug-brain-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const logged: string[] = [];
  const log = (message: string) => logged.push(message);

  const missing = path.join(dir, "connectome.bin");
  assert.equal(hasBrainData(missing), false);
  assert.equal(await readBrainData(missing, log), null);
  assert.deepEqual(logged, []);

  await writeFile(missing, Buffer.from([1, 2, 3]));
  assert.equal(hasBrainData(missing), true);
  assert.deepEqual([...(await readBrainData(missing, log))!], [1, 2, 3]);

  assert.equal(await readBrainData(dir, log), null);
  assert.equal(logged.length, 1);
});
