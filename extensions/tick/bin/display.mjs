// display.mjs — table/schedule display formatting shared by the list, log,
// and transcripts subcommands. Display-only; owns no catalog or schedule
// validation logic.

import { KIND_INTERVAL, KIND_DAILY, KIND_WEEKLY } from "./validate.mjs";
import { nextDailyAt, nextWeeklyAt } from "./schedule-math.mjs";

export function humanizeSeconds(total) {
  // ponytail: <60s stays in seconds; minute- and hour-scale only. No days,
  // add when a job needs >24h cadence.
  if (total < 60) return `${total}s`;
  if (total < 3600) {
    const m = Math.floor(total / 60);
    const s = total % 60;
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export function formatSchedule(s) {
  if (s.kind === KIND_INTERVAL) {
    const total = s.value.minutes * 60 + s.value.seconds;
    // Defensive read: old catalog entries (pre-issue-23) have no `offset` key.
    const off = s.value.offset ?? { minutes: 0, seconds: 0 };
    const offsetSec = off.minutes * 60 + off.seconds;
    const body = `every ${humanizeSeconds(total)}`;
    return offsetSec > 0 ? `${body} +${humanizeSeconds(offsetSec)} offset` : body;
  }
  if (s.kind === KIND_DAILY) return `daily @ ${s.value.time}`;
  if (s.kind === KIND_WEEKLY) return `weekly ${s.value.days.join(",")} @ ${s.value.time}`;
  return "?";
}

export function formatNextFire(s) {
  const now = new Date();
  if (s.kind === KIND_INTERVAL) {
    const total = s.value.minutes * 60 + s.value.seconds;
    // Defensive read; the offset is intentionally NOT applied to the
    // display column — `formatNextFire` is a best-effort hint, the plist
    // (the source of truth) is what launchd actually reads at bootstrap.
    // Re-enabling a job rewrites the plist and shifts the phase; the
    // display would silently disagree if we tried to model it here.
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
  return "--";
}

export function printTable(rows, { stdout }) {
  const widths = [];
  for (const r of rows) {
    for (let i = 0; i < r.length; i++) {
      widths[i] = Math.max(widths[i] || 0, String(r[i]).length);
    }
  }
  for (const r of rows) {
    stdout.write(r.map((cell, i) => String(cell).padEnd(widths[i])).join("  ") + "\n");
  }
}
