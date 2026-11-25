// Regression tests for runner / run-registry / pi-adapter bugs found in a bug hunt:
// huge stdout lines, taskflow failure detection, /tf arg parsing, signal handling
// and orphaned runs (runner died, child still running).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import * as runner from "../extensions/tick/bin/runner.mjs";
import * as registry from "../extensions/tick/bin/run-registry.mjs";
import { buildRunArgs } from "../extensions/tick/bin/agents/pi.mjs";
import { cmdKill } from "../extensions/tick/bin/commands/kill.mjs";

let tempDir: string;
let savedDataDir: string | undefined;

before(() => {
  tempDir = mkdtempSync(join(tmpdir(), "pi-tick-bugfix-"));
  savedDataDir = process.env.PI_TICK_DATA_DIR;
  process.env.PI_TICK_DATA_DIR = tempDir;
});
after(() => {
  if (savedDataDir === undefined) delete process.env.PI_TICK_DATA_DIR;
  else process.env.PI_TICK_DATA_DIR = savedDataDir;
  rmSync(tempDir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitFor(fn: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(20); }
  return fn();
}
const runs = () => {
  const f = join(tempDir, "runs.jsonl");
  return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};

function opts(extra: object = {}) {
  return {
    piPath: "/usr/bin/pi", transcriptsDir: join(tempDir, "transcripts"), logsDir: join(tempDir, "logs"),
    envPath: "/usr/bin:/bin", stderr: { write: () => {} }, ...extra,
  };
}
function mockChild() {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = Object.assign(new EventEmitter(), { destroyed: false, ended: 0, write() {}, end() { this.ended++; } });
  child.kill = (signal: string) => {
    if (child.killedWith !== undefined) return;
    child.killedWith = signal;
    child.emit("close", null, signal);
  };
  return child;
}
let stubSeq = 0;
function shStub(body: string) {
  const p = join(tempDir, `stub-${++stubSeq}.sh`);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}
const job = (id: string, extra: object = {}) => ({ id, prompt: "do something", cwd: tmpdir(), timeoutMs: 0, idleTimeoutMs: 0, ...extra });

// ── 1. lines longer than 1MB ──
test("runJob: an agent_end line larger than 1MB still closes RPC stdin and is parsed", async () => {
  const child = mockChild();
  const p = runner.runJob(job("big-line", { prompt: "/cmd" }), "manual", opts({ spawnFn: () => child }));
  const evt = JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "x".repeat(3 * 1024 * 1024) }], stopReason: "error", errorMessage: "boom" },
  });
  const agentEnd = JSON.stringify({ type: "agent_end", messages: [{ pad: "y".repeat(2 * 1024 * 1024) }] });
  // deliver in 64KB chunks, as a pipe would
  for (const line of [evt, agentEnd]) {
    const buf = Buffer.from(line + "\n");
    for (let i = 0; i < buf.length; i += 65536) child.stdout.emit("data", buf.subarray(i, i + 65536));
  }
  assert.equal(child.stdin.ended, 1, "stdin closed by the >1MB agent_end line");
  child.emit("close", 0, null);
  const res = await p;
  assert.equal(res.reason, "model_error", "the >1MB message_end (model error) was parsed, not dropped");
});

test("runJob: a line past the hard cap is discarded but an overflowed agent_end still ends the turn", async () => {
  const child = mockChild();
  const p = runner.runJob(job("huge-line", { prompt: "/cmd" }), "manual", opts({ spawnFn: () => child }));
  const head = Buffer.from('{"type":"agent_end","messages":["');
  child.stdout.emit("data", head);
  const chunk = Buffer.alloc(8 * 1024 * 1024, "z");
  for (let i = 0; i < 9; i++) child.stdout.emit("data", chunk); // 72MB > 64MB cap
  assert.equal(child.stdin.ended, 1, "stdin closed once the line overflowed");
  child.stdout.emit("data", Buffer.from('"]}\n{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"later"}}\n'));
  child.emit("close", 0, null);
  const res = await p;
  assert.equal(res.reason, "model_error", "parsing resumes on the line after the overflowed one");
  assert.equal(res.error, "later");
});

