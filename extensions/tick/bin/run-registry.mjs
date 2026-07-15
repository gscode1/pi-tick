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
// killActiveRun targets childPid exclusively, never `pid`.
import { readFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
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

export function readActiveRun(jobId) {
  const p = activeRunPath(jobId);
  if (!existsSync(p)) return null;
  try {
    const rec = JSON.parse(readFileSync(p, "utf8"));
    if (rec && rec.jobId === jobId && isPidAlive(rec.pid)) return rec;
  } catch { /* stale/corrupt */ }
  try { unlinkSync(p); } catch { /* best effort */ }
  return null;
}

export function writeActiveRun(jobId, rec) {
  mkdirSync(activeRunsDir(), { recursive: true, mode: 0o700 });
  writeAtomic(activeRunPath(jobId), rec);
}

export function findRunningProcess(jobId) {
  const r = spawnSync("ps", ["-x", "-o", "pid=,etime=,command="], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout) return null;
  for (const line of r.stdout.split("\n")) {
    if (!line.includes("pi-tick.mjs run ") || !line.includes(jobId)) continue;
    const m = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
    if (m) {
      const command = m[3];
      const regex = new RegExp(`\\brun\\s+${jobId}\\b`);
      if (regex.test(command)) {
        const pid = Number(m[1]);
        if (isPidAlive(pid)) {
          return { jobId, pid, durationText: m[2] };
        }
      }
    }
  }
  return null;
}

export function getActiveRun(jobId) {
  return readActiveRun(jobId) || findRunningProcess(jobId);
}

export function clearActiveRun(jobId, runId) {
  const rec = readActiveRun(jobId);
  if (!rec || rec.runId === runId) {
    try { unlinkSync(activeRunPath(jobId)); } catch { /* best effort */ }
  }
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

// Find the job's active run and terminate its process tree: SIGTERM, then
// SIGKILL after `graceMs` if it's still alive. Returns quickly if the
// process already exited (e.g. it finished between the user typing
// `/tick kill` and this running).
export async function killActiveRun(jobId, { graceMs = 5000, pollMs = 100 } = {}) {
  const rec = readActiveRun(jobId);
  if (!rec) return { ok: false, error: `no active run for job '${jobId}'` };

  const pid = rec.childPid;
  if (!Number.isInteger(pid) || pid <= 0) {
    return {
      ok: false,
      error: `active run for '${jobId}' has no recorded child pid (started before this pi-tick version); wait for it to finish`,
    };
  }

  if (!isPidAlive(pid)) {
    clearActiveRun(jobId, rec.runId);
    return { ok: true, pid, alreadyDead: true };
  }

  signalProcessTree(pid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    if (!isPidAlive(pid)) return { ok: true, pid, signal: "SIGTERM" };
  }
  if (isPidAlive(pid)) {
    signalProcessTree(pid, "SIGKILL");
    // SIGKILL can't be blocked, but the kernel reaping the process and
    // isPidAlive reflecting that aren't instantaneous — give it a short,
    // bounded moment so callers see an accurate "it's dead" result rather
    // than a result that's technically true but not yet observable.
    const killDeadline = Date.now() + Math.min(graceMs, 1000);
    while (isPidAlive(pid) && Date.now() < killDeadline) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return { ok: true, pid, signal: "SIGKILL" };
  }
  return { ok: true, pid, signal: "SIGTERM" };
}
