import assert from "node:assert/strict";
import { test } from "node:test";
import type { execFile } from "node:child_process";
import { shutdownDevice } from "./device-shutdown.ts";

test("shutdown executes only fixed noninteractive platform commands without a shell", async (t) => {
  for (const platform of ["linux", "darwin"] as const) {
    let executed = 0;
    await shutdownDevice({ platform, execute: t.mock.fn((file: unknown, args: unknown, options: unknown, done: (error: unknown) => void) => {
      executed++;
      assert.equal(file, "/usr/bin/sudo");
      assert.deepEqual(args, platform === "linux" ? ["-n", "/usr/bin/systemctl", "poweroff", "--force"] : ["-n", "/sbin/shutdown", "-h", "now"]);
      assert.deepEqual(options, { shell: false, timeout: 10_000 });
      done(null);
    }) as unknown as typeof execFile });
    assert.equal(executed, 1);
  }
});

test("unsupported platforms do nothing; permission errors and missing executables log locally", async () => {
  let errors = 0;
  const log = () => { errors++; };
  await shutdownDevice({ platform: "win32", execute: (() => { assert.fail("Windows must not execute"); }) as unknown as typeof execFile, log });
  assert.equal(errors, 0);
  await shutdownDevice({ platform: "linux", log, execute: ((_file: unknown, _args: unknown, _options: unknown, done: (error: unknown) => void) => {
    done({ code: 1 });
  }) as unknown as typeof execFile });
  await shutdownDevice({ platform: "darwin", log, execute: (() => { throw new Error("ENOENT"); }) as unknown as typeof execFile });
  assert.equal(errors, 2);
});
