// test/guard.test.ts — `--when` guard commands (issue #66).
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runJob } from "../extensions/tick/bin/runner.mjs";
import { runGuard, substituteWhenStdout, GUARD_STDOUT_MAX_BYTES } from "../extensions/tick/bin/guard.mjs";
import { createTick, cmdAdd } from "../extensions/tick/bin/commands/add.mjs";
import { cmdRun } from "../extensions/tick/bin/commands/run.mjs";
import { cmdLog } from "../extensions/tick/bin/commands/log.mjs";
import { cmdShow } from "../extensions/tick/bin/commands/show.mjs";
import { diagnoseJob } from "../extensions/tick/bin/commands/doctor.mjs";
import { loadCatalog, findJob, appendJsonl } from "../extensions/tick/bin/catalog.mjs";
import { getActiveRun } from "../extensions/tick/bin/run-registry.mjs";

const quiet = { write() { return true; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function capture() {
  const out: string[] = [];
  return { out, stream: { write: (c: string | Uint8Array) => { out.push(String(c)); return true; } } as any, text: () => out.join("") };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "tick-guard-"));
  process.env.PI_TICK_DATA_DIR = dir;
  const logsDir = join(dir, "logs");
  mkdirSync(logsDir, { recursive: true });
  const options = { piPath: "/nonexistent/pi", transcriptsDir: join(dir, "runs"), logsDir, stderr: quiet };
  return { dir, logsDir, options };
}

function runs(dir: string): any[] {
  const p = join(dir, "runs.jsonl");
  return existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

function add(dir: string, id: string, extra: Record<string, unknown> = {}) {
  return createTick({ jobId: id, prompt: "echo ran", cwd: dir, agent: "command",
    scheduleKind: "interval", scheduleOpts: { minutes: "10" }, ...extra }, { stdout: quiet });
}

// A pi "agent" that records its argv instead of running anything.
function fakePi() {
  const calls: string[][] = [];
  const envs: Record<string, string | undefined>[] = [];
  const spawnFn = (_exe: string, args: string[], opts: any) => {
    calls.push(args);
    envs.push(opts.env);
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setTimeout(() => child.emit("close", 0, null), 10);
    return child;
  };
  return { calls, envs, spawnFn };
}

function script(dir: string, name: string, body: string) {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return p;
}

// ─── runGuard / templating ──────────────────────────────────────────────

test("guard: exit 0 passes and returns stdout with the trailing newline trimmed", async () => {
  const { dir } = setup();
  const r: any = await runGuard({ when: `printf 'a\\nb\\n\\n'`, cwd: dir }, { env: process.env });
  assert.deepEqual(r, { outcome: "pass", stdout: "a\nb" });
});

test("guard: runs in the job's cwd", async () => {
  const { dir } = setup();
  const r: any = await runGuard({ when: `pwd -P`, cwd: dir }, { env: process.env });
  assert.equal(r.outcome, "pass");
  assert.ok(r.stdout.endsWith(dir.split("/").pop()!)); // realpath may differ from tmpdir's spelling
});

test("guard: exit 1 is a skip; other exits, signals, timeouts and spawn errors are failures", async () => {
  const { dir } = setup();
  assert.deepEqual(await runGuard({ when: "exit 1", cwd: dir }, { env: process.env }), { outcome: "skip" });

  const exit2: any = await runGuard({ when: `echo first >&2; echo 'oops: bad thing' >&2; exit 2`, cwd: dir }, { env: process.env });
  assert.equal(exit2.outcome, "fail");
  assert.equal(exit2.error, "guard exit 2: oops: bad thing");

  const sig: any = await runGuard({ when: `kill -9 $$`, cwd: dir }, { env: process.env });
  assert.deepEqual(sig, { outcome: "fail", error: "guard killed by SIGKILL" });

  const slow: any = await runGuard({ when: `sleep 5`, cwd: dir }, { env: process.env, timeoutMs: 200 });
  assert.equal(slow.outcome, "fail");
  assert.match(slow.error, /^guard timed out after/);

  const nocwd: any = await runGuard({ when: `true`, cwd: join(dir, "missing") }, { env: process.env });
  assert.equal(nocwd.outcome, "fail");
  assert.match(nocwd.error, /^guard spawn failed/);
});

test("guard: a timed-out guard has its whole process group killed", async () => {
  const { dir } = setup();
  const pidFile = join(dir, "grandchild.pid");
  const r: any = await runGuard({ when: `sleep 30 & echo $! > ${pidFile}; wait`, cwd: dir }, { env: process.env, timeoutMs: 300 });
  assert.equal(r.outcome, "fail");
  const pid = Number(readFileSync(pidFile, "utf8"));
  await sleep(100);
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  if (alive) {
    const stat = existsSync(`/proc/${pid}/stat`) ? readFileSync(`/proc/${pid}/stat`, "utf8") : "";
    alive = !/\) Z /.test(stat) && stat !== "";
  }
  assert.equal(alive, false, "grandchild killed");
});

