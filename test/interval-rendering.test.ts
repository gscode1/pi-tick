// test/interval-rendering.test.ts — interval schedules (with/without offset)
// render faithfully on launchd and cron, validate at add time, and next-fire
// matches the rendered schedule. Issues #24 and #27.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { renderPlist, launchdBackend } from "../extensions/tick/bin/backends/launchd.mjs";
import { buildCronLine } from "../extensions/tick/bin/backends/cron.mjs";
import { intervalCalendarForm, nextFireAt, buildSchedule, validateInterval } from "../extensions/tick/bin/schedule.mjs";
import { cmdAdd } from "../extensions/tick/bin/commands/add.mjs";
import { withTempDir, setupEnv, withEnv, teardownEnv } from "./_helpers.ts";

function job(minutes: number, offsetMinutes = 0, offsetSeconds = 0) {
  return {
    id: "j1",
    cwd: "/tmp",
    schedule: { kind: "interval", value: { minutes, seconds: 0, offset: { minutes: offsetMinutes, seconds: offsetSeconds } } },
  };
}
const POPTS = { nodePath: "/n", cliPath: "/c", logsDir: () => "/l" };

function plistFor(minutes: number, off = 0, offSec = 0): string {
  return renderPlist(job(minutes, off, offSec), POPTS);
}
function cronFor(minutes: number, off = 0, offSec = 0): string {
  const out = buildCronLine(job(minutes, off, offSec), POPTS);
  assert.ok(!out.error, out.error);
  return out.line.split(" '")[0]; // schedule fields only
}
// Reduce a plist to its schedule: "I<seconds>" or "C[hour:minute,...]".
function plistSchedule(plist: string): string {
  const si = plist.match(/<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/);
  const sc = plist.includes("<key>StartCalendarInterval</key>");
  assert.ok(!(si && sc), "plist must never contain both StartInterval and StartCalendarInterval");
  assert.doesNotMatch(plist, /<key>Second<\/key>/);
  if (si) return `I${si[1]}`;
  const body = plist.split("<key>StartCalendarInterval</key>")[1];
  const dicts = [...body.matchAll(/<dict>([\s\S]*?)<\/dict>/g)].map((d) => d[1]);
  return "C[" + dicts.map((d) => {
    const h = d.match(/<key>Hour<\/key>\s*<integer>(\d+)<\/integer>/);
    const m = d.match(/<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/);
    return `${h ? h[1] : "*"}:${m![1]}`;
  }).join(",") + "]";
}

// The user's real jobs: [name, minutes, offsetMinutes, launchd, cron].
const USER_TABLE: Array<[string, number, number, string, string]> = [
  ["every 2h +1h", 120, 60, "C[1:0,3:0,5:0,7:0,9:0,11:0,13:0,15:0,17:0,19:0,21:0,23:0]", "0 1,3,5,7,9,11,13,15,17,19,21,23 * * *"],
  ["every 1h +30m", 60, 30, "C[*:30]", "30 * * * *"],
  ["every 3h +30m", 180, 30, "C[0:30,3:30,6:30,9:30,12:30,15:30,18:30,21:30]", "30 0,3,6,9,12,15,18,21 * * *"],
  ["every 2h", 120, 0, "I7200", "0 */2 * * *"],
  ["every 4h", 240, 0, "I14400", "0 */4 * * *"],
  ["every 3h", 180, 0, "I10800", "0 */3 * * *"],
  ["every 1h", 60, 0, "I3600", "0 * * * *"],
];

for (const [name, minutes, off, launchd, cron] of USER_TABLE) {
  test(`user job table: ${name} renders correctly on launchd and cron`, () => {
    assert.equal(plistSchedule(plistFor(minutes, off)), launchd);
    assert.equal(cronFor(minutes, off), cron);
  });
}

test("launchd: no-offset intervals keep StartInterval (7, 10, 15, 45, 60, 90, 120, 180, 1440 minutes)", () => {
  for (const m of [7, 10, 15, 45, 60, 90, 120, 180, 1440]) {
    assert.equal(plistSchedule(plistFor(m)), `I${m * 60}`, `${m}m`);
  }
});

