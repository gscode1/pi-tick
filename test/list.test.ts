// test/list.test.ts — list and log output formatting.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cmdList } from "../extensions/tick/bin/commands/list.mjs";
import { cmdLog, parseSinceDuration } from "../extensions/tick/bin/commands/log.mjs";
import { printTable, formatSchedule, formatNextFire, humanizeSeconds } from "../extensions/tick/bin/display.mjs";
import { appendJsonl } from "../extensions/tick/bin/catalog.mjs";
import { formatLocal, tailLines } from "../extensions/tick/bin/format.mjs";
import { withTempDir, setupEnv, withEnv, teardownEnv } from "./_helpers.ts";
import { join } from "node:path";
import { writeFileSync, existsSync } from "node:fs";

function makeJob(overrides: Partial<{
  id: string;
  prompt: string;
  cwd: string;
  scheduleKind: "interval" | "daily" | "weekly";
  scheduleValue: Record<string, unknown>;
  enabled: boolean;
  model: string | null;
  lastRun: { startedAt: string; finishedAt: string; exitCode: number; error: string | null } | null;
}> = {}) {
  return {
    id: overrides.id ?? "test-job",
    prompt: overrides.prompt ?? "hello",
    cwd: overrides.cwd ?? "/tmp",
    schedule:
      overrides.scheduleKind === "interval"
        ? { kind: "interval", value: overrides.scheduleValue ?? { minutes: 5, seconds: 0 } }
        : overrides.scheduleKind === "weekly"
          ? { kind: "weekly", value: overrides.scheduleValue ?? { days: ["monday"], time: "09:00" } }
          : { kind: "daily", value: overrides.scheduleValue ?? { time: "09:00" } },
    enabled: overrides.enabled ?? false,
    model: overrides.model ?? null,
    piPath: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastRun: overrides.lastRun ?? null,
  };
}

async function seedJobs(env: ReturnType<typeof setupEnv>, jobs: ReturnType<typeof makeJob>[]) {
  await withEnv(env, () => {
    // Touch the catalog by running cmdList once, then write directly.
    cmdList([], { stdout: process.stdout as any, stderr: process.stderr as any });
  });
  // Now overwrite the catalog with our seed.
  const cat = { version: 1, jobs };
  writeFileSync(join(env.PI_TICK_DATA_DIR, "jobs.json"), JSON.stringify(cat, null, 2), "utf8");
}

