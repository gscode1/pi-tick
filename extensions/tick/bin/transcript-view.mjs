// transcript-view.mjs — renders a job's JSONL event stream as a low-noise
// chat log, and the small set of helpers (file listing, run-record lookup,
// header formatting) that support it.
//
// Issue #58: this used to be ~340 lines inline in tick-core.mjs, exported
// piecemeal as a dozen symbols purely so tests could reach them. The public
// interface is `renderTranscript(events, opts)` (prettyPrintTranscript is
// kept as an alias — existing tests and tooling call it by that name).
// Everything else here is a supporting helper, still exported individually
// because existing tests exercise them directly (truncation edge cases,
// filename parsing, etc.) — but cmdShow/cmdTranscripts in tick-core.mjs now
// only call the entry points (renderTranscript, listTranscriptFiles,
// findRunRecord, formatRunHeader), not the internals.
//
// formatLocal/durationSeconds/tailLines live in format.mjs — a small,
// catalog-independent module, so importing them here no longer risks the
// tick-core.mjs import cycle that used to motivate routing through
// catalog.mjs (issue #58).

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { runsFile } from "./paths.mjs";
import { transcriptJobDir } from "./catalog.mjs";
import { formatLocal, durationSeconds, tailLines } from "./format.mjs";

// Default truncation knobs for the chat-style pretty-printer. These are
// exposed as constants so tests can reference the same values.
export const CHAT_MAX_THINKING_CHARS = 240;
export const CHAT_MAX_THINKING_LINES = 6;
export const CHAT_MAX_TOOL_RESULT_CHARS = 500;
export const CHAT_MAX_TOOL_RESULT_LINES = 5;
export const CHAT_MAX_TOOL_ARGS_CHARS = 100;

// Render one assistant turn's content blocks (thinking, text, tool calls)
// in content order. Shared by the normal message_end path and the partial-
// turn path below (issue #50) — both need byte-for-byte the same formatting.
function renderAssistantContent(content, out, { maxThink, maxThinkLines, maxToolArgs }) {
  const thinkingParts = content
    .filter((p) => p && p.type === "thinking" && typeof p.thinking === "string")
    .map((p) => p.thinking);
  const renderable = content.filter(
    (p) =>
      p &&
      ((p.type === "text" && typeof p.text === "string") ||
        p.type === "toolCall" ||
        p.type === "tool_use"),
  );

  if (thinkingParts.length > 0) {
    const joined = thinkingParts.join("\n").trim();
    const truncated = truncateForChat(joined, maxThink, maxThinkLines);
    out.push("");
    for (const line of truncated.split("\n")) {
      out.push(`  ${line}`);
    }
  }

  let hasBlock = thinkingParts.length > 0;
  for (const part of renderable) {
    if (part.type === "text") {
      if (hasBlock) out.push("");
      for (const rawLine of part.text.split("\n")) {
        out.push(`→ ${rawLine.trimEnd()}`);
      }
      hasBlock = true;
    } else {
      // toolCall / tool_use
      const name = part.name || part.toolName || part.tool || "?";
      const args = part.arguments ?? part.args ?? part.input ?? {};
      const argsStr = formatToolArgs(args, maxToolArgs);
      out.push(hasBlock ? "" : "");
      out.push(`  → ${name}: ${argsStr}`);
      hasBlock = true;
    }
  }
  return hasBlock;
}

// Accumulate a streaming delta into the last content block of `open`,
// creating one of the requested `kind` if the last block doesn't match.
// Used by the partial-turn path (issue #50) to absorb content_block_delta
// events that arrive after a message_start/message_update with no content
// of their own yet.
function appendOpenDelta(open, kind, text) {
  const last = open.content[open.content.length - 1];
  if (last && last.type === kind) {
    if (kind === "thinking") last.thinking += text;
    else last.text += text;
    return;
  }
  open.content.push(kind === "thinking" ? { type: "thinking", thinking: text } : { type: "text", text });
}

