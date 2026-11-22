import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runJob, pruneLogs } from "../extensions/tick/bin/runner.mjs";
import { runCallback, callbackLogPath } from "../extensions/tick/bin/callback.mjs";
import { createTick } from "../extensions/tick/bin/commands/add.mjs";
import { cleanupJobArtifacts } from "../extensions/tick/bin/catalog.mjs";
import { waitForCallback } from "../extensions/tick/bin/commands/run.mjs";

const quiet = { write() { return true; } };

function setup(id: string) {
  const dir = mkdtempSync(join(tmpdir(), "tick-oncomplete-"));
  process.env.PI_TICK_DATA_DIR = dir;
  const logsDir = join(dir, "logs");
  mkdirSync(logsDir, { recursive: true });
  return { dir, logsDir, options: { piPath: "/nonexistent/pi", transcriptsDir: join(dir, "runs"), logsDir, stderr: quiet } };
}

function script(dir: string, name: string, body: string) {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return p;
}

test("on-complete: runs after the run is recorded and no longer active, without delaying runJob", async () => {
  const { dir, options } = setup("oc");
  const seen = join(dir, "seen.json");
  const cb = script(dir, "cb.sh", [
    `cat > ${seen}.stdin`,
    `if [ -e ${join(dir, "active", "oc.json")} ]; then echo active; else echo inactive; fi > ${seen}.active`,
    `cp ${join(dir, "runs.jsonl")} ${seen}.runs`,
    `sleep 0.5`,
    `echo callback-said-hi`,
  ].join("\n"));
  const job = await createTick({ jobId: "oc", prompt: "echo done", cwd: dir, agent: "command", onComplete: cb,
    scheduleKind: "daily", scheduleOpts: { time: "09:00" } }, { stdout: quiet });
  assert.equal(job.onComplete, cb);

  const t0 = Date.now();
  const res: any = await runJob(job, "manual", options);
  assert.ok(Date.now() - t0 < 450, "runJob does not wait for the callback");
  assert.equal(Object.keys(res).includes("callback"), false, "callback is not part of the result's fields");
  assert.equal(await res.callback, "exit 0");

  const rec = JSON.parse(readFileSync(`${seen}.stdin`, "utf8"));
  assert.equal(rec.runId, res.runId);
  assert.equal(rec.exitCode, 0);
  assert.equal(rec.finalTextPreview, "done");
  assert.match(readFileSync(`${seen}.runs`, "utf8"), new RegExp(res.runId), "record saved before the callback");
  assert.equal(readFileSync(`${seen}.active`, "utf8").trim(), "inactive");

  const log = readFileSync(callbackLogPath(options.logsDir, "oc"), "utf8");
  assert.match(log, new RegExp(`run ${res.runId} \\(exit_code, exit 0\\)`));
  assert.match(log, /callback-said-hi\non-complete: exit 0\n$/);
});

test("on-complete: a failing or missing callback does not change the run's outcome", async () => {
  const { dir, options } = setup("oc2");
  const job = await createTick({ jobId: "oc2", prompt: "exit 3", cwd: dir, agent: "command",
    onComplete: script(dir, "cb.sh", "echo boom >&2; exit 7"), scheduleKind: "daily", scheduleOpts: { time: "09:00" } }, { stdout: quiet });
  const res: any = await runJob(job, "manual", options);
  assert.equal(res.exitCode, 3);
  assert.equal(await res.callback, "exit 7");
  assert.match(readFileSync(callbackLogPath(options.logsDir, "oc2"), "utf8"), /boom\non-complete: exit 7/);

  const missing: any = await runJob({ ...job, onComplete: join(dir, "nope") }, "manual", options);
  assert.equal(missing.exitCode, 3);
  assert.match(await missing.callback, /ENOENT/);
});

test("on-complete: jobs without one get a null callback and no log", async () => {
  const { dir, options } = setup("plain");
  const job = await createTick({ jobId: "plain", prompt: "true", cwd: dir, agent: "command",
    scheduleKind: "daily", scheduleOpts: { time: "09:00" } }, { stdout: quiet });
  const res: any = await runJob(job, "manual", options);
  assert.equal(await res.callback, null);
  assert.equal(existsSync(callbackLogPath(options.logsDir, "plain")), false);
});

