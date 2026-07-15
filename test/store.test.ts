// test/store.test.ts — catalog I/O: atomicity, mode 0600, corrupt handling.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  writeAtomic,
  loadCatalog,
  saveCatalog,
  findJob,
  appendJsonl,
  RUNTIME_DEFAULTS,
} from "../extensions/tick/bin/catalog.mjs";
import { withTempDir, setupEnv, withEnv, teardownEnv, fileMode } from "./_helpers.ts";
import { join, sep } from "node:path";
import { writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

test("writeAtomic creates a file with mode 0600", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await withEnv(env, () => {
        const path = join(dir, "secret.json");
        writeAtomic(path, { a: 1 });
        assert.ok(existsSync(path));
        assert.equal(fileMode(path), 0o600);
        assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { a: 1 });
      });
    } finally {
      teardownEnv(env);
    }
  });
});

test("writeAtomic overwrites an existing file (atomic rename)", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await withEnv(env, () => {
        const path = join(dir, "secret.json");
        writeAtomic(path, { v: 1 });
        writeAtomic(path, { v: 2 });
        assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { v: 2 });
        // No .tmp file left behind
        assert.ok(!existsSync(path + ".tmp"));
      });
    } finally {
      teardownEnv(env);
    }
  });
});

test("loadCatalog returns empty array for fresh data dir", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await withEnv(env, () => {
        const cat = loadCatalog();
        assert.equal(cat.version, 1);
        assert.deepEqual(cat.jobs, []);
        // The catalog file was created on first read.
        assert.ok(existsSync(join(dir, "jobs.json")));
        assert.equal(fileMode(join(dir, "jobs.json")), 0o600);
      });
    } finally {
      teardownEnv(env);
    }
  });
});

test("loadCatalog rejects corrupt JSON", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await withEnv(env, () => {
        // First call would create the catalog; manually corrupt it.
        loadCatalog();
        writeFileSync(join(dir, "jobs.json"), "{ not json", "utf8");
        assert.throws(() => loadCatalog(), /JSON|Unexpected/);
      });
    } finally {
      teardownEnv(env);
    }
  });
});

test("loadCatalog rejects a catalog missing the jobs array", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await withEnv(env, () => {
        writeFileSync(join(dir, "jobs.json"), JSON.stringify({ version: 1 }), "utf8");
        assert.throws(() => loadCatalog(), /malformed/);
      });
    } finally {
      teardownEnv(env);
    }
  });
});

test("saveCatalog round-trips a job through loadCatalog", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await withEnv(env, () => {
        const cat = loadCatalog();
        cat.jobs.push({
          id: "test-job",
          prompt: "hello",
          cwd: "/tmp",
          schedule: { kind: "daily", value: { time: "09:00" } },
          enabled: false,
          model: null,
          piPath: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          lastRun: null,
        });
        saveCatalog(cat);

        const reloaded = loadCatalog();
        assert.equal(reloaded.jobs.length, 1);
        const found = findJob(reloaded, "test-job");
        assert.ok(found);
        assert.equal(found!.prompt, "hello");
      });
    } finally {
      teardownEnv(env);
    }
  });
});

test("appendJsonl writes one JSON object per line and is mode 0600", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await withEnv(env, () => {
        const path = join(dir, "runs.jsonl");
        appendJsonl(path, { a: 1 });
        appendJsonl(path, { a: 2 });
        const content = readFileSync(path, "utf8");
        const lines = content.split("\n").filter(Boolean);
        assert.equal(lines.length, 2);
        assert.deepEqual(JSON.parse(lines[0]), { a: 1 });
        assert.deepEqual(JSON.parse(lines[1]), { a: 2 });
      });
    } finally {
      teardownEnv(env);
    }
  });
});

test("findJob returns null for missing id", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await withEnv(env, () => {
        const cat = loadCatalog();
        assert.equal(findJob(cat, "nope"), null);
      });
    } finally {
      teardownEnv(env);
    }
  });
});

// Regression: writeAtomic used a fixed `${path}.tmp` name, so two
// processes racing on the same path could both `writeFileSync` and one
// would then `renameSync` an already-renamed file → ENOENT → crash.
// The fix uses a per-pid + counter tmp name, so concurrent writers no
// longer collide. This test spawns N node processes all writing to the
// same path; none should throw, and no leftover .tmp files should remain.
test("writeAtomic is safe under concurrent writers", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await withEnv(env, async () => {
        const path = join(dir, "shared.json");
        // writeAtomic lives in catalog.mjs, not pi-tick.mjs (issue #63).
        const cli = fileURLToPath(new URL("../extensions/tick/bin/catalog.mjs", import.meta.url));
        const N = 8;
        const childEnv: NodeJS.ProcessEnv = { ...process.env };
        for (const [k, v] of Object.entries(env)) {
          if (!k.startsWith("__")) childEnv[k] = String(v);
        }
        await Promise.all(
          Array.from({ length: N }, (_, i) =>
            new Promise<void>((resolve, reject) => {
              const child = spawn(
                process.execPath,
                [
                  "-e",
                  `import(${JSON.stringify("file://" + cli)}).then(m => { m.writeAtomic(${JSON.stringify(path)}, { v: ${i} }); process.exit(0); }).catch(e => { console.error(e); process.exit(1); });`,
                ],
                { env: childEnv, stdio: ["ignore", "pipe", "pipe"] },
              );
              let stderr = "";
              child.stderr.on("data", (c) => { stderr += c.toString("utf8"); });
              child.on("close", (code) =>
                code === 0 ? resolve() : reject(new Error(`child ${i} exit ${code}: ${stderr}`)),
              );
            }),
          ),
        );
        const final = JSON.parse(readFileSync(path, "utf8"));
        assert.ok(typeof final.v === "number" && final.v >= 0 && final.v < N);
        const leftover = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
        assert.deepEqual(leftover, [], `unexpected leftover .tmp files: ${leftover.join(", ")}`);
      });
    } finally {
      teardownEnv(env);
    }
  });
});

// Issue #61 — the per-job runtime-control defaults (timeout/idle-timeout/
// max-output-bytes/kill-grace) used to be redeclared in both runner.mjs
// (the copy actually applied to a run) and tick-core.mjs (a stale copy,
// three of whose four fields were never read). RUNTIME_DEFAULTS is now the
// one place either module reads; this pins the contract both depend on.
test("RUNTIME_DEFAULTS holds the documented defaults for all four runtime controls", () => {
  assert.deepEqual(RUNTIME_DEFAULTS, {
    timeoutMs: 30 * 60 * 1000,
    idleTimeoutMs: 0,
    maxOutputBytes: 0,
    killGraceMs: 5000,
  });
});
