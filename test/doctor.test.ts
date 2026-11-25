// test/doctor.test.ts — `pi-tick doctor` (issue #61): silent-stop detection.

import { test } from "node:test";
import assert from "node:assert/strict";
import { join, delimiter } from "node:path";
import { copyFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, rmSync } from "node:fs";
import { diagnoseJob, cmdDoctor } from "../extensions/tick/bin/commands/doctor.mjs";
import { cmdList } from "../extensions/tick/bin/commands/list.mjs";
import { cmdAdd } from "../extensions/tick/bin/commands/add.mjs";
import { cmdEnable } from "../extensions/tick/bin/commands/enable.mjs";
import { writeActiveRun, clearActiveRun } from "../extensions/tick/bin/run-registry.mjs";
import { previousFireAt } from "../extensions/tick/bin/schedule.mjs";
import { cronBackend, buildCronLine, parseCronPaths } from "../extensions/tick/bin/backends/cron.mjs";
import { renderPlist, parsePlistPaths, launchdBackend } from "../extensions/tick/bin/backends/launchd.mjs";
import { withTempDir, setupEnv, withEnv, teardownEnv, writeStub } from "./_helpers.ts";

function capture() {
  const out: string[] = [];
  return { out, stream: { write: (c: string | Uint8Array) => { out.push(String(c)); return true; } } as any };
}

// A job + fake backend whose status() reports a healthy entry.
function healthy(overrides: Record<string, unknown> = {}, now = new Date()) {
  const job = {
    id: "j",
    prompt: "p",
    cwd: "/tmp",
    schedule: { kind: "daily", value: { time: "09:00" } },
    enabled: true,
    nodePath: process.execPath,
    piPath: null,
    agent: "command",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    registration: { backend: "fake", fingerprint: "abc", registeredAt: new Date(now.getTime() - 3 * 86400_000).toISOString() },
    lastRun: { startedAt: new Date(now.getTime() - 60_000).toISOString(), finishedAt: now.toISOString(), exitCode: 0 },
    ...overrides,
  };
  const status = { registered: true, loaded: true, fingerprint: "abc", paths: { nodePath: process.execPath, cliPath: process.execPath, cwd: "/tmp" } };
  return { job, status };
}

function fakeBackend(status: unknown) {
  return { name: "fake", status: () => status };
}

function codes(r: { problems: { code: string }[] }) {
  return r.problems.map((p) => p.code).sort();
}

// ─── previousFireAt ─────────────────────────────────────────────────────

test("previousFireAt: daily is today's time once passed, else yesterday's", () => {
  const now = new Date(2026, 5, 10, 12, 0);
  assert.equal(previousFireAt({ kind: "daily", value: { time: "09:30" } }, now).at, new Date(2026, 5, 10, 9, 30).toISOString());
  assert.equal(previousFireAt({ kind: "daily", value: { time: "13:00" } }, now).at, new Date(2026, 5, 9, 13, 0).toISOString());
});

test("previousFireAt: weekly picks the latest listed weekday at or before now", () => {
  const now = new Date(2026, 5, 10, 12, 0); // Wednesday
  const r = previousFireAt({ kind: "weekly", value: { days: ["monday", "friday"], time: "09:00" } }, now);
  assert.equal(r.at, new Date(2026, 5, 8, 9, 0).toISOString());
});

test("previousFireAt: once is null until its time passes", () => {
  const at = new Date(2026, 5, 10, 12, 0).toISOString();
  assert.equal(previousFireAt({ kind: "once", value: { at } }, new Date(2026, 5, 10, 11, 0)).at, null);
  assert.equal(previousFireAt({ kind: "once", value: { at } }, new Date(2026, 5, 10, 13, 0)).at, at);
});

test("previousFireAt: plain launchd StartInterval is uncalibrated", () => {
  const r = previousFireAt({ kind: "interval", value: { minutes: 5, seconds: 0 } }, new Date());
  assert.equal(r.calibrated, false); // PI_TICK_BACKEND=launchd in npm test
});

test("previousFireAt: offset interval uses its calendar form", () => {
  const now = new Date(2026, 5, 10, 12, 7, 30);
  const r = previousFireAt({ kind: "interval", value: { minutes: 15, seconds: 0, offset: { minutes: 5, seconds: 0 } } }, now);
  assert.equal(r.at, new Date(2026, 5, 10, 12, 5).toISOString());
});

