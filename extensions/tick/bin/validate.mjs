// validate.mjs — job-field validation and schedule-kind constants, shared
// by every subcommand that touches a job id, prompt, cwd, or schedule.

import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fail } from "./errors.mjs";
import { WEEKDAY_TO_INT } from "./schedule-math.mjs";
import { getMinIntervalSeconds, activeBackend } from "./backend-info.mjs";

export const ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
export const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;
export const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY_SHORT = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
export const MAX_PROMPT_BYTES = 16 * 1024;
// MIN_INTERVAL_SECONDS comes from the active backend (5 on darwin/launchd,
// 60 on cron). See getMinIntervalSeconds() in backend-info.mjs.

export const KIND_INTERVAL = "interval";
export const KIND_DAILY = "daily";
export const KIND_WEEKLY = "weekly";
export const VALID_KINDS = [KIND_INTERVAL, KIND_DAILY, KIND_WEEKLY];

export function validateId(id) {
  if (!id || !ID_REGEX.test(id)) {
    fail(`invalid id '${id}': must match ${ID_REGEX}`, 2);
  }
}

export function validatePrompt(prompt) {
  if (typeof prompt !== "string" || prompt.length === 0) {
    fail(`prompt must be a non-empty string`, 2);
  }
  const bytes = Buffer.byteLength(prompt, "utf8");
  if (bytes > MAX_PROMPT_BYTES) {
    fail(`prompt is ${bytes} bytes; maximum is ${MAX_PROMPT_BYTES}`, 2);
  }
}

export function validateCwd(cwd) {
  if (typeof cwd !== "string" || !isAbsolute(cwd)) {
    fail(`cwd must be an absolute path (got '${cwd}')`, 2);
  }
  if (!existsSync(cwd)) {
    fail(`cwd does not exist: ${cwd}`, 2);
  }
}

export function validateKind(kind) {
  if (!VALID_KINDS.includes(kind)) {
    fail(`invalid --kind '${kind}': must be one of ${VALID_KINDS.join(", ")}`, 2);
  }
}

export function validateTime(time, flag = "--time") {
  if (typeof time !== "string" || !TIME_REGEX.test(time)) {
    fail(`invalid ${flag} '${time}': must match HH:MM in 24h format (${TIME_REGEX})`, 2);
  }
}

export function validateDays(days) {
  if (!Array.isArray(days) || days.length === 0) {
    fail(`--days must be a non-empty list (got '${String(days)}')`, 2);
  }
  for (const d of days) {
    const lower = String(d).toLowerCase();
    if (!(lower in WEEKDAY_TO_INT)) {
      fail(`invalid --day '${d}': must be one of ${WEEKDAYS.concat(WEEKDAY_SHORT).join(", ")}`, 2);
    }
  }
}

// Validate an interval schedule. Accepts an optional phase offset
// (offsetMinutes, offsetSeconds) that staggers the first fire by N
// minutes/seconds; cadence is unchanged. The offset is always returned
// on the value object so read sites can assume a uniform shape and old
// catalog entries (no offset key) are read defensively via `??`.
export function validateInterval(minutes, seconds, offsetMinutes, offsetSeconds) {
  if ((minutes == null || minutes === 0) && (seconds == null || seconds === 0)) {
    fail(`--kind interval requires --minutes and/or --seconds with at least one > 0`, 2);
  }
  const m = minutes == null ? 0 : Number(minutes);
  const s = seconds == null ? 0 : Number(seconds);
  if (!Number.isFinite(m) || m < 0 || !Number.isInteger(m)) {
    fail(`--minutes must be a non-negative integer (got '${String(minutes)}')`, 2);
  }
  if (!Number.isFinite(s) || s < 0 || !Number.isInteger(s)) {
    fail(`--seconds must be a non-negative integer (got '${String(seconds)}')`, 2);
  }
  const total = m * 60 + s;
  const minSeconds = getMinIntervalSeconds();
  if (total < minSeconds) {
    const note = minSeconds >= 60
      ? ` (the ${activeBackend().name} backend cannot express sub-minute intervals)`
      : "";
    fail(`interval too short: ${total}s; minimum is ${minSeconds}s${note}`, 2);
  }
  // Offset: same validation shape as minutes/seconds. No upper bound —
  // launchd/cron both handle arbitrary StartCalendarInterval seconds and
  // a giant offset is harmless beyond delaying the first fire. `0/0` is
  // always valid (the no-offset case). Bare `--offset-minutes` (a flag
  // with no value) yields `true` from parseFlags, so reject it before
  // Number(true) quietly becomes 1.
  if (offsetMinutes === true) fail(`--offset-minutes requires a value`, 2);
  if (offsetSeconds === true) fail(`--offset-seconds requires a value`, 2);
  const om = offsetMinutes == null ? 0 : Number(offsetMinutes);
  const os = offsetSeconds == null ? 0 : Number(offsetSeconds);
  if (!Number.isFinite(om) || om < 0 || !Number.isInteger(om)) {
    fail(`--offset-minutes must be a non-negative integer (got '${String(offsetMinutes)}')`, 2);
  }
  if (!Number.isFinite(os) || os < 0 || !Number.isInteger(os)) {
    fail(`--offset-seconds must be a non-negative integer (got '${String(offsetSeconds)}')`, 2);
  }
  return { minutes: m, seconds: s, offset: { minutes: om, seconds: os } };
}

export function buildSchedule(kind, opts) {
  validateKind(kind);
  if (kind === KIND_INTERVAL) {
    return {
      kind,
      value: validateInterval(
        opts.minutes,
        opts.seconds,
        opts["offset-minutes"],
        opts["offset-seconds"],
      ),
    };
  }
  if (kind === KIND_DAILY) {
    validateTime(opts.time);
    return { kind, value: { time: opts.time } };
  }
  if (kind === KIND_WEEKLY) {
    const days = String(opts.days ?? "")
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);
    validateDays(days);
    validateTime(opts.time);
    return { kind, value: { days, time: opts.time } };
  }
  fail(`unreachable: kind '${kind}'`, 2);
}