test("launchd: offset intervals render StartCalendarInterval only", () => {
  assert.equal(plistSchedule(plistFor(10, 3)), "C[*:3,*:13,*:23,*:33,*:43,*:53]");
  assert.equal(plistSchedule(plistFor(15, 5)), "C[*:5,*:20,*:35,*:50]");
  assert.equal(plistSchedule(plistFor(60, 15)), "C[*:15]");
  assert.ok(plistSchedule(plistFor(120, 90)).startsWith("C[1:30,3:30,"));
  assert.equal(plistSchedule(plistFor(1440, 90)), "C[1:30]");
  assert.equal(plistSchedule(plistFor(1440, 0)), "I86400");
});

test("launchd: offsets without a calendar form, with seconds, or >= interval are rejected", () => {
  for (const [m, off, sec] of [[7, 3, 0], [45, 5, 0], [90, 30, 0], [10, 3, 30], [10, 10, 0], [120, 120, 0], [180, 200, 0]]) {
    assert.throws(() => plistFor(m, off, sec), /launchd cannot render/, `${m}m +${off}m +${sec}s`);
    const r = launchdBackend.scheduleError(job(m, off, sec).schedule);
    assert.match(r!, /launchd cannot render/);
  }
});

test("cron: intervals render faithfully or are rejected", () => {
  assert.equal(cronFor(1), "* * * * *");
  assert.equal(cronFor(10), "*/10 * * * *");
  assert.equal(cronFor(15), "*/15 * * * *");
  assert.equal(cronFor(60), "0 * * * *");
  assert.equal(cronFor(120), "0 */2 * * *");
  assert.equal(cronFor(180), "0 */3 * * *");
  assert.equal(cronFor(1440), "0 */24 * * *");
  assert.equal(cronFor(10, 3), "3,13,23,33,43,53 * * * *");
  assert.equal(cronFor(15, 5), "5,20,35,50 * * * *");
  assert.equal(cronFor(1440, 90), "30 1 * * *");
  for (const m of [7, 45, 90]) {
    const out = buildCronLine(job(m), POPTS);
    assert.match(out.error!, /cron cannot render this interval faithfully/, `${m}m`);
    assert.match(out.error!, /1, 2, 3/);
  }
  assert.match(buildCronLine(job(120, 90, 30), POPTS).error!, /whole number of minutes/);
  assert.match(buildCronLine(job(10, 10), POPTS).error!, /smaller than the interval/);
  assert.match(buildCronLine(job(7, 3), POPTS).error!, /cron cannot render/);
});

test("intervalCalendarForm", () => {
  assert.deepEqual(intervalCalendarForm(1800, 900), { minutes: [15, 45], hours: null });
  assert.deepEqual(intervalCalendarForm(86400, 0), { minutes: [0], hours: [0] });
  assert.ok(intervalCalendarForm(5400, 0).error);
  assert.ok(intervalCalendarForm(420, 60).error);
});

test("add-time validation: unrenderable offsets fail on the active backend", () => {
  const prev = process.env.PI_TICK_BACKEND;
  try {
    process.env.PI_TICK_BACKEND = "cron";
    assert.throws(() => validateInterval(7, 0, 0, 0), /cron cannot render/);
    assert.doesNotThrow(() => validateInterval(120, 0, 60, 0));
    process.env.PI_TICK_BACKEND = "launchd";
    assert.doesNotThrow(() => validateInterval(7, 0, 0, 0));
    assert.throws(() => validateInterval(7, 0, 3, 0), /launchd cannot render/);
    assert.throws(() => buildSchedule("interval", { minutes: 10, "offset-minutes": 3, "offset-seconds": 30 }), /launchd cannot render/);
  } finally {
    if (prev === undefined) delete process.env.PI_TICK_BACKEND; else process.env.PI_TICK_BACKEND = prev;
  }
});

test("cmdAdd --enabled with an unrenderable offset fails cleanly and stores nothing", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await assert.rejects(
        withEnv(env, () => cmdAdd(["bad", "--prompt", "p", "--cwd", "/tmp", "--kind", "interval", "--minutes", "7", "--offset-minutes", "3", "--enabled"])),
        /launchd cannot render/,
      );
      assert.ok(!existsSync(join(dir, "agents", "dev.pi.tick.bad.plist")));
      const cat = existsSync(join(dir, "jobs.json")) ? JSON.parse(readFileSync(join(dir, "jobs.json"), "utf8")) : { jobs: [] };
      assert.equal(cat.jobs.length, 0);
    } finally {
      teardownEnv(env);
    }
  });
});