// ─── diagnoseJob ────────────────────────────────────────────────────────

test("diagnoseJob: healthy job is ok", () => {
  const now = new Date(2026, 5, 10, 9, 5);
  const { job, status } = healthy({}, now);
  const r = diagnoseJob(job, { backend: fakeBackend(status), now, running: false });
  assert.equal(r.status, "ok", JSON.stringify(r.problems));
});

test("diagnoseJob: disabled jobs are not checked", () => {
  const { job } = healthy({ enabled: false });
  const r = diagnoseJob(job, { backend: fakeBackend({ registered: false }), running: false });
  assert.equal(r.status, "ok");
  assert.deepEqual(r.problems, []);
});

test("diagnoseJob: missing scheduler entry is stale and fixable", () => {
  const { job } = healthy();
  const r = diagnoseJob(job, { backend: fakeBackend({ registered: false, loaded: null, fingerprint: null, paths: null }), running: false });
  assert.equal(r.status, "stale");
  assert.ok(r.problems.find((p) => p.code === "not-registered")?.fixable);
});

test("diagnoseJob: not loaded and drifted entries are stale", () => {
  const { job, status } = healthy();
  const r = diagnoseJob(job, { backend: fakeBackend({ ...status, loaded: false, fingerprint: "other" }), running: false });
  assert.equal(r.status, "stale");
  assert.deepEqual(codes(r), ["drift", "not-loaded"]);
});

test("diagnoseJob: no stored fingerprint (pre-doctor enable) skips the drift check", () => {
  const { job, status } = healthy({ registration: undefined });
  const r = diagnoseJob(job, { backend: fakeBackend({ ...status, fingerprint: "other" }), running: false });
  assert.ok(!codes(r).includes("drift"));
});

test("diagnoseJob: a node path that vanished (nvm/mise upgrade) is stale", () => {
  const { job, status } = healthy();
  const gone = "/nonexistent/.nvm/versions/node/v20.0.0/bin/node";
  const r = diagnoseJob(job, { backend: fakeBackend({ ...status, paths: { ...status.paths, nodePath: gone } }), running: false });
  assert.equal(r.status, "stale");
  const p = r.problems.find((p) => p.code === "missing-node");
  assert.ok(p?.fixable);
  assert.match(p!.message, /v20\.0\.0/);
});

test("diagnoseJob: missing pi, cwd and --on-complete are reported", () => {
  const { job, status } = healthy({ agent: undefined, piPath: "/nonexistent/pi", onComplete: "/nonexistent/hook" });
  const r = diagnoseJob(job, { backend: fakeBackend({ ...status, paths: { ...status.paths, cwd: "/nonexistent/cwd" } }), running: false });
  assert.deepEqual(codes(r), ["missing-cwd", "missing-on-complete", "missing-pi"]);
});

test("diagnoseJob: a daily job that missed today's fire is overdue", () => {
  const now = new Date(2026, 5, 10, 12, 0);
  const lastRun = { startedAt: new Date(2026, 5, 9, 9, 0, 1).toISOString(), finishedAt: new Date(2026, 5, 9, 9, 1).toISOString(), exitCode: 0 };
  const { job, status } = healthy({ lastRun }, now);
  const r = diagnoseJob(job, { backend: fakeBackend(status), now, running: false });
  assert.equal(r.status, "overdue");
});

test("diagnoseJob: within the grace window a fire is not yet overdue", () => {
  const now = new Date(2026, 5, 10, 9, 5);
  const lastRun = { startedAt: new Date(2026, 5, 9, 9, 0, 1).toISOString(), finishedAt: new Date(2026, 5, 9, 9, 1).toISOString(), exitCode: 0 };
  const { job, status } = healthy({ lastRun }, now);
  assert.equal(diagnoseJob(job, { backend: fakeBackend(status), now, running: false }).status, "ok");
});

test("diagnoseJob: a job enabled after the last expected fire is not overdue", () => {
  const now = new Date(2026, 5, 10, 12, 0);
  const { job, status } = healthy({ lastRun: null, registration: { backend: "fake", fingerprint: "abc", registeredAt: new Date(2026, 5, 10, 10, 0).toISOString() } }, now);
  assert.equal(diagnoseJob(job, { backend: fakeBackend(status), now, running: false }).status, "ok");
});

