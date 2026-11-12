// test/retention.test.ts — transcript/log/run-history retention (issue #31, #30).

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  existsSync, readFileSync, writeFileSync, utimesSync, mkdirSync, readdirSync, statSync,
} from "node:fs";
import { cmdShow } from "../extensions/tick/bin/commands/show.mjs";
import { cmdTranscripts } from "../extensions/tick/bin/commands/transcripts.mjs";
import { cmdLog } from "../extensions/tick/bin/commands/log.mjs";
import { transcriptsDir, logsDir, runsFile } from "../extensions/tick/bin/paths.mjs";
import { appendJsonl, safeTimestamp } from "../extensions/tick/bin/catalog.mjs";
import { findRunRecord, formatRunHeader } from "../extensions/tick/bin/transcript-view.mjs";
import { tailLines, readTail, transcriptStartMs } from "../extensions/tick/bin/format.mjs";
import { pruneTranscripts, pruneLogs, parseRetentionDays } from "../extensions/tick/bin/runner.mjs";
import { withTempDir, setupEnv, withEnv, teardownEnv, fileMode } from "./_helpers.ts";

function streams() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out, err,
    stdout: { write: (c: any) => (out.push(String(c)), true) } as any,
    stderr: { write: (c: any) => (err.push(String(c)), true) } as any,
  };
}

async function inEnv(fn: (dir: string) => unknown) {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try { await withEnv(env, () => fn(dir)); } finally { teardownEnv(env); }
  });
}

const DAY = 86400_000;
function touch(p: string, ms: number) { const d = new Date(ms); utimesSync(p, d, d); }

// ─── item 1: size prune never deletes the newest transcript ────────────────

test("pruneTranscripts never deletes the newest transcript even if it alone exceeds the cap", async () => {
  await inEnv(() => {
    const now = Date.now();
    const jobDir = join(transcriptsDir(), "big");
    mkdirSync(jobDir, { recursive: true });
    const a = join(jobDir, `${safeTimestamp(new Date(now - 2 * DAY).toISOString())}_aa11.jsonl`);
    const b = join(jobDir, `${safeTimestamp(new Date(now - 1 * DAY).toISOString())}_bb22.jsonl`);
    writeFileSync(a, Buffer.alloc(100));
    writeFileSync(b, Buffer.alloc(1000));
    touch(a, now - 2 * DAY); touch(b, now - 1 * DAY);
    pruneTranscripts("big", transcriptsDir(), { now, maxBytes: 50 });
    assert.deepEqual(readdirSync(jobDir), [b.split("/").pop()]);
  });
});

test("pruneTranscripts size pass orders by filename start time, not mtime, and honours keep", async () => {
  await inEnv(() => {
    const now = Date.now();
    const jobDir = join(transcriptsDir(), "ord");
    mkdirSync(jobDir, { recursive: true });
    const mk = (ageDays: number, id: string) =>
      join(jobDir, `${safeTimestamp(new Date(now - ageDays * DAY).toISOString())}_${id}.jsonl`);
    const oldest = mk(3, "a1"), mid = mk(2, "b2"), newest = mk(1, "c3");
    for (const p of [oldest, mid, newest]) writeFileSync(p, Buffer.alloc(100));
    // Copy/touch scrambles mtime: the newest-by-name looks oldest by mtime.
    touch(newest, now - 3 * DAY + 1000); touch(oldest, now - 1000); touch(mid, now - 2000);
    pruneTranscripts("ord", transcriptsDir(), { now, maxBytes: 100 });
    assert.ok(existsSync(newest), "newest by filename kept");
    assert.ok(!existsSync(oldest) && !existsSync(mid));

    // keep: protected path survives even when it is not the newest.
    for (const p of [oldest, mid]) writeFileSync(p, Buffer.alloc(100));
    touch(oldest, now - 1000); touch(mid, now - 1000);
    pruneTranscripts("ord", transcriptsDir(), { now, maxBytes: 100, keep: [oldest] });
    assert.ok(existsSync(oldest) && existsSync(newest) && !existsSync(mid));
  });
});

