// tick-core — the command dispatcher for pi-tick. Imported in-process by the
// extension (extensions/tick/index.ts) AND by the thin CLI wrapper
// (pi-tick.mjs). No top-level CLI side effects live here — argv parsing
// happens inside each subcommand module, process exit is the wrapper's job.
// See pi-tick-prd.md for the full design.
//
// Each CLI verb's validation, execution, and formatting lives in its own
// module under commands/ — dispatch is a lookup table, not the place new
// verbs default to landing in. Cross-cutting concerns (argv parsing,
// validation, PATH/binary resolution, display formatting, the active
// backend) live in their own small modules alongside this one; see
// argv.mjs, validate.mjs, bin-resolve.mjs, display.mjs, backend-info.mjs.

import { PiTickError } from "./catalog.mjs";
import { HELP, cmdHelp } from "./commands/help.mjs";
import { cmdConfig } from "./commands/config.mjs";
import { cmdAdd } from "./commands/add.mjs";
import { cmdList } from "./commands/list.mjs";
import { cmdDelete } from "./commands/delete.mjs";
import { cmdEnable } from "./commands/enable.mjs";
import { cmdDisable } from "./commands/disable.mjs";
import { cmdRun } from "./commands/run.mjs";
import { cmdKill } from "./commands/kill.mjs";
import { cmdLog } from "./commands/log.mjs";
import { cmdTranscripts } from "./commands/transcripts.mjs";
import { cmdShow } from "./commands/show.mjs";

// name → handler, plus any aliases. Each handler is `(argv, io) => exitCode`.
const COMMANDS = {
  help: cmdHelp,
  add: cmdAdd,
  list: cmdList,
  ls: cmdList,
  delete: cmdDelete,
  rm: cmdDelete,
  enable: cmdEnable,
  disable: cmdDisable,
  run: cmdRun,
  kill: cmdKill,
  log: cmdLog,
  transcripts: cmdTranscripts,
  show: cmdShow,
  config: cmdConfig,
};

async function dispatch(argv, { stdout, stderr }) {
  const sub = argv[0];
  const rest = argv.slice(1);

  if (sub === undefined || sub === "") {
    stdout.write(HELP);
    return 0;
  }
  if (sub === "--help" || sub === "-h") {
    return cmdHelp([], { stdout, stderr });
  }

  const handler = COMMANDS[sub];
  if (!handler) {
    stderr.write(`pi-tick: unknown subcommand: ${sub}\n`);
    return 1;
  }
  return handler(rest, { stdout, stderr });
}

export { dispatch, PiTickError };
