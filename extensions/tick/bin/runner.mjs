import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, statSync, readdirSync, unlinkSync, renameSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

import {
  appendJsonl, ensureFileMode, safeTimestamp,
  withCatalogLock, loadCatalog, saveCatalog, findJob,
  TRANSCRIPT_FINAL_TEXT_PREVIEW, TRANSCRIPT_PRUNE_THROTTLE_MS,
  RUNTIME_DEFAULTS,
} from "./catalog.mjs";
import { writeActiveRun, clearActiveRun } from "./run-registry.mjs";
import { runsFile } from "./paths.mjs";

export const TRANSCRIPT_RETENTION_DAYS = 7;
export const TRANSCRIPT_MAX_BYTES_PER_JOB = 500 * 1024 * 1024;
export const LOG_RETENTION_DAYS = parseInt(process.env.PI_TICK_LOG_RETENTION_DAYS || "7", 10);
export const LOG_MAX_BYTES_PER_FILE = parseInt(process.env.PI_TICK_LOG_MAX_BYTES || `${50 * 1024 * 1024}`, 10);

export function pruneTranscripts(jobId, transcriptsDir, { now = Date.now(), stderr, maxBytes = TRANSCRIPT_MAX_BYTES_PER_JOB } = {}) {
  const dir = join(transcriptsDir, jobId);
  if (!existsSync(dir)) return;
  const entries = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const full = join(dir, f);
      try {
        const st = statSync(full);
        return { path: full, mtime: st.mtime, size: st.size };
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const ageCutoff = now - TRANSCRIPT_RETENTION_DAYS * 86400_000;
  for (const e of entries) {
    if (e.mtime.getTime() < ageCutoff) {
      try { unlinkSync(e.path); } catch (err) {
        stderr?.write(`pi-tick: prune: ${err.message}\n`);
      }
    }
  }

  const remaining = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const full = join(dir, f);
      try {
        const st = statSync(full);
        return { path: full, mtime: st.mtime, size: st.size };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.mtime.getTime() - b.mtime.getTime());

  let total = remaining.reduce((s, e) => s + e.size, 0);
  for (const e of remaining) {
    if (total <= maxBytes) break;
    try {
      unlinkSync(e.path);
      total -= e.size;
    } catch (err) {
      stderr?.write(`pi-tick: prune: ${err.message}\n`);
    }
  }
}

export function pruneLogs(jobId, logsDir, { now = Date.now(), stderr } = {}) {
  const ageCutoff = now - LOG_RETENTION_DAYS * 86400_000;
  const maxBytes = Number.isSafeInteger(LOG_MAX_BYTES_PER_FILE) ? LOG_MAX_BYTES_PER_FILE : 50 * 1024 * 1024;
  for (const suffix of [".out.log", ".err.log", ".out.log.1", ".err.log.1"]) {
    const p = join(logsDir, `${jobId}${suffix}`);
    try {
      const st = statSync(p);
      if (st.mtime.getTime() < ageCutoff) {
        unlinkSync(p);
      } else if (st.size > maxBytes && !suffix.endsWith(".1")) {
        renameSync(p, `${p}.1`);
      }
    } catch (err) {
      if (err && err.code === "ENOENT") continue;
      stderr?.write(`pi-tick: prune logs: ${err.message}\n`);
    }
  }
}

const NAMED_ERROR_RE = /^\s*(?:Error|TypeError|RangeError|ReferenceError|SyntaxError|EvalError|URIError|AssertionError|SystemError)\s*:/;

export function extractStderrSignature(stderrBuf) {
  if (!stderrBuf) return null;
  const lines = stderrBuf.split("\n");
  // Named-error match stays top-down: it's unambiguous, so the first
  // Error:/TypeError:/etc. line found is the signature regardless of
  // position.
  for (const line of lines) {
    if (NAMED_ERROR_RE.test(line)) return line.trim();
  }
  // Fallback: scan bottom-up. Node prints ExperimentalWarning and similar
  // startup notices at the TOP of stderr before the actual crash; a
  // top-down fallback scan picked up the warning and masked the real
  // failure (issue #51). The actual exception/throw is always at or near
  // the end of the buffer.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^\s*at\s/.test(line)) continue;
    if (!/[a-zA-Z0-9]/.test(trimmed)) continue;
    return trimmed;
  }
  return null;
}

