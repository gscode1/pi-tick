// format.mjs — generic display formatters and a file-tailing utility.
//
// Split out of catalog.mjs (which had accreted these alongside catalog CRUD
// and the lock — nothing here reads or writes the catalog). Both tick-core.mjs
// (cmdList, cmdLog, cmdTranscripts) and transcript-view.mjs (formatRunHeader,
// findRunRecord) import from here directly, which also retires the import-
// cycle workaround that used to keep these in catalog.mjs (issue #58).

import { openSync, closeSync, readSync, statSync } from "node:fs";

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

export function tailLines(path, maxLines) {
  // Read backwards from EOF in 64KB chunks.
  const fd = openSync(path, "r");
  try {
    const CHUNK = 64 * 1024;
    let pos = statSync(path).size;
    let buf = "";
    let lines = [];
    while (pos > 0 && lines.length < maxLines) {
      const readSize = Math.min(CHUNK, pos);
      pos -= readSize;
      const b = Buffer.alloc(readSize);
      readSync(fd, b, 0, readSize, pos);
      buf = b.toString("utf8") + buf;
      const parts = buf.split("\n");
      buf = parts.shift();
      lines = parts.concat(lines);
      if (lines.length > maxLines) {
        lines = lines.slice(-maxLines);
        break;
      }
    }
    if (buf.length > 0) lines.unshift(buf);
    return lines.filter((l) => l.length > 0);
  } finally {
    try { closeSync(fd); } catch { /* */ }
  }
}
