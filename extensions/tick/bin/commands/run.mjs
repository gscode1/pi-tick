// commands/run.mjs — `pi-tick run <id> [--manual]`. Fired by launchd/cron as
// a subprocess (`node pi-tick.mjs run <id>`) or in-process by the extension.

import { existsSync } from "node:fs";
import { ensureDataDirs, loadCatalog, findJob, loadConfig, claimOnceJob } from "../catalog.mjs";
import { transcriptsDir, logsDir } from "../paths.mjs";
import { parseFlags } from "../argv.mjs";
import { fail } from "../errors.mjs";
import { resolvePiPath, resolveNodePath, augmentedPath } from "../bin-resolve.mjs";
import { runJob } from "../runner.mjs";
import { activeBackend } from "../backend-info.mjs";

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

  if (!job.enabled) {
    stderr.write(`pi-tick: job '${id}' is disabled; not running\n`);
    return 0;
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

  // Claim only after all pre-run validation succeeds. A failed validation
  // must leave the one-shot available for a later scheduled invocation.
  let claimedOnce = false;
  if (trigger === "external" && job.schedule?.kind === "once") {
    const claimed = await claimOnceJob(id);
    if (!claimed) return 0;
    job = claimed;
    claimedOnce = true;
  }

  const result = await runJob(job, trigger, {
    nodePath: nodeBinary,
    piPath: piBinary,
    transcriptsDir: transcriptsDir(),
    logsDir: logsDir(),
    envPath: augmentedPath(),
    defaultModel: loadConfig().defaultModel,
    stderr
  });

  // Unregister only after the run has finished and been recorded. Under
  // launchd, `bootout` terminates the job's own process, so doing it before
  // runJob kills Pi before it starts. Correctness does not depend on this
  // succeeding: onceConsumedAt is already durable, so a stale calendar entry
  // can never run the prompt again. This is best-effort cleanup.
  if (claimedOnce) {
    try {
      const unregister = await activeBackend().unregister(id);
      if (!unregister.ok) stderr.write(`pi-tick: could not unregister one-shot '${id}': ${unregister.error}\n`);
    } catch (err) {
      stderr.write(`pi-tick: could not unregister one-shot '${id}': ${err.message}\n`);
    }
  }
  return result.exitCode;
}
