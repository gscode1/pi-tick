// test/worktree.test.ts — `--isolate worktree` (issue #67). Real temporary git
// repositories; the agent is a `command` job whose prompt is a shell script.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, rmSync, realpathSync, chmodSync, readdirSync, utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runJob } from "../extensions/tick/bin/runner.mjs";
import { createTick, cmdAdd } from "../extensions/tick/bin/commands/add.mjs";
import { cmdShow } from "../extensions/tick/bin/commands/show.mjs";
import { cmdLog } from "../extensions/tick/bin/commands/log.mjs";
import { cmdDelete } from "../extensions/tick/bin/commands/delete.mjs";
import { cmdConfig } from "../extensions/tick/bin/commands/config.mjs";
import { cmdRun } from "../extensions/tick/bin/commands/run.mjs";
import { diagnoseJob } from "../extensions/tick/bin/commands/doctor.mjs";
import { loadCatalog, findJob, loadConfig } from "../extensions/tick/bin/catalog.mjs";
import { cleanupWorktreeLeftovers, worktreeRoot, listTickBranches } from "../extensions/tick/bin/worktree.mjs";
import { HELP } from "../extensions/tick/bin/commands/help.mjs";

const quiet = { write() { return true; } } as any;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function capture() {
  const out: string[] = [];
  return { stream: { write: (c: string | Uint8Array) => { out.push(String(c)); return true; } } as any, text: () => out.join("") };
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function gitOk(cwd: string, ...args: string[]): boolean {
  return spawnSync("git", args, { cwd, encoding: "utf8" }).status === 0;
}

function makeRepo(): string {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "tick-wt-repo-")));
  git(repo, "init", "-q");
  git(repo, "symbolic-ref", "HEAD", "refs/heads/main");
  git(repo, "config", "user.name", "Tester");
  git(repo, "config", "user.email", "tester@example.com");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "a.txt"), "one\n");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  mkdirSync(join(repo, "sub"));
  writeFileSync(join(repo, "sub", "b.txt"), "b\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}

function setup() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tick-wt-data-")));
  process.env.PI_TICK_DATA_DIR = dir;
  const repo = makeRepo();
  const logsDir = join(dir, "logs");
  mkdirSync(logsDir, { recursive: true });
  const options: any = { piPath: "/nonexistent/pi", transcriptsDir: join(dir, "runs"), logsDir, stderr: quiet };
  return { dir, repo, logsDir, options };
}