test("guard: stdout is capped at 64 KiB with a truncation marker, without blocking the guard", async () => {
  const { dir } = setup();
  const r: any = await runGuard({ when: `head -c 300000 /dev/zero | tr '\\0' a`, cwd: dir }, { env: process.env });
  assert.equal(r.outcome, "pass");
  const marker = `\n[pi-tick: guard stdout truncated at ${GUARD_STDOUT_MAX_BYTES} bytes]`;
  assert.ok(r.stdout.endsWith(marker));
  assert.equal(r.stdout.length, GUARD_STDOUT_MAX_BYTES + marker.length);
});

test("guard: substituteWhenStdout inserts literal text in one pass", () => {
  assert.equal(substituteWhenStdout("x {{when.stdout}} y {{when.stdout}}", "{{when.stdout}} $& $1"), "x {{when.stdout}} $& $1 y {{when.stdout}} $& $1");
  assert.equal(substituteWhenStdout("x {{when.stdout}}.", ""), "x .");
  assert.equal(substituteWhenStdout("x {{when.stdout}}.", undefined), "x .");
});

// ─── runJob ─────────────────────────────────────────────────────────────

test("runJob: exit 0 runs the pi agent with {{when.stdout}} filled in, without re-expanding it", async () => {
  const { dir, options } = setup();
  const job = await add(dir, "g1", { agent: "pi", prompt: "Triage: {{when.stdout}} | again: {{when.stdout}}", when: `printf '#1 {{when.stdout}} {{oops}}\\n'` });
  const pi = fakePi();
  const res: any = await runJob(job, "manual", { ...options, spawnFn: pi.spawnFn });
  assert.equal(res.exitCode, 0);
  assert.equal(pi.calls.length, 1);
  const prompt = pi.calls[0][pi.calls[0].length - 1];
  assert.equal(prompt, "Triage: #1 {{when.stdout}} {{oops}} | again: #1 {{when.stdout}} {{oops}}");
  assert.equal(pi.envs[0].PI_TICK_WHEN_STDOUT, "#1 {{when.stdout}} {{oops}}");
  assert.equal(runs(dir).length, 1);
  assert.equal(runs(dir)[0].reason, "exit_code");
});

test("runJob: a job without a guard gets an empty {{when.stdout}}; skipGuard bypasses the guard", async () => {
  const { dir, options } = setup();
  const plain = await add(dir, "plain", { agent: "pi", prompt: "A[{{when.stdout}}]" });
  const pi = fakePi();
  await runJob(plain, "manual", { ...options, spawnFn: pi.spawnFn });
  assert.equal(pi.calls[0].at(-1), "A[]");
  assert.equal(pi.envs[0].PI_TICK_WHEN_STDOUT, undefined);

  const guarded = await add(dir, "bypass", { agent: "pi", prompt: "B[{{when.stdout}}]", when: "exit 1" });
  const res: any = await runJob(guarded, "manual", { ...options, spawnFn: pi.spawnFn, skipGuard: true });
  assert.equal(res.exitCode, 0);
  assert.equal(pi.calls[1].at(-1), "B[]");
});

test("runJob: exit 1 records `skipped`, spawns nothing, writes no transcript and skips on-complete", async () => {
  const { dir, options } = setup();
  const marker = join(dir, "callback-ran");
  const cb = script(dir, "cb.sh", `touch ${marker}`);
  const job = await add(dir, "sk", { agent: "pi", when: "exit 1", onComplete: cb });
  const pi = fakePi();
  const res: any = await runJob(job, "external", { ...options, spawnFn: pi.spawnFn });
  assert.equal(pi.calls.length, 0, "no agent spawn");
  assert.equal(res.reason, "skipped");
  assert.equal(res.exitCode, 0);
  assert.equal(res.transcriptPath, null);
  assert.equal(await res.callback, null);
  await sleep(150);
  assert.equal(existsSync(marker), false, "on-complete not invoked");
  assert.equal(existsSync(join(dir, "runs", "sk")), false, "no transcript directory");

  const [rec] = runs(dir);
  assert.equal(rec.reason, "skipped");
  assert.equal(rec.exitCode, 0);
  assert.equal(rec.error, null);
  assert.equal(rec.jobId, "sk");
  assert.equal(rec.transcriptPath, undefined);
  assert.equal(findJob(loadCatalog(), "sk").lastRun.reason, "skipped");
  assert.equal(getActiveRun("sk"), null, "active record cleared");
});

