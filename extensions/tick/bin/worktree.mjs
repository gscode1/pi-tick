// worktree.mjs — `--isolate worktree`: each run of an opted-in job gets a
// fresh detached git worktree of `--base`, the agent runs there, and whatever
// it changed ends up on a branch `tick/<jobId>/<runId>` (no changes, no
// branch). The worktree is removed right after the run; branches are never
// deleted by pi-tick.
//
// Pieces:
//   - git helpers (async for the runner, sync for add/doctor/show/delete);
//   - root resolution: job --worktree-dir > config worktree-dir >
//     <dataDir>/worktrees, always with `<jobId>/<runId>` appended;
//   - createWorktree / finalizeWorktree / removeWorktree, used by runner.mjs;
//   - leftover cleanup (crashed runs) for retention and `delete`.
//
// CLI-only (`pi-tick add --isolate`): the tick_create tool has no field for it.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, rmdirSync, readdirSync, statSync, lstatSync } from "node:fs";
import { join, dirname } from "node:path";
import { dataDir } from "./paths.mjs";

export const ISOLATE_WORKTREE = "worktree";
export const SETUP_DEFAULT_TIMEOUT_S = 300;
export const GIT_TIMEOUT_MS = 5 * 60 * 1000;
const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const RUN_ID_DIR_RE = /^[0-9a-f]{8}$/;
export const WORKTREE_RETENTION_DAYS = 7;

// Never let a git hook, an inherited repository location or a prompt change
// what a pi-tick git call does.
export function gitEnv(base = process.env) {
  const env = { ...base, GIT_TERMINAL_PROMPT: "0" };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX", "GIT_OBJECT_DIRECTORY", "GIT_NAMESPACE"]) delete env[k];
  return env;
}

// Hooks (post-checkout, post-commit, ...) belong to the user's interactive
// workflow, not to unattended runs.
const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"];

