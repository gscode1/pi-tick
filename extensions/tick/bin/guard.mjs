// guard.mjs — the optional `--when <shell command>` guard. Before each fire
// the runner runs the command via /bin/sh in the job's cwd:
//   exit 0      the run proceeds; the guard's stdout is available to it
//               ({{when.stdout}} in a pi prompt, $PI_TICK_WHEN_STDOUT for
//               command jobs and --on-complete);
//   exit 1      nothing to do: the run is recorded as `skipped`, no agent
//               is spawned;
//   anything else (other exit code, signal, spawn error, timeout) is a
//               broken guard: recorded as `guard_failed`, no agent is spawned.
// Spawn and kill follow callback.mjs (detached, whole process group killed on
// timeout). stdout is capped; stderr only keeps a short tail for the error.
//
// CLI-only (`pi-tick add --when`): the tick_create tool has no field for it.
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export const GUARD_SHELL = "/bin/sh";
export const GUARD_DEFAULT_TIMEOUT_S = 60;
export const GUARD_MAX_TIMEOUT_S = 2147483; // keeps seconds * 1000 inside a timer's range
export const GUARD_STDOUT_MAX_BYTES = 64 * 1024;
export const GUARD_DRAIN_MS = 2000;
const STDERR_TAIL_CHARS = 4096;
const ERROR_MAX_CHARS = 200;

export function guardTimeoutSeconds(job) {
  return Number.isInteger(job.whenTimeout) && job.whenTimeout > 0 ? job.whenTimeout : GUARD_DEFAULT_TIMEOUT_S;
}

// Replace {{when.stdout}} in a pi prompt with the guard's stdout (empty when
// there is none). One pass with a function replacer: the inserted text is
// literal, so `{{...}}` or `$&` inside it is never expanded.
export function substituteWhenStdout(prompt, stdout) {
  return String(prompt).replace(/\{\{when\.stdout\}\}/g, () => stdout ?? "");
}

function stderrSummary(tail) {
  const line = tail.trim().split("\n").filter((l) => l.trim()).pop();
  return line ? line.trim() : "";
}

// Resolves (never rejects) to
//   { outcome: "pass", stdout }
//   { outcome: "skip" }
//   { outcome: "fail", error }
// `onSpawn(child)` lets the caller register the child (active-run record,
// termination). `spawnFn` is injectable for tests.
export function runGuard(job, { env, timeoutMs, spawnFn = spawn, onSpawn, drainMs = GUARD_DRAIN_MS } = {}) {
  const limitMs = Number.isFinite(timeoutMs) ? timeoutMs : guardTimeoutSeconds(job) * 1000;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(GUARD_SHELL, ["-c", job.when], { cwd: job.cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ outcome: "fail", error: `guard spawn failed: ${err.message}`.slice(0, ERROR_MAX_CHARS) });
      return;
    }
    try { onSpawn?.(child); } catch { /* best effort */ }

    const decoder = new StringDecoder("utf8");
    let out = "";
    let bytes = 0;
    let truncated = false;
    let errTail = "";
    let timedOut = false;
    let exitInfo = null;
    let drainTimer = null;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }, limitMs);

    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (drainTimer) clearTimeout(drainTimer);
      for (const s of [child.stdout, child.stderr]) {
        try { if (s && typeof s.destroy === "function") s.destroy(); } catch { /* already closed */ }
      }
      resolve(result);
    };

    const finish = () => {
      if (settled) return;
      if (!truncated) out += decoder.end();
      const { code, signal } = exitInfo ?? { code: null, signal: null };
      if (timedOut) {
        settle({ outcome: "fail", error: `guard timed out after ${Math.round(limitMs / 1000)}s` });
      } else if (signal) {
        settle({ outcome: "fail", error: `guard killed by ${signal}` });
      } else if (code === 0) {
        let text = out.replace(/[\r\n]+$/, "");
        if (truncated) text += `\n[pi-tick: guard stdout truncated at ${GUARD_STDOUT_MAX_BYTES} bytes]`;
        settle({ outcome: "pass", stdout: text });
      } else if (code === 1) {
        settle({ outcome: "skip" });
      } else {
        const why = stderrSummary(errTail);
        settle({ outcome: "fail", error: `guard exit ${code}${why ? `: ${why}` : ""}`.slice(0, ERROR_MAX_CHARS) });
      }
    };

    child.stdout?.on("data", (chunk) => {
      if (bytes >= GUARD_STDOUT_MAX_BYTES) { truncated = true; return; } // keep draining so the guard never blocks on a full pipe
      let piece = chunk;
      if (bytes + piece.length > GUARD_STDOUT_MAX_BYTES) {
        piece = piece.subarray(0, GUARD_STDOUT_MAX_BYTES - bytes);
        truncated = true;
      }
      bytes += piece.length;
      out += decoder.write(piece);
    });
    child.stderr?.on("data", (chunk) => {
      errTail = (errTail + chunk.toString("utf8")).slice(-STDERR_TAIL_CHARS);
    });
    child.on("error", (err) => {
      // Only a child that never spawned is a spawn failure.
      if (!child.pid) settle({ outcome: "fail", error: `guard spawn failed: ${err.message}`.slice(0, ERROR_MAX_CHARS) });
    });
    // 'exit' fires even if a descendant keeps the pipes open; give them a
    // short drain window, then decide.
    child.on("exit", (code, signal) => {
      exitInfo = { code, signal };
      clearTimeout(timer); // the guard is done; a late timer must not relabel it a timeout
      if (!drainTimer) drainTimer = setTimeout(finish, drainMs);
    });
    child.on("close", (code, signal) => {
      if (!exitInfo) exitInfo = { code, signal };
      finish();
    });
  });
}
