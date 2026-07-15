// schedule-math.mjs — weekday numbering, next-fire date math, and the
// schedule-interpretation step shared by both scheduler backends.
//
// Split out of catalog.mjs, which had accreted this alongside catalog CRUD
// and the lock — nothing here reads or writes the catalog.

export const WEEKDAY_TO_INT = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

export function nextDailyAt(now, hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const next = new Date(now);
  next.setHours(h, m, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next.toISOString();
}

export function nextWeeklyAt(now, days, hhmm) {
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

// Normalize a job's `schedule` into the fields both backend adapters render
// from, so the interval/daily/weekly branching and the defensive
// `offset ?? {minutes:0,seconds:0}` read (pre-issue-23 catalog entries have
// no `offset` key) happen in exactly one place instead of twice. Each
// adapter still owns its own output format (plist XML vs. crontab syntax)
// and its own validation contract — this only shares the interpretation.
export function resolveScheduleFields(schedule) {
  const s = schedule;
  if (s.kind === "interval") {
    const totalSeconds = s.value.minutes * 60 + s.value.seconds;
    const off = s.value.offset ?? { minutes: 0, seconds: 0 };
    const offsetSeconds = off.minutes * 60 + off.seconds;
    return { kind: s.kind, hour: null, minute: null, totalSeconds, offsetSeconds, weekdays: null };
  }
  if (s.kind === "daily") {
    const [hour, minute] = String(s.value.time).split(":").map(Number);
    return { kind: s.kind, hour, minute, totalSeconds: null, offsetSeconds: 0, weekdays: null };
  }
  if (s.kind === "weekly") {
    const [hour, minute] = String(s.value.time).split(":").map(Number);
    const weekdays = s.value.days.map((d) => WEEKDAY_TO_INT[d]).sort((a, b) => a - b);
    return { kind: s.kind, hour, minute, totalSeconds: null, offsetSeconds: 0, weekdays };
  }
  return { kind: s.kind, hour: null, minute: null, totalSeconds: null, offsetSeconds: 0, weekdays: null };
}