test("runJob: a broken guard records `guard_failed` and starts nothing", async () => {
  const { dir, options } = setup();
  const marker = join(dir, "callback-ran");
  const cb = script(dir, "cb.sh", `touch ${marker}`);
  const job = await add(dir, "gf", { agent: "pi", when: `echo 'jq: not found' >&2; exit 127`, onComplete: cb });
  const pi = fakePi();
  const res: any = await runJob(job, "external", { ...options, spawnFn: pi.spawnFn });
  assert.equal(pi.calls.length, 0);
  assert.equal(res.reason, "guard_failed");
  assert.equal(res.exitCode, 1);
  assert.equal(res.error, "guard exit 127: jq: not found");
  await sleep(150);
  assert.equal(existsSync(marker), false);
  const [rec] = runs(dir);
  assert.equal(rec.reason, "guard_failed");
  assert.equal(rec.exitCode, 1);
  assert.equal(findJob(loadCatalog(), "gf").lastRun.reason, "guard_failed");
});

test("runJob: --when-timeout bounds the guard (guard_failed, no agent)", async () => {
  const { dir, options } = setup();
  const job = await add(dir, "slow", { agent: "pi", when: "sleep 30", whenTimeout: "1" });
  assert.equal(job.whenTimeout, 1);
  const pi = fakePi();
  const t0 = Date.now();
  const res: any = await runJob(job, "external", { ...options, spawnFn: pi.spawnFn });
  assert.ok(Date.now() - t0 < 5000);
  assert.equal(res.reason, "guard_failed");
  assert.equal(res.error, "guard timed out after 1s");
  assert.equal(pi.calls.length, 0);
});

test("runJob: command jobs get the guard's stdout in $PI_TICK_WHEN_STDOUT, never substituted into the command", async () => {
  const { dir, options } = setup();
  const out = join(dir, "out.txt");
  const job = await add(dir, "cmd", {
    prompt: `printf '%s|%s' "$PI_TICK_WHEN_STDOUT" '{{when.stdout}}' > ${out}`,
    when: `echo "x'; touch ${join(dir, "pwned")}; echo '"`,
  });
  const res: any = await runJob(job, "manual", options);
  assert.equal(res.exitCode, 0);
  assert.equal(readFileSync(out, "utf8"), `x'; touch ${join(dir, "pwned")}; echo '|{{when.stdout}}`);
  assert.equal(existsSync(join(dir, "pwned")), false);
});

test("runJob: on-complete sees the guard's stdout in $PI_TICK_WHEN_STDOUT", async () => {
  const { dir, options } = setup();
  const out = join(dir, "cb-out.txt");
  const cb = script(dir, "cb.sh", `printf %s "$PI_TICK_WHEN_STDOUT" > ${out}`);
  const job = await add(dir, "cbenv", { when: "echo from-guard", onComplete: cb });
  const res: any = await runJob(job, "manual", options);
  assert.equal(await res.callback, "exit 0");
  assert.equal(readFileSync(out, "utf8"), "from-guard");
});

test("runJob: the job is marked running while its guard runs, so an overlapping tick is refused", async () => {
  const { dir } = setup();
  await add(dir, "busy", { when: "sleep 1; exit 1" });
  const errs = capture();
  const first = cmdRun(["busy", "--manual"], { stdout: quiet as any, stderr: errs.stream });
  let active = null;
  for (let i = 0; i < 40 && !active; i++) { await sleep(50); active = getActiveRun("busy"); }
  assert.ok(active, "active record present during the guard");
  const second = await cmdRun(["busy", "--manual"], { stdout: quiet as any, stderr: errs.stream });
  assert.equal(second, 5);
  assert.match(errs.text(), /already running/);
  assert.equal(await first, 0);
  assert.equal(getActiveRun("busy"), null);
  assert.deepEqual(runs(dir).map((r) => r.reason), ["skipped"]);
});

