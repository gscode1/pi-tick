// commands/doctor.mjs — `pi-tick doctor [id] [--fix] [--json]` (issue #61).
//
// Finds enabled jobs that have silently stopped firing: the scheduler entry
// is gone, not loaded, or no longer what `enable` wrote; a path baked into
// it (node, the stable CLI, pi, cwd, --on-complete) no longer exists, e.g.
// after an nvm/mise node upgrade; or the last run is older than the
// previous expected fire; or the `--when` guard's last run failed
// (`guard_failed`: the guard crashed or timed out, so the agent never runs).
// A `skipped` run (guard exit 1) is a healthy fire. `--fix` re-registers jobs whose problems a fresh
// `enable` can repair (it re-resolves node and pi).
//
// diagnoseJob is also used by `list` (stale/overdue status) and by the
// extension's session_start notice (attentionSummary).

import { existsSync } from "node:fs";
import { ensureDataDirs, loadCatalog, findJob } from "../catalog.mjs";
import { parseFlags } from "../argv.mjs";
import { fail } from "../errors.mjs";
import { stableCliPath } from "../paths.mjs";
import { activeBackend } from "../backend-info.mjs";
import { getActiveRun } from "../run-registry.mjs";
import { previousFireAt, resolveScheduleFields, KIND_INTERVAL, KIND_ONCE } from "../schedule.mjs";
import { agentAdapter } from "../agents/index.mjs";
import { printTable } from "../display.mjs";
import { cmdEnableInternal } from "./enable.mjs";

// How late a fire may be before it counts as missed. Calendar jobs get a
// fixed window (launchd reruns a calendar fire missed during sleep on wake;
// cron does not, so a cron fire missed while asleep is reported). Interval
// jobs tolerate one missed fire. Plain launchd StartInterval jobs have no
// fixed phase, so they are overdue only when the last run is older than two
// intervals plus the grace.
export const CALENDAR_GRACE_MS = 10 * 60 * 1000;
const MIN_INTERVAL_GRACE_MS = 2 * 60 * 1000;
const UNCALIBRATED_GRACE_MS = 5 * 60 * 1000;

// Statuses, most severe first. `stale`: the scheduler won't run the job as
// registered. `overdue`: it should have run and didn't. `failing`: it ran
// and its last run failed.
export const STATUS_ORDER = ["stale", "overdue", "failing", "ok"];

function problem(code, message, { severity = "stale", fixable = false } = {}) {
  return { code, message, severity, fixable };
}

function ms(iso) {
  const t = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
}

function overdueProblem(job, now) {
  const baseline = Math.max(
    ms(job.lastRun?.startedAt) ?? 0,
    ms(job.registration?.registeredAt ?? job.updatedAt ?? job.createdAt) ?? 0,
  );
  const s = job.schedule;
  let grace = CALENDAR_GRACE_MS;
  if (s.kind === KIND_INTERVAL) {
    grace = Math.max(MIN_INTERVAL_GRACE_MS, resolveScheduleFields(s).totalSeconds * 1000);
  }
  const prev = previousFireAt(s, new Date(now.getTime() - grace));
  if (!prev.calibrated) {
    const period = resolveScheduleFields(s).totalSeconds * 1000;
    if (now.getTime() - baseline > 2 * period + UNCALIBRATED_GRACE_MS) {
      return problem("overdue", `no run since ${new Date(baseline).toISOString()} (every ${period / 1000}s)`, { severity: "overdue" });
    }
    return null;
  }
  const prevMs = ms(prev.at);
  if (prevMs !== null && prevMs > baseline) {
    const what = s.kind === KIND_ONCE ? "one-shot" : "expected fire";
    return problem("overdue", `missed ${what} at ${prev.at}`, { severity: "overdue" });
  }
  return null;
}

