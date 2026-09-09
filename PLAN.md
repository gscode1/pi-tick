# One-Shot (`once`) Scheduling Plan

## Goal

Add a first-class `once` schedule frequency to this fork of `pi-tick`.

This should be a reliable, explicit replacement for the current pattern of:

1. creating a recurring schedule,
2. running the job, and
3. deleting the job after its first execution.

The feature is initially for personal use in this fork. We will not open an upstream issue or pull request until it has been exercised successfully for several weeks.

## Proposed user-facing interface

### CLI

```sh
pi-tick add reminder \
  --prompt "Do the thing" \
  --cwd ~/project \
  --kind once \
  --at 2026-07-22T15:30:00Z \
  --enabled
```

`--at` will use an absolute ISO-8601 timestamp. The initial implementation should require minute precision (`seconds = 0`, no fractional milliseconds), because both supported operating-system backends have minute-oriented calendar scheduling behavior.

### LLM tool

```json
{
  "jobId": "reminder",
  "prompt": "Do the thing",
  "cwd": "/home/me/project",
  "scheduleKind": "once",
  "scheduleValue": {
    "at": "2026-07-22T15:30:00Z"
  },
  "enabled": true
}
```

The `tick_create` schema and guidance must clearly distinguish one-shot jobs from recurring jobs.

## Semantics

A once job is registered like any other enabled job, but the first scheduled/external execution consumes it.

Execution flow:

1. The scheduler invokes `pi-tick run <id>`.
2. The runner atomically claims the once job under the existing catalog lock.
3. The job is marked consumed/disabled before the prompt starts.
4. Its launchd/cron registration is removed on a best-effort basis.
5. The prompt executes once.
6. Any stale or duplicate scheduler invocation sees the consumed state and does not execute the prompt again.

The intended guarantee is **at most once**, including when the first execution fails. A failed one-shot run must not silently execute again.

Manual execution should not consume the schedule. `/tick run <id>` and `pi-tick run <id> --manual` are testing/interactive operations; the scheduled execution should remain available afterward.

## Catalog shape

A new schedule uses the existing schedule field:

```json
{
  "schedule": {
    "kind": "once",
    "value": {
      "at": "2026-07-22T15:30:00.000Z"
    }
  },
  "enabled": true,
  "onceConsumedAt": null
}
```

After the external claim:

```json
{
  "enabled": false,
  "onceConsumedAt": "2026-07-22T15:30:01.123Z"
}
```

`onceConsumedAt` is the durable guard against repeated fires from stale scheduler registrations. Existing jobs and old catalog shapes must remain readable.

## Implementation areas

### Schedule module

Update `extensions/tick/bin/schedule.mjs`:

- Add `KIND_ONCE`.
- Add `once` to `VALID_KINDS`.
- Validate absolute ISO-8601 timestamps.
- Reject timestamps that are not in the future when creating/enabling.
- Initially require minute precision.
- Extend `buildSchedule()`.
- Extend `resolveScheduleFields()`.
- Extend `nextFireAt()`.

### CLI and creation API

Update `extensions/tick/bin/commands/add.mjs`:

- Accept `--at` for `--kind once`.
- Convert typed `scheduleValue.at` for the LLM tool.
- Initialize `onceConsumedAt` to `null`.

Update `extensions/tick/index.ts`:

- Add `once` to the `scheduleKind` enum.
- Add `at` to `scheduleValue`.
- Update tool description, prompt snippet, and prompt guidelines.

Update CLI help and README documentation.

### Execution lifecycle

Update `extensions/tick/bin/commands/run.mjs` and catalog helpers:

- Preserve the explicit manual/external trigger distinction.
- Add an atomic once-job claim helper using the existing catalog lock.
- Claim only external executions.
- Disable the job before calling `runJob()`.
- Unregister its active backend entry.
- Make stale invocations return without running.
- Avoid consuming a job if pre-run validation fails before execution can start.

The claim operation must be safe when two scheduler processes race. Only one caller may win.

### Backends

#### launchd

