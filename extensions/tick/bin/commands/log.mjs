// commands/log.mjs — `pi-tick log [id] [--limit N] [--failed] [--since <dur>] [--all]`.
// `skipped` runs (a --when guard that found nothing to do) are hidden unless --all.

import { existsSync } from "node:fs";
import { runsFile } from "../paths.mjs";
import { ensureFileMode } from "../catalog.mjs";
import { parseFlags } from "../argv.mjs";
import { fail } from "../errors.mjs";
import { tailRunLines, formatLocal, durationSeconds } from "../format.mjs";
import { printTable } from "../display.mjs";

// Parse a duration string like "30m", "2h", "1d", "90s" into milliseconds.
// Throws PiTickError on bad input.
export function parseSinceDuration(s) {
  if (typeof s !== "string" || !/^\d+[smhd]$/.test(s)) {
    fail(`--since must be a non-negative integer followed by s/m/h/d (got '${s}')`, 2);
  }
  const n = Number(s.slice(0, -1));
  const unit = s.slice(-1);
  const mult = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  return n * mult;
}

export function cmdLog(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const flags = parseFlags(argv);
  const pos = flags._;
  const id = pos[0] || null;
  const limit = flags.limit === undefined || flags.limit === true ? 10 : Number(flags.limit);
  if (!Number.isInteger(limit) || limit < 0) fail(`--limit must be a non-negative integer (got '${flags.limit}')`, 2);
  const onlyFailed = flags.failed === true || flags.failed === "true";
  const showSkipped = flags.all === true || flags.all === "true";
  let sinceMs = null;
  if (flags.since !== undefined) {
    sinceMs = parseSinceDuration(String(flags.since));
  }

  if (!existsSync(runsFile())) {
    stdout.write("(no runs yet)\n");
    return 0;
  }
  // Ensure file mode is 0600 (defensive — should already be).
  ensureFileMode(runsFile(), 0o600);

  // Tail by reading backwards in 64KB chunks and counting newlines.
  // Over-fetch so post-filters still have enough to fill --limit.
  // With an id or --failed filter the matches can be arbitrarily far back, so
  // scan the whole history (current + rotated file).
  // Skipped rows are filtered out, so without --all they can bury the rest.
  const overFetch = id !== null || onlyFailed || limit === 0 || !showSkipped
    ? Infinity
    : Math.max(limit * 5 + 1000, (sinceMs != null ? 5000 : 0));
  const all = tailRunLines(overFetch);
  const records = [];
  const skippedAt = []; // startedAt of skipped rows hidden by default
  for (const line of all) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (id !== null && rec.jobId !== id) continue;
      if (onlyFailed && (!rec.exitCode || rec.exitCode === 0)) continue;
      if (sinceMs != null) {
        const t = new Date(rec.startedAt).getTime();
        if (!Number.isFinite(t) || t < Date.now() - sinceMs) continue;
      }
      if (rec.reason === "skipped" && !showSkipped) { skippedAt.push(String(rec.startedAt)); continue; }
      records.push(rec);
    } catch (err) {
      stderr.write(`pi-tick: warning: skipping malformed run line: ${err.message}\n`);
    }
  }
  // Take last N.
  // --limit 0 means all (documented in the README).
  const tail = limit === 0 ? records : records.slice(-limit);

  // Hint at hidden skipped rows within the span shown (all of them if none shown).
  const spanStart = tail.length > 0 ? String(tail[0].startedAt) : "";
  const hiddenSkipped = skippedAt.filter((t) => t >= spanStart).length;

  if (tail.length === 0) {
    // Distinguish "no runs at all" from "no runs match filters" so the
    // user knows whether to drop a flag or look elsewhere.
    const filterDesc = [];
    if (onlyFailed) filterDesc.push("--failed");
    if (sinceMs != null) filterDesc.push(`--since ${flags.since}`);
    if (filterDesc.length > 0) {
      stdout.write(`(no runs match ${filterDesc.join(" ")})\n`);
    } else if (hiddenSkipped > 0) {
      stdout.write(`(no runs yet besides ${hiddenSkipped} skipped; use --all to show them)\n`);
    } else if (id) {
      stdout.write(`(no runs for job '${id}')\n`);
    } else {
      stdout.write("(no runs yet)\n");
    }
    return 0;
  }

  // The branch column (worktree-isolated runs: `tick/<id>/<runId>`, the
  // diffstat in parentheses) only appears when a shown run has a branch.
  const showBranch = tail.some((r) => r.branch);
  const headers = ["jobId", "runId", "startedAt", "finishedAt", "duration", "exitCode", "tokens",
    ...(showBranch ? ["branch"] : []), "transcript", "error"];
  const rows = tail.map((r) => [
    r.jobId,
    r.runId || "",
    formatLocal(r.startedAt),
    formatLocal(r.finishedAt),
    `${durationSeconds(r.startedAt, r.finishedAt)}s`,
    String(r.exitCode),
    r.tokens ? `${r.tokens.input}/${r.tokens.output}` : "",
    ...(showBranch ? [r.branch ? `${r.branch}${r.diffstat ? ` (${r.diffstat.filesChanged}f +${r.diffstat.insertions} -${r.diffstat.deletions})` : ""}` : ""] : []),
    r.transcriptPath || "",
    r.error || (r.worktreeError ? `worktree: ${r.worktreeError}` : "") || (r.reason === "skipped" ? "skipped" : ""),
  ]);
  printTable([headers, ...rows], { stdout });
  if (hiddenSkipped > 0) stdout.write(`(${hiddenSkipped} skipped run(s) hidden; use --all to show them)\n`);
  return 0;
}
