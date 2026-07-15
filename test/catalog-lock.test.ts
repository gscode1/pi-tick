// test/catalog-lock.test.ts — cooperative file locking around jobs.json.
//
// Issue #5: two concurrent `cmdRun` processes for the same job (or any
// other writer) used to both loadCatalog → mutate lastRun → saveCatalog,
// and the second writer would clobber the first's update. The fix is a
// `withCatalogLock(fn)` helper that takes a global lockfile at
// `<dataDir>/jobs.json.lock` before every mutating load+save pair.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  withCatalogLock,
  catalogLockPath,
  PiTickError,
} from "../extensions/tick/bin/catalog.mjs";
import { withTempDir, setupEnv, withEnv, teardownEnv, fileMode } from "./_helpers.ts";
import { join } from "node:path";
import {
  existsSync,
  writeFileSync,
  readFileSync,
  openSync,
  closeSync,
  unlinkSync,
  statSync,
  utimesSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Build an env suitable for spawning a child that can import the CLI.
function buildChildEnv(env: { [k: string]: string }): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith("__")) continue;
    childEnv[k] = String(v);
  }
  return childEnv;
}

// withCatalogLock/loadCatalog/saveCatalog/findJob live in catalog.mjs — the
// child processes below import directly from it now that pi-tick.mjs no
// longer re-exports tick-core's internals (issue #63).
const CATALOG_PATH = fileURLToPath(new URL("../extensions/tick/bin/catalog.mjs", import.meta.url));

// T1 — withCatalogLock creates jobs.json.lock with mode 0600 and removes it on return.
test("withCatalogLock creates jobs.json.lock with mode 0600 and removes it on return", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await withEnv(env, async () => {
        const lockPath = join(dir, "jobs.json.lock");
        assert.equal(existsSync(lockPath), false, "lockfile absent before acquire");
        const result = await withCatalogLock(async () => {
          // Held during the body.
          assert.equal(existsSync(lockPath), true, "lockfile present mid-body");
          assert.equal(fileMode(lockPath), 0o600, "lockfile mode is 0600");
          return 42;
        });
        assert.equal(result, 42);
        // Released after the body.
        assert.equal(existsSync(lockPath), false, "lockfile removed on return");
      });
    } finally {
      teardownEnv(env);
    }
  });
});

// T2 — withCatalogLock serializes two concurrent acquisitions across child processes.
test("withCatalogLock serializes concurrent acquisitions across processes", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      // Seed an empty catalog so children can call loadCatalog inside the wrap.
      writeFileSync(
        join(dir, "jobs.json"),
        JSON.stringify({ version: 1, jobs: [] }),
        { mode: 0o600 },
      );
      const startPath = join(dir, "starts.jsonl");
      // Shared parent-recorded start: each child writes its body-start
      // relative to this anchor so the test is robust to spawn jitter.
      const parentStart = Date.now();
      const childScript = `
        import { withCatalogLock, loadCatalog, saveCatalog } from ${JSON.stringify("file://" + CATALOG_PATH)};
        import { appendFileSync } from "node:fs";
        const startPath = ${JSON.stringify(startPath)};
        const parentStart = ${parentStart};
        const attempt = Date.now() - parentStart;
        appendFileSync(startPath, JSON.stringify({phase:"attempt", t: attempt}) + "\\n");
        await withCatalogLock(async () => {
          const bodyT = Date.now() - parentStart;
          appendFileSync(startPath, JSON.stringify({phase:"body", t: bodyT}) + "\\n");
          // Sleep 500ms inside the body so the second child must wait.
          // Same stdlib-only trick as the lock helper: Atomics.wait on a
          // SharedArrayBuffer parks the thread without burning CPU.
          const sab = new SharedArrayBuffer(4);
          const view = new Int32Array(sab);
          Atomics.wait(view, 0, 0, 500);
          // Touch the catalog so we exercise a realistic load+save.
          const c = loadCatalog();
          saveCatalog(c);
        });
        appendFileSync(startPath, JSON.stringify({phase:"done", t: Date.now() - parentStart}) + "\\n");
      `;
      const childEnv = buildChildEnv(env);
      await Promise.all(
        Array.from({ length: 2 }, () =>
          new Promise<void>((resolve, reject) => {
            const child = spawn(
              process.execPath,
              ["--input-type=module", "-e", childScript],
              { env: childEnv, stdio: ["ignore", "pipe", "pipe"] },
            );
            let stderr = "";
            child.stderr.on("data", (c) => { stderr += c.toString("utf8"); });
            child.on("close", (code) =>
              code === 0 ? resolve() : reject(new Error(`child exit ${code}: ${stderr}`)),
            );
            child.on("error", reject);
          }),
        ),
      );
      // Read both body-start timestamps, assert the second was at least
      // 450ms after the first (allow 50ms jitter under the 500ms sleep).
      const lines = readFileSync(startPath, "utf8").split("\n").filter(Boolean);
      const bodies = lines
        .map((l) => JSON.parse(l))
        .filter((e: { phase: string }) => e.phase === "body")
        .map((e: { t: number }) => e.t)
        .sort((a: number, b: number) => a - b);
      assert.equal(bodies.length, 2, `expected 2 body entries, got ${bodies.length}: ${lines.join(" | ")}`);
      assert.ok(
        bodies[1] - bodies[0] >= 450,
        `expected second body to start >=450ms after first; got delta=${bodies[1] - bodies[0]}ms (raw bodies=${JSON.stringify(bodies)})`,
      );
    } finally {
      teardownEnv(env);
    }
  });
});