// ─── pi-tick run --manual / --no-when ───────────────────────────────────

test("run --manual runs the guard; --no-when bypasses it; --no-when needs --manual", async () => {
  const { dir } = setup();
  const marker = join(dir, "agent-ran");
  await add(dir, "m", { prompt: `touch ${marker}`, when: "exit 1" });

  const err1 = capture();
  assert.equal(await cmdRun(["m", "--manual"], { stdout: quiet as any, stderr: err1.stream }), 0);
  assert.equal(existsSync(marker), false, "guard skipped the manual run");
  assert.match(err1.text(), /guard \(--when\) exited 1.*--no-when/);

  assert.equal(await cmdRun(["m", "--manual", "--no-when"], { stdout: quiet as any, stderr: quiet as any }), 0);
  assert.equal(existsSync(marker), true, "--no-when ran the agent");

  await assert.rejects(cmdRun(["m", "--no-when"], { stdout: quiet as any, stderr: quiet as any }), /--no-when only applies with --manual/);
  assert.deepEqual(runs(dir).map((r) => r.reason), ["skipped", "exit_code"]);

  await add(dir, "broken", { prompt: `touch ${marker}.2`, when: "exit 3" });
  const err2 = capture();
  assert.equal(await cmdRun(["broken", "--manual"], { stdout: quiet as any, stderr: err2.stream }), 1);
  assert.match(err2.text(), /guard exit 3; run not started/);
  assert.equal(existsSync(`${marker}.2`), false);
});

// ─── log ────────────────────────────────────────────────────────────────

test("log hides skipped runs by default (with a count), --all shows them, guard_failed is always shown", () => {
  const { dir } = setup();
  const rec = (runId: string, reason: string, exitCode: number, minute: number, error: string | null = null) => ({
    runId, jobId: "j", triggerKind: "external", startedAt: `2026-01-01T00:0${minute}:00.000Z`,
    finishedAt: `2026-01-01T00:0${minute}:01.000Z`, exitCode, reason, error, model: null,
  });
  const p = join(dir, "runs.jsonl");
  appendJsonl(p, rec("aaaa0001", "exit_code", 0, 1));
  appendJsonl(p, rec("aaaa0002", "skipped", 0, 2));
  appendJsonl(p, rec("aaaa0003", "skipped", 0, 3));
  appendJsonl(p, rec("aaaa0004", "guard_failed", 1, 4, "guard exit 2"));
  appendJsonl(p, rec("aaaa0005", "skipped", 0, 5));

  const def = capture();
  cmdLog([], { stdout: def.stream, stderr: quiet as any });
  assert.match(def.text(), /aaaa0001/);
  assert.match(def.text(), /aaaa0004.*guard exit 2/);
  assert.doesNotMatch(def.text(), /aaaa0002|aaaa0003|aaaa0005/);
  assert.match(def.text(), /3 skipped run\(s\) hidden; use --all/);

  const all = capture();
  cmdLog(["--all"], { stdout: all.stream, stderr: quiet as any });
  for (const id of ["aaaa0001", "aaaa0002", "aaaa0003", "aaaa0004", "aaaa0005"]) assert.match(all.text(), new RegExp(id));
  assert.doesNotMatch(all.text(), /hidden/);

  const failed = capture();
  cmdLog(["--failed"], { stdout: failed.stream, stderr: quiet as any });
  assert.match(failed.text(), /aaaa0004/);
  assert.doesNotMatch(failed.text(), /aaaa0002|hidden/);

  // Skipped rows must not crowd real runs out of --limit.
  const lim = capture();
  cmdLog(["--limit", "1"], { stdout: lim.stream, stderr: quiet as any });
  assert.match(lim.text(), /aaaa0004/);
  assert.match(lim.text(), /1 skipped run\(s\) hidden/);
});

