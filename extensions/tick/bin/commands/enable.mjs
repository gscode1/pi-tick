// commands/enable.mjs — `pi-tick enable <id>`. `cmdEnableInternal` is also
// called by commands/add.mjs for `pi-tick add --enabled`.

import { mkdirSync, existsSync } from "node:fs";
import { ensureDataDirs, loadCatalog, findJob, withCatalogLock, saveCatalog } from "../catalog.mjs";
import { stableCliPath, logsDir } from "../paths.mjs";
import { parseFlags } from "../argv.mjs";
import { fail } from "../errors.mjs";
import { resolveNodePath, resolvePiPath, augmentedPath } from "../bin-resolve.mjs";
import { activeBackend } from "../backend-info.mjs";

export async function cmdEnableInternal(id, { skipCatalogExistsCheck = false, stdout = process.stdout, stderr = process.stderr } = {}) {
  ensureDataDirs();
  const pre = loadCatalog();
  const preJob = findJob(pre, id);
  if (!preJob) fail(`no such job: ${id}`, 4);

  // Validate that the stable script path exists; if not, the session_start
  // sync hasn't run yet.
  if (!existsSync(stableCliPath())) {
    fail(`stable CLI not found at ${stableCliPath()}; open a pi session once to sync it (session_start copies it)`, 1);
  }

  const nodePath = resolveNodePath();
  if (!nodePath) {
    fail(`could not resolve 'node' on PATH; install Node.js or set up ~/.local/bin`, 1);
  }
  const piPath = resolvePiPath();
  if (!piPath) {
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
