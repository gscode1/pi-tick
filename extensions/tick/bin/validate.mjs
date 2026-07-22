// validate.mjs — job-field validation, shared by every subcommand that
// touches a job id, prompt, or cwd.

import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fail } from "./errors.mjs";

export const ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
export const MAX_PROMPT_BYTES = 16 * 1024;

export function validateId(id) {
  if (!id || !ID_REGEX.test(id)) {
    fail(`invalid id '${id}': must match ${ID_REGEX}`, 2);
  }
}

export function validatePrompt(prompt) {
  if (typeof prompt !== "string" || prompt.length === 0) {
    fail(`prompt must be a non-empty string`, 2);
  }
  const bytes = Buffer.byteLength(prompt, "utf8");
  if (bytes > MAX_PROMPT_BYTES) {
    fail(`prompt is ${bytes} bytes; maximum is ${MAX_PROMPT_BYTES}`, 2);
  }
}

export function validateCwd(cwd) {
  if (typeof cwd !== "string" || !isAbsolute(cwd)) {
    fail(`cwd must be an absolute path (got '${cwd}')`, 2);
  }
  if (!existsSync(cwd)) {
    fail(`cwd does not exist: ${cwd}`, 2);
  }
}
