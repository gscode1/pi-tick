// commands/delete.mjs — `pi-tick delete <id>`.

import { ensureDataDirs, loadCatalog, findJob, withCatalogLock, saveCatalog, cleanupJobArtifacts } from "../catalog.mjs";
import { parseFlags } from "../argv.mjs";
import { fail } from "../errors.mjs";
import { validateId } from "../validate.mjs";
import { existsSync } from "node:fs";
import { activeBackend } from "../backend-info.mjs";
import { plistPath, disabledPlistPath } from "../backends/launchd.mjs";

export async function cmdDelete(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const flags = parseFlags(argv);
  const pos = flags._;
  if (pos.length < 1) fail(`delete requires a job id`, 2);
  const id = pos[0];
  validateId(id);

  ensureDataDirs();
  let pre;
  try {
    pre = loadCatalog();
  } catch (err) {
    fail(`failed to read catalog: ${err.message}`, 1);
  }
  const preJob = findJob(pre, id);
  if (!preJob) {
    // Orphan cleanup (launchd): no catalog entry, but plist files for exactly
    // this id remain (e.g. from an older delete). Remove only those.
    const backend = activeBackend();
    if (backend.name === "launchd" && (existsSync(plistPath(id)) || existsSync(disabledPlistPath(id)))) {
      const r = await backend.unregisterAndDelete(id);
      if (!r.ok) fail(r.error, 1);
      stdout.write(`no such job '${id}' in catalog; removed orphan launchd plist file(s)\n`);
      return 0;
    }
    stderr.write(`pi-tick: no such job: ${id}\n`);
    return 0;
  }

  // Slow backend call: OUTSIDE the lock (see commands/enable.mjs for why).
  // launchd: always run, since a disabled job leaves a .plist.disabled that
  // unregisterAndDelete also removes. cron has no leftover for disabled jobs
  // (disable already removed the crontab entry), so skip it there.
  if (preJob.enabled || activeBackend().name === "launchd") {
    const r = await activeBackend().unregisterAndDelete(id);
    if (!r.ok) fail(r.error, 1);
  }

  await withCatalogLock(async () => {
    const catalog = loadCatalog();
    const job = findJob(catalog, id);
    if (!job) {
      // Concurrent delete already removed it; nothing to do.
      return;
    }
    catalog.jobs = catalog.jobs.filter((j) => j.id !== id);
    saveCatalog(catalog);
  });

  // Sweep logs + transcripts. Runs unconditionally — including for
  // disabled jobs (where the backend unregister was skipped) — so
  // no per-job artifacts survive a delete on either backend.
  cleanupJobArtifacts(id, { stderr });

  stdout.write(`deleted job '${id}'\n`);
  return 0;
}
