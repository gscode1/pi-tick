// backends/launchd.mjs — macOS launchd backend.
//
// One launchd plist per job, written to ~/Library/LaunchAgents/ and
// loaded with `launchctl bootstrap gui/<uid>`. Standard ScheduleSpec
// fields (interval / daily / weekly) map directly to plist keys
// (StartInterval / StartCalendarInterval).

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
  renameSync,
  chmodSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";

import { logsDir as defaultLogsDir } from "../paths.mjs";
import { resolveScheduleFields, intervalCalendarForm, CALENDAR_INTERVAL_HINT } from "../schedule.mjs";

const LABEL_PREFIX = "dev.pi.tick.";

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function plistDir() {
  return process.env.PI_TICK_PLIST_DIR || join(homedir(), "Library", "LaunchAgents");
}

export function plistPath(jobId) {
  return join(plistDir(), `${LABEL_PREFIX}${jobId}.plist`);
}

export function disabledPlistPath(jobId) {
  return join(plistDir(), `${LABEL_PREFIX}${jobId}.plist.disabled`);
}

function userUid() {
  return process.getuid ? process.getuid() : 0;
}

// Returns an error string when launchd cannot render this interval faithfully.
// Without an offset StartInterval is used as-is. With an offset the schedule
// must have a calendar form (see intervalCalendarForm).
function intervalError(fields) {
  if (fields.offsetSeconds === 0) return null;
  const form = intervalCalendarForm(fields.totalSeconds, fields.offsetSeconds);
  if (form.error) {
    return `launchd cannot render this interval offset: ${form.error} (offsets must be whole minutes smaller than the interval; ${CALENDAR_INTERVAL_HINT})`;
  }
  return null;
}

export function renderPlist(job, opts) {
  const label = `${LABEL_PREFIX}${job.id}`;
  const nodePath = opts.nodePath;
  const cliPath = opts.cliPath;
  // Accept either a string path or a function returning one; fall back to
  // the default data dir's logs/ if neither is given (used by tests).
  const logsPath = typeof opts.logsDir === "function" ? opts.logsDir()
    : (opts.logsDir || defaultLogsDir());
  const outLog = join(logsPath, `${job.id}.out.log`);
  const errLog = join(logsPath, `${job.id}.err.log`);
  // launchd starts jobs with a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin),
  // so `forge`→tea/gh and other tools in Homebrew/~/.local/bin are not found.
  // Bake a deterministic PATH (computed by the caller at enable time) into the
  // plist's EnvironmentVariables so the scheduled job sees the same tools as an
  // interactive shell.
  const envVars = { ...(opts.envVars || {}) };
  if (opts.envPath) envVars.PATH = opts.envPath;
  const envEntries = Object.entries(envVars)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(v)}</string>`)
    .join("\n");
  const envBlock = envEntries
    ? `  <key>EnvironmentVariables</key>\n  <dict>\n${envEntries}\n  </dict>\n`
    : "";
  // Schedule interpretation (hour/minute/weekdays/offset) is shared with the
  // cron backend via resolveScheduleFields — only the XML rendering below is
  // launchd-specific (issue: the two backends used to each re-derive these
  // fields independently and could silently drift).
  const fields = resolveScheduleFields(job.schedule);

  let scheduleKeys = "";
  if (job.schedule.kind === "interval") {
    const err = intervalError(fields);
    if (err) throw new Error(err);
    if (fields.offsetSeconds === 0) {
      scheduleKeys = `  <key>StartInterval</key>\n  <integer>${fields.totalSeconds}</integer>\n`;
    } else {
      // StartInterval has no phase, and launchd honours StartInterval and
      // StartCalendarInterval independently, so an offset job is rendered as
      // StartCalendarInterval ONLY (never both keys).
      const form = intervalCalendarForm(fields.totalSeconds, fields.offsetSeconds);
      const dicts = [];
      for (const h of form.hours ?? [null]) {
        for (const m of form.minutes) {
          const hourKey = h === null ? "" : `    <key>Hour</key>\n    <integer>${h}</integer>\n`;
          dicts.push(`  <dict>\n${hourKey}    <key>Minute</key>\n    <integer>${m}</integer>\n  </dict>`);
        }
      }
      scheduleKeys = `  <key>StartCalendarInterval</key>\n  <array>\n${dicts.join("\n")}\n  </array>\n`;
    }
  } else if (job.schedule.kind === "daily") {
    scheduleKeys = `  <key>StartCalendarInterval</key>\n  <dict>\n    <key>Hour</key>\n    <integer>${fields.hour}</integer>\n    <key>Minute</key>\n    <integer>${fields.minute}</integer>\n  </dict>\n`;
  } else if (job.schedule.kind === "weekly") {
    const entries = fields.weekdays
      .map((wd) => `  <dict>\n    <key>Weekday</key>\n    <integer>${wd}</integer>\n    <key>Hour</key>\n    <integer>${fields.hour}</integer>\n    <key>Minute</key>\n    <integer>${fields.minute}</integer>\n  </dict>`)
      .join("\n");
    scheduleKeys = `  <key>StartCalendarInterval</key>\n  <array>\n${entries}\n  </array>\n`;
  } else if (job.schedule.kind === "once") {
    scheduleKeys = `  <key>StartCalendarInterval</key>\n  <dict>\n    <key>Month</key>\n    <integer>${fields.month}</integer>\n    <key>Day</key>\n    <integer>${fields.day}</integer>\n    <key>Hour</key>\n    <integer>${fields.hour}</integer>\n    <key>Minute</key>\n    <integer>${fields.minute}</integer>\n  </dict>\n`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodePath)}</string>
    <string>${xmlEscape(cliPath)}</string>
    <string>run</string>
    <string>${xmlEscape(job.id)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(job.cwd)}</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(outLog)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(errLog)}</string>
${envBlock}${scheduleKeys}</dict>
</plist>
`;
}

