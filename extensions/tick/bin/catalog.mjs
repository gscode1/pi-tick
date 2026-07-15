import { readFileSync, writeFileSync, appendFileSync, statSync, mkdirSync, unlinkSync, renameSync, existsSync, chmodSync, readdirSync, openSync, closeSync, writeSync, fsyncSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  dataDir,
  jobsFile,
  runsFile,
  logsDir,
  transcriptsDir,
  configFile,
} from "./paths.mjs";

export const SCHEDULE_VERSION = 1;

export class PiTickError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
    this.name = "PiTickError";
  }
}

export const TRANSCRIPT_DIR_NAME = "runs";

export const TRANSCRIPT_FINAL_TEXT_PREVIEW = 200;
export const TRANSCRIPT_PRUNE_THROTTLE_MS = 60 * 60 * 1000;

// Defaults for the per-job runtime controls (issue #61). A job's catalog
// entry stores `null` for a control it doesn't override (see cmdAdd in
// tick-core.mjs) so the runner's default can change in a future release
// without rewriting every job; this is the one place that default lives.
// Both the runner (applying them to a run) and tick-core's `cmdKill`
// (falling back for --grace-ms) read from here — previously each kept its
// own copy and three of the four in tick-core had silently gone dead.
export const RUNTIME_DEFAULTS = {
  timeoutMs: 30 * 60 * 1000,   // wall-clock cap; SIGTERM then SIGKILL
  idleTimeoutMs: 0,            // no-stdout/no-stderr cap; 0 = off
  maxOutputBytes: 0,           // transcript cap; 0 = disabled
  killGraceMs: 5000,           // delay between SIGTERM and SIGKILL
};



export function transcriptJobDir(jobId) {
  return join(transcriptsDir(), jobId);
}

// Active-run liveness tracking (activeRunsDir, isPidAlive, writeActiveRun,
// readActiveRun, findRunningProcess, getActiveRun, clearActiveRun) and
// killActiveRun (issue #47, /tick kill) live in run-registry.mjs — not
// here. That module imports writeAtomic from this one; keeping the
// liveness/kill concern out of catalog.mjs (which now means "jobs CRUD +
// lock") avoids re-spreading the grab-bag that issue #43 consolidated.

export function cleanupJobArtifacts(id, { stderr }) {
  for (const p of [join(logsDir(), `${id}.out.log`), join(logsDir(), `${id}.err.log`), join(logsDir(), `${id}.out.log.1`), join(logsDir(), `${id}.err.log.1`)]) {
    try { unlinkSync(p); } catch (err) {
      if (err && err.code === "ENOENT") continue;
      stderr.write(`pi-tick: delete: ${err.message}\n`);
    }
  }
  try { rmSync(transcriptJobDir(id), { recursive: true, force: true }); } catch (err) {
    if (err && err.code === "ENOENT") return;
    stderr.write(`pi-tick: delete: ${err.message}\n`);
  }
}

export function safeTimestamp(iso) {
  return iso.replace(/[:.]/g, "-");
}

export function transcriptPathFor(jobId, startedAtIso, runId) {
  return join(transcriptJobDir(jobId), `${safeTimestamp(startedAtIso)}_${runId}.jsonl`);
}

export function ensureDataDirs() {
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  mkdirSync(logsDir(), { recursive: true, mode: 0o700 });
  mkdirSync(transcriptsDir(), { recursive: true, mode: 0o700 });
  if (!existsSync(jobsFile())) {
    writeAtomic(jobsFile(), { version: SCHEDULE_VERSION, jobs: [] });
  }
}


let writeAtomicCounter = 0;
export function writeAtomic(path, obj) {
  const tmp = `${path}.${process.pid}.${writeAtomicCounter++}.tmp`;
  const data = JSON.stringify(obj, null, 2);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export function appendJsonl(path, obj) {
  const data = JSON.stringify(obj);
  appendFileSync(path, data + "\n", { encoding: "utf8" });
}

export function ensureFileMode(path, mode) {
  try {
    const s = statSync(path);
    if ((s.mode & 0o777) !== mode) {
      chmodSync(path, mode);
    }
  } catch {
  }
}

export function loadCatalog() {
  ensureDataDirs();
  const raw = readFileSync(jobsFile(), "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.jobs)) {
    throw new Error(`catalog at ${jobsFile()} is malformed: missing 'jobs' array`);
  }
  return parsed;
}

export function saveCatalog(catalog) {
  writeAtomic(jobsFile(), catalog);
}

export function findJob(catalog, id) {
  return catalog.jobs.find((j) => j.id === id) || null;
}

export function catalogLockPath() {
  return jobsFile() + ".lock";
}

const ACQUIRE_TIMEOUT_MS = 10_000;
// Catalog mutations take well under 1ms, so a lock held longer than this is
// almost certainly abandoned by a crashed process, not legitimate contention.
// Must stay comfortably below ACQUIRE_TIMEOUT_MS: a contender that arrives
// after a crash needs the stale-lock reap to fire before its own deadline,
// or it times out for no reason (see issue #52).
const STALE_LOCK_MS = 5_000;
const RETRY_INTERVAL_MS = 50;

export async function withCatalogLock(fn, opts = {}) {
  ensureDataDirs();
  const lockPath = catalogLockPath();
  const acquireMs = opts.acquireMs ?? ACQUIRE_TIMEOUT_MS;
  const staleMs = opts.staleMs ?? STALE_LOCK_MS;
  const retryMs = opts.retryMs ?? RETRY_INTERVAL_MS;
  const deadline = Date.now() + acquireMs;
  let fd = -1;
  const sleepAsync = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  while (true) {
    try {
      fd = openSync(lockPath, "wx", 0o600);
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      let st;
      try {
        st = statSync(lockPath);
      } catch (e) {
        if (e.code === "ENOENT") continue;
        throw e;
      }
      if (st.mtimeMs + staleMs < Date.now()) {
        try { unlinkSync(lockPath); } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new PiTickError("could not acquire catalog lock", 1);
      }
      await sleepAsync(retryMs);
    }
  }
  try {
    return await fn();
  } finally {
    try { closeSync(fd); } catch { /* */ }
    try { unlinkSync(lockPath); } catch { /* */ }
  }
}

export function loadConfig() {
  const p = configFile();
  if (!existsSync(p)) return { defaultModel: null };
  const parsed = JSON.parse(readFileSync(p, "utf8"));
  if (!parsed || typeof parsed !== "object") return { defaultModel: null };
  // Be lenient: drop junk fields, keep `defaultModel` if it's a non-empty string.
  const dm = typeof parsed.defaultModel === "string" && parsed.defaultModel.length > 0
    ? parsed.defaultModel
    : null;
  return { defaultModel: dm };
}

export function saveConfig(cfg) {
  writeAtomic(configFile(), cfg);
}

// Weekday numbering, next-fire date math (nextDailyAt/nextWeeklyAt), and
// general display formatters (formatLocal/durationSeconds/tailLines) used
// to live here — this module's own scope had crept to "jobs CRUD + lock
// + date math + formatters + file utilities". They now live in
// schedule-math.mjs and format.mjs, which also retires the import-cycle
// workaround that used to keep formatters here so transcript-view.mjs
// wouldn't have to depend on tick-core.mjs (issue #58).
