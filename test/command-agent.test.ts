// ─── command agent ──────────────────────────────────────────────────────
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { agentAdapter } from "../extensions/tick/bin/agents/index.mjs";
import { mkdtempSync, readFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runJob } from "../extensions/tick/bin/runner.mjs";
import { createTick } from "../extensions/tick/bin/commands/add.mjs";
import { cmdShow } from "../extensions/tick/bin/commands/show.mjs";

const quiet = { write() { return true; } };

async function commandJob(id: string, prompt: string) {
  const dir = mkdtempSync(join(tmpdir(), "tick-command-"));
  process.env.PI_TICK_DATA_DIR = dir;
  const job = await createTick({ jobId: id, prompt, cwd: dir, agent: "command",
    scheduleKind: "interval", scheduleOpts: { minutes: "10" } }, { stdout: quiet });
  const options = { piPath: "/nonexistent/pi", transcriptsDir: join(dir, "runs"), logsDir: join(dir, "logs"), stderr: quiet };
  mkdirSync(options.logsDir, { recursive: true });
  return { dir, job, options };
}

test("command agent: runs the prompt with /bin/sh, no model, last stdout line is the summary", async () => {
  const { dir, job, options } = await commandJob("cmd", `echo "checking in $PWD"; echo '{"ok":true}'`);
  assert.equal(job.agent, "command");
  assert.equal(job.model, null);
  const ok = await runJob(job, "manual", options);
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.reason, "exit_code");
  const rec = JSON.parse(readFileSync(join(dir, "runs.jsonl"), "utf8").trim().split("\n").pop()!);
  assert.equal(rec.agent, "command");
  assert.equal(rec.model, null);
  assert.equal(ok.finalTextPreview, '{"ok":true}');
  assert.match(readFileSync(ok.transcriptPath, "utf8"), new RegExp(`checking in ${dir}`));

  const out: string[] = [];
  cmdShow(["cmd", "--no-meta"], { stdout: { write: (s: string) => { out.push(s); return true; } }, stderr: quiet });
  assert.equal(out.join(""), `checking in ${dir}\n{"ok":true}\n`);
});

test("command agent: a non-zero exit fails with the last stdout line when stderr is empty", async () => {
  const { job, options } = await commandJob("cmd-fail", `echo 'taskflow failed: not ours'; echo 'fetch failed'; exit 2`);
  const failed = await runJob(job, "manual", options);
  assert.equal(failed.exitCode, 2);
  assert.equal(failed.reason, "exit_code");
  assert.equal(failed.error, "fetch failed");
});

test("command agent: stdout mentioning a failed taskflow does not fail a clean exit", async () => {
  const { job, options } = await commandJob("cmd-tf", `echo 'taskflow failed'`);
  const r = await runJob(job, "manual", options);
  assert.equal(r.exitCode, 0);
  assert.equal(r.reason, "exit_code");
});

test("command agent: prompts starting with '-' are not rewritten (no pi argv guard)", () => {
  assert.deepEqual(agentAdapter("command").plan({ prompt: "-x" }, {}).args, ["-c", "-x"]);
});

test("command agent: rejects --model and unknown agents", async () => {
  process.env.PI_TICK_DATA_DIR = mkdtempSync(join(tmpdir(), "tick-command-model-"));
  const base = { prompt: "/bin/true", cwd: tmpdir(), scheduleKind: "daily", scheduleOpts: { time: "09:00" } };
  await assert.rejects(createTick({ ...base, jobId: "c1", agent: "command", model: "x" }, { stdout: quiet }), /take no --model/);
  await assert.rejects(createTick({ ...base, jobId: "c2", agent: "codex" }, { stdout: quiet }), /unknown agent: codex/);
});

test("pi jobs run with PWD set to the job's cwd", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tick-pwd-")));
  let env: any;
  await runJob({ id: "pwd", prompt: "hi", cwd: dir }, "manual", {
    piPath: "/usr/bin/pi", transcriptsDir: join(dir, "runs"), logsDir: join(dir, "logs"), stderr: quiet,
    spawnFn: (_bin: string, _args: string[], opts: any) => {
      env = opts.env;
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
      setTimeout(() => child.emit("close", 0, null), 5);
      return child;
    },
  });
  assert.equal(env.PWD, dir);
});