test("diagnoseJob: a running job is never overdue", () => {
  const now = new Date(2026, 5, 10, 12, 0);
  const { job, status } = healthy({ lastRun: null }, now);
  assert.equal(diagnoseJob(job, { backend: fakeBackend(status), now, running: true }).status, "ok");
});

test("diagnoseJob: uncalibrated StartInterval is overdue only past 2 intervals + grace", () => {
  const now = new Date(2026, 5, 10, 12, 0);
  const schedule = { kind: "interval", value: { minutes: 10, seconds: 0 } };
  const ago = (min: number) => ({ startedAt: new Date(now.getTime() - min * 60_000).toISOString(), finishedAt: now.toISOString(), exitCode: 0 });
  const reg = { backend: "fake", fingerprint: "abc", registeredAt: "2026-01-01T00:00:00.000Z" };
  const { status } = healthy();
  const fresh = healthy({ schedule, lastRun: ago(20), registration: reg }, now).job;
  const stale = healthy({ schedule, lastRun: ago(30), registration: reg }, now).job;
  assert.equal(diagnoseJob(fresh, { backend: fakeBackend(status), now, running: false }).status, "ok");
  assert.equal(diagnoseJob(stale, { backend: fakeBackend(status), now, running: false }).status, "overdue");
});

test("diagnoseJob: a failed last run is 'failing'", () => {
  const now = new Date(2026, 5, 10, 9, 5);
  const { job, status } = healthy({}, now);
  job.lastRun = { ...job.lastRun, exitCode: 1, reason: "model_error" } as any;
  const r = diagnoseJob(job, { backend: fakeBackend(status), now, running: false });
  assert.equal(r.status, "failing");
  assert.match(r.problems[0].message, /model_error/);
});

// ─── Backend status ─────────────────────────────────────────────────────

test("cron: parseCronPaths round-trips quoted node and CLI paths", () => {
  const job = { id: "a", schedule: { kind: "daily", value: { time: "09:00" } } };
  const { line } = buildCronLine(job, { nodePath: "/x/n%o'de", cliPath: "/c li/pi-tick.mjs", logsDir: "/l" });
  assert.deepEqual(parseCronPaths(line), { nodePath: "/x/n%o'de", cliPath: "/c li/pi-tick.mjs", cwd: null });
});

test("launchd: parsePlistPaths reads node, CLI and cwd", () => {
  const job = { id: "a", cwd: "/w&d", schedule: { kind: "daily", value: { time: "09:00" } } };
  const plist = renderPlist(job, { nodePath: "/n<ode", cliPath: "/cli", logsDir: "/l" });
  assert.deepEqual(parsePlistPaths(plist), { nodePath: "/n<ode", cliPath: "/cli", cwd: "/w&d" });
});

test("cron: status fingerprint matches what register returned, and detects edits", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    const file = join(dir, "crontab.txt");
    writeStub(env, "crontab", `f='${file}'\ncase "$1" in\n  -l) [ -f "$f" ] || { echo "no crontab for x" >&2; exit 1; }; while IFS= read -r l || [ -n "$l" ]; do printf '%s\\n' "$l"; done < "$f";;\n  -) rm -f "$f"; while IFS= read -r l; do printf '%s\\n' "$l" >> "$f"; done;;\nesac`);
    try {
      await withEnv(env, async () => {
        const job = { id: "c1", schedule: { kind: "daily", value: { time: "09:00" } } };
        assert.equal(cronBackend.status("c1").registered, false);
        const reg = await cronBackend.register(job, { nodePath: "/n", cliPath: "/cli", logsDir: join(dir, "logs") });
        assert.ok(reg.ok);
        const st = cronBackend.status("c1");
        assert.equal(st.registered, true);
        assert.equal(st.fingerprint, reg.fingerprint);
        assert.equal(st.paths.nodePath, "/n");
        writeFileSync(file, readFileSync(file, "utf8").replace("'/n'", "'/other'"));
        assert.notEqual(cronBackend.status("c1").fingerprint, reg.fingerprint);
      });
    } finally {
      teardownEnv(env);
    }
  });
});

// ─── End to end: node upgrade → doctor → --fix ──────────────────────────