// ── 2. taskflow failure detection only for taskflow prompts ──
async function finalTextRun(id: string, prompt: string, text: string) {
  const child = mockChild();
  const p = runner.runJob(job(id, { prompt }), "manual", opts({ spawnFn: () => child }));
  child.stdout.emit("data", Buffer.from(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } }) + "\n"));
  child.emit("close", 0, null);
  return p;
}

test("taskflow failure text in a normal prompt's output does not fail a clean exit", async () => {
  const res = await finalTextRun("tf-normal", "summarize the CI log", "The taskflow job failed last night because of a typo.");
  assert.equal(res.exitCode, 0);
  assert.equal(res.reason, "exit_code");
});

test("taskflow prompt: a real failure report fails the run; prose mentioning 'taskflow failed' does not", async () => {
  const bad = await finalTextRun("tf-bad", "/tf:deploy env=prod", "Taskflow `deploy` failed.\n\n- Failed at: `plan`\n- Reason: no budget");
  assert.equal(bad.reason, "taskflow_failed");
  assert.equal(bad.error, "no budget");
  const header = await finalTextRun("tf-hdr", "/tf run deploy", "Taskflow `deploy` failed.");
  assert.equal(header.reason, "taskflow_failed");
  const ok = await finalTextRun("tf-ok", "/tf:deploy", "Done. Earlier I assumed the taskflow had failed, but it succeeded.");
  assert.equal(ok.reason, "exit_code");
  assert.equal(runner.extractTaskflowFailure("I think the taskflow failed somewhere"), null, "bare fallback is gone");
});

// ── 3. /tf argument parsing ──
function tfArgs(prompt: string) {
  const msg = buildRunArgs({ prompt }, {}).args.at(-1)!;
  return JSON.parse(msg.match(/with (\{.*\})\. Do not/s)![1]).args;
}

test("/tf args: quoted values keep their spaces; bare values and '=' in values still work", () => {
  assert.deepEqual(tfArgs('/tf:x msg="hello world" mode=fast'), { msg: "hello world", mode: "fast" });
  assert.deepEqual(tfArgs("/tf run x msg='a b  c' k=v=w"), { msg: "a b  c", k: "v=w" });
  assert.deepEqual(tfArgs('/tf:x msg="say \\"hi\\""'), { msg: 'say "hi"' });
  assert.deepEqual(tfArgs("/tf:x force=true maxOpenIssues=10"), { force: "true", maxOpenIssues: "10" });
});

test("/tf prompt spanning multiple lines is still a taskflow prompt (not RPC mode)", () => {
  const plan = buildRunArgs({ prompt: '/tf:x a=1\nb="two\nlines"\nc=3' }, {});
  assert.equal(plan.isSlashCommand, false);
  assert.ok(plan.args.includes("--tools"));
  assert.deepEqual(tfArgs('/tf:x a=1\nb="two\nlines"\nc=3'), { a: "1", b: "two\nlines", c: "3" });
  assert.equal(buildRunArgs({ prompt: "/compact\nnow" }, {}).isSlashCommand, true);
});

// ── 4 + 5. runner signal handling (handlers are exercised via process.emit) ──
runner.enableTerminationHandling();

async function withFakeExit<T>(fn: (exited: Promise<number>) => Promise<T>) {
  const realExit = process.exit;
  let resolveExit!: (c: number) => void;
  const exited = new Promise<number>((r) => { resolveExit = r; });
  (process as any).exit = (c: number) => { resolveExit(c); };
  try { return await fn(exited); } finally { (process as any).exit = realExit; }
}

for (const [sig, code] of [["SIGHUP", 129], ["SIGQUIT", 131], ["SIGTERM", 143], ["SIGINT", 130]] as const) {
  test(`runner: ${sig} terminates the child, records 'terminated' and exits ${code}`, async () => {
    await withFakeExit(async (exited) => {
      const child = mockChild();
      const p = runner.runJob(job(`sig-${sig}`), "manual", opts({ spawnFn: () => child }));
      await sleep(10);
      (process as any).emit(sig);
      const res = await p;
      assert.equal(child.killedWith, "SIGTERM");
      assert.equal(res.reason, "terminated");
      assert.equal(res.exitCode, 143);
      assert.equal(await exited, code);
    });
  });
}

