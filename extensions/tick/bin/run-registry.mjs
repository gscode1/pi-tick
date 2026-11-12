// run-registry.mjs — tracks which job is currently running and lets
// /tick kill find and terminate it, including any recursively spawned
// child processes (issue #47).
//
// Active-run records live at <dataDir>/active/<jobId>.json, written by
// runJob when a run starts and cleared when it finishes.
//
// `pi-tick run <id>` executes two different ways:
//  - as a subprocess (launchd/cron spawn `node pi-tick.mjs run <id>`):
//    process.pid there is the one-shot runner subprocess.
//  - in-process (the extension's runCli calls dispatch() inside the
//    user's live pi session): process.pid there is the pi SESSION itself.
// Killing the record's `pid` would be correct for the first case and
// catastrophic for the second (it would kill the user's whole session).
// `childPid` — the pid of the actual spawned `pi --mode ...` process — is
// the one thing that's always safe and correct to kill in both cases, so
// killActiveRun targets childPid (and its process group) exclusively, never
// `pid`.
//
// Lifecycle notes (issue #26):
//  - Liveness is verified by pid AND process start time (`ps -o lstart=`),
//    recorded at spawn as `pidStart` (runner) / `childStart` (child). After a
//    crash or reboot a recycled pid has a different start time, so the record
//    is treated as stale instead of "running" / signalled. Records without a
//    start time (older versions, or `ps` unavailable) fall back to pid-only.
//  - A run is live only when the runner pid is alive AND the child (or, if
//    the child leader is gone, its process group) is alive.
//  - The `ps`-scan fallback that guessed "running" from command lines was
//    removed: it matched by prefix (`backup` vs `backup-daily`) and even
//    unrelated processes. The active file is the single source of truth.
//  - `pi-tick kill` flags a run through a separate marker file
//    active/<id>.<runId>.kill (never rewriting the active file), carrying the
//    request time. The runner honours it only if the child ended by signal or
//    exited at/after the request.
import { readFileSync, existsSync, unlinkSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { dataDir } from "./paths.mjs";
import { writeAtomic } from "./catalog.mjs";

export function activeRunsDir() {
  return join(dataDir(), "active");
}

export function activeRunPath(jobId) {
  return join(activeRunsDir(), `${jobId}.json`);
}

export function killMarkerPath(jobId, runId) {
  return join(activeRunsDir(), `${jobId}.${runId}.kill`);
}

// process.kill(pid, 0) throws EPERM when the pid belongs to another user —
// that PROVES the process exists; only ESRCH means "no such pid" (issue
// #54, fixed here in its real home rather than patched in place).
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === "EPERM";
  }
}

// True when any member of process group `pgid` is alive (the child is spawned
// detached, so its pid is its group id and descendants stay in the group).
export function isGroupAlive(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return !!err && err.code === "EPERM";
  }
}

// Process start time as `ps` prints it (second resolution), or null when the
// process does not exist or `ps` is unavailable.
export function processStart(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
    });
    if (r.status !== 0 || !r.stdout) return null;
    const t = r.stdout.trim().replace(/\s+/g, " ");
    return t || null;
  } catch {
    return null;
  }
}

// pid is alive and (when a start time was recorded) still the same process.
// An unverifiable start (ps failed) is trusted: pid liveness alone, as before.
function pidMatches(pid, start) {
  if (!isPidAlive(pid)) return false;
  if (!start) return true;
  const now = processStart(pid);
  return now === null || now === start;
}

// Child state for a record: stale (pid recycled), or alive via the leader or
// via surviving group members when the leader itself is gone. (While any group
// member lives the kernel does not recycle the group id as a pid.)
function childState(rec) {
  const pid = rec.childPid;
  if (!Number.isInteger(pid) || pid <= 0) return { alive: false, stale: false };
  if (isPidAlive(pid)) {
    if (rec.childStart) {
      const now = processStart(pid);
      if (now !== null && now !== rec.childStart) return { alive: false, stale: true };
    }
    return { alive: true, stale: false };
  }
  return { alive: isGroupAlive(pid), stale: false };
}

function removeActiveFiles(jobId, runId) {
  try { unlinkSync(activeRunPath(jobId)); } catch { /* best effort */ }
  if (runId) { try { unlinkSync(killMarkerPath(jobId, runId)); } catch { /* best effort */ } }
}

// The raw record when the runner that wrote it is still the same live
// process (child state NOT checked); stale/corrupt files are removed.
function readOwnedRecord(jobId) {
  const p = activeRunPath(jobId);
  if (!existsSync(p)) return null;
  let rec = null;
  try {
    rec = JSON.parse(readFileSync(p, "utf8"));
    if (rec && rec.jobId === jobId && pidMatches(rec.pid, rec.pidStart)) return rec;
  } catch { /* stale/corrupt */ }
  removeActiveFiles(jobId, rec && rec.runId);
  return null;
}

