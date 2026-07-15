// commands/delete.mjs — `pi-tick delete <id>`.

import { ensureDataDirs, loadCatalog, findJob, withCatalogLock, saveCatalog, cleanupJobArtifacts } from "../catalog.mjs";
import { parseFlags } from "../argv.mjs";
import { fail } from "../errors.mjs";
import { validateId } from "../validate.mjs";
import { activeBackend } from "../backend-info.mjs";

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
    stderr.write(`pi-tick: no such job: ${id}\n`);
    return 0;
  }

  // Slow backend call: OUTSIDE the lock (see commands/enable.mjs for why).
  if (preJob.enabled) {
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
