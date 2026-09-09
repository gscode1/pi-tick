// schedule.mjs — Schedule construction, validation, normalization, and next-fire math.

import { fail } from "./errors.mjs";
import { getMinIntervalSeconds, activeBackend } from "./backend-info.mjs";

export const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;
export const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY_SHORT = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export const WEEKDAY_TO_INT = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

export const KIND_INTERVAL = "interval";
export const KIND_DAILY = "daily";
export const KIND_WEEKLY = "weekly";
export const KIND_ONCE = "once";
export const VALID_KINDS = [KIND_INTERVAL, KIND_DAILY, KIND_WEEKLY, KIND_ONCE];

// One-shot timestamps intentionally use minute precision. Both supported
// backends render calendar fields and cannot provide portable sub-minute
// scheduling semantics.
export const ONCE_ISO_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(?:Z|[+-]\d{2}:\d{2})$/;

export function validateOnceAt(at, { now = new Date() } = {}) {
  const match = typeof at === "string" && at.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):00(Z|([+-])(\d{2}):(\d{2}))$/);
  if (!match) {
    fail(`invalid --at '${String(at)}': must be an absolute ISO-8601 timestamp with minute precision (seconds must be 00)`, 2);
  }
  const [, ys, mos, ds, hs, mis, zone, sign, ohs, oms] = match;
  const year = Number(ys);
  const month = Number(mos);
  const day = Number(ds);
  const hour = Number(hs);
  const minute = Number(mis);
  const offsetMinutes = zone === "Z" ? 0 : Number(ohs) * 60 + Number(oms);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()
      || hour > 23 || minute > 59 || (zone !== "Z" && (Number(ohs) > 23 || Number(oms) > 59))) {
    fail(`invalid --at '${at}': must be a valid ISO-8601 timestamp`, 2);
  }
  const parsed = new Date(Date.UTC(year, month - 1, day, hour, minute) - (sign === "-" ? -offsetMinutes : offsetMinutes) * 60_000);
  if (!Number.isFinite(parsed.getTime())) {
    fail(`invalid --at '${at}': must be a valid ISO-8601 timestamp`, 2);
  }
  if (parsed.getTime() <= now.getTime()) {
    fail(`invalid --at '${at}': timestamp must be in the future`, 2);
  }
  return parsed.toISOString();
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
  if (kind === KIND_ONCE) {
    return { kind, value: { at: validateOnceAt(opts.at) } };
  }
  fail(`unreachable: kind '${kind}'`, 2);
}

// Normalize a job's `schedule` into the fields both backend adapters render
// from, so the interval/daily/weekly branching and the defensive
// `offset ?? {minutes:0,seconds:0}` read (pre-issue-23 catalog entries have
// no `offset` key) happen in exactly one place instead of twice. Each
// adapter still owns its own output format (plist XML vs. crontab syntax)
// and its own validation contract — this only shares the interpretation.
export function resolveScheduleFields(schedule) {
  const s = schedule;
  if (s.kind === KIND_INTERVAL) {
    const totalSeconds = s.value.minutes * 60 + s.value.seconds;
    const off = s.value.offset ?? { minutes: 0, seconds: 0 };
    const offsetSeconds = off.minutes * 60 + off.seconds;
    return { kind: s.kind, hour: null, minute: null, totalSeconds, offsetSeconds, weekdays: null };
  }
  if (s.kind === KIND_DAILY) {
    const [hour, minute] = String(s.value.time).split(":").map(Number);
    return { kind: s.kind, hour, minute, totalSeconds: null, offsetSeconds: 0, weekdays: null };
  }
  if (s.kind === KIND_WEEKLY) {
    const [hour, minute] = String(s.value.time).split(":").map(Number);
    const weekdays = s.value.days.map((d) => WEEKDAY_TO_INT[d]).sort((a, b) => a - b);
    return { kind: s.kind, hour, minute, totalSeconds: null, offsetSeconds: 0, weekdays };
  }
  if (s.kind === KIND_ONCE) {
    const at = new Date(s.value.at);
    return {
      kind: s.kind,
      year: at.getFullYear(),
      month: at.getMonth() + 1,
      day: at.getDate(),
      hour: at.getHours(),
      minute: at.getMinutes(),
      totalSeconds: null,
      offsetSeconds: 0,
      weekdays: null,
    };
  }
  return { kind: s.kind, hour: null, minute: null, totalSeconds: null, offsetSeconds: 0, weekdays: null };
}

function nextDailyAt(now, hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const next = new Date(now);
  next.setHours(h, m, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next.toISOString();
}

function nextWeeklyAt(now, days, hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const nowDow = now.getDay();
  let best = null;
  for (const d of days) {
    const target = WEEKDAY_TO_INT[d];
    let diff = (target - nowDow + 7) % 7;
    const cand = new Date(now);
    cand.setHours(h, m, 0, 0);
    cand.setDate(cand.getDate() + diff);
    if (cand.getTime() <= now.getTime()) {
      cand.setDate(cand.getDate() + 7);
    }
    if (best === null || cand.getTime() < best.getTime()) best = cand;
  }
  return best ? best.toISOString() : "--";
}

// Dispatch next-fire ISO timestamp calculation based on schedule kind.
export function nextFireAt(schedule, now = new Date()) {
  const s = schedule;
  if (s.kind === KIND_INTERVAL) {
    const total = s.value.minutes * 60 + s.value.seconds;
    const _off = s.value.offset ?? { minutes: 0, seconds: 0 };
    void _off;
    const next = new Date(now.getTime() + total * 1000);
    return next.toISOString();
  }
  if (s.kind === KIND_DAILY) {
    return nextDailyAt(now, s.value.time);
  }
  if (s.kind === KIND_WEEKLY) {
    return nextWeeklyAt(now, s.value.days, s.value.time);
  }
  if (s.kind === KIND_ONCE) {
    return new Date(s.value.at).toISOString();
  }
  return "--";
}
