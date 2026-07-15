# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