test("log: only skipped runs prints a hint instead of an empty table", () => {
  const { dir } = setup();
  appendJsonl(join(dir, "runs.jsonl"), { runId: "bbbb0001", jobId: "j", triggerKind: "external",
    startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:00.100Z", exitCode: 0, reason: "skipped", error: null, model: null });
  const o = capture();
  cmdLog([], { stdout: o.stream, stderr: quiet as any });
  assert.match(o.text(), /no runs yet besides 1 skipped; use --all/);
});

// ─── doctor / list ──────────────────────────────────────────────────────

function liveJob(lastRun: Record<string, unknown>, now: Date) {
  const job = {
    id: "dj", prompt: "p", cwd: "/tmp", schedule: { kind: "interval", value: { minutes: 5, seconds: 0 } },
    enabled: true, nodePath: process.execPath, piPath: null, agent: "command", when: "true",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    registration: { backend: "fake", fingerprint: "abc", registeredAt: new Date(now.getTime() - 86400_000).toISOString() },
    lastRun,
  };
  const status = { registered: true, loaded: true, fingerprint: "abc", paths: { nodePath: process.execPath, cliPath: process.execPath, cwd: "/tmp" } };
  return { job, backend: { name: "fake", status: () => status } };
}

test("doctor/list: a skipped run is a healthy fire; a guard_failed last run is reported", () => {
  const now = new Date();
  const recent = new Date(now.getTime() - 60_000).toISOString();
  const skipped = liveJob({ startedAt: recent, finishedAt: recent, exitCode: 0, reason: "skipped", error: null }, now);
  const ok = diagnoseJob(skipped.job, { backend: skipped.backend as any, now, running: false });
  assert.equal(ok.status, "ok");
  assert.deepEqual(ok.problems, []);

  // Old last run of the same job IS overdue: skips are what keep it alive.
  const old = new Date(now.getTime() - 3 * 3600_000).toISOString();
  const stale = liveJob({ startedAt: old, finishedAt: old, exitCode: 0, reason: "exit_code", error: null }, now);
  assert.equal(diagnoseJob(stale.job, { backend: stale.backend as any, now, running: false }).status, "overdue");

  const failed = liveJob({ startedAt: recent, finishedAt: recent, exitCode: 1, reason: "guard_failed", error: "guard exit 127: jq: not found" }, now);
  const res = diagnoseJob(failed.job, { backend: failed.backend as any, now, running: false });
  assert.equal(res.status, "failing");
  assert.deepEqual(res.problems.map((p: any) => p.code), ["guard-failed"]);
  assert.match(res.problems[0].message, /guard \(--when\) failed: guard exit 127: jq: not found/);
});

// ─── add validation / display ───────────────────────────────────────────

test("add: --when and --when-timeout are validated and stored", async () => {
  const { dir } = setup();
  const base = ["--prompt", "p", "--cwd", dir, "--kind", "interval", "--minutes", "5"];
  const run = (id: string, ...extra: string[]) => cmdAdd([id, ...base, ...extra], { stdout: quiet as any, stderr: quiet as any });

  assert.equal(await run("w1", "--when", "git diff --quiet HEAD@{1}", "--when-timeout", "15"), 0);
  const w1 = findJob(loadCatalog(), "w1");
  assert.equal(w1.when, "git diff --quiet HEAD@{1}");
  assert.equal(w1.whenTimeout, 15);

  assert.equal(await run("w2", "--when", "true"), 0);
  const w2 = findJob(loadCatalog(), "w2");
  assert.equal(w2.when, "true");
  assert.equal("whenTimeout" in w2, false);
  await run("w3");
  assert.equal("when" in findJob(loadCatalog(), "w3"), false);

  await assert.rejects(run("e1", "--when", ""), /--when requires a non-empty value/);
  await assert.rejects(run("e2", "--when", "   "), /--when requires a non-empty value/);
  await assert.rejects(run("e3", "--when"), /--when requires a value/);
  await assert.rejects(run("e4", "--when-timeout", "5"), /--when-timeout requires --when/);
  for (const bad of ["0", "-1", "1.5", "abc", "1e3", "99999999999"]) {
    await assert.rejects(run("e5", "--when", "true", `--when-timeout=${bad}`), /--when-timeout must be/, `--when-timeout=${bad}`);
  }
  await assert.rejects(run("e6", "--when", "true", "--when-timeout"), /--when-timeout requires a value/);
  assert.equal(findJob(loadCatalog(), "e5"), null);
});

test("show prints the guard of a job that has one", async () => {
  const { dir } = setup();
  await add(dir, "shown", { when: "test -f /tmp/x", whenTimeout: "9" });
  await add(dir, "unguarded");
  const a = capture();
  cmdShow(["shown"], { stdout: a.stream, stderr: quiet as any });
  assert.match(a.text(), /^guard \(--when\): test -f \/tmp\/x \(timeout 9s\)\n/);
  const b = capture();
  cmdShow(["unguarded"], { stdout: b.stream, stderr: quiet as any });
  assert.doesNotMatch(b.text(), /guard \(--when\)/);
});