export function extractTaskflowFailure(text) {
  if (!text || !/taskflow/i.test(text) || !/failed/i.test(text)) return null;
  const error = text.match(/^\s*(?:[-*]\s*)?(?:error|reason|cause):\s*(.+)$/im)?.[1]?.trim();
  const failedAt = text.match(/^\s*(?:[-*]\s*)?(?:failed at|halted at):\s*`?([^`\n]+)`?/im)?.[1]?.trim();
  return error || (failedAt ? `taskflow failed at ${failedAt}` : "taskflow failed");
}

function taskflowPrompt(prompt) {
  const text = String(prompt).trim();
  let name = null;
  let rest = "";
  const shortcut = text.match(/^\/tf:([^\s]+)(?:\s+(.*))?$/);
  if (shortcut) {
    name = shortcut[1];
    rest = shortcut[2] || "";
  } else {
    const run = text.match(/^\/tf\s+run\s+([^\s]+)(?:\s+(.*))?$/);
    if (run) {
      name = run[1];
      rest = run[2] || "";
    }
  }
  if (!name) return null;
  const args = {};
  for (const part of rest.split(/\s+/).filter(Boolean)) {
    const i = part.indexOf("=");
    if (i > 0) args[part.slice(0, i)] = part.slice(i + 1);
  }
  return `Call the taskflow tool exactly once with ${JSON.stringify({ action: "run", name, args })}. Do not call any other tool. Do not inspect files. Return only the taskflow result.`;
}

// ─── Phase: spawn plan ──────────────────────────────────────────────────
// Pure: which pi invocation mode a job runs under and the argv that follow
// from it. Slash-command jobs run via pi's RPC mode; everything else
// (including saved taskflows — /tf itself expands to a model turn, and
// unconstrained scheduled runs often pick the wrong first tool) runs as a
// one-shot prompt.
function buildRunArgs(job, { defaultModel }) {
  const tfPrompt = taskflowPrompt(job.prompt);
  const isSlashCommand = !tfPrompt && job.prompt.trimStart().startsWith("/");
  const args = isSlashCommand ? ["--mode", "rpc", "--no-session"] : ["--mode", "json", "-p", "--no-session"];
  const effectiveModel = job.model ?? defaultModel ?? null;
  if (effectiveModel) args.push("--model", effectiveModel);
  if (tfPrompt) args.push("--tools", "taskflow");
  if (!isSlashCommand) args.push(tfPrompt || job.prompt);
  return { isSlashCommand, args, effectiveModel };
}

// ─── Phase: run controls (wall/idle/output-cap timers + kill escalation) ──
// Encapsulates the kill-reason bookkeeping and the SIGTERM→SIGKILL
// escalation so the rest of runJob only ever calls killChild(reason) /
// resetIdleTimer() / getKillReason() — the timer trio (issue: these three
// timers used to live inline, interleaved with the RPC and streaming code).
function createRunControls(child, { timeoutMs, idleTimeoutMs, killGraceMs }) {
  let killed = false;
  let killReason = null;
  let escalationTimer = null;
  let idleTimer = null;
  let wallTimer = null;

  // Signal the child's whole process group (it's spawned detached, so its
  // pid doubles as its process-group id) so any descendants IT spawned die
  // too (issue #47) — not just the immediate pi process. Always also
  // signals child.kill directly: harmless if the group signal already hit
  // the same pid, and it's the only thing that works against the mocked
  // children used in tests (no real OS pid to form a group from).
  const signalChildTree = (sig) => {
    if (Number.isInteger(child.pid)) {
      try { process.kill(-child.pid, sig); } catch { /* no such group */ }
    }
    try { child.kill(sig); } catch { /* already dead */ }
  };

  const killChild = (reason) => {
    if (killed) return;
    killed = true;
    killReason = reason;
    signalChildTree("SIGTERM");
    escalationTimer = setTimeout(() => signalChildTree("SIGKILL"), killGraceMs);
  };

  const clearIdleTimer = () => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  };

  const resetIdleTimer = () => {
    if (idleTimeoutMs <= 0) return;
    clearIdleTimer();
    idleTimer = setTimeout(() => killChild("idle_timeout"), idleTimeoutMs);
  };

  const armWallTimer = () => {
    wallTimer = setTimeout(() => killChild("timeout"), timeoutMs);
  };

  const clearAll = () => {
    if (wallTimer) clearTimeout(wallTimer);
    clearIdleTimer();
    if (escalationTimer) clearTimeout(escalationTimer);
  };

  return { killChild, resetIdleTimer, armWallTimer, clearAll, getKillReason: () => killReason };
}

// Issue #56 — chunk.toString("utf8") + char-count slicing had two bugs: a
// multi-byte UTF-8 character straddling a chunk boundary corrupted into
// U+FFFD, and capping by character count on a multi-byte string wrote more
// bytes than maxOutputBytes allows (the cap is a byte cap). `budget` is a
// shared mutable byte counter across stdout+stderr (the cap is combined,
// not per-stream) — capped on the raw buffer via chunk.subarray (byte-
// accurate); decoder.end() flushes on a cap so a partial multi-byte
// character isn't silently dropped.
function decodeWithCap(chunk, decoder, budget, maxOutputBytes) {
  let toDecode = chunk;
  let capped = false;
  if (maxOutputBytes > 0 && budget.bytes + chunk.length > maxOutputBytes) {
    const room = Math.max(0, maxOutputBytes - budget.bytes);
    toDecode = chunk.subarray(0, room);
    budget.bytes = maxOutputBytes;
    capped = true;
  } else {
    budget.bytes += chunk.length;
  }
  const text = capped ? decoder.write(toDecode) + decoder.end() : decoder.write(toDecode);
  return { text, capped };
}

// ─── Phase: RPC handshake lifecycle ────────────────────────────────────
// Keeps a slash-command job's (--mode rpc) stdin open until the assistant
// turn finishes — closing it right after the prompt only proves pi
// accepted the command, yielding an instant exit 0 with a tiny transcript.
// `agent_end` closes stdin directly; a `response`/prompt event with no
// subsequent `agent_start` within 250ms (a command that never dispatched
// to the agent, e.g. a built-in slash command) falls back to closing it
// too. Also tracks usage/final-text from message_end events, which the
// run record needs.
function createRpcLifecycle({ isSlashCommand, child }) {
  let agentStarted = false;
  let closeTimer = null;
  let lastUsage = null;
  let finalText = null;

  const closeStdin = () => {
    if (isSlashCommand && child.stdin && !child.stdin.destroyed) child.stdin.end();
  };

  const handleEvent = (evt) => {
    if (!evt || typeof evt.type !== "string") return;
    if (evt.type === "agent_start") {
      agentStarted = true;
      if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    }
    if (evt.type === "agent_end") closeStdin();
    if (evt.type === "response" && evt.command === "prompt" && isSlashCommand) {
      closeTimer = setTimeout(() => {
        if (!agentStarted) closeStdin();
      }, 250);
    }
    if (evt.type === "message_end" && evt.message) {
      if (evt.message.usage) lastUsage = evt.message.usage;
      if (evt.message.role === "assistant" && Array.isArray(evt.message.content)) {
        const texts = evt.message.content
          .filter((p) => p && p.type === "text" && typeof p.text === "string")
          .map((p) => p.text);
        if (texts.length > 0) {
          const joined = texts.join("\n").trim();
          if (joined.length > 0) finalText = joined;
        }
      }
    }
  };

  return {
    writePrompt: (prompt) => {
      if (isSlashCommand && child.stdin) {
        child.stdin.write(`${JSON.stringify({ type: "prompt", message: prompt })}\n`);
      }
    },
    handleLine: (line) => {
      try { handleEvent(JSON.parse(line)); } catch { /* not JSON; ignore */ }
    },
    clear: () => {
      if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    },
    getLastUsage: () => lastUsage,
    getFinalText: () => finalText,
  };
}

// ─── Phase: run record ──────────────────────────────────────────────────
// Pure: classify how the run ended (spawn error, kill, signal, transcript
// write failure, taskflow failure, clean exit, or a failed exit) and shape
// the record written to runs.jsonl / job.lastRun.
function buildRunRecord({
  runId, jobId, triggerKind, startedAt, finishedAt,
  code, signal, spawnErr, killReason, transcriptWriteError,
  stderrBuf, finalText, effectiveModel, lastUsage,
  transcriptPath, transcriptBytes,
}) {
  let exitCode = typeof code === "number" ? code : 1;
  let error = null;
  let reason;

  if (spawnErr) {
    exitCode = 1;
    reason = "spawn_error";
    error = `spawn failed: ${spawnErr.message}`;
  } else if (killReason) {
    exitCode = 124;
    reason = killReason;
    error = killReason;
  } else if (transcriptWriteError) {
    reason = "exit_code";
    error = `transcript write failed: ${transcriptWriteError.message}`;
  } else if (signal) {
    reason = "signal";
    error = `killed by ${signal}`;
  } else if (exitCode === 0) {
    const taskflowFailure = extractTaskflowFailure(finalText);
    if (taskflowFailure) {
      exitCode = 1;
      reason = "taskflow_failed";
      error = taskflowFailure.slice(0, 200);
    } else {
      reason = "exit_code";
    }
  } else {
    reason = "exit_code";
    const sig = extractStderrSignature(stderrBuf);
    const fallback = stderrBuf.trim().split("\n").pop() || "";
    error = (sig || fallback).slice(0, 200) || null;
  }

  const record = {
    runId, jobId, triggerKind, startedAt, finishedAt, exitCode, reason, error, model: effectiveModel,
  };
  if (lastUsage) {
    const inp = lastUsage.input || lastUsage.inputTokens || 0;
    const outp = lastUsage.output || lastUsage.outputTokens || 0;
    record.tokens = { input: inp, output: outp };
  }
  if (transcriptPath) {
    record.transcriptPath = transcriptPath;
    if (transcriptBytes != null) record.transcriptBytes = transcriptBytes;
  }
  if (finalText) {
    record.finalTextPreview = finalText.length > TRANSCRIPT_FINAL_TEXT_PREVIEW
      ? finalText.slice(0, TRANSCRIPT_FINAL_TEXT_PREVIEW) + "…"
      : finalText;
  }
  return record;
}

// ─── Phase: catalog bookkeeping + prune trigger ────────────────────────
// Records the run on job.lastRun under the catalog lock, then — throttled
// per-job via lastPrunedAt (TRANSCRIPT_PRUNE_THROTTLE_MS) so high-frequency
// jobs don't pay the readdirSync/statSync cost every run — sweeps stale
// transcripts/logs for this job.
async function updateLastRunAndPrune(jobId, record, { transcriptPath, finishedAt, transcriptsDir, logsDir, stderr }) {
  let pruneOk = false;
  let j = null;
  try {
    await withCatalogLock(async () => {
      const cat = loadCatalog();
      j = findJob(cat, jobId);
      if (j) {
        j.lastRun = {
          startedAt: record.startedAt,
          finishedAt: record.finishedAt,
          exitCode: record.exitCode,
          reason: record.reason,
          error: record.error,
        };
        if (transcriptPath) j.lastRun.transcriptPath = transcriptPath;
        if (record.tokens) j.lastRun.tokens = record.tokens;
        if (record.finalTextPreview) j.lastRun.finalTextPreview = record.finalTextPreview;
        j.updatedAt = finishedAt;

        const nowMs = Date.now();
        const lastPrunedMs = j.lastPrunedAt && Number.isFinite(Date.parse(j.lastPrunedAt))
          ? Date.parse(j.lastPrunedAt) : 0;
        if (nowMs - lastPrunedMs >= TRANSCRIPT_PRUNE_THROTTLE_MS) {
          j.lastPrunedAt = new Date(nowMs).toISOString();
          pruneOk = true;
        }

        saveCatalog(cat);
      }
    });
    if (!j || pruneOk) {
      const pruneNowMs = Date.now();
      try { pruneTranscripts(jobId, transcriptsDir, { now: pruneNowMs, stderr }); } catch (err) {
        stderr.write(`pi-tick: prune failed: ${err.message}\n`);
      }
      try { pruneLogs(jobId, logsDir, { now: pruneNowMs, stderr }); } catch (err) {
        stderr.write(`pi-tick: prune logs failed: ${err.message}\n`);
      }
    }
  } catch (err) {
    stderr.write(`pi-tick: lastRun update failed: ${err && err.message ? err.message : err}\n`);
  }
}

export async function runJob(job, trigger, options) {
  const { nodePath, piPath, transcriptsDir, logsDir, spawnFn = spawn, stderr = process.stderr, envPath, defaultModel } = options;

  const { isSlashCommand, args, effectiveModel } = buildRunArgs(job, { defaultModel });

  const startedAt = new Date().toISOString();
  const runId = randomBytes(4).toString("hex");

  let transcriptStream = null;
  let transcriptPath = null;
  let transcriptWriteError = null;
  try {
    const tDir = join(transcriptsDir, job.id);
    mkdirSync(tDir, { recursive: true, mode: 0o700 });
    transcriptPath = join(tDir, `${safeTimestamp(startedAt)}_${runId}.jsonl`);
    transcriptStream = createWriteStream(transcriptPath, { flags: "w", mode: 0o600 });
    transcriptStream.on("error", (err) => {
      transcriptWriteError = err;
      stderr.write(`pi-tick: transcript write failed: ${err.message}\n`);
    });
  } catch (err) {
    transcriptWriteError = err;
    stderr.write(`pi-tick: cannot open transcript ${transcriptPath || "(unknown)"}: ${err.message}\n`);
  }

  const childProgram = nodePath && existsSync(nodePath) ? nodePath : piPath;
  const childArgs = nodePath && existsSync(nodePath) ? [piPath, ...args] : args;

  const env = { ...process.env, CONTEXT_MODE_BRIDGE_DEPTH: process.env.CONTEXT_MODE_BRIDGE_DEPTH || "1" };
  if (envPath) env.PATH = envPath;

  let child;
  try {
    child = spawnFn(childProgram, childArgs, {
      cwd: job.cwd,
      stdio: [isSlashCommand ? "pipe" : "ignore", "pipe", "pipe"],
      env,
      // detached makes the child its own process-group leader, so /tick
      // kill (issue #47) can signal -child.pid to reach every descendant
      // the child itself spawns, not just the immediate pi process.
      detached: true,
    });
  } catch (err) {
    clearActiveRun(job.id, runId);
    if (transcriptStream) {
      await new Promise(r => transcriptStream.end(r));
    }
    return {
      exitCode: 1,
      reason: "spawn_error",
      error: `spawn failed: ${err.message}`,
      startedAt,
      finishedAt: new Date().toISOString(),
      runId,
      transcriptPath,
      transcriptBytes: 0,
    };
  }

  // Record the run as active only once the child actually exists. `pid`
  // is THIS process (the runner) — for an in-process call from the
  // extension that's the user's whole pi session, never safe to kill.
  // `childPid` is the actual spawned pi process and is what /tick kill
  // targets (run-registry.mjs's killActiveRun never touches `pid`).
  try {
    writeActiveRun(job.id, { jobId: job.id, runId, startedAt, pid: process.pid, childPid: child.pid });
  } catch { /* best effort */ }

  const rpc = createRpcLifecycle({ isSlashCommand, child });
  // Keep RPC stdin open until the assistant turn finishes (see
  // createRpcLifecycle above for why).
  rpc.writePrompt(job.prompt);

  // Issue #48 — trigger is always passed explicitly by callers now (cmdRun
  // reads --manual, not process.env). "external" only covers direct
  // runJob() callers (tests) that don't pass a trigger at all.
  const triggerKind = trigger || "external";
  let stderrBuf = "";
  let spawnErr = null;
  let lineBuf = "";

  const controls = createRunControls(child, {
    timeoutMs: Number.isFinite(job.timeoutMs) ? job.timeoutMs : RUNTIME_DEFAULTS.timeoutMs,
    idleTimeoutMs: Number.isFinite(job.idleTimeoutMs) ? job.idleTimeoutMs : RUNTIME_DEFAULTS.idleTimeoutMs,
    killGraceMs: Number.isFinite(job.killGraceMs) ? job.killGraceMs : RUNTIME_DEFAULTS.killGraceMs,
  });
  const maxOutputBytes = Number.isFinite(job.maxOutputBytes) ? job.maxOutputBytes : RUNTIME_DEFAULTS.maxOutputBytes;

  const outputBudget = { bytes: 0 };
  const stderrDecoder = new StringDecoder("utf8");
  const stdoutDecoder = new StringDecoder("utf8");

  child.stderr.on("data", (chunk) => {
    const { text: s, capped } = decodeWithCap(chunk, stderrDecoder, outputBudget, maxOutputBytes);
    if (capped) controls.killChild("output_cap");
    stderrBuf = (stderrBuf + s).slice(-16384);
    if (s.length > 0 && transcriptStream && !transcriptWriteError) {
      transcriptStream.write(s);
    }
    if (chunk.length > 0) controls.resetIdleTimer();
  });

  child.stdout.on("data", (chunk) => {
    const { text: s, capped } = decodeWithCap(chunk, stdoutDecoder, outputBudget, maxOutputBytes);
    if (capped) controls.killChild("output_cap");
    if (s.length > 0 && transcriptStream && !transcriptWriteError) {
      transcriptStream.write(s);
    }
    lineBuf = (lineBuf + s).slice(-1048576); // Cap line buffer to 1MB
    let nlIdx;
    while ((nlIdx = lineBuf.indexOf("\n")) !== -1) {
      const line = lineBuf.slice(0, nlIdx);
      lineBuf = lineBuf.slice(nlIdx + 1);
      if (!line.trim()) continue;
      rpc.handleLine(line);
    }
    if (chunk.length > 0) controls.resetIdleTimer();
  });

  controls.armWallTimer();
  controls.resetIdleTimer();

  return new Promise((resolve) => {
    child.on("error", (err) => {
      spawnErr = err;
    });
    child.on("close", async (code, signal) => {
      controls.clearAll();
      rpc.clear();

      if (transcriptStream) {
        await new Promise(r => transcriptStream.end(r));
        transcriptStream = null;
      }

      const finishedAt = new Date().toISOString();

      let transcriptBytes = null;
      if (transcriptPath && existsSync(transcriptPath)) {
        try { transcriptBytes = statSync(transcriptPath).size; } catch { /* best effort */ }
      }

      const record = buildRunRecord({
        runId, jobId: job.id, triggerKind, startedAt, finishedAt,
        code, signal, spawnErr, killReason: controls.getKillReason(), transcriptWriteError,
        stderrBuf, finalText: rpc.getFinalText(), effectiveModel, lastUsage: rpc.getLastUsage(),
        transcriptPath, transcriptBytes,
      });

      try { appendJsonl(runsFile(), record); } catch { /* best effort */ }
      try { ensureFileMode(runsFile(), 0o600); } catch { /* best effort */ }
      clearActiveRun(job.id, runId);

      await updateLastRunAndPrune(job.id, record, { transcriptPath, finishedAt, transcriptsDir, logsDir, stderr });

      resolve({
        exitCode: record.exitCode,
        reason: record.reason,
        error: record.error,
        startedAt,
        finishedAt,
        runId,
        transcriptPath,
        transcriptBytes,
        tokens: record.tokens,
        finalTextPreview: record.finalTextPreview,
      });
    });
  });
}