function runs(dir: string): any[] {
  const p = join(dir, "runs.jsonl");
  return existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

function add(repo: string, id: string, prompt: string, extra: Record<string, unknown> = {}) {
  return createTick({
    jobId: id, prompt, cwd: repo, agent: "command", isolate: "worktree", base: "main",
    scheduleKind: "interval", scheduleOpts: { minutes: "10" }, ...extra,
  }, { stdout: quiet });
}

function script(dir: string, name: string, body: string) {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return p;
}

const worktreesOf = (dir: string, id: string) => {
  const p = join(dir, "worktrees", id);
  return existsSync(p) ? readdirSync(p) : [];
};

// ─── run flow ───────────────────────────────────────────────────────────

test("isolate: changes end up on tick/<id>/<runId> with a commit and diffstat; the worktree is removed", async () => {
  const { dir, repo, options } = setup();
  const baseSha = git(repo, "rev-parse", "main");
  const job = await add(repo, "nightly", `echo two >> a.txt; echo new > new.txt; pwd -P > ${join(dir, "cwd.txt")}`);
  assert.equal(job.isolate, "worktree");
  assert.equal(job.base, "main");

  const res: any = await runJob(job, "manual", options);
  assert.equal(res.exitCode, 0);
  const branch = `tick/nightly/${res.runId}`;
  assert.equal(res.branch, branch);
  assert.deepEqual(res.diffstat, { filesChanged: 2, insertions: 2, deletions: 0 });

  const rec = runs(dir)[0];
  assert.equal(rec.isolate, "worktree");
  assert.equal(rec.baseRef, "main");
  assert.equal(rec.baseSha, baseSha);
  assert.equal(rec.branch, branch);
  assert.deepEqual(rec.diffstat, { filesChanged: 2, insertions: 2, deletions: 0 });
  assert.equal("worktreeError" in rec, false);
  assert.equal(findJob(loadCatalog(), "nightly").lastRun.branch, branch);

  // The agent ran in the worktree, which is gone now and was never the source checkout.
  const ranIn = readFileSync(join(dir, "cwd.txt"), "utf8").trim();
  assert.equal(ranIn, join(dir, "worktrees", "nightly", res.runId));
  assert.equal(existsSync(ranIn), false);
  assert.deepEqual(worktreesOf(dir, "nightly"), []);
  assert.equal(git(repo, "worktree", "list").split("\n").length, 1, "registration pruned");

  // One commit on top of the base, by pi-tick, holding exactly the changes.
  assert.equal(git(repo, "rev-parse", `${branch}~1`), baseSha);
  assert.equal(git(repo, "log", "-1", "--format=%an <%ae>|%s", branch), `pi-tick <pi-tick@localhost>|pi-tick: nightly run ${res.runId} (exit_code)`);
  assert.equal(git(repo, "show", `${branch}:new.txt`), "new");
  assert.equal(git(repo, "show", `${branch}:a.txt`), "one\ntwo");

  // The source checkout is untouched.
  assert.equal(git(repo, "status", "--porcelain"), "");
  assert.equal(existsSync(join(repo, "new.txt")), false);
  assert.equal(git(repo, "rev-parse", "main"), baseSha);
});

test("isolate: no changes means no branch (but the record still says what was isolated)", async () => {
  const { dir, repo, options } = setup();
  const job = await add(repo, "idle", `true`);
  const res: any = await runJob(job, "manual", options);
  assert.equal(res.exitCode, 0);
  assert.equal(res.branch, null);
  const rec = runs(dir)[0];
  assert.equal(rec.isolate, "worktree");
  assert.equal(rec.branch, null);
  assert.equal(rec.diffstat, null);
  assert.equal(rec.baseSha, git(repo, "rev-parse", "main"));
  assert.deepEqual(listTickBranches(repo, "idle"), []);
  assert.deepEqual(worktreesOf(dir, "idle"), []);
});

test("isolate: commits the agent made itself are kept (even with a clean tree)", async () => {
  const { dir, repo, options } = setup();
  const job = await add(repo, "committer",
    `echo x > made.txt; git add made.txt; git -c user.name=Agent -c user.email=agent@example.com commit -q -m 'agent commit'`);
  const res: any = await runJob(job, "manual", options);
  assert.equal(res.exitCode, 0);
  assert.equal(git(repo, "log", "-1", "--format=%an|%s", res.branch), "Agent|agent commit");
  assert.equal(git(repo, "rev-list", "--count", `main..${res.branch}`), "1", "no extra empty commit");
  assert.deepEqual(res.diffstat, { filesChanged: 1, insertions: 1, deletions: 0 });
});

test("isolate: the change set is committed with hooks off and no signing, whatever the user's config says", async () => {
  const { dir, repo, options } = setup();
  mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
  for (const h of ["pre-commit", "commit-msg", "post-commit", "post-checkout"]) {
    writeFileSync(join(repo, ".git", "hooks", h), `#!/bin/sh\ntouch ${join(dir, `hook-${h}`)}\nexit 1\n`, { mode: 0o755 });
  }
  git(repo, "config", "commit.gpgsign", "true");
  git(repo, "config", "gpg.program", "/nonexistent/gpg");
  const job = await add(repo, "hooks", `echo y > y.txt`);
  const res: any = await runJob(job, "manual", options);
  assert.equal(res.exitCode, 0);
  assert.ok(res.branch);
  assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith("hook-")), []);
});

test("isolate: a failing agent still gets a branch with its partial work", async () => {
  const { dir, repo, options } = setup();
  const job = await add(repo, "failing", `echo partial > partial.txt; echo boom >&2; exit 3`);
  const res: any = await runJob(job, "manual", options);
  assert.equal(res.exitCode, 3);
  assert.equal(res.reason, "exit_code");
  assert.equal(git(repo, "show", `${res.branch}:partial.txt`), "partial");
  assert.match(git(repo, "log", "-1", "--format=%s", res.branch), /\(exit_code\)$/);
  assert.equal(runs(dir)[0].branch, res.branch);
  assert.deepEqual(worktreesOf(dir, "failing"), []);
});

test("isolate: a timed-out agent still gets a branch with its partial work", async () => {
  const { dir, repo, options } = setup();
  const job = await add(repo, "slow", `echo partial > partial.txt; sleep 20`, { timeoutMs: 400, killGraceMs: 300 });
  const res: any = await runJob(job, "manual", options);
  assert.equal(res.reason, "timeout");
  assert.equal(git(repo, "show", `${res.branch}:partial.txt`), "partial");
  assert.match(git(repo, "log", "-1", "--format=%s", res.branch), /\(timeout\)$/);
  assert.deepEqual(worktreesOf(dir, "slow"), []);
});

test("isolate: SIGTERM to a standalone `pi-tick run` still finalizes (branch, record, worktree removed)", async () => {
  const { dir, repo } = setup();
  await add(repo, "term", `echo partial > partial.txt; sleep 30`, { killGraceMs: 300 });
  const cli = new URL("../extensions/tick/bin/pi-tick.mjs", import.meta.url).pathname;
  const proc = spawn(process.execPath, [cli, "run", "term", "--manual"], { env: { ...process.env, PI_TICK_DATA_DIR: dir }, stdio: "ignore" });
  const exited = new Promise<number | null>((res) => proc.on("exit", (c, s) => res(c ?? (s ? 128 : null))));
  const started = () => existsSync(join(dir, "worktrees", "term")) && readdirSync(join(dir, "worktrees", "term")).some((r) => existsSync(join(dir, "worktrees", "term", r, "partial.txt")));
  for (let i = 0; i < 300 && !started(); i++) await sleep(50); // a loaded machine may start the runner slowly
  assert.ok(started(), "the agent started in its worktree");
  proc.kill("SIGTERM");
  const code = await Promise.race([exited, sleep(20_000).then(() => "hang")]);
  assert.equal(code, 143);
  const rec = runs(dir).filter((r) => r.jobId === "term").pop();
  assert.equal(rec.reason, "terminated");
  assert.equal(git(repo, "show", `${rec.branch}:partial.txt`), "partial");
  assert.deepEqual(worktreesOf(dir, "term"), []);
});