function lastMeaningfulLine(text) {
  const lines = String(text ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : "";
}

function gitMessage(args, status, stderr, err) {
  if (err) return err.code === "ENOENT" ? "git not found" : err.message;
  return `git ${args[0]} failed (exit ${status})${stderr ? `: ${lastMeaningfulLine(stderr)}` : ""}`;
}

// → { ok, status, stdout, stderr, message }
export function gitSync(args, { cwd, input, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  const r = spawnSync("git", args, {
    cwd, env: gitEnv(), input, encoding: "utf8", maxBuffer: GIT_MAX_BUFFER, timeout: timeoutMs,
  });
  const status = typeof r.status === "number" ? r.status : null;
  return {
    ok: status === 0 && !r.error, status, stdout: r.stdout ?? "", stderr: r.stderr ?? "",
    message: gitMessage(args, status, r.stderr, r.error),
  };
}

export function gitAsync(args, { cwd, input, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    let out = "";
    let err = "";
    let done = false;
    const finish = (status, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: status === 0 && !error, status, stdout: out, stderr: err, message: gitMessage(args, status, err, error) });
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      finish(null, new Error(`git ${args[0]} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    try {
      child = spawn("git", args, { cwd, env: gitEnv(), stdio: [input !== undefined ? "pipe" : "ignore", "pipe", "pipe"] });
    } catch (e) {
      finish(null, e);
      return;
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => { if (out.length < GIT_MAX_BUFFER) out += c; });
    child.stderr.on("data", (c) => { err = (err + c).slice(-16384); });
    child.on("error", (e) => finish(null, e));
    child.on("close", (code) => finish(code, null));
    if (input !== undefined) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });
}

// ─── checks (add, doctor, show) ─────────────────────────────────────────
export function isGitWorkTree(cwd) {
  const r = gitSync(["rev-parse", "--is-inside-work-tree"], { cwd, timeoutMs: 30_000 });
  return r.ok && r.stdout.trim() === "true";
}

// The commit sha `ref` resolves to in `cwd`, or null.
export function resolveCommitSync(cwd, ref) {
  if (typeof ref !== "string" || ref === "" || ref.startsWith("-")) return null;
  const r = gitSync(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd, timeoutMs: 30_000 });
  const sha = r.stdout.trim();
  return r.ok && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

export function branchNameFor(jobId, runId) {
  return `tick/${jobId}/${runId}`;
}

// True when `tick/<jobId>/<runId>` is a legal ref name (ids such as `a..b` or
// `x.lock` are legal job ids but not legal branch components).
export function branchNameIsValid(jobId) {
  const r = gitSync(["check-ref-format", `refs/heads/${branchNameFor(jobId, "00000000")}`], { timeoutMs: 30_000 });
  return r.ok;
}

// `tick/<jobId>/*` branches present in `cwd`'s repository.
export function listTickBranches(cwd, jobId) {
  const r = gitSync(["for-each-ref", "--format=%(refname:short)", `refs/heads/tick/${jobId}/`], { cwd, timeoutMs: 30_000 });
  return r.ok ? r.stdout.split("\n").map((l) => l.trim()).filter(Boolean) : [];
}

// ─── roots ──────────────────────────────────────────────────────────────
export function defaultWorktreeRoot() {
  return join(dataDir(), "worktrees");
}

// job --worktree-dir > config worktree-dir > <dataDir>/worktrees
export function worktreeRoot(job, configRoot) {
  return job.worktreeDir || configRoot || defaultWorktreeRoot();
}

// Every root a job's runs may have used (the config may have changed since).
export function worktreeRootCandidates(job, configRoot) {
  return [...new Set([job.worktreeDir, configRoot, defaultWorktreeRoot()].filter(Boolean))];
}

export function setupTimeoutSeconds(job) {
  return Number.isInteger(job.setupTimeout) && job.setupTimeout > 0 ? job.setupTimeout : SETUP_DEFAULT_TIMEOUT_S;
}

// ─── create / finalize / remove ─────────────────────────────────────────
// → { ok: true, dir, cwd, baseSha } | { ok: false, error, baseSha }
// `dir` is the worktree root; `cwd` is where the agent runs: the same
// subdirectory of it as the job's cwd has within the repository.
export async function createWorktree(job, { runId, root }) {
  const base = String(job.base ?? "");
  if (base === "" || base.startsWith("-")) return { ok: false, error: `invalid base '${base}'`, baseSha: null };
  const sha = await gitAsync(["rev-parse", "--verify", "--quiet", `${base}^{commit}`], { cwd: job.cwd });
  const baseSha = sha.stdout.trim();
  if (!sha.ok || !/^[0-9a-f]{40,64}$/.test(baseSha)) {
    const why = sha.status === 1 || sha.status === 128 ? "" : ` (${sha.message})`;
    return { ok: false, error: `cannot resolve --base '${base}' in ${job.cwd}${why}`, baseSha: null };
  }
  const prefix = await gitAsync(["rev-parse", "--show-prefix"], { cwd: job.cwd });
  if (!prefix.ok) return { ok: false, error: `${job.cwd} is not inside a git work tree (${prefix.message})`, baseSha };

  const dir = join(root, job.id, runId);
  try {
    mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
  } catch (err) {
    return { ok: false, error: `cannot create worktree root ${dirname(dir)}: ${err.message}`.slice(0, 300), baseSha };
  }
  const add = await gitAsync([...NO_HOOKS, "worktree", "add", "--detach", dir, baseSha], { cwd: job.cwd });
  if (!add.ok) {
    await removeWorktree(job.cwd, dir);
    return { ok: false, error: `git worktree add failed: ${lastMeaningfulLine(add.stderr) || add.message}`.slice(0, 300), baseSha };
  }
  const cwd = join(dir, prefix.stdout.trim());
  if (!existsSync(cwd)) {
    await removeWorktree(job.cwd, dir);
    return { ok: false, error: `${job.cwd} does not exist at ${base} (${baseSha.slice(0, 12)})`, baseSha };
  }
  return { ok: true, dir, cwd, baseSha };
}

// Untracked, non-ignored paths (directories collapsed) that exist right now:
// what the setup step produced (node_modules, a copied .env). They are kept
// out of the run's commit.
export async function snapshotUntracked(dir) {
  const r = await gitAsync(["ls-files", "--others", "--exclude-standard", "--directory", "-z"], { cwd: dir });
  return r.ok ? r.stdout.split("\0").filter(Boolean) : [];
}

function parseShortstat(text) {
  const num = (re) => Number(re.exec(text)?.[1] ?? 0);
  return {
    filesChanged: num(/(\d+) files? changed/),
    insertions: num(/(\d+) insertions?\(\+\)/),
    deletions: num(/(\d+) deletions?\(-\)/),
  };
}

// Commits what the run left in the worktree and names it a branch.
// → { branch, diffstat, error, keep }. Never throws. `keep` means the work
// could not be saved to a branch, so the worktree must not be removed.
export async function finalizeWorktree(job, { dir, baseSha, runId, reason, excludes = [] }) {
  const result = { branch: null, diffstat: null, error: null, keep: false };
  const fail = (what, r) => {
    result.error = `${what}: ${lastMeaningfulLine(r.stderr) || r.message}`.slice(0, 300);
    result.keep = result.branch === null;
  };
  try {
    const addArgs = ["add", "-A"];
    let input;
    if (excludes.length > 0) {
      addArgs.push("--pathspec-from-file=-", "--pathspec-file-nul");
      input = [".", ...excludes.map((p) => `:(exclude,literal)${p}`)].join("\0") + "\0";
    }
    let add = await gitAsync([...NO_HOOKS, ...addArgs], { cwd: dir, input });
    if (!add.ok && /index\.lock/.test(add.stderr)) {
      // The agent was killed mid-git: its lock is stale (its process group is gone).
      const gd = await gitAsync(["rev-parse", "--absolute-git-dir"], { cwd: dir });
      if (gd.ok) {
        try { rmSync(join(gd.stdout.trim(), "index.lock"), { force: true }); } catch { /* best effort */ }
        add = await gitAsync([...NO_HOOKS, ...addArgs], { cwd: dir, input });
      }
    }
    if (!add.ok) return (fail("git add failed", add), result);

    const staged = await gitAsync(["diff", "--cached", "--quiet"], { cwd: dir });
    if (staged.status !== 0 && staged.status !== 1) return (fail("git diff --cached failed", staged), result);
    if (staged.status === 1) {
      const commit = await gitAsync([
        ...NO_HOOKS, "-c", "user.name=pi-tick", "-c", "user.email=pi-tick@localhost", "-c", "commit.gpgsign=false",
        "commit", "--no-verify", "-q", "-m", `pi-tick: ${job.id} run ${runId} (${reason})`,
      ], { cwd: dir });
      if (!commit.ok) return (fail("git commit failed", commit), result);
    }

    const head = await gitAsync(["rev-parse", "HEAD"], { cwd: dir });
    if (!head.ok) return (fail("git rev-parse HEAD failed", head), result);
    if (head.stdout.trim() === baseSha) return result; // no changes, no new commits: no branch

    const name = branchNameFor(job.id, runId);
    const br = await gitAsync(["branch", name, head.stdout.trim()], { cwd: dir });
    if (!br.ok) return (fail(`cannot create branch ${name}`, br), result);
    result.branch = name;

    const stat = await gitAsync(["diff", "--shortstat", `${baseSha}..${name}`], { cwd: dir });
    if (stat.ok) result.diffstat = parseShortstat(stat.stdout);
    else fail("git diff --shortstat failed", stat);
  } catch (err) {
    result.error = `finalize failed: ${err && err.message ? err.message : err}`.slice(0, 300);
    result.keep = result.branch === null;
  }
  return result;
}

