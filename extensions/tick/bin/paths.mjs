// paths.mjs — shared path helpers, used by both backends.
//
// Kept in a separate file (not backends/index.mjs) to avoid circular
// imports: backends/index.mjs imports each backend, and each backend
// imports path helpers from here.

import { homedir, userInfo } from "node:os";
import { join, resolve, sep } from "node:path";

export function dataDir() {
  const dir = process.env.PI_TICK_DATA_DIR || join(homedir(), ".pi", "agent", "tick");
  // Safety net (issue #23): under `node --test` (which sets NODE_TEST_CONTEXT
  // in every test process) never resolve a data dir inside ~/.pi — that is
  // the developer's real data. Tests must point PI_TICK_DATA_DIR at a temp dir.
  if (process.env.NODE_TEST_CONTEXT) {
    const real = join(userInfo().homedir, ".pi") + sep; // passwd home: ignores $HOME
    if ((resolve(dir) + sep).startsWith(real)) {
      throw new Error(`pi-tick: refusing to use real data dir ${dir} during tests; set PI_TICK_DATA_DIR to a temp dir`);
    }
  }
  return dir;
}

export function logsDir() {
  return join(dataDir(), "logs");
}

export function stableCliPath() {
  // The "stable" copy of the CLI, synced by the extension to
  // ~/.pi/agent/tick/pi-tick.mjs. launchd plists and crontab entries
  // both reference this absolute path.
  return join(dataDir(), "pi-tick.mjs");
}

export function jobsFile() {
  return join(dataDir(), "jobs.json");
}

export function runsFile() {
  return join(dataDir(), "runs.jsonl");
}

// Tick-scoped config (separate from pi's global settings.json). Used for
// things like the default model applied when a job doesn't pin one.
// Treated as "no defaults set" if missing — don't auto-create.
export function configFile() {
  return join(dataDir(), "config.json");
}

export function transcriptsDir() {
  return join(dataDir(), "runs");
}

// Where every other sibling .mjs file (tick-core.mjs, catalog.mjs,
// backends/*.mjs, ...) is installed alongside the stable CLI is no longer
// answered here one function per file — see bundle.mjs's installedPath(rel),
// which derives the same dataDir-relative layout from the bin/ source tree
// (issue #60).