test("isolate: SIGTERM during --setup exits 143, records setup_failed, removes the worktree and never starts the agent", async () => {
  const { dir, repo } = setup();
  const ready = join(dir, "setup-ready");
  await add(repo, "termsetup", `touch ${join(dir, "agent-ran")}`, { setup: `touch ${ready}; sleep 30` });
  const cli = new URL("../extensions/tick/bin/pi-tick.mjs", import.meta.url).pathname;
  const proc = spawn(process.execPath, [cli, "run", "termsetup", "--manual"], { env: { ...process.env, PI_TICK_DATA_DIR: dir }, stdio: "ignore" });
  const exited = new Promise<number | null>((res) => proc.on("exit", (c, s) => res(c ?? (s ? 128 : null))));
  for (let i = 0; i < 300 && !existsSync(ready); i++) await sleep(50);
  assert.ok(existsSync(ready), "setup started");
  proc.kill("SIGTERM");
  assert.equal(await Promise.race([exited, sleep(20_000).then(() => "hang")]), 143);
  const rec = runs(dir).filter((r) => r.jobId === "termsetup").pop();
  assert.equal(rec.reason, "setup_failed");
  assert.equal(rec.error, "setup terminated");
  assert.equal(existsSync(join(dir, "agent-ran")), false);
  assert.deepEqual(worktreesOf(dir, "termsetup"), []);
  assert.equal(existsSync(join(dir, "active", "termsetup.json")), false);
});

test("isolate: a guard skip creates no worktree; a guard that passes runs first, in the job's cwd", async () => {
  const { dir, repo, options } = setup();
  const skip = await add(repo, "skipper", `touch ran`, { when: "exit 1" });
  const res: any = await runJob(skip, "manual", options);
  assert.equal(res.reason, "skipped");
  assert.equal(existsSync(join(dir, "worktrees")), false, "no worktree root was even created");
  assert.equal(runs(dir)[0].isolate, undefined);
  assert.equal(git(repo, "worktree", "list").split("\n").length, 1);

  const guardCwd = join(dir, "guard-cwd.txt");
  const pass = await add(repo, "passer", `echo hi > from-agent.txt`, { when: `pwd -P > ${guardCwd}` });
  const ok: any = await runJob(pass, "manual", options);
  assert.equal(readFileSync(guardCwd, "utf8").trim(), repo, "guard ran in job.cwd");
  assert.ok(ok.branch);
});

test("isolate: an unresolvable base records worktree_failed and never spawns the agent", async () => {
  const { dir, repo, options } = setup();
  git(repo, "branch", "release");
  const job = await add(repo, "nobase", `touch ${join(dir, "agent-ran")}`, { base: "release" });
  git(repo, "branch", "-D", "release");
  const res: any = await runJob(job, "manual", options);
  assert.equal(res.exitCode, 1);
  assert.equal(res.reason, "worktree_failed");
  assert.match(res.error, /cannot resolve --base 'release'/);
  assert.equal(existsSync(join(dir, "agent-ran")), false);
  const rec = runs(dir)[0];
  assert.equal(rec.reason, "worktree_failed");
  assert.equal(rec.isolate, "worktree");
  assert.equal(rec.baseRef, "release");
  assert.equal(rec.baseSha, null);
  assert.equal(rec.branch, null);
  assert.equal(findJob(loadCatalog(), "nobase").lastRun.reason, "worktree_failed");
});

test("isolate: a worktree that cannot be created records worktree_failed", async () => {
  const { dir, repo, options } = setup();
  const blocker = join(dir, "blocker");
  writeFileSync(blocker, "a file where the root should be");
  const job = await add(repo, "blocked", `touch ${join(dir, "agent-ran")}`, { worktreeDir: join(blocker, "root") });
  const res: any = await runJob(job, "manual", options);
  assert.equal(res.reason, "worktree_failed");
  assert.match(res.error, /cannot create worktree root/);
  assert.equal(existsSync(join(dir, "agent-ran")), false);
});