// Removes a worktree and its registration. Never throws.
export async function removeWorktree(repoCwd, dir) {
  const r = await gitAsync(["worktree", "remove", "--force", dir], { cwd: repoCwd });
  if (!r.ok || existsSync(dir)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  await gitAsync(["worktree", "prune"], { cwd: repoCwd });
  try { rmdirSync(dirname(dir)); } catch { /* not empty or gone */ }
  return !existsSync(dir);
}

// ─── leftovers (crashed runs) ───────────────────────────────────────────
// Only `<root>/<jobId>/<8 hex>` directories that hold a git worktree link are
// touched: a configured root may be an ordinary directory holding other
// things, even one named like the job.
function isWorktreeLeftover(path) {
  try {
    if (!statSync(path).isDirectory()) return false;
    const git = join(path, ".git");
    if (existsSync(git)) return lstatSync(git).isFile();
    return readdirSync(path).length === 0;
  } catch {
    return false;
  }
}

// `olderThanMs: null` removes every leftover (delete); a number only those
// not touched for that long (retention). Always ends with `git worktree
// prune` in the job's repository. Returns how many directories were removed.
export function cleanupWorktreeLeftovers(job, roots, { olderThanMs = null, now = Date.now(), stderr } = {}) {
  let removed = 0;
  for (const root of roots) {
    const jobDir = join(root, job.id);
    let entries;
    try { entries = readdirSync(jobDir); } catch { continue; }
    for (const name of entries) {
      if (!RUN_ID_DIR_RE.test(name)) continue;
      const p = join(jobDir, name);
      if (!isWorktreeLeftover(p)) continue;
      try {
        if (olderThanMs !== null && statSync(p).mtimeMs > now - olderThanMs) continue;
        rmSync(p, { recursive: true, force: true });
        removed++;
      } catch (err) {
        stderr?.write(`pi-tick: worktree cleanup: ${err.message}\n`);
      }
    }
    try { rmdirSync(jobDir); } catch { /* not empty: not ours alone */ }
  }
  if (job.cwd && existsSync(job.cwd)) gitSync(["worktree", "prune"], { cwd: job.cwd, timeoutMs: 30_000 });
  return removed;
}
