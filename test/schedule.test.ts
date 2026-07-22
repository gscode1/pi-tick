// test/schedule.test.ts — Schedule construction, validation, normalization, and next-fire math tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFlags } from "../extensions/tick/bin/argv.mjs";
import {
  validateKind,
  validateTime,
  validateDays,
  validateInterval,
  buildSchedule,
  resolveScheduleFields,
  nextFireAt,
  WEEKDAY_TO_INT,
} from "../extensions/tick/bin/schedule.mjs";

test("validateTime accepts HH:MM and rejects bad values", () => {
  validateTime("00:00");
  validateTime("23:59");
  assert.throws(() => validateTime("24:00"), /HH:MM/);
  assert.throws(() => validateTime("9:00"), /HH:MM/);
  assert.throws(() => validateTime("9:00am"), /HH:MM/);
});

test("validateKind accepts valid kinds and rejects invalid kind", () => {
  validateKind("interval");
  validateKind("daily");
  validateKind("weekly");
  assert.throws(() => validateKind("monthly"), /invalid --kind/);
});

test("validateDays accepts valid day names and rejects invalid days", () => {
  validateDays(["monday", "tue", "FRIDAY"]);
  assert.throws(() => validateDays([]), /non-empty/);
  assert.throws(() => validateDays(["fooday"]), /invalid --day/);
});

test("validateInterval enforces minimum 5 seconds", () => {
  assert.throws(() => validateInterval(0, 0), /requires/);
  assert.throws(() => validateInterval(0, 4), /too short/);
  const v = validateInterval(0, 5);
  assert.deepEqual(v, { minutes: 0, seconds: 5, offset: { minutes: 0, seconds: 0 } });
  const v2 = validateInterval(10, 30);
  assert.deepEqual(v2, { minutes: 10, seconds: 30, offset: { minutes: 0, seconds: 0 } });
});

test("validateInterval accepts offset fields and returns them on the value", () => {
  const v = validateInterval(2, 0, 15, 30);
  assert.deepEqual(v, { minutes: 2, seconds: 0, offset: { minutes: 15, seconds: 30 } });
  const v0 = validateInterval(2, 0, 0, 0);
  assert.deepEqual(v0, { minutes: 2, seconds: 0, offset: { minutes: 0, seconds: 0 } });
  // Bare flag (parseFlags returns `true`) is rejected with a clear message.
  assert.throws(() => validateInterval(2, 0, true as any, 0), /--offset-minutes requires a value/);
  assert.throws(() => validateInterval(2, 0, 0, true as any), /--offset-seconds requires a value/);
});

test("validateInterval rejects negative or non-integer offset", () => {
  assert.throws(() => validateInterval(2, 0, -1, 0), /--offset-minutes/);
  assert.throws(() => validateInterval(2, 0, 0, -1), /--offset-seconds/);
  assert.throws(() => validateInterval(2, 0, 1.5, 0), /--offset-minutes/);
  assert.throws(() => validateInterval(2, 0, 0, 1.5), /--offset-seconds/);
});

test("buildSchedule for daily returns { kind, value: { time } }", () => {
  assert.deepEqual(buildSchedule("daily", { time: "09:00" }), {
    kind: "daily",
    value: { time: "09:00" },
  });
});

test("buildSchedule for weekly normalizes days to lowercase", () => {
  const s = buildSchedule("weekly", { days: "MON,Wed", time: "17:00" });
  assert.equal(s.kind, "weekly");
  assert.deepEqual(s.value, { days: ["mon", "wed"], time: "17:00" });
});

test("buildSchedule for interval validates total ≥ 5s", () => {
  assert.throws(() => buildSchedule("interval", { minutes: 0, seconds: 4 }), /too short/);
  const s = buildSchedule("interval", { minutes: 1, seconds: 0 });
  assert.equal(s.kind, "interval");
  assert.deepEqual(s.value, { minutes: 1, seconds: 0, offset: { minutes: 0, seconds: 0 } });
});

test("buildSchedule interval passes offset through to validateInterval", () => {
  const s = buildSchedule("interval", {
    minutes: 2,
    seconds: 0,
    "offset-minutes": 15,
    "offset-seconds": 0,
  });
  assert.equal(s.kind, "interval");
  assert.deepEqual(s.value, { minutes: 2, seconds: 0, offset: { minutes: 15, seconds: 0 } });
});