test("isolate: --setup runs in the worktree with the isolation env; a failing or slow setup records setup_failed", async () => {
  const { dir, repo, options } = setup();
  writeFileSync(join(repo, ".env"), "SECRET=1\n"); // untracked in the source checkout
  const out = join(dir, "setup-out.txt");
  const job = await add(repo, "setupok",
    `printf '%s|%s|%s' "$PWD" "$PI_TICK_WORKTREE" "$PI_TICK_SOURCE_CWD" > ${join(dir, "agent-env.txt")}; echo done > work.txt`,
    { setup: `pwd -P > ${out}; cp "$PI_TICK_SOURCE_CWD/.env" .env; mkdir node_modules; echo dep > node_modules/dep.js; mkdir -p cache; echo c > cache/c.bin; printf '%s' "$PI_TICK_WORKTREE" > ${out}.wt` });
  const res: any = await runJob(job, "manual", options);
  assert.equal(res.exitCode, 0);
  const wt = join(dir, "worktrees", "setupok", res.runId);
  assert.equal(readFileSync(out, "utf8").trim(), wt, "setup ran in the worktree");
  assert.equal(readFileSync(`${out}.wt`, "utf8"), wt);
  assert.equal(readFileSync(join(dir, "agent-env.txt"), "utf8"), `${wt}|${wt}|${repo}`);
  // What setup produced (an untracked .env, a non-ignored cache dir) is not part of the run's commit.
  const files = git(repo, "ls-tree", "-r", "--name-only", res.branch).split("\n");
  assert.deepEqual(files.filter((f) => f.includes("work.txt") || f.includes(".env") || f.includes("cache") || f.includes("node_modules")), ["work.txt"]);

  const failing = await add(repo, "setupfail", `touch ${join(dir, "agent-ran")}`, { setup: "echo 'npm ERR! nope' >&2; touch marker; exit 4" });
  const bad: any = await runJob(failing, "manual", options);
  assert.equal(bad.reason, "setup_failed");
  assert.equal(bad.exitCode, 1);
  assert.equal(bad.error, "setup exit 4: npm ERR! nope");
  assert.equal(existsSync(join(dir, "agent-ran")), false, "agent not spawned");
  assert.deepEqual(worktreesOf(dir, "setupfail"), [], "worktree removed");
  assert.deepEqual(listTickBranches(repo, "setupfail"), []);
  const rec = runs(dir).filter((r) => r.jobId === "setupfail")[0];
  assert.equal(rec.reason, "setup_failed");
  assert.equal(rec.baseSha, git(repo, "rev-parse", "main"));

  const slow = await add(repo, "setupslow", `touch ${join(dir, "agent-ran")}`, { setup: "sleep 20", setupTimeout: 1 });
  const t0 = Date.now();
  const timedOut: any = await runJob(slow, "manual", options);
  assert.ok(Date.now() - t0 < 8000);
  assert.equal(timedOut.reason, "setup_failed");
  assert.match(timedOut.error, /^setup timed out after 1s/);
  assert.equal(existsSync(join(dir, "agent-ran")), false);
});

test("isolate: a job inside a subdirectory runs in the same subdirectory of the worktree", async () => {
  const { dir, repo, options } = setup();
  const job = await createTick({ jobId: "subdir", prompt: `pwd -P > ${join(dir, "p.txt")}; echo z > z.txt`, cwd: join(repo, "sub"), agent: "command",
    isolate: "worktree", base: "main", scheduleKind: "interval", scheduleOpts: { minutes: "10" } }, { stdout: quiet });
  const res: any = await runJob(job, "manual", options);
  assert.equal(readFileSync(join(dir, "p.txt"), "utf8").trim(), join(dir, "worktrees", "subdir", res.runId, "sub"));
  assert.equal(git(repo, "show", `${res.branch}:sub/z.txt`), "z");
});

test("isolate: the worktree is cut from --base's commit, not from whatever the checkout has", async () => {
  const { dir, repo, options } = setup();
  const job = await add(repo, "frombase", `cat a.txt > ${join(dir, "seen.txt")}`);
  writeFileSync(join(repo, "a.txt"), "dirty\n"); // uncommitted in the source checkout
  git(repo, "checkout", "-q", "-b", "other");
  const res: any = await runJob(job, "manual", options);
  assert.equal(readFileSync(join(dir, "seen.txt"), "utf8"), "one\n");
  assert.equal(res.branch, null);
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "dirty\n");
});

// ─── roots ──────────────────────────────────────────────────────────────

test("worktree root: job --worktree-dir > config worktree-dir > <dataDir>/worktrees, plus <id>/<runId>", async () => {
  const { dir, repo, options } = setup();
  const jobRoot = join(dir, "job-root");
  const cfgRoot = join(dir, "cfg-root");
  const prompt = `pwd -P > ${join(dir, "where.txt")}`;
  const where = () => readFileSync(join(dir, "where.txt"), "utf8").trim();

  const plain = await add(repo, "r-default", prompt);
  const r1: any = await runJob(plain, "manual", options);
  assert.equal(where(), join(dir, "worktrees", "r-default", r1.runId));

  const r2: any = await runJob(plain, "manual", { ...options, worktreeDir: cfgRoot });
  assert.equal(where(), join(cfgRoot, "r-default", r2.runId));

  const own = await add(repo, "r-job", prompt, { worktreeDir: jobRoot });
  const r3: any = await runJob(own, "manual", { ...options, worktreeDir: cfgRoot });
  assert.equal(where(), join(jobRoot, "r-job", r3.runId));

  assert.equal(worktreeRoot({}, null), join(dir, "worktrees"));
  assert.equal(worktreeRoot({}, "/c"), "/c");
  assert.equal(worktreeRoot({ worktreeDir: "/j" }, "/c"), "/j");

  // The default follows PI_TICK_DATA_DIR.
  const other = realpathSync(mkdtempSync(join(tmpdir(), "tick-wt-data2-")));
  process.env.PI_TICK_DATA_DIR = other;
  mkdirSync(join(other, "logs"), { recursive: true });
  const r4: any = await runJob(plain, "manual", { ...options, transcriptsDir: join(other, "runs"), logsDir: join(other, "logs") });
  assert.equal(where(), join(other, "worktrees", "r-default", r4.runId));
});

