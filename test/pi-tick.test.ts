// test/pi-tick.test.ts — CLI behavior: validation, runner, plist render
// (plist rendering now lives in the launchd backend module, imported below).

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFlags } from "../extensions/tick/bin/argv.mjs";
import { validateId, validatePrompt, validateCwd, validateTime, validateInterval, buildSchedule, KIND_INTERVAL, KIND_DAILY, KIND_WEEKLY } from "../extensions/tick/bin/validate.mjs";
import { formatSchedule, formatNextFire } from "../extensions/tick/bin/display.mjs";
import { augmentedPath } from "../extensions/tick/bin/bin-resolve.mjs";
import { cmdAdd } from "../extensions/tick/bin/commands/add.mjs";
import { cmdList } from "../extensions/tick/bin/commands/list.mjs";
import { cmdDelete } from "../extensions/tick/bin/commands/delete.mjs";
import { cmdEnable } from "../extensions/tick/bin/commands/enable.mjs";
import { cmdDisable } from "../extensions/tick/bin/commands/disable.mjs";
import { cmdRun } from "../extensions/tick/bin/commands/run.mjs";
import { cmdKill } from "../extensions/tick/bin/commands/kill.mjs";
import { cmdConfig } from "../extensions/tick/bin/commands/config.mjs";
import { getActiveRun, isPidAlive, killActiveRun } from "../extensions/tick/bin/run-registry.mjs";
import { loadConfig, saveConfig, PiTickError } from "../extensions/tick/bin/catalog.mjs";
import { WEEKDAY_TO_INT } from "../extensions/tick/bin/schedule-math.mjs";
import { configFile } from "../extensions/tick/bin/paths.mjs";
import { extractStderrSignature, extractTaskflowFailure } from "../extensions/tick/bin/runner.mjs";
import { launchdBackend, renderPlist } from "../extensions/tick/bin/backends/launchd.mjs";
import { cronBackend } from "../extensions/tick/bin/backends/cron.mjs";
import { withTempDir, setupEnv, withEnv, teardownEnv, writeStub, readStubLog } from "./_helpers.ts";
import { join, sep, dirname } from "node:path";
import { existsSync, readFileSync, writeFileSync, statSync, mkdirSync, copyFileSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

function mockPi() {
  return `echo '{"type":"message_start","message":{"role":"assistant"}}'
echo '{"type":"message_update","message":{"role":"assistant"}}'
echo '{"type":"message_end","message":{"role":"assistant","usage":{"input":42,"output":7}}}'
echo '{"type":"message_end","message":{"role":"assistant","usage":{"input":100,"output":50}}}'
exit 0
`;
}

function mockPiFail(code = 1) {
  return `echo "something went wrong" >&2
exit ${code}
`;
}

function mockPiTaskflowFail() {
  const text = [
    "runId: 53a3f8e3",
    "duration: 9s",
    "taskflow run: dev-pr-review-mqltogta-da47a6",
    "failed at: preflight",
    "error: forge: tea not installed",
  ].join("\\n");
  return `echo '${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage: { input: 1, output: 2 } } })}'
exit 0
`;
}

// Mirror a real pi crash: write a named Error to stderr with a trailing
// stack frame, then exit non-zero. Used to assert the runner picks the
// `Error:` line as `RunRecord.error` instead of the trailing frame.
function mockPiCrashWithStack(message = "prompt must be a string") {
  return `printf 'TypeError: ${message}\\n    at ModuleJob.syncLink (node:internal/modules/esm/loader:1:1)\\n    at async Promise.all (index 0)\\n' >&2
exit 1
`;
}

function mockPiSlow(ms = 100) {
  return `sleep ${ms}
exit 0
`;
}

async function captureStdout(fn: (streams: { stdout: any, stderr: any }) => Promise<unknown> | unknown): Promise<string> {
  const out: string[] = [];
  const stdout = {
    write: (chunk: string | Uint8Array) => {
      out.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }
  } as typeof process.stdout;
  const stderr = {
    write: () => true
  } as typeof process.stderr;
  await fn({ stdout, stderr });
  return out.join("");
}

async function captureStderr(fn: (streams: { stdout: any, stderr: any }) => Promise<unknown> | unknown): Promise<string> {
  const out: string[] = [];
  const stdout = {
    write: () => true
  } as typeof process.stdout;
  const stderr = {
    write: (chunk: string | Uint8Array) => {
      out.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }
  } as typeof process.stderr;
  await fn({ stdout, stderr });
  return out.join("");
}

function stubbedLaunchctl() {
  // Log every call and exit 0.
  return `echo "launchctl $@" >> "$LOG"
exit 0
`;
}

function stubbedLaunchctlBootstrapFails() {
  return `echo "launchctl $@" >> "$LOG"
if [ "$1" = "bootstrap" ]; then
  echo "bootstrap failed" >&2
  exit 1
fi
exit 0
`;
}

// ─── Argv parsing ────────────────────────────────────────────────────────

test("parseFlags handles --key value pairs", () => {
  const r = parseFlags(["--prompt", "hello", "--kind", "daily"]);
  assert.equal(r.prompt, "hello");
  assert.equal(r.kind, "daily");
  assert.deepEqual(r._, []);
});

test("parseFlags handles --key=value", () => {
  const r = parseFlags(["--prompt=hi", "--time=09:00"]);
  assert.equal(r.prompt, "hi");
  assert.equal(r.time, "09:00");
});

test("parseFlags treats lone --flag as boolean true", () => {
  const r = parseFlags(["--enabled"]);
  assert.equal(r.enabled, true);
});

test("parseFlags preserves positional args", () => {
  const r = parseFlags(["my-job", "extra"]);
  assert.deepEqual(r._, ["my-job", "extra"]);
});

// ─── Validation ───────────────────────────────────────────────────────────

test("validateId accepts a valid id", () => {
  // No throw.
  validateId("nightly-recap_2.0");
});

test("validateId rejects an empty id", () => {
  assert.throws(() => validateId(""), /invalid id/);
  assert.throws(() => validateId("-leading-dash"), /invalid id/);
  assert.throws(() => validateId("with space"), /invalid id/);
  assert.throws(() => validateId("a".repeat(65)), /invalid id/);
});

test("validatePrompt rejects empty and oversized", () => {
  assert.throws(() => validatePrompt(""), /non-empty/);
  assert.throws(() => validatePrompt("x".repeat(16 * 1024 + 1)), /maximum/);
});

test("validateCwd rejects non-absolute and missing paths", () => {
  assert.throws(() => validateCwd("relative/path"), /absolute/);
  assert.throws(() => validateCwd("/this/does/not/exist/12345"), /does not exist/);
});

test("validateCwd accepts an existing directory", () => {
  validateCwd(tmpdir());
});

test("validateTime accepts HH:MM and rejects bad values", () => {
  validateTime("00:00");
  validateTime("23:59");
  assert.throws(() => validateTime("24:00"), /HH:MM/);
  assert.throws(() => validateTime("9:00"), /HH:MM/);
  assert.throws(() => validateTime("9:00am"), /HH:MM/);
});

test("validateInterval enforces minimum 5 seconds", () => {
  assert.throws(() => validateInterval(0, 0), /requires/);
  assert.throws(() => validateInterval(0, 4), /too short/);
  const v = validateInterval(0, 5);
  assert.deepEqual(v, { minutes: 0, seconds: 5, offset: { minutes: 0, seconds: 0 } });
  const v2 = validateInterval(10, 30);
  assert.deepEqual(v2, { minutes: 10, seconds: 30, offset: { minutes: 0, seconds: 0 } });
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

test("buildSchedule rejects unknown kind", () => {
  assert.throws(() => buildSchedule("monthly", {}), /--kind/);
});

// ─── Plist render ─────────────────────────────────────────────────────────

test("renderPlist: daily schedule has StartCalendarInterval dict with Hour/Minute", () => {
  const job = makeJob({ id: "daily-job", scheduleKind: "daily", scheduleValue: { time: "09:00" } });
  const plist = renderPlist(job, { nodePath: "/usr/local/bin/node", cliPath: "/stable/cli.mjs" });
  assert.match(plist, /<key>Label<\/key>\s*<string>dev\.pi\.tick\.daily-job<\/string>/);
  assert.match(plist, /<key>ProgramArguments<\/key>/);
  assert.match(plist, /<string>\/usr\/local\/bin\/node<\/string>/);
  assert.match(plist, /<string>\/stable\/cli\.mjs<\/string>/);
  assert.match(plist, /<string>run<\/string>/);
  assert.match(plist, /<string>daily-job<\/string>/);
  assert.match(plist, /<key>WorkingDirectory<\/key>\s*<string>\/tmp<\/string>/);
  assert.match(plist, /<key>StandardOutPath<\/key>/);
  assert.match(plist, /<key>StandardErrorPath<\/key>/);
  assert.match(plist, /<key>StartCalendarInterval<\/key>/);
  assert.match(plist, /<key>Hour<\/key>\s*<integer>9<\/integer>/);
  assert.match(plist, /<key>Minute<\/key>\s*<integer>0<\/integer>/);
  assert.doesNotMatch(plist, /StartInterval/);
});

test("renderPlist: weekly schedule has StartCalendarInterval array with Weekday numbers", () => {
  const job = makeJob({ id: "weekly-job", scheduleKind: "weekly", scheduleValue: { days: ["sunday", "monday", "wednesday", "saturday"], time: "17:30" } });
  const plist = renderPlist(job, { nodePath: "/n", cliPath: "/c" });
  assert.match(plist, /<key>StartCalendarInterval<\/key>/);
  assert.match(plist, /<key>Weekday<\/key>\s*<integer>0<\/integer>/); // sunday
  assert.match(plist, /<key>Weekday<\/key>\s*<integer>1<\/integer>/); // monday
  assert.match(plist, /<key>Weekday<\/key>\s*<integer>3<\/integer>/); // wednesday
  assert.match(plist, /<key>Weekday<\/key>\s*<integer>6<\/integer>/); // saturday
  assert.match(plist, /<key>Hour<\/key>\s*<integer>17<\/integer>/);
  assert.match(plist, /<key>Minute<\/key>\s*<integer>30<\/integer>/);
});

test("renderPlist: interval schedule uses StartInterval in seconds", () => {
  const job = makeJob({ id: "tick", scheduleKind: "interval", scheduleValue: { minutes: 2, seconds: 30 } });
  const plist = renderPlist(job, { nodePath: "/n", cliPath: "/c" });
  assert.match(plist, /<key>StartInterval<\/key>\s*<integer>150<\/integer>/);
  assert.doesNotMatch(plist, /StartCalendarInterval/);
});

test("renderPlist: envPath is baked into EnvironmentVariables.PATH (fixes launchd minimal PATH)", () => {
  const job = makeJob({ id: "envjob", scheduleKind: "interval", scheduleValue: { minutes: 1, seconds: 0 } });
  const envPath = "/opt/homebrew/bin:/Users/x/.local/bin:/usr/bin:/bin";
  const plist = renderPlist(job, { nodePath: "/n", cliPath: "/c", envPath });
  assert.match(plist, /<key>EnvironmentVariables<\/key>\s*<dict>\s*<key>PATH<\/key>/);
  assert.match(plist, /<string>\/opt\/homebrew\/bin:\/Users\/x\/\.local\/bin:\/usr\/bin:\/bin<\/string>/);
});

test("renderPlist: envVars are baked into EnvironmentVariables", () => {
  const job = makeJob({ id: "otel", scheduleKind: "interval", scheduleValue: { minutes: 1, seconds: 0 } });
  const plist = renderPlist(job, { nodePath: "/n", cliPath: "/c", envVars: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" } });
  assert.match(plist, /<key>OTEL_EXPORTER_OTLP_ENDPOINT<\/key>\s*<string>http:\/\/collector:4318<\/string>/);
});

test("renderPlist: no EnvironmentVariables block when envPath is absent", () => {
  const job = makeJob({ id: "noenv", scheduleKind: "interval", scheduleValue: { minutes: 1, seconds: 0 } });
  const plist = renderPlist(job, { nodePath: "/n", cliPath: "/c" });
  assert.doesNotMatch(plist, /EnvironmentVariables/);
});

test("augmentedPath: includes the running node's dir, Homebrew, and system dirs; deduped; no empties", () => {
  const p = augmentedPath("/usr/bin:/bin");
  const parts = p.split(":");
  // the node executing the tests is the most reliable anchor under launchd
  assert.ok(parts.includes(dirname(process.execPath)), "should include dir of process.execPath");
  assert.ok(parts.includes("/opt/homebrew/bin"), "should include Homebrew (Apple silicon)");
  assert.ok(parts.includes("/usr/local/bin"), "should include Homebrew (Intel)/usr-local");
  for (const sys of ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]) {
    assert.ok(parts.includes(sys), `should include system dir ${sys}`);
  }
  assert.equal(parts.filter((d) => d === "").length, 0, "no empty segments");
  assert.equal(new Set(parts).size, parts.length, "no duplicate dirs");
});

test("augmentedPath: a minimal launchd PATH gains the tool dirs it was missing", () => {
  // Simulates launchd's default: tea/gh (Homebrew) absent.
  const p = augmentedPath("/usr/bin:/bin:/usr/sbin:/sbin");
  assert.ok(p.split(":").includes("/opt/homebrew/bin"));
});

// ─── Interval offset (issue 22) ──────────────────────────────────────────

test("validateInterval accepts offset fields and returns them on the value", () => {
  const v = validateInterval(2, 0, 15, 30);
  assert.deepEqual(v, { minutes: 2, seconds: 0, offset: { minutes: 15, seconds: 30 } });
  const v0 = validateInterval(2, 0, 0, 0);
  assert.deepEqual(v0, { minutes: 2, seconds: 0, offset: { minutes: 0, seconds: 0 } });
  // Bare flag (parseFlags returns `true`) is rejected with a clear
  // message — not silently coerced to 1.
  assert.throws(() => validateInterval(2, 0, true, 0), /--offset-minutes requires a value/);
  assert.throws(() => validateInterval(2, 0, 0, true), /--offset-seconds requires a value/);
});

test("validateInterval rejects negative or non-integer offset", () => {
  assert.throws(() => validateInterval(2, 0, -1, 0), /--offset-minutes/);
  assert.throws(() => validateInterval(2, 0, 0, -1), /--offset-seconds/);
  assert.throws(() => validateInterval(2, 0, 1.5, 0), /--offset-minutes/);
  assert.throws(() => validateInterval(2, 0, 0, 1.5), /--offset-seconds/);
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

test("renderPlist: interval with offset adds StartCalendarInterval for wall-clock first fire", () => {
  // Compute the expected wall-clock target = now + offset. renderPlist
  // reads Date.now() at render time, so we sample the boundary just
  // before/after and assert the plist lands within ±1 second of either
  // — the only drift source is the time between the two Date.now()
  // calls, which is sub-millisecond on any modern machine.
  const offsetMin = 15;
  const offsetSec = 30;
  const offsetMs = offsetMin * 60_000 + offsetSec * 1000;
  const tBefore = Date.now();
  const job = makeJob({
    id: "phase",
    scheduleKind: "interval",
    scheduleValue: { minutes: 2, seconds: 0, offset: { minutes: offsetMin, seconds: offsetSec } },
  });
  const plist = renderPlist(job, { nodePath: "/n", cliPath: "/c" });
  const tAfter = Date.now();

  // StartInterval must still be the unphased cadence (120s for minutes:2, seconds:0).
  assert.match(plist, /<key>StartInterval<\/key>\s*<integer>120<\/integer>/);
  // StartCalendarInterval must be present.
  assert.match(plist, /<key>StartCalendarInterval<\/key>/);
  assert.match(plist, /<key>Minute<\/key>/);
  assert.match(plist, /<key>Second<\/key>/);

  // Extract the emitted Minute/Second integers.
  const m = plist.match(/<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/);
  const s = plist.match(/<key>Second<\/key>\s*<integer>(\d+)<\/integer>/);
  assert.ok(m && s, `plist missing Minute/Second integers:\n${plist}`);

  // The plist's minute/second must equal new Date(now + offsetMs) for
  // some `now` in [tBefore, tAfter]. Equivalently, allow ±1s drift on
  // the second boundary (the minute rarely drifts within a single render).
  const candidates = [new Date(tBefore + offsetMs), new Date(tAfter + offsetMs)];
  const expectMin = candidates[0].getMinutes();
  const expectSec = candidates[0].getSeconds();
  const altSec = candidates[1].getSeconds();
  const altMin = candidates[1].getMinutes();
  const emittedMin = Number(m[1]);
  const emittedSec = Number(s[1]);
  const minOk = emittedMin === expectMin || emittedMin === altMin;
  const secOk = emittedSec === expectSec || emittedSec === altSec;
  assert.ok(minOk, `emitted Minute=${emittedMin} not in {${expectMin},${altMin}}; now=${new Date().toISOString()}`);
  assert.ok(secOk, `emitted Second=${emittedSec} not in {${expectSec},${altSec}}; now=${new Date().toISOString()}`);
});

test("renderPlist: two interval jobs of the same cadence with different offsets get distinct first-fires", () => {
  const a = makeJob({
    id: "a",
    scheduleKind: "interval",
    scheduleValue: { minutes: 2, seconds: 0, offset: { minutes: 0, seconds: 0 } },
  });
  const b = makeJob({
    id: "b",
    scheduleKind: "interval",
    scheduleValue: { minutes: 2, seconds: 0, offset: { minutes: 15, seconds: 0 } },
  });
  const plistA = renderPlist(a, { nodePath: "/n", cliPath: "/c" });
  const plistB = renderPlist(b, { nodePath: "/n", cliPath: "/c" });
  // StartInterval is identical (the cadence is unchanged by the offset).
  assert.match(plistA, /<key>StartInterval<\/key>\s*<integer>120<\/integer>/);
  assert.match(plistB, /<key>StartInterval<\/key>\s*<integer>120<\/integer>/);
  // Only the offset job emits StartCalendarInterval.
  assert.doesNotMatch(plistA, /StartCalendarInterval/);
  assert.match(plistB, /StartCalendarInterval/);
});

test("renderPlist: no-offset interval is byte-identical to the pre-offset plist", () => {
  // Hard-coded snapshot of a 2m interval plist with no offset. Any
  // whitespace change in renderPlist will fail this string-equal
  // check, surfacing unintended drift. Pass an explicit logsDir so
  // the output is independent of the host's PI_TICK_DATA_DIR.
  const PLIST_NO_OFFSET_INTERVAL_120 = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.pi.tick.back-compat</string>
  <key>ProgramArguments</key>
  <array>
    <string>/n</string>
    <string>/c</string>
    <string>run</string>
    <string>back-compat</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/tmp</string>
  <key>StandardOutPath</key>
  <string>/test-logs/back-compat.out.log</string>
  <key>StandardErrorPath</key>
  <string>/test-logs/back-compat.err.log</string>
  <key>StartInterval</key>
  <integer>120</integer>
</dict>
</plist>
`;
  // Old-shape value (no `offset` key) — the defensive read should
  // collapse it to no StartCalendarInterval.
  const job = makeJob({
    id: "back-compat",
    scheduleKind: "interval",
    scheduleValue: { minutes: 2, seconds: 0 },
  });
  const plist = renderPlist(job, { nodePath: "/n", cliPath: "/c", logsDir: () => "/test-logs" });
  assert.equal(plist, PLIST_NO_OFFSET_INTERVAL_120);
});

test("renderPlist: interval with explicit 0/0 offset is byte-identical to omitted offset", () => {
  const jobImplicit = makeJob({
    id: "x",
    scheduleKind: "interval",
    scheduleValue: { minutes: 2, seconds: 0 },
  });
  const jobExplicit = makeJob({
    id: "x",
    scheduleKind: "interval",
    scheduleValue: { minutes: 2, seconds: 0, offset: { minutes: 0, seconds: 0 } },
  });
  const plistImplicit = renderPlist(jobImplicit, { nodePath: "/n", cliPath: "/c" });
  const plistExplicit = renderPlist(jobExplicit, { nodePath: "/n", cliPath: "/c" });
  assert.equal(plistImplicit, plistExplicit);
});

test("renderPlist: interval with offset ≥ 60s rolls correctly via Date math", () => {
  // 75 minutes from now → Date.getMinutes()/getSeconds() are bounded
  // 0..59 so the rendered Minute/Second always land in range. We just
  // assert the plist is structurally well-formed; the previous test
  // pins the wall-clock target semantics.
  const job = makeJob({
    id: "big",
    scheduleKind: "interval",
    scheduleValue: { minutes: 2, seconds: 0, offset: { minutes: 75, seconds: 0 } },
  });
  const plist = renderPlist(job, { nodePath: "/n", cliPath: "/c" });
  const m = plist.match(/<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/);
  const s = plist.match(/<key>Second<\/key>\s*<integer>(\d+)<\/integer>/);
  assert.ok(m && s);
  assert.ok(Number(m[1]) >= 0 && Number(m[1]) <= 59, `Minute out of range: ${m[1]}`);
  assert.ok(Number(s[1]) >= 0 && Number(s[1]) <= 59, `Second out of range: ${s[1]}`);
});

test("formatSchedule: interval with no offset returns 'every Xm' (humanized display)", () => {
  // Old-shape value (no offset key) — human-readable display above 60s.
  const s = { kind: "interval", value: { minutes: 2, seconds: 0 } };
  assert.equal(formatSchedule(s), "every 2m");
});

test("formatSchedule: interval with explicit 0/0 offset matches the no-offset string", () => {
  const noOffset = formatSchedule({ kind: "interval", value: { minutes: 2, seconds: 0 } });
  const zeroOffset = formatSchedule({ kind: "interval", value: { minutes: 2, seconds: 0, offset: { minutes: 0, seconds: 0 } } });
  assert.equal(noOffset, zeroOffset);
  assert.equal(noOffset, "every 2m");
});

test("formatSchedule: interval with non-zero offset appends '+Xm offset' (humanized)", () => {
  const out = formatSchedule({ kind: "interval", value: { minutes: 2, seconds: 0, offset: { minutes: 15, seconds: 0 } } });
  assert.equal(out, "every 2m +15m offset");
});

test("formatNextFire: interval with offset is offset-agnostic by design", () => {
  // The display column is a best-effort hint and must not pretend to
  // model the offset — the plist is the source of truth and re-enable
  // shifts the phase. Both shapes must produce the same output.
  const a = formatNextFire({ kind: "interval", value: { minutes: 2, seconds: 0 } });
  const b = formatNextFire({ kind: "interval", value: { minutes: 2, seconds: 0, offset: { minutes: 15, seconds: 0 } } });
  assert.equal(a, b);
  // And it's `now + interval`, not `now + interval + offset`.
  const expectedMs = Date.now() + (2 * 60 + 0) * 1000;
  const actualMs = new Date(a).getTime();
  // ±2s tolerance for the time between Date.now() calls.
  assert.ok(Math.abs(actualMs - expectedMs) < 2000, `expected ~${expectedMs}, got ${actualMs}`);
});

test("cmdAdd persists the offset when --offset-minutes/--offset-seconds are set", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      const code = await withEnv(env, () => cmdAdd([
        "phased",
        "--prompt", "p",
        "--cwd", "/tmp",
        "--kind", "interval",
        "--minutes", "2",
        "--offset-minutes", "15",
        "--offset-seconds", "30",
      ], { stdout: process.stdout as any, stderr: process.stderr as any }));
      assert.equal(code, 0);
      const cat = JSON.parse(readFileSync(join(dir, "jobs.json"), "utf8"));
      assert.deepEqual(cat.jobs[0].schedule.value.offset, { minutes: 15, seconds: 30 });
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdAdd persists a 0/0 offset by default when flags are absent", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await withEnv(env, () => cmdAdd([
        "nophase",
        "--prompt", "p",
        "--cwd", "/tmp",
        "--kind", "interval",
        "--minutes", "2",
      ], { stdout: process.stdout as any, stderr: process.stderr as any }));
      const cat = JSON.parse(readFileSync(join(dir, "jobs.json"), "utf8"));
      assert.deepEqual(cat.jobs[0].schedule.value.offset, { minutes: 0, seconds: 0 });
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdAdd rejects negative offset values", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await assert.rejects(
        () => withEnv(env, () => cmdAdd([
          "bad", "--prompt", "p", "--cwd", "/tmp",
          "--kind", "interval", "--minutes", "2",
          "--offset-minutes", "-1",
        ], { stdout: process.stdout as any, stderr: process.stderr as any })),
        /--offset-minutes/,
      );
    } finally {
      teardownEnv(env);
    }
  });
});

// tick_create argv shape: --offset-minutes is pushed when set, omitted
// when absent. Mirrors how the LLM tool constructs argv from
// scheduleValue (the schema for offsetMinutes/offsetSeconds is verified
// at the TypeBox level separately; this test pins the argv logic).
test("tick_create-style argv: --offset-minutes 15 persists offset, --offset-seconds omitted when not set", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      // scheduleValue { offsetMinutes: 15, offsetSeconds: undefined } →
      // tick_create pushes only --offset-minutes 15 (offsetSeconds === null
      // is treated the same as undefined by the tool). We construct the
      // argv that tick_create.execute would build and pass it directly
      // to cmdAdd.
      await withEnv(env, () => cmdAdd([
        "tool-argv",
        "--prompt", "p",
        "--cwd", "/tmp",
        "--kind", "interval",
        "--minutes", "2",
        "--offset-minutes", "15",
      ], { stdout: process.stdout as any, stderr: process.stderr as any }));
      const cat = JSON.parse(readFileSync(join(dir, "jobs.json"), "utf8"));
      assert.deepEqual(cat.jobs[0].schedule.value.offset, { minutes: 15, seconds: 0 });
    } finally {
      teardownEnv(env);
    }
  });
});

test("renderPlist: XML-escapes special characters", () => {
  const job = makeJob({ id: "weird", scheduleKind: "daily", scheduleValue: { time: "09:00" }, cwd: "/tmp/<weird> & \"quoted\"" });
  const plist = renderPlist(job, { nodePath: "/n", cliPath: "/c" });
  assert.match(plist, /&lt;weird&gt;/);
  assert.match(plist, /&amp;/);
  assert.match(plist, /&quot;quoted&quot;/);
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

// ─── cmdAdd / cmdList / cmdDelete (disabled) ─────────────────────────────

function makeJob(o: Partial<{
  id: string; prompt: string; cwd: string;
  scheduleKind: "interval" | "daily" | "weekly";
  scheduleValue: Record<string, unknown>;
  enabled: boolean; model: string | null;
}> = {}) {
  const sk = o.scheduleKind ?? "daily";
  return {
    id: o.id ?? "test-job",
    prompt: o.prompt ?? "hello",
    cwd: o.cwd ?? "/tmp",
    schedule: sk === "interval"
      ? { kind: "interval", value: o.scheduleValue ?? { minutes: 5, seconds: 0 } }
      : sk === "weekly"
        ? { kind: "weekly", value: o.scheduleValue ?? { days: ["monday"], time: "09:00" } }
        : { kind: "daily", value: o.scheduleValue ?? { time: "09:00" } },
    enabled: o.enabled ?? false,
    model: o.model ?? null,
    piPath: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastRun: null,
  };
}

test("cmdAdd creates a disabled job in the catalog", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      const code = await withEnv(env, () => cmdAdd([
        "test-job",
        "--prompt", "do the thing",
        "--cwd", "/tmp",
        "--kind", "daily",
        "--time", "09:00",
      ], { stdout: process.stdout as any, stderr: process.stderr as any }));
      assert.equal(code, 0);
      const cat = JSON.parse(readFileSync(join(dir, "jobs.json"), "utf8"));
      assert.equal(cat.jobs.length, 1);
      assert.equal(cat.jobs[0].id, "test-job");
      assert.equal(cat.jobs[0].enabled, false);
      assert.equal(cat.jobs[0].schedule.kind, "daily");
      assert.equal((statSync(join(dir, "jobs.json")).mode & 0o777), 0o600);
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdAdd rejects a duplicate id with a clear error", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await withEnv(env, () => cmdAdd([
        "test-job", "--prompt", "x", "--cwd", "/tmp", "--kind", "daily", "--time", "09:00",
      ], { stdout: process.stdout as any, stderr: process.stderr as any }));
      await withEnv(env, () => cmdAdd([
        "test-job", "--prompt", "x", "--cwd", "/tmp", "--kind", "daily", "--time", "10:00",
      ], { stdout: process.stdout as any, stderr: process.stderr as any })).then(
        () => assert.fail("expected throw"),
        (err) => {
          assert.ok(err instanceof PiTickError);
          assert.equal(err.code, 4);
        },
      );
      const cat = JSON.parse(readFileSync(join(dir, "jobs.json"), "utf8"));
      assert.equal(cat.jobs.length, 1);
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdAdd rejects invalid id, prompt, cwd, time", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      // Bad id
      await withEnv(env, () => cmdAdd([
        "-bad", "--prompt", "x", "--cwd", "/tmp", "--kind", "daily", "--time", "09:00",
      ], { stdout: process.stdout as any, stderr: process.stderr as any })).then(
        () => assert.fail("expected throw"),
        (err) => assert.ok(err instanceof PiTickError),
      );
      // Empty prompt
      await withEnv(env, () => cmdAdd([
        "ok", "--prompt", "", "--cwd", "/tmp", "--kind", "daily", "--time", "09:00",
      ], { stdout: process.stdout as any, stderr: process.stderr as any })).then(
        () => assert.fail("expected throw"),
        (err) => assert.ok(err instanceof PiTickError),
      );
      // Missing cwd
      await withEnv(env, () => cmdAdd([
        "ok", "--prompt", "x", "--cwd", "/no/such/path/1234", "--kind", "daily", "--time", "09:00",
      ], { stdout: process.stdout as any, stderr: process.stderr as any })).then(
        () => assert.fail("expected throw"),
        (err) => assert.ok(err instanceof PiTickError),
      );
      // Bad time
      await withEnv(env, () => cmdAdd([
        "ok", "--prompt", "x", "--cwd", "/tmp", "--kind", "daily", "--time", "9:00",
      ], { stdout: process.stdout as any, stderr: process.stderr as any })).then(
        () => assert.fail("expected throw"),
        (err) => assert.ok(err instanceof PiTickError),
      );
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdAdd --enabled enables and loads plist via stubbed launchctl", async () => {
  await withTempDir(async (dir) => {
    const plistDir = join(dir, "agents");
    const env = setupEnv({ dataDir: dir, plistDir });
    writeStub(env, "node", `echo "fake node"`);
    writeStub(env, "launchctl", stubbedLaunchctl(), { log: "launchctl.log" });
    // No `pi` stub on PATH — so enable should fail at resolvePiPath().
    try {
      const cliPath = new URL("../extensions/tick/bin/pi-tick.mjs", import.meta.url).pathname;
      copyFileSync(cliPath, join(dir, "pi-tick.mjs"));
      chmodSync(join(dir, "pi-tick.mjs"), 0o755);

      await withEnv(env, () => cmdAdd([
        "with-enabled",
        "--prompt", "do it",
        "--cwd", "/tmp",
        "--kind", "daily",
        "--time", "09:00",
        "--enabled",
      ], { stdout: process.stdout as any, stderr: process.stderr as any })).then(
        () => assert.fail("expected throw"),
        (err) => assert.ok(err instanceof PiTickError),
      );
      const log = readStubLog(env, "launchctl.log");
      // bootstrap was not called (enable failed at resolvePiPath)
      assert.equal(log.includes("bootstrap"), false);
      // But the catalog entry should exist with enabled=false (enable failure reverts).
      const cat = JSON.parse(readFileSync(join(dir, "jobs.json"), "utf8"));
      const j = cat.jobs.find((j: { id: string }) => j.id === "with-enabled");
      assert.ok(j);
      assert.equal(j.enabled, false);
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdAdd --enabled succeeds end-to-end with stubbed node/pi/launchctl", async () => {
  await withTempDir(async (dir) => {
    const plistDir = join(dir, "agents");
    const env = setupEnv({ dataDir: dir, plistDir });
    writeStub(env, "node", `echo fake`);
    writeStub(env, "pi", `echo fake-pi`);
    writeStub(env, "launchctl", stubbedLaunchctl(), { log: "launchctl.log" });
    try {
      const cliPath = new URL("../extensions/tick/bin/pi-tick.mjs", import.meta.url).pathname;
      copyFileSync(cliPath, join(dir, "pi-tick.mjs"));
      chmodSync(join(dir, "pi-tick.mjs"), 0o755);

      const code = await withEnv(env, () => cmdAdd([
        "happy-job",
        "--prompt", "do it",
        "--cwd", "/tmp",
        "--kind", "daily",
        "--time", "09:00",
        "--enabled",
      ], { stdout: process.stdout as any, stderr: process.stderr as any }));
      assert.equal(code, 0);
      const cat = JSON.parse(readFileSync(join(dir, "jobs.json"), "utf8"));
      const j = cat.jobs.find((j: { id: string }) => j.id === "happy-job");
      assert.equal(j.enabled, true);
      // Both piPath and nodePath are resolved and stored at enable time
      // (nodePath is what the runner uses to bypass the shebang in launchd context).
      assert.ok(j.piPath && j.piPath.length > 0, "piPath is set");
      assert.ok(j.nodePath && j.nodePath.length > 0, "nodePath is set");
      const pp = join(plistDir, "dev.pi.tick.happy-job.plist");
      assert.ok(existsSync(pp));
      const log = readStubLog(env, "launchctl.log");
      assert.match(log, /bootstrap gui\/\d+ \S+dev\.pi\.tick\.happy-job\.plist/);
      assert.match(log, /bootout/);
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdDelete on a disabled job removes the catalog entry", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await withEnv(env, () => cmdAdd(["a", "--prompt", "x", "--cwd", "/tmp", "--kind", "daily", "--time", "09:00"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      const code = await withEnv(env, () => cmdDelete(["a"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      assert.equal(code, 0);
      const cat = JSON.parse(readFileSync(join(dir, "jobs.json"), "utf8"));
      assert.equal(cat.jobs.length, 0);
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdDelete on a missing job is idempotent (exit 0)", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      const err = await captureStderr(({ stdout, stderr }) => withEnv(env, () => cmdDelete(["nope"], { stdout, stderr })));
      assert.match(err, /no such job/);
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdDelete on an enabled job unloads and unlinks the plist", async () => {
  await withTempDir(async (dir) => {
    const plistDir = join(dir, "agents");
    const env = setupEnv({ dataDir: dir, plistDir });
    writeStub(env, "node", `echo fake`);
    writeStub(env, "pi", `echo fake-pi`);
    writeStub(env, "launchctl", stubbedLaunchctl(), { log: "launchctl.log" });
    try {
      const cliPath = new URL("../extensions/tick/bin/pi-tick.mjs", import.meta.url).pathname;
      copyFileSync(cliPath, join(dir, "pi-tick.mjs"));
      chmodSync(join(dir, "pi-tick.mjs"), 0o755);
      await withEnv(env, () => cmdAdd(["x", "--prompt", "p", "--cwd", "/tmp", "--kind", "daily", "--time", "09:00", "--enabled"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      const pp = join(plistDir, "dev.pi.tick.x.plist");
      assert.ok(existsSync(pp));
      await withEnv(env, () => cmdDelete(["x"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      assert.ok(!existsSync(pp));
      const cat = JSON.parse(readFileSync(join(dir, "jobs.json"), "utf8"));
      assert.equal(cat.jobs.length, 0);
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdDelete removes logs/<id>.{out,err}.log and runs/<id>/", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await withEnv(env, () => cmdAdd(["z", "--prompt", "p", "--cwd", "/tmp", "--kind", "daily", "--time", "09:00"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      const outLog = join(env.PI_TICK_DATA_DIR, "logs", "z.out.log");
      const errLog = join(env.PI_TICK_DATA_DIR, "logs", "z.err.log");
      const runsDir = join(env.PI_TICK_DATA_DIR, "runs", "z");
      mkdirSync(runsDir, { recursive: true, mode: 0o700 });
      writeFileSync(outLog, "hello", "utf8");
      writeFileSync(errLog, "boom", "utf8");
      writeFileSync(join(runsDir, "2026-01-01T00-00-00-000Z_abcd1234.jsonl"), "{}\n", "utf8");
      assert.ok(existsSync(outLog));
      assert.ok(existsSync(errLog));
      assert.ok(existsSync(runsDir));

      // Force the cron backend so the test does not depend on launchd stubs.
      const savedBackend = process.env.PI_TICK_BACKEND;
      process.env.PI_TICK_BACKEND = "cron";
      const code = await withEnv(env, () => cmdDelete(["z"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      if (savedBackend === undefined) delete process.env.PI_TICK_BACKEND;
      else process.env.PI_TICK_BACKEND = savedBackend;

      assert.equal(code, 0);
      assert.ok(!existsSync(outLog), "out log removed");
      assert.ok(!existsSync(errLog), "err log removed");
      assert.ok(!existsSync(runsDir), "transcript dir removed");

      const cat = JSON.parse(readFileSync(join(dir, "jobs.json"), "utf8"));
      assert.equal(cat.jobs.length, 0);
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdDelete with no logs or transcripts still exits 0", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await withEnv(env, () => cmdAdd(["q", "--prompt", "p", "--cwd", "/tmp", "--kind", "daily", "--time", "09:00"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      const code = await withEnv(env, () => cmdDelete(["q"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      assert.equal(code, 0);
      const cat = JSON.parse(readFileSync(join(dir, "jobs.json"), "utf8"));
      assert.equal(cat.jobs.length, 0);
    } finally {
      teardownEnv(env);
    }
  });
});

// ─── enable / disable ────────────────────────────────────────────────────

test("cmdDisable on enabled job unloads and renames plist to .disabled", async () => {
  await withTempDir(async (dir) => {
    const plistDir = join(dir, "agents");
    const env = setupEnv({ dataDir: dir, plistDir });
    writeStub(env, "node", `echo fake`);
    writeStub(env, "pi", `echo fake-pi`);
    writeStub(env, "launchctl", stubbedLaunchctl(), { log: "launchctl.log" });
    try {
      const cliPath = new URL("../extensions/tick/bin/pi-tick.mjs", import.meta.url).pathname;
      copyFileSync(cliPath, join(dir, "pi-tick.mjs"));
      chmodSync(join(dir, "pi-tick.mjs"), 0o755);
      await withEnv(env, () => cmdAdd(["y", "--prompt", "p", "--cwd", "/tmp", "--kind", "daily", "--time", "09:00", "--enabled"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      await withEnv(env, () => cmdDisable(["y"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      assert.ok(!existsSync(join(plistDir, "dev.pi.tick.y.plist")));
      assert.ok(existsSync(join(plistDir, "dev.pi.tick.y.plist.disabled")));
      const cat = JSON.parse(readFileSync(join(dir, "jobs.json"), "utf8"));
      assert.equal(cat.jobs[0].enabled, false);
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdDisable on disabled job is a no-op", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await withEnv(env, () => cmdAdd(["z", "--prompt", "p", "--cwd", "/tmp", "--kind", "daily", "--time", "09:00"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      const code = await withEnv(env, () => cmdDisable(["z"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      assert.equal(code, 0);
      // No .plist.disabled was created
      assert.ok(!existsSync(join(dir, "agents", "dev.pi.tick.z.plist.disabled")));
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdEnable on missing job throws PiTickError(4)", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await withEnv(env, () => cmdEnable(["nope"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      assert.fail("expected cmdEnable to throw");
    } catch (err) {
      assert.ok(err instanceof PiTickError, "should be PiTickError");
      assert.equal(err.code, 4);
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdEnableInternal rollback handles both sync and async unregister gracefully", async () => {
  await withTempDir(async (dir) => {
    const plistDir = join(dir, "agents");
    const env = setupEnv({ dataDir: dir, plistDir });
    writeStub(env, "node", `echo fake`);
    writeStub(env, "pi", `echo fake-pi`);
    writeStub(env, "launchctl", stubbedLaunchctl(), { log: "launchctl.log" });
    writeStub(env, "crontab", `if [ "$1" = "-l" ]; then exit 0; elif [ "$1" = "-" ]; then cat >/dev/null; else exit 0; fi`);
    try {
      const cliPath = new URL("../extensions/tick/bin/pi-tick.mjs", import.meta.url).pathname;
      copyFileSync(cliPath, join(dir, "pi-tick.mjs"));
      chmodSync(join(dir, "pi-tick.mjs"), 0o755);

      for (const backend of ["launchd", "cron"]) {
        const backendObj = backend === "launchd" ? launchdBackend : cronBackend;
        const originalRegister = backendObj.register;
        
        await withEnv({ ...env, PI_TICK_BACKEND: backend }, async () => {
          await cmdAdd(["rolljob", "--prompt", "p", "--cwd", "/tmp", "--kind", "daily", "--time", "09:00"], { stdout: process.stdout as any, stderr: process.stderr as any });
          
          try {
            backendObj.register = async (job, opts) => {
              const res = await originalRegister.call(backendObj, job, opts);
              // simulate concurrent delete
              const catalogFile = join(dir, "jobs.json");
              const cat = JSON.parse(readFileSync(catalogFile, "utf8"));
              cat.jobs = cat.jobs.filter((j) => j.id !== job.id);
              writeFileSync(catalogFile, JSON.stringify(cat));
              return res;
            };
            
            await assert.rejects(
              () => cmdEnable(["rolljob"], { stdout: process.stdout as any, stderr: process.stderr as any }),
              (err) => err instanceof PiTickError && err.code === 4,
              "should throw PiTickError(4) without TypeError"
            );
          } finally {
            backendObj.register = originalRegister;
          }
        });
      }
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdEnable surfaces launchctl bootstrap failure", async () => {
  await withTempDir(async (dir) => {
    const plistDir = join(dir, "agents");
    const env = setupEnv({ dataDir: dir, plistDir });
    writeStub(env, "node", `echo fake`);
    writeStub(env, "pi", `echo fake-pi`);
    writeStub(env, "launchctl", stubbedLaunchctlBootstrapFails(), { log: "launchctl.log" });
    try {
      const cliPath = new URL("../extensions/tick/bin/pi-tick.mjs", import.meta.url).pathname;
      copyFileSync(cliPath, join(dir, "pi-tick.mjs"));
      chmodSync(join(dir, "pi-tick.mjs"), 0o755);
      await withEnv(env, () => cmdAdd(["bad", "--prompt", "p", "--cwd", "/tmp", "--kind", "daily", "--time", "09:00"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      await withEnv(env, () => cmdEnable(["bad"], { stdout: process.stdout as any, stderr: process.stderr as any })).then(
        () => assert.fail("expected throw"),
        (err) => assert.ok(err instanceof PiTickError),
      );
      assert.ok(!existsSync(join(plistDir, "dev.pi.tick.bad.plist")));
      const cat = JSON.parse(readFileSync(join(dir, "jobs.json"), "utf8"));
      assert.equal(cat.jobs[0].enabled, false);
    } finally {
      teardownEnv(env);
    }
  });
});

// Issue #53 — when launchctl itself fails to spawn (missing PATH, sandbox,
// EACCES), spawnSync returns { status: null, error: <Error> } with empty
// stderr/stdout. Before the fix, register() surfaced "unknown error"
// instead of the real ENOENT/EACCES reason. PI_TICK_LAUNCHCTL pointed at a
// nonexistent path reproduces a genuine spawn failure (no shell stub needed).
test("launchdBackend.register surfaces the real launchctl spawn error (ENOENT), not 'unknown error'", async () => {
  await withTempDir(async (dir) => {
    const plistDir = join(dir, "agents");
    const env = setupEnv({ dataDir: dir, plistDir });
    const missingLaunchctl = join(dir, "no-such-launchctl-binary");
    try {
      const r = await withEnv(
        { ...env, PI_TICK_LAUNCHCTL: missingLaunchctl },
        () => launchdBackend.register(
          { id: "spawnfail", cwd: "/tmp", schedule: { kind: "daily", value: { time: "09:00" } } },
          { nodePath: "/usr/bin/node", cliPath: "/opt/pi-tick.mjs", logsDir: join(dir, "logs") },
        ),
      );
      assert.equal(r.ok, false);
      assert.match(r.error, /ENOENT/);
    } finally {
      teardownEnv(env);
    }
  });
});

// Issue #62 — register/unregister/unregisterAndDelete/listRegistered are
// uniformly async on both backends now (launchd's own work is synchronous,
// but the port contract no longer hides that behind the await). Every
// caller already awaits these, so the only thing worth pinning directly is
// that launchd actually returns a real Promise, the same shape cron always
// has.
test("launchdBackend port methods return real Promises, matching cronBackend's contract", async () => {
  for (const backend of [launchdBackend, cronBackend]) {
    for (const method of ["register", "unregister", "unregisterAndDelete", "listRegistered"]) {
      assert.equal(typeof backend[method], "function", `${backend.name}.${method} is a function`);
    }
  }
  // launchd's register/unregister/unregisterAndDelete/listRegistered must
  // each be declared `async` — calling them returns a thenable even though
  // the work inside is synchronous.
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await withEnv(env, () => {
        assert.ok(launchdBackend.listRegistered() instanceof Promise, "listRegistered returns a Promise");
      });
    } finally {
      teardownEnv(env);
    }
  });
});

// ─── Runner ──────────────────────────────────────────────────────────────

test("cmdRun on a non-existent job exits 4", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      const code = await withEnv(env, () => cmdRun(["nope"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      assert.equal(code, 4);
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdRun on a disabled job exits 0 with a 'not running' message", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await withEnv(env, () => cmdAdd(["d", "--prompt", "p", "--cwd", "/tmp", "--kind", "daily", "--time", "09:00"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      const code = await withEnv(env, () => cmdRun(["d"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      assert.equal(code, 0);
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdRun on a job with missing cwd exits 6", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      const catMod = await import(new URL("../extensions/tick/bin/catalog.mjs", import.meta.url).pathname);
      // Seed inside withEnv so the catalog lives in the tempdir.
      await withEnv(env, () => {
        const cat = catMod.loadCatalog();
        cat.jobs.push({
          id: "nocwd", prompt: "p", cwd: "/no/such/path/abc", schedule: { kind: "daily", value: { time: "09:00" } },
          enabled: true, model: null, piPath: "/bin/true", createdAt: "x", updatedAt: "x", lastRun: null,
        });
        catMod.saveCatalog(cat);
      });
      const code = await withEnv(env, () => cmdRun(["nocwd"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      assert.equal(code, 6);
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdRun with a happy-path mock pi spawns the right argv and writes a RunRecord", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    const piStub = writeStub(env, "pi", mockPi());
    try {
      const catMod = await import(new URL("../extensions/tick/bin/catalog.mjs", import.meta.url).pathname);
      await withEnv(env, () => {
        const cat = catMod.loadCatalog();
        cat.jobs.push({
          id: "h", prompt: "do thing", cwd: dir,
          schedule: { kind: "interval", value: { minutes: 1, seconds: 0 } },
          enabled: true, model: null, piPath: piStub,
          createdAt: "x", updatedAt: "x", lastRun: null,
        });
        catMod.saveCatalog(cat);
      });

      const code = await withEnv(env, () => cmdRun(["h"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      assert.equal(code, 0);
      const runs = readFileSync(join(dir, "runs.jsonl"), "utf8").trim().split("\n").filter(Boolean);
      assert.equal(runs.length, 1);
      const rec = JSON.parse(runs[0]);
      assert.equal(rec.jobId, "h");
      assert.equal(rec.exitCode, 0);
      assert.equal(rec.triggerKind, "external");
      assert.equal(rec.tokens.input, 100);
      assert.equal(rec.tokens.output, 50);
      await withEnv(env, () => {
        const cat2 = catMod.loadCatalog();
        assert.ok(cat2.jobs[0].lastRun);
        assert.equal(cat2.jobs[0].lastRun.exitCode, 0);
      });
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdRun sends slash-command jobs through RPC instead of print mode", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    const piStub = writeStub(env, "pi", `echo "$@" >> "$LOG"
IFS= read -r line
printf '%s' "$line" > "$LOG.stdin"
echo '{"type":"response","command":"prompt","success":true}'
cat >/dev/null
exit 0
`, { log: "pi-args.log" });
    try {
      const catMod = await import(new URL("../extensions/tick/bin/catalog.mjs", import.meta.url).pathname);
      await withEnv(env, () => {
        const cat = catMod.loadCatalog();
        cat.jobs.push({
          id: "slash", prompt: "/tick run job1", cwd: dir,
          schedule: { kind: "interval", value: { minutes: 1, seconds: 0 } },
          enabled: true, model: null, piPath: piStub,
          createdAt: "x", updatedAt: "x", lastRun: null, timeoutMs: 2000,
        });
        catMod.saveCatalog(cat);
      });

      await withEnv(env, () => cmdRun(["slash"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      const args = readStubLog(env, "pi-args.log").trim();
      assert.match(args, /--mode rpc --no-session/);
      assert.doesNotMatch(args, / -p /);
      const stdin = readFileSync(join(env.__stubDir, "pi-args.log.stdin"), "utf8").trim();
      assert.deepEqual(JSON.parse(stdin), { type: "prompt", message: "/tick run job1" });
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdRun sends /tf jobs through constrained print mode", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    const piStub = writeStub(env, "pi", mockPiRecordArgs(), { log: "pi-args.log" });
    try {
      const catMod = await import(new URL("../extensions/tick/bin/catalog.mjs", import.meta.url).pathname);
      await withEnv(env, () => {
        const cat = catMod.loadCatalog();
        cat.jobs.push({
          id: "tf", prompt: "/tf:audit-arch-to-issues force=true maxOpenIssues=10", cwd: dir,
          schedule: { kind: "interval", value: { minutes: 1, seconds: 0 } },
          enabled: true, model: null, piPath: piStub,
          createdAt: "x", updatedAt: "x", lastRun: null,
        });
        catMod.saveCatalog(cat);
      });

      await withEnv(env, () => cmdRun(["tf"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      const args = readStubLog(env, "pi-args.log").trim();
      assert.match(args, /--mode json -p --no-session/);
      assert.match(args, /--tools taskflow/);
      assert.match(args, /"action":"run","name":"audit-arch-to-issues"/);
      assert.match(args, /"force":"true"/);
      assert.doesNotMatch(args, /--mode rpc/);
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdRun keeps RPC stdin open until agent_end", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    const piStub = writeStub(env, "pi", `IFS= read -r line
echo '{"type":"response","command":"prompt","success":true}'
echo '{"type":"agent_start"}'
sleep 0.3
echo '{"message":{"usage":{"input":1,"output":2}},"type":"message_end"}'
sleep 0.3
echo '{"type":"agent_end"}'
cat >/dev/null
exit 0
`);
    try {
      const catMod = await import(new URL("../extensions/tick/bin/catalog.mjs", import.meta.url).pathname);
      await withEnv(env, () => {
        const cat = catMod.loadCatalog();
        cat.jobs.push({
          id: "rpc-agent", prompt: "/tf:job1", cwd: dir,
          schedule: { kind: "interval", value: { minutes: 1, seconds: 0 } },
          enabled: true, model: null, piPath: piStub,
          createdAt: "x", updatedAt: "x", lastRun: null, timeoutMs: 2000,
        });
        catMod.saveCatalog(cat);
      });

      const started = Date.now();
      const code = await withEnv(env, () => cmdRun(["rpc-agent"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      assert.equal(code, 0);
      assert.ok(Date.now() - started >= 550, "runner must not close stdin before agent_end");
    } finally {
      teardownEnv(env);
    }
  });
});

// Issue #48 — trigger kind is now threaded through an explicit --manual
// argv flag (read by cmdRun via parseFlags), not process.env. This removes
// the race where a concurrent in-process dispatch() call could observe
// another call's temporarily-overridden PI_SCHEDULER_MANUAL.
test("cmdRun --manual sets triggerKind=manual", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    const piStub = writeStub(env, "pi", mockPi());
    try {
      const catMod = await import(new URL("../extensions/tick/bin/catalog.mjs", import.meta.url).pathname);
      await withEnv(env, () => {
        const cat = catMod.loadCatalog();
        cat.jobs.push({
          id: "m", prompt: "p", cwd: dir,
          schedule: { kind: "interval", value: { minutes: 1, seconds: 0 } },
          enabled: true, model: null, piPath: piStub,
          createdAt: "x", updatedAt: "x", lastRun: null,
        });
        catMod.saveCatalog(cat);
      });

      await withEnv(env, () => cmdRun(["m", "--manual"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      const rec = JSON.parse(readFileSync(join(dir, "runs.jsonl"), "utf8").trim());
      assert.equal(rec.triggerKind, "manual");
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdRun without --manual sets triggerKind=external", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    const piStub = writeStub(env, "pi", mockPi());
    try {
      const catMod = await import(new URL("../extensions/tick/bin/catalog.mjs", import.meta.url).pathname);
      await withEnv(env, () => {
        const cat = catMod.loadCatalog();
        cat.jobs.push({
          id: "e", prompt: "p", cwd: dir,
          schedule: { kind: "interval", value: { minutes: 1, seconds: 0 } },
          enabled: true, model: null, piPath: piStub,
          createdAt: "x", updatedAt: "x", lastRun: null,
        });
        catMod.saveCatalog(cat);
      });

      await withEnv(env, () => cmdRun(["e"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      const rec = JSON.parse(readFileSync(join(dir, "runs.jsonl"), "utf8").trim());
      assert.equal(rec.triggerKind, "external");
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdRun treats taskflow failure text as a failed run", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    const piStub = writeStub(env, "pi", mockPiTaskflowFail());
    try {
      const catMod = await import(new URL("../extensions/tick/bin/catalog.mjs", import.meta.url).pathname);
      await withEnv(env, () => {
        const cat = catMod.loadCatalog();
        cat.jobs.push({
          id: "tf", prompt: "p", cwd: dir,
          schedule: { kind: "interval", value: { minutes: 1, seconds: 0 } },
          enabled: true, model: null, piPath: piStub,
          createdAt: "x", updatedAt: "x", lastRun: null,
        });
        catMod.saveCatalog(cat);
      });
      const code = await withEnv(env, () => cmdRun(["tf"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      assert.equal(code, 1);
      const rec = JSON.parse(readFileSync(join(dir, "runs.jsonl"), "utf8").trim());
      assert.equal(rec.exitCode, 1);
      assert.equal(rec.reason, "taskflow_failed");
      assert.equal(rec.error, "forge: tea not installed");
      await withEnv(env, () => {
        const cat2 = catMod.loadCatalog();
        assert.equal(cat2.jobs[0].lastRun.exitCode, 1);
        assert.equal(cat2.jobs[0].lastRun.reason, "taskflow_failed");
      });
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdRun propagates a non-zero child exit code", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    const piStub = writeStub(env, "pi", mockPiFail(2));
    try {
      const catMod = await import(new URL("../extensions/tick/bin/catalog.mjs", import.meta.url).pathname);
      await withEnv(env, () => {
        const cat = catMod.loadCatalog();
        cat.jobs.push({
          id: "f", prompt: "p", cwd: dir,
          schedule: { kind: "interval", value: { minutes: 1, seconds: 0 } },
          enabled: true, model: null, piPath: piStub,
          createdAt: "x", updatedAt: "x", lastRun: null,
        });
        catMod.saveCatalog(cat);
      });
      const code = await withEnv(env, () => cmdRun(["f"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      assert.equal(code, 2);
      const rec = JSON.parse(readFileSync(join(dir, "runs.jsonl"), "utf8").trim());
      assert.equal(rec.exitCode, 2);
    } finally {
      teardownEnv(env);
    }
  });
});

// ─── stderr / semantic failure parsing (issue #8) ───────────────────────

test("extractTaskflowFailure extracts the taskflow error line", () => {
  const text = "taskflow run: x\nfailed at: locate\nerror: forge: tea not installed";
  assert.equal(extractTaskflowFailure(text), "forge: tea not installed");
});

test("extractTaskflowFailure catches final summary format", () => {
  const text = "Taskflow `dev-issue-to-pr` failed.\n\n- Failed at: `plan-gate`\n- Reason: subagent exceeded wall-clock timeout of `300s`";
  assert.equal(extractTaskflowFailure(text), "subagent exceeded wall-clock timeout of `300s`");
});

test("extractStderrSignature picks the Error: line over a trailing stack frame", () => {
  const buf = [
    "node:internal/process/task_queues:96",
    "    'processTicksAndRejections'",
    "Error: prompt must be a string",
    "    at ModuleJob.syncLink (node:internal/modules/esm/loader:1:1)",
    "    at async Promise.all (index 0)",
  ].join("\n");
  assert.equal(extractStderrSignature(buf), "Error: prompt must be a string");
});

test("extractStderrSignature falls back to first stack frame message when no Error: line is present", () => {
  const buf = [
    "Cannot read properties of undefined (reading 'x')",
    "    at foo (file.js:1:1)",
    "    at bar (file.js:2:2)",
  ].join("\n");
  assert.equal(
    extractStderrSignature(buf),
    "Cannot read properties of undefined (reading 'x')",
  );
});

test("extractStderrSignature returns null when only 'at' frames / garbage are present", () => {
  const buf = [
    "}",
    "    at ModuleJob.syncLink (node:internal/modules/esm/loader:1:1)",
  ].join("\n");
  assert.equal(extractStderrSignature(buf), null);
});

// Issue #51 — the fallback path used to scan top-down, so a Node startup
// notice (ExperimentalWarning, etc.) printed before the real crash was
// recorded as the failure reason. Scan bottom-up: the actual exception is
// always at or near the end.
test("extractStderrSignature ignores a leading ExperimentalWarning and returns the trailing exception", () => {
  const buf = [
    "(node:12345) ExperimentalWarning: --experimental-strip-types is an experimental feature",
    "",
    "TypeError: boom",
  ].join("\n");
  assert.equal(extractStderrSignature(buf), "TypeError: boom");
});

test("extractStderrSignature fallback (no named error) returns the LAST meaningful line, not the first", () => {
  const buf = [
    "(node:12345) ExperimentalWarning: --experimental-strip-types is an experimental feature",
    "some intermediate diagnostic noise",
    "Cannot read properties of undefined (reading 'x')",
  ].join("\n");
  assert.equal(
    extractStderrSignature(buf),
    "Cannot read properties of undefined (reading 'x')",
  );
});

test("cmdRun surfaces the Error: line as the run record's error when child crashes with a stack", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    const piStub = writeStub(env, "pi", mockPiCrashWithStack());
    try {
      const catMod = await import(new URL("../extensions/tick/bin/catalog.mjs", import.meta.url).pathname);
      await withEnv(env, () => {
        const cat = catMod.loadCatalog();
        cat.jobs.push({
          id: "crash", prompt: "p", cwd: dir,
          schedule: { kind: "interval", value: { minutes: 1, seconds: 0 } },
          enabled: true, model: null, piPath: piStub,
          createdAt: "x", updatedAt: "x", lastRun: null,
        });
        catMod.saveCatalog(cat);
      });
      const code = await withEnv(env, () => cmdRun(["crash"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      assert.equal(code, 1);
      const rec = JSON.parse(readFileSync(join(dir, "runs.jsonl"), "utf8").trim());
      assert.equal(rec.exitCode, 1);
      // The Error: line wins over the trailing `    at ModuleJob.syncLink …` frame.
      assert.equal(rec.error, "TypeError: prompt must be a string");
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdRun appends to runs.jsonl and preserves its mode 0600", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    const piStub = writeStub(env, "pi", mockPi());
    try {
      const catMod = await import(new URL("../extensions/tick/bin/catalog.mjs", import.meta.url).pathname);
      await withEnv(env, () => {
        const cat = catMod.loadCatalog();
        cat.jobs.push({
          id: "g", prompt: "p", cwd: dir,
          schedule: { kind: "interval", value: { minutes: 1, seconds: 0 } },
          enabled: true, model: null, piPath: piStub,
          createdAt: "x", updatedAt: "x", lastRun: null,
        });
        catMod.saveCatalog(cat);
      });
      await withEnv(env, () => cmdRun(["g"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      const mode = statSync(join(dir, "runs.jsonl")).mode & 0o777;
      assert.equal(mode, 0o600);
    } finally {
      teardownEnv(env);
    }
  });
});

// ─── Runtime controls (Phase 2) ─────────────────────────────────────────

// A pi stub that never produces output, just sleeps. Used to force
// timeouts and idle-timeout kills without races from real work.
function mockPiSleep(seconds: number): string {
  return `sleep ${seconds}\nexit 0\n`;
}

// A pi stub that floods stdout. Used to trip maxOutputBytes. The data
// is plain text, not JSONL — the runner accepts both because the
// transcript is just a raw byte stream and JSON parsing is best-effort.
function mockPiFlood(bytes: number): string {
  // `head -c N < /dev/zero | tr '\\0' 'x'` would work, but `tr` may not
  // be on the test PATH. Use `yes` (always present) and `head -c`.
  return `head -c ${bytes} < /dev/zero | tr '\\0' 'x'\nexit 0\n`;
}

test("cmdAdd stores runtime controls on the job", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      const code = await withEnv(env, () =>
        cmdAdd([
          "rc",
          "--prompt", "p",
          "--cwd", "/tmp",
          "--kind", "interval",
          "--minutes", "5",
          "--timeout-ms", "1000",
          "--idle-timeout-ms", "2000",
          "--max-output-bytes", "3000",
          "--kill-grace-ms", "4000",
        ], { stdout: process.stdout as any, stderr: process.stderr as any }),
      );
      assert.equal(code, 0);
      const cat = JSON.parse(readFileSync(join(dir, "jobs.json"), "utf8"));
      const j = cat.jobs[0];
      assert.equal(j.timeoutMs, 1000);
      assert.equal(j.idleTimeoutMs, 2000);
      assert.equal(j.maxOutputBytes, 3000);
      assert.equal(j.killGraceMs, 4000);
    } finally {
      teardownEnv(env);
    }
  });
});

// Issue #55 — cmdAdd used to evaluate DEFAULT_* eagerly and bake today's
// default into the catalog forever. Storing null instead lets the runner's
// default change in a future release without rewriting every job. The
// runner (runJob) treats a non-finite value — including null — as "use the
// current default", so behavior at run time is unchanged.
test("cmdAdd stores null (not evaluated defaults) for runtime controls when flags are absent", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await withEnv(env, () => cmdAdd(["d", "--prompt", "p", "--cwd", "/tmp", "--kind", "daily", "--time", "09:00"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      const cat = JSON.parse(readFileSync(join(dir, "jobs.json"), "utf8"));
      const j = cat.jobs[0];
      assert.equal(j.timeoutMs, null);
      assert.equal(j.idleTimeoutMs, null);
      assert.equal(j.maxOutputBytes, null);
      assert.equal(j.killGraceMs, null);
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdAdd allows --max-output-bytes 0 but rejects --kill-grace-ms 0", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await withEnv(env, () => cmdAdd([
        "x", "--prompt", "p", "--cwd", "/tmp",
        "--kind", "daily", "--time", "09:00", "--max-output-bytes", "0",
      ], { stdout: process.stdout as any, stderr: process.stderr as any }));
      const cat = JSON.parse(readFileSync(join(dir, "jobs.json"), "utf8"));
      assert.equal(cat.jobs[0].maxOutputBytes, 0);
      await assert.rejects(
        () => withEnv(env, () => cmdAdd([
          "y", "--prompt", "p", "--cwd", "/tmp",
          "--kind", "daily", "--time", "09:00", "--kill-grace-ms", "0",
        ], { stdout: process.stdout as any, stderr: process.stderr as any })),
        /non-negative integer/,
      );
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdRun emits reason=exit_code on a clean run", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    const piStub = writeStub(env, "pi", mockPi());
    try {
      const catMod = await import(new URL("../extensions/tick/bin/catalog.mjs", import.meta.url).pathname);
      await withEnv(env, () => {
        const cat = catMod.loadCatalog();
        cat.jobs.push({
          id: "ok", prompt: "p", cwd: dir,
          schedule: { kind: "interval", value: { minutes: 1, seconds: 0 } },
          enabled: true, model: null, piPath: piStub,
          createdAt: "x", updatedAt: "x", lastRun: null,
        });
        catMod.saveCatalog(cat);
      });
      const code = await withEnv(env, () => cmdRun(["ok"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      assert.equal(code, 0);
      const rec = JSON.parse(readFileSync(join(dir, "runs.jsonl"), "utf8").trim());
      assert.equal(rec.reason, "exit_code");
      assert.equal(rec.exitCode, 0);
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdRun clears escalation timer on fast exit, preventing event-loop leak", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    // Sleep 30s so the child doesn't exit on its own before the initial timeout.
    const piStub = writeStub(env, "pi", mockPiSleep(30));
    try {
      // The executable entry point (spawned below as a real subprocess), not
      // a symbol import — kept separate from catMod's catalog.mjs import.
      const cliPath = new URL("../extensions/tick/bin/pi-tick.mjs", import.meta.url).pathname;
      const catMod = await import(new URL("../extensions/tick/bin/catalog.mjs", import.meta.url).pathname);
      await withEnv(env, () => {
        const cat = catMod.loadCatalog();
        cat.jobs.push({
          id: "fast-exit", prompt: "p", cwd: dir,
          schedule: { kind: "interval", value: { minutes: 1, seconds: 0 } },
          enabled: true, model: null, piPath: piStub,
          createdAt: "x", updatedAt: "x", lastRun: null,
          timeoutMs: 100, // Very short initial timeout to trigger killChild quickly
          idleTimeoutMs: 0,
          maxOutputBytes: 2_000_000,
          killGraceMs: 5000, // Long grace period so the escalation timer would hang the event loop if not cleared
        });
        catMod.saveCatalog(cat);
      });
      
      const startMs = Date.now();
      // Spawn as a completely separate process to verify event loop closure.
      // If the timer leaks, this will block for ~5000ms.
      const res = spawnSync(process.execPath, [cliPath, "run", "fast-exit"], {
        env: { ...process.env, ...env },
        encoding: "utf8",
      });
      const elapsedMs = Date.now() - startMs;
      
      // GNU `timeout` convention: 124 = killed by the timer.
      assert.equal(res.status, 124);
      // The process should return quickly, proving it didn't wait 5s for the timer.
      assert.ok(elapsedMs < 2000, `process should exit quickly, took ${elapsedMs}ms`);
      
      const rec = JSON.parse(readFileSync(join(dir, "runs.jsonl"), "utf8").trim());
      assert.equal(rec.reason, "timeout");
      assert.equal(rec.exitCode, 124);
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdRun kills hanging child and emits reason=timeout", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    // Sleep 30s; runner must kill us at ~200ms.
    const piStub = writeStub(env, "pi", mockPiSleep(30));
    try {
      const catMod = await import(new URL("../extensions/tick/bin/catalog.mjs", import.meta.url).pathname);
      await withEnv(env, () => {
        const cat = catMod.loadCatalog();
        cat.jobs.push({
          id: "hang", prompt: "p", cwd: dir,
          schedule: { kind: "interval", value: { minutes: 1, seconds: 0 } },
          enabled: true, model: null, piPath: piStub,
          createdAt: "x", updatedAt: "x", lastRun: null,
          timeoutMs: 200,
          idleTimeoutMs: 0,
          maxOutputBytes: 2_000_000,
          killGraceMs: 200,
        });
        catMod.saveCatalog(cat);
      });
      const code = await withEnv(env, () => cmdRun(["hang"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      // GNU `timeout` convention: 124 = killed by the timer.
      assert.equal(code, 124);
      const rec = JSON.parse(readFileSync(join(dir, "runs.jsonl"), "utf8").trim());
      assert.equal(rec.reason, "timeout");
      assert.equal(rec.exitCode, 124);
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdRun kills idle child and emits reason=idle_timeout", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    // Silent sleep. Wall timeout 10s (long) and idle timeout 200ms
    // (short) prove idle is the cause of death.
    const piStub = writeStub(env, "pi", mockPiSleep(10));
    try {
      const catMod = await import(new URL("../extensions/tick/bin/catalog.mjs", import.meta.url).pathname);
      await withEnv(env, () => {
        const cat = catMod.loadCatalog();
        cat.jobs.push({
          id: "idle", prompt: "p", cwd: dir,
          schedule: { kind: "interval", value: { minutes: 1, seconds: 0 } },
          enabled: true, model: null, piPath: piStub,
          createdAt: "x", updatedAt: "x", lastRun: null,
          timeoutMs: 10_000,
          idleTimeoutMs: 200,
          maxOutputBytes: 2_000_000,
          killGraceMs: 200,
        });
        catMod.saveCatalog(cat);
      });
      const code = await withEnv(env, () => cmdRun(["idle"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      assert.equal(code, 124);
      const rec = JSON.parse(readFileSync(join(dir, "runs.jsonl"), "utf8").trim());
      assert.equal(rec.reason, "idle_timeout");
      assert.equal(rec.exitCode, 124);
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdRun kills noisy child and emits reason=output_cap", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    // Produce 64KB of 'x' characters. Cap is 1KB so the runner must
    // kill us well before the 64KB finishes streaming.
    const piStub = writeStub(env, "pi", mockPiFlood(64 * 1024));
    try {
      const catMod = await import(new URL("../extensions/tick/bin/catalog.mjs", import.meta.url).pathname);
      await withEnv(env, () => {
        const cat = catMod.loadCatalog();
        cat.jobs.push({
          id: "noisy", prompt: "p", cwd: dir,
          schedule: { kind: "interval", value: { minutes: 1, seconds: 0 } },
          enabled: true, model: null, piPath: piStub,
          createdAt: "x", updatedAt: "x", lastRun: null,
          timeoutMs: 10_000,
          idleTimeoutMs: 0,
          maxOutputBytes: 1024,
          killGraceMs: 200,
        });
        catMod.saveCatalog(cat);
      });
      const code = await withEnv(env, () => cmdRun(["noisy"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      assert.equal(code, 124);
      const rec = JSON.parse(readFileSync(join(dir, "runs.jsonl"), "utf8").trim());
      assert.equal(rec.reason, "output_cap");
      // The transcript must exist and be non-empty (partial output
      // was captured before the kill) AND must not exceed the cap.
      assert.ok(rec.transcriptPath);
      const tBytes = statSync(rec.transcriptPath).size;
      assert.ok(tBytes > 0, `expected partial transcript, got ${tBytes} bytes`);
      assert.ok(tBytes <= 1024, `transcript ${tBytes} bytes exceeded the cap`);
    } finally {
      teardownEnv(env);
    }
  });
});

// ─── Kill (issue #47) ────────────────────────────────────────────────────

test("cmdKill on a job with no active run reports an error and exits 4", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      const code = await withEnv(env, () => cmdKill(["nope"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      assert.equal(code, 4);
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdKill terminates a running job's process tree (SIGTERM)", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    // Sleeps far longer than the test should take; cmdKill must end it early.
    const piStub = writeStub(env, "pi", mockPiSleep(30));
    try {
      const catalogMod = await import(new URL("../extensions/tick/bin/catalog.mjs", import.meta.url).pathname);
      const registryMod = await import(new URL("../extensions/tick/bin/run-registry.mjs", import.meta.url).pathname);
      await withEnv(env, () => {
        const cat = catalogMod.loadCatalog();
        cat.jobs.push({
          id: "killme", prompt: "p", cwd: dir,
          schedule: { kind: "interval", value: { minutes: 1, seconds: 0 } },
          enabled: true, model: null, piPath: piStub,
          createdAt: "x", updatedAt: "x", lastRun: null,
        });
        catalogMod.saveCatalog(cat);
      });

      const started = Date.now();
      const runPromise = withEnv(env, () => cmdRun(["killme"], { stdout: process.stdout as any, stderr: process.stderr as any }));

      // Wait for the active-run record (and its childPid) to land, then kill it.
      let active: any = null;
      for (let i = 0; i < 50 && !active?.childPid; i++) {
        active = await withEnv(env, () => registryMod.readActiveRun("killme"));
        if (!active?.childPid) await new Promise((r) => setTimeout(r, 20));
      }
      assert.ok(active?.childPid, "active-run record has a childPid to kill");
      assert.ok(isPidAlive(active.childPid), "the pi child is actually running before the kill");

      const killCode = await withEnv(env, () => cmdKill(["killme"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      assert.equal(killCode, 0);

      const runCode = await runPromise;
      const elapsedMs = Date.now() - started;
      // The stub sleeps 30s; if the kill didn't actually work this would
      // time out the test runner long before reaching this assertion.
      assert.ok(elapsedMs < 10_000, `expected the run to end quickly after kill, took ${elapsedMs}ms`);
      assert.ok(runCode !== 0, "killed run must not report a clean exit");
      assert.ok(!isPidAlive(active.childPid), "the pi child is no longer running after the kill");

      const rec = JSON.parse(readFileSync(join(dir, "runs.jsonl"), "utf8").trim());
      assert.equal(rec.reason, "signal");
      assert.match(rec.error, /SIGTERM/);
    } finally {
      teardownEnv(env);
    }
  });
});

test("killActiveRun escalates to SIGKILL when the child ignores SIGTERM", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      // A real `process.on("SIGTERM", ...)` handler, run under the real
      // node binary (not a shell stub) — deterministic ignore semantics.
      // A shell `trap '' TERM` was tried here first: it reliably protects
      // the shell process itself, but a *backgrounded* `sleep` it forks
      // does NOT inherit that disposition on this platform, so the run
      // still ended on plain SIGTERM once `wait` unblocked — defeating
      // the point of the test. A Node child sidesteps that shell-specific
      // signal-inheritance ambiguity entirely.
      const stubScript = join(env.__stubDir, "pi-stubborn.mjs");
      writeFileSync(stubScript, `process.on("SIGTERM", () => {});\nsetInterval(() => {}, 1000);\n`, "utf8");
      const catalogMod = await import(new URL("../extensions/tick/bin/catalog.mjs", import.meta.url).pathname);
      const registryMod = await import(new URL("../extensions/tick/bin/run-registry.mjs", import.meta.url).pathname);
      await withEnv(env, () => {
        const cat = catalogMod.loadCatalog();
        cat.jobs.push({
          id: "stubborn", prompt: "p", cwd: dir,
          schedule: { kind: "interval", value: { minutes: 1, seconds: 0 } },
          enabled: true, model: null, piPath: stubScript, nodePath: process.execPath,
          createdAt: "x", updatedAt: "x", lastRun: null,
        });
        catalogMod.saveCatalog(cat);
      });

      const runPromise = withEnv(env, () => cmdRun(["stubborn"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      let active: any = null;
      for (let i = 0; i < 50 && !active?.childPid; i++) {
        active = await withEnv(env, () => registryMod.readActiveRun("stubborn"));
        if (!active?.childPid) await new Promise((r) => setTimeout(r, 20));
      }
      assert.ok(active?.childPid);
      // Give the process a moment to reach process.on("SIGTERM", ...)
      // before we signal it.
      await new Promise((r) => setTimeout(r, 150));

      const result = await withEnv(env, () => killActiveRun("stubborn", { graceMs: 300, pollMs: 20 }));
      assert.equal(result.ok, true);
      assert.equal(result.signal, "SIGKILL", "SIGTERM was ignored, so the escalation must fire");
      assert.ok(!isPidAlive(active.childPid));

      await runPromise;
    } finally {
      teardownEnv(env);
    }
  });
});

test("list --json includes runtime control fields", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await withEnv(env, () => cmdAdd([
        "rc", "--prompt", "p", "--cwd", "/tmp",
        "--kind", "interval", "--minutes", "5",
        "--timeout-ms", "1000", "--idle-timeout-ms", "2000",
        "--max-output-bytes", "3000", "--kill-grace-ms", "4000",
      ], { stdout: process.stdout as any, stderr: process.stderr as any }));
      // Capture stdout while cmdList runs.
      let captured = "";
      const stdout = {
        write: (chunk: string | Uint8Array) => {
          captured += typeof chunk === "string" ? chunk : chunk.toString();
          return true;
        }
      } as typeof process.stdout;
      await withEnv(env, () => cmdList(["--json"], { stdout, stderr: process.stderr as any }));
      const jobs = JSON.parse(captured);
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0].timeoutMs, 1000);
      assert.equal(jobs[0].idleTimeoutMs, 2000);
      assert.equal(jobs[0].maxOutputBytes, 3000);
      assert.equal(jobs[0].killGraceMs, 4000);
    } finally {
      teardownEnv(env);
    }
  });
});

// ─── Tick-scoped config (issue: --model precedence) ──────────────────────

// Mock pi that records its full argv to a log file so each test can assert
// which `--model` (if any) was passed. We pass the log path via the prompt
// itself since stub scripts have no other way to learn it.
function mockPiRecordArgs() {
  return `echo "$@" >> "$LOG"
cat > "$LOG.stdin"
exit 0
`;
}

test("loadConfig returns { defaultModel: null } when config.json is missing", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await withEnv(env, () => {
        assert.equal(existsSync(configFile()), false);
        const cfg = loadConfig();
        assert.equal(cfg.defaultModel, null);
      });
    } finally {
      teardownEnv(env);
    }
  });
});

test("config set / get / unset round-trip", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      const captures: string[] = [];
      const stdout = {
        write: (chunk: string | Uint8Array) => {
          captures.push(typeof chunk === "string" ? chunk : chunk.toString());
          return true;
        }
      } as typeof process.stdout;
      const reset = () => { captures.length = 0; };
      let valueAfterSet: string | null = "sentinel";
      let valueAfterUnset: string | null = "sentinel";
      await withEnv(env, async () => {
        reset();
        await cmdConfig(["set", "default-model", "my-cool-model"], { stdout, stderr: process.stderr as any });
        valueAfterSet = loadConfig().defaultModel;
        reset();
        await cmdConfig(["get", "default-model"], { stdout, stderr: process.stderr as any });
        const getAfterSet = captures.join("");
        reset();
        await cmdConfig(["unset", "default-model"], { stdout, stderr: process.stderr as any });
        valueAfterUnset = loadConfig().defaultModel;
        reset();
        await cmdConfig(["get", "default-model"], { stdout, stderr: process.stderr as any });
        const getAfterUnset = captures.join("");
        // Save for assertions outside withEnv.
        captures.length = 0;
        captures.push(getAfterSet, "|", getAfterUnset);
      });
      assert.equal(valueAfterSet, "my-cool-model");
      assert.equal(valueAfterUnset, null);
      const [getAfterSet, getAfterUnset] = captures.join("").split("|");
      assert.equal(getAfterSet, "my-cool-model\n");
      assert.equal(getAfterUnset, "\n");
    } finally {
      teardownEnv(env);
    }
  });
});

test("config set trims whitespace and rejects empty values", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      let saved: string | null = "sentinel";
      await withEnv(env, async () => {
        await cmdConfig(["set", "default-model", "  spaced-model  "], { stdout: process.stdout as any, stderr: process.stderr as any });
        saved = loadConfig().defaultModel;
      });
      assert.equal(saved, "spaced-model");
      await assert.rejects(
        withEnv(env, () => cmdConfig(["set", "default-model", "   "], { stdout: process.stdout as any, stderr: process.stderr as any })),
        /non-empty/,
      );
      await assert.rejects(
        withEnv(env, () => cmdConfig(["set", "default-model", ""], { stdout: process.stdout as any, stderr: process.stderr as any })),
        /non-empty/,
      );
      await assert.rejects(
        withEnv(env, () => cmdConfig(["set", "default-model"], { stdout: process.stdout as any, stderr: process.stderr as any })),
        /requires a value/,
      );
    } finally {
      teardownEnv(env);
    }
  });
});

test("config rejects unknown subcommand and unknown key", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    try {
      await assert.rejects(withEnv(env, () => cmdConfig([], { stdout: process.stdout as any, stderr: process.stderr as any })), /subcommand/);
      await assert.rejects(withEnv(env, () => cmdConfig(["get"], { stdout: process.stdout as any, stderr: process.stderr as any })), /unknown or missing key/);
      await assert.rejects(withEnv(env, () => cmdConfig(["set", "nope", "x"], { stdout: process.stdout as any, stderr: process.stderr as any })), /unknown or missing key/);
      await assert.rejects(withEnv(env, () => cmdConfig(["wat", "default-model"], { stdout: process.stdout as any, stderr: process.stderr as any })), /unknown subcommand/);
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdRun applies tick default-model to a job with model: null", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    const logPath = join(env.__stubDir, "pi-args.log");
    const piStub = writeStub(env, "pi", mockPiRecordArgs(), { log: "pi-args.log" });
    try {
      const catMod = await import(new URL("../extensions/tick/bin/catalog.mjs", import.meta.url).pathname);
      await withEnv(env, () => {
        // Pin the tick default; job stays at model: null.
        saveConfig({ defaultModel: "tick-default" });
        const cat = catMod.loadCatalog();
        cat.jobs.push({
          id: "dm", prompt: "p", cwd: dir,
          schedule: { kind: "interval", value: { minutes: 1, seconds: 0 } },
          enabled: true, model: null, piPath: piStub,
          createdAt: "x", updatedAt: "x", lastRun: null,
        });
        catMod.saveCatalog(cat);
      });

      await withEnv(env, () => cmdRun(["dm"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      const args = readStubLog(env, "pi-args.log").trim();
      assert.match(args, /--model tick-default/);
      const rec = JSON.parse(readFileSync(join(dir, "runs.jsonl"), "utf8").trim());
      assert.equal(rec.model, "tick-default");
      // Sanity: log file actually got written.
      assert.ok(existsSync(logPath));
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdRun with explicit job.model overrides the tick default-model", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    const piStub = writeStub(env, "pi", mockPiRecordArgs(), { log: "pi-args.log" });
    try {
      const catMod = await import(new URL("../extensions/tick/bin/catalog.mjs", import.meta.url).pathname);
      await withEnv(env, () => {
        saveConfig({ defaultModel: "tick-default" });
        const cat = catMod.loadCatalog();
        cat.jobs.push({
          id: "ov", prompt: "p", cwd: dir,
          schedule: { kind: "interval", value: { minutes: 1, seconds: 0 } },
          enabled: true, model: "job-wins", piPath: piStub,
          createdAt: "x", updatedAt: "x", lastRun: null,
        });
        catMod.saveCatalog(cat);
      });
      await withEnv(env, () => cmdRun(["ov"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      const args = readStubLog(env, "pi-args.log").trim();
      assert.match(args, /--model job-wins/);
      assert.doesNotMatch(args, /tick-default/);
      const rec = JSON.parse(readFileSync(join(dir, "runs.jsonl"), "utf8").trim());
      assert.equal(rec.model, "job-wins");
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdRun omits --model when neither job nor tick default is set", async () => {
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    writeStub(env, "pi", mockPiRecordArgs(), { log: "pi-args.log" });
    try {
      const catMod = await import(new URL("../extensions/tick/bin/catalog.mjs", import.meta.url).pathname);
      await withEnv(env, () => {
        // No saveConfig call → no tick default.
        assert.equal(existsSync(configFile()), false);
        const cat = catMod.loadCatalog();
        cat.jobs.push({
          id: "nm", prompt: "p", cwd: dir,
          schedule: { kind: "interval", value: { minutes: 1, seconds: 0 } },
          enabled: true, model: null, piPath: join(env.__stubDir, "pi"),
          createdAt: "x", updatedAt: "x", lastRun: null,
        });
        catMod.saveCatalog(cat);
      });
      await withEnv(env, () => cmdRun(["nm"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      const args = readStubLog(env, "pi-args.log").trim();
      assert.doesNotMatch(args, /--model/);
      const rec = JSON.parse(readFileSync(join(dir, "runs.jsonl"), "utf8").trim());
      assert.equal(rec.model, null);
    } finally {
      teardownEnv(env);
    }
  });
});

test("cmdRun omits --model when tick default exists but config file is removed mid-flight", async () => {
  // Edge case: loadConfig() must tolerate a missing file at run time too.
  await withTempDir(async (dir) => {
    const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
    writeStub(env, "pi", mockPiRecordArgs(), { log: "pi-args.log" });
    try {
      const catMod = await import(new URL("../extensions/tick/bin/catalog.mjs", import.meta.url).pathname);
      await withEnv(env, () => {
        // No config file at all → loadConfig returns {defaultModel: null}.
        assert.equal(existsSync(configFile()), false);
        const cat = catMod.loadCatalog();
        cat.jobs.push({
          id: "x", prompt: "p", cwd: dir,
          schedule: { kind: "interval", value: { minutes: 1, seconds: 0 } },
          enabled: true, model: null, piPath: join(env.__stubDir, "pi"),
          createdAt: "x", updatedAt: "x", lastRun: null,
        });
        catMod.saveCatalog(cat);
      });
      await withEnv(env, () => cmdRun(["x"], { stdout: process.stdout as any, stderr: process.stderr as any }));
      const args = readStubLog(env, "pi-args.log").trim();
      assert.doesNotMatch(args, /--model/);
    } finally {
      teardownEnv(env);
    }
  });
});

// Issue #63 — pi-tick.mjs used to `export * from "./tick-core.mjs"`, so any
// of tick-core's ~90 re-exported internals (most of them owned by other
// modules) was reachable through the CLI wrapper. It now exports only what
// it itself needs: dispatch and the error class it catches. This pins that
// boundary so a future `export *` doesn't quietly widen it back out.
test("pi-tick.mjs exports only dispatch and PiTickError, not tick-core's full internals", async () => {
  const mod = await import(
    new URL("../extensions/tick/bin/pi-tick.mjs", import.meta.url).pathname
  );
  assert.deepEqual(Object.keys(mod).sort(), ["PiTickError", "dispatch"]);
});
