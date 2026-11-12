// Issue #26 — kill & process lifecycle, tested against real stub process trees.
// Safety: every process killed here was spawned by these tests (pids come from
// files the stubs write); leftovers are reaped in `finally`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import * as runner from "../extensions/tick/bin/runner.mjs";
import * as registry from "../extensions/tick/bin/run-registry.mjs";
import { cmdRun } from "../extensions/tick/bin/commands/run.mjs";
import { loadCatalog, saveCatalog } from "../extensions/tick/bin/catalog.mjs";

let tempDir: string;
let stubDir: string;
let savedDataDir: string | undefined;

before(() => {
  tempDir = mkdtempSync(join(tmpdir(), "pi-tick-life-"));
  stubDir = mkdtempSync(join(tmpdir(), "pi-tick-life-stubs-"));
  savedDataDir = process.env.PI_TICK_DATA_DIR;
  process.env.PI_TICK_DATA_DIR = tempDir;
});
after(() => {
  if (savedDataDir === undefined) delete process.env.PI_TICK_DATA_DIR;
  else process.env.PI_TICK_DATA_DIR = savedDataDir;
  rmSync(tempDir, { recursive: true, force: true });
  rmSync(stubDir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
function reap(pid: number | null | undefined) {
  if (pid && alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
}
async function waitFor(fn: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(20); }
  return fn();
}
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<T>((_, rej) => { timer = setTimeout(() => rej(new Error(`timed out: ${label}`)), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
const runs = () => {
  const f = join(tempDir, "runs.jsonl");
  return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};

// A `pi` stub: spawns a descendant in the same process group (inheriting
// stdout/stderr, so it holds the pipes open), records its pid, then behaves
// per `mode`.
//  - "term-victim": pi stays alive (dies on TERM), descendant ignores TERM.
//  - "exit0": pi exits 0 immediately; descendant holds stdout for 30s.
//  - "exit0-late-marker": like exit0 but pi announces its exit via a file.
let stubSeq = 0;
function makeTreeStub(mode: "term-victim" | "exit0") {
  const n = ++stubSeq;
  const pidFile = join(stubDir, `desc-${n}.pid`);
  const piPidFile = join(stubDir, `pi-${n}.pid`);
  const doneFile = join(stubDir, `done-${n}.flag`);
  const script = join(stubDir, `pi-${n}.mjs`);
  const descSrc = `process.on("SIGTERM",()=>{});setInterval(()=>{},1000);setTimeout(()=>process.exit(0),30000);`;
  writeFileSync(script, `#!${process.execPath}
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const d = spawn(process.execPath, ["-e", ${JSON.stringify(descSrc)}], { stdio: ["ignore", "inherit", "inherit"] });
writeFileSync(${JSON.stringify(pidFile)}, String(d.pid));
writeFileSync(${JSON.stringify(piPidFile)}, String(process.pid));
${mode === "exit0" ? `writeFileSync(${JSON.stringify(doneFile)}, "1"); d.unref(); setTimeout(() => process.exit(0), 50);` : `setInterval(() => {}, 1000);`}
`, { mode: 0o755 });
  chmodSync(script, 0o755);
  const descPid = () => (existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : null);
  return { script, pidFile, doneFile, descPid, piPid: () => (existsSync(piPidFile) ? Number(readFileSync(piPidFile, "utf8")) : null) };
}

function baseOpts(extra = {}) {
  return {
    nodePath: process.execPath,
    piPath: "",
    transcriptsDir: join(tempDir, "transcripts"),
    logsDir: join(tempDir, "logs"),
    envPath: process.env.PATH,
    stderr: { write: () => {} },
    ...extra,
  };
}
function job(id: string, over = {}) {
  return { id, prompt: "p", cwd: tmpdir(), schedule: { kind: "interval", value: { minutes: 1, seconds: 0 } }, enabled: true, model: null, createdAt: "x", updatedAt: "x", lastRun: null, ...over };
}
function addJob(j: any) {
  const cat = loadCatalog();
  cat.jobs.push(j);
  saveCatalog(cat);
}

// ── 1. kill SIGKILLs a TERM-ignoring descendant; runner returns promptly ──
test("kill: SIGKILLs the process group when a descendant ignores SIGTERM, and the runner returns promptly", async () => {
  const stub = makeTreeStub("term-victim");
  let desc: number | null = null;
  try {
    const p = runner.runJob(job("kill-tree", { killGraceMs: 30000 }), "manual", baseOpts({ piPath: stub.script, drainMs: 300 }));
    assert.ok(await waitFor(() => !!stub.descPid() && !!registry.readActiveRun("kill-tree")?.childPid), "tree is up");
    desc = stub.descPid();
    const t0 = Date.now();
    const res = await registry.killActiveRun("kill-tree", { graceMs: 400, pollMs: 20 });
    assert.equal(res.ok, true);
    assert.equal(res.signal, "SIGKILL", "descendant survived TERM, so the group must be SIGKILLed");
    assert.ok(!alive(desc!), "descendant is dead");
    const rec = await withTimeout(p, 6000, "runJob after kill");
    assert.ok(Date.now() - t0 < 5000);
    assert.equal(rec.reason, "killed");
  } finally { reap(desc); reap(stub.piPid()); }
});

test("kill: signals the group even when the leader is already dead (no alreadyDead shortcut)", async () => {
  const stub = makeTreeStub("exit0");
  let desc: number | null = null;
  try {
    const p = runner.runJob(job("kill-orphan", { timeoutMs: 0 }), "manual", baseOpts({ piPath: stub.script, drainMs: 4000 }));
    assert.ok(await waitFor(() => existsSync(stub.doneFile)));
    desc = stub.descPid();
    // wait until pi (the group leader) is gone but the descendant is alive
    assert.ok(await waitFor(() => !alive(stub.piPid()!) && alive(desc!)), "leader dead, descendant alive");
    const live = registry.readActiveRun("kill-orphan");
    assert.ok(live, "run is still live via its process group");
    const res = await registry.killActiveRun("kill-orphan", { graceMs: 300, pollMs: 20 });
    assert.equal(res.ok, true);
    assert.ok(!res.alreadyDead, "must not shortcut to alreadyDead while the group lives");
    assert.ok(!alive(desc!), "descendant killed");
    await withTimeout(p, 6000, "runJob");
  } finally { reap(desc); }
});

// ── 2. exit 0 + lingering descendant holding stdout ──
test("runner: pi exits 0 with a background process holding stdout -> recorded success within the drain window, exactly once", async () => {
  const stub = makeTreeStub("exit0");
  let desc: number | null = null;
  try {
    const before = runs().length;
    const t0 = Date.now();
    // wall timeout shorter than the drain window: must NOT become `timeout`
    const rec = await withTimeout(
      runner.runJob(job("drain", { timeoutMs: 1500 }), "manual", baseOpts({ piPath: stub.script, drainMs: 2500 })), 10000, "runJob");
    desc = stub.descPid();
    assert.equal(rec.reason, "exit_code");
    assert.equal(rec.exitCode, 0);
    assert.ok(Date.now() - t0 < 8000, `took ${Date.now() - t0}ms; must not wait for the 30s descendant`);
    assert.ok(alive(desc!), "descendant still running (we did not wait for it)");
    reap(desc);
    await sleep(300);
    assert.equal(runs().length - before, 1, "run recorded exactly once");
  } finally { reap(desc); }
});

// ── 3. concurrency guard ──
test("run: a second concurrent run of the same job is refused (manual exit 5, scheduler exit 0) and records nothing", async () => {
  const stub = makeTreeStub("term-victim");
  let desc: number | null = null;
  try {
    addJob(job("busy", { piPath: stub.script, nodePath: process.execPath }));
    const errs: string[] = [];
    const err = { write: (s: string) => { errs.push(String(s)); return true; } };
    const out = { write: () => true };
    const first = cmdRun(["busy", "--manual"], { stdout: out as any, stderr: err as any });
    assert.ok(await waitFor(() => !!registry.readActiveRun("busy")?.childPid), "first run is active");
    desc = stub.descPid();
    const before = runs().length;
    const firstRunId = registry.readActiveRun("busy")?.runId;
    const second = await withTimeout(cmdRun(["busy", "--manual"], { stdout: out as any, stderr: err as any }), 4000, "second run must be refused, not started");
    assert.equal(second, 5);
    assert.ok(errs.some((e) => /already running/.test(e)));
    const third = await withTimeout(cmdRun(["busy"], { stdout: out as any, stderr: err as any }), 4000, "scheduler run must be refused");
    assert.equal(third, 0, "scheduler path exits 0");
    assert.equal(runs().length, before, "refused starts record nothing");
    assert.equal(registry.readActiveRun("busy")?.runId, firstRunId, "first run's active file untouched");
    await registry.killActiveRun("busy", { graceMs: 300, pollMs: 20 });
    await withTimeout(first, 8000, "first run");
  } finally {
    // best effort: stop any run this test started (including an unwanted second one)
    for (let i = 0; i < 2; i++) { try { await registry.killActiveRun("busy", { graceMs: 200, pollMs: 20 }); } catch { /* */ } }
    reap(stub.piPid()); reap(desc);
  }
});

// ── 4. kill flag vs a clean exit that happened before the request ──
test("kill flag is not applied to a clean exit 0 that finished before the kill was requested", async () => {
  const stub = makeTreeStub("exit0");
  let desc: number | null = null;
  try {
    const p = runner.runJob(job("flag", { timeoutMs: 0 }), "manual", baseOpts({ piPath: stub.script, drainMs: 4000 }));
    assert.ok(await waitFor(() => existsSync(stub.doneFile)));
    desc = stub.descPid();
    assert.ok(await waitFor(() => !alive(stub.piPid()!)), "pi has exited cleanly");
    await sleep(100);
    // The run is only still "live" through its lingering descendant; kill it.
    const res = await registry.killActiveRun("flag", { graceMs: 300, pollMs: 20 });
    assert.equal(res.ok, true);
    const rec = await withTimeout(p, 8000, "runJob");
    assert.equal(rec.reason, "exit_code", "pi exited 0 before the kill request; not 'killed'");
    assert.equal(rec.exitCode, 0);
  } finally { reap(desc); }
});

test("kill: writes no marker and recreates no active file when the run is already gone", async () => {
  const res = await registry.killActiveRun("ghost-job", { graceMs: 50, pollMs: 10 });
  assert.equal(res.ok, false);
  const dir = join(tempDir, "active");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith("ghost-job")) : [];
  assert.deepEqual(files, []);
});

// ── 5. run detection: no prefix / regex false positives ──
test("list/getActiveRun: other jobs' processes (backup-daily, axb) are not mistaken for backup / a.b", async () => {
  const decoys = ["backup-daily", "axb"].map((id) =>
    spawn(process.execPath, ["-e", "setInterval(()=>{},1000)", "pi-tick.mjs", "run", id], { stdio: "ignore" }));
  try {
    await sleep(300);
    assert.equal(registry.getActiveRun("backup"), null);
    assert.equal(registry.getActiveRun("a.b"), null);
  } finally { for (const d of decoys) reap(d.pid); }
});

// ── 7. PID reuse ──
test("stale active record with a mismatched process start time is treated as not running and never signalled", async () => {
  const victim = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", detached: true });
  try {
    mkdirSync(join(tempDir, "active"), { recursive: true });
    const write = (rec: any) => writeFileSync(join(tempDir, "active", "stale.json"), JSON.stringify({ jobId: "stale", runId: "r1", startedAt: new Date().toISOString(), ...rec }));
    const real = registry.processStart(victim.pid!);
    assert.ok(real, "ps reports a start time");
    // Sanity: matching start times -> live.
    write({ pid: process.pid, pidStart: registry.processStart(process.pid), childPid: victim.pid, childStart: real });
    assert.ok(registry.getActiveRun("stale"), "matching record is live");
    // Child pid recycled (different start time) -> stale.
    write({ pid: process.pid, pidStart: registry.processStart(process.pid), childPid: victim.pid, childStart: "Mon Jan  1 00:00:00 1990" });
    const res = await registry.killActiveRun("stale", { graceMs: 100, pollMs: 10 });
    assert.equal(res.ok, false, "kill refuses a stale record");
    assert.ok(alive(victim.pid!), "the unrelated process was not signalled");
    assert.equal(registry.getActiveRun("stale"), null);
    // Runner pid recycled -> stale.
    write({ pid: process.pid, pidStart: "Mon Jan  1 00:00:00 1990", childPid: victim.pid, childStart: real });
    assert.equal(registry.getActiveRun("stale"), null);
    assert.ok(!existsSync(join(tempDir, "active", "stale.json")), "stale file cleaned up");
  } finally { reap(victim.pid); }
});

// ── 3 (runner). SIGTERM to a standalone `pi-tick run` ──
test("runner: SIGTERM to `pi-tick run` kills the child tree, records 'terminated' (143) and clears the active file", async () => {
  const stub = makeTreeStub("term-victim");
  let desc: number | null = null;
  let runnerProc: ReturnType<typeof spawn> | null = null;
  try {
    addJob(job("term-run", { piPath: stub.script, nodePath: process.execPath, killGraceMs: 400 }));
    const cli = new URL("../extensions/tick/bin/pi-tick.mjs", import.meta.url).pathname;
    runnerProc = spawn(process.execPath, [cli, "run", "term-run", "--manual"], {
      env: { ...process.env, PI_TICK_DATA_DIR: tempDir }, stdio: "ignore",
    });
    const exited = new Promise<number | null>((res) => runnerProc!.on("exit", (c, s) => res(c ?? (s ? 128 : null))));
    assert.ok(await waitFor(() => !!registry.readActiveRun("term-run")?.childPid && !!stub.descPid()), "runner started the tree");
    desc = stub.descPid();
    const child = registry.readActiveRun("term-run")!.childPid;
    runnerProc.kill("SIGTERM");
    const code = await withTimeout(exited, 8000, "runner exit");
    assert.equal(code, 143);
    assert.ok(!alive(child) && !alive(desc!), "child and descendant are dead (not orphaned)");
    const rec = runs().filter((r) => r.jobId === "term-run").pop();
    assert.equal(rec.reason, "terminated");
    assert.equal(rec.exitCode, 143);
    assert.ok(!existsSync(join(tempDir, "active", "term-run.json")), "active file cleared");
  } finally { reap(desc); reap(stub.piPid()); if (runnerProc) reap(runnerProc.pid); }
});

test("runner: signal handlers are opt-in (an in-process runJob adds none)", async () => {
  const before = [process.listenerCount("SIGTERM"), process.listenerCount("SIGINT")];
  const stub = makeTreeStub("exit0");
  let desc: number | null = null;
  try {
    const p = runner.runJob(job("noh", { timeoutMs: 0 }), "manual", baseOpts({ piPath: stub.script, drainMs: 100 }));
    assert.ok(await waitFor(() => !!stub.piPid()));
    assert.deepEqual([process.listenerCount("SIGTERM"), process.listenerCount("SIGINT")], before);
    await withTimeout(p, 6000, "runJob");
    desc = stub.descPid();
  } finally { reap(desc); }
});
