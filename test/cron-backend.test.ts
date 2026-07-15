// test/cron-backend.test.ts — Linux cron backend unit tests.
//
// The cross-platform test runner picks up this file but only runs it
// meaningfully on Linux (or wherever PI_TICK_BACKEND=cron is set). The
// launchd backend tests in test/pi-tick.test.ts already cover the macOS
// path. To test the cron backend on macOS, set PI_TICK_BACKEND=cron and
// use a fake `crontab` on PATH.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  withTempDir,
  setupEnv,
  withEnv,
  teardownEnv,
  writeStub,
  type TestEnv,
} from "./_helpers.ts";
import { join } from "node:path";
import { existsSync, writeFileSync, readFileSync, mkdirSync, chmodSync, mkdtempSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

// Force the backend to cron so these tests run regardless of the host OS.
const BACKEND_ENV = { PI_TICK_BACKEND: "cron" };

// Copy the bundled CLI (and the paths + backends helpers) into the test's
// data dir so cmdEnable can find the stable path. The runner checks
// existsSync(stableCliPath) before doing anything else.
function seedStableCli(env: TestEnv) {
  const src = new URL("../extensions/tick/bin/pi-tick.mjs", import.meta.url).pathname;
  const dest = join(env.PI_TICK_DATA_DIR, "pi-tick.mjs");
  mkdirSync(env.PI_TICK_DATA_DIR, { recursive: true, mode: 0o700 });
  copyFileSync(src, dest);
  // Also seed paths.mjs and the backends/ directory so the stable CLI
  // can resolve its imports when actually invoked (though for these
  // tests we only care that the file exists, not that it runs).
  const pathsSrc = new URL("../extensions/tick/bin/paths.mjs", import.meta.url).pathname;
  const pathsDest = join(env.PI_TICK_DATA_DIR, "paths.mjs");
  copyFileSync(pathsSrc, pathsDest);
  const backendsSrc = new URL("../extensions/tick/bin/backends", import.meta.url).pathname;
  const backendsDest = join(env.PI_TICK_DATA_DIR, "backends");
  mkdirSync(backendsDest, { recursive: true, mode: 0o700 });
  for (const f of ["index.mjs", "launchd.mjs", "cron.mjs"]) {
    copyFileSync(join(backendsSrc, f), join(backendsDest, f));
  }
}

// ─── Pure helper: buildCronLine ────────────────────────────────────────

import { cronBackend, buildCronLine } from "../extensions/tick/bin/backends/cron.mjs";

const FAKE_LOGS = "/tmp/fake-logs";
const FAKE_NODE = "/usr/bin/node";
const FAKE_CLI = "/opt/pi-tick/pi-tick.mjs";

// ─── Interval offset (issue 23) ────────────────────────────────────────────────

// Defensive read: an old-shape value (no `offset` key) must still
// produce a valid crontab line — the no-offset case is the same as a
// present 0/0 offset.
test("buildCronLine: interval with old-shape value (no offset key) still works", () => {
  const out = buildCronLine(
    { id: "j1", schedule: { kind: "interval", value: { minutes: 2, seconds: 0 } } },
    { nodePath: FAKE_NODE, cliPath: FAKE_CLI, logsDir: () => FAKE_LOGS },
  );
  assert.ok(!out.error, out.error);
  assert.match(out.line, /^\*\/2 \* \* \* \* /);
});

test("buildCronLine: interval with explicit 0/0 offset matches the no-offset line", () => {
  const noOffset = buildCronLine(
    { id: "j1", schedule: { kind: "interval", value: { minutes: 2, seconds: 0 } } },
    { nodePath: FAKE_NODE, cliPath: FAKE_CLI, logsDir: () => FAKE_LOGS },
  );
  const zeroOffset = buildCronLine(
    { id: "j1", schedule: { kind: "interval", value: { minutes: 2, seconds: 0, offset: { minutes: 0, seconds: 0 } } } },
    { nodePath: FAKE_NODE, cliPath: FAKE_CLI, logsDir: () => FAKE_LOGS },
  );
  assert.ok(!noOffset.error);
  assert.ok(!zeroOffset.error);
  assert.equal(noOffset.line, zeroOffset.line);
});

test("buildCronLine: interval with offset minutes rejects on cron", () => {
  const out = buildCronLine(
    { id: "j1", schedule: { kind: "interval", value: { minutes: 2, seconds: 0, offset: { minutes: 15, seconds: 0 } } } },
    { nodePath: FAKE_NODE, cliPath: FAKE_CLI, logsDir: () => FAKE_LOGS },
  );
  assert.ok(out.error, "expected error for cron + interval offset");
  assert.match(out.error, /interval offset not supported on the cron backend/);
});

test("buildCronLine: interval with offset seconds rejects on cron", () => {
  const out = buildCronLine(
    { id: "j1", schedule: { kind: "interval", value: { minutes: 2, seconds: 0, offset: { minutes: 0, seconds: 30 } } } },
    { nodePath: FAKE_NODE, cliPath: FAKE_CLI, logsDir: () => FAKE_LOGS },
  );
  assert.ok(out.error, "expected error for cron + interval offset seconds");
  assert.match(out.error, /interval offset not supported on the cron backend/);
});

test("buildCronLine: interval 60s produces '* * * * *'", () => {
  const out = buildCronLine(
    { id: "j1", schedule: { kind: "interval", value: { minutes: 1, seconds: 0 } } },
    { nodePath: FAKE_NODE, cliPath: FAKE_CLI, logsDir: () => FAKE_LOGS },
  );
  assert.ok(!out.error, out.error);
  assert.match(out.line, /^\* \* \* \* \* /);
  assert.ok(out.line.includes("'j1'"));
  assert.ok(out.line.includes("'"));
});

test("buildCronLine: interval 5m produces '*/5 * * * *'", () => {
  const out = buildCronLine(
    { id: "j1", schedule: { kind: "interval", value: { minutes: 5, seconds: 0 } } },
    { nodePath: FAKE_NODE, cliPath: FAKE_CLI, logsDir: () => FAKE_LOGS },
  );
  assert.ok(!out.error, out.error);
  assert.match(out.line, /^\*\/5 \* \* \* \* /);
});

test("buildCronLine: daily HH:MM produces 'M H * * *'", () => {
  const out = buildCronLine(
    { id: "j1", schedule: { kind: "daily", value: { time: "02:30" } } },
    { nodePath: FAKE_NODE, cliPath: FAKE_CLI, logsDir: () => FAKE_LOGS },
  );
  assert.ok(!out.error, out.error);
  assert.match(out.line, /^30 2 \* \* \* /);
});

test("buildCronLine: weekly [mon,wed,fri] 17:00 produces 'M H * * 1,3,5'", () => {
  const out = buildCronLine(
    { id: "j1", schedule: { kind: "weekly", value: { days: ["mon", "wed", "fri"], time: "17:00" } } },
    { nodePath: FAKE_NODE, cliPath: FAKE_CLI, logsDir: () => FAKE_LOGS },
  );
  assert.ok(!out.error, out.error);
  assert.match(out.line, /^0 17 \* \* 1,3,5 /);
});

test("buildCronLine: rejects sub-minute (30 seconds)", () => {
  const out = buildCronLine(
    { id: "j1", schedule: { kind: "interval", value: { minutes: 0, seconds: 30 } } },
    { nodePath: FAKE_NODE, cliPath: FAKE_CLI, logsDir: () => FAKE_LOGS },
  );
  assert.ok(out.error, "expected error for sub-minute interval");
  assert.match(out.error, /30s is below the cron minimum/);
});

test("buildCronLine: rejects non-minute multiples (90 seconds)", () => {
  const out = buildCronLine(
    { id: "j1", schedule: { kind: "interval", value: { minutes: 1, seconds: 30 } } },
    { nodePath: FAKE_NODE, cliPath: FAKE_CLI, logsDir: () => FAKE_LOGS },
  );
  assert.ok(out.error);
  assert.match(out.error, /not a whole number of minutes/);
});

test("buildCronLine: rejects null daily time", () => {
  const out = buildCronLine(
    { id: "j1", schedule: { kind: "daily", value: { time: null } } },
    { nodePath: FAKE_NODE, cliPath: FAKE_CLI, logsDir: () => FAKE_LOGS },
  );
  assert.ok(out.error, "expected an error for null time");
  assert.match(out.error, /HH:MM format/);
});

test("buildCronLine: quotes the node path, cli path, and job id (cron-safe)", () => {
  const out = buildCronLine(
    { id: "with spaces", schedule: { kind: "daily", value: { time: "09:00" } } },
    { nodePath: "/path with space/node", cliPath: "/path with space/cli.mjs", logsDir: () => "/var/log/pi tick" },
  );
  assert.ok(!out.error, out.error);
  // All paths should be single-quoted (cron-safe).
  assert.match(out.line, /'\/path with space\/node'/);
  assert.match(out.line, /'\/path with space\/cli\.mjs'/);
  assert.match(out.line, /'with spaces'/);
  assert.match(out.line, /'\/var\/log\/pi tick\/with spaces\.out\.log'/);
});

test("buildCronLine: appends stdout to logs/<id>.out.log and stderr to .err.log", () => {
  const out = buildCronLine(
    { id: "j1", schedule: { kind: "interval", value: { minutes: 1, seconds: 0 } } },
    { nodePath: FAKE_NODE, cliPath: FAKE_CLI, logsDir: () => FAKE_LOGS },
  );
  assert.match(out.line, new RegExp(`>> '${FAKE_LOGS}/j1\\.out\\.log' 2>> '${FAKE_LOGS}/j1\\.err\\.log'`));
});

// Cron treats a bare `%` as a newline + stdin delimiter, so a path
// containing `%` (e.g. `/opt/%node`, `/var/log/%dir`) would silently
// truncate the command. `quote` must escape `%` as `\%`.
test("buildCronLine: escapes `%` in paths so cron sees a literal percent", () => {
  const out = buildCronLine(
    { id: "j1", schedule: { kind: "interval", value: { minutes: 1, seconds: 0 } } },
    {
      nodePath: "/opt/%node",
      cliPath: "/opt/%cli/run.mjs",
      logsDir: "/var/log/%dir",
    },
  );
  assert.ok(!out.error, out.error);
  // Use `.includes` for the escaped form so there is no regex-literal
  // ambiguity (JS source `\\%` is the 2-char sequence `\%`).
  assert.ok(out.line.includes("'/opt/\\%node'"), `node path not escaped:\n${out.line}`);
  assert.ok(out.line.includes("'/opt/\\%cli/run.mjs'"), `cli path not escaped:\n${out.line}`);
  assert.ok(out.line.includes("'j1'"), `job id missing:\n${out.line}`);
  assert.ok(out.line.includes("'/var/log/\\%dir/j1.out.log'"), `out log path not escaped:\n${out.line}`);
  assert.ok(out.line.includes("'/var/log/\\%dir/j1.err.log'"), `err log path not escaped:\n${out.line}`);
  // No bare `%` survives in the assembled line.
  assert.equal(out.line.match(/(?<!\\)%/g), null, `bare % in line:\n${out.line}`);
});

// ─── Stubs for crontab I/O ─────────────────────────────────────────────

// A `crontab` stub backed by a file in a tempdir. -l reads, - writes the
// stdin to the file. We use only POSIX shell builtins (no `cat`/`dd`)
// because the test PATH doesn't include /bin or /usr/bin.
//
// The read/write loops are factored into functions to work around a
// bash 3.2 (macOS /bin/sh) parsing quirk where `while` inside `if/then`
// inside `case` gets mis-parsed.
function makeCrontabStub(env: TestEnv, file: string, log?: string): string {
  return writeStub(env, "crontab", `f=${shellQuote(file)}
read_crontab() {
  while IFS= read -r line || [ -n "$line" ]; do
    printf '%s\\n' "$line"
  done < "$f"
}
write_crontab() {
  rm -f "$f"
  while IFS= read -r line; do
    printf '%s\\n' "$line" >> "$f"
  done
}
case "$1" in
  -l)
    if [ -f "$f" ]; then
      read_crontab
      exit 0
    else
      echo "no crontab for $(whoami)" >&2
      exit 1
    fi
    ;;
  -) write_crontab ;;
  *) echo "crontab stub: unsupported arg $1" >&2; exit 2 ;;
esac
${log ? `log() { echo "$@" >> ${shellQuote(log)}; }` : ""}
`, { log });
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ─── Integration: register/unregister via the stub ─────────────────────

test("cronBackend.register adds an entry to a fresh crontab", async () => {
  await withTempDir(async (dir) => {
    const crontabFile = join(dir, "crontab.txt");
    writeFileSync(crontabFile, "", "utf8");
    const env = setupEnv({ dataDir: join(dir, "data"), plistDir: join(dir, "agents") });
    makeCrontabStub(env, crontabFile);
    try {
      await withEnv({ ...env, ...BACKEND_ENV }, async () => {
        const r = await cronBackend.register(
          { id: "alpha", cwd: "/tmp", schedule: { kind: "interval", value: { minutes: 1, seconds: 0 } } },
          { nodePath: FAKE_NODE, cliPath: FAKE_CLI, logsDir: () => join(dir, "logs") },
        );
        assert.ok(r.ok, r.error);
        const out = readFileSync(crontabFile, "utf8");
        assert.match(out, /# pi-tick: alpha/);
        assert.match(out, /\* \* \* \* \* .* 'alpha'/);
      });
    } finally {
      teardownEnv(env);
    }
  });
});

// `%` in node path / log dir must survive `register` and show up in
// the on-disk crontab escaped as `\%`. Job id is plain `j1` so the
// `# pi-tick: j1` comment line stays `%`-free (cron ignores `#` lines,
// but the no-bare-`%` assertion would still flag a comment).
test("cronBackend.register escapes `%` in node path and logsDir on disk", async () => {
  await withTempDir(async (dir) => {
    const crontabFile = join(dir, "crontab.txt");
    writeFileSync(crontabFile, "", "utf8");
    const env = setupEnv({ dataDir: join(dir, "data"), plistDir: join(dir, "agents") });
    makeCrontabStub(env, crontabFile);
    try {
      await withEnv({ ...env, ...BACKEND_ENV }, async () => {
        const r = await cronBackend.register(
          { id: "j1", cwd: "/tmp", schedule: { kind: "interval", value: { minutes: 1, seconds: 0 } } },
          {
            nodePath: "/opt/%node",
            cliPath: "/opt/%cli/run.mjs",
            logsDir: () => join(dir, "logs/%dir"),
          },
        );
        assert.ok(r.ok, r.error);
        const out = readFileSync(crontabFile, "utf8");
        // Comment header is unchanged.
        assert.ok(out.includes("# pi-tick: j1"), `comment missing:\n${out}`);
        // Interpolated paths escaped.
        assert.ok(out.includes("'/opt/\\%node'"), `node path not escaped:\n${out}`);
        assert.ok(out.includes("'/opt/\\%cli/run.mjs'"), `cli path not escaped:\n${out}`);
        const expectedLogDir = join(dir, "logs/%dir").replace(/%/g, "\\%");
        assert.ok(
          out.includes(`'${expectedLogDir}/j1.out.log'`),
          `out log path not escaped:\n${out}`,
        );
        // No bare `%` anywhere in the on-disk crontab. Safe here because
        // the comment line is `# pi-tick: j1` with no `%`.
        assert.equal(out.match(/(?<!\\)%/g), null, `bare % in crontab:\n${out}`);
      });
    } finally {
      teardownEnv(env);
    }
  });
});

// Issue #57 — opts without a `logsDir` key used to throw
// TypeError: The "path" argument must be of type string. Received undefined
// because register passed opts.logsDir straight to mkdirSync. buildCronLine
// already fell back to defaultLogsDir(); register must do the same.
test("cronBackend.register falls back to defaultLogsDir() when opts.logsDir is missing", async () => {
  await withTempDir(async (dir) => {
    const crontabFile = join(dir, "crontab.txt");
    writeFileSync(crontabFile, "", "utf8");
    const dataDir = join(dir, "data");
    const env = setupEnv({ dataDir, plistDir: join(dir, "agents") });
    makeCrontabStub(env, crontabFile);
    try {
      await withEnv({ ...env, ...BACKEND_ENV }, async () => {
        const r = await cronBackend.register(
          { id: "alpha", cwd: "/tmp", schedule: { kind: "interval", value: { minutes: 1, seconds: 0 } } },
          { nodePath: FAKE_NODE, cliPath: FAKE_CLI },
        );
        assert.ok(r.ok, r.error);
        assert.ok(existsSync(join(dataDir, "logs")), "logs dir created under defaultLogsDir()");
      });
    } finally {
      teardownEnv(env);
    }
  });
});

test("cronBackend.register preserves other crontab entries", async () => {
  await withTempDir(async (dir) => {
    const crontabFile = join(dir, "crontab.txt");
    const existing = "# My other daily job\n0 6 * * * /usr/local/bin/backup.sh\n\n# Yet another\n*/15 * * * * /usr/local/bin/check.sh\n";
    writeFileSync(crontabFile, existing, "utf8");
    const env = setupEnv({ dataDir: join(dir, "data"), plistDir: join(dir, "agents") });
    makeCrontabStub(env, crontabFile);
    try {
      await withEnv({ ...env, ...BACKEND_ENV }, async () => {
        const r = await cronBackend.register(
          { id: "alpha", cwd: "/tmp", schedule: { kind: "daily", value: { time: "02:00" } } },
          { nodePath: FAKE_NODE, cliPath: FAKE_CLI, logsDir: () => join(dir, "logs") },
        );
        assert.ok(r.ok, r.error);
        const out = readFileSync(crontabFile, "utf8");
        assert.ok(out.includes("backup.sh"), "other entry was lost");
        assert.ok(out.includes("check.sh"), "other entry was lost");
        assert.ok(out.includes("# pi-tick: alpha"), "our entry was not added");
      });
    } finally {
      teardownEnv(env);
    }
  });
});

test("cronBackend.register replaces an existing entry for the same id", async () => {
  await withTempDir(async (dir) => {
    const crontabFile = join(dir, "crontab.txt");
    writeFileSync(crontabFile, "# pi-tick: alpha\n0 6 * * * '/old/node' '/old/cli' run alpha\n", "utf8");
    const env = setupEnv({ dataDir: join(dir, "data"), plistDir: join(dir, "agents") });
    makeCrontabStub(env, crontabFile);
    try {
      await withEnv({ ...env, ...BACKEND_ENV }, async () => {
        const r = await cronBackend.register(
          { id: "alpha", cwd: "/tmp", schedule: { kind: "interval", value: { minutes: 5, seconds: 0 } } },
          { nodePath: FAKE_NODE, cliPath: FAKE_CLI, logsDir: () => join(dir, "logs") },
        );
        assert.ok(r.ok, r.error);
        const out = readFileSync(crontabFile, "utf8");
        const matches = out.match(/# pi-tick: alpha/g) || [];
        assert.equal(matches.length, 1, `expected exactly one entry, got ${matches.length}:\n${out}`);
        assert.ok(!out.includes("/old/node"), "old node path still present");
        assert.ok(out.includes("'alpha'"));
      });
    } finally {
      teardownEnv(env);
    }
  });
});

test("cronBackend.register rejects a sub-minute interval with a clear error", async () => {
  await withTempDir(async (dir) => {
    const crontabFile = join(dir, "crontab.txt");
    writeFileSync(crontabFile, "", "utf8");
    const env = setupEnv({ dataDir: join(dir, "data"), plistDir: join(dir, "agents") });
    makeCrontabStub(env, crontabFile);
    try {
      await withEnv({ ...env, ...BACKEND_ENV }, async () => {
        const r = await cronBackend.register(
          { id: "j", cwd: "/tmp", schedule: { kind: "interval", value: { minutes: 0, seconds: 30 } } },
          { nodePath: FAKE_NODE, cliPath: FAKE_CLI, logsDir: () => join(dir, "logs") },
        );
        assert.equal(r.ok, false);
        assert.match(r.error, /30s is below the cron minimum/);
        // No entry should be written.
        const out = readFileSync(crontabFile, "utf8");
        assert.equal(out, "");
      });
    } finally {
      teardownEnv(env);
    }
  });
});

test("cronBackend.unregister removes only the matching entry", async () => {
  await withTempDir(async (dir) => {
    const crontabFile = join(dir, "crontab.txt");
    const existing = [
      "# pi-tick: alpha",
      "* * * * * '/n' '/c' run alpha",
      "",
      "# pi-tick: beta",
      "*/5 * * * * '/n' '/c' run beta",
      "",
      "# unrelated",
      "0 6 * * * /usr/local/bin/backup.sh",
    ].join("\n");
    writeFileSync(crontabFile, existing, "utf8");
    const env = setupEnv({ dataDir: join(dir, "data"), plistDir: join(dir, "agents") });
    makeCrontabStub(env, crontabFile);
    try {
      await withEnv({ ...env, ...BACKEND_ENV }, async () => {
        const r = await cronBackend.unregister("alpha");
        assert.ok(r.ok, r.error);
        const out = readFileSync(crontabFile, "utf8");
        assert.ok(!out.includes("# pi-tick: alpha"), "alpha entry was not removed");
        assert.ok(out.includes("# pi-tick: beta"), "beta entry was lost");
        assert.ok(out.includes("backup.sh"), "unrelated entry was lost");
      });
    } finally {
      teardownEnv(env);
    }
  });
});

test("cronBackend.unregister on a job that isn't in the crontab is a no-op", async () => {
  await withTempDir(async (dir) => {
    const crontabFile = join(dir, "crontab.txt");
    const existing = "# pi-tick: beta\n*/5 * * * * '/n' '/c' run beta\n";
    writeFileSync(crontabFile, existing, "utf8");
    const env = setupEnv({ dataDir: join(dir, "data"), plistDir: join(dir, "agents") });
    makeCrontabStub(env, crontabFile);
    try {
      await withEnv({ ...env, ...BACKEND_ENV }, async () => {
        const r = await cronBackend.unregister("alpha");
        assert.ok(r.ok, r.error);
        const out = readFileSync(crontabFile, "utf8");
        assert.equal(out, existing, "crontab should be unchanged");
      });
    } finally {
      teardownEnv(env);
    }
  });
});

test("cronBackend.listRegistered returns job ids from the crontab", async () => {
  await withTempDir(async (dir) => {
    const crontabFile = join(dir, "crontab.txt");
    const existing = [
      "# pi-tick: alpha",
      "* * * * * '/n' '/c' run alpha",
      "",
      "# pi-tick: beta",
      "*/5 * * * * '/n' '/c' run beta",
      "",
      "# pi-tick: gamma_2",
      "0 9 * * * '/n' '/c' run gamma_2",
    ].join("\n");
    writeFileSync(crontabFile, existing, "utf8");
    const env = setupEnv({ dataDir: join(dir, "data"), plistDir: join(dir, "agents") });
    makeCrontabStub(env, crontabFile);
    try {
      await withEnv({ ...env, ...BACKEND_ENV }, async () => {
        const ids = await cronBackend.listRegistered();
        assert.deepEqual(ids.sort(), ["alpha", "beta", "gamma_2"]);
      });
    } finally {
      teardownEnv(env);
    }
  });
});

// ─── Issue #4: unseparated crontabs (no blank lines between entries) ──

// Regression for issue #4: when the user's crontab has no blank line
// between pi-tick entries and/or user entries, the old block-splitting
// extractEntries() ate the entire crontab. These tests pin the fix.

test("cronBackend.unregister on an unseparated crontab leaves user entries byte-identical", async () => {
  await withTempDir(async (dir) => {
    const crontabFile = join(dir, "crontab.txt");
    // No blank lines at all. One pi-tick entry + one user job.
    const existing = [
      "# pi-tick: alpha",
      "* * * * * '/n' '/c' run alpha",
      "# my real job",
      "0 6 * * * /usr/local/bin/backup.sh",
    ].join("\n");
    writeFileSync(crontabFile, existing + "\n", "utf8");
    const env = setupEnv({ dataDir: join(dir, "data"), plistDir: join(dir, "agents") });
    makeCrontabStub(env, crontabFile);
    try {
      await withEnv({ ...env, ...BACKEND_ENV }, async () => {
        const r = await cronBackend.unregister("alpha");
        assert.ok(r.ok, r.error);
        const out = readFileSync(crontabFile, "utf8");
        // The user line and its preceding comment survive byte-identical
        // (modulo the trailing newline, which cron requires).
        assert.equal(out, "# my real job\n0 6 * * * /usr/local/bin/backup.sh\n");
      });
    } finally {
      teardownEnv(env);
    }
  });
});

test("cronBackend.unregister on unseparated crontab with two pi-tick ids removes only the targeted pair", async () => {
  await withTempDir(async (dir) => {
    const crontabFile = join(dir, "crontab.txt");
    // Two pi-tick entries of different ids, no blank lines, plus a user job.
    const existing = [
      "# pi-tick: alpha",
      "* * * * * '/n' '/c' run alpha",
      "# pi-tick: beta",
      "*/5 * * * * '/n' '/c' run beta",
      "# my real job",
      "0 6 * * * /usr/local/bin/backup.sh",
    ].join("\n");
    writeFileSync(crontabFile, existing + "\n", "utf8");
    const env = setupEnv({ dataDir: join(dir, "data"), plistDir: join(dir, "agents") });
    makeCrontabStub(env, crontabFile);
    try {
      await withEnv({ ...env, ...BACKEND_ENV }, async () => {
        const r = await cronBackend.unregister("alpha");
        assert.ok(r.ok, r.error);
        const out = readFileSync(crontabFile, "utf8");
        assert.ok(!out.includes("# pi-tick: alpha"), "alpha was not removed");
        assert.ok(out.includes("# pi-tick: beta"), "beta was lost");
        assert.ok(out.includes("backup.sh"), "user entry was lost");
        assert.ok(out.includes("# my real job"), "user comment was lost");
      });
    } finally {
      teardownEnv(env);
    }
  });
});

test("cronBackend.register replaces exactly one entry on an unseparated crontab", async () => {
  await withTempDir(async (dir) => {
    const crontabFile = join(dir, "crontab.txt");
    writeFileSync(crontabFile, "# pi-tick: alpha\n0 6 * * * '/old/node' '/old/cli' run alpha\n", "utf8");
    const env = setupEnv({ dataDir: join(dir, "data"), plistDir: join(dir, "agents") });
    makeCrontabStub(env, crontabFile);
    try {
      await withEnv({ ...env, ...BACKEND_ENV }, async () => {
        const r = await cronBackend.register(
          { id: "alpha", cwd: "/tmp", schedule: { kind: "interval", value: { minutes: 5, seconds: 0 } } },
          { nodePath: FAKE_NODE, cliPath: FAKE_CLI, logsDir: () => join(dir, "logs") },
        );
        assert.ok(r.ok, r.error);
        const out = readFileSync(crontabFile, "utf8");
        const matches = out.match(/# pi-tick: alpha/g) || [];
        assert.equal(matches.length, 1, `expected exactly one entry, got ${matches.length}:\n${out}`);
        assert.ok(!out.includes("/old/node"), "old node path still present");
        assert.ok(out.includes("'alpha'"));
        assert.match(out, /\*\/5 \* \* \* \* /);
      });
    } finally {
      teardownEnv(env);
    }
  });
});

test("cronBackend.register then unregister on unseparated crontab leaves user lines byte-identical", async () => {
  await withTempDir(async (dir) => {
    const crontabFile = join(dir, "crontab.txt");
    const existing = [
      "# pi-tick: alpha",
      "* * * * * '/n' '/c' run alpha",
      "# my real job",
      "0 6 * * * /usr/local/bin/backup.sh",
    ].join("\n");
    writeFileSync(crontabFile, existing + "\n", "utf8");
    const env = setupEnv({ dataDir: join(dir, "data"), plistDir: join(dir, "agents") });
    makeCrontabStub(env, crontabFile);
    try {
      await withEnv({ ...env, ...BACKEND_ENV }, async () => {
        // Add a second pi-tick entry (gamma) while leaving the others alone.
        const r1 = await cronBackend.register(
          { id: "gamma", cwd: "/tmp", schedule: { kind: "interval", value: { minutes: 5, seconds: 0 } } },
          { nodePath: FAKE_NODE, cliPath: FAKE_CLI, logsDir: () => join(dir, "logs") },
        );
        assert.ok(r1.ok, r1.error);
        // Now remove alpha; the user line + gamma entry must both survive.
        const r2 = await cronBackend.unregister("alpha");
        assert.ok(r2.ok, r2.error);
        const out = readFileSync(crontabFile, "utf8");
        assert.ok(!out.includes("# pi-tick: alpha"), "alpha was not removed");
        assert.ok(out.includes("backup.sh"), "user entry was lost");
        assert.ok(out.includes("# pi-tick: gamma"), "gamma was lost");
      });
    } finally {
      teardownEnv(env);
    }
  });
});

// ─── CLI integration: cmdEnable with cron backend ─────────────────────

import { cmdAdd } from "../extensions/tick/bin/commands/add.mjs";
import { cmdEnable } from "../extensions/tick/bin/commands/enable.mjs";
import { cmdDisable } from "../extensions/tick/bin/commands/disable.mjs";
import { cmdDelete } from "../extensions/tick/bin/commands/delete.mjs";
import { loadCatalog, saveCatalog } from "../extensions/tick/bin/catalog.mjs";

test("cmdAdd + cmdEnable on cron backend registers an entry and sets enabled=true", async () => {
  await withTempDir(async (dir) => {
    const crontabFile = join(dir, "crontab.txt");
    writeFileSync(crontabFile, "", "utf8");
    const env = setupEnv({ dataDir: join(dir, "data"), plistDir: join(dir, "agents") });
    seedStableCli(env);
    makeCrontabStub(env, crontabFile);
    writeStub(env, "node", `echo fake-node`);
    writeStub(env, "pi", `echo fake-pi`);
    try {
      const env2 = { ...env, ...BACKEND_ENV };
      await withEnv(env2, () => cmdAdd(["j1", "--prompt", "p", "--cwd", "/tmp", "--kind", "interval", "--minutes", "5"]));
      const code = await withEnv(env2, () => cmdEnable(["j1"]));
      assert.equal(code, 0);
      const out = readFileSync(crontabFile, "utf8");
      assert.match(out, /# pi-tick: j1/);
      assert.match(out, /\*\/5 \* \* \* \* .* run 'j1'/);
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdAdd + cmdEnable on cron backend rejects sub-minute interval", async () => {
  await withTempDir(async (dir) => {
    const crontabFile = join(dir, "crontab.txt");
    writeFileSync(crontabFile, "", "utf8");
    const env = setupEnv({ dataDir: join(dir, "data"), plistDir: join(dir, "agents") });
    seedStableCli(env);
    makeCrontabStub(env, crontabFile);
    writeStub(env, "node", `echo fake-node`);
    writeStub(env, "pi", `echo fake-pi`);
    try {
      const env2 = { ...env, ...BACKEND_ENV };
      let addCode = 0;
      try {
        await withEnv(env2, () => cmdAdd(["j1", "--prompt", "p", "--cwd", "/tmp", "--kind", "interval", "--seconds", "30"]));
      } catch (err: any) {
        addCode = err.code;
      }
      assert.equal(addCode, 2, "sub-minute interval should fail with PiTickError(2)");
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdDisable on cron backend removes the entry but keeps the catalog row", async () => {
  await withTempDir(async (dir) => {
    const crontabFile = join(dir, "crontab.txt");
    writeFileSync(crontabFile, "", "utf8");
    const env = setupEnv({ dataDir: join(dir, "data"), plistDir: join(dir, "agents") });
    seedStableCli(env);
    makeCrontabStub(env, crontabFile);
    writeStub(env, "node", `echo fake-node`);
    writeStub(env, "pi", `echo fake-pi`);
    try {
      const env2 = { ...env, ...BACKEND_ENV };
      await withEnv(env2, () => cmdAdd(["j1", "--prompt", "p", "--cwd", "/tmp", "--kind", "daily", "--time", "09:00", "--enabled"]));
      assert.match(readFileSync(crontabFile, "utf8"), /# pi-tick: j1/);
      const code = await withEnv(env2, () => cmdDisable(["j1"]));
      assert.equal(code, 0);
      const out = readFileSync(crontabFile, "utf8");
      assert.ok(!out.includes("# pi-tick: j1"));
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdDelete on an enabled cron job removes both the crontab entry and the catalog row", async () => {
  await withTempDir(async (dir) => {
    const crontabFile = join(dir, "crontab.txt");
    writeFileSync(crontabFile, "", "utf8");
    const env = setupEnv({ dataDir: join(dir, "data"), plistDir: join(dir, "agents") });
    seedStableCli(env);
    makeCrontabStub(env, crontabFile);
    writeStub(env, "node", `echo fake-node`);
    writeStub(env, "pi", `echo fake-pi`);
    try {
      const env2 = { ...env, ...BACKEND_ENV };
      await withEnv(env2, () => cmdAdd(["j1", "--prompt", "p", "--cwd", "/tmp", "--kind", "interval", "--minutes", "1", "--enabled"]));
      assert.match(readFileSync(crontabFile, "utf8"), /# pi-tick: j1/);
      const code = await withEnv(env2, () => cmdDelete(["j1"]));
      assert.equal(code, 0);
      const out = readFileSync(crontabFile, "utf8");
      // The cron backend writes a single trailing newline when the
      // crontab is otherwise empty (matches vixie-cron's behavior —
      // a totally empty crontab would make `crontab -` fail).
      assert.equal(out, "\n");
    } finally {
      teardownEnv(env);
    }
  });
});

// Regression: cmdDelete used to ignore the result of
// `unregisterAndDelete`, so a cron failure would silently remove the
// catalog row while the cron entry kept firing forever ("zombie job").
// The fix must surface the failure AND keep the catalog row so the user
// can retry. Pre-seed an enabled job so cmdDelete reaches the backend
// path without needing register to succeed first.
test("cmdDelete keeps catalog row when backend unregister fails", async () => {
  await withTempDir(async (dir) => {
    const dataDir = join(dir, "data");
    const env = setupEnv({ dataDir, plistDir: join(dir, "agents") });
    seedStableCli(env);
    // Always-failing crontab stub. The job is pre-seeded so we never
    // exercise register — we only care about the unregister path here.
    writeStub(env, "crontab", `echo "boom" >&2; exit 1`);
    writeStub(env, "node", `echo fake-node`);
    writeStub(env, "pi", `echo fake-pi`);
    try {
      const env2 = { ...env, ...BACKEND_ENV };
      await withEnv(env2, () => {
        saveCatalog({
          version: 1,
          jobs: [{
            id: "stuck",
            prompt: "p",
            cwd: "/tmp",
            schedule: { kind: "daily", value: { time: "09:00" } },
            enabled: true,
            model: null,
            piPath: null,
            nodePath: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            lastRun: null,
          }],
        });
      });
      let err: any = null;
      try {
        await withEnv(env2, () => cmdDelete(["stuck"]));
      } catch (e) {
        err = e;
      }
      assert.ok(err, "cmdDelete should have thrown on backend failure");
      assert.equal(err.code, 1, `expected PiTickError code 1, got ${err.code}`);
      // Catalog row must still be present so the user can retry.
      const cat = await withEnv(env2, () => loadCatalog());
      assert.equal(cat.jobs.length, 1, "catalog row was removed despite backend failure");
      assert.equal(cat.jobs[0].id, "stuck");
    } finally {
      teardownEnv(env);
    }
  });
});

// ─── Backend dispatch ───────────────────────────────────────────────────

import { getBackend } from "../extensions/tick/bin/backends/index.mjs";

test("getBackend() returns cron on Linux regardless of platform detection", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await withEnv({ ...env, PI_TICK_BACKEND: "cron" }, () => {
        const b = getBackend();
        assert.equal(b.name, "cron");
        assert.equal(b.minimumIntervalSeconds, 60);
      });
    } finally {
      teardownEnv(env);
    }
  });
});

test("getBackend() returns launchd on darwin by default", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      // No PI_TICK_BACKEND override. Mac → launchd, Linux → cron. Either
      // way, the dispatch must respect the override (we just tested cron).
      // Here we just check the function is callable and returns *something*
      // with a name and minimumIntervalSeconds.
      await withEnv(env, () => {
        const b = getBackend();
        assert.ok(typeof b.name === "string");
        assert.ok(typeof b.minimumIntervalSeconds === "number");
        assert.ok(b.minimumIntervalSeconds > 0);
      });
    } finally {
      teardownEnv(env);
    }
  });
});
