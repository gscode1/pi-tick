// commands/kill.mjs — `pi-tick kill <id> [--grace-ms N]` (issue #47).
// Terminates a job's running process and everything it recursively spawned.
// Looked up via the run-registry's active-run record, not the catalog — a
// run started before a concurrent `pi-tick delete` is still killable.

import { RUNTIME_DEFAULTS } from "../catalog.mjs";
import { parseFlags, flagOptionalU32 } from "../argv.mjs";
import { fail } from "../errors.mjs";
import { killActiveRun } from "../run-registry.mjs";

export async function cmdKill(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const flags = parseFlags(argv);
  const pos = flags._;
  if (pos.length < 1) fail(`kill requires a job id`, 2);
  const id = pos[0];
  const graceMs = flagOptionalU32(flags, "grace-ms", { allowZero: false }) ?? RUNTIME_DEFAULTS.killGraceMs;

  const result = await killActiveRun(id, { graceMs });
  if (!result.ok) {
    stderr.write(`pi-tick: ${result.error}\n`);
    return 4;
  }
  if (result.alreadyDead) {
    stdout.write(`job '${id}' has no running process (already finished)\n`);
    return 0;
  }
  stdout.write(`killed job '${id}' (pid ${result.pid}, ${result.signal})\n`);
  return 0;
}
