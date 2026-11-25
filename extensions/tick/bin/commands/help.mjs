// commands/help.mjs — `pi-tick help` / `pi-tick --help` / bare `pi-tick`.

import { getBackend } from "../backends/index.mjs";
import { getMinIntervalSeconds } from "../backend-info.mjs";

export const HELP = `pi-tick — persistent scheduled agent tasks for Pi

Backend: ${getBackend().name} (override with PI_TICK_BACKEND=launchd|cron)
Minimum interval: ${getMinIntervalSeconds()}s (cron cannot express sub-minute)


Usage:
  pi-tick add <id> --prompt "..." --cwd <path> --kind <interval|daily|weekly|once> \\
                   [--minutes N] [--seconds N] [--at ISO-8601] \\
                   [--offset-minutes N] [--offset-seconds N] \\
                   [--time HH:MM] [--days mon,wed,fri] \\
                   [--agent pi|command] [--model <id>] [--on-complete <abs path>] [--enabled] \\
                   [--when "<shell cmd>"] [--when-timeout SECONDS] \\
                   [--isolate worktree --base <ref> [--worktree-dir <abs path>] \\
                    [--setup "<shell cmd>"] [--setup-timeout SECONDS]] \\
                   [--timeout-ms N] [--idle-timeout-ms N] \\
                   [--max-output-bytes N] [--kill-grace-ms N]
  pi-tick list [--json]
  pi-tick delete <id>
  pi-tick enable <id>
  pi-tick disable <id>
  pi-tick run <id> [--manual [--no-when]]   (--manual runs even if disabled)
  pi-tick kill <id> [--grace-ms N]
  pi-tick log [id] [--limit N] [--failed] [--since <dur>] [--all]
  pi-tick transcripts <id> [--limit N]
  pi-tick show <id> [--run N|--run-id <id>] [--tail M] [--raw] [--no-meta]
  pi-tick show <id> --diff [--run-id <id>]   (diff of an isolated run's branch)
  pi-tick config <set|get|unset> <key> [value]   (keys: default-model, worktree-dir)
  pi-tick doctor [id] [--fix] [--json]
  pi-tick help

Interval offsets (--offset-minutes) need whole minutes smaller than the
interval, on a divisor of 60 minutes or an hour count dividing 24 (e.g. 2h +1h).
cron also needs one of those for plain intervals; launchd accepts any >= 5s.

Jobs are disabled by default; pass --enabled to schedule them.

--agent command runs --prompt as a /bin/sh command line with no model; the
exit code decides success and the last stdout line is the run summary.

--on-complete runs an executable after each run is recorded, with the run
record as JSON on stdin (30s limit). Output: logs/<id>.callback.log.

--when runs a shell command (cwd = the job's, 60s limit, or --when-timeout)
before each fire: exit 0 runs the agent, exit 1 records the run as
"skipped" (no agent, no tokens), any other exit, a signal or a timeout
records "guard_failed". The guard's stdout (64 KiB cap) replaces
{{when.stdout}} in a pi prompt, and is in $PI_TICK_WHEN_STDOUT for command
jobs and --on-complete. "run --manual" runs the guard; --no-when bypasses it.
"log" hides skipped runs unless --all.

--isolate worktree gives every run its own git worktree of --base (a detached
checkout under <worktree root>/<id>/<runId>; root = --worktree-dir, else
"config set worktree-dir", else ~/.pi/agent/tick/worktrees). The agent runs
there; --setup (cwd = the worktree, 300s limit or --setup-timeout) prepares it
(npm ci, copying .env from $PI_TICK_SOURCE_CWD). Afterwards the changes are
committed to branch tick/<id>/<runId> (none if nothing changed) and the
worktree is removed; the run record gains branch and diffstat, --on-complete
receives them, and "show <id> --diff" prints the diff. A run whose worktree or
setup fails is recorded as "worktree_failed" / "setup_failed" without running
the agent. Branches are never deleted by pi-tick.

  pi-tick doctor        # find enabled jobs that silently stopped: missing or
                        # changed scheduler entry, node/pi/cwd/--on-complete
                        # path gone (e.g. after an nvm/mise upgrade), missed
                        # fires, failing last run. Exits 1 if any need attention.
  pi-tick doctor --fix  # re-register repairable jobs with fresh node/pi paths

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