test("on-complete: a callback that outlives the timeout is killed with its process group", async () => {
  const { dir, logsDir } = setup("slow");
  const child = join(dir, "grandchild.pid");
  const cb = script(dir, "cb.sh", `sleep 30 & echo $! > ${child}; wait`);
  const status = await runCallback({ id: "slow", cwd: dir, onComplete: cb }, { runId: "r1", reason: "exit_code", exitCode: 0 },
    { logsDir, stderr: quiet, timeoutMs: 300 });
  assert.equal(status, "timeout");
  const pid = Number(readFileSync(child, "utf8"));
  await new Promise((r) => setTimeout(r, 100));
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  // In containers without an init that reaps, a killed process can linger as
  // a zombie; check its state instead of bare existence.
  if (alive) {
    const stat = existsSync(`/proc/${pid}/stat`) ? readFileSync(`/proc/${pid}/stat`, "utf8") : "";
    alive = !/\) Z /.test(stat) && stat !== "";
  }
  assert.equal(alive, false, "grandchild killed");
  assert.match(readFileSync(callbackLogPath(logsDir, "slow"), "utf8"), /on-complete: timeout\n$/);
});

test("on-complete: callback logs are aged out by pruneLogs and removed on delete", () => {
  const { logsDir } = setup("prune");
  const p = callbackLogPath(logsDir, "prune");
  writeFileSync(p, "old\n");
  writeFileSync(`${p}.1`, "older\n");
  const old = new Date(Date.now() - 30 * 86400_000);
  utimesSync(p, old, old);
  utimesSync(`${p}.1`, old, old);
  pruneLogs("prune", logsDir, { stderr: quiet });
  assert.equal(existsSync(p), false);
  assert.equal(existsSync(`${p}.1`), false);

  writeFileSync(p, "fresh\n");
  cleanupJobArtifacts("prune", { stderr: quiet });
  assert.equal(existsSync(p), false);
});

test("on-complete: must be an absolute path", async () => {
  const { dir } = setup("v");
  const base = { prompt: "true", cwd: dir, scheduleKind: "daily", scheduleOpts: { time: "09:00" } };
  await assert.rejects(createTick({ ...base, jobId: "v1", onComplete: "notify.sh" }, { stdout: quiet }), /absolute path/);
});

test("on-complete: must exist and be executable at add time", async () => {
  const { dir } = setup("vx");
  const base = { prompt: "true", cwd: dir, scheduleKind: "daily", scheduleOpts: { time: "09:00" } };
  await assert.rejects(createTick({ ...base, jobId: "vx1", onComplete: join(dir, "missing.sh") }, { stdout: quiet }), /does not exist/);
  const noexec = join(dir, "noexec.sh");
  writeFileSync(noexec, "#!/bin/sh\n", { mode: 0o644 });
  await assert.rejects(createTick({ ...base, jobId: "vx2", onComplete: noexec }, { stdout: quiet }), /not executable/);
  await assert.rejects(createTick({ ...base, jobId: "vx3", onComplete: dir }, { stdout: quiet }), /not a file/);
  const ok = await createTick({ ...base, jobId: "vx4", onComplete: script(dir, "ok.sh", "true") }, { stdout: quiet });
  assert.equal(ok.onComplete, join(dir, "ok.sh"));
});

test("on-complete: a manual run says it is waiting for a slow callback; scheduler runs stay quiet", async () => {
  const slow = () => new Promise((r) => setTimeout(() => r("exit 0"), 60));
  const out: string[] = [];
  const stderr = { write(s: string) { out.push(s); return true; } };
  await waitForCallback(slow(), { manual: true, stderr, noticeDelayMs: 10 });
  assert.equal(out.length, 1);
  assert.match(out[0], /waiting for --on-complete/);
  out.length = 0;
  await waitForCallback(slow(), { manual: false, stderr, noticeDelayMs: 10 });
  await waitForCallback(Promise.resolve("exit 0"), { manual: true, stderr, noticeDelayMs: 10 });
  await waitForCallback(null, { manual: true, stderr });
  assert.deepEqual(out, []);
});