// Diagnose one job. `backend` and `now` are injectable for tests.
// Returns { id, enabled, running, status, problems }.
export function diagnoseJob(job, { backend = activeBackend(), now = new Date(), running } = {}) {
  const isRunning = running ?? Boolean(getActiveRun(job.id));
  const base = { id: job.id, enabled: Boolean(job.enabled), running: isRunning };
  if (!job.enabled) return { ...base, status: "ok", problems: [] };

  const problems = [];
  const reg = job.registration;
  if (reg?.backend && reg.backend !== backend.name) {
    problems.push(problem("backend-changed", `registered with ${reg.backend}, active backend is ${backend.name}`, { fixable: true }));
  }

  let st = null;
  if (typeof backend.status === "function") {
    try { st = backend.status(job.id); } catch (err) { st = { error: err.message }; }
  }
  if (st?.error) {
    problems.push(problem("backend-error", `${backend.name}: ${st.error}`));
  } else if (st && !st.registered) {
    problems.push(problem("not-registered", `no ${backend.name} entry`, { fixable: true }));
  } else if (st) {
    if (st.loaded === false) {
      problems.push(problem("not-loaded", `${backend.name} entry exists but is not loaded`, { fixable: true }));
    }
    if (reg?.fingerprint && st.fingerprint && reg.fingerprint !== st.fingerprint) {
      problems.push(problem("drift", `${backend.name} entry differs from what 'enable' registered`, { fixable: true }));
    }
  }

  // Paths: prefer what the scheduler entry actually contains.
  const nodePath = st?.paths?.nodePath ?? job.nodePath;
  if (nodePath && !existsSync(nodePath)) {
    problems.push(problem("missing-node", `node not found: ${nodePath}`, { fixable: true }));
  }
  const cliPath = st?.paths?.cliPath ?? stableCliPath();
  if (!existsSync(cliPath)) {
    problems.push(problem("missing-cli", `pi-tick CLI not found: ${cliPath} (open a pi session to sync it)`));
  }
  if (agentAdapter(job.agent).id === "pi" && job.piPath && !existsSync(job.piPath)) {
    problems.push(problem("missing-pi", `pi not found: ${job.piPath}`, { fixable: true }));
  }
  const cwd = st?.paths?.cwd ?? job.cwd;
  if (cwd && !existsSync(cwd)) {
    problems.push(problem("missing-cwd", `cwd not found: ${cwd}`));
  }
  if (job.onComplete && !existsSync(job.onComplete)) {
    problems.push(problem("missing-on-complete", `--on-complete not found: ${job.onComplete}`));
  }

  if (!isRunning) {
    const od = overdueProblem(job, now);
    if (od) problems.push(od);
    if (job.lastRun?.reason === "guard_failed") {
      problems.push(problem("guard-failed", `guard (--when) failed: ${job.lastRun.error || "unknown error"}; the agent did not run`, { severity: "failing" }));
    } else if (job.lastRun && job.lastRun.exitCode !== 0) {
      const why = job.lastRun.reason || job.lastRun.error || `exit ${job.lastRun.exitCode}`;
      problems.push(problem("failing", `last run failed: ${why}`, { severity: "failing" }));
    }
  }

  const status = STATUS_ORDER.find((s) => problems.some((p) => p.severity === s)) ?? "ok";
  return { ...base, status, problems };
}

export function diagnoseCatalog(catalog, opts = {}) {
  return catalog.jobs.filter((j) => j.enabled).map((j) => diagnoseJob(j, opts));
}

// For the extension's session_start notice. Never throws.
export function attentionSummary(opts = {}) {
  try {
    const results = diagnoseCatalog(loadCatalog(), opts).filter((r) => r.status !== "ok");
    return { count: results.length, ids: results.map((r) => r.id) };
  } catch {
    return { count: 0, ids: [] };
  }
}

async function fixJob(result) {
  const fixable = result.problems.filter((p) => p.fixable);
  const blocking = result.problems.filter((p) => p.severity === "stale" && !p.fixable);
  if (fixable.length === 0) return null;
  if (blocking.length > 0) {
    return `not re-registered: ${blocking.map((p) => p.message).join("; ")}`;
  }
  // Re-registering bootouts the service under launchd, which would SIGTERM the
  // in-flight run.
  if (getActiveRun(result.id)) return "running; retry later";
  const sink = { write: () => true };
  try {
    await cmdEnableInternal(result.id, { stdout: sink, stderr: sink });
    return "re-registered";
  } catch (err) {
    return `re-register failed: ${err && err.message ? err.message : err}`;
  }
}

export async function cmdDoctor(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const flags = parseFlags(argv);
  const wantJson = flags.json === true || flags.json === "true";
  const wantFix = flags.fix === true || flags.fix === "true";
  const id = flags._[0];

  ensureDataDirs();
  const load = () => {
    const catalog = loadCatalog();
    if (id === undefined) return catalog.jobs.filter((j) => j.enabled);
    const job = findJob(catalog, id);
    if (!job) fail(`no such job: ${id}`, 4);
    return [job];
  };

  let results = load().map((j) => diagnoseJob(j));
  const fixes = {};
  if (wantFix) {
    for (const r of results) {
      const outcome = await fixJob(r);
      if (outcome) fixes[r.id] = outcome;
    }
    if (Object.keys(fixes).length > 0) results = load().map((j) => diagnoseJob(j));
  }

  const unhealthy = results.filter((r) => r.enabled && r.status !== "ok");

  if (wantJson) {
    stdout.write(JSON.stringify(results.map((r) => ({ ...r, fix: fixes[r.id] ?? null })), null, 2) + "\n");
    return unhealthy.length > 0 ? 1 : 0;
  }

  if (results.length === 0) {
    stdout.write("(no enabled jobs)\n");
    return 0;
  }

  const rows = [];
  for (const r of results) {
    const status = !r.enabled ? "disabled" : r.running && r.status === "ok" ? "running" : r.status;
    const lines = r.problems.length ? r.problems.map((p) => p.message) : ["--"];
    if (fixes[r.id]) lines.push(`fix: ${fixes[r.id]}`);
    rows.push([r.id, status, lines[0]]);
    for (const extra of lines.slice(1)) rows.push(["", "", extra]);
  }
  printTable([["id", "status", "problems"], ...rows], { stdout });

  if (unhealthy.length === 0) {
    stdout.write(`\nall ${results.length} job(s) look healthy\n`);
    return 0;
  }
  const fixableLeft = unhealthy.some((r) => r.problems.some((p) => p.fixable));
  stdout.write(`\n${unhealthy.length} job(s) need attention${fixableLeft && !wantFix ? "; run 'pi-tick doctor --fix' to re-register" : ""}\n`);
  return 1;
}
