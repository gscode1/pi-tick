// backends/cron.mjs — Linux user-crontab backend.
//
// One crontab entry per job, written atomically by piping to
// `crontab -`. Each pi-tick entry is preceded by a comment marker
// `# pi-tick: <id>` so we can find and remove our entries without
// clobbering the user's other crontab entries.
//
// Crontab format reminder:
//   # ┌── min (0-59)
//   # │  ┌── hour (0-23)
//   # │  │  ┌── day of month (1-31)
//   # │  │  │  ┌── month (1-12)
//   # │  │  │  │  ┌── day of week (0-6, Sun=0)
//   # │  │  │  │  │
//   *  *  *  *  *  command
//
// Cron's smallest unit is 1 minute; sub-minute intervals are rejected
// (see issue 22). Non-multiple-of-60 seconds are also rejected for
// the same reason.

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { logsDir as defaultLogsDir } from "../paths.mjs";
import { resolveScheduleFields } from "../schedule.mjs";

// Cron weekday numbering is identical to launchd: Sun=0..Sat=6. Schedule
// interpretation (hour/minute/weekdays/offset) is shared with the launchd
// backend via resolveScheduleFields, in ../schedule.mjs.

const COMMENT_PREFIX = "# pi-tick: ";
const MIN_INTERVAL_SECONDS = 60; // cron has 1-minute granularity

function labelFor(jobId) {
  return `pi-tick:${jobId}`;
}

// Build a single cron line for a job. Returns { line, warning? }.
export function buildCronLine(job, opts) {
  const s = job.schedule;
  // Accept either a string path or a function returning one; fall back to
  // the default data dir's logs/ if neither is given.
  const logsPath = typeof opts.logsDir === "function" ? opts.logsDir()
    : (opts.logsDir || defaultLogsDir());
  let schedule;
  if (s.kind === "interval") {
    const fields = resolveScheduleFields(s);
    // The cron backend cannot express a phase offset (cron has no
    // first-fire / phase primitive), so reject explicitly when one is
    // set. 0 is always valid — it's the no-offset case and any
    // pre-issue-23 catalog entry (no `offset` key) reads as 0 here.
    if (fields.offsetSeconds > 0) {
      return { error: `interval offset not supported on the cron backend; use --kind daily at HH:MM or omit --offset-*` };
    }
    if (fields.totalSeconds < MIN_INTERVAL_SECONDS) {
      return { error: `interval ${fields.totalSeconds}s is below the cron minimum of ${MIN_INTERVAL_SECONDS}s` };
    }
    if (fields.totalSeconds % 60 !== 0) {
      return { error: `interval ${fields.totalSeconds}s is not a whole number of minutes; cron cannot express sub-minute cadences` };
    }
    const minutes = Math.floor(fields.totalSeconds / 60);
    if (minutes === 1) {
      schedule = "* * * * *";           // every minute
    } else {
      schedule = `*/${minutes} * * * *`; // every N minutes
    }
  } else if (s.kind === "daily") {
    if (typeof s.value.time !== "string" || !/^\d{2}:\d{2}$/.test(s.value.time)) {
      return { error: `daily schedule requires time in HH:MM format (got ${JSON.stringify(s.value.time)})` };
    }
    const fields = resolveScheduleFields(s);
    schedule = `${fields.minute} ${fields.hour} * * *`;
  } else if (s.kind === "weekly") {
    if (typeof s.value.time !== "string" || !/^\d{2}:\d{2}$/.test(s.value.time)) {
      return { error: `weekly schedule requires time in HH:MM format (got ${JSON.stringify(s.value.time)})` };
    }
    const fields = resolveScheduleFields(s);
    schedule = `${fields.minute} ${fields.hour} * * ${fields.weekdays.join(",")}`;
  } else {
    return { error: `unknown schedule kind: ${s.kind}` };
  }

  const outLog = join(logsPath, `${job.id}.out.log`);
  const errLog = join(logsPath, `${job.id}.err.log`);
  // Crontab runs in a minimal env; use absolute paths and quote them.
  // We intentionally invoke pi-tick.mjs via the node binary: cron
  // has no shebang-resolution guarantee.
  // StandardOutPath equivalent: append stdout+stderr to per-job log.
  const cmd = `${quote(opts.nodePath)} ${quote(opts.cliPath)} run ${quote(job.id)} >> ${quote(outLog)} 2>> ${quote(errLog)}`;
  const line = `${schedule} ${cmd}`;
  return { line };
}

