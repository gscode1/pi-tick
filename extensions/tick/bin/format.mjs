// format.mjs — generic display formatters and a file-tailing utility.
//
// Split out of catalog.mjs (which had accreted these alongside catalog CRUD
// and the lock — nothing here reads or writes the catalog). Both tick-core.mjs
// (cmdList, cmdLog, cmdTranscripts) and transcript-view.mjs (formatRunHeader,
// findRunRecord) import from here directly, which also retires the import-
// cycle workaround that used to keep these in catalog.mjs (issue #58).

import { openSync, closeSync, readSync, statSync, existsSync } from "node:fs";
import { runsFile } from "./paths.mjs";

export function formatLocal(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // YYYY-MM-DD HH:MM:SS in local time
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function durationSeconds(start, end) {
  const a = new Date(start).getTime();
  const b = new Date(end).getTime();
  return Math.max(0, Math.round((b - a) / 1000));
}

// Read the tail of a file as complete lines. Reads backwards in 64KB chunks,
// accumulating raw bytes (never decoding a chunk that may split a multi-byte
// character), and stops once enough newlines were seen for `maxLines` or
// `maxBytes` bytes were read. When the read does not start at byte 0 the
// leading partial line is dropped (issue #30). Returns { lines, truncated }
// where truncated means earlier content was not returned because of a limit.
export function readTail(path, { maxLines = Infinity, maxBytes = Infinity } = {}) {
  const fd = openSync(path, "r");
  try {
    const CHUNK = 64 * 1024;
    const size = statSync(path).size;
    let pos = size;
    let got = 0;
    let newlines = 0;
    const chunks = [];
    while (pos > 0 && got < maxBytes && newlines <= maxLines) {
      const readSize = Math.min(CHUNK, pos, maxBytes - got);
      pos -= readSize;
      const b = Buffer.alloc(readSize);
      const n = readSync(fd, b, 0, readSize, pos);
      const piece = n === readSize ? b : b.subarray(0, n);
      chunks.unshift(piece);
      got += piece.length;
      for (let i = 0; i < piece.length; i++) if (piece[i] === 0x0a) newlines++;
    }
    const all = Buffer.concat(chunks);
    const parts = [];
    let start = 0;
    for (let i = 0; i < all.length; i++) {
      if (all[i] === 0x0a) { parts.push(all.subarray(start, i)); start = i + 1; }
    }
    if (start < all.length) parts.push(all.subarray(start));
    // The first piece is partial when we did not reach the start of the file.
    if (pos > 0 && parts.length > 0) parts.shift();
    let lines = parts.map((p) => p.toString("utf8")).filter((l) => l.length > 0);
    let truncated = pos > 0;
    if (lines.length > maxLines) { lines = lines.slice(-maxLines); truncated = true; }
    return { lines, truncated };
  } finally {
    try { closeSync(fd); } catch { /* */ }
  }
}

export function tailLines(path, maxLines) {
  return readTail(path, { maxLines }).lines;
}

// Last `maxLines` run-history lines across runs.jsonl and, when more are
// needed, the rotated runs.jsonl.1 generation (see appendJsonl).
export function tailRunLines(maxLines) {
  const cur = runsFile();
  let lines = existsSync(cur) ? tailLines(cur, maxLines) : [];
  if (lines.length < maxLines) {
    const old = `${cur}.1`;
    if (existsSync(old)) lines = tailLines(old, maxLines - lines.length).concat(lines);
  }
  return lines;
}

// Transcript files are named `<safeTimestamp>_<runId>.jsonl`, where
// safeTimestamp is the run's ISO start time with ':' and '.' replaced by '-'
// (catalog.mjs safeTimestamp). Returns the start time in ms, or null.
export function parseSafeTimestamp(ts) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d{1,3}))?Z$/.exec(ts || "");
  if (!m) return null;
  const ms = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${(m[5] || "0").padEnd(3, "0")}Z`);
  return Number.isFinite(ms) ? ms : null;
}

// Start time (ms) of a transcript from its filename; mtime only as a fallback
// for names that don't parse (mtime is the finish time and changes on copy).
export function transcriptStartMs(name, mtimeMs) {
  const m = /^(.+)_([a-f0-9]+)\.jsonl$/i.exec(name || "");
  const ts = m ? parseSafeTimestamp(m[1]) : null;
  return ts ?? mtimeMs;
}

// Newest-first comparator over {startedAt: Date, mtime: Date, name} entries.
export function compareNewestFirst(a, b) {
  return (b.startedAt.getTime() - a.startedAt.getTime())
    || (b.mtime.getTime() - a.mtime.getTime())
    || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0);
}