test("cmdList on empty catalog prints '(no jobs)'", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      const out: string[] = [];

      const stdout = {

        write: (chunk: string | Uint8Array) => {

          out.push(typeof chunk === "string" ? chunk : chunk.toString());

          return true;

        }

      } as typeof process.stdout;

      await withEnv(env, () => cmdList([], { stdout, stderr: process.stderr as any }));
      assert.equal(out.join("").trim(), "(no jobs)");
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdList --json returns parseable JSON", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await seedJobs(env, [makeJob({ id: "alpha" })]);
      const out: string[] = [];

      const stdout = {

        write: (chunk: string | Uint8Array) => {

          out.push(typeof chunk === "string" ? chunk : chunk.toString());

          return true;

        }

      } as typeof process.stdout;

      await withEnv(env, () => cmdList(["--json"], { stdout, stderr: process.stderr as any }));
      const parsed = JSON.parse(out.join(""));
      assert.ok(Array.isArray(parsed));
      assert.equal(parsed.length, 1);
      assert.equal(parsed[0].id, "alpha");
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdList shows expected columns for one job", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await seedJobs(env, [
        makeJob({ id: "alpha", enabled: true, scheduleKind: "daily", scheduleValue: { time: "09:00" } }),
        makeJob({ id: "beta", enabled: false, scheduleKind: "interval", scheduleValue: { minutes: 5, seconds: 0 } }),
      ]);
      const out: string[] = [];

      const stdout = {

        write: (chunk: string | Uint8Array) => {

          out.push(typeof chunk === "string" ? chunk : chunk.toString());

          return true;

        }

      } as typeof process.stdout;

      await withEnv(env, () => cmdList([], { stdout, stderr: process.stderr as any }));
      const text = out.join("");
      assert.match(text, /alpha/);
      assert.match(text, /beta/);
      // enabled yes/no
      assert.match(text, /\byes\b/);
      assert.match(text, /\bno\b/);
      // schedule summary
      assert.match(text, /daily @ 09:00/);
      assert.match(text, /every 5m/);
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdList shows '--' for next-fire on disabled jobs", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await seedJobs(env, [makeJob({ id: "draft", enabled: false })]);
      const out: string[] = [];

      const stdout = {

        write: (chunk: string | Uint8Array) => {

          out.push(typeof chunk === "string" ? chunk : chunk.toString());

          return true;

        }

      } as typeof process.stdout;

      await withEnv(env, () => cmdList([], { stdout, stderr: process.stderr as any }));
      const text = out.join("");
      assert.match(text, /--/);
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdList shows 'never' for last-run on a job that has not run", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await seedJobs(env, [makeJob({ id: "fresh", lastRun: null })]);
      const out: string[] = [];

      const stdout = {

        write: (chunk: string | Uint8Array) => {

          out.push(typeof chunk === "string" ? chunk : chunk.toString());

          return true;

        }

      } as typeof process.stdout;

      await withEnv(env, () => cmdList([], { stdout, stderr: process.stderr as any }));
      const text = out.join("");
      assert.match(text, /never/);
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdList includes last-run timestamp when a job has run", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await seedJobs(env, [makeJob({
        id: "done",
        lastRun: {
          startedAt: "2026-01-01T00:00:00.000Z",
          finishedAt: "2026-01-01T00:00:06.000Z",
          exitCode: 0,
          error: null,
        },
      })]);
      const out: string[] = [];

      const stdout = {

        write: (chunk: string | Uint8Array) => {

          out.push(typeof chunk === "string" ? chunk : chunk.toString());

          return true;

        }

      } as typeof process.stdout;

      await withEnv(env, () => cmdList([], { stdout, stderr: process.stderr as any }));
      assert.match(out.join(""), /runner-finished\s+runner-exit\s+duration/);
      assert.match(out.join(""), /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\s+0\s+6s/);
      assert.doesNotMatch(out.join(""), /2026-01-01T00:00:06\.000Z/);
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdLog on missing runs.jsonl prints '(no runs yet)'", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      const out: string[] = [];

      const stdout = {

        write: (chunk: string | Uint8Array) => {

          out.push(typeof chunk === "string" ? chunk : chunk.toString());

          return true;

        }

      } as typeof process.stdout;

      await withEnv(env, () => cmdLog([], { stdout, stderr: process.stderr as any }));
      assert.equal(out.join("").trim(), "(no runs yet)");
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdLog shows runId column", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await withEnv(env, () => {
        appendJsonl(join(env.PI_TICK_DATA_DIR, "runs.jsonl"), {
          runId: "abcd1234", jobId: "alpha", triggerKind: "external",
          startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:05.000Z",
          exitCode: 0, error: null,
        });
      });
      const out: string[] = [];

      const stdout = {

        write: (chunk: string | Uint8Array) => {

          out.push(typeof chunk === "string" ? chunk : chunk.toString());

          return true;

        }

      } as typeof process.stdout;

      await withEnv(env, () => cmdLog([], { stdout, stderr: process.stderr as any }));
      const text = out.join("");
      assert.match(text, /jobId\s+runId\s+startedAt/);
      assert.match(text, /alpha\s+abcd1234/);
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdLog filters by jobId", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await withEnv(env, () => {
        appendJsonl(join(env.PI_TICK_DATA_DIR, "runs.jsonl"), {
          runId: "r1", jobId: "alpha", triggerKind: "external",
          startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:05.000Z",
          exitCode: 0, error: null,
        });
        appendJsonl(join(env.PI_TICK_DATA_DIR, "runs.jsonl"), {
          runId: "r2", jobId: "beta", triggerKind: "external",
          startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:02.000Z",
          exitCode: 0, error: null,
        });
      });
      const out: string[] = [];

      const stdout = {

        write: (chunk: string | Uint8Array) => {

          out.push(typeof chunk === "string" ? chunk : chunk.toString());

          return true;

        }

      } as typeof process.stdout;

      await withEnv(env, () => cmdLog(["alpha"], { stdout, stderr: process.stderr as any }));
      const text = out.join("");
      assert.match(text, /alpha/);
      assert.doesNotMatch(text, /\bbeta\b/);
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdLog respects --limit", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await withEnv(env, () => {
        for (let i = 0; i < 20; i++) {
          appendJsonl(join(env.PI_TICK_DATA_DIR, "runs.jsonl"), {
            runId: `r${i}`, jobId: "x", triggerKind: "external",
            startedAt: `2026-01-01T00:${String(i).padStart(2, "0")}:00.000Z`,
            finishedAt: `2026-01-01T00:${String(i).padStart(2, "0")}:05.000Z`,
            exitCode: 0, error: null,
          });
        }
      });
      const out: string[] = [];

      const stdout = {

        write: (chunk: string | Uint8Array) => {

          out.push(typeof chunk === "string" ? chunk : chunk.toString());

          return true;

        }

      } as typeof process.stdout;

      await withEnv(env, () => cmdLog(["--limit", "5"], { stdout, stderr: process.stderr as any }));
      // Header + 5 rows = 6 lines.
      const lines = out.join("").trim().split("\n");
      assert.equal(lines.length, 6);
    } finally {
      teardownEnv(env);
    }
  });
});