function quote(s) {
  // Wrap in single quotes; escape any single quote inside. Also escape
  // `%` because cron interprets a bare `%` in a crontab line as a
  // newline + stdin delimiter (so `/opt/%node` would silently truncate
  // the command). `\%` is a literal `%` to cron. The two replaces act
  // on disjoint character sets and commute; order is for clarity only.
  return `'${String(s).replace(/%/g, '\\%').replace(/'/g, `'\\''`)}'`;
}

function readCrontab() {
  const bin = process.env.PI_TICK_CRONTAB || "crontab";
  const res = spawnSync(bin, ["-l"], { encoding: "utf8" });
  if (res.status === 0) return res.stdout || "";
  // crontab -l exits non-zero when the user has no crontab (e.g. never
  // installed one). That's "empty", not an error.
  if (res.status === 1 && /no crontab/i.test((res.stderr || "") + (res.stdout || ""))) {
    return "";
  }
  return null; // real error
}

function writeCrontab(content) {
  const bin = process.env.PI_TICK_CRONTAB || "crontab";
  return new Promise((resolve) => {
    const child = spawn(bin, ["-"], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (c) => { stderr += c.toString("utf8"); });
    child.on("error", (err) => resolve({ ok: false, error: err.message }));
    child.on("close", (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: `crontab exited ${code}: ${stderr.trim()}` });
    });
    child.stdin.end(content);
  });
}

// ponytail: `ours` is preserved for API parity; current callers ignore it.
// Walk lines instead of splitting on blank lines so a crontab without
// blank separators between entries still gets parsed correctly.
function extractEntries(crontabText, jobId) {
  // Returns { ours, theirs }.
  //   ours:   the removed marker+command line-pair for `jobId`, joined with "\n"
  //           (or null if `jobId` was not present). Kept for API parity.
  //   theirs: every surviving line in original order, trailing "" popped.
  const lines = crontabText.split("\n");
  const ours = [];
  const theirs = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === `${COMMENT_PREFIX}${jobId}`) {
      ours.push(lines[i]);
      i++; // consume the marker
      if (i < lines.length && lines[i].length > 0) {
        ours.push(lines[i]);
      }
      continue;
    }
    theirs.push(lines[i]);
  }
  if (theirs.length > 0 && theirs[theirs.length - 1] === "") theirs.pop();
  return { ours: ours.length ? ours.join("\n") : null, theirs };
}

// The port both backends implement (issue #62): name, minimumIntervalSeconds,
// and label are plain data; register/unregister/unregisterAndDelete/
// listRegistered are uniformly async. buildCronLine is cron-only and lives
// as a standalone export above, for this module's own tests — not on the
// shared port.
export const cronBackend = {
  name: "cron",
  minimumIntervalSeconds: MIN_INTERVAL_SECONDS,
  label: labelFor,
  listRegistered: async () => {
    const text = readCrontab();
    if (text === null) return [];
    const ids = new Set();
    for (const line of text.split("\n")) {
      const m = line.match(/^#\s*pi-tick:\s*([A-Za-z0-9][A-Za-z0-9_.-]{0,63})\s*$/);
      if (m) ids.add(m[1]);
    }
    return [...ids];
  },
  register: async (job, opts) => {
    const built = buildCronLine(job, opts);
    if (built.error) return { ok: false, error: built.error };
    const current = readCrontab();
    if (current === null) {
      return { ok: false, error: "failed to read crontab (is `crontab` installed and on PATH?)" };
    }
    const { ours, theirs } = extractEntries(current, job.id);
    const newBlock = `${COMMENT_PREFIX}${job.id}\n${built.line}`;
    // theirs has no trailing newline; append "\n" only when there's at
    // least one surviving line so we don't write a stray blank line.
    const updated = theirs.join("\n") + (theirs.length ? "\n" : "") + newBlock + "\n";
    // Same fallback as buildCronLine: opts.logsDir may be a function, a
    // string, or absent entirely (issue #57 — `register({})` used to throw
    // because mkdirSync(undefined, ...) is a TypeError).
    const logsPath = typeof opts.logsDir === "function" ? opts.logsDir() : (opts.logsDir || defaultLogsDir());
    mkdirSync(logsPath, { recursive: true, mode: 0o700 });
    const w = await writeCrontab(updated);
    if (!w.ok) return { ok: false, error: w.error };
    return { ok: true, referencePath: `crontab (entry: ${built.line.slice(0, 60)}...)` };
  },
  unregister: async (jobId) => {
    const current = readCrontab();
    if (current === null) return { ok: false, error: "failed to read crontab" };
    const { theirs } = extractEntries(current, jobId);
    if (theirs.length === 0 && current.trim().length === 0) {
      return { ok: true, referencePath: "crontab (no entry to remove)" };
    }
    // theirs already has the trailing empty line popped; join with "\n".
    // If everything else is empty, write a single trailing newline so
    // crontab doesn't choke on a totally empty file.
    const finalContent = theirs.length === 0 ? "\n" : theirs.join("\n") + "\n";
    const w = await writeCrontab(finalContent);
    if (!w.ok) return { ok: false, error: w.error };
    return { ok: true, referencePath: "crontab (entry removed)" };
  },
  unregisterAndDelete: async (jobId) => {
    // Same as unregister: removal from crontab IS the delete.
    return cronBackend.unregister(jobId);
  },
};
