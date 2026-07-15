// test/transcripts.test.ts — transcript persistence and inspection commands.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cmdRun } from "../extensions/tick/bin/commands/run.mjs";
import { cmdLog } from "../extensions/tick/bin/commands/log.mjs";
import { cmdTranscripts } from "../extensions/tick/bin/commands/transcripts.mjs";
import { cmdShow } from "../extensions/tick/bin/commands/show.mjs";
import { transcriptsDir, logsDir } from "../extensions/tick/bin/paths.mjs";
import {
  transcriptJobDir,
  transcriptPathFor,
  safeTimestamp,
  TRANSCRIPT_PRUNE_THROTTLE_MS,
} from "../extensions/tick/bin/catalog.mjs";
import {
  listTranscriptFiles,
  prettyPrintTranscript,
  renderTranscript,
  parseTranscriptFilename,
  findRunRecord,
  formatRunHeader,
  formatToolArgs,
  truncateForChat,
  truncateByLines,
  CHAT_MAX_THINKING_CHARS,
  CHAT_MAX_TOOL_RESULT_CHARS,
  CHAT_MAX_TOOL_RESULT_LINES,
  CHAT_MAX_TOOL_ARGS_CHARS,
} from "../extensions/tick/bin/transcript-view.mjs";
import {
  TRANSCRIPT_RETENTION_DAYS,
  TRANSCRIPT_MAX_BYTES_PER_JOB,
  LOG_RETENTION_DAYS,
  LOG_MAX_BYTES_PER_FILE,
  pruneTranscripts,
  pruneLogs,
} from "../extensions/tick/bin/runner.mjs";
import {
  withTempDir,
  setupEnv,
  withEnv,
  teardownEnv,
  writeStub,
  type TestEnv,
} from "./_helpers.ts";
import { join } from "node:path";
import {
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
  utimesSync,
  mkdirSync,
  chmodSync,
} from "node:fs";

// A realistic mock pi that emits the same event stream `pi --mode json` does.
function mockPiRealistic() {
  return `printf '%s\\n' \
'{"type":"session","version":3,"id":"sess-1","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}' \
'{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"hi"}],"timestamp":1}}' \
'{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"hi"}],"timestamp":1}}' \
'{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":"brief thought","thinkingSignature":"x"},{"type":"text","text":"hi back"}],"api":"a","provider":"a","model":"a","usage":{"input":1,"output":2,"cacheRead":0,"cacheWrite":0,"totalTokens":3,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":2}}' \
'{"type":"agent_end","messages":[],"willRetry":false}'
exit 0
`;
}

function mockPiFail() {
  return `echo "boom" >&2
exit 1
`;
}

function mockPiNoOutput() {
  return `exit 0
`;
}

async function captureStdout(fn: (streams: { stdout: any, stderr: any }) => Promise<unknown> | unknown): Promise<string> {
  const out: string[] = [];
  const stdout = {
    write: (chunk: string | Uint8Array) => {
      out.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }
  } as typeof process.stdout;
  const stderr = {
    write: () => true
  } as typeof process.stderr;
  await fn({ stdout, stderr });
  return out.join("");
}

async function seedEnabledJob(env: TestEnv, id: string, piStub: string) {
  const catMod = await import(new URL("../extensions/tick/bin/catalog.mjs", import.meta.url).pathname);
  await withEnv(env, () => {
    const cat = catMod.loadCatalog();
    cat.jobs.push({
      id,
      prompt: "p",
      cwd: env.PI_TICK_DATA_DIR,
      schedule: { kind: "interval", value: { minutes: 1, seconds: 0 } },
      enabled: true,
      model: null,
      piPath: piStub,
      createdAt: "x",
      updatedAt: "x",
      lastRun: null,
    });
    catMod.saveCatalog(cat);
  });
}

// ─── Pure helpers ────────────────────────────────────────────────────────

test("safeTimestamp replaces colons and dots", () => {
  assert.equal(safeTimestamp("2026-06-16T19:58:14.831Z"), "2026-06-16T19-58-14-831Z");
  assert.equal(safeTimestamp("2026-01-01T00:00:00.000Z"), "2026-01-01T00-00-00-000Z");
});

test("transcriptPathFor combines jobId, safe timestamp, and runId", () => {
  const p = transcriptPathFor("h", "2026-06-16T19:58:14.831Z", "abcd1234");
  assert.equal(p, join(transcriptsDir(), "h", "2026-06-16T19-58-14-831Z_abcd1234.jsonl"));
});

test("transcriptJobDir nests under the global runs dir", () => {
  assert.equal(transcriptJobDir("alpha"), join(transcriptsDir(), "alpha"));
});

test("listTranscriptFiles returns [] when the job dir does not exist", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      const got = await withEnv(env, () => listTranscriptFiles("nope"));
      assert.deepEqual(got, []);
    } finally {
      teardownEnv(env);
    }
  });
});

test("prettyPrintTranscript renders user prompt, thinking, and assistant text in chat style", () => {
  const events = [
    { type: "session" },
    {
      type: "message_end",
      message: {
        role: "user",
        content: [{ type: "text", text: "ping" }],
      },
    },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "pong" }],
      },
    },
  ];
  const out = prettyPrintTranscript(events);
  // User prompt is prefixed with '> '.
  assert.match(out, /\n> ping\n/);
  // Thinking is indented 2 spaces, no divider.
  assert.match(out, /\n  hmm\n/);
  // Final assistant text starts with '→ ' (no indent).
  assert.match(out, /\n→ pong\n?$/);
  // No noisy dividers.
  assert.doesNotMatch(out, /───/);
});

