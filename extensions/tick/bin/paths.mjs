// paths.mjs — shared path helpers, used by both backends.
//
// Kept in a separate file (not backends/index.mjs) to avoid circular
// imports: backends/index.mjs imports each backend, and each backend
// imports path helpers from here.

import { homedir } from "node:os";
import { join } from "node:path";

export function dataDir() {
  return process.env.PI_TICK_DATA_DIR || join(homedir(), ".pi", "agent", "tick");
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