// Render a transcript event stream as a low-noise chat log. Walks
// `message_end` events (each carries the complete final content of its
// turn) and groups user prompts, assistant thinking, tool calls, tool
// results, and the final assistant answer into a single readable block.
//
// Issue #50 — a run killed mid-turn (output cap, timeout, idle timeout,
// /tick kill) never produces a closing message_end for its last assistant
// turn, so that turn used to render nothing. We track the open (not yet
// closed) assistant message via message_start/message_update snapshots and
// content_block_delta accumulation; if the stream ends while one is still
// open, it's rendered through the same path as a completed turn, with a
// trailing marker noting it was interrupted.
//
// Visual contract:
//   > ...           user prompt (one or more lines, each prefixed with '>')
//     ...           assistant thinking (2-space indent, truncated)
//     → tool: ...   tool call (2-space indent, single line)
//       ...         tool result (4-space indent, truncated)
//   → ...           assistant final text (no indent, full)
//   (turn interrupted before completion)   — only for a partial trailing turn
export function prettyPrintTranscript(events, opts = {}) {
  const maxThink = opts.maxThinkingChars ?? CHAT_MAX_THINKING_CHARS;
  const maxThinkLines = opts.maxThinkingLines ?? CHAT_MAX_THINKING_LINES;
  const maxToolRes = opts.maxToolResultChars ?? CHAT_MAX_TOOL_RESULT_CHARS;
  const maxToolResLines = opts.maxToolResultLines ?? CHAT_MAX_TOOL_RESULT_LINES;
  const maxToolArgs = opts.maxToolArgsChars ?? CHAT_MAX_TOOL_ARGS_CHARS;
  const assistantOpts = { maxThink, maxThinkLines, maxToolArgs };

  const out = [];
  // The in-progress assistant message, if any turn is currently open
  // (started but not yet closed by message_end).
  let open = null;

  for (const evt of events) {
    if (!evt || typeof evt.type !== "string") continue;

    if ((evt.type === "message_start" || evt.type === "message_update")
      && evt.message && evt.message.role === "assistant") {
      // Snapshot replaces whatever was open: message_update carries the
      // full current state of the turn, not just a diff.
      open = { content: Array.isArray(evt.message.content) ? evt.message.content.slice() : [] };
      continue;
    }
    if (evt.type === "content_block_delta" && evt.delta && open) {
      if (typeof evt.delta.text === "string") appendOpenDelta(open, "text", evt.delta.text);
      else if (typeof evt.delta.thinking === "string") appendOpenDelta(open, "thinking", evt.delta.thinking);
      continue;
    }

    if (evt.type !== "message_end" || !evt.message) continue;
    const m = evt.message;
    if (m.role === "assistant") open = null; // closed normally — nothing left to flush
    const content = Array.isArray(m.content) ? m.content : [];

    if (m.role === "user") {
      const texts = content
        .filter((p) => p && p.type === "text" && typeof p.text === "string")
        .map((p) => p.text);
      if (texts.length > 0) {
        out.push("");
        for (const t of texts) {
          for (const line of t.trimEnd().split("\n")) {
            out.push(`> ${line}`);
          }
        }
      }
    } else if (m.role === "assistant") {
      renderAssistantContent(content, out, assistantOpts);
    } else if (m.role === "tool" || m.role === "toolResult") {
      const texts = content
        .filter((p) => p && p.type === "text" && typeof p.text === "string")
        .map((p) => p.text);
      let body;
      if (texts.length > 0) {
        body = texts.join("\n").trim();
      } else {
        try { body = JSON.stringify(content, null, 2); } catch { body = String(content); }
      }
      const { text: truncated, dropped } = truncateByLines(body, maxToolResLines, maxToolRes);
      out.push("");
      for (const line of truncated.split("\n")) {
        out.push(`    ${line}`);
      }
      if (dropped > 0) {
        out.push(`    …(${dropped} more ${dropped === 1 ? "line" : "lines"})`);
      }
    }
  }

  // The stream ended with an assistant turn still open: render whatever
  // streamed before the cut, then mark it as partial.
  if (open && open.content.length > 0) {
    const hadBlock = renderAssistantContent(open.content, out, assistantOpts);
    out.push(hadBlock ? "  (turn interrupted before completion)" : "(turn interrupted before completion)");
  }

  return out.join("\n");
}

