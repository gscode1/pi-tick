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
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { logsDir as defaultLogsDir } from "../paths.mjs";
import { resolveScheduleFields } from "../schedule-math.mjs";

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
    scheduleKeys = `  <key>StartInterval</key>\n  <integer>${fields.totalSeconds}</integer>\n`;
    // Phase offset: a single StartCalendarInterval fires once at
    // `Date.now() + offset` so two interval jobs of the same cadence
    // don't race. Target = now + offset in wall-clock time; emit its
    // Minute/Second directly (they're already bounded 0..59). Drift
    // is bounded by the sub-second granularity of Date.now() — for
    // any offset ≥ 5s the effective drift is < 1s. The phase is set
    // at this render call, so re-running `pi-tick enable` shifts it.
    if (fields.offsetSeconds > 0) {
      const target = new Date(Date.now() + fields.offsetSeconds * 1000);
      scheduleKeys += `  <key>StartCalendarInterval</key>\n  <dict>\n    <key>Minute</key>\n    <integer>${target.getMinutes()}</integer>\n    <key>Second</key>\n    <integer>${target.getSeconds()}</integer>\n  </dict>\n`;
    }
  } else if (job.schedule.kind === "daily") {
    scheduleKeys = `  <key>StartCalendarInterval</key>\n  <dict>\n    <key>Hour</key>\n    <integer>${fields.hour}</integer>\n    <key>Minute</key>\n    <integer>${fields.minute}</integer>\n  </dict>\n`;
  } else if (job.schedule.kind === "weekly") {
    const entries = fields.weekdays
      .map((wd) => `  <dict>\n    <key>Weekday</key>\n    <integer>${wd}</integer>\n    <key>Hour</key>\n    <integer>${fields.hour}</integer>\n    <key>Minute</key>\n    <integer>${fields.minute}</integer>\n  </dict>`)
      .join("\n");
    scheduleKeys = `  <key>StartCalendarInterval</key>\n  <array>\n${entries}\n  </array>\n`;
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
  const res = runLaunchctl(["bootout", `gui/${userUid()}/${LABEL_PREFIX}${jobId}`, plistPath(jobId)]);
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
    const plist = renderPlist(job, {
      nodePath: opts.nodePath,
      cliPath: opts.cliPath,
      logsDir: opts.logsDir,
      envPath: opts.envPath,
    });
    mkdirSync(plistDir(), { recursive: true });
    writeFileSync(plistPath(job.id), plist, { encoding: "utf8" });
    chmodSync(plistPath(job.id), 0o644);

    // Idempotent re-registration: always bootout first, ignore errors.
    bootout(job.id);
    const boot = bootstrap(job.id);
    if (!boot.ok) {
      try { unlinkSync(plistPath(job.id)); } catch { /* already gone */ }
      return { ok: false, error: `launchctl bootstrap failed: ${boot.stderr.trim() || "unknown error"}` };
    }
    return { ok: true, referencePath: plistPath(job.id) };
  },
  unregister: async (jobId) => {
    bootout(jobId);
    // Rename to .disabled for inspection.
    const pp = plistPath(jobId);
    const dpp = disabledPlistPath(jobId);
    if (existsSync(pp)) {
      try { renameSync(pp, dpp); } catch { /* already gone */ }
    }
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
