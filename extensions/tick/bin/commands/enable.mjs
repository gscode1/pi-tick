// commands/enable.mjs — `pi-tick enable <id>`. `cmdEnableInternal` is also
// called by commands/add.mjs for `pi-tick add --enabled`.

import { mkdirSync, existsSync } from "node:fs";
import { ensureDataDirs, loadCatalog, findJob, withCatalogLock, saveCatalog } from "../catalog.mjs";
import { stableCliPath, logsDir } from "../paths.mjs";
import { parseFlags } from "../argv.mjs";
import { fail } from "../errors.mjs";
import { resolveNodePath, augmentedPath } from "../bin-resolve.mjs";
import { agentAdapter } from "../agents/index.mjs";
import { activeBackend } from "../backend-info.mjs";
import { KIND_ONCE, validateOnceAt } from "../schedule.mjs";
import { validateCwd, validateExecutable } from "../validate.mjs";
import { getActiveRun } from "../run-registry.mjs";

// Overrides the runner/paths/backends read from the environment (see README).
// launchd/cron start jobs with a minimal environment, so those set in the
// enabling process are baked into the plist / crontab line. PI_TICK_BACKEND
// and the stub paths are included on purpose: a one-shot's self-unregister
// resolves the backend the same way and must act on the same scheduler.
export const SCHEDULER_ENV_NAMES = [
  "PI_TICK_DATA_DIR",
  "PI_TICK_LOG_RETENTION_DAYS",
  "PI_TICK_LOG_MAX_BYTES",
  "PI_TICK_RUNS_MAX_BYTES",
  "PI_TICK_BACKEND",
  "PI_TICK_PLIST_DIR",
  "PI_TICK_CRONTAB",
  "PI_TICK_LAUNCHCTL",
];

export function schedulerEnvVars(env = process.env) {
  const out = {};
  for (const k of SCHEDULER_ENV_NAMES) {
    if (typeof env[k] === "string" && env[k] !== "") out[k] = env[k];
  }
  return out;
}

export async function cmdEnableInternal(id, { skipCatalogExistsCheck = false, stdout = process.stdout, stderr = process.stderr } = {}) {
  ensureDataDirs();
  const pre = loadCatalog();
  const preJob = findJob(pre, id);
  if (!preJob) fail(`no such job: ${id}`, 4);
  // Re-registering an enabled job makes launchd bootout (SIGTERM) its service,
  // killing an in-flight run. Enabling is idempotent, so just report and skip.
  if (preJob.enabled && getActiveRun(id)) {
    stdout.write(`job '${id}' is already enabled and currently running; not re-registering (retry when the run finishes)\n`);
    return 0;
  }
  if (preJob.schedule?.kind === KIND_ONCE) {
    if (preJob.onceConsumedAt) fail(`job '${id}' has already been consumed`, 2);
    // A disabled one-shot can outlive its requested time. Revalidate before
    // touching the backend so enabling it can never register a stale fire.
    validateOnceAt(preJob.schedule.value?.at);
  }

  // A cwd or callback deleted since `add` would register a job that can't start.
  validateCwd(preJob.cwd);
  if (preJob.onComplete) validateExecutable(preJob.onComplete);

  // Validate that the stable script path exists; if not, the session_start
  // sync hasn't run yet.
  if (!existsSync(stableCliPath())) {
    fail(`stable CLI not found at ${stableCliPath()}; open a pi session once to sync it (session_start copies it), or run 'node scripts/install.mjs' from a pi-tick checkout`, 1);
  }

  const nodePath = resolveNodePath();
  if (!nodePath) {
    fail(`could not resolve 'node' on PATH; install Node.js or set up ~/.local/bin`, 1);
  }
  const adapter = agentAdapter(preJob.agent);
  // Command jobs run /bin/sh and need no pi binary.
  const piPath = adapter.id === "pi" ? adapter.resolve({}) : null;
  if (adapter.id === "pi" && !piPath) {
    fail(`could not resolve 'pi' on PATH; install pi via 'npm i -g @earendil-works/pi-coding-agent' or symlink it into ~/.local/bin`, 1);
  }

  mkdirSync(logsDir(), { recursive: true, mode: 0o700 });

  // Slow backend call: OUTSIDE the lock. If we ran register under the
  // lock, a stale-steal 30s window would let a second process steal
  // mid-register, re-read pre-commit state, and save — clobbering our
  // eventual saveCatalog. Keep the wrap to sub-ms load+mutate+save.
  const result = await activeBackend().register(preJob, {
    nodePath,
    cliPath: stableCliPath(),
    logsDir: logsDir(),
    // Bake a robust PATH into the plist so the launchd-spawned job (and the
    // `forge`→tea/gh tools it shells out to) resolve, not just the interactive
    // shell. Computed at enable time when process.env.PATH is rich.
    envPath: augmentedPath(),
    envVars: schedulerEnvVars(),
  });

  if (!result.ok) {
    fail(result.error, 1);
  }

  let jobWasDeleted = false;
  let rollbackPromise;

  await withCatalogLock(async () => {
    const catalog = loadCatalog();
    const job = findJob(catalog, id);
    if (!job) {
      jobWasDeleted = true;
      // Concurrent delete raced us after we registered. Best-effort
      // rollback the register so the backend doesn't carry a dangling
      // entry for a job the catalog no longer knows about. Fire-and-
      // forget: the wrap is sync and we don't hold the lock here.
      try {
        rollbackPromise = activeBackend().unregister(id);
      } catch { /* swallow */ }
    } else {
      job.enabled = true;
      job.piPath = piPath;
      job.nodePath = nodePath;
      job.updatedAt = new Date().toISOString();
      // What we handed the scheduler, so `pi-tick doctor` can tell a
      // hand-edited, replaced, or vanished entry from the one we wrote.
      job.registration = {
        backend: activeBackend().name,
        fingerprint: result.fingerprint ?? null,
        registeredAt: job.updatedAt,
      };
      saveCatalog(catalog);
    }
  });

  if (jobWasDeleted) {
    if (typeof rollbackPromise?.catch === 'function') {
      await rollbackPromise.catch(() => {});
    }
    fail(`no such job: ${id}`, 4);
  }

  stdout.write(`enabled job '${id}' (${activeBackend().name}: ${result.referencePath})\n`);
  return 0;
}

export function cmdEnable(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const flags = parseFlags(argv);
  const pos = flags._;
  if (pos.length < 1) fail(`enable requires a job id`, 2);
  return cmdEnableInternal(pos[0], { stdout, stderr });
}