export function fingerprint(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function xmlUnescape(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

// Paths baked into a rendered plist: node, CLI, and WorkingDirectory.
export function parsePlistPaths(plist) {
  const args = plist.match(/<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>\s*<string>([^<]*)<\/string>/);
  const cwd = plist.match(/<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/);
  return {
    nodePath: args ? xmlUnescape(args[1]) : null,
    cliPath: args ? xmlUnescape(args[2]) : null,
    cwd: cwd ? xmlUnescape(cwd[1]) : null,
  };
}

function runLaunchctl(args) {
  // Test override: PI_TICK_LAUNCHCTL points to a stub binary.
  const bin = process.env.PI_TICK_LAUNCHCTL || "launchctl";
  return spawnSync(bin, args, { encoding: "utf8" });
}

// When the launchctl binary itself fails to spawn (missing PATH, sandboxed,
// EACCES), spawnSync returns { status: null, error: <Error> } with empty
// stderr/stdout. Surface res.error.message in that case instead of falling
// through to a generic "unknown error" — see issue #53.
function launchctlErrorMessage(res) {
  if (res.error) return res.error.message;
  return (res.stderr || "") + (res.stdout || "") || "unknown error";
}

function bootout(jobId) {
  // Ignore errors (might not be loaded) — but if launchctl itself failed to
  // spawn, that's worth knowing about even though the caller doesn't check.
  const res = runLaunchctl(["bootout", `gui/${userUid()}/${LABEL_PREFIX}${jobId}`]);
  if (res.error) {
    return { ok: false, error: launchctlErrorMessage(res) };
  }
  return { ok: true };
}

function bootstrap(jobId) {
  const res = runLaunchctl(["bootstrap", `gui/${userUid()}`, plistPath(jobId)]);
  if (res.status !== 0) {
    return { ok: false, stderr: launchctlErrorMessage(res), status: res.status };
  }
  return { ok: true };
}

// The port both backends implement (issue #62): name, minimumIntervalSeconds,
// and label are plain data; register/unregister/unregisterAndDelete/
// listRegistered are uniformly async even though launchd's own work here is
// synchronous — cron's crontab calls are real I/O, and the core always
// `await`s the result, so the contract should say so rather than hide a
// sync/async split behind the await. renderPlist/plistPath/disabledPlistPath
// are launchd-only and live as standalone exports above, for this module's
// own tests — not on the shared port.
export const launchdBackend = {
  name: "launchd",
  minimumIntervalSeconds: 5,
  scheduleError: (schedule) => {
    if (schedule.kind !== "interval") return null;
    return intervalError(resolveScheduleFields(schedule));
  },
  label: (jobId) => `${LABEL_PREFIX}${jobId}`,
  listRegistered: async () => {
    // Read every plist in the LaunchAgents dir and return jobIds we own.
    if (!existsSync(plistDir())) return [];
    const out = [];
    for (const f of readdirSync(plistDir())) {
      if (f.startsWith(LABEL_PREFIX) && f.endsWith(".plist")) {
        out.push(f.slice(LABEL_PREFIX.length, -".plist".length));
      }
    }
    return out;
  },
  register: async (job, opts) => {
    const problem = launchdBackend.scheduleError(job.schedule);
    if (problem) return { ok: false, error: problem };
    const plist = renderPlist(job, {
      nodePath: opts.nodePath,
      cliPath: opts.cliPath,
      logsDir: opts.logsDir,
      envPath: opts.envPath,
      envVars: opts.envVars,
    });
    mkdirSync(plistDir(), { recursive: true });
    const pp = plistPath(job.id);
    // Remember the plist we are replacing so a failed bootstrap can put it
    // back instead of leaving an enabled job with no plist and no service.
    let previous = null;
    try { previous = readFileSync(pp, "utf8"); } catch { /* none yet */ }
    writeFileSync(pp, plist, { encoding: "utf8" });
    const registeredFingerprint = fingerprint(plist);
    chmodSync(pp, 0o644);

    // Idempotent re-registration: always bootout first, ignore errors.
    bootout(job.id);
    const boot = bootstrap(job.id);
    if (!boot.ok) {
      if (previous === null) {
        try { unlinkSync(pp); } catch { /* already gone */ }
      } else {
        // Best effort: restore the old plist and load it again.
        try {
          writeFileSync(pp, previous, { encoding: "utf8" });
          chmodSync(pp, 0o644);
          bootstrap(job.id);
        } catch { /* nothing more we can do */ }
      }
      return { ok: false, error: `launchctl bootstrap failed: ${boot.stderr.trim() || "unknown error"}` };
    }
    return { ok: true, referencePath: plistPath(job.id), fingerprint: registeredFingerprint };
  },
  // Read-only, and synchronous (unlike the rest of the port) so `list` can
  // stay synchronous. `loaded` is null when launchctl itself can't be run.
  status: (jobId) => {
    let plist;
    try {
      plist = readFileSync(plistPath(jobId), "utf8");
    } catch {
      return { registered: false, loaded: null, fingerprint: null, paths: null };
    }
    const res = runLaunchctl(["print", `gui/${userUid()}/${LABEL_PREFIX}${jobId}`]);
    const loaded = res.error ? null : res.status === 0;
    return { registered: true, loaded, fingerprint: fingerprint(plist), paths: parsePlistPaths(plist) };
  },
  unregister: async (jobId) => {
    // Rename to .disabled for inspection. Do this before bootout: when a
    // one-shot job unregisters itself from inside its own launchd-spawned
    // process, bootout terminates that process, so nothing after it runs.
    const pp = plistPath(jobId);
    const dpp = disabledPlistPath(jobId);
    if (existsSync(pp)) {
      try { renameSync(pp, dpp); } catch { /* already gone */ }
    }
    bootout(jobId);
    return { ok: true, referencePath: dpp };
  },
  unregisterAndDelete: async (jobId) => {
    bootout(jobId);
    try { unlinkSync(plistPath(jobId)); } catch { /* already gone */ }
    // cmdDisable renames the active plist to .disabled, so a deleted-but-
    // previously-disabled job leaves the .disabled file behind unless we
    // clean it up here. launchd never reads it; it's just clutter.
    try { unlinkSync(disabledPlistPath(jobId)); } catch { /* already gone */ }
    return { ok: true };
  },
};