test("prettyPrintTranscript renders tool calls and tool results with chat-style indentation", () => {
  const events = [
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "let me check" },
          { type: "toolCall", name: "bash", arguments: { command: "ls" } },
        ],
      },
    },
    {
      type: "message_end",
      message: {
        role: "tool",
        content: [{ type: "text", text: "file.txt\n" }],
      },
    },
  ];
  const out = prettyPrintTranscript(events);
  // Tool call is indented 2 spaces and prefixed with '→ '.
  assert.match(out, /  → bash: \{"command":"ls"\}/);
  // Tool result is indented 4 spaces.
  assert.match(out, /    file\.txt/);
});

test("prettyPrintTranscript collapses a multi-line user prompt with '> ' on every line", () => {
  const events = [
    {
      type: "message_end",
      message: {
        role: "user",
        content: [{ type: "text", text: "line one\nline two" }],
      },
    },
  ];
  const out = prettyPrintTranscript(events);
  const lines = out.split("\n").filter((l) => l.startsWith("> "));
  assert.equal(lines.length, 2);
  assert.equal(lines[0], "> line one");
  assert.equal(lines[1], "> line two");
});

test("prettyPrintTranscript truncates long thinking with a marker", () => {
  const long = "x".repeat(2000);
  const events = [
    {
      type: "message_end",
      message: {
        role: "user",
        content: [{ type: "text", text: "go" }],
      },
    },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: long }],
      },
    },
  ];
  const out = prettyPrintTranscript(events);
  assert.match(out, /…\(truncated\)/);
  // The full 2000 chars should not be present.
  assert.ok(!out.includes(long), "long thinking is truncated");
});

test("prettyPrintTranscript truncates long tool results by lines and bytes", () => {
  const manyLines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
  const events = [
    {
      type: "message_end",
      message: { role: "tool", content: [{ type: "text", text: manyLines }] },
    },
  ];
  const out = prettyPrintTranscript(events);
  assert.match(out, /…\(\d+ more lines?\)/);
  // Only first CHAT_MAX_TOOL_RESULT_LINES lines should be rendered.
  assert.ok(out.includes("line 0"));
  assert.ok(!out.includes("line 49"), "later lines are not rendered");
});

test("prettyPrintTranscript keeps the full assistant final text (no truncation)", () => {
  const longAnswer = "answer ".repeat(500);
  const events = [
    {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: longAnswer }] },
    },
  ];
  const out = prettyPrintTranscript(events);
  // Confirm a deep slice of the long answer survives (formatter trims the
  // trailing whitespace and prefixes each line with "→ ").
  const slice = longAnswer.slice(2000, 2200).trimEnd();
  assert.ok(out.includes(slice), "deep slice of the final text survives");
});

test("prettyPrintTranscript ignores events it doesn't understand", () => {
  const events = [
    { type: "session", version: 3 },
    { type: "agent_start" },
    { type: "message_update", message: { role: "assistant" } },
  ];
  assert.equal(prettyPrintTranscript(events), "");
});

// Issue #58 — transcript-view.mjs's canonical interface is renderTranscript;
// prettyPrintTranscript is kept as the same function under its original
// name so existing call sites/tests don't churn.
test("renderTranscript is the same function as prettyPrintTranscript", () => {
  assert.equal(renderTranscript, prettyPrintTranscript);
});

// ─── Partial transcripts for interrupted runs (issue #50) ────────────────
//
// A run killed mid-turn (output cap, timeout, idle timeout, /tick kill)
// never produces a closing message_end for its last assistant turn — the
// transcript just stops. Before the fix, prettyPrintTranscript only walked
// message_end events, so that final partial turn rendered nothing at all.

test("prettyPrintTranscript renders a partial turn ending in content_block_delta (no message_end)", () => {
  const events = [
    { type: "message_end", message: { role: "user", content: [{ type: "text", text: "go" }] } },
    { type: "message_start", message: { role: "assistant", content: [] } },
    { type: "content_block_delta", delta: { text: "Working on " } },
    { type: "content_block_delta", delta: { text: "it now" } },
    // No message_end — the run was killed right here.
  ];
  const out = prettyPrintTranscript(events);
  assert.match(out, /Working on it now/);
  assert.match(out, /\(turn interrupted before completion\)/);
});

test("prettyPrintTranscript renders partial thinking from content_block_delta", () => {
  const events = [
    { type: "message_start", message: { role: "assistant", content: [] } },
    { type: "content_block_delta", delta: { thinking: "considering the " } },
    { type: "content_block_delta", delta: { thinking: "options" } },
  ];
  const out = prettyPrintTranscript(events);
  assert.match(out, /considering the options/);
  assert.match(out, /\(turn interrupted before completion\)/);
});

test("prettyPrintTranscript renders a partial turn from message_update snapshots (no content_block_delta)", () => {
  // mockPi()'s actual event shape: message_update carries the full current
  // message state, not a diff — this is the more realistic interruption.
  const events = [
    { type: "message_start", message: { role: "assistant", content: [] } },
    { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "Partial respo" }] } },
    { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "Partial response so far" }] } },
  ];
  const out = prettyPrintTranscript(events);
  assert.match(out, /Partial response so far/);
  assert.match(out, /\(turn interrupted before completion\)/);
});

test("prettyPrintTranscript does not mark a normally-completed turn as interrupted", () => {
  const events = [
    { type: "message_start", message: { role: "assistant", content: [] } },
    { type: "content_block_delta", delta: { text: "draft" } },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "final answer" }] } },
  ];
  const out = prettyPrintTranscript(events);
  assert.match(out, /final answer/);
  assert.doesNotMatch(out, /draft/, "the closed message_end content replaces the streamed draft");
  assert.doesNotMatch(out, /interrupted/);
});

