/**
 * pi-tick — Persistent scheduled agent tasks for Pi on macOS.
 *
 * Architecture: the programmatic core (catalog, run controllers, validation,
 * formatters, dispatcher) lives in `bin/tick-core.mjs` and is shared by both
 * this extension and the thin `bin/pi-tick.mjs` CLI wrapper. This file:
 *
 *  1. On session_start, syncs the bundled `bin/pi-tick.mjs` + `bin/tick-core.mjs`
 *     to `~/.pi/agent/tick/` so launchd plists reference a stable CLI path.
 *  2. Registers the `/tick` slash command: list, run, kill, enable, disable,
 *     delete, log, show.
 *  3. Registers the LLM-callable tools `tick_create`, `tick_list`, `tick_delete`.
 *
 * Operations call the core's `dispatch()` IN-PROCESS via `runCli` — no
 * subprocess spawn, no console-output parsing. The stable CLI copy exists only
 * for launchd/cron, which invoke pi-tick as a subprocess on their own schedule.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { dirname, join } from "node:path";
import {
  access,
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { dataDir } from "./bin/paths.mjs";
// The reusable core. The extension calls its dispatcher IN-PROCESS for
// list/run/delete/log/show — no subprocess, no console-output parsing. The
// stable CLI copy (still synced below) is only for launchd/cron, which spawn it.
import { dispatch } from "./bin/tick-core.mjs";
import { createTick, scheduleOptsFromScheduleValue } from "./bin/commands/add.mjs";
// The bundle manifest: every .mjs file under bin/ that the standalone CLI's
// import closure needs installed alongside it. Derived by walking bin/, not
// hand-listed — see bundle.mjs for why (issue #60).
import { listBundleFiles, bundledPath, installedPath } from "./bundle.mjs";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

let syncOneFileTmpCounter = 0;

async function syncOneFile(src: string, dest: string, mode: number): Promise<boolean> {
  if (!(await exists(src))) return false;
  let needsWrite = true;
  if (await exists(dest)) {
    try {
      const a = await readFile(src);
      const b = await readFile(dest);
      if (a.equals(b)) needsWrite = false;
    } catch { /* fall through */ }
  }
  if (needsWrite) {
    await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
    // Write to a sibling temp file then rename over the destination
    // (issue #49). Two session_start syncs racing on the same dest used
    // to both copyFile() directly, and a process reading mid-write could
    // see a torn/truncated file. rename() on the same filesystem is
    // atomic, so concurrent syncs now see either the old or new file,
    // never a partial one.
    const tmp = `${dest}.${process.pid}.${syncOneFileTmpCounter++}.tmp`;
    const data = await readFile(src);
    const fh = await open(tmp, "w", mode);
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      await rename(tmp, dest);
    } catch (err) {
      try { await unlink(tmp); } catch { /* best effort cleanup */ }
      throw err;
    }
  }
  try { await chmod(dest, mode); } catch { /* best effort */ }
  return needsWrite;
}

// ─── runCli ──────────────────────────────────────────────────────────────

export type CliResult = {
  stdout: string;
  stderr: string;
  code: number;
};