test("doctor finds a job broken by a node upgrade; list shows stale; --fix re-registers it", async () => {
  await withTempDir(async (dir) => {
    const plistDir = join(dir, "agents");
    const env = setupEnv({ dataDir: dir, plistDir });
    const oldNode = writeStub(env, "node", `echo fake`);
    writeStub(env, "launchctl", `exit 0`);
    try {
      const cliPath = new URL("../extensions/tick/bin/pi-tick.mjs", import.meta.url).pathname;
      copyFileSync(cliPath, join(dir, "pi-tick.mjs"));
      chmodSync(join(dir, "pi-tick.mjs"), 0o755);
      const sink = capture().stream;
      await withEnv(env, () => cmdAdd(["nightly", "--prompt", "true", "--agent", "command", "--cwd", "/tmp", "--kind", "daily", "--time", "09:00", "--enabled"], { stdout: sink, stderr: sink }));
      const cat = JSON.parse(readFileSync(join(dir, "jobs.json"), "utf8"));
      assert.ok(cat.jobs[0].registration?.fingerprint, "enable stores the registered fingerprint");

      // Healthy right after enable.
      let c = capture();
      assert.equal(await withEnv(env, () => cmdDoctor([], { stdout: c.stream, stderr: c.stream })), 0, c.out.join(""));

      // "Upgrade" node: the old binary disappears, a new one appears elsewhere.
      unlinkSync(oldNode);
      const newBin = join(dir, "newbin");
      mkdirSync(newBin);
      writeFileSync(join(newBin, "node"), "#!/bin/sh\necho fake\n", { mode: 0o755 });
      env.PATH = [newBin, env.PATH].join(delimiter);

      c = capture();
      assert.equal(await withEnv(env, () => cmdDoctor([], { stdout: c.stream, stderr: c.stream })), 1);
      assert.match(c.out.join(""), /nightly\s+stale\s+node not found/);
      assert.match(c.out.join(""), /doctor --fix/);

      c = capture();
      await withEnv(env, () => cmdList([], { stdout: c.stream, stderr: c.stream }));
      assert.match(c.out.join(""), /nightly\s+yes\s+stale/);

      c = capture();
      assert.equal(await withEnv(env, () => cmdDoctor(["--fix"], { stdout: c.stream, stderr: c.stream })), 0, c.out.join(""));
      assert.match(c.out.join(""), /fix: re-registered/);
      const plist = readFileSync(join(plistDir, "dev.pi.tick.nightly.plist"), "utf8");
      assert.ok(plist.includes(join(newBin, "node")));

      // A removed plist is caught too.
      unlinkSync(join(plistDir, "dev.pi.tick.nightly.plist"));
      c = capture();
      assert.equal(await withEnv(env, () => cmdDoctor(["nightly", "--json"], { stdout: c.stream, stderr: c.stream })), 1);
      const json = JSON.parse(c.out.join(""));
      assert.equal(json[0].status, "stale");
      assert.ok(json[0].problems.some((p: { code: string }) => p.code === "not-registered"));
      assert.ok(!existsSync(join(plistDir, "dev.pi.tick.nightly.plist")), "doctor without --fix is read-only");
    } finally {
      teardownEnv(env);
    }
  });
});

test("doctor <id> on an unknown job exits 4", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await assert.rejects(withEnv(env, () => cmdDoctor(["nope"], { stdout: capture().stream, stderr: capture().stream })), (e: any) => e.code === 4);
    } finally {
      teardownEnv(env);
    }
  });
});

// ─── Re-registration safety, validation, env propagation (launchd) ──────

// A launchctl stub that logs every call and, while a `fail-bootstrap` flag
// file exists, fails `bootstrap` of any plist scheduled at minute 30.
function launchctlLogStub(env: ReturnType<typeof setupEnv>, dir: string) {
  const log = join(dir, "launchctl.log");
  const flag = join(dir, "fail-bootstrap");
  writeStub(env, "launchctl", `echo "$1" >> '${log}'
if [ "$1" = bootstrap ] && [ -f '${flag}' ] && grep -q '<integer>30</integer>' "$3"; then echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; fi
exit 0`);
  const calls = (verb: string) => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l === verb).length : 0);
  return { flag, calls };
}