// T3 — withCatalogLock steals a stale lockfile (mtime > staleMs).
test("withCatalogLock steals a stale lock file (mtime > staleMs)", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await withEnv(env, async () => {
        const lockPath = join(dir, "jobs.json.lock");
        // Pre-create a stale lockfile: owned by a "dead" process.
        const oldFd = openSync(lockPath, "w", 0o600);
        closeSync(oldFd);
        const past = new Date(Date.now() - 60_000);
        utimesSync(lockPath, past, past);
        const beforeSteal = Date.now();
        // Use staleMs: 30_000 to match the production default; the file
        // is 60s old, so stale-steal kicks in.
        await withCatalogLock(async () => {
          // Inside the body: the lockfile is the one we opened (mode
          // 0600, owned by us), with a recent mtime.
          assert.equal(existsSync(lockPath), true);
          assert.equal(fileMode(lockPath), 0o600);
          const st = statSync(lockPath);
          // mtime must have been refreshed by our openSync("wx") — give
          // a 1s grace for filesystem timestamp resolution.
          assert.ok(
            st.mtimeMs >= beforeSteal - 1000,
            `stale lockfile mtime not refreshed (st.mtimeMs=${st.mtimeMs}, beforeSteal=${beforeSteal})`,
          );
        }, { staleMs: 30_000 });
        // Released after the body.
        assert.equal(existsSync(lockPath), false);
      });
    } finally {
      teardownEnv(env);
    }
  });
});

// T4 — withCatalogLock throws PiTickError(1) when acquire times out.
test("withCatalogLock throws PiTickError(1) when acquire times out", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await withEnv(env, async () => {
        const lockPath = join(dir, "jobs.json.lock");
        // Pre-create a FRESH lockfile (not stale) so the timeout path
        // is taken instead of stale-steal. Setting staleMs high keeps
        // the file "held" from our perspective.
        const fd = openSync(lockPath, "w", 0o600);
        closeSync(fd);
        try {
          await assert.rejects(
            async () => await withCatalogLock(async () => 0, { acquireMs: 300, staleMs: 60_000 }),
            (err: unknown) =>
              err instanceof PiTickError &&
              err.code === 1 &&
              /could not acquire catalog lock/.test(err.message),
          );
        } finally {
          // Clean up the lockfile the timeout didn't release.
          try { unlinkSync(lockPath); } catch { /* */ }
        }
      });
    } finally {
      teardownEnv(env);
    }
  });
});