test("worktree root: `pi-tick run` reads the config's worktree-dir", async () => {
  const { dir, repo } = setup();
  const cfgRoot = join(dir, "cfg-root");
  cmdConfig(["set", "worktree-dir", cfgRoot], { stdout: quiet, stderr: quiet });
  await add(repo, "viarun", `pwd -P > ${join(dir, "where.txt")}`);
  assert.equal(await cmdRun(["viarun", "--manual"], { stdout: quiet, stderr: quiet }), 0);
  assert.match(readFileSync(join(dir, "where.txt"), "utf8").trim(), new RegExp(`^${cfgRoot}/viarun/[0-9a-f]{8}$`));
});

test("config worktree-dir: absolute only; get/unset work", () => {
  const { dir } = setup();
  const out = capture();
  assert.throws(() => cmdConfig(["set", "worktree-dir", "relative/dir"], { stdout: quiet, stderr: quiet }), /must be an absolute path/);
  assert.equal(cmdConfig(["set", "worktree-dir", `${dir}/wt/`], { stdout: out.stream, stderr: quiet }), 0);
  assert.equal(out.text(), `worktree-dir=${dir}/wt\n`);
  assert.equal(loadConfig({ stderr: quiet }).worktreeDir, `${dir}/wt`);
  const got = capture();
  cmdConfig(["get", "worktree-dir"], { stdout: got.stream, stderr: quiet });
  assert.equal(got.text(), `${dir}/wt\n`);
  cmdConfig(["unset", "worktree-dir"], { stdout: quiet, stderr: quiet });
  assert.equal(loadConfig({ stderr: quiet }).worktreeDir, null);
  // default-model is untouched by it.
  cmdConfig(["set", "default-model", "m1"], { stdout: quiet, stderr: quiet });
  cmdConfig(["set", "worktree-dir", dir], { stdout: quiet, stderr: quiet });
  assert.equal(loadConfig({ stderr: quiet }).defaultModel, "m1");
});

// ─── add validation ─────────────────────────────────────────────────────

test("add: --isolate validation", async () => {
  const { dir, repo } = setup();
  const base = ["--prompt", "p", "--cwd", repo, "--kind", "interval", "--minutes", "5"];
  const run = (id: string, ...extra: string[]) => cmdAdd([id, ...base, ...extra], { stdout: quiet, stderr: quiet });

  assert.equal(await run("ok1", "--isolate", "worktree", "--base", "main"), 0);
  const ok1 = findJob(loadCatalog(), "ok1");
  assert.deepEqual([ok1.isolate, ok1.base, "worktreeDir" in ok1, "setup" in ok1, "setupTimeout" in ok1], ["worktree", "main", false, false, false]);

  assert.equal(await run("ok2", "--isolate", "worktree", "--base", "main", "--worktree-dir", join(dir, "roots"), "--setup", "npm ci", "--setup-timeout", "90"), 0);
  const ok2 = findJob(loadCatalog(), "ok2");
  assert.deepEqual([ok2.worktreeDir, ok2.setup, ok2.setupTimeout], [join(dir, "roots"), "npm ci", 90]);
  git(repo, "tag", "v1");
  assert.equal(await run("ok3", "--isolate", "worktree", "--base", "v1"), 0);
  assert.equal(await run("ok4", "--isolate", "worktree", "--base", git(repo, "rev-parse", "HEAD")), 0);

  await assert.rejects(run("e1", "--isolate", "worktree"), /requires --base/);
  await assert.rejects(run("e2", "--isolate", "docker", "--base", "main"), /--isolate must be 'worktree'/);
  await assert.rejects(run("e3", "--isolate"), /--isolate requires a value/);
  await assert.rejects(run("e4", "--base", "main"), /--base requires --isolate worktree/);
  await assert.rejects(run("e5", "--worktree-dir", "/x"), /--worktree-dir requires --isolate worktree/);
  await assert.rejects(run("e6", "--setup", "true"), /--setup requires --isolate worktree/);
  await assert.rejects(run("e7", "--isolate", "worktree", "--base", "nope"), /--base 'nope' does not resolve/);
  await assert.rejects(run("e8", "--isolate", "worktree", "--base", "main", "--worktree-dir", "rel/dir"), /--worktree-dir must be an absolute path/);
  await assert.rejects(run("e9", "--isolate", "worktree", "--base", "main", "--setup-timeout", "5"), /--setup-timeout requires --setup/);
  for (const bad of ["0", "-1", "1.5", "abc"]) {
    await assert.rejects(run("e10", "--isolate", "worktree", "--base", "main", "--setup", "true", `--setup-timeout=${bad}`), /--setup-timeout must be/, bad);
  }
  await assert.rejects(run("e11", "--isolate", "worktree", "--base", "main", "--setup", "  "), /--setup requires a non-empty value/);
  await assert.rejects(run("e12", "--isolate", "worktree", "--base=--output=x"), /--base must be a git ref/);
  await assert.rejects(run("a..b", "--isolate", "worktree", "--base", "main"), /cannot be part of a git branch name/);
  assert.equal(findJob(loadCatalog(), "e7"), null);

  const notGit = realpathSync(mkdtempSync(join(tmpdir(), "tick-wt-nogit-")));
  await assert.rejects(
    cmdAdd(["e13", "--prompt", "p", "--cwd", notGit, "--kind", "interval", "--minutes", "5", "--isolate", "worktree", "--base", "main"], { stdout: quiet, stderr: quiet }),
    /cwd is not inside a git work tree/,
  );
  // Without --isolate nothing git-related is checked.
  assert.equal(await cmdAdd(["plain", "--prompt", "p", "--cwd", notGit, "--kind", "interval", "--minutes", "5"], { stdout: quiet, stderr: quiet }), 0);
});