// ─── cmdLog: --failed and --since filters ────────────────────────────

function makeRunRecord(overrides: Record<string, unknown> = {}) {
  return {
    runId: "r" + Math.random().toString(36).slice(2, 8),
    jobId: "j",
    triggerKind: "external",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    exitCode: 0,
    error: null,
    ...overrides,
  };
}

test("parseSinceDuration accepts s/m/h/d suffixes", () => {
  assert.equal(parseSinceDuration("30s"), 30_000);
  assert.equal(parseSinceDuration("5m"), 5 * 60_000);
  assert.equal(parseSinceDuration("2h"), 2 * 3_600_000);
  assert.equal(parseSinceDuration("1d"), 86_400_000);
});

test("parseSinceDuration rejects bad input", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      for (const bad of ["abc", "5", "5x", "1.5h", "", " 1h", "1H"]) {
        await assert.rejects(
          () => withEnv(env, () => parseSinceDuration(bad)),
          /--since/,
          `should reject '${bad}'`,
        );
      }
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdLog --failed keeps only non-zero exit runs", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await withEnv(env, () => {
        const p = join(env.PI_TICK_DATA_DIR, "runs.jsonl");
        appendJsonl(p, makeRunRecord({ runId: "ok1", jobId: "j", exitCode: 0 }));
        appendJsonl(p, makeRunRecord({ runId: "bad1", jobId: "j", exitCode: 1, error: "boom" }));
        appendJsonl(p, makeRunRecord({ runId: "ok2", jobId: "j", exitCode: 0 }));
        appendJsonl(p, makeRunRecord({ runId: "bad2", jobId: "j", exitCode: 124, error: "timeout" }));
      });
      const out: string[] = [];

      const stdout = {

        write: (chunk: string | Uint8Array) => {

          out.push(typeof chunk === "string" ? chunk : chunk.toString());

          return true;

        }

      } as typeof process.stdout;

      await withEnv(env, () => cmdLog(["--failed", "--limit", "0"], { stdout, stderr: process.stderr as any }));
      const text = out.join("");
      const lines = text.trim().split("\n");
      // header + 2 failing rows (bad1, bad2); ok1/ok2 filtered out.
      assert.equal(lines.length, 3, `expected 3 lines, got ${lines.length}: ${text}`);
      // Every data row has exitCode != 0.
      for (const line of lines.slice(1)) {
        const cols = line.split(/\s{2,}/);
        const exit = Number(cols[4]);
        assert.ok(exit !== 0, `expected non-zero exit in row: ${line}`);
      }
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdLog --since keeps only runs in the window", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      const now = Date.now();
      await withEnv(env, () => {
        const p = join(env.PI_TICK_DATA_DIR, "runs.jsonl");
        // 5 min ago: inside 1h window
        appendJsonl(p, makeRunRecord({
          runId: "recent",
          jobId: "j",
          startedAt: new Date(now - 5 * 60_000).toISOString(),
        }));
        // 2 hours ago: outside 1h window
        appendJsonl(p, makeRunRecord({
          runId: "old",
          jobId: "j",
          startedAt: new Date(now - 2 * 3_600_000).toISOString(),
        }));
      });
      const out: string[] = [];

      const stdout = {

        write: (chunk: string | Uint8Array) => {

          out.push(typeof chunk === "string" ? chunk : chunk.toString());

          return true;

        }

      } as typeof process.stdout;

      await withEnv(env, () => cmdLog(["--since", "1h", "--limit", "0"], { stdout, stderr: process.stderr as any }));
      const text = out.join("");
      const lines = text.trim().split("\n");
      // Only the "recent" run is inside the 1h window.
      assert.equal(lines.length, 2, `expected 2 lines, got ${lines.length}: ${text}`);
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdLog --since with bad format exits with PiTickError", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await assert.rejects(
        () => withEnv(env, () => cmdLog(["--since", "forever"], { stdout: process.stdout as any, stderr: process.stderr as any })),
        /--since/,
      );
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdLog with filters and no matches prints a clear message", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await withEnv(env, () => {
        appendJsonl(join(env.PI_TICK_DATA_DIR, "runs.jsonl"), makeRunRecord({ jobId: "j", exitCode: 0 }));
      });
      const out: string[] = [];

      const stdout = {

        write: (chunk: string | Uint8Array) => {

          out.push(typeof chunk === "string" ? chunk : chunk.toString());

          return true;

        }

      } as typeof process.stdout;

      await withEnv(env, () => cmdLog(["--failed"], { stdout, stderr: process.stderr as any }));
      assert.match(out.join(""), /\(no runs match --failed\)/);
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdLog --failed and --since compose (AND, not OR)", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      const now = Date.now();
      await withEnv(env, () => {
        const p = join(env.PI_TICK_DATA_DIR, "runs.jsonl");
        // Recent failure — matches both.
        appendJsonl(p, makeRunRecord({
          runId: "match",
          jobId: "j",
          exitCode: 1,
          startedAt: new Date(now - 5 * 60_000).toISOString(),
        }));
        // Recent success — fails --failed.
        appendJsonl(p, makeRunRecord({
          runId: "ok_recent",
          jobId: "j",
          exitCode: 0,
          startedAt: new Date(now - 5 * 60_000).toISOString(),
        }));
        // Old failure — fails --since.
        appendJsonl(p, makeRunRecord({
          runId: "old_fail",
          jobId: "j",
          exitCode: 1,
          startedAt: new Date(now - 2 * 3_600_000).toISOString(),
        }));
      });
      const out: string[] = [];

      const stdout = {

        write: (chunk: string | Uint8Array) => {

          out.push(typeof chunk === "string" ? chunk : chunk.toString());

          return true;

        }

      } as typeof process.stdout;

      await withEnv(env, () => cmdLog(["--failed", "--since", "1h", "--limit", "0"], { stdout, stderr: process.stderr as any }));
      const text = out.join("");
      const lines = text.trim().split("\n");
      // Only "match" passes both filters.
      assert.equal(lines.length, 2, `expected 2 lines, got ${lines.length}: ${text}`);
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdLog skips malformed lines with a warning", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await withEnv(env, () => {
        const p = join(env.PI_TICK_DATA_DIR, "runs.jsonl");
        appendJsonl(p, { runId: "r1", jobId: "ok", triggerKind: "external", startedAt: "x", finishedAt: "x", exitCode: 0, error: null });
      });
      // Now write a malformed line directly to the file.
      writeFileSync(join(env.PI_TICK_DATA_DIR, "runs.jsonl"), "{ not json\n", "utf8");
      const errOut: string[] = [];
      const stderr = {
        write: (chunk: string | Uint8Array) => {
          errOut.push(typeof chunk === "string" ? chunk : chunk.toString());
          return true;
        }
      } as typeof process.stderr;
      const out: string[] = [];
      const stdout = {
        write: (chunk: string | Uint8Array) => {
          out.push(typeof chunk === "string" ? chunk : chunk.toString());
          return true;
        }
      } as typeof process.stdout;
      await withEnv(env, () => cmdLog([], { stdout, stderr }));
      assert.match(errOut.join(""), /warning/i);
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdList formats timestamps in local display form", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await seedJobs(env, [makeJob({ id: "local-time", enabled: true })]);
      const out: string[] = [];

      const stdout = {

        write: (chunk: string | Uint8Array) => {

          out.push(typeof chunk === "string" ? chunk : chunk.toString());

          return true;

        }

      } as typeof process.stdout;

      await withEnv(env, () => cmdList([], { stdout, stderr: process.stderr as any }));
      const text = out.join("");
      assert.match(text, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
      assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    } finally {
      teardownEnv(env);
    }
  });
});

