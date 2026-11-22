// callback.mjs — the optional `--on-complete <executable>` hook. After a run
// is recorded (runs.jsonl + job.lastRun) and the run is no longer active,
// the executable is spawned in the job's cwd with the run record as one JSON
// line on stdin. Its stdout/stderr are appended to
// <logsDir>/<jobId>.callback.log, which pruneLogs ages out and rotates like
// the scheduler logs. A callback never retries the job or changes its
// recorded outcome; it is killed (with its process group) after
// CALLBACK_TIMEOUT_MS.
//
// CLI-only (`pi-tick add --on-complete`): the tick_create tool has no field
// for it, so a model cannot make pi-tick run an arbitrary executable.
import { spawn } from "node:child_process";
import { openSync, closeSync, writeSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const CALLBACK_TIMEOUT_MS = 30_000;

export function callbackLogPath(logsDir, jobId) {
  return join(logsDir, `${jobId}.callback.log`);
}

// Resolves once the callback has exited, failed to start, or timed out.
// Never rejects.
export function runCallback(job, record, { logsDir, stderr = process.stderr, timeoutMs = CALLBACK_TIMEOUT_MS, spawnFn = spawn } = {}) {
  if (!job.onComplete || !logsDir) return Promise.resolve(null);
  const logPath = callbackLogPath(logsDir, job.id);
  let fd;
  try {
    mkdirSync(logsDir, { recursive: true, mode: 0o700 });
    fd = openSync(logPath, "a", 0o600);
    writeSync(fd, `--- ${new Date().toISOString()} run ${record.runId} (${record.reason}, exit ${record.exitCode})\n`);
  } catch (err) {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
    stderr.write(`pi-tick: on-complete log: ${err.message}\n`);
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(job.onComplete, [], { cwd: job.cwd, detached: true, stdio: ["pipe", fd, fd] });
    } catch (err) {
      try { writeSync(fd, `on-complete: ${err.message}\n`); } catch { /* ignore */ }
      closeSync(fd);
      stderr.write(`pi-tick: on-complete: ${err.message}\n`);
      resolve(err.message);
      return;
    }
    let finished = false;
    const finish = (status) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { writeSync(fd, `on-complete: ${status}\n`); } catch { /* ignore */ }
      try { closeSync(fd); } catch { /* ignore */ }
      resolve(status);
    };
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
      finish("timeout");
    }, timeoutMs);
    child.stdin?.on("error", () => {});
    child.on("error", (err) => finish(err.message));
    child.on("exit", (code, signal) => finish(signal ? `killed by ${signal}` : `exit ${code}`));
    child.stdin?.end(JSON.stringify(record) + "\n");
  });
}
