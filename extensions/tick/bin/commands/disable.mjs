// commands/disable.mjs — `pi-tick disable <id>`.

import { loadCatalog, findJob, withCatalogLock, saveCatalog } from "../catalog.mjs";
import { parseFlags } from "../argv.mjs";
import { fail } from "../errors.mjs";
import { validateId } from "../validate.mjs";
import { activeBackend } from "../backend-info.mjs";

export async function cmdDisable(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const flags = parseFlags(argv);
  const pos = flags._;
  if (pos.length < 1) fail(`disable requires a job id`, 2);
  const id = pos[0];
  validateId(id);

  // Pre-check + state inspection OUTSIDE the lock. Cheap, read-only.
  const pre = loadCatalog();
  const preJob = findJob(pre, id);
  if (!preJob) fail(`no such job: ${id}`, 4);

  if (!preJob.enabled) {
    stdout.write(`job '${id}' is already disabled\n`);
    return 0;
  }

  // Slow backend call: OUTSIDE the lock (see commands/enable.mjs for why).
  const result = await activeBackend().unregister(id);
  if (!result.ok) fail(result.error, 1);

  await withCatalogLock(async () => {
    const catalog = loadCatalog();
    const job = findJob(catalog, id);
    if (!job || !job.enabled) {
      // Concurrent disable or delete raced us. The unregister we just
      // did is idempotent on the backend, so no rollback is needed.
      return;
    }
    job.enabled = false;
    job.updatedAt = new Date().toISOString();
    saveCatalog(catalog);
  });

  stdout.write(`disabled job '${id}' (${activeBackend().name}: ${result.referencePath})\n`);
  return 0;
}