// T5 — concurrent lastRun updates produce a well-formed lastRun object.
test("concurrent lastRun updates produce a well-formed lastRun object", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      // Seed a catalog with one job whose lastRun is null.
      writeFileSync(
        join(dir, "jobs.json"),
        JSON.stringify({
          version: 1,
          jobs: [{
            id: "race",
            prompt: "x",
            cwd: "/tmp",
            schedule: { kind: "daily", value: { time: "09:00" } },
            enabled: false,
            model: null,
            piPath: null,
            nodePath: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            lastRun: null,
          }],
        }),
        { mode: 0o600 },
      );
      // Each child does a full mutating wrap with a distinct exitCode.
      const childScript = `
        import { withCatalogLock, loadCatalog, findJob, saveCatalog } from ${JSON.stringify("file://" + CATALOG_PATH)};
        const exitCode = Number(process.env.CHILD_EXIT);
        const startedAt = "2026-01-01T00:00:0" + exitCode + ".000Z";
        const finishedAt = "2026-01-01T00:00:0" + (exitCode + 1) + ".000Z";
        await withCatalogLock(async () => {
          const cat = loadCatalog();
          const j = findJob(cat, "race");
          j.lastRun = {
            startedAt,
            finishedAt,
            exitCode,
            reason: "exit_code",
            error: null,
          };
          j.updatedAt = finishedAt;
          saveCatalog(cat);
        });
      `;
      const childEnv = buildChildEnv(env);
      await Promise.all(
        [0, 1, 2, 3].map((exitCode) => {
          const per = { ...childEnv, CHILD_EXIT: String(exitCode) };
          return new Promise<void>((resolve, reject) => {
            const child = spawn(
              process.execPath,
              ["--input-type=module", "-e", childScript],
              { env: per, stdio: ["ignore", "pipe", "pipe"] },
            );
            let stderr = "";
            child.stderr.on("data", (c) => { stderr += c.toString("utf8"); });
            child.on("close", (code) =>
              code === 0 ? resolve() : reject(new Error(`child ${exitCode} exit ${code}: ${stderr}`)),
            );
            child.on("error", reject);
          });
        }),
      );
      // Read the final catalog. Exactly one child "won" the slot; the
      // other three saved JSON that was clobbered. The point of this
      // test is well-formedness: lastRun must exist and have the right
      // shape, not be torn or missing.
      const final = JSON.parse(readFileSync(join(dir, "jobs.json"), "utf8"));
      const lr = final.jobs[0].lastRun;
      assert.ok(lr, "lastRun exists");
      assert.equal(typeof lr.startedAt, "string");
      assert.equal(typeof lr.finishedAt, "string");
      assert.ok(Number.isInteger(lr.exitCode) && lr.exitCode >= 0 && lr.exitCode < 4,
        `exitCode must be one of 0..3 (got ${lr.exitCode})`);
      assert.equal(lr.reason, "exit_code");
      assert.equal(lr.error, null);
      assert.equal(typeof final.jobs[0].updatedAt, "string");
    } finally {
      teardownEnv(env);
    }
  });
});

// T6 (issue #52) — a lock file 8s old is reaped under the *default* staleMs,
// without the caller passing an explicit override. Before the fix,
// STALE_LOCK_MS (30s) was greater than ACQUIRE_TIMEOUT_MS (10s), so a
// contender arriving in that 10–30s window would time out before the stale
// lock was ever eligible for reaping.
test("withCatalogLock reaps an 8s-old lock under the default staleMs (issue #52)", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await withEnv(env, async () => {
        const lockPath = join(dir, "jobs.json.lock");
        const fd = openSync(lockPath, "w", 0o600);
        closeSync(fd);
        const past = new Date(Date.now() - 8_000);
        utimesSync(lockPath, past, past);
        let ran = false;
        // No staleMs override: exercises the production default.
        await withCatalogLock(async () => { ran = true; });
        assert.equal(ran, true, "callback ran — stale lock was reaped, no timeout");
      });
    } finally {
      teardownEnv(env);
    }
  });
});
