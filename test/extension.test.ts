// test/extension.test.ts — the extension drives the core IN-PROCESS for each of
// the 3 slash commands and 3 LLM tools (no subprocess), against a real catalog.

import { test } from "node:test";
import assert from "node:assert/strict";
import { withTempDir, setupEnv, withEnv, teardownEnv } from "./_helpers.ts";
import { join, dirname } from "node:path";
import { existsSync, readFileSync, statSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  dataDir as sharedDataDir,
  stableCliPath as sharedStableCliPath,
} from "../extensions/tick/bin/paths.mjs";
import { listBundleFiles, bundledPath, installedPath } from "../extensions/tick/bundle.mjs";

// ─── Recording fake ExtensionAPI ─────────────────────────────────────────

type ToolDef = { name: string; description?: string; parameters?: unknown; execute?: (...args: any[]) => any; [k: string]: unknown };
type CommandDef = { description?: string; getArgumentCompletions?: (prefix: string) => any; handler?: (args: string, ctx: any) => any };

type FakePi = {
  calls: Array<{ tool: string; args: string[]; opts: any }>;
  tools: Map<string, ToolDef>;
  commands: Map<string, CommandDef>;
  handlers: Map<string, (...args: any[]) => any>;
  setResponse: (key: string, value: { stdout: string; stderr: string; code: number }) => void;
  getResponse: (key: string) => { stdout: string; stderr: string; code: number };
};

function makeFakePi(): FakePi {
  const calls: FakePi["calls"] = [];
  const tools = new Map<string, ToolDef>();
  const commands = new Map<string, CommandDef>();
  const handlers = new Map<string, (...args: any[]) => any>();
  const responses = new Map<string, { stdout: string; stderr: string; code: number }>();

  const setResponse = (key: string, value: { stdout: string; stderr: string; code: number }) => {
    responses.set(key, value);
  };
  // Lookup tries:
  //  1. exact joined key
  //  2. args excluding the first (script path)
  //  3. last arg alone
  const getResponse = (args: string[]) => {
    const exact = args.join(" ");
    if (responses.has(exact)) return responses.get(exact)!;
    const noScript = args.slice(1).join(" ");
    if (responses.has(noScript)) return responses.get(noScript)!;
    if (args.length > 0 && responses.has(args[args.length - 1])) {
      return responses.get(args[args.length - 1])!;
    }
    return { stdout: "", stderr: "", code: 0 };
  };

  return {
    calls,
    tools,
    commands,
    handlers,
    setResponse,
    getResponse,
    // The ExtensionAPI surface used by the extension:
    exec: async (cmd: string, args: string[], opts: any = {}) => {
      calls.push({ tool: cmd, args, opts });
      return getResponse(args);
    },
    registerTool: (def: ToolDef) => { tools.set(def.name, def); },
    registerCommand: (name: string, def: CommandDef) => { commands.set(name, def); },
    on: (event: string, handler: (...args: any[]) => any) => { handlers.set(event, handler); },
  } as unknown as FakePi & any;
}

async function loadExtension() {
  const extPath = new URL("../extensions/tick/index.ts", import.meta.url).pathname;
  return import(`${pathToFileURL(extPath).href}?t=${Date.now()}-${Math.random()}`);
}

function makeCtx() {
  const notifies: Array<{ msg: string; level: string }> = [];
  return {
    notifies,
    ctx: { ui: { notify: (msg: string, level: string) => notifies.push({ msg, level }) } },
  };
}

// ─── In-process catalog harness ──────────────────────────────────────────
//
// The extension now calls the core dispatcher IN-PROCESS (no subprocess), so
// these tests drive it against a REAL temp catalog under PI_TICK_DATA_DIR and
// assert on actual output (notifies / tool results / the on-disk catalog)
// rather than on a recorded `pi.exec` argv. This is the whole point of the
// refactor: list/run/delete/log exercise the same code with no ~200ms spawn.

function makeJob(overrides: Partial<{
  id: string; enabled: boolean;
  scheduleKind: "interval" | "daily" | "weekly";
  scheduleValue: Record<string, unknown>;
}> = {}) {
  const kind = overrides.scheduleKind ?? "daily";
  return {
    id: overrides.id ?? "test-job",
    prompt: "hello",
    cwd: "/tmp",
    schedule:
      kind === "interval"
        ? { kind: "interval", value: overrides.scheduleValue ?? { minutes: 5, seconds: 0 } }
        : kind === "weekly"
          ? { kind: "weekly", value: overrides.scheduleValue ?? { days: ["monday"], time: "09:00" } }
          : { kind: "daily", value: overrides.scheduleValue ?? { time: "09:00" } },
    enabled: overrides.enabled ?? false,
    model: null,
    piPath: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastRun: null,
  };
}