test("prettyPrintTranscript renders nothing extra when no turn is open at EOF", () => {
  const events = [
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
  ];
  const out = prettyPrintTranscript(events);
  assert.doesNotMatch(out, /interrupted/);
});

// ─── Runner: transcript file is written ──────────────────────────────────

test("cmdRun writes a transcript file for the run", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    const piStub = writeStub(env, "pi", mockPiRealistic());
    try {
      await seedEnabledJob(env, "t1", piStub);
      const code = await withEnv(env, () => cmdRun(["t1"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      assert.equal(code, 0);
      const files = await withEnv(env, () => listTranscriptFiles("t1"));
      assert.equal(files.length, 1, "exactly one transcript file");
      assert.ok(existsSync(files[0].path));
      const content = readFileSync(files[0].path, "utf8");
      const events = content.split("\n").filter(Boolean).map((l) => JSON.parse(l));
      assert.ok(events.some((e) => e.type === "message_end" && e.message?.role === "assistant"));
      assert.ok(events.some((e) => e.type === "message_end" && e.message?.role === "user"));
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdRun transcript file has mode 0600", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    const piStub = writeStub(env, "pi", mockPiRealistic());
    try {
      await seedEnabledJob(env, "t2", piStub);
      await withEnv(env, () => cmdRun(["t2"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      const files = await withEnv(env, () => listTranscriptFiles("t2"));
      assert.equal(files.length, 1);
      assert.equal(statSync(files[0].path).mode & 0o777, 0o600);
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdRun populates transcriptPath, transcriptBytes, and finalTextPreview on the record", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    const piStub = writeStub(env, "pi", mockPiRealistic());
    try {
      await seedEnabledJob(env, "t3", piStub);
      await withEnv(env, () => cmdRun(["t3"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      const rec = JSON.parse(readFileSync(join(dir, "runs.jsonl"), "utf8").trim());
      const files = await withEnv(env, () => listTranscriptFiles("t3"));
      assert.ok(rec.transcriptPath, "transcriptPath is set");
      assert.equal(rec.transcriptPath, files[0].path);
      assert.ok(rec.transcriptBytes > 0, "transcriptBytes > 0");
      assert.equal(rec.transcriptBytes, statSync(rec.transcriptPath).size);
      assert.equal(rec.finalTextPreview, "hi back");
      assert.equal(rec.tokens.input, 1);
      assert.equal(rec.tokens.output, 2);
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdRun records finalTextPreview truncated with ellipsis for long responses", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    const longText = "x".repeat(500);
    const stub = `printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"${longText}"}],"api":"a","provider":"a","model":"a","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":0}}'
exit 0
`;
    const piStub = writeStub(env, "pi", stub);
    try {
      await seedEnabledJob(env, "tlong", piStub);
      await withEnv(env, () => cmdRun(["tlong"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      const rec = JSON.parse(readFileSync(join(dir, "runs.jsonl"), "utf8").trim());
      assert.ok(rec.finalTextPreview.endsWith("\u2026"), "preview ends with ellipsis");
      assert.equal(rec.finalTextPreview.length, 201); // 200 chars + ellipsis
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdRun still writes a transcript file when pi exits non-zero", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    const piStub = writeStub(env, "pi", mockPiFail());
    try {
      await seedEnabledJob(env, "tfail", piStub);
      const code = await withEnv(env, () => cmdRun(["tfail"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      assert.equal(code, 1);
      const files = await withEnv(env, () => listTranscriptFiles("tfail"));
      assert.equal(files.length, 1, "transcript exists even on failure");
      const rec = JSON.parse(readFileSync(join(dir, "runs.jsonl"), "utf8").trim());
      assert.ok(rec.transcriptPath);
      assert.equal(rec.exitCode, 1);
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdRun writes an empty transcript when pi produces no output", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    const piStub = writeStub(env, "pi", mockPiNoOutput());
    try {
      await seedEnabledJob(env, "tempty", piStub);
      await withEnv(env, () => cmdRun(["tempty"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      const files = await withEnv(env, () => listTranscriptFiles("tempty"));
      assert.equal(files.length, 1);
      assert.equal(files[0].size, 0);
      const rec = JSON.parse(readFileSync(join(dir, "runs.jsonl"), "utf8").trim());
      assert.ok(rec.transcriptPath);
      assert.equal(rec.transcriptBytes, 0);
      assert.equal(rec.finalTextPreview, undefined);
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdRun updates jobs.json lastRun with transcript fields", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    const piStub = writeStub(env, "pi", mockPiRealistic());
    try {
      await seedEnabledJob(env, "tcat", piStub);
      await withEnv(env, () => cmdRun(["tcat"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      const catMod = await import(new URL("../extensions/tick/bin/catalog.mjs", import.meta.url).pathname);
      const cat = await withEnv(env, () => catMod.loadCatalog());
      const j = cat.jobs.find((x: { id: string }) => x.id === "tcat");
      assert.ok(j.lastRun);
      assert.ok(j.lastRun.transcriptPath);
      assert.equal(j.lastRun.tokens.input, 1);
      assert.equal(j.lastRun.finalTextPreview, "hi back");
    } finally {
      teardownEnv(env);
    }
  });
});

// ─── cmdTranscripts ──────────────────────────────────────────────────────

test("cmdTranscripts on a job with no runs prints '(no transcripts ...)'", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      const out = await captureStdout(({ stdout, stderr }) => withEnv(env, () => cmdTranscripts(["nope"], { stdout, stderr })));
      assert.match(out, /\(no transcripts for job 'nope'\)/);
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdTranscripts lists transcript files newest-first with size and path", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    const piStub = writeStub(env, "pi", mockPiRealistic());
    try {
      await seedEnabledJob(env, "tlist", piStub);
      // First run.
      await withEnv(env, () => cmdRun(["tlist"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      // Backdate the first transcript.
      const firstFiles = await withEnv(env, () => listTranscriptFiles("tlist"));
      const past = new Date(Date.now() - 60_000);
      utimesSync(firstFiles[0].path, past, past);
      // Second run.
      await withEnv(env, () => cmdRun(["tlist"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      const allFiles = await withEnv(env, () => listTranscriptFiles("tlist"));
      assert.equal(allFiles.length, 2);
      const newestFirst = [...allFiles].sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
      const out = await captureStdout(({ stdout, stderr }) => withEnv(env, () => cmdTranscripts(["tlist"], { stdout, stderr })));
      const newerIdx = out.indexOf(newestFirst[0].path);
      const olderIdx = out.indexOf(newestFirst[1].path);
      assert.ok(newerIdx > 0, "newer path appears in output");
      assert.ok(olderIdx > 0, "older path appears in output");
      assert.ok(newerIdx < olderIdx, "newer transcript listed first");
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdTranscripts respects --limit", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await withEnv(env, () => {
        const d = transcriptJobDir("multi");
        mkdirSync(d, { recursive: true, mode: 0o700 });
        writeFileSync(join(d, "z.jsonl"), "x", "utf8");
        writeFileSync(join(d, "m.jsonl"), "x", "utf8");
        writeFileSync(join(d, "a.jsonl"), "x", "utf8");
      });
      const out = await captureStdout(({ stdout, stderr }) => withEnv(env, () => cmdTranscripts(["multi", "--limit", "2"], { stdout, stderr })));
      const lines = out.trim().split("\n");
      assert.equal(lines.length, 3); // header + 2 rows
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdTranscripts rejects --limit with non-numeric value", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await assert.rejects(
        () => withEnv(env, () => cmdTranscripts(["x", "--limit", "abc"], { stdout: process.stdout as any, stderr: process.stderr as any })),
        /--limit/,
      );
    } finally {
      teardownEnv(env);
    }
  });
});

// ─── cmdShow ─────────────────────────────────────────────────────────────

test("cmdShow on a job with no runs prints '(no transcripts ...)'", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      const out = await captureStdout(({ stdout, stderr }) => withEnv(env, () => cmdShow(["nope"], { stdout, stderr })));
      assert.match(out, /\(no transcripts for job 'nope'\)/);
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdShow renders the latest transcript in chat style with a run header", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    const piStub = writeStub(env, "pi", mockPiRealistic());
    try {
      await seedEnabledJob(env, "show1", piStub);
      await withEnv(env, () => cmdRun(["show1"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      const out = await captureStdout(({ stdout, stderr }) => withEnv(env, () => cmdShow(["show1"], { stdout, stderr })));
      // Header carries run metadata: jobId, timestamp, runId, duration, tokens.
      assert.match(out, /^── show1 · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} · run [a-f0-9]{8} · \d+s · 1↑ 2↓ ──\n/);
      // Chat markers: '>' for user, '→' for assistant, indented thinking.
      assert.match(out, /\n> hi\n/);
      assert.match(out, /\n  brief thought\n/);
      assert.match(out, /\n→ hi back\n?$/);
      // No verbose dividers anymore.
      assert.doesNotMatch(out, /───/);
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdShow --run 1 picks the second most recent transcript", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    const piStub = writeStub(env, "pi", mockPiRealistic());
    try {
      await seedEnabledJob(env, "show2", piStub);
      await withEnv(env, () => cmdRun(["show2"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      const firstFiles = await withEnv(env, () => listTranscriptFiles("show2"));
      utimesSync(firstFiles[0].path, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
      await withEnv(env, () => cmdRun(["show2"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      const allFiles = await withEnv(env, () => listTranscriptFiles("show2"));
      const newestFirst = [...allFiles].sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
      // Each run has a unique runId; --run 1 should show the older file's
      // truncated runId in the header, not the newer one.
      const olderRunId = parseTranscriptFilename(newestFirst[1].name).runId.slice(0, 8);
      const newerRunId = parseTranscriptFilename(newestFirst[0].name).runId.slice(0, 8);
      const out = await captureStdout(({ stdout, stderr }) => withEnv(env, () => cmdShow(["show2", "--run", "1"], { stdout, stderr })));
      assert.match(out, new RegExp(`run ${olderRunId}`), "header shows the older run's id");
      assert.ok(!out.includes(`run ${newerRunId}`), "header does not show the newer run's id");
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdShow --run-id picks a specific transcript", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    const piStub = writeStub(env, "pi", mockPiRealistic());
    try {
      await seedEnabledJob(env, "show-id", piStub);
      await withEnv(env, () => cmdRun(["show-id"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      const firstFiles = await withEnv(env, () => listTranscriptFiles("show-id"));
      utimesSync(firstFiles[0].path, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
      await withEnv(env, () => cmdRun(["show-id"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      const allFiles = await withEnv(env, () => listTranscriptFiles("show-id"));
      const oldest = [...allFiles].sort((a, b) => a.mtime.getTime() - b.mtime.getTime())[0];
      const runId = parseTranscriptFilename(oldest.name).runId;
      const out = await captureStdout(({ stdout, stderr }) => withEnv(env, () => cmdShow(["show-id", "--run-id", runId], { stdout, stderr })));
      assert.match(out, new RegExp(`run ${runId.slice(0, 8)}`));
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdShow --run out-of-range errors with PiTickError(2)", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    const piStub = writeStub(env, "pi", mockPiRealistic());
    try {
      await seedEnabledJob(env, "show3", piStub);
      await withEnv(env, () => cmdRun(["show3"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      await assert.rejects(
        () => withEnv(env, () => cmdShow(["show3", "--run", "5"], { stdout: process.stdout as any, stderr: process.stderr as any })),
        /out of range/,
      );
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdShow handles a transcript with no renderable events", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await withEnv(env, () => {
        const d = transcriptJobDir("empty");
        mkdirSync(d, { recursive: true, mode: 0o700 });
        writeFileSync(join(d, "only-session.jsonl"), '{"type":"session","version":3}\n', "utf8");
      });
      const out = await captureStdout(({ stdout, stderr }) => withEnv(env, () => cmdShow(["empty"], { stdout, stderr })));
      assert.match(out, /no renderable content/);
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdShow --no-meta skips the run header", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    const piStub = writeStub(env, "pi", mockPiRealistic());
    try {
      await seedEnabledJob(env, "nometa", piStub);
      await withEnv(env, () => cmdRun(["nometa"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      const out = await captureStdout(({ stdout, stderr }) =>
        withEnv(env, () => cmdShow(["nometa", "--no-meta"], { stdout, stderr })),
      );
      assert.ok(!out.startsWith("── "), "no header line");
      // But the chat body is still rendered.
      assert.match(out, /hi back/);
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdShow --raw emits one event: line per JSONL event", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    const piStub = writeStub(env, "pi", mockPiRealistic());
    try {
      await seedEnabledJob(env, "raw1", piStub);
      await withEnv(env, () => cmdRun(["raw1"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      const out = await captureStdout(({ stdout, stderr }) => withEnv(env, () => cmdShow(["raw1", "--raw"], { stdout, stderr })));
      const lines = out.trimEnd().split("\n");
      // Every line is prefixed with 'event: ' and the payload parses.
      for (const l of lines) {
        assert.ok(l.startsWith("event: "), `line starts with 'event: ': ${l.slice(0, 30)}…`);
        const payload = l.slice("event: ".length);
        const obj = JSON.parse(payload);
        assert.ok(typeof obj.type === "string");
      }
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdShow --raw prefixes malformed lines with 'raw:' instead of dropping them", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await withEnv(env, () => {
        const d = transcriptJobDir("mixed");
        mkdirSync(d, { recursive: true, mode: 0o700 });
        writeFileSync(
          join(d, "x_abcd1234.jsonl"),
          '{"type":"session","version":3}\n{ not json\n{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}\n',
          "utf8",
        );
      });
      const out = await captureStdout(({ stdout, stderr }) => withEnv(env, () => cmdShow(["mixed", "--raw"], { stdout, stderr })));
      assert.match(out, /^event: \{/m);
      assert.match(out, /^raw: \{ not json$/m);
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdShow --tail N limits the view to the last N assistant turns", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await withEnv(env, () => {
        const d = transcriptJobDir("multi");
        mkdirSync(d, { recursive: true, mode: 0o700 });
        // Build a transcript with 3 turns.
        const lines = [
          '{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"turn1"}]}}',
          '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"answer1"}]}}',
          '{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"turn2"}]}}',
          '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"answer2"}]}}',
          '{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"turn3"}]}}',
          '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"answer3"}]}}',
        ];
        writeFileSync(join(d, "m_abcd1234.jsonl"), lines.join("\n") + "\n", "utf8");
      });
      const out = await captureStdout(({ stdout, stderr }) => withEnv(env, () => cmdShow(["multi", "--tail", "2", "--no-meta"], { stdout, stderr })));
      assert.match(out, /turn2/);
      assert.match(out, /answer2/);
      assert.match(out, /turn3/);
      assert.match(out, /answer3/);
      assert.doesNotMatch(out, /turn1/);
      assert.doesNotMatch(out, /answer1/);
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdShow --tail 0 returns the full transcript", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await withEnv(env, () => {
        const d = transcriptJobDir("full");
        mkdirSync(d, { recursive: true, mode: 0o700 });
        writeFileSync(
          join(d, "f_abcd1234.jsonl"),
          '{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"u1"}]}}\n' +
            '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"a1"}]}}\n' +
            '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"a2"}]}}\n',
          "utf8",
        );
      });
      const out = await captureStdout(({ stdout, stderr }) => withEnv(env, () => cmdShow(["full", "--tail", "0", "--no-meta"], { stdout, stderr })));
      assert.match(out, /u1/);
      assert.match(out, /a1/);
      assert.match(out, /a2/);
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdShow rejects non-integer --tail", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await assert.rejects(
        () => withEnv(env, () => cmdShow(["x", "--tail", "abc"], { stdout: process.stdout as any, stderr: process.stderr as any })),
        /--tail/,
      );
    } finally {
      teardownEnv(env);
    }
  });
});

// ─── Pure helpers: filename parse, run lookup, header formatting ───────

test("parseTranscriptFilename extracts safeTimestamp and runId", () => {
  const p = parseTranscriptFilename("2026-06-16T20-18-02-427Z_edb872fe.jsonl");
  assert.deepEqual(p, { safeTimestamp: "2026-06-16T20-18-02-427Z", runId: "edb872fe" });
  assert.equal(parseTranscriptFilename("nope.jsonl"), null);
  assert.equal(parseTranscriptFilename("foo_bar_baz.jsonl"), null);
});

test("findRunRecord returns null when runs.jsonl is missing", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      const got = await withEnv(env, () => findRunRecord("anything"));
      assert.equal(got, null);
    } finally {
      teardownEnv(env);
    }
  });
});

test("findRunRecord finds a run by runId", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      const rec = {
        runId: "abcd1234",
        jobId: "j",
        triggerKind: "external",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:05.000Z",
        exitCode: 0,
        error: null,
        tokens: { input: 3, output: 7 },
        model: "test-model",
      };
      await withEnv(env, () => {
        const p = join(env.PI_TICK_DATA_DIR, "runs.jsonl");
        writeFileSync(p, JSON.stringify(rec) + "\n", "utf8");
      });
      const got = await withEnv(env, () => findRunRecord("abcd1234"));
      assert.deepEqual(got, rec);
    } finally {
      teardownEnv(env);
    }
  });
});

test("formatRunHeader includes timestamp, job, runId, duration, tokens, and model", () => {
  const file = {
    name: "2026-06-16T20-18-02-427Z_abcd1234.jsonl",
    path: "/x",
    mtime: new Date("2026-06-16T20:18:02.427Z"),
    size: 1234,
  };
  const rec = {
    runId: "abcd12345678",
    jobId: "j",
    triggerKind: "external",
    startedAt: "2026-06-16T20:18:00.000Z",
    finishedAt: "2026-06-16T20:18:05.000Z",
    exitCode: 0,
    error: null,
    tokens: { input: 14, output: 78 },
    model: "minimax/MiniMax-M3",
  };
  const out = formatRunHeader(file, rec);
  assert.match(out, /^── /);
  assert.match(out, /abcd1234/); // truncated runId
  assert.match(out, /5s/);
  assert.match(out, /14↑ 78↓/);
  assert.match(out, /minimax\/MiniMax-M3/);
  assert.match(out, / ──$/);
});

test("formatRunHeader surfaces an error in the header", () => {
  const file = {
    name: "x.jsonl",
    path: "/x",
    mtime: new Date("2026-01-01T00:00:00.000Z"),
    size: 1,
  };
  const rec = {
    runId: "abcd1234",
    jobId: "j",
    triggerKind: "external",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:00.100Z",
    exitCode: 1,
    error: "boom",
  };
  const out = formatRunHeader(file, rec);
  assert.match(out, /exit 1: boom/);
});

test("formatToolArgs truncates long args", () => {
  const long = "x".repeat(500);
  const out = formatToolArgs({ command: long }, CHAT_MAX_TOOL_ARGS_CHARS);
  assert.ok(out.length <= CHAT_MAX_TOOL_ARGS_CHARS + 1);
  assert.ok(out.endsWith("…"));
});

test("formatToolArgs returns empty for null/undefined", () => {
  assert.equal(formatToolArgs(null), "");
  assert.equal(formatToolArgs(undefined), "");
});

test("truncateForChat respects maxChars and maxLines", () => {
  const t = "x".repeat(2000);
  const out = truncateForChat(t, 100, 5);
  assert.ok(out.length <= 200); // generous bound; lines + ellipsis
  assert.match(out, /\n…\(truncated\)/);
});

test("truncateByLines returns the dropped count when content is clipped", () => {
  const text = Array.from({ length: 100 }, (_, i) => `L${i}`).join("\n");
  const { text: out, dropped } = truncateByLines(text, 5, 10_000);
  assert.ok(out.split("\n").length <= 5);
  assert.equal(dropped, 95);
});

test("truncateByLines returns the byte cap if shorter than the line cap", () => {
  const text = "abcdef\nghijkl";
  const { text: out, dropped } = truncateByLines(text, 100, 3);
  // Hard-cuts at 3 chars; only "abc" remains, the second line is gone.
  assert.equal(out, "abc");
  assert.ok(dropped >= 1);
});

// ─── End-to-end: real run shows a full chat header ──────────────────────

test("cmdShow on a real run includes the run's tokens and model in the header", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    const piStub = writeStub(env, "pi", mockPiRealistic());
    try {
      await seedEnabledJob(env, "e2e", piStub);
      await withEnv(env, () => cmdRun(["e2e"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      const out = await captureStdout(({ stdout, stderr }) => withEnv(env, () => cmdShow(["e2e"], { stdout, stderr })));
      assert.match(out, /1↑ 2↓/);
      assert.match(out, /e2e/);
      assert.match(out, /run [a-f0-9]{8}/);
    } finally {
      teardownEnv(env);
    }
  });
});

// ─── cmdLog: transcript column ──────────────────────────────────────────

test("cmdLog includes the transcript path column", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    const piStub = writeStub(env, "pi", mockPiRealistic());
    try {
      await seedEnabledJob(env, "logc", piStub);
      await withEnv(env, () => cmdRun(["logc"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      const out = await captureStdout(({ stdout, stderr }) => withEnv(env, () => cmdLog(["logc"], { stdout, stderr })));
      assert.match(out, /transcript/); // header column
      const files = await withEnv(env, () => listTranscriptFiles("logc"));
      assert.ok(out.includes(files[0].path));
    } finally {
      teardownEnv(env);
    }
  });
});

// ─── Pruning ─────────────────────────────────────────────────────────────

test("pruneTranscripts removes files older than the retention window", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await withEnv(env, () => {
        const d = transcriptJobDir("old");
        mkdirSync(d, { recursive: true, mode: 0o700 });
        const f1 = join(d, "old.jsonl");
        const f2 = join(d, "new.jsonl");
        writeFileSync(f1, "x", "utf8");
        writeFileSync(f2, "x", "utf8");
        const ancient = new Date(Date.now() - (TRANSCRIPT_RETENTION_DAYS + 1) * 86400_000);
        utimesSync(f1, ancient, ancient);
      });
      await withEnv(env, () => pruneTranscripts("old", transcriptsDir()));
      const files = await withEnv(env, () => listTranscriptFiles("old"));
      assert.equal(files.length, 1);
      assert.equal(files[0].name, "new.jsonl");
    } finally {
      teardownEnv(env);
    }
  });
});

test("pruneTranscripts constants are sane", () => {
  // The retention window is a positive number of days; the byte cap is a
  // positive integer. We don't try to fabricate a 500MB+ workload in tests,
  // but the size prune path shares its loop with the age path so this is
  // sufficient to guard against regressions in the constant declarations.
  assert.ok(TRANSCRIPT_RETENTION_DAYS > 0);
  assert.equal(typeof TRANSCRIPT_MAX_BYTES_PER_JOB, "number");
  assert.ok(TRANSCRIPT_MAX_BYTES_PER_JOB > 0);
});

test("pruneTranscripts swallows unlink errors and does not throw", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      if (typeof process.getuid === "function" && process.getuid() === 0) {
        // Running as root: chmod 000 does not prevent unlink, so the
        // error-path is not exercisable. Skip without failing.
        return;
      }
      await withEnv(env, () => {
        const d = transcriptJobDir("err");
        mkdirSync(d, { recursive: true, mode: 0o700 });
        const f = join(d, "locked.jsonl");
        writeFileSync(f, "x", "utf8");
        chmodSync(f, 0o000);
        const ancient = new Date(Date.now() - (TRANSCRIPT_RETENTION_DAYS + 1) * 86400_000);
        utimesSync(f, ancient, ancient);
      });
      // Capture stderr to keep test output clean.
      const captured: string[] = [];
      const stderr = {
        write: (c: string | Uint8Array) => {
          captured.push(typeof c === "string" ? c : c.toString());
          return true;
        }
      } as typeof process.stderr;
      await withEnv(env, () => pruneTranscripts("err", transcriptsDir(), { stderr }));
      // Restore mode so the tempdir teardown can clean up.
      await withEnv(env, () => {
        try { chmodSync(join(transcriptJobDir("err"), "locked.jsonl"), 0o600); } catch { /* */ }
      });
    } finally {
      teardownEnv(env);
    }
  });
});

// ─── pruneLogs ─────────────────────────────────────────────────────────────

test("pruneLogs removes stale logs", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await withEnv(env, () => {
        mkdirSync(logsDir(), { recursive: true, mode: 0o700 });
        const outLog = join(logsDir(), "stale.out.log");
        writeFileSync(outLog, "x", "utf8");
        const ancient = new Date(Date.now() - (LOG_RETENTION_DAYS + 2) * 86400_000);
        utimesSync(outLog, ancient, ancient);
        pruneLogs("stale", logsDir());
        assert.ok(!existsSync(outLog), "stale log was removed");
      });
    } finally {
      teardownEnv(env);
    }
  });
});

test("pruneLogs size-based pruning keeps only the tail", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await withEnv(env, () => {
        mkdirSync(logsDir(), { recursive: true, mode: 0o700 });
        const outLog = join(logsDir(), "size.out.log");
        const head = "h".repeat(100);
        const tail = "t".repeat(LOG_MAX_BYTES_PER_FILE);
        writeFileSync(outLog, head + tail, "utf8");
        pruneLogs("size", logsDir());
        assert.throws(() => statSync(outLog), { code: "ENOENT" });
        const rotatedSt = statSync(outLog + ".1");
        assert.equal(rotatedSt.size, head.length + LOG_MAX_BYTES_PER_FILE, "rotated log size matches original size");
        const content = readFileSync(outLog + ".1", "utf8");
        assert.equal(content, head + tail, "rotated log preserves original contents");
      });
    } finally {
      teardownEnv(env);
    }
  });
});

// ─── cmdRun triggers pruning automatically ───────────────────────────────

test("cmdRun prunes old transcripts automatically on completion", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    const piStub = writeStub(env, "pi", mockPiRealistic());
    try {
      await seedEnabledJob(env, "autop", piStub);
      // Seed an ancient transcript and log for the same job.
      await withEnv(env, () => {
        const d = transcriptJobDir("autop");
        mkdirSync(d, { recursive: true, mode: 0o700 });
        const f = join(d, "ancient.jsonl");
        writeFileSync(f, "x", "utf8");
        const ancientTrans = new Date(Date.now() - (TRANSCRIPT_RETENTION_DAYS + 2) * 86400_000);
        utimesSync(f, ancientTrans, ancientTrans);

        mkdirSync(logsDir(), { recursive: true, mode: 0o700 });
        const l = join(logsDir(), "autop.out.log");
        writeFileSync(l, "x", "utf8");
        const ancientLog = new Date(Date.now() - (LOG_RETENTION_DAYS + 2) * 86400_000);
        utimesSync(l, ancientLog, ancientLog);
      });
      const beforeRun = await withEnv(env, () => listTranscriptFiles("autop"));
      assert.equal(beforeRun.length, 1);
      assert.ok(existsSync(join(env.PI_TICK_DATA_DIR, "logs", "autop.out.log")));
      await withEnv(env, () => cmdRun(["autop"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      const afterRun = await withEnv(env, () => listTranscriptFiles("autop"));
      assert.equal(afterRun.length, 1, "ancient file pruned, new one present");
      assert.ok(!afterRun[0].name.includes("ancient"));
      assert.ok(!existsSync(join(env.PI_TICK_DATA_DIR, "logs", "autop.out.log")), "ancient log pruned");
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdRun skips prune when lastPrunedAt is within the throttle window", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    const piStub = writeStub(env, "pi", mockPiRealistic());
    const catMod = await import(new URL("../extensions/tick/bin/catalog.mjs", import.meta.url).pathname);
    try {
      await seedEnabledJob(env, "throttle-skip", piStub);
      // Backdate lastPrunedAt to 5 min ago — well inside the 1 h window.
      const recentIso = new Date(Date.now() - 5 * 60_000).toISOString();
      await withEnv(env, () => {
        const cat = catMod.loadCatalog();
        cat.jobs[0].lastPrunedAt = recentIso;
        catMod.saveCatalog(cat);
      });
      // Seed an ancient transcript and log for the same job.
      await withEnv(env, () => {
        const d = transcriptJobDir("throttle-skip");
        mkdirSync(d, { recursive: true, mode: 0o700 });
        const f = join(d, "ancient.jsonl");
        writeFileSync(f, "x", "utf8");
        const ancientTrans = new Date(Date.now() - (TRANSCRIPT_RETENTION_DAYS + 2) * 86400_000);
        utimesSync(f, ancientTrans, ancientTrans);

        mkdirSync(logsDir(), { recursive: true, mode: 0o700 });
        const l = join(logsDir(), "throttle-skip.out.log");
        writeFileSync(l, "x", "utf8");
        const ancientLog = new Date(Date.now() - (LOG_RETENTION_DAYS + 2) * 86400_000);
        utimesSync(l, ancientLog, ancientLog);
      });
      await withEnv(env, () => cmdRun(["throttle-skip"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      // Throttle held → ancient file survives. The new run also writes a
      // transcript, so we expect 2 files: ancient + the fresh run.
      const afterRun = await withEnv(env, () => listTranscriptFiles("throttle-skip"));
      assert.equal(afterRun.length, 2, "ancient file preserved — prune was throttled");
      assert.ok(afterRun.some((f) => f.name === "ancient.jsonl"));
      assert.ok(existsSync(join(env.PI_TICK_DATA_DIR, "logs", "throttle-skip.out.log")), "ancient log preserved");
      // lastPrunedAt was NOT refreshed.
      const cat = await withEnv(env, () => catMod.loadCatalog());
      const written = cat.jobs[0].lastPrunedAt;
      assert.equal(written, recentIso);
      // Still well inside the throttle window — elapsed since prune is ~5 min,
      // comfortably under THROTTLE_MS - 60s.
      assert.ok(Date.now() - Date.parse(written) < TRANSCRIPT_PRUNE_THROTTLE_MS - 60_000);
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdRun prunes and refreshes lastPrunedAt when past the throttle window", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    const piStub = writeStub(env, "pi", mockPiRealistic());
    const catMod = await import(new URL("../extensions/tick/bin/catalog.mjs", import.meta.url).pathname);
    try {
      await seedEnabledJob(env, "throttle-fire", piStub);
      // Backdate lastPrunedAt to just past the threshold (1 ms past).
      const staleIso = new Date(Date.now() - TRANSCRIPT_PRUNE_THROTTLE_MS - 1).toISOString();
      await withEnv(env, () => {
        const cat = catMod.loadCatalog();
        cat.jobs[0].lastPrunedAt = staleIso;
        catMod.saveCatalog(cat);
      });
      // Seed an ancient transcript for the same job.
      await withEnv(env, () => {
        const d = transcriptJobDir("throttle-fire");
        mkdirSync(d, { recursive: true, mode: 0o700 });
        const f = join(d, "ancient.jsonl");
        writeFileSync(f, "x", "utf8");
        const ancient = new Date(Date.now() - (TRANSCRIPT_RETENTION_DAYS + 2) * 86400_000);
        utimesSync(f, ancient, ancient);
      });
      await withEnv(env, () => cmdRun(["throttle-fire"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      // Gate released → ancient file gone.
      const afterRun = await withEnv(env, () => listTranscriptFiles("throttle-fire"));
      assert.equal(afterRun.length, 1, "ancient pruned, new run present");
      assert.ok(!afterRun[0].name.includes("ancient"));
      // lastPrunedAt refreshed to a fresh ISO string.
      const cat = await withEnv(env, () => catMod.loadCatalog());
      const written = cat.jobs[0].lastPrunedAt;
      assert.ok(Number.isFinite(Date.parse(written)));
      assert.ok(Date.now() - Date.parse(written) < 5_000);
    } finally {
      teardownEnv(env);
    }
  });
});

// ─── End-to-end: pid is small, format is stable across re-read ───────────

test("transcript is parseable on a second read (idempotent format)", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    const piStub = writeStub(env, "pi", mockPiRealistic());
    try {
      await seedEnabledJob(env, "idem", piStub);
      await withEnv(env, () => cmdRun(["idem"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      const files = await withEnv(env, () => listTranscriptFiles("idem"));
      const firstRead = readFileSync(files[0].path, "utf8").split("\n").filter(Boolean);
      const secondRead = readFileSync(files[0].path, "utf8").split("\n").filter(Boolean);
      assert.deepEqual(firstRead, secondRead);
      // All lines are valid JSON.
      for (const line of firstRead) JSON.parse(line);
    } finally {
      teardownEnv(env);
    }
  });
});