// Canonical name for the module's entry point (issue #58). Same function —
// prettyPrintTranscript is kept as the primary export because existing
// tests/tooling call it by that name.
export const renderTranscript = prettyPrintTranscript;

export function formatToolArgs(args, maxChars) {
  if (args == null) return "";
  let s;
  if (typeof args === "string") {
    s = args;
  } else {
    try { s = JSON.stringify(args); } catch { s = String(args); }
  }
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + "…";
}

export function truncateForChat(text, maxChars, maxLines) {
  const { text: byLines } = truncateByLines(text, maxLines, maxChars);
  if (byLines.length < text.length) {
    return byLines + "\n…(truncated)";
  }
  return byLines;
}

export function truncateByLines(text, maxLines, maxChars) {
  const lines = text.split("\n");
  let kept = lines;
  let dropped = 0;
  if (lines.length > maxLines) {
    kept = lines.slice(0, maxLines);
    dropped = lines.length - maxLines;
  }
  let result = kept.join("\n");
  if (result.length > maxChars) {
    // Hard truncate on a char boundary; if we cut mid-line, keep whole lines.
    let cut = result.slice(0, maxChars);
    const lastNl = cut.lastIndexOf("\n");
    if (lastNl > 0) cut = cut.slice(0, lastNl);
    result = cut;
    // If we cut, the dropped count is at least the remaining full lines.
    const remainingAfterCut = lines.length - cut.split("\n").length;
    if (remainingAfterCut > dropped) dropped = remainingAfterCut;
  }
  return { text: result, dropped };
}

// Parse `<safeTimestamp>_<runId>.jsonl` → { safeTimestamp, runId } or null.
export function parseTranscriptFilename(name) {
  const m = name.match(/^(.+)_([a-f0-9]+)\.jsonl$/i);
  if (!m) return null;
  return { safeTimestamp: m[1], runId: m[2] };
}

// Look up a run record by runId in runs.jsonl. Tails the file for speed.
export function findRunRecord(runId) {
  if (!existsSync(runsFile())) return null;
  // Tails the last 5000 lines; run records are small so this is plenty.
  const lines = tailLines(runsFile(), 5000);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const rec = JSON.parse(lines[i]);
      if (rec && rec.runId === runId) return rec;
    } catch {
      // skip malformed
    }
  }
  return null;
}

// Build a one-line header summarizing a transcript's run metadata.
// Returns null when the run record is missing AND the caller did not pass
// any file info.
export function formatRunHeader(file, runRecord, jobId) {
  const parts = [];
  if (jobId) parts.push(jobId);
  const at = new Date(file.mtime);
  parts.push(formatLocal(at.toISOString()));
  if (runRecord && runRecord.runId) {
    parts.push(`run ${runRecord.runId.slice(0, 8)}`);
  }
  if (runRecord) {
    const dur = durationSeconds(runRecord.startedAt, runRecord.finishedAt);
    parts.push(`${dur}s`);
    if (runRecord.tokens) {
      parts.push(`${runRecord.tokens.input}↑ ${runRecord.tokens.output}↓`);
    }
    if (runRecord.model) parts.push(runRecord.model);
    if (runRecord.exitCode !== 0 || runRecord.error) {
      const e = runRecord.error ? `: ${runRecord.error}` : "";
      parts.push(`exit ${runRecord.exitCode}${e}`);
    }
  } else {
    parts.push(`${file.size} bytes`);
  }
  return `── ${parts.join(" · ")} ──`;
}

export function listTranscriptFiles(jobId) {
  const dir = transcriptJobDir(jobId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const full = join(dir, f);
      try {
        const st = statSync(full);
        return { name: f, path: full, mtime: st.mtime, size: st.size };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