// Run `fn` with a temp data dir on PI_TICK_DATA_DIR, optionally seeding a
// catalog. The extension's in-process dispatch reads this same dir.
async function withCatalog(
  jobs: ReturnType<typeof makeJob>[] | null,
  fn: (env: ReturnType<typeof setupEnv>, dataDir: string) => Promise<void>,
) {
  await withTempDir(async (home) => {
    const dataDir = join(home, ".pi", "agent", "tick");
    const env = setupEnv({ dataDir, plistDir: join(home, "agents") });
    try {
      mkdirSync(dataDir, { recursive: true });
      if (jobs) {
        writeFileSync(join(dataDir, "jobs.json"), JSON.stringify({ version: 1, jobs }, null, 2), "utf8");
      }
      await withEnv(env, () => fn(env, dataDir));
    } finally {
      teardownEnv(env);
    }
  });
}

function readCatalog(dataDir: string): { version: number; jobs: any[] } {
  const p = join(dataDir, "jobs.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : { version: 1, jobs: [] };
}

// ─── Tests ───────────────────────────────────────────────────────────────

test("extension: default export is a function", async () => {
  const ext = await loadExtension();
  assert.equal(typeof ext.default, "function");
});

test("extension: registers tick slash command and 3 LLM tools", async () => {
  const ext = await loadExtension();
  const fake = makeFakePi();
  ext.default(fake as any);
  assert.ok(fake.commands.has("tick"));
  assert.ok(fake.tools.has("tick_create"));
  assert.ok(fake.tools.has("tick_list"));
  assert.ok(fake.tools.has("tick_delete"));
  assert.ok(fake.handlers.has("session_start"));
});

test("extension: session_start syncs the bundled CLI to the stable path", async () => {
  await withTempDir(async (dataHome) => {
    const dataDir = join(dataHome, ".pi", "agent", "tick");
    const env = setupEnv({ dataDir, plistDir: join(dataHome, "agents") });
    try {
      const ext = await loadExtension();
      const fake = makeFakePi();
      const realHome = process.env.HOME;
      process.env.HOME = dataHome;
      process.env.PI_TICK_DATA_DIR = dataDir;
      try {
        ext.default(fake as any);
        const handler = fake.handlers.get("session_start")!;
        await handler({ reason: "startup" }, makeCtx().ctx);
        const stablePath = join(dataDir, "pi-tick.mjs");
        assert.ok(existsSync(stablePath), `stable CLI exists at ${stablePath}`);
        assert.equal(statSync(stablePath).mode & 0o777, 0o755);
        const logs = join(dataDir, "logs");
        assert.ok(existsSync(logs));
        assert.equal(statSync(logs).mode & 0o777, 0o700);
      } finally {
        process.env.HOME = realHome;
        delete process.env.PI_TICK_DATA_DIR;
      }
    } finally {
      teardownEnv(env);
    }
  });
});

test("extension: session_start is idempotent (no error on re-run)", async () => {
  await withTempDir(async (dataHome) => {
    const dataDir = join(dataHome, ".pi", "agent", "tick");
    const env = setupEnv({ dataDir, plistDir: join(dataHome, "agents") });
    try {
      const ext = await loadExtension();
      const fake = makeFakePi();
      const realHome = process.env.HOME;
      process.env.HOME = dataHome;
      process.env.PI_TICK_DATA_DIR = dataDir;
      try {
        ext.default(fake as any);
        const handler = fake.handlers.get("session_start")!;
        await handler({ reason: "startup" }, makeCtx().ctx);
        await handler({ reason: "startup" }, makeCtx().ctx);
        assert.ok(existsSync(join(dataDir, "pi-tick.mjs")));
      } finally {
        process.env.HOME = realHome;
        delete process.env.PI_TICK_DATA_DIR;
      }
    } finally {
      teardownEnv(env);
    }
  });
});

test("extension: tick_create for interval persists the job to the catalog", async () => {
  // enabled is omitted (draft): the --enabled path performs a real launchd
  // install, which needs the synced stable CLI + launchctl — out of scope for a
  // unit test. cmdEnable is covered separately in pi-tick.test.ts.
  await withCatalog([], async (_env, dataDir) => {
    const ext = await loadExtension();
    const fake = makeFakePi();
    ext.default(fake as any);
    const tool = fake.tools.get("tick_create")!;
    const result = await tool.execute!("call1", {
      jobId: "j1", prompt: "do it", cwd: "/tmp",
      scheduleKind: "interval",
      scheduleValue: { minutes: 5, seconds: 0 },
      model: "claude-sonnet-4-5",
    });
    assert.notEqual(result.isError, true);
    const job = readCatalog(dataDir).jobs.find((j) => j.id === "j1");
    assert.ok(job, "job j1 was created in the catalog");
    assert.equal(job.schedule.kind, "interval");
    assert.equal(job.schedule.value.minutes, 5);
    assert.equal(job.model, "claude-sonnet-4-5");
    assert.equal(job.prompt, "do it");
  });
});

test("extension: tick_create for weekly persists schedule (and stays a draft)", async () => {
  await withCatalog([], async (_env, dataDir) => {
    const ext = await loadExtension();
    const fake = makeFakePi();
    ext.default(fake as any);
    const tool = fake.tools.get("tick_create")!;
    const result = await tool.execute!("c1", {
      jobId: "wk", prompt: "weekly", cwd: "/tmp",
      scheduleKind: "weekly",
      scheduleValue: { days: ["mon", "wed", "fri"], time: "17:00" },
    });
    assert.notEqual(result.isError, true);
    const job = readCatalog(dataDir).jobs.find((j) => j.id === "wk");
    assert.ok(job, "job wk was created");
    assert.equal(job.schedule.kind, "weekly");
    assert.equal(job.schedule.value.time, "17:00");
    for (const d of ["mon", "wed", "fri"]) {
      assert.ok(job.schedule.value.days.includes(d), `days include ${d}`);
    }
    assert.equal(job.enabled, false, "no enabled flag → draft");
  });
});

test("extension: tick_create reports core validation errors via isError: true", async () => {
  await withCatalog([], async () => {
    const ext = await loadExtension();
    const fake = makeFakePi();
    ext.default(fake as any);
    const tool = fake.tools.get("tick_create")!;
    const result = await tool.execute!("c1", {
      jobId: "bad id!", prompt: "x", cwd: "/tmp",
      scheduleKind: "daily", scheduleValue: { time: "09:00" },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /invalid id/);
  });
});

test("extension: tick_list returns the catalog as JSON", async () => {
  await withCatalog([makeJob({ id: "a" })], async () => {
    const ext = await loadExtension();
    const fake = makeFakePi();
    ext.default(fake as any);
    const tool = fake.tools.get("tick_list")!;
    const result = await tool.execute!("c1", {});
    assert.notEqual(result.isError, true);
    assert.ok(result.content[0].text.includes('"id"'));
    assert.ok(result.content[0].text.includes("a"));
    assert.equal(fake.calls.length, 0, "no subprocess was spawned");
  });
});

test("extension: tick_delete removes the job and reports success", async () => {
  await withCatalog([makeJob({ id: "j1" })], async (_env, dataDir) => {
    const ext = await loadExtension();
    const fake = makeFakePi();
    ext.default(fake as any);
    const tool = fake.tools.get("tick_delete")!;
    const result = await tool.execute!("c1", { jobId: "j1" });
    assert.notEqual(result.isError, true);
    assert.match(result.content[0].text, /deleted job 'j1'/);
    assert.equal(readCatalog(dataDir).jobs.find((j) => j.id === "j1"), undefined);
  });
});

test("extension: tick_delete on a missing job surfaces 'no such job' (not isError)", async () => {
  await withCatalog([], async () => {
    const ext = await loadExtension();
    const fake = makeFakePi();
    ext.default(fake as any);
    const tool = fake.tools.get("tick_delete")!;
    const result = await tool.execute!("c1", { jobId: "gone" });
    assert.notEqual(result.isError, true);
    assert.match(result.content[0].text, /no such job/);
  });
});

test("extension: /tick list notifies info with the catalog on success", async () => {
  await withCatalog([makeJob({ id: "foo", enabled: true })], async () => {
    const ext = await loadExtension();
    const fake = makeFakePi();
    ext.default(fake as any);
    const cmd = fake.commands.get("tick")!;
    const { ctx, notifies } = makeCtx();
    await cmd.handler!("list", ctx);
    assert.ok(notifies.length > 0);
    assert.equal(notifies[0].level, "info");
    assert.match(notifies[0].msg, /foo/);
    // The whole point of the refactor: this ran IN-PROCESS, no pi.exec spawn.
    assert.equal(fake.calls.length, 0, "no subprocess was spawned");
  });
});

test("extension: /tick list notifies error when the catalog is unreadable", async () => {
  await withCatalog(null, async (_env, dataDir) => {
    // Corrupt the catalog so loadCatalog fails — exercises the error path that
    // used to be simulated with a non-zero subprocess exit.
    writeFileSync(join(dataDir, "jobs.json"), "{ not valid json", "utf8");
    const ext = await loadExtension();
    const fake = makeFakePi();
    ext.default(fake as any);
    const cmd = fake.commands.get("tick")!;
    const { ctx, notifies } = makeCtx();
    await cmd.handler!("list", ctx);
    assert.ok(notifies.some((n) => n.level === "error"), "an error notify is raised");
  });
});

// Issue #48 — /tick run used to mark a run as "manual" by mutating
// process.env.PI_SCHEDULER_MANUAL around the in-process dispatch call. The
// trigger is now passed as an explicit --manual argv flag, so there is no
// global state to leak in the first place.
test("extension: /tick run does not touch process.env at all", async () => {
  await withCatalog([], async () => {
    const ext = await loadExtension();
    const fake = makeFakePi();
    ext.default(fake as any);
    const cmd = fake.commands.get("tick")!;
    const { ctx, notifies } = makeCtx();
    assert.equal(process.env.PI_SCHEDULER_MANUAL, undefined, "precondition: not set before the call");
    // Missing job → fails fast before any pi spawn, so this stays a unit test.
    await cmd.handler!("run missing", ctx);
    assert.ok(notifies.some((n) => n.level === "error"), "missing job notifies error");
    assert.equal(process.env.PI_SCHEDULER_MANUAL, undefined, "still unset — nothing was ever mutated");
  });
});

test("extension: /tick run notifies error on failure", async () => {
  await withCatalog([], async () => {
    const ext = await loadExtension();
    const fake = makeFakePi();
    ext.default(fake as any);
    const cmd = fake.commands.get("tick")!;
    const { ctx, notifies } = makeCtx();
    await cmd.handler!("run missing", ctx);
    assert.ok(notifies.some((n) => n.level === "error"));
  });
});

test("extension: /tick kill with no id shows usage", async () => {
  await withCatalog([], async () => {
    const ext = await loadExtension();
    const fake = makeFakePi();
    ext.default(fake as any);
    const cmd = fake.commands.get("tick")!;
    const { ctx, notifies } = makeCtx();
    await cmd.handler!("kill", ctx);
    assert.ok(notifies.some((n) => n.level === "error" && /Usage: \/tick kill/.test(n.msg)));
  });
});

test("extension: /tick kill on a job with no active run notifies error", async () => {
  await withCatalog([], async () => {
    const ext = await loadExtension();
    const fake = makeFakePi();
    ext.default(fake as any);
    const cmd = fake.commands.get("tick")!;
    const { ctx, notifies } = makeCtx();
    await cmd.handler!("kill nope", ctx);
    assert.ok(notifies.some((n) => n.level === "error" && /no active run/.test(n.msg)));
  });
});

test("extension: /tick enable with no id shows usage", async () => {
  await withCatalog([], async () => {
    const ext = await loadExtension();
    const fake = makeFakePi();
    ext.default(fake as any);
    const cmd = fake.commands.get("tick")!;
    const { ctx, notifies } = makeCtx();
    await cmd.handler!("enable", ctx);
    assert.ok(notifies.some((n) => n.level === "error" && /Usage: \/tick enable/.test(n.msg)));
  });
});

test("extension: /tick disable with no id shows usage", async () => {
  await withCatalog([], async () => {
    const ext = await loadExtension();
    const fake = makeFakePi();
    ext.default(fake as any);
    const cmd = fake.commands.get("tick")!;
    const { ctx, notifies } = makeCtx();
    await cmd.handler!("disable", ctx);
    assert.ok(notifies.some((n) => n.level === "error" && /Usage: \/tick disable/.test(n.msg)));
  });
});

// Already-disabled is the one disable path with no backend dependency
// (cmdDisable short-circuits before calling activeBackend().unregister), so
// it's the one we can exercise here without stubbing launchctl/pi/node.
test("extension: /tick disable on an already-disabled job reports the no-op, doesn't touch the catalog", async () => {
  await withCatalog([makeJob({ id: "j1", enabled: false })], async (_env, dataDir) => {
    const ext = await loadExtension();
    const fake = makeFakePi();
    ext.default(fake as any);
    const cmd = fake.commands.get("tick")!;
    const { ctx, notifies } = makeCtx();
    await cmd.handler!("disable j1", ctx);
    assert.equal(readCatalog(dataDir).jobs.find((j) => j.id === "j1")?.enabled, false);
    assert.ok(notifies.some((n) => n.level === "info" && /already disabled/.test(n.msg)));
  });
});

test("extension: /tick delete removes the job from the catalog", async () => {
  await withCatalog([makeJob({ id: "j1" })], async (_env, dataDir) => {
    const ext = await loadExtension();
    const fake = makeFakePi();
    ext.default(fake as any);
    const cmd = fake.commands.get("tick")!;
    const { ctx, notifies } = makeCtx();
    await cmd.handler!("delete j1", ctx);
    assert.equal(readCatalog(dataDir).jobs.find((j) => j.id === "j1"), undefined);
    assert.ok(notifies.some((n) => /deleted job 'j1'/.test(n.msg)));
  });
});

test("extension: /tick show reports no transcripts for a fresh job", async () => {
  await withCatalog([makeJob({ id: "j1" })], async () => {
    const ext = await loadExtension();
    const fake = makeFakePi();
    ext.default(fake as any);
    const cmd = fake.commands.get("tick")!;
    const { ctx, notifies } = makeCtx();
    await cmd.handler!("show j1", ctx);
    assert.ok(notifies.length > 0);
    assert.match(notifies[0].msg, /no transcripts/);
  });
});

test("extension: /tick show without job shows examples", async () => {
  const ext = await loadExtension();
  const fake = makeFakePi();
  ext.default(fake as any);
  const cmd = fake.commands.get("tick")!;
  const { ctx, notifies } = makeCtx();
  await cmd.handler!("show", ctx);
  assert.equal(fake.calls.length, 0);
  assert.match(notifies[0].msg, /Usage: \/tick show <jobId>/);
  assert.match(notifies[0].msg, /Example: \/tick show model-check-1/);
});

test("extension: /tick log reports no runs for a fresh job", async () => {
  await withCatalog([makeJob({ id: "j1" })], async () => {
    const ext = await loadExtension();
    const fake = makeFakePi();
    ext.default(fake as any);
    const cmd = fake.commands.get("tick")!;
    const { ctx, notifies } = makeCtx();
    await cmd.handler!("log j1 --failed", ctx);
    assert.ok(notifies.length > 0);
    assert.match(notifies[0].msg, /no runs/);
  });
});

test("extension: getArgumentCompletions returns subcommands for empty prefix", async () => {
  const ext = await loadExtension();
  const fake = makeFakePi();
  fake.setResponse("list --json", { stdout: "[]", stderr: "", code: 0 });
  ext.default(fake as any);
  const cmd = fake.commands.get("tick")!;
  const completions = await cmd.getArgumentCompletions!("");
  assert.ok(completions);
  const values = completions!.map((c: any) => c.value);
  assert.ok(values.includes("list"));
  assert.ok(values.includes("run"));
  assert.ok(values.includes("kill"));
  assert.ok(values.includes("enable"));
  assert.ok(values.includes("disable"));
  assert.ok(values.includes("delete"));
  assert.ok(values.includes("log"));
  assert.ok(values.includes("show"));
});

test("extension: getArgumentCompletions for /tick run <id> returns job ids from catalog", async () => {
  await withCatalog([makeJob({ id: "alpha" }), makeJob({ id: "beta" })], async () => {
    const ext = await loadExtension();
    const fake = makeFakePi();
    ext.default(fake as any);
    const cmd = fake.commands.get("tick")!;
    const completions = await cmd.getArgumentCompletions!("run ");
    const values = completions!.map((c: any) => c.value);
    assert.ok(values.includes("alpha"));
    assert.ok(values.includes("beta"));
  });
});

test("extension: getArgumentCompletions for /tick delete <id> returns job ids", async () => {
  await withCatalog([makeJob({ id: "alpha" })], async () => {
    const ext = await loadExtension();
    const fake = makeFakePi();
    ext.default(fake as any);
    const cmd = fake.commands.get("tick")!;
    const completions = await cmd.getArgumentCompletions!("delete ");
    const values = completions!.map((c: any) => c.value);
    assert.ok(values.includes("alpha"));
  });
});

test("extension: getArgumentCompletions returns [] for /tick list <nothing>", async () => {
  const ext = await loadExtension();
  const fake = makeFakePi();
  ext.default(fake as any);
  const cmd = fake.commands.get("tick")!;
  const completions = await cmd.getArgumentCompletions!("list ");
  assert.deepEqual(completions, []);
});

test("extension: /tick with no subcommand shows usage info notification", async () => {
  const ext = await loadExtension();
  const fake = makeFakePi();
  ext.default(fake as any);
  const cmd = fake.commands.get("tick")!;
  const { ctx, notifies } = makeCtx();
  await cmd.handler!("", ctx);
  assert.ok(notifies.length > 0);
  assert.match(notifies[0].msg, /Usage/);
});

test("extension: /tick with unknown subcommand notifies error", async () => {
  const ext = await loadExtension();
  const fake = makeFakePi();
  ext.default(fake as any);
  const cmd = fake.commands.get("tick")!;
  const { ctx, notifies } = makeCtx();
  await cmd.handler!("weird", ctx);
  assert.ok(notifies.some((n) => n.level === "error"));
});

// ─── Path consolidation (issue #19) ─────────────────────────────────────
//
// The extension and core now share the same dataDir, so the in-process calls
// read/write exactly where the CLI helper points.

test("paths: extension reads the same dataDir the CLI helper computes", async () => {
  await withTempDir(async (dataHome) => {
    const dataDir = join(dataHome, ".pi", "agent", "tick");
    const env = setupEnv({ dataDir, plistDir: join(dataHome, "agents") });
    try {
      const realHome = process.env.HOME;
      process.env.HOME = dataHome;
      process.env.PI_TICK_DATA_DIR = dataDir;
      try {
        // The shared helpers must agree on resolved paths — otherwise the
        // in-process core and the synced CLI would diverge.
        assert.equal(sharedDataDir(), dataDir);
        assert.equal(sharedStableCliPath(), join(dataDir, "pi-tick.mjs"));
        assert.equal(installedPath("backends/index.mjs"), join(dataDir, "backends", "index.mjs"));
        assert.equal(installedPath("paths.mjs"), join(dataDir, "paths.mjs"));

        // Seed a job directly, then prove the in-process /tick list sees it —
        // i.e. the extension reads the very dataDir the helper resolves.
        mkdirSync(dataDir, { recursive: true });
        writeFileSync(join(dataDir, "jobs.json"), JSON.stringify({ version: 1, jobs: [makeJob({ id: "shared-id" })] }, null, 2), "utf8");
        const ext = await loadExtension();
        const fake = makeFakePi();
        ext.default(fake as any);
        const cmd = fake.commands.get("tick")!;
        const { ctx, notifies } = makeCtx();
        await cmd.handler!("list", ctx);
        assert.ok(notifies.some((n) => /shared-id/.test(n.msg)));
      } finally {
        process.env.HOME = realHome;
        delete process.env.PI_TICK_DATA_DIR;
      }
    } finally {
      teardownEnv(env);
    }
  });
});

test("sync: session_start installs tick-core.mjs next to the CLI (byte-equal)", async () => {
  await withTempDir(async (dataHome) => {
    const dataDir = join(dataHome, ".pi", "agent", "tick");
    const env = setupEnv({ dataDir, plistDir: join(dataHome, "agents") });
    try {
      const realHome = process.env.HOME;
      process.env.HOME = dataHome;
      process.env.PI_TICK_DATA_DIR = dataDir;
      try {
        const ext = await loadExtension();
        const fake = makeFakePi();
        ext.default(fake as any);
        const handler = fake.handlers.get("session_start")!;
        await handler({ reason: "startup" }, makeCtx().ctx);

        // The thin wrapper imports ./tick-core.mjs, so the sync MUST install it
        // alongside pi-tick.mjs or launchd/cron runs break at import time.
        const installedCore = join(dataDir, "tick-core.mjs");
        assert.ok(existsSync(installedCore), `tick-core.mjs synced to ${installedCore}`);
        const bundledSrc = new URL("../extensions/tick/bin/tick-core.mjs", import.meta.url).pathname;
        assert.ok(readFileSync(bundledSrc).equals(readFileSync(installedCore)), "synced core is byte-equal to bundled source");
      } finally {
        process.env.HOME = realHome;
        delete process.env.PI_TICK_DATA_DIR;
      }
    } finally {
      teardownEnv(env);
    }
  });
});

// Issue #58 — tick-core.mjs now statically imports transcript-view.mjs, so
// the sync must install it too or a launchd/cron-spawned `pi-tick run <id>`
// fails to load (Cannot find module './transcript-view.mjs').
test("sync: session_start installs transcript-view.mjs next to the CLI (byte-equal)", async () => {
  await withTempDir(async (dataHome) => {
    const dataDir = join(dataHome, ".pi", "agent", "tick");
    const env = setupEnv({ dataDir, plistDir: join(dataHome, "agents") });
    try {
      const realHome = process.env.HOME;
      process.env.HOME = dataHome;
      process.env.PI_TICK_DATA_DIR = dataDir;
      try {
        const ext = await loadExtension();
        const fake = makeFakePi();
        ext.default(fake as any);
        const handler = fake.handlers.get("session_start")!;
        await handler({ reason: "startup" }, makeCtx().ctx);

        const installed = join(dataDir, "transcript-view.mjs");
        assert.ok(existsSync(installed), `transcript-view.mjs synced to ${installed}`);
        const bundledSrc = new URL("../extensions/tick/bin/transcript-view.mjs", import.meta.url).pathname;
        assert.ok(readFileSync(bundledSrc).equals(readFileSync(installed)), "synced transcript-view is byte-equal to bundled source");
      } finally {
        process.env.HOME = realHome;
        delete process.env.PI_TICK_DATA_DIR;
      }
    } finally {
      teardownEnv(env);
    }
  });
});

// Issue #47 — runner.mjs now imports run-registry.mjs (writeActiveRun /
// clearActiveRun moved there), and tick-core.mjs imports it directly too
// (cmdKill). The sync must install it or a launchd/cron-spawned
// `pi-tick run <id>` fails to load.
test("sync: session_start installs run-registry.mjs next to the CLI (byte-equal)", async () => {
  await withTempDir(async (dataHome) => {
    const dataDir = join(dataHome, ".pi", "agent", "tick");
    const env = setupEnv({ dataDir, plistDir: join(dataHome, "agents") });
    try {
      const realHome = process.env.HOME;
      process.env.HOME = dataHome;
      process.env.PI_TICK_DATA_DIR = dataDir;
      try {
        const ext = await loadExtension();
        const fake = makeFakePi();
        ext.default(fake as any);
        const handler = fake.handlers.get("session_start")!;
        await handler({ reason: "startup" }, makeCtx().ctx);

        const installed = join(dataDir, "run-registry.mjs");
        assert.ok(existsSync(installed), `run-registry.mjs synced to ${installed}`);
        const bundledSrc = new URL("../extensions/tick/bin/run-registry.mjs", import.meta.url).pathname;
        assert.ok(readFileSync(bundledSrc).equals(readFileSync(installed)), "synced run-registry is byte-equal to bundled source");
      } finally {
        process.env.HOME = realHome;
        delete process.env.PI_TICK_DATA_DIR;
      }
    } finally {
      teardownEnv(env);
    }
  });
});

test("sync: session_start copies paths.mjs to dataDir (byte-equal to bundled source)", async () => {
  await withTempDir(async (dataHome) => {
    const dataDir = join(dataHome, ".pi", "agent", "tick");
    const env = setupEnv({ dataDir, plistDir: join(dataHome, "agents") });
    try {
      const ext = await loadExtension();
      const fake = makeFakePi();
      const realHome = process.env.HOME;
      process.env.HOME = dataHome;
      process.env.PI_TICK_DATA_DIR = dataDir;
      try {
        ext.default(fake as any);
        const handler = fake.handlers.get("session_start")!;
        await handler({ reason: "startup" }, makeCtx().ctx);

        const installed = installedPath("paths.mjs");
        assert.ok(existsSync(installed), `paths.mjs synced to ${installed}`);

        // Byte-equal to the bundled source — drift between the two is the
        // exact failure mode this issue is meant to prevent.
        const bundledSrc = new URL("../extensions/tick/bin/paths.mjs", import.meta.url).pathname;
        const bundled = readFileSync(bundledSrc);
        const synced = readFileSync(installed);
        assert.ok(bundled.equals(synced), "synced paths.mjs must be byte-equal to bundled source");
      } finally {
        process.env.HOME = realHome;
        delete process.env.PI_TICK_DATA_DIR;
      }
    } finally {
      teardownEnv(env);
    }
  });
});

// Issue #60 — the installed bundle used to be a hand-kept list (one entry
// per file, in three places). This test derives the manifest the same way
// the extension does (by walking bin/) and asserts every entry actually
// landed byte-equal, so a future module split under bin/ is caught here
// instead of surfacing only on a real launchd/cron run.
test("sync: session_start installs every file in the bundle manifest (byte-equal)", async () => {
  await withTempDir(async (dataHome) => {
    const dataDir = join(dataHome, ".pi", "agent", "tick");
    const env = setupEnv({ dataDir, plistDir: join(dataHome, "agents") });
    try {
      const realHome = process.env.HOME;
      process.env.HOME = dataHome;
      process.env.PI_TICK_DATA_DIR = dataDir;
      try {
        const files = listBundleFiles();
        // Sanity: the manifest must include the entry point and at least
        // one backend, or this test would pass trivially on an empty list.
        assert.ok(files.includes("pi-tick.mjs"), "manifest includes pi-tick.mjs");
        assert.ok(files.some((f) => f.startsWith("backends/")), "manifest includes backends/*.mjs");

        const ext = await loadExtension();
        const fake = makeFakePi();
        ext.default(fake as any);
        const handler = fake.handlers.get("session_start")!;
        await handler({ reason: "startup" }, makeCtx().ctx);

        for (const rel of files) {
          const installed = installedPath(rel);
          assert.ok(existsSync(installed), `${rel} synced to ${installed}`);
          const bundled = readFileSync(bundledPath(rel));
          const synced = readFileSync(installed);
          assert.ok(bundled.equals(synced), `synced ${rel} must be byte-equal to bundled source`);
        }
      } finally {
        process.env.HOME = realHome;
        delete process.env.PI_TICK_DATA_DIR;
      }
    } finally {
      teardownEnv(env);
    }
  });
});

test("extension: session_start concurrent triggers do not cause race conditions or redundant I/O", async (t) => {
  await withTempDir(async (dataHome) => {
    const dataDir = join(dataHome, ".pi", "agent", "tick");
    const env = setupEnv({ dataDir, plistDir: join(dataHome, "agents") });
    try {
      const ext = await loadExtension();
      const fake = makeFakePi();
      const realHome = process.env.HOME;
      process.env.HOME = dataHome;
      process.env.PI_TICK_DATA_DIR = dataDir;
      try {
        ext.default(fake as any);
        const handler = fake.handlers.get("session_start")!;
        
        const fsPromises = await import("node:fs/promises");
        let copyFileMock;
        try {
          copyFileMock = t.mock.method(fsPromises, "copyFile");
        } catch (e) {
          // Node version might not support mocking built-ins this way
        }

        const triggers = Array.from({ length: 10 }, () => handler({ reason: "startup" }, makeCtx().ctx));
        await Promise.all(triggers);

        const stablePath = join(dataDir, "pi-tick.mjs");
        assert.ok(existsSync(stablePath), `stable CLI exists at ${stablePath}`);
        
        if (copyFileMock) {
          const copiedDestinations = copyFileMock.mock.calls.map((call: any) => call.arguments[1]);
          const uniqueDestinations = new Set(copiedDestinations);
          assert.equal(copiedDestinations.length, uniqueDestinations.size, "copyFile should only be called once per destination");
        }
      } finally {
        process.env.HOME = realHome;
        delete process.env.PI_TICK_DATA_DIR;
      }
    } finally {
      teardownEnv(env);
    }
  });
});

// Issue #49 — syncOneFile used to copyFile(src, dest) directly. Two
// session_start syncs racing in SEPARATE PROCESSES (e.g. two pi sessions
// starting at once) could both write to dest at the same moment, producing
// a half-written/truncated pi-tick.mjs. The within-process concurrency
// test above doesn't exercise this (a single process's `initPromise`
// already dedupes concurrent triggers) — this test spawns real child
// processes so the syncs are genuinely concurrent at the OS level.
test("sync: N concurrent syncBundledCli calls across separate processes leave a valid, byte-equal pi-tick.mjs", async () => {
  await withTempDir(async (dataHome) => {
    const dataDir = join(dataHome, ".pi", "agent", "tick");
    const env = setupEnv({ dataDir, plistDir: join(dataHome, "agents") });
    try {
      const extPath = fileURLToPath(new URL("../extensions/tick/index.ts", import.meta.url));
      const childScript = `
        const ext = await import(${JSON.stringify(pathToFileURL(extPath).href)});
        const fake = {
          handlers: new Map(),
          on(name, fn) { this.handlers.set(name, fn); },
          registerCommand() {},
          registerTool() {},
        };
        ext.default(fake);
        const handler = fake.handlers.get("session_start");
        await handler({ reason: "startup" }, { ui: { notify: () => {} } });
      `;
      const childEnv = {
        ...process.env,
        HOME: dataHome,
        PI_TICK_DATA_DIR: dataDir,
        PI_TICK_PLIST_DIR: join(dataHome, "agents"),
      };
      const N = 8;
      await Promise.all(
        Array.from({ length: N }, () =>
          new Promise<void>((resolve, reject) => {
            const child = spawn(
              process.execPath,
              ["--experimental-strip-types", "--input-type=module", "-e", childScript],
              { env: childEnv, stdio: ["ignore", "pipe", "pipe"] },
            );
            let stderr = "";
            child.stderr.on("data", (c) => { stderr += c.toString("utf8"); });
            child.on("close", (code) =>
              code === 0 ? resolve() : reject(new Error(`child exit ${code}: ${stderr}`)),
            );
            child.on("error", reject);
          }),
        ),
      );
      const stablePath = join(dataDir, "pi-tick.mjs");
      assert.ok(existsSync(stablePath), `stable CLI exists at ${stablePath}`);
      // No leftover temp files from a sync that crashed mid-write.
      const leftoverTmp = readdirSync(dataDir).filter((f) => f.includes(".tmp"));
      assert.deepEqual(leftoverTmp, [], `no leftover .tmp files: ${leftoverTmp.join(", ")}`);
      // Byte-equal to the bundled source — not torn/truncated.
      const bundledPath = join(dirname(extPath), "bin", "pi-tick.mjs");
      assert.deepEqual(readFileSync(stablePath), readFileSync(bundledPath));
      // Actually loadable — a torn write would fail to parse as a module.
      await import(`${pathToFileURL(stablePath).href}?verify=${Date.now()}`);
    } finally {
      teardownEnv(env);
    }
  });
});
