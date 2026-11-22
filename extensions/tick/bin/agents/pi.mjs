// agents/pi.mjs — the pi adapter: argv for a job's pi invocation and the
// RPC/JSON event lifecycle that tracks its outcome. Moved verbatim from
// runner.mjs; runner.mjs owns process lifetime, timers and storage.

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

// pi's CLI parser has no `--` end-of-options marker: a positional argument
// starting with `-` is read as an (unknown) option and one starting with `@`
// as a file to attach (issue #41). A single leading space makes pi take the
// token as the message; pi passes argv messages through untrimmed, and a
// leading space is harmless to the model.
export function protectPromptArg(prompt) {
  return /^[-@]/.test(prompt) ? ` ${prompt}` : prompt;
}

// ─── Phase: spawn plan ──────────────────────────────────────────────────
// Pure: which pi invocation mode a job runs under and the argv that follow
// from it. Slash-command jobs run via pi's RPC mode; everything else
// (including saved taskflows — /tf itself expands to a model turn, and
// unconstrained scheduled runs often pick the wrong first tool) runs as a
// one-shot prompt.
export function buildRunArgs(job, { defaultModel }) {
  const tfPrompt = taskflowPrompt(job.prompt);
  const isSlashCommand = !tfPrompt && job.prompt.trimStart().startsWith("/");
  const args = isSlashCommand ? ["--mode", "rpc", "--no-session"] : ["--mode", "json", "-p", "--no-session"];
  const effectiveModel = job.model ?? defaultModel ?? null;
  if (effectiveModel) args.push("--model", effectiveModel);
  if (tfPrompt) args.push("--tools", "taskflow");
  if (!isSlashCommand) args.push(protectPromptArg(tfPrompt || job.prompt));
  return { isSlashCommand, args, effectiveModel };
}

// stopReasons of a final assistant message that mean the turn did not finish.
const FAILED_STOP_REASONS = new Set(["error", "aborted", "toolUse"]);

// ─── Phase: RPC handshake lifecycle ────────────────────────────────────
// Keeps a slash-command job's (--mode rpc) stdin open until the assistant
// turn finishes — closing it right after the prompt only proves pi
// accepted the command, yielding an instant exit 0 with a tiny transcript.
// `agent_end` closes stdin directly; a `response`/prompt event with no
// subsequent `agent_start` within 250ms (a command that never dispatched
// to the agent, e.g. a built-in slash command) falls back to closing it
// too. Also tracks usage/final-text from message_end events, which the
// run record needs.
export function createRpcLifecycle({ isSlashCommand, child }) {
  let agentStarted = false;
  let closeTimer = null;
  let lastUsage = null;
  let finalText = null;
  let finalError = null;

  const closeStdin = () => {
    if (isSlashCommand && child.stdin && !child.stdin.destroyed) {
      try { child.stdin.end(); } catch { /* pipe already gone */ }
    }
  };

  const handleEvent = (evt) => {
    if (!evt || typeof evt.type !== "string") return;
    if (evt.type === "agent_start") {
      agentStarted = true;
      if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    }
    // pi emits agent_end with willRetry when it is about to retry the turn
    // (e.g. after a transient provider error); closing stdin then would cut
    // the retry off. Only the final agent_end closes it.
    if (evt.type === "agent_end" && !evt.willRetry) closeStdin();
    if (evt.type === "response" && evt.command === "prompt" && isSlashCommand) {
      closeTimer = setTimeout(() => {
        if (!agentStarted) closeStdin();
      }, 250);
    }
    if (evt.type === "message_end" && evt.message) {
      if (evt.message.usage) lastUsage = evt.message.usage;
      if (evt.message.role === "assistant") {
        // The LAST assistant message decides: an earlier error that a retry
        // recovered from must not fail the run (issue #13).
        // The preview is the last assistant message's text: a final message
        // with no text must not show an earlier message's text as the result.
        // A turn that ended aborted, or still waiting on a tool call, did not
        // finish and fails the run too.
        finalText = null;
        const stop = evt.message.stopReason;
        finalError = FAILED_STOP_REASONS.has(stop)
          ? String(evt.message.errorMessage || (stop === "error" ? "model error" : `run ended with stopReason ${stop}`))
          : null;
      }
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
      if (isSlashCommand && child.stdin && !child.stdin.destroyed) {
        try {
          child.stdin.write(`${JSON.stringify({ type: "prompt", message: prompt })}\n`);
        } catch { /* pipe already gone; the 'error' listener handles async EPIPE */ }
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
    getFinalError: () => finalError,
  };
}
