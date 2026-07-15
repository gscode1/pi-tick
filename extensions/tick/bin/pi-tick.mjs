#!/usr/bin/env node
// pi-tick — thin CLI wrapper. All logic lives in tick-core.mjs (the reusable
// programmatic core, imported in-process by the extension). This entry point
// only parses argv and delegates to the core dispatcher, then maps the result
// to a process exit code.
//
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename } from "node:path";
import { dispatch, PiTickError } from "./tick-core.mjs";

// Re-export only what this wrapper itself needs (dispatch + the error class
// it catches below) — not a blanket `export *` (issue #63). Anything that
// imported a tick-core internal through this file should import it from the
// module that actually owns it.
export { dispatch, PiTickError };

// If executed directly (not imported), run the CLI.
// We resolve symlinks on argv[1] so the check works whether the script was
// invoked directly (`node pi-tick.mjs ...`), via the stable copy
// (`~/.pi/agent/tick/pi-tick.mjs ...`), or via a symlink (`pi-tick ...`).
function isMainModule() {
  const arg1 = process.argv[1];
  if (!arg1) return false;
  try {
    const realArgv1 = realpathSync(arg1);
    const realSelf = realpathSync(fileURLToPath(import.meta.url));
    if (realArgv1 === realSelf) return true;
  } catch { /* fall through */ }
  // Fallback: compare basenames (handles non-existent argv[1] and weird setups).
  const selfName = basename(fileURLToPath(import.meta.url));
  return basename(arg1) === selfName;
}

if (isMainModule()) {
  // Subcommand argv: argv[0] is "node" or "pi-tick", argv[1] is the script,
  // argv[2] is the subcommand, rest are flags.
  const subargv = process.argv.slice(2);
  const stdout = process.stdout;
  const stderr = process.stderr;
  dispatch(subargv, { stdout, stderr })
    .then((code) => {
      process.exit(typeof code === "number" ? code : 0);
    })
    .catch((err) => {
      if (err instanceof PiTickError) {
        stderr.write(`pi-tick: ${err.message}\n`);
        process.exit(err.code);
      }
      stderr.write(`pi-tick: ${err && err.message ? err.message : err}\n`);
      process.exit(1);
    });
}