test("formatSchedule and formatNextFire produce stable strings", () => {
  assert.equal(formatSchedule({ kind: "interval", value: { minutes: 1, seconds: 0 } }), "every 1m");
  assert.equal(formatSchedule({ kind: "daily", value: { time: "09:00" } }), "daily @ 09:00");
  assert.equal(formatSchedule({ kind: "weekly", value: { days: ["monday", "friday"], time: "17:00" } }), "weekly monday,friday @ 17:00");
  // formatNextFire returns an ISO string for enabled schedules
  const nf = formatNextFire({ kind: "daily", value: { time: "09:00" } });
  assert.match(nf, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});

test("humanizeSeconds: sub-minute stays in seconds", () => {
  assert.equal(humanizeSeconds(5),   "5s");
  assert.equal(humanizeSeconds(45),  "45s");
});

test("humanizeSeconds: minute-scale switches to Xm [Ys]", () => {
  assert.equal(humanizeSeconds(60),  "1m");      // boundary
  assert.equal(humanizeSeconds(65),  "1m 5s");   // mixed
  assert.equal(humanizeSeconds(900), "15m");     // round minute
});

test("humanizeSeconds: hour-scale switches to Xh [Ym]", () => {
  assert.equal(humanizeSeconds(3600), "1h");        // boundary
  assert.equal(humanizeSeconds(5400), "1h 30m");    // mixed hour+minute
  assert.equal(humanizeSeconds(7200), "2h");        // round hour
});

test("formatSchedule: offset is humanized too", () => {
  // 5s minimum interval (launchd floor) survives; offset rolls up to minutes.
  assert.equal(
    formatSchedule({ kind: "interval", value: { minutes: 0, seconds: 5, offset: { minutes: 2, seconds: 30 } } }),
    "every 5s +2m 30s offset",
  );
});

test("formatLocal converts ISO to local YYYY-MM-DD HH:MM:SS", () => {
  // 2026-01-01T00:00:00Z formats to *something* with the right shape
  const out = formatLocal("2026-01-01T00:00:00.000Z");
  assert.match(out, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test("tailLines returns the last N non-empty lines", async () => {
  await withTempDir(async (dir) => {
    const p = join(dir, "t.txt");
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) lines.push(`line-${i}`);
    writeFileSync(p, lines.join("\n") + "\n", "utf8");
    const t = tailLines(p, 10);
    assert.equal(t.length, 10);
    assert.equal(t[t.length - 1], "line-199");
  });
});

test("printTable aligns columns by width", () => {
  const out: string[] = [];
  const stdout = {
    write: (chunk: string | Uint8Array) => {
      out.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }
  } as typeof process.stdout;
  printTable([
    ["id", "kind"],
    ["a", "daily"],
    ["longer", "interval"],
  ], { stdout });
  const lines = out.join("").split("\n").filter((l) => l.length > 0);
  assert.equal(lines.length, 3);
  // Each non-empty line has at least one occurrence of "  " (2-space gap between fields).
  for (const ln of lines) {
    assert.match(ln, /^(\S+( {2,}\S+)+ *)$/);
  }
});
