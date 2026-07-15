# Pi Tick

> Persistent scheduled agent tasks for [Pi](https://pi.dev), backed by
> launchd (macOS) or cron (Linux).

Register a prompt + a schedule, and `pi-tick` fires it via your OS's
native scheduler. The runner spawns `pi` in a fresh session, captures
the full event stream as a per-run **transcript**, and writes a
`RunRecord` to `runs.jsonl`. Prompts starting with `/` use Pi RPC mode
so slash commands execute as commands, not model-interpreted text. Jobs
persist across restarts, and the machine doesn't need to be awake
exactly on time — the scheduler owns the timer.

## What it does

- One-time install via `pi install npm:pi-tick`.
- Use the `pi-tick` CLI to register a job (prompt + cwd + schedule) and to
  browse past runs (table, chat-style view, or raw JSONL for piping to `jq`).
- Use the `/tick` slash command inside Pi to list, run, and delete jobs.
- Use the `tick_create` / `tick_list` / `tick_delete` LLM tools to schedule
  from inside an agent session.
- launchd fires the job at the scheduled time; the runner streams the full
  transcript, writes a `RunRecord` to `runs.jsonl`, and updates `lastRun` on
  the catalog. Transcripts are kept for 7 days or 500 MB per job, whichever
  comes first.

## Install

```sh
# 1. Install the package
pi install npm:pi-tick

# 2. One-time CLI symlink (so you can run `pi-tick` from the terminal)
ln -s ~/.pi/agent/tick/pi-tick.mjs ~/.local/bin/pi-tick
chmod +x ~/.pi/agent/tick/pi-tick.mjs

# 3. macOS TCC pre-flight: launchd-spawned processes can't show TCC dialogs.
#    Run any job once interactively with `/tick run <id>` to answer any
#    permission prompts (e.g. "node wants to access ~/Documents"). After
#    that, launchd-fired runs work.
```

> **Why the pre-flight dance?** A `~/Library/LaunchAgents/`-spawned process
> cannot present TCC (Transparency, Consent, and Control) dialogs. macOS
> denies the access by default. Run the job once interactively, answer any
> prompts, and the answer is cached for the (binary, resource) pair.

## Quick start

```sh
# 1. Create a draft job (disabled by default — nothing fires yet)
pi-tick add nightly-recap \
  --prompt "Summarize today's git log and write to .scratch/recap.md" \
  --cwd ~/code/myproject \
  --kind daily --time 02:00

# 2. Test it once via the runner (manual trigger)
pi-tick run nightly-recap

# 3. Enable the schedule (registers a launchd plist)
pi-tick enable nightly-recap

# 4. Inspect
pi-tick list
pi-tick log nightly-recap --limit 10

# 5. Remove (unload + delete)
pi-tick disable nightly-recap   # if it was enabled
pi-tick delete nightly-recap
```

## Commands

### Terminal: `pi-tick`

| Command | Purpose |
|---|---|
| `pi-tick add <id> ...` | Create a job in the catalog. **Disabled by default** — pass `--enabled` to also register a launchd plist. |
| `pi-tick list [--json]` | Print all jobs as a table (or JSON). |
| `pi-tick delete <id>` | Remove a job (also unloads its plist if enabled). |
| `pi-tick enable <id>` | Register / re-register the launchd plist. Idempotent. |
| `pi-tick disable <id>` | Unload the plist and rename it to `.plist.disabled`. |
| `pi-tick run <id>` | Fire a job manually. |
| `pi-tick log [id] [--limit N] [--failed] [--since <dur>]` | Tail the run log. `--failed` keeps only non-zero exits; `--since` keeps runs in the last `<dur>` (`30s`/`5m`/`2h`/`1d`). |
| `pi-tick transcripts <id> [--limit N]` | List transcript files for a job, newest first. |
| `pi-tick show <id> [--run N] [--tail M] [--raw] [--no-meta]` | Chat-style view of a transcript (default: latest). `--run N` picks the Nth most recent. `--tail M` keeps the last M assistant turns. `--raw` emits JSONL events, one per line (`event:` prefix for `jq` pipelines). `--no-meta` skips the run header. |
| `pi-tick config <set\|get\|unset> <key> [value]` | Read or write tick-scoped config. Today: `default-model` (see below). |
| `pi-tick help` | Print usage. |

Flags for `add`:
- `--prompt "..."` — required (≤ 16 KB)
- `--cwd <abs path>` — required, must exist
- `--kind interval|daily|weekly` — required
- `--minutes N --seconds N` — for `interval` (min total 5s)
- `--time HH:MM` — for `daily` and `weekly` (24h)
- `--days mon,wed,fri` — for `weekly` (comma-separated, case-insensitive)
- `--model <id>` — optional, passed to `pi` as `--model`
- `--enabled` — also register the launchd plist in the same call

### Default model

Every job run resolves its `--model` flag by precedence:

1. `--model` on the job (set via `pi-tick add --model <id>`).
2. The tick-scoped default (`pi-tick config set default-model <id>`).
3. **Nothing** — `pi` uses its own global default (from `~/.pi/agent/settings.json`).

This lives in `~/.pi/agent/tick/config.json` so it doesn't touch pi's global
settings. A missing or empty `config.json` is treated as "no tick default".
Example:

```sh
pi-tick config set default-model MiniMax-M3
pi-tick config get default-model     # prints MiniMax-M3
pi-tick config unset default-model   # back to step 3
```

### Inside a Pi session: `/tick`

| Command | Purpose |
|---|---|
| `/tick list` | Show all jobs (markdown table). |
| `/tick run <id>` | Fire a job manually. The `RunRecord` is marked `triggerKind: "manual"`. |
| `/tick kill <id>` | Terminate a running job's process tree. |
| `/tick enable <id>` | Register the job with the active backend (launchd/cron) so it starts firing. |
| `/tick disable <id>` | Unregister the job from the backend without deleting it. |
| `/tick delete <id>` | Delete a job. |
| `/tick log [id]` | List recent runs. |
| `/tick show <id>` | Chat-style view of a job's latest transcript. |

Argument completion works for all of these.

### LLM-callable tools

| Tool | Args | Returns |
|---|---|---|
| `tick_create` | `jobId, prompt, cwd, scheduleKind, scheduleValue, days?, enabled?, model?` | The new job (JSON). |
| `tick_list` | — | The catalog as a JSON array. |
| `tick_delete` | `jobId` | Confirmation. |

The LLM can create-and-enable in one call by passing `enabled: true` to
`tick_create`. It cannot enable or disable existing jobs — to do that, the
agent must `tick_delete` and `tick_create` a new one with `enabled: true`.
This is intentional: a misbehaving prompt cannot enable a job the user
hasn't already approved by creating.

## How it works

```
LLM tool    ──┐
slash cmd   ──┼──►  extensions/tick/index.ts  ──spawn──►  pi-tick.mjs  ──spawn──►  pi
terminal    ──┘                            │
                                          ├─► jobs.json       (mode 0600)
                                          ├─► runs.jsonl      (mode 0600)
                                          ├─► runs/<jobId>/   (per-run JSONL transcripts, mode 0600)
                                          └─► ~/Library/LaunchAgents/dev.pi.tick.<id>.plist
                                                                                  ▲
                                            launchd ── fires at scheduled time ────┘
                                                       (runs `node pi-tick.mjs run <id>`)
```

**One runner, three callers.** The CLI is the source of truth — it owns the
catalog, the run log, the plist template, and the launchctl calls. The
extension's slash commands and LLM tools shell out to the same CLI.

**The `pi-tick.mjs` "stable" path.** The extension's `session_start` handler
copies `bin/pi-tick.mjs` to `~/.pi/agent/tick/pi-tick.mjs`. This path is
stable across reinstalls of the extension, so the launchd plist's
`ProgramArguments` remains valid forever. When you update the extension,
the next session re-syncs the script; existing plists pick it up
automatically.

## Platform notes

### macOS (launchd)

- **A user must be logged in.** `~/Library/LaunchAgents/` jobs only run
  in a logged-in user session (any session; the screen can be locked).
  A Mac that's asleep with no one logged in will not fire scheduled jobs.
- **No admin / sudo required.** `~/Library/LaunchAgents/` and per-user
  `launchctl` commands do not require elevation.
- **The Mac will not wake from sleep for a scheduled fire.** launchd's
  `StartCalendarInterval` has no wake-the-machine flag. If the Mac is
  asleep at the scheduled time, the fire is missed. When the Mac wakes,
  the missed fire is **not** replayed. Same behavior as cron. If "fire
  even when asleep" is needed, that's a `pmset schedule` problem, out of
  scope here.
- **TCC pre-flight is required.** See the install step above. Without it,
  a launchd-fired run that needs to touch `~/Documents` or similar will
  be silently denied.
- **`launchctl bootstrap` requires a GUI session domain.** We use
  `gui/<uid>` where `uid` is `process.getuid()`. If the user is in a
  remote or non-GUI session, this won't work — but our use case assumes
  a normal desktop session.

### Linux (cron)

- **User crontab, not system.** `pi-tick` adds entries to the **user's**
  crontab via `crontab -` (no `sudo` needed). Your other crontab
  entries are preserved; pi-tick's entries are marked with a
  `# pi-tick: <jobId>` comment so we only touch our own lines.
- **Minute granularity.** Cron's smallest unit is one minute. The
  minimum interval on Linux is **60 seconds** (vs. 5 seconds on
  macOS). Sub-minute cadences (e.g. `--seconds 30`) are rejected with
  a clear error at `pi-tick add` time. Non-multiple-of-60 intervals
  (e.g. 90 seconds) are also rejected — cron can't express them.
- **Standard cron service must be running.** Most Linux distributions
  run `cron`/`crond` by default. If `crontab -l` returns "no crontab
  for \<user\>" the daemon is up but you have no entries yet; that's
  fine — `pi-tick` will create the first one.
- **No wake from suspend.** Cron (like launchd) does not wake the
  machine. If you suspend your laptop, scheduled fires are missed.
  Same as `pmset schedule` — out of scope here.
- **Output goes to log files.** Each pi-tick crontab line appends to
  `~/.pi/agent/tick/logs/<id>.out.log` and `.err.log`, mirroring the
  macOS launchd behavior.

## Backends

`pi-tick` dispatches to one of two backends based on `process.platform`:

| Platform | Backend | Min interval | Schedule files |
|---|---|---:|---|
| macOS (`darwin`) | launchd | 5s | `~/Library/LaunchAgents/dev.pi.tick.<id>.plist` |
| Everything else | user crontab | 60s | the user's crontab (entries tagged `# pi-tick: <id>`) |

Override for testing with `PI_TICK_BACKEND=launchd` or
`PI_TICK_BACKEND=cron`. The active backend is reported in the
`pi-tick help` output.

## Default-disabled safety

A new job does not start firing until you explicitly enable it. This is
deliberate:

```sh
# User runs this once, intending just to "try it out"
pi-tick add my-test --prompt "..." --cwd /tmp --kind daily --time 09:00

# They've now created a job in the catalog with enabled=false. Nothing fires.
pi-tick list
# → my-test  no  daily  daily @ 09:00  --  never

pi-tick enable my-test   # explicit, intentional
```

The extra step is one command for legitimate users and prevents the
"register an autonomous job that does X" class of mistake. The LLM can
still create-and-enable in one call by passing `enabled: true` to
`tick_create`.

## Data layout

```
~/.pi/agent/tick/                         # data dir, created on first session_start
├── jobs.json                             # the catalog (mode 0600)
├── runs.jsonl                            # append-only audit log (mode 0600)
├── pi-tick.mjs                           # stable copy of the CLI (mode 0755)
├── runs/                                 # per-job transcripts (mode 0700)
│   └── nightly-recap/                    # one dir per job
│       └── 2026-06-15T02-00-04-123Z_7c8a1234.jsonl
└── logs/                                 # launchd stdout/stderr (mode 0700)
    ├── nightly-recap.out.log
    └── nightly-recap.err.log

**Retention:** Each per-job log file (`logs/<id>.out.log`, `logs/<id>.err.log`) is capped by default to 7 days of age and 50 MB in size. Size-capping truncates the head of the file and preserves the tail (the most recent bytes). These thresholds can be overridden via the `PI_TICK_LOG_RETENTION_DAYS` and `PI_TICK_LOG_MAX_BYTES` environment variables.

~/Library/LaunchAgents/
└── dev.pi.tick.<jobId>.plist             # one per enabled job
```

### `jobs.json`

```json
{
  "version": 1,
  "jobs": [
    {
      "id": "nightly-recap",
      "prompt": "Summarize today's git log…",
      "cwd": "/Users/me/code/myproject",
      "schedule": { "kind": "daily", "value": { "time": "02:00" } },
      "enabled": true,
      "model": "claude-sonnet-4-5",
      "piPath": "/Users/me/.local/share/mise/installs/node/25.9.0/bin/pi",
      "createdAt": "2026-06-15T08:12:33.000Z",
      "updatedAt": "2026-06-15T08:12:47.000Z",
      "lastRun": {
        "startedAt": "2026-06-15T02:00:04.123Z",
        "finishedAt": "2026-06-15T02:00:47.890Z",
        "exitCode": 0,
        "error": null,
        "tokens": { "input": 1234, "output": 567 },
        "transcriptPath": "/Users/me/.pi/agent/tick/runs/nightly-recap/2026-06-15T02-00-04-123Z_7c8a1234.jsonl",
        "finalTextPreview": "Done. Wrote .scratch/recap.md."
      }
    }
  ]
}
```

**Field rules:**

- `id` — `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`. Used as the plist label suffix.
- `prompt` — non-empty, ≤ 16 KB.
- `cwd` — absolute path; must exist at create-time.
- `schedule` — one of `interval` (≥ 5s), `daily` (HH:MM), `weekly` (days + HH:MM).
- `enabled` — boolean. **Default `false` on `add`.**
- `model` — optional; passed to `pi` as `--model`.
- `piPath` — internal; set by `enable` after resolving `which pi`.
- `lastRun` — written by the runner; `null` until first run. Carries the
  same fields as a `RunRecord` (see below) plus `transcriptPath` and
  `finalTextPreview` so a fresh `pi-tick show <id>` can render the latest
  transcript without re-scanning `runs.jsonl`.
- `version` — always `1` in Phase 1.

### `runs.jsonl`

One JSON object per line, append-only:

```json
{"runId":"7c8a1234","jobId":"nightly-recap","triggerKind":"external","startedAt":"2026-06-15T02:00:04.123Z","finishedAt":"2026-06-15T02:00:47.890Z","exitCode":0,"error":null,"tokens":{"input":1234,"output":567},"transcriptPath":"/Users/me/.pi/agent/tick/runs/nightly-recap/2026-06-15T02-00-04-123Z_7c8a1234.jsonl","transcriptBytes":12083,"finalTextPreview":"Done. Wrote .scratch/recap.md."}
```

- `triggerKind` — `"external"` (launchd) or `"manual"` (`/tick run` or `pi-tick run`).
- `tokens` — `{ input, output }` from the final `message_end` event. Anthropic-style cache fields (`cacheRead`, `cacheWrite`) are dropped from the record; the raw JSONL transcript preserves them.
- `transcriptPath` / `transcriptBytes` — pointer to the full event stream
  in `runs/<jobId>/`. Survives even if the transcript file is later pruned.
- `finalTextPreview` — the last assistant `message_end` text, truncated to
  200 chars with `…` if longer. Lets `pi-tick log` show the agent's
  answer without opening the transcript.

### Transcripts (`runs/<jobId>/*.jsonl`)

Every fire writes the full `pi --mode json` event stream to
`runs/<jobId>/<safeTimestamp>_<runId>.jsonl` (mode 0600). `safeTimestamp`
replaces `:` and `.` with `-` to keep the name portable
(`2026-06-15T02-00-04-123Z_7c8a1234.jsonl`); `runId` is 8 random hex chars.

`pi-tick show <id>` renders a transcript readably (user prompt, agent
thinking, tool calls, tool results, final answer — like reading a pi
session). `pi-tick show <id> --raw` emits the events one per line
prefixed with `event: ` for piping to `jq`.

**Retention** is 7 days or 500 MB per job, whichever comes first. The
runner prunes automatically on each fire; older files are deleted
oldest-first, and the size cap is enforced by total bytes in
`runs/<jobId>/`.

## Uninstall

Three steps per job, then remove the package:

```sh
pi-tick disable <id> && pi-tick delete <id>   # for each job
rm -rf ~/.pi/agent/tick
rm ~/.local/bin/pi-tick
pi remove npm:pi-tick
```

## Limitations

This is Phase 1. The following are explicitly deferred:

- **`/loop <interval> <prompt>`** — Phase 2.
- **In-pi poller** for jobs that should fire while a pi session is alive.
- **Windows** — Windows Task Scheduler support is deferred.
- **`update` command** — use `delete` + `add` instead.
- **`dry-run`, `uninstall`, `status --plist`** — Phase 1.1.
- **`tick_update`, `tick_enable`, `tick_disable` LLM tools** — Phase 1.1.
- **Per-job tool allow/deny**, **session continuation** — Phase 2.
- **SQLite store** — JSON files only, for ≤ 100 jobs and ≤ 10k runs.

## Reading past runs

```sh
# Recent runs for a job (default: last 10)
pi-tick log nightly-recap

# All runs
pi-tick log nightly-recap --limit 0

# Only failures in the last hour
pi-tick log nightly-recap --failed --since 1h

# Chat-style view of the latest run
pi-tick show nightly-recap

# Just the last 2 turns, no header
pi-tick show nightly-recap --tail 2 --no-meta

# Raw JSONL for jq pipelines
pi-tick show nightly-recap --raw | grep '"type":"message_end"' \
  | sed 's/^event: //' | jq '.message.usage'
```

## Development

```sh
# Run the cross-platform test suite (Linux CI)
npm test

# Run the macOS-only launchd integration smoke test
npm run test:macos
```

Tests use Node's built-in `node:test` runner. No external dependencies.
The launchctl and `pi` calls are stubbed via PATH overrides; the test
suite does not touch the user's real data dir or LaunchAgents.

The current suite has **286 tests** across the CLI, catalog, extension,
backends, runner, and transcript behavior (the macOS-only launchd smoke test
is run separately via `npm run test:macos`).

## License

MIT