test("runner: SIGTERM after the child already exited does not signal it or relabel a clean exit", async () => {
  await withFakeExit(async (exited) => {
    const child = mockChild();
    const p = runner.runJob(job("late-term"), "manual", opts({ spawnFn: () => child, drainMs: 300 }));
    await sleep(10);
    child.emit("exit", 0, null); // child reaped; pipes still draining
    (process as any).emit("SIGTERM");
    child.emit("close", 0, null);
    const res = await p;
    assert.equal(child.killedWith, undefined, "no signal sent to the exited child");
    assert.equal(res.reason, "exit_code");
    assert.equal(res.exitCode, 0);
    assert.equal(await exited, 143, "the runner itself still exits");
  });
});

// ── 6. orphaned runs: runner dead, child alive ──
function spawnVictim() {
  return spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", detached: true });
}
function deadPid() {
  const r = spawnSync(process.execPath, ["-e", "0"]);
  return r.pid;
}
function writeActive(jobId: string, rec: object) {
  mkdirSync(join(tempDir, "active"), { recursive: true });
  writeFileSync(join(tempDir, "active", `${jobId}.json`), JSON.stringify({ jobId, runId: `run-${jobId}`, startedAt: "2026-01-01T00:00:00.000Z", ...rec }));
}

test("a dead runner with a live, verified child is an orphaned live run that `kill` can target", async () => {
  const victim = spawnVictim();
  try {
    await waitFor(() => !!registry.processStart(victim.pid!));
    writeActive("orph", { pid: deadPid(), childPid: victim.pid, childStart: registry.processStart(victim.pid!) });
    const live = registry.getActiveRun("orph") as any;
    assert.ok(live, "still reported as running");
    assert.equal(live.orphaned, true);
    assert.ok(existsSync(join(tempDir, "active", "orph.json")), "record kept while the child lives");

    const out: string[] = [];
    const code = await cmdKill(["orph", "--grace-ms", "500"], { stdout: { write: (s: string) => out.push(s) } as any, stderr: { write: (s: string) => out.push(s) } as any });
    assert.equal(code, 0, out.join(""));
    assert.match(out.join(""), /killed job 'orph'.*runner had already died/);
    assert.ok(await waitFor(() => !alive(victim.pid!)), "child process group killed");
    assert.equal(registry.getActiveRun("orph"), null);
    assert.ok(!existsSync(join(tempDir, "active", "orph.json")));
    const rec = runs().filter((r) => r.jobId === "orph");
    assert.equal(rec.length, 1, "exactly one orphaned run record");
    assert.equal(rec[0].reason, "orphaned");
    assert.equal(rec[0].runId, "run-orph");
  } finally { if (alive(victim.pid!)) process.kill(victim.pid!, "SIGKILL"); }
});

test("a dead runner whose child is also dead is cleaned up and logged once as orphaned", () => {
  writeActive("orph-dead", { pid: deadPid(), childPid: deadPid(), childStart: "Mon Jan  1 00:00:00 2001" });
  assert.equal(registry.getActiveRun("orph-dead"), null);
  assert.equal(registry.getActiveRun("orph-dead"), null);
  assert.ok(!existsSync(join(tempDir, "active", "orph-dead.json")));
  assert.deepEqual(runs().filter((r) => r.jobId === "orph-dead").map((r) => r.reason), ["orphaned"]);
});

test("a dead runner with a recycled child pid (start time mismatch) is not treated as orphaned live", async () => {
  const victim = spawnVictim();
  try {
    await waitFor(() => !!registry.processStart(victim.pid!));
    writeActive("orph-recycled", { pid: deadPid(), childPid: victim.pid, childStart: "Mon Jan  1 00:00:00 1990" });
    assert.equal(registry.getActiveRun("orph-recycled"), null);
    const res = await registry.killActiveRun("orph-recycled", { graceMs: 100, pollMs: 10 });
    assert.equal(res.ok, false);
    assert.ok(alive(victim.pid!), "unrelated process untouched");
  } finally { if (alive(victim.pid!)) process.kill(victim.pid!, "SIGKILL"); }
});