function seedCli(dir: string) {
  copyFileSync(new URL("../extensions/tick/bin/pi-tick.mjs", import.meta.url).pathname, join(dir, "pi-tick.mjs"));
  chmodSync(join(dir, "pi-tick.mjs"), 0o755);
}

const ADD_DAILY = (id: string, extra: string[] = []) =>
  [id, "--prompt", "true", "--agent", "command", "--cwd", "/tmp", "--kind", "daily", "--time", "09:00", ...extra];

test("launchd register: a failed bootstrap restores the previous plist and reloads it (re-register of an enabled job)", async () => {
  await withTempDir(async (dir) => {
    const plistDir = join(dir, "agents");
    const env = setupEnv({ dataDir: dir, plistDir });
    const lc = launchctlLogStub(env, dir);
    try {
      const job = (time: string) => ({ id: "keep", cwd: "/tmp", schedule: { kind: "daily", value: { time } } });
      const opts = { nodePath: "/usr/bin/node", cliPath: "/opt/pi-tick.mjs", logsDir: join(dir, "logs") };
      const pp = join(plistDir, "dev.pi.tick.keep.plist");
      await withEnv(env, async () => {
        assert.ok((await launchdBackend.register(job("09:00") as any, opts)).ok);
        const before = readFileSync(pp, "utf8");
        assert.equal(lc.calls("bootstrap"), 1);
        writeFileSync(lc.flag, "1");
        const r = await launchdBackend.register(job("10:30") as any, opts);
        assert.equal(r.ok, false);
        assert.equal(readFileSync(pp, "utf8"), before, "previous plist restored");
        assert.equal(lc.calls("bootstrap"), 3, "initial + failed attempt + reload of the restored plist");
        // Brand-new job: nothing to restore, so the plist is removed.
        const r2 = await launchdBackend.register({ ...job("10:30"), id: "fresh" } as any, opts);
        assert.equal(r2.ok, false);
        assert.ok(!existsSync(join(plistDir, "dev.pi.tick.fresh.plist")));
      });
    } finally {
      teardownEnv(env);
    }
  });
});

test("enable of an already-enabled job with a live run skips re-registration; doctor --fix says 'running; retry later'", async () => {
  await withTempDir(async (dir) => {
    const plistDir = join(dir, "agents");
    const env = setupEnv({ dataDir: dir, plistDir });
    writeStub(env, "node", `echo fake`);
    const lc = launchctlLogStub(env, dir);
    try {
      seedCli(dir);
      const sink = capture().stream;
      await withEnv(env, () => cmdAdd(ADD_DAILY("busy", ["--enabled"]), { stdout: sink, stderr: sink }));
      assert.equal(lc.calls("bootout"), 1);
      const record = { jobId: "busy", runId: "r1", pid: process.pid, childPid: process.pid, startedAt: new Date().toISOString() };
      await withEnv(env, async () => {
        writeActiveRun("busy", record);

        let c = capture();
        assert.equal(await cmdEnable(["busy"], { stdout: c.stream, stderr: c.stream }), 0);
        assert.match(c.out.join(""), /already enabled and currently running; not re-registering/);
        assert.equal(lc.calls("bootout"), 1, "no bootout (would SIGTERM the run)");

        // doctor --fix: break the plist so there is a fixable problem.
        const pp = join(plistDir, "dev.pi.tick.busy.plist");
        unlinkSync(pp);
        c = capture();
        await cmdDoctor(["--fix"], { stdout: c.stream, stderr: c.stream });
        assert.match(c.out.join(""), /fix: running; retry later/);
        assert.ok(!existsSync(pp));
        assert.equal(lc.calls("bootout"), 1);

        // Once the run is gone, enable re-registers as before.
        clearActiveRun("busy", "r1");
        c = capture();
        assert.equal(await cmdEnable(["busy"], { stdout: c.stream, stderr: c.stream }), 0);
        assert.match(c.out.join(""), /^enabled job 'busy'/);
        assert.ok(existsSync(pp));
        assert.equal(lc.calls("bootout"), 2);
      });
    } finally {
      teardownEnv(env);
    }
  });
});