test("launchd register returns an error (no plist written) for a catalog job that cannot be rendered", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      const r = await withEnv(env, () => launchdBackend.register(job(7, 3) as any, { ...POPTS, logsDir: join(dir, "logs") } as any));
      assert.equal(r.ok, false);
      assert.match(r.error!, /launchd cannot render/);
      assert.ok(!existsSync(join(dir, "agents", "dev.pi.tick.j1.plist")));
    } finally {
      teardownEnv(env);
    }
  });
});

// ─── next-fire ───────────────────────────────────────────────────────────

function withTz<T>(tz: string, backend: string, fn: () => T): T {
  const prevTz = process.env.TZ;
  const prevB = process.env.PI_TICK_BACKEND;
  process.env.TZ = tz;
  process.env.PI_TICK_BACKEND = backend;
  try { return fn(); } finally {
    if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz;
    if (prevB === undefined) delete process.env.PI_TICK_BACKEND; else process.env.PI_TICK_BACKEND = prevB;
  }
}
const sched = (m: number, off = 0) => job(m, off).schedule;

test("nextFireAt (UTC): offsets follow the calendar form", () => {
  withTz("UTC", "launchd", () => {
    const now = new Date("2026-03-10T10:20:30Z");
    assert.equal(nextFireAt(sched(120, 60), now), "2026-03-10T11:00:00.000Z"); // 1,3,5,..,11
    assert.equal(nextFireAt(sched(60, 30), now), "2026-03-10T10:30:00.000Z");
    assert.equal(nextFireAt(sched(60, 30), new Date("2026-03-10T10:30:00Z")), "2026-03-10T11:30:00.000Z");
    assert.equal(nextFireAt(sched(180, 30), now), "2026-03-10T12:30:00.000Z"); // 0:30,3:30,...,12:30
    assert.equal(nextFireAt(sched(10, 3), now), "2026-03-10T10:23:00.000Z");
    assert.equal(nextFireAt(sched(1440, 90), now), "2026-03-11T01:30:00.000Z");
    // No offset on launchd stays the now + interval approximation.
    assert.equal(nextFireAt(sched(120), now), "2026-03-10T12:20:30.000Z");
  });
});

test("nextFireAt (UTC, cron): no-offset intervals follow the cron fields", () => {
  withTz("UTC", "cron", () => {
    const now = new Date("2026-03-10T10:20:30Z");
    assert.equal(nextFireAt(sched(120), now), "2026-03-10T12:00:00.000Z");
    assert.equal(nextFireAt(sched(15), now), "2026-03-10T10:30:00.000Z");
    assert.equal(nextFireAt(sched(180, 30), now), "2026-03-10T12:30:00.000Z");
  });
});

test("nextFireAt (Europe/Prague): wall-clock matching, including DST", () => {
  withTz("Europe/Prague", "launchd", () => {
    // 2026-03-10 is CET (UTC+1): 10:20 UTC = 11:20 local; next odd hour = 13:00 local = 12:00 UTC.
    assert.equal(nextFireAt(sched(120, 60), new Date("2026-03-10T10:20:30Z")), "2026-03-10T12:00:00.000Z");
    assert.equal(nextFireAt(sched(60, 30), new Date("2026-03-10T10:20:30Z")), "2026-03-10T10:30:00.000Z");
    // 2026-07-10 is CEST (UTC+2): 10:20 UTC = 12:20 local; next odd hour = 13:00 local = 11:00 UTC.
    assert.equal(nextFireAt(sched(120, 60), new Date("2026-07-10T10:20:30Z")), "2026-07-10T11:00:00.000Z");
    // 3h +30m at 22:40 local (21:40Z, CET) -> 00:30 local next day = 23:30Z.
    assert.equal(nextFireAt(sched(180, 30), new Date("2026-03-10T21:40:00Z")), "2026-03-10T23:30:00.000Z");
    // Spring-forward 2026-03-29: 01:10 CET (00:10Z); 2h +1h next odd local hour is 03:00 CEST (01:00Z).
    assert.equal(nextFireAt(sched(120, 60), new Date("2026-03-29T00:10:00Z")), "2026-03-29T01:00:00.000Z");
  });
});
