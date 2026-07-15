// commands/add.mjs — `pi-tick add <id> ...` and the tick intake it shares
// with the extension's `tick_create` LLM tool (extensions/tick/index.ts).
//
// createTick is the single place that validates, builds the schedule,
// persists to the catalog, and optionally enables a new tick. cmdAdd
// (CLI/argv) and tick_create both call it instead of each re-deriving the
// same logic — previously the tool serialized its typed params into argv
// strings, had the core re-parse them, then made a SECOND call
// (`list --json`) just to recover a job object cmdAdd already held in
// memory.

import { ensureDataDirs, loadCatalog, saveCatalog, findJob, withCatalogLock } from "../catalog.mjs";
import { parseFlags, flagString, flagOptionalU32 } from "../argv.mjs";
import { fail } from "../errors.mjs";
import { validateId, validatePrompt, validateCwd, buildSchedule, KIND_INTERVAL, KIND_DAILY, KIND_WEEKLY } from "../validate.mjs";
import { cmdEnableInternal } from "./enable.mjs";

// `scheduleOpts` is in the shape `buildSchedule` already consumes (the same
// shape `parseFlags` produces: minutes/seconds/"offset-minutes"/
// "offset-seconds"/time/days-as-comma-string) — cmdAdd passes its parsed
// `flags` straight through with zero conversion. Callers with a typed,
// camelCase scheduleValue (the tool) convert once via
// `scheduleOptsFromScheduleValue` below.
export function scheduleOptsFromScheduleValue(kind, scheduleValue) {
  const sv = scheduleValue ?? {};
  const opts = {};
  if (kind === KIND_INTERVAL) {
    if (sv.minutes != null) opts.minutes = sv.minutes;
    if (sv.seconds != null) opts.seconds = sv.seconds;
    if (sv.offsetMinutes != null) opts["offset-minutes"] = sv.offsetMinutes;
    if (sv.offsetSeconds != null) opts["offset-seconds"] = sv.offsetSeconds;
  } else if (kind === KIND_DAILY) {
    if (sv.time) opts.time = sv.time;
  } else if (kind === KIND_WEEKLY) {
    if (sv.time) opts.time = sv.time;
    if (Array.isArray(sv.days) && sv.days.length > 0) opts.days = sv.days.join(",");
  }
  return opts;
}

export async function createTick(params, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const id = String(params.jobId);
  validateId(id);
  const prompt = String(params.prompt);
  validatePrompt(prompt);
  const cwd = String(params.cwd);
  validateCwd(cwd);
  const kind = String(params.scheduleKind);
  const enabled = params.enabled === true;
  const model = params.model ? String(params.model) : null;

  // Runtime controls arrive as plain numbers here (CLI flags are parsed by
  // the caller, the tool's params are already numbers) — reuse
  // flagOptionalU32's validation via a synthetic flags-shaped object so
  // both paths enforce the same non-negative-integer contract.
  const rt = {
    "timeout-ms": params.timeoutMs,
    "idle-timeout-ms": params.idleTimeoutMs,
    "max-output-bytes": params.maxOutputBytes,
    "kill-grace-ms": params.killGraceMs,
  };
  const timeoutMs = flagOptionalU32(rt, "timeout-ms");
  const idleTimeoutMs = flagOptionalU32(rt, "idle-timeout-ms", { allowZero: true });
  const maxOutputBytes = flagOptionalU32(rt, "max-output-bytes", { allowZero: true });
  const killGraceMs = flagOptionalU32(rt, "kill-grace-ms", { allowZero: false });

  const schedule = buildSchedule(kind, params.scheduleOpts ?? {});

  // Cheap pre-check outside the lock so we don't acquire+release on a
  // fast-fail duplicate. We re-check under the lock below.
  ensureDataDirs();
  {
    const pre = loadCatalog();
    if (findJob(pre, id)) {
      fail(`job '${id}' already exists; use 'pi-tick delete' first`, 4);
    }
  }

  const now = new Date().toISOString();
  const job = {
    id,
    prompt,
    cwd,
    schedule,
    enabled: false,
    model,
    piPath: null,
    nodePath: null,
    createdAt: now,
    updatedAt: now,
    lastRun: null,
    // Runtime controls. `null` means "fall back to the runner's default";
    // storing null (rather than the resolved number) lets the runner's
    // default change in a future release without rewriting every job
    // (issue #55 — this used to evaluate DEFAULT_* eagerly at creation
    // time, baking today's default into the catalog forever).
    timeoutMs,
    idleTimeoutMs,
    maxOutputBytes,
    killGraceMs,
  };

  await withCatalogLock(async () => {
    const catalog = loadCatalog();
    // Re-check under the lock: another process may have raced between
    // the pre-check and the wrap.
    if (findJob(catalog, id)) {
      fail(`job '${id}' already exists; use 'pi-tick delete' first`, 4);
    }
    catalog.jobs.push(job);
    saveCatalog(catalog);
  });

  if (!enabled) {
    stdout.write(`added job '${id}' (disabled; use 'pi-tick enable ${id}' to schedule)\n`);
    return job;
  }

  // Lock is released by now. cmdEnableInternal re-acquires it on its own
  // when it runs; we must NOT call it inside the wrap above or it would
  // self-deadlock (EEXIST on the second acquire).
  await cmdEnableInternal(id, { skipCatalogExistsCheck: true, stdout, stderr });
  return findJob(loadCatalog(), id) || job;
}

export async function cmdAdd(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const flags = parseFlags(argv);
  const pos = flags._;
  if (pos.length < 1) fail(`add requires a job id`, 2);
  const id = pos[0];
  const prompt = flagString(flags, "prompt");
  const cwd = flagString(flags, "cwd");
  const kind = flagString(flags, "kind");
  const enabled = flags.enabled === true || flags.enabled === "true";
  const model = flags.model ? String(flags.model) : undefined;

  await createTick({
    jobId: id,
    prompt,
    cwd,
    scheduleKind: kind,
    scheduleOpts: flags,
    enabled,
    model,
    // Raw flag values (string, `true` for a bare flag, or undefined) —
    // createTick is the single place that runs them through
    // flagOptionalU32's validation, for both this CLI path and the tool.
    timeoutMs: flags["timeout-ms"],
    idleTimeoutMs: flags["idle-timeout-ms"],
    maxOutputBytes: flags["max-output-bytes"],
    killGraceMs: flags["kill-grace-ms"],
  }, { stdout, stderr });

  return 0;
}
