import assert from "node:assert/strict";
import { test } from "node:test";
import type { execFile } from "node:child_process";
import { killChrome } from "./browser-kill.ts";

test("Chrome termination uses a fixed executable, exact platform name and current UID without a shell", async (t) => {
  for (const [platform, name] of [["linux", "chrome"], ["darwin", "Google Chrome"]] as const) {
    await t.test(platform, async () => {
      const execute = t.mock.fn((file, args, options, callback) => {
        assert.equal(file, "/usr/bin/pkill");
        assert.deepEqual(args, ["-KILL", "-u", "1234", "-x", name]);
        assert.deepEqual(options, { shell: false, timeout: 5000 });
        callback(null);
      });
      await killChrome({ platform, uid: () => 1234, execute: execute as unknown as typeof execFile });
      assert.equal(execute.mock.callCount(), 1);
    });
  }
  const execute = t.mock.fn();
  await killChrome({ platform: "win32", execute: execute as unknown as typeof execFile });
  assert.equal(execute.mock.callCount(), 0);
});

test("missing Chrome is a no-op; process execution failures log only bounded operational text", async (t) => {
  for (const code of [1, 2, "ENOENT"]) {
    const log = t.mock.fn();
    const execute = (_file: unknown, _args: unknown, _options: unknown, callback: (error: unknown) => void) => callback({ code });
    await killChrome({ platform: "linux", uid: () => 1234, execute: execute as unknown as typeof execFile, log });
    assert.equal(log.mock.callCount(), code === 1 ? 0 : 1);
    if (code !== 1) assert.deepEqual(log.mock.calls[0].arguments, []);
  }
  const log = t.mock.fn();
  await killChrome({ platform: "linux", uid: () => 1234, execute: (() => { throw new Error("private"); }) as unknown as typeof execFile, log });
  assert.equal(log.mock.callCount(), 1);
});