Render a calendar schedule for the timestamp's local month/day/hour/minute. launchd does not provide a portable one-time calendar primitive, so the catalog claim/disable guard is the correctness mechanism. A stale yearly recurrence must be harmless.

#### cron

Render month/day/hour/minute fields. Cron also has no portable one-time primitive and may technically match again in a later year; the consumed catalog state must prevent repeat execution.

Both adapters retain ownership of backend-specific rendering and constraints.

## Test plan

Add or update tests for:

### Schedule behavior

- `validateKind("once")`.
- Valid and invalid ISO timestamps.
- Past timestamps rejected.
- Sub-minute timestamps rejected initially.
- `buildSchedule("once", ...)`.
- `resolveScheduleFields()` for once schedules.
- `nextFireAt()` returns the requested timestamp.

### CLI/API

- CLI creation with `--kind once --at`.
- Invalid/missing `--at` errors.
- LLM tool schema and typed conversion.
- Catalog initialization with `onceConsumedAt: null`.

### Backend rendering

- launchd calendar rendering.
- cron calendar rendering.
- Backend-specific invalid schedule errors.
- Stale yearly recurrence does not execute a consumed job.

### Execution semantics

- Manual execution does not consume a once job.
- First external execution claims and disables it.
- Failed first execution remains consumed.
- Duplicate external execution does not spawn Pi.
- Concurrent claims allow only one execution.
- Backend unregister failure does not permit a second execution.
- Existing recurring jobs remain unchanged.

Run the normal suite with:

```sh
npm test
```

Run macOS-specific tests with:

```sh
npm run test:macos
```

## Documentation and release

Update:

- `README.md`
- CLI help text
- LLM tool descriptions/guidelines
- `CHANGELOG.md`
- This plan as decisions evolve

Use a fork-specific version bump, likely `0.2.0`, once the feature is complete and validated.

## Fork and installation workflow

1. Implement on a feature branch in this local clone.
2. Run the full test suite and exercise real jobs manually.
3. During development, install the checkout directly as a local Pi package:

   ```sh
   pi remove npm:pi-tick                 # avoid loading the released copy too
   pi install /home/vicg4rcia/code/pi-tick
   pi list
   pi-tick help
   ```

   A local-path install points Pi at the checkout, so code changes can be tested without publishing. Restart Pi (or reload the extension where supported) after changes. The `session_start` handler synchronizes the stable runner to `~/.pi/agent/tick/pi-tick.mjs`.

4. Create/push the GitHub fork when the implementation is ready.
5. Update `package.json` repository, bugs, and homepage URLs for the fork.
6. Configure `upstream` to point to `gscode1/pi-tick` and retain the fork as `origin`:

   ```sh
   git remote rename origin upstream
   git remote add origin https://github.com/<account>/pi-tick.git
   git push -u origin feature/once-scheduling
   ```

7. Install the custom GitHub repository directly in Pi. Pi supports Git packages, including branches, tags, and commits:

   ```sh
   pi remove /home/vicg4rcia/code/pi-tick
   pi install git:github.com/<account>/pi-tick@feature/once-scheduling
   ```

   For a stable fork release, use a tag instead:

   ```sh
   pi install git:github.com/<account>/pi-tick@v0.2.0
   ```

   SSH Git URLs are also supported, for example `git:git@github.com:<account>/pi-tick`.
   The repository is a valid Pi package because `package.json` declares the
   `pi.extensions` entry. Pi clones Git packages under
   `~/.pi/agent/git/github.com/<account>/pi-tick/` and runs package installation
   when needed.

8. Verify `pi list`, `pi-tick help`, and that `session_start` synchronizes the fork's bundled CLI and modules.
9. Use the fork in real scheduling for several weeks before deciding whether to upstream the feature.

## Explicit non-goals for the first version

- Relative scheduling such as `--after 10m`.
- Sub-minute one-shot timestamps.
- Retry/replay semantics after a failed one-shot execution.
- Opening an upstream issue.
- Submitting an upstream pull request.
- Changing recurring interval/daily/weekly behavior.