test("add rejects an id that differs from an existing one only by case (exit 4)", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      const sink = capture().stream;
      await withEnv(env, async () => {
        await cmdAdd(ADD_DAILY("Nightly"), { stdout: sink, stderr: sink });
        await assert.rejects(cmdAdd(ADD_DAILY("nightly"), { stdout: sink, stderr: sink }), (e: any) => e.code === 4 && /conflicts with existing job 'Nightly'/.test(e.message));
        await assert.rejects(cmdAdd(ADD_DAILY("Nightly"), { stdout: sink, stderr: sink }), (e: any) => e.code === 4 && /already exists/.test(e.message));
        await cmdAdd(ADD_DAILY("Other"), { stdout: sink, stderr: sink }); // unrelated ids still fine
      });
      const cat = JSON.parse(readFileSync(join(dir, "jobs.json"), "utf8"));
      assert.deepEqual(cat.jobs.map((j: any) => j.id), ["Nightly", "Other"]);
    } finally {
      teardownEnv(env);
    }
  });
});

test("enable re-validates cwd and --on-complete (exit 2) instead of registering a job that cannot start", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    writeStub(env, "node", `echo fake`);
    const lc = launchctlLogStub(env, dir);
    try {
      seedCli(dir);
      const work = join(dir, "work");
      mkdirSync(work);
      const cb = join(dir, "cb.sh");
      writeFileSync(cb, "#!/bin/sh\n", { mode: 0o755 });
      const sink = capture().stream;
      await withEnv(env, async () => {
        await cmdAdd(["gone", "--prompt", "true", "--agent", "command", "--cwd", work, "--kind", "daily", "--time", "09:00", "--on-complete", cb], { stdout: sink, stderr: sink });
        unlinkSync(cb);
        await assert.rejects(cmdEnable(["gone"], { stdout: sink, stderr: sink }), (e: any) => e.code === 2 && /--on-complete/.test(e.message));
        writeFileSync(cb, "#!/bin/sh\n", { mode: 0o755 });
        rmSync(work, { recursive: true });
        await assert.rejects(cmdEnable(["gone"], { stdout: sink, stderr: sink }), (e: any) => e.code === 2 && /cwd does not exist/.test(e.message));
      });
      assert.equal(lc.calls("bootstrap"), 0);
      assert.ok(!existsSync(join(dir, "agents", "dev.pi.tick.gone.plist")));
      assert.equal(JSON.parse(readFileSync(join(dir, "jobs.json"), "utf8")).jobs[0].enabled, false);
    } finally {
      teardownEnv(env);
    }
  });
});

test("enable bakes the documented PI_TICK_* overrides into the plist (XML-escaped) and doctor sees no drift", async () => {
  await withTempDir(async (dir) => {
    const plistDir = join(dir, "agents");
    const env = setupEnv({ dataDir: dir, plistDir });
    writeStub(env, "node", `echo fake`);
    launchctlLogStub(env, dir);
    try {
      seedCli(dir);
      const sink = capture().stream;
      const overrides = { PI_TICK_LOG_RETENTION_DAYS: "3", PI_TICK_LOG_MAX_BYTES: "1234", PI_TICK_RUNS_MAX_BYTES: "5678&<x>" };
      await withEnv({ ...env, ...overrides }, () => cmdAdd(ADD_DAILY("envy", ["--enabled"]), { stdout: sink, stderr: sink }));
      const plist = readFileSync(join(plistDir, "dev.pi.tick.envy.plist"), "utf8");
      for (const [k, v] of [["PI_TICK_LOG_RETENTION_DAYS", "3"], ["PI_TICK_LOG_MAX_BYTES", "1234"], ["PI_TICK_RUNS_MAX_BYTES", "5678&amp;&lt;x&gt;"], ["PI_TICK_DATA_DIR", dir], ["PI_TICK_BACKEND", "launchd"]]) {
        assert.ok(plist.includes(`<key>${k}</key>\n    <string>${v}</string>`), `${k} missing:\n${plist}`);
      }
      // Unset overrides are not invented.
      assert.ok(!plist.includes("PI_TICK_CRONTAB"));
      // Doctor (run in a different env) compares stored vs on-disk text: no false drift.
      const c = capture();
      assert.equal(await withEnv(env, () => cmdDoctor([], { stdout: c.stream, stderr: c.stream })), 0, c.out.join(""));
    } finally {
      teardownEnv(env);
    }
  });
});
