// commands/run.mjs — `pi-tick run <id> [--manual]`. Fired by launchd/cron as
// a subprocess (`node pi-tick.mjs run <id>`) or in-process by the extension.

import { existsSync } from "node:fs";
import { ensureDataDirs, loadCatalog, findJob, loadConfig } from "../catalog.mjs";
import { transcriptsDir, logsDir } from "../paths.mjs";
import { parseFlags } from "../argv.mjs";
import { fail } from "../errors.mjs";
import { resolvePiPath, resolveNodePath, augmentedPath } from "../bin-resolve.mjs";
import { runJob } from "../runner.mjs";

export async function cmdRun(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const flags = parseFlags(argv);
  const pos = flags._;
  if (pos.length < 1) fail(`run requires a job id`, 2);
  const id = pos[0];

  ensureDataDirs();
  const catalog = loadCatalog();
  const job = findJob(catalog, id);
  if (!job) {
    stderr.write(`pi-tick: no such job: ${id}\n`);
    return 4;
  }

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

  // Trigger kind comes from an explicit --manual flag, not process.env
  // (issue #48). Threading it through the options bag instead of an
  // ambient global removes the race where a concurrent in-process call
  // could observe another call's temporarily-overridden env var.
  const trigger = (flags.manual === true || flags.manual === "true") ? "manual" : "external";
  const result = await runJob(job, trigger, {
    nodePath: nodeBinary,
    piPath: piBinary,
    transcriptsDir: transcriptsDir(),
    logsDir: logsDir(),
    envPath: augmentedPath(),
    defaultModel: loadConfig().defaultModel,
    stderr
  });
  return result.exitCode;
}
