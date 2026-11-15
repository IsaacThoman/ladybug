import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS, parseSettings, SettingsStore } from "./settings.ts";

async function tempDir(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(path.join(tmpdir(), "computerbug-settings-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("settings default to off, and only known keys of the right type are read", () => {
  assert.deepEqual(DEFAULT_SETTINGS, { flyBrain: false, brainActivity: false });
  assert.deepEqual(parseSettings("not json"), DEFAULT_SETTINGS);
  assert.deepEqual(parseSettings("null"), DEFAULT_SETTINGS);
  assert.deepEqual(parseSettings("[true]"), DEFAULT_SETTINGS);
  assert.deepEqual(parseSettings('{"flyBrain":"yes","brainActivity":1,"other":true}'), DEFAULT_SETTINGS);
  assert.deepEqual(parseSettings('{"flyBrain":true}'), { flyBrain: true, brainActivity: false });
});

test("a missing or corrupt settings file reads as the defaults", async (t) => {
  const dir = await tempDir(t);
  assert.deepEqual(new SettingsStore(path.join(dir, "missing", "settings.json")).get(), DEFAULT_SETTINGS);
  const corrupt = path.join(dir, "corrupt.json");
  await writeFile(corrupt, '{"flyBrain": tr');
  assert.deepEqual(new SettingsStore(corrupt).get(), DEFAULT_SETTINGS);
});

test("changes apply at once, are saved in order and survive a restart", async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, "nested", "settings.json");
  const store = new SettingsStore(file);
  const first = store.set({ flyBrain: true });
  assert.equal(store.get().flyBrain, true);
  const second = store.set({ brainActivity: true, flyBrain: false });
  await Promise.all([first, second]);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { flyBrain: false, brainActivity: true });
  assert.deepEqual(new SettingsStore(file).get(), { flyBrain: false, brainActivity: true });

  // get() hands out a copy.
  const copy = store.get();
  copy.flyBrain = true;
  assert.equal(store.get().flyBrain, false);
});

test("a failed save is reported, and the setting still applies for this run", async (t) => {
  const dir = await tempDir(t);
  const blocker = path.join(dir, "file");
  await writeFile(blocker, "");
  const errors: unknown[] = [];
  const store = new SettingsStore(path.join(blocker, "settings.json"), { onError: (error) => errors.push(error) });
  await store.set({ flyBrain: true });
  assert.equal(errors.length, 1);
  assert.equal(store.get().flyBrain, true);
});
