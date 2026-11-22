import { test } from "node:test";
import assert from "node:assert/strict";
import { agentAdapter } from "../extensions/tick/bin/agents/index.mjs";
import { buildRunArgs, createRpcLifecycle, protectPromptArg } from "../extensions/tick/bin/agents/pi.mjs";
import { listBundleFiles } from "../extensions/tick/bundle.mjs";

test("agentAdapter: jobs without an agent use the pi adapter", () => {
  for (const id of [undefined, null, "pi"]) {
    const a = agentAdapter(id as any);
    assert.equal(a.id, "pi");
    assert.equal(a.plan, buildRunArgs);
    assert.equal(a.lifecycle, createRpcLifecycle);
  }
});

test("agentAdapter: unknown agent throws", () => {
  assert.throws(() => agentAdapter("nope"), /unknown agent: nope/);
});

test("pi adapter: plan is unchanged by the move", () => {
  assert.deepEqual(buildRunArgs({ prompt: "hello", model: "m" }, {}), {
    isSlashCommand: false, args: ["--mode", "json", "-p", "--no-session", "--model", "m", "hello"], effectiveModel: "m",
  });
  assert.deepEqual(buildRunArgs({ prompt: "/compact" }, { defaultModel: "d" }), {
    isSlashCommand: true, args: ["--mode", "rpc", "--no-session", "--model", "d"], effectiveModel: "d",
  });
  // issue #41 guard lives with the pi argv now
  assert.equal(buildRunArgs({ prompt: "--help" }, {}).args.at(-1), " --help");
  assert.equal(protectPromptArg("@file"), " @file");
});

test("bundle manifest ships the agents/ adapters to the stable CLI", () => {
  const files = listBundleFiles();
  assert.ok(files.includes("agents/index.mjs"));
  assert.ok(files.includes("agents/pi.mjs"));
});
