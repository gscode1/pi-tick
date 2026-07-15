// commands/list.mjs — `pi-tick list [--json]`.

import { ensureDataDirs, loadCatalog } from "../catalog.mjs";
import { parseFlags } from "../argv.mjs";
import { fail } from "../errors.mjs";
import { getActiveRun } from "../run-registry.mjs";
import { formatLocal, durationSeconds } from "../format.mjs";
import { formatSchedule, formatNextFire, printTable } from "../display.mjs";

export function cmdList(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const flags = parseFlags(argv);
  const wantJson = flags.json === true || flags.json === "true";

  ensureDataDirs();
  let catalog;
  try {
    catalog = loadCatalog();
  } catch (err) {
    fail(`failed to read catalog: ${err.message}`, 1);
  }

  if (wantJson) {
    stdout.write(JSON.stringify(catalog.jobs, null, 2) + "\n");
    return 0;
  }

  if (catalog.jobs.length === 0) {
    stdout.write("(no jobs)\n");
    return 0;
  }

  // Header + rows.
  const headers = ["id", "enabled", "status", "kind", "schedule", "next-fire", "runner-finished", "runner-exit", "duration"];
  const rows = catalog.jobs.map((j) => {
    const active = getActiveRun(j.id);
    const enabled = j.enabled ? "yes" : "no";
    const status = active ? "running" : (j.enabled ? "scheduled" : "disabled");
    const sched = formatSchedule(j.schedule);
    const next = j.enabled ? formatLocal(formatNextFire(j.schedule)) : "--";
    const lastFinished = active ? "--" : (j.lastRun ? formatLocal(j.lastRun.finishedAt) : "never");
    const exit = active ? "--" : (j.lastRun ? String(j.lastRun.exitCode) : "--");
    const duration = active
      ? (active.startedAt ? `${durationSeconds(active.startedAt, new Date().toISOString())}s` : active.durationText || "--")
      : (j.lastRun ? `${durationSeconds(j.lastRun.startedAt, j.lastRun.finishedAt)}s` : "--");
    return [j.id, enabled, status, j.schedule.kind, sched, next, lastFinished, exit, duration];
  });

  printTable([headers, ...rows], { stdout });
  return 0;
}