test("buildSchedule rejects unknown kind", () => {
  assert.throws(() => buildSchedule("monthly", {}), /--kind/);
});

test("parseFlags: bare --offset-minutes yields boolean true and build rejects it", () => {
  const bare = parseFlags(["--offset-minutes"]);
  assert.equal(bare["offset-minutes"], true);
  const absent = parseFlags(["--minutes", "5"]);
  assert.equal(absent["offset-minutes"], undefined);
  assert.throws(
    () => buildSchedule("interval", { minutes: 5, seconds: 0, "offset-minutes": true }),
    /--offset-minutes requires a value/,
  );
  const sAbsent = buildSchedule("interval", { minutes: 5, seconds: 0 });
  assert.deepEqual(sAbsent.value.offset, { minutes: 0, seconds: 0 });
});

test("WEEKDAY_TO_INT matches Apple launchd.plist (Sunday=0..Saturday=6)", () => {
  assert.equal(WEEKDAY_TO_INT.sunday, 0);
  assert.equal(WEEKDAY_TO_INT.monday, 1);
  assert.equal(WEEKDAY_TO_INT.tuesday, 2);
  assert.equal(WEEKDAY_TO_INT.wednesday, 3);
  assert.equal(WEEKDAY_TO_INT.thursday, 4);
  assert.equal(WEEKDAY_TO_INT.friday, 5);
  assert.equal(WEEKDAY_TO_INT.saturday, 6);
});

test("resolveScheduleFields normalizes interval, daily, and weekly schedules", () => {
  const interval = resolveScheduleFields({
    kind: "interval",
    value: { minutes: 5, seconds: 30, offset: { minutes: 1, seconds: 15 } },
  });
  assert.deepEqual(interval, {
    kind: "interval",
    hour: null,
    minute: null,
    totalSeconds: 330,
    offsetSeconds: 75,
    weekdays: null,
  });

  // Old interval shape without offset key (pre-issue-23 catalog entries)
  const oldInterval = resolveScheduleFields({
    kind: "interval",
    value: { minutes: 5, seconds: 0 },
  });
  assert.deepEqual(oldInterval, {
    kind: "interval",
    hour: null,
    minute: null,
    totalSeconds: 300,
    offsetSeconds: 0,
    weekdays: null,
  });

  const daily = resolveScheduleFields({
    kind: "daily",
    value: { time: "14:30" },
  });
  assert.deepEqual(daily, {
    kind: "daily",
    hour: 14,
    minute: 30,
    totalSeconds: null,
    offsetSeconds: 0,
    weekdays: null,
  });

  const weekly = resolveScheduleFields({
    kind: "weekly",
    value: { days: ["friday", "monday"], time: "08:15" },
  });
  assert.deepEqual(weekly, {
    kind: "weekly",
    hour: 8,
    minute: 15,
    totalSeconds: null,
    offsetSeconds: 0,
    weekdays: [1, 5],
  });
});

test("nextFireAt computes expected timestamps for all kinds including old interval shapes", () => {
  const now = new Date("2026-07-22T10:00:00.000Z");

  // Interval
  const nextInterval = nextFireAt({ kind: "interval", value: { minutes: 10, seconds: 0 } }, now);
  assert.equal(nextInterval, "2026-07-22T10:10:00.000Z");

  // Old interval shape without offset key
  const nextOldInterval = nextFireAt({ kind: "interval", value: { minutes: 5, seconds: 0 } }, now);
  assert.equal(nextOldInterval, "2026-07-22T10:05:00.000Z");

  // Daily (later today)
  const nextDailyLater = nextFireAt({ kind: "daily", value: { time: "15:00" } }, now);
  const dDaily = new Date(nextDailyLater);
  assert.equal(dDaily.getHours(), 15);
  assert.equal(dDaily.getMinutes(), 0);

  // Weekly
  const nextWeekly = nextFireAt({ kind: "weekly", value: { days: ["wednesday"], time: "12:00" } }, now);
  const dWeekly = new Date(nextWeekly);
  assert.equal(dWeekly.getHours(), 12);
  assert.equal(dWeekly.getMinutes(), 0);
});
