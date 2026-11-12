// argv.mjs — a tiny positional + flag parser shared by every CLI subcommand.
// Flags may be `--key value` or `--key=value`. Unknown subcommand, missing
// required value, or `--help` is handled in dispatch (tick-core.mjs).

import { fail } from "./errors.mjs";

export function parseFlags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      if (eq !== -1) {
        out[tok.slice(2, eq)] = tok.slice(eq + 1);
      } else {
        const key = tok.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
          out[key] = true;
        } else {
          out[key] = next;
          i++;
        }
      }
    } else {
      out._.push(tok);
    }
  }
  return out;
}

export function flagString(flags, name, label = name) {
  const v = flags[name];
  if (v === undefined || v === true) fail(`missing --${name} (${label})`, 2);
  return String(v);
}

export function flagNumber(flags, name, label = name) {
  const v = flags[name];
  if (v === undefined || v === true) fail(`missing --${name} (${label})`, 2);
  const n = Number(v);
  if (!Number.isFinite(n)) fail(`--${name} must be a number (got '${v}')`, 2);
  return n;
}

// Optional numeric flag. Returns `null` when absent and a non-negative
// integer (or `null`) when present. Used for runtime controls that have
// a built-in default — the caller decides what to do with `null`/0.
//
// Only plain decimal digit strings (or the equivalent integer from the tool
// path) are accepted: no empty/whitespace values (Number("") is 0, which
// would silently disable a limit), no floats, exponents or signs.
// Values above MAX_RUNTIME_LIMIT are rejected: Node clamps setTimeout
// delays above 2^31-1 ms to 1 ms, firing the timer almost immediately. The
// same bound is applied to maxOutputBytes (a byte count, not a timer) for
// simplicity.
export const MAX_RUNTIME_LIMIT = 2147483647;

export function flagOptionalU32(flags, name, { allowZero = true } = {}) {
  const v = flags[name];
  if (v === undefined || v === null) return null;
  if (v === true) fail(`--${name} requires a value`, 2);
  const str = String(v);
  if (!/^\d+$/.test(str)) {
    fail(`--${name} must be a non-negative integer (got '${v}')`, 2);
  }
  const n = Number(str);
  if (n > MAX_RUNTIME_LIMIT) {
    fail(`--${name} must be at most ${MAX_RUNTIME_LIMIT} (got '${v}')`, 2);
  }
  if (!allowZero && n === 0) {
    fail(`--${name} must be a non-negative integer greater than 0 (got '${v}')`, 2);
  }
  return n;
}
