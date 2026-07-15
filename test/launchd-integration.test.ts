// test/launchd-integration.test.ts
//
// macOS-only smoke test that exercises real launchctl + real plist bootstrap.
// Skipped on non-darwin. Run via `npm run test:macos`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, statSync, writeFileSync, chmodSync, readFileSync, mkdirSync, rmSync, mkdtempSync, openSync, closeSync, readdirSync } from "node:fs";
import { join, delimiter, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { listBundleFiles, bundledPath } from "../extensions/tick/bundle.mjs";

const isMac = process.platform === "darwin";
const SKIP = !isMac;
const macOnly = SKIP ? test.skip : test;

if (SKIP) {
  // The default CI matrix is Linux, so this file is excluded by being non-darwin.
  // Emit a single visible skip line so the user sees it ran (or didn't).
  test("launchd-integration: skipped on non-darwin", { skip: true }, () => {});
}

function uniqueId() {
  return `smoke-${Date.now()}-${process.pid}`;
}

function sh(cmd: string, args: string[], opts: { env?: Record<string, string> } = {}) {
  return spawnSync(cmd, args, {
    env: { ...process.env, ...(opts.env || {}) },
    encoding: "utf8",
  });
}

function withIsolatedEnv<T>(dataDir: string, plistDir: string, fn: () => T | Promise<T>): Promise<T> {
  const saved = { ...process.env };
  process.env.PI_TICK_DATA_DIR = dataDir;
  process.env.PI_TICK_PLIST_DIR = plistDir;
  // Empty PATH for the `which` lookup inside the CLI so it doesn't see the user's pi.
  // We don't want to actually fire a real pi in this smoke test; we only test launchctl registration.
  const PATH = "/usr/bin:/bin";
  process.env.PATH = PATH;
  return Promise.resolve().then(() => fn()).finally(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in saved)) delete process.env[k];
    }
    for (const [k, v] of Object.entries(saved)) {
      process.env[k] = v as string;
    }
  });
}

macOnly("launchd-integration: add --enabled creates a loaded plist, then disable/delete cleans up", async () => {
  // Use unique data + plist dirs so we never touch the real user's data.
  const base = mkdtempSync(join(tmpdir(), "pi-tick-smoke-"));
  const dataDir = join(base, "data");
  const plistDir = join(base, "agents");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(plistDir, { recursive: true });

  // Ship every file in the bundle manifest (issue #60) — the same list the
  // extension's session_start sync installs. Previously this test hand-listed
  // five files and missed run-registry.mjs/transcript-view.mjs entirely; a
  // manifest-driven copy can't drift from what a real sync installs.
  for (const rel of listBundleFiles()) {
    const dest = join(dataDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(bundledPath(rel)));
  }
  const stableCli = join(dataDir, "pi-tick.mjs");
  chmodSync(stableCli, 0o755);

  // Structural check: catch regressions if the sibling layout ever changes.
  assert.ok(existsSync(join(dataDir, "paths.mjs")), "paths.mjs shipped");
  assert.ok(existsSync(join(dataDir, "run-registry.mjs")), "run-registry.mjs shipped");
  assert.ok(existsSync(join(dataDir, "transcript-view.mjs")), "transcript-view.mjs shipped");
  const backendsSrc = join(new URL("../extensions/tick/bin", import.meta.url).pathname, "backends");
  const copied = readdirSync(join(dataDir, "backends")).filter((f) => f.endsWith(".mjs")).sort();
  const source = readdirSync(backendsSrc).filter((f) => f.endsWith(".mjs")).sort();
  assert.deepEqual(copied, source, "backends/*.mjs shipped");

  const jobId = uniqueId();
  let exitCode = 0;
  try {
    exitCode = await withIsolatedEnv(dataDir, plistDir, () => {
      // We need a fake `pi` on PATH for `which pi` to succeed; stub it with a 0-exit script.
      const stubDir = join(base, "stubs");
      mkdirSync(stubDir, { recursive: true });
      writeFileSync(join(stubDir, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      chmodSync(join(stubDir, "pi"), 0o755);
      // And a `node` on PATH so resolveNodePath works.
      writeFileSync(join(stubDir, "node"), `#!/bin/sh\necho fake\n`, { mode: 0o755 });
      chmodSync(join(stubDir, "node"), 0o755);
      process.env.PATH = `${stubDir}${delimiter}${process.env.PATH}`;
      // Use the synced stable CLI to add a job with --enabled.
      const res = sh(process.execPath, [stableCli, "add", jobId, "--prompt", "echo hi", "--cwd", tmpdir(), "--kind", "interval", "--seconds", "30", "--enabled"]);
      if (res.status !== 0) {
        throw new Error(`add --enabled failed: ${res.stdout} ${res.stderr}`);
      }
      return 0;
    });
    assert.equal(exitCode, 0);

    // Plist file should exist on disk
    const pp = join(plistDir, `dev.pi.tick.${jobId}.plist`);
    assert.ok(existsSync(pp), `plist exists at ${pp}`);

    // launchctl print should report the service as loaded
    const printRes = sh("launchctl", ["print", `gui/${process.getuid()}/dev.pi.tick.${jobId}`], { env: { LAUNCHD_PRINT_DISABLE_BUFFER: "1" } });
    // The output should NOT contain "Could not find service"
    assert.ok(!/Could not find service/.test(printRes.stderr), `service should be loaded; got: ${printRes.stderr}`);
    assert.ok(!/Could not find service/.test(printRes.stdout), `service should be loaded; got: ${printRes.stdout}`);

    // Now disable
    exitCode = await withIsolatedEnv(dataDir, plistDir, () => {
      const res = sh(process.execPath, [stableCli, "disable", jobId]);
      if (res.status !== 0) throw new Error(`disable failed: ${res.stdout} ${res.stderr}`);
      return 0;
    });
    assert.equal(exitCode, 0);
    assert.ok(!existsSync(pp), "plist unlinked after disable");

    // And delete
    exitCode = await withIsolatedEnv(dataDir, plistDir, () => {
      const res = sh(process.execPath, [stableCli, "delete", jobId]);
      if (res.status !== 0) throw new Error(`delete failed: ${res.stdout} ${res.stderr}`);
      return 0;
    });
    assert.equal(exitCode, 0);
    assert.ok(!existsSync(pp), "plist not present after delete");
    const cat = JSON.parse(readFileSync(join(dataDir, "jobs.json"), "utf8"));
    assert.equal(cat.jobs.find((j: { id: string }) => j.id === jobId), undefined);
  } finally {
    // Cleanup
    try {
      // Best-effort: disable and delete the job, then remove the temp dir.
      withIsolatedEnv(dataDir, plistDir, () => {
        sh(process.execPath, [stableCli, "delete", jobId]);
      });
    } catch { /* */ }
    try { rmSync(base, { recursive: true, force: true }); } catch { /* */ }
  }
});
