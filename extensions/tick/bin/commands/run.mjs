// commands/run.mjs — `pi-tick run <id> [--manual]`. Fired by launchd/cron as
// a subprocess (`node pi-tick.mjs run <id>`) or in-process by the extension.

import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { ensureDataDirs, loadCatalog, findJob, loadConfig, claimOnceJob, appendJsonl, ensureFileMode } from "../catalog.mjs";
import { transcriptsDir, logsDir, runsFile } from "../paths.mjs";
import { parseFlags } from "../argv.mjs";
import { fail } from "../errors.mjs";
import { resolvePiPath, resolveNodePath, augmentedPath } from "../bin-resolve.mjs";
import { runJob } from "../runner.mjs";
import { getActiveRun } from "../run-registry.mjs";
import { activeBackend } from "../backend-info.mjs";

// A scheduler-fired one-shot may legitimately arrive slightly early (clock
// adjustment) or late (launchd coalesces fires missed during sleep). The
// backends render `at` as month/day/hour/minute with no year, so a slot missed
// while the machine was off would otherwise fire a year later (issue #25).
// Outside [at - EARLY, at + LATE] an external trigger does not run the job.
export const ONCE_EARLY_GRACE_MS = 60 * 1000;
export const ONCE_LATE_GRACE_MS = 24 * 60 * 60 * 1000;

// Best-effort removal of the scheduler entry; never fails the run.
async function unregisterQuietly(id, stderr, what) {
  try {
    const unregister = await activeBackend().unregister(id);
    if (!unregister.ok) stderr.write(`pi-tick: could not unregister ${what} '${id}': ${unregister.error}\n`);
  } catch (err) {
    stderr.write(`pi-tick: could not unregister ${what} '${id}': ${err.message}\n`);
  }
}

export async function cmdRun(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const flags = parseFlags(argv);
  const pos = flags._;
  if (pos.length < 1) fail(`run requires a job id`, 2);
  const id = pos[0];

  ensureDataDirs();
  const catalog = loadCatalog();
  let job = findJob(catalog, id);
  if (!job) {
    stderr.write(`pi-tick: no such job: ${id}\n`);
    return 4;
  }

  // Trigger kind comes from an explicit --manual flag, not process.env
  // (issue #48). Manual runs never consume a one-shot schedule.
  const trigger = (flags.manual === true || flags.manual === "true") ? "manual" : "external";

  // Explicit manual runs ignore `enabled` so a job can be tested without
  // registering it with the scheduler. Scheduler-triggered runs skip disabled
  // jobs (including consumed one-shots) and exit 0: a stale scheduler entry is
  // expected, and non-zero would only add launchd/cron failure noise.
  if (trigger === "external" && !job.enabled) {
    stderr.write(`pi-tick: job '${id}' is disabled; not running\n`);
    // A consumed one-shot that fires again is a stale scheduler entry (it would
    // repeat every year): remove it (issue #25).
    if (job.schedule?.kind === "once" && job.onceConsumedAt) await unregisterQuietly(id, stderr, "stale one-shot");
    return 0;
  }

  // One-shot slot check (issue #25), before any other validation so a missed
  // slot is retired even if cwd/pi have since gone away.
  if (trigger === "external" && job.schedule?.kind === "once") {
    const at = Date.parse(job.schedule.value?.at);
    const now = Date.now();
    if (Number.isFinite(at)) {
      if (now < at - ONCE_EARLY_GRACE_MS) {
        stderr.write(`pi-tick: one-shot '${id}' fired before its scheduled time (${job.schedule.value.at}); not running\n`);
        return 0;
      }
      if (now > at + ONCE_LATE_GRACE_MS) {
        const claimed = await claimOnceJob(id, { missed: true });
        if (claimed) {
          stderr.write(`pi-tick: one-shot '${id}' missed its slot (${job.schedule.value.at}) by more than 24h; not running, disabled\n`);
          const stamp = new Date().toISOString();
          try {
            appendJsonl(runsFile(), {
              runId: randomBytes(4).toString("hex"), jobId: id, triggerKind: "external",
              startedAt: stamp, finishedAt: stamp, exitCode: 1, reason: "once_missed",
              error: `missed one-shot slot ${job.schedule.value.at}`, model: null,
            });
            ensureFileMode(runsFile(), 0o600);
          } catch { /* best effort */ }
        }
        await unregisterQuietly(id, stderr, "missed one-shot");
        return 0;
      }
    }
  }

  if (!existsSync(job.cwd)) {
    stderr.write(`pi-tick: cwd does not exist: ${job.cwd}\n`);
    return 6;
  }

  let piBinary = job.piPath;
  if (!piBinary || !existsSync(piBinary)) {
    piBinary = resolvePiPath();
  }
  if (!piBinary || !existsSync(piBinary)) {
    stderr.write(`pi-tick: could not resolve 'pi' binary; set job.piPath or install pi\n`);
    return 7;
  }

  let nodeBinary = job.nodePath;
  if (!nodeBinary || !existsSync(nodeBinary)) {
    nodeBinary = resolveNodePath();
  }

  // Load config before claiming: a bad config must never consume a one-shot
  // (issue #29). loadConfig falls back to defaults with a single warning.
  const config = loadConfig({ stderr });

  // One run per job at a time (issue #26): the active file is keyed by job
  // id, so a second run would hide the first from `list`/`kill`. A live run
  // (runner and child both alive) refuses the start and records nothing.
  // Manual: failure (exit 5) so the user notices. Scheduler: exit 0 — an
  // overlapping tick is expected for long jobs and non-zero is only noise.
  // Checked before claiming a one-shot so a refused start doesn't consume it.
  // (A check-then-start window of a few ms remains between two simultaneous
  // starts; accepted.)
  const live = getActiveRun(id);
  if (live) {
    stderr.write(`pi-tick: job '${id}' is already running (run ${live.runId || "?"}, started ${live.startedAt || "?"}); not starting another\n`);
    return trigger === "manual" ? 5 : 0;
  }

  // Claim only after all pre-run validation succeeds. A failed validation
  // must leave the one-shot available for a later scheduled invocation.
  let claimedOnce = false;
  if (trigger === "external" && job.schedule?.kind === "once") {
    const claimed = await claimOnceJob(id);
    if (!claimed) {
      // Already consumed (or disabled concurrently): the scheduler entry is
      // stale. Remove it so it stops firing every year.
      await unregisterQuietly(id, stderr, "stale one-shot");
      return 0;
    }
    job = claimed;
    claimedOnce = true;
  }

  const result = await runJob(job, trigger, {
    nodePath: nodeBinary,
    piPath: piBinary,
    transcriptsDir: transcriptsDir(),
    logsDir: logsDir(),
    envPath: augmentedPath(),
    defaultModel: config.defaultModel,
    stderr
  });

  // Unregister only after the run has finished and been recorded. Under
  // launchd, `bootout` terminates the job's own process, so doing it before
  // runJob kills Pi before it starts. Correctness does not depend on this
  // succeeding: onceConsumedAt is already durable, so a stale calendar entry
  // can never run the prompt again. This is best-effort cleanup.
  if (claimedOnce) await unregisterQuietly(id, stderr, "one-shot");
  return result.exitCode;
}