test("add: tick_create's typed params cannot isolate (CLI-only)", async () => {
  const src = readFileSync(new URL("../extensions/tick/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /isolate|worktree/i);
});

// ─── on-complete ────────────────────────────────────────────────────────

test("on-complete: receives branch and diffstat in the record on stdin, and the isolation env", async () => {
  const { dir, repo, options } = setup();
  const seen = join(dir, "cb");
  const cb = script(dir, "cb.sh", [
    `cat > ${seen}.stdin`,
    `printf '%s|%s|%s' "$PI_TICK_SOURCE_CWD" "$PI_TICK_WORKTREE" "$PWD" > ${seen}.env`,
    `git -C "$PI_TICK_SOURCE_CWD" rev-parse --verify "$(sed 's/.*"branch":"\\([^"]*\\)".*/\\1/' ${seen}.stdin)" > ${seen}.rev`,
  ].join("\n"));
  const job = await add(repo, "hook", `echo hi > hi.txt`, { onComplete: cb });
  const res: any = await runJob(job, "manual", options);
  assert.equal(await res.callback, "exit 0");
  const rec = JSON.parse(readFileSync(`${seen}.stdin`, "utf8"));
  assert.equal(rec.branch, `tick/hook/${res.runId}`);
  assert.deepEqual(rec.diffstat, { filesChanged: 1, insertions: 1, deletions: 0 });
  assert.equal(rec.baseSha, git(repo, "rev-parse", "main"));
  assert.equal(rec.isolate, "worktree");
  assert.equal(readFileSync(`${seen}.env`, "utf8"), `${repo}|${join(dir, "worktrees", "hook", res.runId)}|${repo}`);
  assert.equal(readFileSync(`${seen}.rev`, "utf8").trim(), git(repo, "rev-parse", rec.branch));
});

test("on-complete: also runs for worktree_failed and setup_failed", async () => {
  const { dir, repo, options } = setup();
  const seen = join(dir, "cbf.stdin");
  const cb = script(dir, "cbf.sh", `cat >> ${seen}`);
  const job = await add(repo, "hookfail", `true`, { onComplete: cb, setup: "exit 2" });
  const res: any = await runJob(job, "manual", options);
  assert.equal(await res.callback, "exit 0");
  assert.equal(JSON.parse(readFileSync(seen, "utf8")).reason, "setup_failed");
});

// ─── show, log ──────────────────────────────────────────────────────────

test("show --diff prints the diff of the latest run with a branch (--run-id picks one); show prints the isolation settings", async () => {
  const { dir, repo, options } = setup();
  const job = await add(repo, "diffy", `echo "line $$" > r.txt`, { setup: "true", setupTimeout: 45 });
  const none = capture();
  assert.equal(cmdShow(["diffy", "--diff"], { stdout: none.stream, stderr: quiet }), 0);
  assert.match(none.text(), /no run of job 'diffy' has produced a branch yet/);

  const first: any = await runJob(job, "manual", options);
  await sleep(5);
  const second: any = await runJob(job, "manual", options);
  const latest = capture();
  const info = capture();
  cmdShow(["diffy", "--diff"], { stdout: latest.stream, stderr: info.stream });
  assert.match(latest.text(), /^diff --git a\/r\.txt b\/r\.txt\nnew file mode/);
  assert.equal(latest.text(), git(repo, "diff", `${git(repo, "rev-parse", "main")}..${second.branch}`) + "\n");
  assert.match(info.text(), new RegExp(`run ${second.runId}: ${second.branch} \\(base main`));

  const picked = capture();
  cmdShow(["diffy", "--diff", "--run-id", first.runId], { stdout: picked.stream, stderr: quiet });
  assert.equal(picked.text(), git(repo, "diff", `${git(repo, "rev-parse", "main")}..${first.branch}`) + "\n");
  assert.throws(() => cmdShow(["diffy", "--diff", "--run-id", "deadbeef"], { stdout: quiet, stderr: quiet }), /no run 'deadbeef'/);
  assert.throws(() => cmdShow(["nojob", "--diff"], { stdout: quiet, stderr: quiet }), /no such job/);

  git(repo, "branch", "-D", second.branch);
  assert.throws(() => cmdShow(["diffy", "--diff"], { stdout: quiet, stderr: quiet }), /cannot diff/);

  const meta = capture();
  cmdShow(["diffy"], { stdout: meta.stream, stderr: quiet });
  assert.match(meta.text(), new RegExp(`isolation: worktree \\(base main\\), root ${join(dir, "worktrees")}, setup 'true' \\(timeout 45s\\)`));

  const idle = await add(repo, "diffidle", `true`);
  await runJob(idle, "manual", options);
  const noBranch = capture();
  cmdShow(["diffidle", "--diff"], { stdout: noBranch.stream, stderr: quiet });
  assert.match(noBranch.text(), /no run of job 'diffidle' has produced a branch/);
  const plain = await createTick({ jobId: "plainjob", prompt: "true", cwd: repo, agent: "command", scheduleKind: "interval", scheduleOpts: { minutes: "5" } }, { stdout: quiet });
  const notIso = capture();
  cmdShow([plain.id, "--diff"], { stdout: notIso.stream, stderr: quiet });
  assert.match(notIso.text(), /not worktree-isolated/);
});

test("log shows the branch (with diffstat) only when a shown run has one", async () => {
  const { dir, repo, options } = setup();
  const idle = await add(repo, "logidle", `true`);
  await runJob(idle, "manual", options);
  const before = capture();
  cmdLog(["logidle"], { stdout: before.stream, stderr: quiet });
  assert.doesNotMatch(before.text(), /branch/);

  const busy = await add(repo, "logbusy", `echo a > a1.txt; echo b > b1.txt`);
  const res: any = await runJob(busy, "manual", options);
  const after = capture();
  cmdLog(["logbusy"], { stdout: after.stream, stderr: quiet });
  assert.match(after.text(), /tokens\s+branch\s+transcript\s+error/);
  assert.ok(after.text().includes(`${res.branch} (2f +2 -0)`));
});

// ─── doctor ─────────────────────────────────────────────────────────────

test("doctor: flags isolated jobs whose cwd is not a repo, base is gone, or configured root is missing/unwritable; reports worktree_failed/setup_failed", async () => {
  const { dir, repo } = setup();
  const now = new Date();
  const job = (over: Record<string, unknown> = {}) => ({
    id: "d", prompt: "p", cwd: repo, schedule: { kind: "daily", value: { time: "09:00" } }, enabled: true,
    nodePath: process.execPath, agent: "command", isolate: "worktree", base: "main",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    registration: { backend: "fake", fingerprint: "abc", registeredAt: new Date(now.getTime() - 3 * 86400_000).toISOString() },
    lastRun: { startedAt: new Date(now.getTime() - 60_000).toISOString(), finishedAt: now.toISOString(), exitCode: 0 },
    ...over,
  });
  const backend = { name: "fake", status: (_id: string) => ({ registered: true, loaded: true, fingerprint: "abc", paths: { nodePath: process.execPath, cliPath: process.execPath, cwd: repo } }) };
  const codes = (j: any, config: any = { worktreeDir: null }) => diagnoseJob(j, { backend, now, running: false, config }).problems.map((p: any) => p.code).sort();

  assert.deepEqual(codes(job()), [], "healthy; the default root under dataDir need not exist");
  assert.equal(existsSync(join(dir, "worktrees")), false);

  const notGit = realpathSync(mkdtempSync(join(tmpdir(), "tick-wt-nogit-")));
  const bs = { name: "fake", status: () => ({ registered: true, loaded: true, fingerprint: "abc", paths: { nodePath: process.execPath, cliPath: process.execPath, cwd: notGit } }) };
  assert.deepEqual(diagnoseJob(job({ cwd: notGit }), { backend: bs, now, running: false, config: {} }).problems.map((p: any) => p.code), ["isolate-not-git"]);

  assert.deepEqual(codes(job({ base: "gone" })), ["isolate-base-missing"]);

  assert.deepEqual(codes(job({ worktreeDir: join(dir, "missing-root") })), ["isolate-root-missing"]);
  assert.deepEqual(codes(job(), { worktreeDir: join(dir, "missing-cfg-root") }), ["isolate-root-missing"]);
  const ro = join(dir, "ro-root");
  mkdirSync(ro);
  assert.deepEqual(codes(job({ worktreeDir: ro })), []);
  if (process.getuid && process.getuid() !== 0) {
    chmodSync(ro, 0o500);
    assert.deepEqual(codes(job({ worktreeDir: ro })), ["isolate-root-unwritable"]);
    chmodSync(ro, 0o700);
  }

  const last = (reason: string, error: string) => ({ startedAt: new Date(now.getTime() - 60_000).toISOString(), finishedAt: now.toISOString(), exitCode: 1, reason, error });
  const wf = diagnoseJob(job({ lastRun: last("worktree_failed", "git worktree add failed: boom") }), { backend, now, running: false, config: {} });
  assert.equal(wf.status, "failing");
  assert.deepEqual(wf.problems.map((p: any) => p.code), ["worktree-failed"]);
  assert.match(wf.problems[0].message, /boom/);
  const sf = diagnoseJob(job({ lastRun: last("setup_failed", "setup exit 4: npm ERR!") }), { backend, now, running: false, config: {} });
  assert.deepEqual(sf.problems.map((p: any) => p.code), ["setup-failed"]);
  assert.equal(sf.status, "failing");

  // Non-isolated jobs are not checked.
  assert.deepEqual(codes(job({ isolate: undefined, base: "gone", cwd: repo })), []);
});

// ─── delete, retention ──────────────────────────────────────────────────

test("delete: keeps tick/* branches (and says how to remove them) and cleans leftover worktree dirs", async () => {
  const { dir, repo, options } = setup();
  const cfgRoot = join(dir, "cfg-root");
  const job = await add(repo, "gone", `echo x > x.txt`);
  const res: any = await runJob(job, "manual", options);
  assert.ok(res.branch);

  // Leftovers of a crashed run, under the default and the configured root; plus things that are not ours.
  const fakeWorktree = (root: string, name: string) => {
    mkdirSync(join(root, "gone", name), { recursive: true });
    writeFileSync(join(root, "gone", name, ".git"), "gitdir: /nonexistent\n");
    writeFileSync(join(root, "gone", name, "file"), "x");
  };
  fakeWorktree(join(dir, "worktrees"), "deadbeef");
  fakeWorktree(cfgRoot, "cafebabe");
  mkdirSync(join(cfgRoot, "gone", "my-notes"), { recursive: true }); // not a run dir
  mkdirSync(join(cfgRoot, "gone", "0badc0de", ".git"), { recursive: true }); // .git is a directory: a real repo
  cmdConfig(["set", "worktree-dir", cfgRoot], { stdout: quiet, stderr: quiet });

  const out = capture();
  assert.equal(await cmdDelete(["gone"], { stdout: out.stream, stderr: quiet }), 0);
  assert.equal(findJob(loadCatalog(), "gone"), null);
  assert.equal(existsSync(join(dir, "worktrees", "gone")), false);
  assert.equal(existsSync(join(cfgRoot, "gone", "cafebabe")), false);
  assert.ok(existsSync(join(cfgRoot, "gone", "my-notes")), "foreign dir kept");
  assert.ok(existsSync(join(cfgRoot, "gone", "0badc0de", ".git")), "a real repo is never removed");
  assert.deepEqual(listTickBranches(repo, "gone"), [res.branch], "branch kept");
  assert.match(out.text(), /deleted job 'gone'/);
  assert.match(out.text(), /kept 1 branch\(es\) tick\/gone\/\*/);
  assert.ok(out.text().includes(`git -C '${repo}' for-each-ref --format='%(refname:short)' refs/heads/tick/gone/ | xargs git -C '${repo}' branch -D`));

  // A job without branches prints no hint.
  const clean = await add(repo, "gone2", `true`);
  await runJob(clean, "manual", options);
  const out2 = capture();
  await cmdDelete(["gone2"], { stdout: out2.stream, stderr: quiet });
  assert.doesNotMatch(out2.text(), /kept/);
});

test("retention: a finished run sweeps stale leftover dirs only; branches are never pruned", async () => {
  const { dir, repo, options } = setup();
  const job = await add(repo, "keeper", `echo x > x.txt`);
  const leftover = (name: string, ageDays: number) => {
    const p = join(dir, "worktrees", "keeper", name);
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, ".git"), "gitdir: /nonexistent\n");
    const t = new Date(Date.now() - ageDays * 86400_000);
    utimesSync(p, t, t);
  };
  leftover("01d01d01", 10);
  leftover("0e0e0e0e", 1);
  const first: any = await runJob(job, "manual", options); // first run: lastPrunedAt unset, so it prunes
  assert.deepEqual(worktreesOf(dir, "keeper"), ["0e0e0e0e"]);
  assert.deepEqual(listTickBranches(repo, "keeper"), [first.branch]);
  assert.equal(cleanupWorktreeLeftovers(job, [join(dir, "worktrees")], { olderThanMs: 0, now: Date.now() + 1000 }), 1);
  assert.deepEqual(worktreesOf(dir, "keeper"), []);
});
