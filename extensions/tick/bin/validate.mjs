// validate.mjs — job-field validation, shared by every subcommand that
// touches a job id, prompt, or cwd.

import { statSync, accessSync, constants as fsConstants } from "node:fs";
import { isAbsolute } from "node:path";
import { fail } from "./errors.mjs";
import { GUARD_MAX_TIMEOUT_S } from "./guard.mjs";
import { ISOLATE_WORKTREE, isGitWorkTree, resolveCommitSync, branchNameIsValid } from "./worktree.mjs";

export const ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
export const MAX_PROMPT_BYTES = 16 * 1024;

export function validateId(id) {
  if (!id || !ID_REGEX.test(id)) {
    fail(`invalid id '${id}': must match ${ID_REGEX}`, 2);
  }
}

export function validatePrompt(prompt) {
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    fail(`prompt must be a non-empty string`, 2);
  }
  const bytes = Buffer.byteLength(prompt, "utf8");
  if (bytes > MAX_PROMPT_BYTES) {
    fail(`prompt is ${bytes} bytes; maximum is ${MAX_PROMPT_BYTES}`, 2);
  }
}

// The callback only runs after a job fires, so catch a typo or a missing
// chmod +x at add/enable time instead of in logs/<id>.callback.log hours later.
export function validateExecutable(path) {
  let st;
  try { st = statSync(path); } catch {
    fail(`--on-complete: ${path} does not exist`, 2);
  }
  if (!st.isFile()) fail(`--on-complete: ${path} is not a file`, 2);
  try { accessSync(path, fsConstants.X_OK); } catch {
    fail(`--on-complete: ${path} is not executable`, 2);
  }
}

// `--when` guard command. Returns it unchanged; the shell parses it at run time.
export function validateWhen(when) {
  if (typeof when !== "string" || when.trim().length === 0) {
    fail(`--when must be a non-empty shell command`, 2);
  }
  const bytes = Buffer.byteLength(when, "utf8");
  if (bytes > MAX_PROMPT_BYTES) {
    fail(`--when is ${bytes} bytes; maximum is ${MAX_PROMPT_BYTES}`, 2);
  }
}

// `--when-timeout` / `--setup-timeout` in whole seconds; returns the number.
function parseTimeoutSeconds(raw, flag) {
  if (raw === true) fail(`${flag} requires a value`, 2);
  const str = String(raw);
  if (!/^\d+$/.test(str) || Number(str) < 1) {
    fail(`${flag} must be a positive integer number of seconds (got '${raw}')`, 2);
  }
  const n = Number(str);
  if (n > GUARD_MAX_TIMEOUT_S) fail(`${flag} must be at most ${GUARD_MAX_TIMEOUT_S} (got '${raw}')`, 2);
  return n;
}

export function parseWhenTimeout(raw) {
  return parseTimeoutSeconds(raw, "--when-timeout");
}

// `--isolate worktree [--base <ref>] [--worktree-dir <abs>] [--setup <cmd>]
// [--setup-timeout S]`. Returns the job fields to store ({} when not
// isolated). Run after validateCwd (the git checks run in `cwd`).
export function validateIsolation({ isolate, base, worktreeDir, setup, setupTimeout, cwd, jobId }) {
  const given = (v) => v !== undefined && v !== null;
  if (!given(isolate)) {
    for (const [flag, v] of [["--base", base], ["--worktree-dir", worktreeDir], ["--setup", setup], ["--setup-timeout", setupTimeout]]) {
      if (given(v)) fail(`${flag} requires --isolate ${ISOLATE_WORKTREE}`, 2);
    }
    return {};
  }
  if (isolate !== ISOLATE_WORKTREE) fail(`--isolate must be '${ISOLATE_WORKTREE}' (got '${isolate}')`, 2);
  if (!given(base)) fail(`--isolate ${ISOLATE_WORKTREE} requires --base <ref>`, 2);
  if (typeof base !== "string" || base.trim() === "" || base.startsWith("-")) {
    fail(`--base must be a git ref (branch, tag or commit), not '${base}'`, 2);
  }
  if (given(worktreeDir) && (typeof worktreeDir !== "string" || !isAbsolute(worktreeDir))) {
    fail(`--worktree-dir must be an absolute path (got '${worktreeDir}')`, 2);
  }
  if (given(setup)) {
    if (typeof setup !== "string" || setup.trim().length === 0) fail(`--setup must be a non-empty shell command`, 2);
    const bytes = Buffer.byteLength(setup, "utf8");
    if (bytes > MAX_PROMPT_BYTES) fail(`--setup is ${bytes} bytes; maximum is ${MAX_PROMPT_BYTES}`, 2);
  }
  if (given(setupTimeout) && !given(setup)) fail(`--setup-timeout requires --setup`, 2);
  const timeout = given(setupTimeout) ? parseTimeoutSeconds(setupTimeout, "--setup-timeout") : null;

  if (!isGitWorkTree(cwd)) fail(`--isolate ${ISOLATE_WORKTREE}: cwd is not inside a git work tree: ${cwd}`, 2);
  if (resolveCommitSync(cwd, base) === null) fail(`--base '${base}' does not resolve to a commit in ${cwd}`, 2);
  if (!branchNameIsValid(jobId)) {
    fail(`--isolate ${ISOLATE_WORKTREE}: job id '${jobId}' cannot be part of a git branch name (tick/${jobId}/<runId>); pick another id`, 2);
  }
  return {
    isolate,
    base,
    ...(given(worktreeDir) ? { worktreeDir } : {}),
    ...(given(setup) ? { setup } : {}),
    ...(timeout !== null ? { setupTimeout: timeout } : {}),
  };
}

export function validateCwd(cwd) {
  if (typeof cwd !== "string" || !isAbsolute(cwd)) {
    fail(`cwd must be an absolute path (got '${cwd}')`, 2);
  }
  let st;
  try {
    st = statSync(cwd);
  } catch {
    fail(`cwd does not exist: ${cwd}`, 2);
  }
  if (!st.isDirectory()) {
    fail(`cwd is not a directory: ${cwd}`, 2);
  }
}
