// commands/help.mjs — `pi-tick help` / `pi-tick --help` / bare `pi-tick`.

import { getBackend } from "../backends/index.mjs";
import { getMinIntervalSeconds } from "../backend-info.mjs";

export const HELP = `pi-tick — persistent scheduled agent tasks for Pi

Backend: ${getBackend().name} (override with PI_TICK_BACKEND=launchd|cron)
Minimum interval: ${getMinIntervalSeconds()}s (cron cannot express sub-minute)


Usage:
  pi-tick add <id> --prompt "..." --cwd <path> --kind <interval|daily|weekly> \\
                   [--minutes N] [--seconds N] \\
                   [--offset-minutes N] [--offset-seconds N] \\
                   [--time HH:MM] [--days mon,wed,fri] \\
                   [--model <id>] [--enabled] \\
                   [--timeout-ms N] [--idle-timeout-ms N] \\
                   [--max-output-bytes N] [--kill-grace-ms N]
  pi-tick list [--json]
  pi-tick delete <id>
  pi-tick enable <id>
  pi-tick disable <id>
  pi-tick run <id> [--manual]
  pi-tick kill <id> [--grace-ms N]
  pi-tick log [id] [--limit N] [--failed] [--since <dur>]
  pi-tick transcripts <id> [--limit N]
  pi-tick show <id> [--run N|--run-id <id>] [--tail M] [--raw] [--no-meta]
  pi-tick config <set|get|unset> <key> [value]
  pi-tick help

Jobs are disabled by default; pass --enabled to schedule them.

  pi-tick kill <id>  # terminate a running job and everything it spawned;
                     # sends SIGTERM, then SIGKILL after the grace period
                     # (default 5s) if it's still alive

Transcripts: every run writes a per-job JSONL record of pi's full event
stream under ~/.pi/agent/tick/runs/<id>/. Retention is 7 days or 500MB
per job, whichever comes first.

  pi-tick log <id>             # tabular list of recent runs
  pi-tick log <id> --failed    # only non-zero exit
  pi-tick log <id> --since 1h  # only runs in the last hour (s/m/h/d)
  pi-tick transcripts <id>     # list transcript files for a job
  pi-tick show <id>            # chat-style view of the latest transcript
  pi-tick show <id> --raw      # JSONL events, one per line ('event:' prefix)
  pi-tick show <id> --tail 3   # only the last 3 assistant turns
  pi-tick show <id> --run-id abc123  # show a specific run from 'pi-tick log'
  pi-tick show <id> --no-meta  # skip the run header

The chat view renders the user prompt, the agent's thinking, tool calls
and results, and the final answer — like reading a pi session, with
verbose JSON metadata stripped. Pipe --raw output to jq to filter events:
  pi-tick show <id> --raw | grep '"type":"tool_result_end"' | jq .
`;

export function cmdHelp(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  stdout.write(HELP);
  return 0;
}
