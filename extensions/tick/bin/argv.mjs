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
export function flagOptionalU32(flags, name, { allowZero = true } = {}) {
  const v = flags[name];
  if (v === undefined) return null;
  if (v === true) fail(`--${name} requires a value`, 2);
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || (!allowZero && n === 0)) {
    fail(`--${name} must be a non-negative integer (got '${v}')`, 2);
  }
  return n;
}