// The job's live active run, or null. Live = runner alive and the child (or
// its process group) alive. A record whose child is gone but whose runner is
// still finalizing is reported as not running, but not deleted.
export function readActiveRun(jobId) {
  const rec = readOwnedRecord(jobId);
  if (!rec) return null;
  const st = childState(rec);
  if (st.stale) { removeActiveFiles(jobId, rec.runId); return null; }
  return st.alive ? rec : null;
}

export function writeActiveRun(jobId, rec) {
  mkdirSync(activeRunsDir(), { recursive: true, mode: 0o700 });
  writeAtomic(activeRunPath(jobId), rec);
}

// Time (ms since epoch) at which `pi-tick kill` flagged this run, or null.
export function readKillRequest(jobId, runId) {
  try {
    const t = JSON.parse(readFileSync(killMarkerPath(jobId, runId), "utf8")).requestedAt;
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

// `list` shows a job as running iff it has a live active record (no ps
// fallback — see the notes at the top).
export function getActiveRun(jobId) {
  return readActiveRun(jobId);
}

export function clearActiveRun(jobId, runId) {
  let rec = null;
  try { rec = JSON.parse(readFileSync(activeRunPath(jobId), "utf8")); } catch { /* missing/corrupt */ }
  if (!rec || rec.runId === runId) removeActiveFiles(jobId, runId);
  else if (runId) { try { unlinkSync(killMarkerPath(jobId, runId)); } catch { /* none */ } }
}

// Signal a pid's whole process group (it was spawned with `detached: true`,
// so its own pid doubles as its process-group id) — this reaches any
// descendants the child itself spawned, not just the immediate process.
// Falls back to signaling the lone pid when the group signal fails (no
// such group, EPERM, or — in tests — a pid that was never a real process).
function signalProcessTree(pid, sig) {
  try {
    process.kill(-pid, sig);
  } catch {
    try { process.kill(pid, sig); } catch { /* already dead */ }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Find the job's active run and terminate its process tree: SIGTERM to the
// group, then — after `graceMs` — SIGKILL to the group if ANYTHING in it is
// still alive (the leader may be gone while a TERM-ignoring descendant
// lingers). Returns quickly if nothing is alive any more.
export async function killActiveRun(jobId, { graceMs = 5000, pollMs = 100 } = {}) {
  const rec = readActiveRun(jobId);
  if (!rec) {
    // Runner finalizing with a dead child, or no run at all.
    return { ok: false, error: `no active run for job '${jobId}'` };
  }

  const pid = rec.childPid;
  if (!Number.isInteger(pid) || pid <= 0) {
    return {
      ok: false,
      error: `active run for '${jobId}' has no recorded child pid (started before this pi-tick version); wait for it to finish`,
    };
  }

  const treeAlive = () => isPidAlive(pid) || isGroupAlive(pid);
  if (!treeAlive()) {
    clearActiveRun(jobId, rec.runId);
    return { ok: true, pid, alreadyDead: true };
  }

  // Flag the run as user-killed BEFORE signalling: the runner reads the
  // marker when the child exits (the SIGTERM goes to the child, so the runner
  // can't otherwise tell a kill from an ordinary failure). The marker is a
  // separate file, written only if the active file still belongs to the same
  // run (re-read right before), and dropped again if the run vanished while
  // writing — so a kill can never resurrect a stale active record.
  const current = readOwnedRecord(jobId);
  if (current && current.runId === rec.runId) {
    try {
      mkdirSync(activeRunsDir(), { recursive: true, mode: 0o700 });
      writeFileSync(killMarkerPath(jobId, rec.runId), JSON.stringify({ requestedAt: Date.now() }), { mode: 0o600 });
      const after = readOwnedRecord(jobId);
      if (!after || after.runId !== rec.runId) {
        try { unlinkSync(killMarkerPath(jobId, rec.runId)); } catch { /* gone */ }
      }
    } catch { /* best effort */ }
  }

  signalProcessTree(pid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    if (!treeAlive()) return { ok: true, pid, signal: "SIGTERM" };
  }
  if (treeAlive()) {
    signalProcessTree(pid, "SIGKILL");
    // SIGKILL can't be blocked, but the kernel reaping the process and
    // liveness reflecting that aren't instantaneous — give it a short,
    // bounded moment so callers see an accurate "it's dead" result.
    const killDeadline = Date.now() + Math.min(graceMs, 1000);
    while (treeAlive() && Date.now() < killDeadline) {
      await sleep(pollMs);
    }
    return { ok: true, pid, signal: "SIGKILL" };
  }
  return { ok: true, pid, signal: "SIGTERM" };
}
