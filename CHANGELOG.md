# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `pi-tick add --when '<shell cmd>' [--when-timeout SECONDS]`: a guard that runs before each fire (cwd = the job's, 60s default limit). Exit 0 runs the agent; exit 1 records the run as `skipped` (no agent, no transcript, no `--on-complete`); any other exit, a signal, a spawn error or a timeout records `guard_failed`. The guard's stdout (64 KiB cap) replaces `{{when.stdout}}` in a pi prompt as literal text, and is in `PI_TICK_WHEN_STDOUT` for command jobs and `--on-complete`. CLI-only (#66).
- `pi-tick run --manual` runs the guard; `--no-when` bypasses it.
- `pi-tick log` hides `skipped` runs by default with a count of how many; `--all` shows them.
- `doctor` reports a job whose last run was `guard_failed` as `failing`; `skipped` and `guard_failed` count as fires, so guarded jobs are not flagged `overdue`. `pi-tick show` prints a job's guard.
- `pi-tick doctor [id] [--fix] [--json]` finds enabled jobs that silently stopped firing: a missing, unloaded or changed launchd/cron entry, a baked node, CLI, pi, `cwd` or `--on-complete` path that no longer exists (e.g. after an nvm or mise node upgrade), a missed expected fire, or a failing last run. `--fix` re-registers the repairable ones with freshly resolved paths. Also `/tick doctor` (#61).
- `pi-tick list` shows `stale` or `overdue` for enabled jobs doctor would flag.
- On `session_start`, the extension shows one notice when tick jobs need attention.
- `enable` records what it registered (`registration` in `jobs.json`), and both backends gain a read-only `status(id)`.

### Docs
- README brought up to date with 0.2.x: agent adapters, `kill`, `show --run-id`, `add` runtime-limit/`--agent`/`--on-complete` flags, `tick_create` runtime args, run `reason` values, token-limit failures on pi 1.1+, log rotation, test count.

## [0.2.1] - 2026-11-22

### Changed
- Tested against pi 1.6: `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` are now dev dependencies at `^1.6.0` (the lockfile had pinned pi 0.79.5), so tests and Renovate track current pi.
- With pi 1.1 or later, a run whose reply is cut off at the model's output token limit is recorded as failed: `pi -p` now exits 1 there and pi's warning becomes the run error. Earlier pi versions exited 0 and the run was recorded as a success.
- `pi-tick run --manual` prints a notice on stderr when it is still waiting for an `--on-complete` callback after a second, instead of looking hung for up to 30s.

### Fixed
- `pi-tick add --on-complete` rejects a path that does not exist, is not a file, or is not executable, instead of only failing later in `logs/<id>.callback.log`.

### Docs
- README: a prompt starting with `--` needs the `--prompt='--foo'` form.

## [0.2.0] - 2026-11-22

### Added
- `pi-tick add --agent command`: run the prompt as a `/bin/sh` command line with no model; exit code decides success and the last stdout line is the summary. CLI-only, not exposed to `tick_create`.
- `pi-tick add --on-complete <abs path>`: run an executable after each run with the run record on stdin. Starts after the run is recorded and inactive, 30s limit, output in `logs/<id>.callback.log` (pruned with the other job logs). CLI-only.
- `scripts/install.mjs` (`npm run install:cli`): install the CLI from a source checkout without opening a pi session.

### Changed
- Jobs run with `PWD` set to the job's cwd.
- Internal: pi invocation (argv plan and RPC/JSON event lifecycle) moved from `runner.mjs` into an agent adapter, `bin/agents/pi.mjs`, behind `agentAdapter()` in `bin/agents/index.mjs`. No behaviour change. Adapter layout adapted from the [samwei12/pi-tick](https://github.com/samwei12/pi-tick) fork (MIT).

### Fixed
- Slash-command (RPC) jobs: `agent_end` with `willRetry` no longer closes pi's stdin, so pi's own retry can finish the run.
- A run whose last assistant message stopped with `aborted` or `toolUse` is now recorded as `model_error` (only `error` was before), when pi exits 0.
- `lastRun.finalTextPreview` now always reflects the last assistant message; a final message with no text no longer shows an earlier message's text.
- Prompts starting with `-` or `@` (e.g. `-x foo`, `--help`, `@file`) are now delivered to pi as the message instead of being parsed as options or file arguments (#41).

## [0.1.6] - 2026-11-12

### Changed
- Interval offsets are rendered as calendar entries on launchd and cron (no more extra hourly runs on launchd; cron now supports offsets); intervals a backend can't express are rejected at add time. `next-fire` accounts for offsets (#24, #27).
- A second run of a job that is already running is refused (manual: exit 5; scheduler: exit 0 with a note). `pi-tick run` stopped by SIGTERM/SIGINT records `terminated` (#26).
- `runs.jsonl` rotates to `runs.jsonl.1` above 10 MB; `show` reads at most the last 32 MB of a transcript (#31).

### Fixed
- Runtime limits (`--timeout-ms`, `--idle-timeout-ms`, `--kill-grace-ms`, `--max-output-bytes`) reject empty, non-integer and out-of-range values; timer delays are capped at 2^31-1 ms so huge values no longer fire after ~1 ms (#20).
- The runner no longer crashes with EPIPE when pi closes stdin early on slash-command jobs, parses a final stdout line without a trailing newline, and records `spawn_error` only when the child never started (#21).
- Catalog lock: stale-lock reaping is serialized and identity-checked, and a holder only releases its own lock, so concurrent runs no longer lose catalog updates (#22).
- The test suite no longer writes run records into the real `~/.pi/agent/tick/runs.jsonl`; tests refuse to use a data directory under the real `~/.pi` (#23).
- One-shot jobs only run within 1 minute before to 24 hours after their time; missed slots are recorded as `once_missed` and their scheduler entry removed, so they no longer fire a year later (#25).
- A corrupt `config.json` no longer breaks runs or consumes one-shot jobs (#29).
- `kill` stops the whole process group; the runner no longer hangs on descendants holding stdout; run detection no longer matches prefixed ids or reused PIDs (#26).
- CLI: bare `--model` and bare schedule flags are rejected, boolean flags no longer swallow the job id, `--` ends options, a failed `add --enabled` is rolled back, and `/tick` commands show CLI errors instead of false success; `--cwd` must be a directory (#28).
- Size-based transcript pruning keeps the newest transcript; transcripts are ordered by their start time; `LOG_RETENTION_DAYS=0` no longer deletes the current log (#31).
- `log` no longer warns about a malformed first line, and multi-byte characters at read boundaries are preserved (#30).

## [0.1.5] - 2026-11-12

### Changed
- Runs that end because the model returned an error (Pi exits 0) are now recorded as failed: `reason: "model_error"`, exit code 1, with the error message (#13).
- Runs stopped with `pi-tick kill` are recorded as `reason: "killed"` (exit code 143) instead of `signal` (#16).
- `pi-tick run <id> --manual` now runs disabled jobs; scheduler-triggered runs still skip them (#15).

### Fixed
- `delete` removes a disabled job's `.plist.disabled` file on launchd, and `delete <id>` cleans up orphaned plist files for that id (#14).

## [0.1.4] - 2026-11-12

### Added
- `--timeout-ms 0` (and `timeoutMs: 0`) disables the per-job wall-clock
  timeout. The default remains 30 minutes.

### Fixed
- `scripts/sync-cli.mjs` now syncs every bundle file (via `listBundleFiles()`),
  not a hand-maintained subset, so the dev sync no longer leaves the installed
  CLI stale.
- Execute the Pi launcher directly so Homebrew shell wrappers, npm shebang
  entry points, and native executables work under launchd and cron. Arguments
  remain separate and are never interpolated into a shell command.

Thanks to @arjunprakash027 (launcher fix) and @gosvig123 (sync-cli and timeout opt-out) for the original implementations.

## [0.1.3] - 2026-10-02

### Added
- One-shot (`once`) schedules with absolute, minute-precision ISO-8601 timestamps.
- Atomic at-most-once claiming for externally triggered one-shot jobs.

Thanks to @vicgarcia for the original implementation.

## [0.1.2] - 2026-07-22

### Changed
- Schedule construction, validation, normalization, and next-fire calculation
  now live in one deep Schedule module shared by CLI callers and both scheduler
  backends.
- Schedule behavior tests now live in a dedicated test module.

## [0.1.1] - 2026-07-22

### Fixed
- Synchronous process spawn failures are now recorded in `runs.jsonl` and the
  job's `lastRun`, so they remain visible through `pi-tick log`.
- Failed transcript setup now marks the run as failed and no longer reports a
  transcript path unless the file exists.

## [0.1.0] - 2026-07-15

### Added
- **Linux / cron backend.** `pi-tick` now runs on Linux via the user's
  crontab, alongside the existing macOS launchd backend. `enable` /
  `disable` / `delete` dispatch to whichever backend is active
  (override with `PI_TICK_BACKEND=launchd|cron` for testing). Minimum
  interval is platform-aware: 5s on darwin, 60s on cron (cron's
  smallest unit is one minute).
- **`/tick kill <id>`** and **`pi-tick kill <id>`** — terminate a
  running job and everything it recursively spawned (SIGTERM, then
  SIGKILL after a configurable grace period).
- **`/tick enable <id>`** and **`/tick disable <id>`** slash commands
  — the CLI verbs already existed; they're now reachable from inside
  a Pi session, not just the terminal.
- **Per-job runtime controls**: `--timeout-ms`, `--idle-timeout-ms`,
  `--max-output-bytes`, `--kill-grace-ms` on `pi-tick add` / `tick_create`,
  so a job can override the default 30-minute wall-clock cap, opt into
  an idle timeout, cap transcript size, or tune the SIGTERM→SIGKILL
  grace period.
- **Interval start offset (phase)** — `--offset-minutes` /
  `--offset-seconds` stagger an interval job's first fire so two jobs
  of the same cadence don't race. Not supported on the cron backend
  (cron has no phase primitive).
- **Transcript persistence.** Every run writes a per-job JSONL copy of
  `pi`'s full event stream to `runs/<jobId>/<timestamp>_<runId>.jsonl`,
  retained for 7 days or 500 MB per job (oldest-first), whichever comes
  first.
- **`pi-tick show <id> [--run N] [--tail M] [--raw] [--no-meta]`** —
  chat-style transcript viewer: user prompt, agent thinking, tool
  calls/results, and the final answer, with verbose JSON stripped.
  `--raw` emits one event per line for `jq` pipelines. Renders partial
  transcripts correctly for runs interrupted mid-turn (timeout, kill,
  output cap).
- **`pi-tick transcripts <id> [--limit N]`** — list transcript files
  for a job, newest first.
- **`pi-tick log --failed`** / **`--since <dur>`** — filter recent
  runs by exit status or recency (composable).
- **`pi-tick config`** subcommand for tick-scoped settings. Today:
  `default-model`, applied at run time when a job doesn't pin one.
- Prompts starting with `/tf:` or `/tf run` (saved taskflows) now run
  through Pi's RPC mode with only the taskflow tool enabled, so a
  scheduled run invokes the saved flow deterministically instead of
  letting an unconstrained model turn pick the wrong first tool.
- Run-record enrichment: `runs.jsonl` and `jobs.json`'s `lastRun` carry
  `transcriptPath`, `transcriptBytes`, `finalTextPreview`, and the
  effective model used.

### Changed
- `/tick list` and `pi-tick list` schedule/timestamp columns now show
  humanized durations (`every 5m`, `every 1h 30m`) and local time
  instead of raw seconds and UTC.
- The macOS-specific plist + launchctl code moved to
  `extensions/tick/bin/backends/launchd.mjs`; `pi-tick.mjs` now
  dispatches through a shared backend port (`register` / `unregister`
  / `unregisterAndDelete` / `listRegistered`, uniformly async) so a
  third backend has one shape to satisfy.
- `tick-core.mjs` (catalog I/O, validation, the run controller,
  formatters, the dispatcher) was split into `catalog.mjs`,
  `runner.mjs`, `transcript-view.mjs`, and `run-registry.mjs`, each
  scoped to one concern; the standalone CLI bundle synced to
  `~/.pi/agent/tick/` is now derived from that file set instead of
  hand-listed, so a future module split can't silently break a
  launchd/cron-fired run.
- `pi-tick.mjs` no longer blanket re-exports tick-core's internals —
  only `dispatch` and `PiTickError`, what the CLI wrapper itself needs.
- The per-job default timeout/idle-timeout/max-output-bytes/kill-grace
  values now live in one place (`RUNTIME_DEFAULTS` in `catalog.mjs`)
  instead of two drifting copies.
- The output cap (`--max-output-bytes`) is disabled by default; opt in
  per job.

### Fixed
- launchctl spawn failures (missing/non-executable binary) now surface
  the real OS error instead of a generic "unknown error".
- Scheduled jobs get a robust `PATH` baked into the plist/crontab entry
  at enable time, so tools resolved interactively (Homebrew, `~/.local/bin`,
  version-manager shims) are still found when launchd/cron fires with a
  minimal environment.
- `extractStderrSignature` scans bottom-up so a startup warning
  (e.g. `ExperimentalWarning`) printed before the real exception no
  longer masks it in the run record's `error` field.
- `--max-output-bytes` enforcement is byte-accurate (was previously
  capping by character count, which could write more bytes than the
  cap allowed and corrupt a multi-byte character split across a chunk
  boundary).
- The escalation (SIGTERM→SIGKILL) timer is cleared on a fast child
  exit, preventing an event-loop leak.
- `cmdEnableInternal`'s rollback path handles both the sync (launchd)
  and async (cron) `unregister` return shape.
- The catalog lock's stale-lock timeout now sits safely below the
  acquire timeout, so a contender arriving just after a crash doesn't
  time out for no reason.
- The cron backend's `register` no longer throws when `opts.logsDir`
  is omitted; it falls back to the default logs directory.