// ─── item 2: runs.jsonl rotation ───────────────────────────────────────────

test("appendJsonl rotates to .1 above the threshold, keeps lines, creates 0600", async () => {
  await inEnv((dir) => {
    process.env.PI_TICK_RUNS_MAX_BYTES = "200";
    try {
      const p = runsFile();
      for (let i = 0; i < 30; i++) appendJsonl(p, { i, pad: "x".repeat(20) });
      assert.ok(existsSync(`${p}.1`), "rotated file exists");
      assert.ok(statSync(p).size <= 200 + 60, "current file stays near threshold");
      assert.equal(fileMode(p), 0o600);
      assert.ok(!existsSync(`${p}.rotate.lock`), "lock released");
      const cur = readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).i);
      const old = readFileSync(`${p}.1`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).i);
      assert.equal(cur[cur.length - 1], 29);
      assert.equal(old[old.length - 1] + 1, cur[0], "no line lost at the rotation boundary");
    } finally {
      delete process.env.PI_TICK_RUNS_MAX_BYTES;
    }
  });
});

test("findRunRecord and cmdLog read runs.jsonl.1 when the current file is short", async () => {
  await inEnv(() => {
    const p = runsFile();
    writeFileSync(`${p}.1`, JSON.stringify({ runId: "old1", jobId: "j", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), exitCode: 0 }) + "\n");
    writeFileSync(p, JSON.stringify({ runId: "new1", jobId: "j", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), exitCode: 0 }) + "\n");
    assert.equal(findRunRecord("old1")?.runId, "old1");
    assert.equal(findRunRecord("new1")?.runId, "new1");
    const s = streams();
    cmdLog(["j", "--limit", "10"], s);
    const text = s.out.join("");
    assert.match(text, /new1|old1/);
    assert.ok(text.split("\n").filter((l) => /j\b/.test(l)).length >= 2, text);
  });
});

// ─── item 3: show is bounded; tailLines partial-line fix (#30) ─────────────

test("tailLines drops the partial first line and decodes multibyte safely (#30)", async () => {
  await withTempDir((dir) => {
    const p = join(dir, "t.txt");
    const lines = Array.from({ length: 3000 }, (_, i) => `line-${i}-é€-${"y".repeat(40)}`);
    writeFileSync(p, lines.join("\n") + "\n");
    const got = tailLines(p, 2500);
    assert.equal(got.length, 2500);
    assert.deepEqual(got, lines.slice(-2500));
    // maxBytes cut lands mid-line: first returned line must still be whole.
    const r = readTail(p, { maxBytes: 1000 });
    assert.ok(r.truncated);
    for (const l of r.lines) assert.ok(lines.includes(l), `partial line: ${l}`);
    assert.equal(r.lines[r.lines.length - 1], lines[2999]);
    assert.ok(!readTail(p, { maxBytes: 10_000_000 }).truncated);
  });
});

test("show on a transcript larger than the byte cap reads only the tail and says so", async () => {
  await inEnv(() => {
    const dir = join(transcriptsDir(), "huge");
    mkdirSync(dir, { recursive: true });
    const f = join(dir, `${safeTimestamp(new Date().toISOString())}_ab12.jsonl`);
    const evs: string[] = [];
    for (let i = 0; i < 20000; i++) {
      evs.push(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `turn-${i} ${"z".repeat(50)}` }] } }));
    }
    writeFileSync(f, evs.join("\n") + "\n");
    process.env.PI_TICK_SHOW_MAX_BYTES = "20000";
    try {
      const s = streams();
      cmdShow(["huge", "--tail", "2"], s);
      const text = s.out.join("");
      assert.match(text, /transcript truncated/);
      assert.match(text, /turn-19999/);
      assert.match(text, /turn-19998/);
      assert.doesNotMatch(text, /turn-19997 /);
      assert.ok(text.length < 5000);
      const s2 = streams();
      cmdShow(["huge"], s2);
      const t2 = s2.out.join("");
      assert.ok(t2.length < 60_000, `bounded output (${t2.length})`);
      assert.doesNotMatch(t2, /turn-0 /);
      // raw mode: note on stderr, only whole JSON lines on stdout
      const s3 = streams();
      cmdShow(["huge", "--raw"], s3);
      assert.match(s3.err.join(""), /truncated/);
      for (const l of s3.out.join("").split("\n").filter(Boolean)) assert.match(l, /^event: \{.*\}$/);
    } finally {
      delete process.env.PI_TICK_SHOW_MAX_BYTES;
    }
  });
});

