# Pi Tick

> Persistent scheduled agent tasks for [Pi](https://pi.dev), backed by
> launchd (macOS) or cron (Linux).

Register a prompt + a schedule, and `pi-tick` fires it via your OS's
native scheduler. The runner spawns `pi` in a fresh session (or, for
[command jobs](#command-jobs---agent-command), a plain shell command), captures
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
- launchd or cron fires the job at the scheduled time; the runner streams the full
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
#    From a source checkout you can instead run `npm run install:cli`
#    (scripts/install.mjs): it syncs the CLI without opening a pi session
#    and symlinks it into ~/.local/bin (override with PI_TICK_BIN_DIR).

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
pi-tick run nightly-recap --manual

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
| `pi-tick list [--json]` | Print all jobs as a table (or JSON). An enabled job shows `stale` or `overdue` instead of `scheduled` when `doctor` would flag it. |
| `pi-tick delete <id>` | Remove a job (also unloads its plist if enabled). For a worktree-isolated job, also removes leftover worktree directories; its `tick/<id>/*` branches are kept and listed with the command to delete them. |
| `pi-tick enable <id>` | Register / re-register the launchd plist. Idempotent; skips re-registering a job that is currently running. |
| `pi-tick disable <id>` | Unload the plist and rename it to `.plist.disabled`. |
| `pi-tick run <id> [--manual [--no-when]]` | Fire a job. With `--manual` it runs even if the job is disabled (and runs its `--when` guard; `--no-when` bypasses it); without it (scheduler path) disabled jobs are skipped with exit 0. Only one run per job at a time: a start while the job is already running is refused (exit 5 with `--manual`, exit 0 from the scheduler). SIGTERM/SIGINT to the runner kills pi's process tree and records the run as `terminated` (exit 143). |
| `pi-tick kill <id> [--grace-ms N]` | Terminate a running job's process group: SIGTERM, then SIGKILL after the grace period (default 5s). The run is recorded as `killed` (exit 143). |
| `pi-tick log [id] [--limit N] [--failed] [--since <dur>] [--all]` | Tail the run log. `--failed` keeps only non-zero exits; `--since` keeps runs in the last `<dur>` (`30s`/`5m`/`2h`/`1d`). `skipped` runs (a `--when` guard found nothing to do) are hidden, with a count; `--all` shows them. |
| `pi-tick transcripts <id> [--limit N]` | List transcript files for a job, newest first. |
| `pi-tick show <id> [--run N\|--run-id <id>] [--tail M] [--raw] [--no-meta]` | Chat-style view of a transcript (default: latest). `--run N` picks the Nth most recent; `--run-id` picks a run shown by `pi-tick log`. `--tail M` keeps the last M assistant turns. `--raw` emits JSONL events, one per line (`event:` prefix for `jq` pipelines). `--no-meta` skips the run header. |
| `pi-tick show <id> --diff [--run-id <id>]` | Print `git diff <baseSha>..<branch>` for the job's most recent run that produced a branch (or the named run). See [Worktree isolation](#worktree-isolation---isolate-worktree). |
| `pi-tick config <set\|get\|unset> <key> [value]` | Read or write tick-scoped config. Keys: `default-model` (see below) and `worktree-dir` (an absolute path; see [Worktree isolation](#worktree-isolation---isolate-worktree)). |
| `pi-tick doctor [id] [--fix] [--json]` | Find enabled jobs that silently stopped firing (see below). Exits 1 when any job needs attention. |
| `pi-tick help` | Print usage. |

Flags for `add`:
- `--prompt "..."` — required (≤ 16 KB). A prompt that itself starts with `--`
  must use the `=` form, `--prompt='--foo bar'`; otherwise `--foo` is read as a
  flag. Prompts starting with `-` or `@` reach pi unchanged (#41).
- `--cwd <abs path>` — required, must exist
- `--kind interval|daily|weekly|once` — required
- `--minutes N --seconds N` — for `interval` (min total 5s; see "Interval support" below)
- `--offset-minutes N --offset-seconds N` — optional phase for `interval` (see "Interval support")
- `--at ISO-8601` — for `once`; absolute future timestamp with `:00` seconds (an optional `.000` is accepted; other fractional seconds are not)
- `--time HH:MM` — for `daily` and `weekly` (24h)
- `--days mon,wed,fri` — for `weekly` (comma-separated, case-insensitive)
- `--model <id>` — optional, passed to `pi` as `--model` (rejected for command jobs)
- `--agent pi|command` — optional, default `pi`; see [Command jobs](#command-jobs---agent-command). CLI-only.
- `--on-complete <abs path>` — optional executable run after each run; see [Completion hook](#completion-hook---on-complete). CLI-only.
- `--when "<shell cmd>"` — optional guard run before each fire; see [Guard commands](#guard-commands---when). CLI-only.
- `--when-timeout SECONDS` — optional, with `--when`; default 60.
- `--isolate worktree` — optional; run each fire in its own git worktree and keep the result on a branch. Needs `--base`; see [Worktree isolation](#worktree-isolation---isolate-worktree). CLI-only.
- `--base <ref>` — required with `--isolate`: the branch, tag or commit each worktree is cut from.
- `--worktree-dir <abs path>` — optional, with `--isolate`: root for this job's worktrees.
- `--setup "<shell cmd>"` — optional, with `--isolate`: prepares each fresh worktree (`npm ci`, copy `.env`).
- `--setup-timeout SECONDS` — optional, with `--setup`; default 300.
- `--enabled` — also register the schedule (launchd plist / crontab entry) in the same call

Runtime limits (all optional, in ms/bytes; `0` disables where allowed):

| Flag | Default | Effect |
|---|---|---|
| `--timeout-ms N` | 30 min | Wall-clock cap; the run is recorded as `timeout` (exit 124). |
| `--idle-timeout-ms N` | off | Cap on time with no stdout/stderr output (`idle_timeout`). |
| `--max-output-bytes N` | off | Transcript size cap; the child is killed when exceeded. |
| `--kill-grace-ms N` | 5000 | Delay between SIGTERM and SIGKILL (must be ≥ 1). |

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

### Agents

Each job runs through an agent adapter (`extensions/tick/bin/agents/`):

- `pi` (default) — runs `pi --mode json` (or `--mode rpc` for `/slash`
  prompts) with the job's prompt and model.
- `command` — runs the prompt as a shell command line, no model (below).

### Command jobs (`--agent command`)

`pi-tick add <id> --agent command --prompt "<shell command line>" ...` runs the
prompt with `/bin/sh -c` in `--cwd`, with no model. Command jobs share
schedules, timeouts, kill, the run log and transcripts with pi jobs:

- The exit code decides success.
- The last non-empty stdout line becomes the run summary (`finalTextPreview`),
  and the error text when the command fails with nothing on stderr.
- `pi-tick show` prints the output verbatim.
- `--model` is rejected.

Command jobs are CLI-only: the `tick_create` tool cannot choose an agent, so a
model cannot schedule a shell command.

### Completion hook (`--on-complete`)

`pi-tick add <id> --on-complete /abs/path/to/executable ...` runs that
executable after every run of the job, in the job's cwd, with the run record
(the `runs.jsonl` line) as JSON on stdin.

- It starts after the run is recorded and no longer active, so it cannot
  block `pi-tick kill` or the next run.
- It never changes the run's recorded outcome. It is killed with its process
  group after 30s.
- The path must exist and be executable when the job is added.
- `pi-tick run --manual` waits for it before exiting and, if it is still
  running after a second, says so on stderr.
- Its stdout/stderr go to `logs/<id>.callback.log`, which is rotated and aged
  out with the scheduler logs and removed by `pi-tick delete`.

Like command jobs, it is CLI-only: `tick_create` has no field for it.

### Guard commands (`--when`)

Many scheduled runs have nothing to do. `--when` adds a cheap shell check
that runs before the agent, so an idle tick costs no `pi` spawn and no tokens:

```sh
pi-tick add triage \
  --when 'out=$(gh issue list --label new --json number,title -q ".[] | \"#\(.number) \(.title)\""); [ -n "$out" ] && echo "$out"' \
  --prompt "Triage these issues: {{when.stdout}}" \
  --cwd ~/code/app --kind interval --minutes 5 --enabled
```

The guard must signal "nothing to do" with its exit status: here `[ -n "$out" ]`
fails on an empty list, so `echo` is not reached and the guard exits 1. Before
each fire the runner runs the command with `/bin/sh -c` in the job's
cwd (60s limit; `--when-timeout SECONDS` changes it). Its exit status decides:

| Guard exit | Run recorded as | Agent |
|---|---|---|
| `0` | normal run | spawned; the guard's stdout is available to it |
| `1` | `skipped` (exit code 0) | not spawned, no transcript, no `--on-complete` |
| anything else, a signal, a failure to start, or the timeout | `guard_failed` (exit code 1, with the reason in `error`) | not spawned, no `--on-complete` |

Using the guard's stdout:

- In a pi prompt, `{{when.stdout}}` is replaced by the stdout (trailing
  newline trimmed). It is inserted as literal text and not expanded again, so
  stdout containing `{{...}}` is safe. A prompt of a job with no guard (or run
  with `--no-when`) gets an empty string.
- For `--agent command` jobs and `--on-complete`, stdout is never pasted into
  command text. It is in the environment as `PI_TICK_WHEN_STDOUT`.
- stdout is capped at 64 KiB (a marker line is appended when it is cut); only
  a short stderr tail is kept, in `error` of a `guard_failed` record.

Other behavior:

- `pi-tick run <id> --manual` runs the guard too; `--no-when` runs the agent
  anyway (`{{when.stdout}}` is empty). `--no-when` requires `--manual`.
- While the guard runs the job counts as running: an overlapping tick is
  refused and `pi-tick kill` stops the guard.
- A `skipped` or `guard_failed` run is a fire as far as `list` and `doctor`
  are concerned, so a guarded job that is mostly idle is not reported as
  `overdue`. A skip does not replace the job's last run, so an earlier failure
  stays visible. `doctor` does report a job whose last run was `guard_failed`
  (`failing`), since its agent never runs.
- `pi-tick log` hides `skipped` rows by default (`--all` shows them);
  `guard_failed` rows are always shown. `pi-tick show` prints the guard.
- Like `--agent command` and `--on-complete`, it is CLI-only: `tick_create`
  has no field for it.

### Worktree isolation (`--isolate worktree`)

By default the agent runs in the job's `cwd`: the same checkout you work in.
`--isolate worktree` gives every run its own git worktree instead, so a bad
run costs you a branch to delete rather than a damaged working tree, two jobs
on one repo cannot collide, and what a run changed is a diff to review.

```sh
pi-tick add nightly-deps --isolate worktree --base main \
  --setup 'npm ci' \
  --prompt "Update outdated deps and fix what breaks" \
  --cwd ~/code/myproject --kind daily --time 02:00 --enabled
```

For each fire the runner:

1. runs the `--when` guard, if any, exactly as without isolation, in the job's
   `cwd`. `skipped` and `guard_failed` runs never create a worktree;
2. resolves `--base` to a commit and creates a detached worktree of it at
   `<root>/<jobId>/<runId>` (`git worktree add --detach`). If that fails the
   run is recorded as `worktree_failed` and no agent is started;
3. runs `--setup` there (see below). A non-zero exit, a signal or the timeout
   records `setup_failed`, removes the worktree and starts no agent;
4. runs the agent with the worktree as its working directory. If the job's
   `cwd` is a subdirectory of the repository, the agent starts in the same
   subdirectory of the worktree. The environment has `PI_TICK_WORKTREE` (the
   worktree root) and `PI_TICK_SOURCE_CWD` (the job's `cwd`); `--setup` and
   `--on-complete` get them too;
5. whatever the outcome (success, failure, timeout, `pi-tick kill`, runner
   SIGTERM), stages everything (`git add -A`), commits it with
   `git commit --no-verify` as `pi-tick <pi-tick@localhost>` (message
   `pi-tick: <jobId> run <runId> (<reason>)`) and creates the branch
   `tick/<jobId>/<runId>` at HEAD. Commits the agent made itself are kept and
   the branch points at the final HEAD. A run that changed nothing and
   committed nothing gets **no branch**. Git hooks and commit signing are off
   for pi-tick's own git calls;
6. removes the worktree.

The run record then says what happened (see the tables below), and
`--on-complete` receives it on stdin, so a hook can open a PR from `branch`.
`pi-tick show <id> --diff` prints the diff of the latest branch,
`pi-tick log` shows the branch next to the run, and
`pi-tick run <id> --manual` prints it on stderr.

**Where worktrees live.** The root is, in order of precedence, the job's
`--worktree-dir`, the global `pi-tick config set worktree-dir <abs path>`, or
`<dataDir>/worktrees` (follows `PI_TICK_DATA_DIR`). The runner always appends
`<jobId>/<runId>`, so runs never share a directory. Reasons to override: a
monorepo layout, a bigger volume, or macOS TCC: a root under `~/Documents`
or `~/Desktop` needs the same one-time interactive run (`pi-tick run <id>
--manual`) as any other protected folder, because launchd cannot show the
permission dialog.

**Setup.** A fresh worktree has the tracked files of `--base` and nothing
else: no `node_modules`, no `.env`. `--setup` is a shell command run via
`/bin/sh -c` in the worktree (300s limit, or `--setup-timeout SECONDS`),
before the agent:

```sh
--setup 'npm ci'
--setup 'cp "$PI_TICK_SOURCE_CWD/.env" .env && npm ci'
```

Untracked files that exist after setup (a copied `.env`, an installed
dependency directory that `.gitignore` does not cover) are **not** committed:
only what the agent changes afterwards is. Setup output is not kept; on
failure the last stderr line is in the run's `error`.

**Cleanup and retention.** The worktree is removed right after each run, so
nothing accumulates. Only a runner that was killed hard (SIGKILL, power loss)
leaves one behind; the next run of that job sweeps leftover directories older
than 7 days, and `pi-tick delete` removes them all. If the final commit or
branch cannot be created, the worktree is kept so the work is not lost, and
`worktreeError` in the run record names its path.

**`tick/*` branches are never deleted by pi-tick**: not by retention, not by
`pi-tick delete`, which instead prints the command that removes them. Review,
merge or delete them yourself:

```sh
git -C ~/code/myproject branch --list 'tick/nightly-deps/*'
git -C ~/code/myproject branch -D $(git -C ~/code/myproject for-each-ref --format='%(refname:short)' refs/heads/tick/nightly-deps/)
```

`add` checks that `cwd` is inside a git work tree, that `--base` resolves to a
commit, that `--worktree-dir` is absolute and that the job id can be part of
a branch name. `doctor` reports an isolated job (status `stale`) whose `cwd`
is no longer a repository, whose `--base` no longer resolves, or whose
configured root (the job's, else the config's) is missing or not writable
(the default root is created on demand), and (status `failing`) one whose last
run was `worktree_failed` or `setup_failed`.

Like `--agent command`, `--on-complete` and `--when`, isolation is CLI-only:
`tick_create` has no field for it. Command jobs honour it too (they run in the
worktree).

### Silent-stop detection (`doctor`)

`enable` bakes absolute paths into the scheduler entry, so a node upgrade via
nvm or mise, a moved repo, or a hand-edited plist/crontab can stop a job
without any error. `pi-tick doctor` checks every enabled job (or one `id`):

| Status | Meaning |
|---|---|
| `stale` | The launchd/cron entry is missing, not loaded, differs from what `enable` registered, or a baked path is gone: node, the stable CLI, pi, `cwd`, `--on-complete`. For `--isolate worktree` jobs also: `cwd` is not a git work tree, `--base` no longer resolves, or a configured worktree root is missing or not writable. |
| `overdue` | The last run started before the previous expected fire. Calendar jobs get 10 minutes of grace; interval jobs tolerate one missed fire; plain launchd `StartInterval` jobs (no fixed phase) are overdue after two intervals plus 5 minutes. cron does not catch up after sleep, so a fire missed while asleep shows as `overdue`. |
| `failing` | The last run failed, including a `guard_failed` run (its `--when` guard crashed or timed out) and a `worktree_failed` / `setup_failed` run (the worktree or its `--setup` failed, so the agent never ran). A `skipped` run is healthy. |

`--fix` re-runs `enable` for jobs a fresh registration can repair (missing,
unloaded or changed entry, missing node or pi): it re-resolves node and pi
and rewrites the entry. Missing `cwd` or `--on-complete` must be fixed by
hand. On `session_start` the extension shows one notice when any job needs
attention.

### Inside a Pi session: `/tick`

| Command | Purpose |
|---|---|
| `/tick list` | Show all jobs (plain-text table). |
| `/tick run <id>` | Fire a job manually, even if disabled. The `RunRecord` is marked `triggerKind: "manual"`. |
| `/tick kill <id>` | Terminate a running job's process tree. |
| `/tick enable <id>` | Register the job with the active backend (launchd/cron) so it starts firing. |
| `/tick disable <id>` | Unregister the job from the backend without deleting it. |
| `/tick delete <id>` | Delete a job. |
| `/tick log [id]` | List recent runs. |
| `/tick show <id>` | Chat-style view of a job's latest transcript. |
| `/tick doctor [id]` | Check enabled jobs for silent stops (see above). |

Argument completion works for all of these.

### LLM-callable tools

| Tool | Args | Returns |
|---|---|---|
| `tick_create` | `jobId, prompt, cwd, scheduleKind, scheduleValue, enabled?, model?, timeoutMs?, idleTimeoutMs?, maxOutputBytes?, killGraceMs?` | The new job (JSON). `scheduleKind=once` uses `scheduleValue.at`; interval/daily/weekly remain recurring. |
| `tick_list` | — | The catalog as a JSON array. |
| `tick_delete` | `jobId` | Confirmation. |

`tick_create` always creates pi jobs: `agent`, `onComplete`, `when` and the
isolation options are CLI-only, so a model can neither schedule a shell
command nor attach a hook or a guard, nor choose where its runs happen.

The LLM can create-and-enable in one call by passing `enabled: true` to
`tick_create`. It cannot enable or disable existing jobs — to do that, the
agent must `tick_delete` and `tick_create` a new one with `enabled: true`.
This is intentional: a misbehaving prompt cannot enable a job the user
hasn't already approved by creating.

## How it works

```
LLM tool    ──┐
slash cmd   ──┼──►  extensions/tick/index.ts  ──spawn──►  pi-tick.mjs  ──spawn──►  pi or /bin/sh (agent adapter)
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
- **The Mac will not wake from sleep for a scheduled fire.** launchd has
  no wake-the-machine flag. What happens to a missed fire depends on the
  schedule kind:
  - `daily`, `weekly`, `once` and calendar-form intervals use
    `StartCalendarInterval`. A fire that falls while the Mac is asleep
    runs **once when it wakes**; several missed fires are coalesced into
    one. One-shot jobs more than 24h late are not run (see
    [One-shot schedules](#one-shot-schedules)).
  - Plain intervals use `StartInterval`. A fire due during sleep is
    skipped; the next one runs on schedule.
  - If the Mac was **powered off**, missed fires are not replayed.

  Unlike cron, which skips missed fires on suspend. If "fire even when
  asleep" is needed, that's a `pmset schedule` problem, out of scope here.
- **TCC pre-flight is required.** See the install step above. Without it,
  a launchd-fired run that needs to touch `~/Documents` or similar will
  be silently denied.
- **`launchctl bootstrap` requires a GUI session domain.** We use
  `gui/<uid>` where `uid` is `process.getuid()`. If the user is in a
  remote or non-GUI session, this won't work — but our use case assumes
  a normal desktop session.

### Interval support

Neither launchd's `StartInterval` nor cron can express "every N minutes
from a given phase" in general, so pi-tick renders only what it can do
exactly and rejects the rest with a clear error at `add` / `enable` time.

| Backend | No offset | With offset (`--offset-minutes`) |
|---|---|---|
| launchd | any interval ≥ 5s (`StartInterval`) | calendar form only (below); offset must be whole minutes and smaller than the interval |
| cron | 1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30 minutes (`*/N`) or 1, 2, 3, 4, 6, 8, 12, 24 hours (`0 */H`) | calendar form only (below) |

Calendar form: an interval of N minutes where 60 is divisible by N (minute
list every hour), or of H whole hours where 24 is divisible by H (hour list
at a fixed minute). Examples: `every 2h +1h` fires at 01:00, 03:00, ...;
`every 1h +30m` fires at :30; `every 3h +30m` fires at 00:30, 03:30, ....
With an offset launchd gets `StartCalendarInterval` only (never together
with `StartInterval`). Without an offset launchd jobs count from load/last
run, so the "next fire" shown is an approximation; calendar-form jobs show
the real next wall-clock time.

### Linux (cron)

- **User crontab, not system.** `pi-tick` adds entries to the **user's**
  crontab via `crontab -` (no `sudo` needed). Your other crontab
  entries are preserved; pi-tick's entries are marked with a
  `# pi-tick: <jobId>` comment so we only touch our own lines.
- **Minute granularity.** Cron's smallest unit is one minute. The
  minimum interval on Linux is **60 seconds** (vs. 5 seconds on
  macOS). Sub-minute cadences (e.g. `--seconds 30`) are rejected with
  a clear error at `pi-tick add` time, as are intervals that cron
  cannot render faithfully (see "Interval support" below).
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

## One-shot schedules

A one-shot job uses an absolute ISO-8601 timestamp and minute precision:

```sh
pi-tick add reminder \
  --prompt "Do the thing" \
  --cwd ~/project \
  --kind once \
  --at 2027-01-22T15:30:00Z \
  --enabled
```

The scheduler backend uses calendar fields and may technically match the same
month/day/time in a later year. The first external invocation atomically marks
the job consumed and disables it before starting Pi, so duplicate or stale
invocations cannot run the prompt again. Manual runs (allowed even after
consumption) do not consume or re-enable the schedule. Failed external runs remain consumed by design.

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
├── runs.jsonl                            # append-only audit log (mode 0600; rotates to runs.jsonl.1 above 10 MB)
├── config.json                           # tick-scoped config (default-model, worktree-dir)
├── pi-tick.mjs                           # stable copy of the CLI (mode 0755)
├── runs/                                 # per-job transcripts (mode 0700)
│   └── nightly-recap/                    # one dir per job
│       └── 2026-06-15T02-00-04-123Z_7c8a1234.jsonl
├── worktrees/                            # --isolate worktree runs (default root; removed after each run)
│   └── nightly-deps/7c8a1234/            # <jobId>/<runId>
└── logs/                                 # scheduler + hook output (mode 0700)
    ├── nightly-recap.out.log
    ├── nightly-recap.err.log
    └── nightly-recap.callback.log        # --on-complete output

~/Library/LaunchAgents/
└── dev.pi.tick.<jobId>.plist             # one per enabled job (macOS)
```

**Log retention:** each per-job log file (`.out.log`, `.err.log`,
`.callback.log`) is deleted once older than 7 days, and rotated to `<file>.1`
when larger than 50 MB. Override with `PI_TICK_LOG_RETENTION_DAYS` and
`PI_TICK_LOG_MAX_BYTES`. `PI_TICK_*` overrides set when you run `enable`
(`PI_TICK_DATA_DIR`, `PI_TICK_LOG_*`, `PI_TICK_RUNS_MAX_BYTES`, …) are baked
into the plist / crontab line, so scheduled runs see them; re-run `enable`
after changing them.

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
- `schedule` — one of `interval` (≥ 5s on launchd, ≥ 60s on cron), `daily` (HH:MM), `weekly` (days + HH:MM), `once` (ISO-8601 `at`).
- `enabled` — boolean. **Default `false` on `add`.**
- `model` — optional; passed to `pi` as `--model`.
- `piPath` — internal; set by `enable` after resolving `which pi`.
- `nodePath` — internal; the node binary `enable` baked into the entry.
- `registration` — internal; `{ backend, fingerprint, registeredAt }` written
  by `enable`. `fingerprint` hashes the rendered plist or cron line so
  `doctor` can detect an entry that changed since. Jobs enabled before
  `doctor` existed have none; re-enable them to record one.
- `agent` — optional; `"command"` for command jobs. Absent means pi.
- `onComplete` — optional; absolute path of the `--on-complete` executable.
- `when`, `whenTimeout` — optional; the `--when` guard command and its limit
  in seconds (absent means 60).
- `isolate`, `base`, `worktreeDir`, `setup`, `setupTimeout` — optional;
  `--isolate worktree` and its `--base`, `--worktree-dir`, `--setup` and
  `--setup-timeout` (seconds; absent means 300). `isolate` and `base` are set
  together; the others only when given.
- `timeoutMs`, `idleTimeoutMs`, `maxOutputBytes`, `killGraceMs` — runtime
  limits; `null` means the runner's default.
- `lastSkippedAt` — written when a `--when` guard skips a run. A skip never
  replaces `lastRun`, so it cannot hide an earlier failure; `doctor` counts it
  as the job's latest fire.
- `lastRun` — written by the runner; `null` until first run. Carries the
  same fields as a `RunRecord` (see below) plus `transcriptPath` and
  `finalTextPreview` so a fresh `pi-tick show <id>` can render the latest
  transcript without re-scanning `runs.jsonl`.
- `version` — always `1` in Phase 1.

### `runs.jsonl`

One JSON object per line, append-only:

```json
{"runId":"7c8a1234","jobId":"nightly-recap","triggerKind":"external","startedAt":"2026-06-15T02:00:04.123Z","finishedAt":"2026-06-15T02:00:47.890Z","exitCode":0,"reason":"exit_code","error":null,"model":"claude-sonnet-4-5","tokens":{"input":1234,"output":567},"transcriptPath":"/Users/me/.pi/agent/tick/runs/nightly-recap/2026-06-15T02-00-04-123Z_7c8a1234.jsonl","transcriptBytes":12083,"finalTextPreview":"Done. Wrote .scratch/recap.md."}
```

- `triggerKind` — `"external"` (launchd/cron) or `"manual"` (`/tick run` or `pi-tick run --manual`; `pi-tick run` without `--manual` is `"external"`).
- `reason` — why the run ended: `exit_code`, `signal`, `spawn_error`,
  `model_error`, `taskflow_failed`, `timeout`, `idle_timeout`, `killed`,
  `terminated`, `output_cap`, `once_missed`, `skipped`, `guard_failed`,
  `worktree_failed` or `setup_failed`. `skipped` and `guard_failed` come from
  a `--when` guard (`skipped` has exit code 0); `worktree_failed` and
  `setup_failed` from `--isolate worktree`. None of these four has a
  transcript, and no agent ran. `error` holds the message (≤ 200 chars) when
  `exitCode` is non-zero.
- `agent` — present only for non-pi jobs (`"command"`).
- Worktree-isolated jobs (`--isolate worktree`) add, to every run that got as
  far as creating (or trying to create) a worktree, failed runs included:

  | Field | Meaning |
  |---|---|
  | `isolate` | `"worktree"`. |
  | `baseRef` | The `--base` as given. |
  | `baseSha` | The commit it resolved to for this run (`null` if it did not resolve). |
  | `branch` | `tick/<jobId>/<runId>`, or `null` when the run changed and committed nothing. |
  | `diffstat` | `{ filesChanged, insertions, deletions }` of `git diff --shortstat baseSha..branch`; `null` without a branch. |
  | `worktreeError` | Only when committing, branching or removing the worktree failed. The run's own outcome is unchanged and the record is still written. |

  `job.lastRun` carries `branch` too.
- A pi run counts as failed (`model_error`) when pi exits 0 but the last
  assistant message stopped with `error`, `aborted` or `toolUse`. With pi
  1.1+, a reply cut off at the model's output token limit makes `pi` exit 1,
  so the run is recorded as failed with pi's warning as the error.
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

Tests use Node's built-in `node:test` runner and run against pi 1.6
(`@earendil-works/pi-coding-agent` / `pi-ai` dev dependencies).
The launchctl and `pi` calls are stubbed via PATH overrides; the test
suite does not touch the user's real data dir or LaunchAgents.

The current suite has **532 tests** across the CLI, catalog, extension,
backends, runner, and transcript behavior (the macOS-only launchd smoke test
is run separately via `npm run test:macos`).

## License

MIT
