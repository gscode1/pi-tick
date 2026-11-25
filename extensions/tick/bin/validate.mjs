// validate.mjs — job-field validation, shared by every subcommand that
// touches a job id, prompt, or cwd.

import { statSync, accessSync, constants as fsConstants } from "node:fs";
import { isAbsolute } from "node:path";
import { fail } from "./errors.mjs";
import { GUARD_MAX_TIMEOUT_S } from "./guard.mjs";

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

// `--when-timeout` in whole seconds; returns the number.
export function parseWhenTimeout(raw) {
  if (raw === true) fail(`--when-timeout requires a value`, 2);
  const str = String(raw);
  if (!/^\d+$/.test(str) || Number(str) < 1) {
    fail(`--when-timeout must be a positive integer number of seconds (got '${raw}')`, 2);
  }
  const n = Number(str);
  if (n > GUARD_MAX_TIMEOUT_S) fail(`--when-timeout must be at most ${GUARD_MAX_TIMEOUT_S} (got '${raw}')`, 2);
  return n;
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