// ─── item 4: filename-derived start time ───────────────────────────────────

test("transcripts and show --run N order by filename start time; header shows it", async () => {
  await inEnv(() => {
    const dir = join(transcriptsDir(), "ord2");
    mkdirSync(dir, { recursive: true });
    const t1 = "2026-03-01T10:00:00.000Z", t2 = "2026-03-02T10:00:00.000Z";
    const f1 = join(dir, `${safeTimestamp(t1)}_aaaa.jsonl`);
    const f2 = join(dir, `${safeTimestamp(t2)}_bbbb.jsonl`);
    const ev = (t: string) => JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: t }] } }) + "\n";
    writeFileSync(f1, ev("first-run")); writeFileSync(f2, ev("second-run"));
    // mtimes inverted (e.g. after a copy): old run looks newest by mtime.
    touch(f1, Date.now()); touch(f2, Date.now() - 10 * DAY);
    const s = streams();
    cmdShow(["ord2"], s);
    assert.match(s.out.join(""), /second-run/);
    const s1 = streams();
    cmdShow(["ord2", "--run", "1"], s1);
    assert.match(s1.out.join(""), /first-run/);
    const st = streams();
    cmdTranscripts(["ord2"], st);
    const lines = st.out.join("").split("\n");
    assert.match(lines[0], /startedAt/);
    assert.ok(lines[1].includes("bbbb") && lines[2].includes("aaaa"), st.out.join(""));
    const expectLocal = (iso: string) => {
      const d = new Date(iso); const p = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    };
    assert.ok(lines[1].includes(expectLocal(t2)), lines[1]);
  });
});

test("transcriptStartMs parses the filename and falls back to mtime", () => {
  const iso = "2026-03-01T10:20:30.456Z";
  assert.equal(transcriptStartMs(`${safeTimestamp(iso)}_ab12.jsonl`, 5), Date.parse(iso));
  assert.equal(transcriptStartMs("weird.jsonl", 5), 5);
  assert.equal(transcriptStartMs("nonsense_ab12.jsonl", 7), 7);
  assert.match(formatRunHeader({ name: "x", size: 1, mtime: new Date(0), startedAt: new Date(Date.parse(iso)) }, null, "j"), /2026-03-0[12]/);
});

// ─── item 5: pruneLogs retention edge cases ────────────────────────────────

test("pruneLogs with retention 0 keeps a log just written, removes an old one", async () => {
  await inEnv(() => {
    mkdirSync(logsDir(), { recursive: true });
    const cur = join(logsDir(), "j.out.log"), old = join(logsDir(), "j.err.log");
    writeFileSync(cur, "now"); writeFileSync(old, "old");
    touch(old, Date.now() - 3 * DAY);
    pruneLogs("j", logsDir(), { retentionDays: 0 });
    assert.ok(existsSync(cur), "current run's log kept");
    assert.ok(!existsSync(old), "old log removed");
  });
});

test("LOG_RETENTION_DAYS parsing: non-numeric falls back to the default", () => {
  assert.equal(parseRetentionDays("abc", 7), 7);
  assert.equal(parseRetentionDays("", 7), 7);
  assert.equal(parseRetentionDays(undefined, 7), 7);
  assert.equal(parseRetentionDays("-3", 7), 7);
  assert.equal(parseRetentionDays("0", 7), 0);
  assert.equal(parseRetentionDays("14", 7), 14);
});