async function runCli(
  _pi: ExtensionAPI,
  args: string[],
): Promise<CliResult> {
  // Call the core dispatcher IN-PROCESS. We capture stdout/stderr via minimal
  // writable shims, so the returned shape is identical to the old subprocess
  // path (same argv parsing, same formatters) — but with no node startup and
  // no spawn. This is the whole point of the refactor: ~200ms saved per call.
  //
  // Issue #48 — this used to also mutate process.env for the duration of the
  // call (e.g. PI_SCHEDULER_MANUAL=1) and restore it in `finally`. Because
  // dispatch is async, that left a window where any concurrent in-process
  // task could observe the override. Anything a command needs to know
  // (e.g. manual vs scheduled trigger) is now passed as an explicit argv
  // flag instead — no global state crosses the seam.
  let stdout = "";
  let stderr = "";
  const sink = (append: (s: string) => void) => ({
    write: (chunk: string | Uint8Array) => {
      append(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    },
  });
  const out = sink((s) => { stdout += s; });
  const err = sink((s) => { stderr += s; });

  try {
    const code = await dispatch(args, { stdout: out, stderr: err });
    return { stdout, stderr, code: typeof code === "number" ? code : 0 };
  } catch (e: any) {
    // The CLI wrapper maps a thrown PiTickError to a `pi-tick: <msg>` line plus
    // its exit code; mirror that so callers see the same stderr/code they used
    // to get from the subprocess.
    const msg = e && e.message ? e.message : String(e);
    stderr += `pi-tick: ${msg}\n`;
    return { stdout, stderr, code: typeof e?.code === "number" ? e.code : 1 };
  }
}

// A writable-stream shim that discards everything written to it. Passed to
// createTick() below so its (CLI-oriented) status messages don't leak to
// the real process.stdout/stderr when called from an LLM tool — the tool
// reports its own result from createTick's return value instead.
const silentSink = { write: (_chunk: string | Uint8Array) => true };

// ─── Sync (session_start) ────────────────────────────────────────────────

async function syncBundledCli(): Promise<{ ok: boolean; reason?: string }> {
  // The manifest is derived by walking bin/ (issue #60) — every .mjs file
  // there, including bin/backends/*.mjs, is part of tick-core.mjs's static
  // import closure and must be installed alongside the stable CLI or a
  // launchd/cron-spawned `pi-tick run <id>` fails to load.
  const files = listBundleFiles();
  if (!files.includes("pi-tick.mjs")) {
    return { ok: false, reason: `bundled CLI not found under ${bundledPath("")}` };
  }
  await mkdir(dataDir(), { recursive: true, mode: 0o700 });

  for (const rel of files) {
    // pi-tick.mjs is the executable entry point; every sibling module is
    // imported, never executed directly.
    const mode = rel === "pi-tick.mjs" ? 0o755 : 0o644;
    await syncOneFile(bundledPath(rel), installedPath(rel), mode);
  }
  return { ok: true };
}

async function ensureLogsDir(): Promise<void> {
  const d = join(dataDir(), "logs");
  await mkdir(d, { recursive: true, mode: 0o700 });
  try { await chmod(d, 0o700); } catch { /* best effort */ }
}

// ─── Slash commands ──────────────────────────────────────────────────────

// Top-level subcommands under /tick. Used for completions and dispatch.
const TICK_SUBCOMMANDS = ["list", "run", "kill", "enable", "disable", "delete", "log", "show"] as const;
type TickSubcommand = (typeof TICK_SUBCOMMANDS)[number];

function parseTickArgs(raw: string): { sub: TickSubcommand | null; rest: string[] } {
  const trimmed = raw.trim();
  if (trimmed === "") return { sub: null, rest: [] };
  const parts = trimmed.split(/\s+/);
  const first = parts[0];
  if ((TICK_SUBCOMMANDS as readonly string[]).includes(first)) {
    return { sub: first as TickSubcommand, rest: parts.slice(1) };
  }
  return { sub: null, rest: parts };
}

async function getJobIds(pi: ExtensionAPI): Promise<string[]> {
  const res = await runCli(pi, ["list", "--json"]);
  if (res.code !== 0) return [];
  try {
    const jobs = JSON.parse(res.stdout) as Array<{ id: string }>;
    return jobs.map((j) => j.id);
  } catch {
    return [];
  }
}

let initPromise: Promise<void> | null = null;

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    if (!initPromise) {
      initPromise = (async () => {
        try {
          const sync = await syncBundledCli();
          if (!sync.ok) {
            ctx.ui.notify(`pi-tick: ${sync.reason}`, "warning");
          }
        } catch (err) {
          ctx.ui.notify(`pi-tick: sync failed: ${err}`, "warning");
        }

        // Decoupled: always attempt to ensure logs dir even if sync fails
        try {
          await ensureLogsDir();
        } catch (err) {
          ctx.ui.notify(`pi-tick: logs dir failed: ${err}`, "warning");
        }
      })();
    }
    await initPromise;
  });

  // ── Slash command: /tick <subcommand> [args] ────────────────────────────
  pi.registerCommand("tick", {
    description: "Manage scheduled agent tasks: list, run <id>, kill <id>, enable <id>, disable <id>, delete <id>",
    getArgumentCompletions: async (prefix) => {
      // /tick <prefix>
      const args = parseTickArgs(prefix);
      if (args.sub === null) {
        // Completing the subcommand itself.
        const filtered = TICK_SUBCOMMANDS.filter((s) => s.startsWith(prefix.trim()));
        return filtered.length > 0
          ? filtered.map((s) => ({ value: s, label: s }))
          : null;
      }
      // Subcommand given — complete based on its shape.
      if (args.sub === "list") return [];
      // run/delete/log/show <id>
      const ids = await getJobIds(pi);
      const lastToken = args.rest[args.rest.length - 1] ?? "";
      const filtered = ids.filter((id) => id.startsWith(lastToken));
      return filtered.length > 0
        ? filtered.map((id) => ({ value: id, label: id }))
        : null;
    },
    handler: async (args, ctx) => {
      const parsed = parseTickArgs(args);
      if (parsed.sub === null) {
        if (args.trim() === "") {
          ctx.ui.notify("Usage: /tick <list|run <id>|kill <id>|enable <id>|disable <id>|delete <id>|log [id]|show <id>>", "info");
          return;
        }
        ctx.ui.notify(`pi-tick: unknown subcommand: ${parsed.rest[0] ?? ""}`, "error");
        return;
      }
      if (parsed.sub === "list") {
        const res = await runCli(pi, ["list"]);
        if (res.code !== 0) {
          ctx.ui.notify(`pi-tick list failed: ${res.stderr.trim() || `exit ${res.code}`}`, "error");
          return;
        }
        const out = res.stdout.trim() || "(no jobs)";
        ctx.ui.notify(out, "info");
        return;
      }
      if (parsed.sub === "run") {
        const id = parsed.rest[0];
        if (!id) {
          ctx.ui.notify("Usage: /tick run <id>", "error");
          return;
        }
        ctx.ui.notify(`Running job '${id}'…`, "info");
        const res = await runCli(pi, ["run", id, "--manual"]);
        if (res.code !== 0) {
          ctx.ui.notify(`pi-tick run ${id} failed: ${res.stderr.trim() || `exit ${res.code}`}`, "error");
          return;
        }
        ctx.ui.notify(`Job '${id}' finished (exit ${res.code})`, "info");
        return;
      }
      if (parsed.sub === "kill") {
        const id = parsed.rest[0];
        if (!id) {
          ctx.ui.notify("Usage: /tick kill <id>", "error");
          return;
        }
        const res = await runCli(pi, ["kill", id]);
        if (res.code !== 0) {
          ctx.ui.notify(`pi-tick kill ${id} failed: ${res.stderr.trim() || `exit ${res.code}`}`, "error");
          return;
        }
        ctx.ui.notify(res.stdout.trim() || `killed job '${id}'`, "info");
        return;
      }
      if (parsed.sub === "enable") {
        const id = parsed.rest[0];
        if (!id) {
          ctx.ui.notify("Usage: /tick enable <id>", "error");
          return;
        }
        const res = await runCli(pi, ["enable", id]);
        if (res.code !== 0) {
          ctx.ui.notify(`pi-tick enable ${id} failed: ${res.stderr.trim() || `exit ${res.code}`}`, "error");
          return;
        }
        ctx.ui.notify(res.stdout.trim() || `enabled job '${id}'`, "info");
        return;
      }
      if (parsed.sub === "disable") {
        const id = parsed.rest[0];
        if (!id) {
          ctx.ui.notify("Usage: /tick disable <id>", "error");
          return;
        }
        const res = await runCli(pi, ["disable", id]);
        if (res.code !== 0) {
          ctx.ui.notify(`pi-tick disable ${id} failed: ${res.stderr.trim() || `exit ${res.code}`}`, "error");
          return;
        }
        ctx.ui.notify(res.stdout.trim() || `disabled job '${id}'`, "info");
        return;
      }
      if (parsed.sub === "delete") {
        const id = parsed.rest[0];
        if (!id) {
          ctx.ui.notify("Usage: /tick delete <id>", "error");
          return;
        }
        const res = await runCli(pi, ["delete", id]);
        if (res.code !== 0) {
          ctx.ui.notify(`pi-tick delete ${id} failed: ${res.stderr.trim() || `exit ${res.code}`}`, "error");
          return;
        }
        ctx.ui.notify(res.stdout.trim() || `deleted job '${id}'`, "info");
        return;
      }
      if (parsed.sub === "show" && !parsed.rest[0]) {
        ctx.ui.notify("Usage: /tick show <jobId> [--run-id <runId>|--run N] [--tail N]\nExample: /tick log\nExample: /tick show model-check-1\nExample: /tick show model-check-1 --run-id 4d7c8aef", "info");
        return;
      }
      if (parsed.sub === "log" || parsed.sub === "show") {
        const res = await runCli(pi, [parsed.sub, ...parsed.rest]);
        if (res.code !== 0) {
          ctx.ui.notify(`pi-tick ${parsed.sub} failed: ${res.stderr.trim() || `exit ${res.code}`}`, "error");
          return;
        }
        ctx.ui.notify(res.stdout.trim() || "(no output)", "info");
        return;
      }
    },
  });

  // ── LLM tool: tick_create ───────────────────────────────────────────────
  pi.registerTool({
    name: "tick_create",
    label: "Create Scheduled Job",
    description:
      "Create a scheduled agent job. The job is disabled by default; pass enabled=true to also register a launchd plist in the same call.",
    promptSnippet: "Schedule a prompt to run on a recurring schedule (daily/weekly/interval).",
    promptGuidelines: [
      "Use tick_create to schedule a recurring prompt. Pass enabled=true to also enable scheduling; otherwise the job is a draft and must be enabled separately via the CLI.",
      "Use tick_list to inspect existing jobs before creating a new one with the same id.",
    ],
    parameters: Type.Object({
      jobId: Type.String({ description: "Job id; matches /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/" }),
      prompt: Type.String({ description: "The prompt to run on each fire (≤ 16KB)" }),
      cwd: Type.String({ description: "Absolute path to the working directory" }),
      scheduleKind: StringEnum(["interval", "daily", "weekly"] as const),
      scheduleValue: Type.Object({
        minutes: Type.Optional(Type.Number({ description: "interval: minutes (≥0)" })),
        seconds: Type.Optional(Type.Number({ description: "interval: seconds (≥0); interval must total ≥ 5s" })),
        offsetMinutes: Type.Optional(Type.Number({ description: "interval: optional phase offset in minutes (≥0); not honored by the cron backend" })),
        offsetSeconds: Type.Optional(Type.Number({ description: "interval: optional phase offset in seconds (≥0); not honored by the cron backend" })),
        time: Type.Optional(Type.String({ description: "daily/weekly: HH:MM in 24h format" })),
        days: Type.Optional(Type.Array(Type.String(), { description: "weekly: list of weekday names (monday, tuesday, ...)" })),
      }),
      enabled: Type.Optional(Type.Boolean({ description: "If true, register launchd plist in the same call" })),
      model: Type.Optional(Type.String({ description: "Optional model id (passed to pi as --model)" })),
      timeoutMs: Type.Optional(Type.Number({ description: "Wall-clock timeout in ms; SIGTERM then SIGKILL after killGraceMs. Default 30m." })),
      idleTimeoutMs: Type.Optional(Type.Number({ description: "No-stdout/no-stderr cap in ms; SIGTERM when reached. 0 = disabled. Default 0." })),
      maxOutputBytes: Type.Optional(Type.Number({ description: "Transcript cap in bytes; child is killed when exceeded. 0 = disabled. Default 0." })),
      killGraceMs: Type.Optional(Type.Number({ description: "Delay between SIGTERM and SIGKILL in ms. Default 5_000." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      // Calls createTick() directly with typed params — no argv strings, no
      // second `list --json` round-trip to recover the job createTick
      // already built. cmdAdd (the CLI path) calls the same function.
      try {
        const job = await createTick({
          jobId: params.jobId,
          prompt: params.prompt,
          cwd: params.cwd,
          scheduleKind: params.scheduleKind,
          scheduleOpts: scheduleOptsFromScheduleValue(params.scheduleKind, params.scheduleValue),
          enabled: params.enabled === true,
          model: params.model,
          timeoutMs: params.timeoutMs,
          idleTimeoutMs: params.idleTimeoutMs,
          maxOutputBytes: params.maxOutputBytes,
          killGraceMs: params.killGraceMs,
        }, { stdout: silentSink, stderr: silentSink });
        return {
          content: [{ type: "text", text: JSON.stringify(job, null, 2) }],
          details: { jobId: job.id },
        };
      } catch (e: any) {
        const msg = e && e.message ? e.message : String(e);
        return {
          content: [{ type: "text", text: `tick_create failed: ${msg}` }],
          isError: true,
        };
      }
    },
  });

  // ── LLM tool: tick_list ─────────────────────────────────────────────────
  pi.registerTool({
    name: "tick_list",
    label: "List Scheduled Jobs",
    description: "List all scheduled jobs as a JSON array.",
    promptSnippet: "Enumerate scheduled agent jobs.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const res = await runCli(pi, ["list", "--json"]);
      if (res.code !== 0) {
        return {
          content: [{ type: "text", text: `tick_list failed: ${(res.stderr || "").trim() || `exit ${res.code}`}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: res.stdout.trim() || "[]" }],
        details: { jobs: res.stdout },
      };
    },
  });

  // ── LLM tool: tick_delete ───────────────────────────────────────────────
  pi.registerTool({
    name: "tick_delete",
    label: "Delete Scheduled Job",
    description: "Delete a scheduled job by id. Idempotent: deleting a non-existent job returns a no-op message.",
    promptSnippet: "Remove a scheduled agent job.",
    parameters: Type.Object({
      jobId: Type.String({ description: "Job id to delete" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const res = await runCli(pi, ["delete", String(params.jobId)]);
      // CLI exits 0 even for missing jobs; non-zero is a real failure.
      if (res.code !== 0) {
        return {
          content: [{ type: "text", text: `tick_delete failed: ${(res.stderr || res.stdout || `exit ${res.code}`).trim()}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: (res.stdout || res.stderr || `deleted job '${params.jobId}'`).trim() }],
        details: { deleted: params.jobId },
      };
    },
  });
}
