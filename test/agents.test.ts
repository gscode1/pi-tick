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

// ─── pi lifecycle outcome rules ─────────────────────────────────────────
function lifecycle(isSlashCommand = true) {
  const stdin = { destroyed: false, ended: 0, write() {}, end() { this.ended++; } };
  const rpc = createRpcLifecycle({ isSlashCommand, child: { stdin } });
  const send = (evt: object) => rpc.handleLine(JSON.stringify(evt));
  const assistant = (extra: object) => send({ type: "message_end", message: { role: "assistant", content: [], ...extra } });
  return { rpc, stdin, send, assistant };
}
const text = (t: string) => [{ type: "text", text: t }];

test("pi lifecycle: agent_end with willRetry keeps RPC stdin open; the final agent_end closes it", () => {
  const { stdin, send } = lifecycle();
  send({ type: "agent_start" });
  send({ type: "agent_end", willRetry: true });
  assert.equal(stdin.ended, 0);
  send({ type: "agent_start" });
  send({ type: "agent_end" });
  assert.equal(stdin.ended, 1);
});

for (const stopReason of ["aborted", "toolUse"]) {
  test(`pi lifecycle: a final assistant message with stopReason ${stopReason} fails the run`, () => {
    const { rpc, assistant } = lifecycle(false);
    assistant({ stopReason, content: text("partial") });
    assert.equal(rpc.getFinalError(), `run ended with stopReason ${stopReason}`);
  });
}

test("pi lifecycle: errorMessage is the failure text; an error without one stays 'model error'", () => {
  const a = lifecycle(false);
  a.assistant({ stopReason: "aborted", errorMessage: "Request was aborted" });
  assert.equal(a.rpc.getFinalError(), "Request was aborted");
  const b = lifecycle(false);
  b.assistant({ stopReason: "error" });
  assert.equal(b.rpc.getFinalError(), "model error");
});

test("pi lifecycle: an aborted or toolUse message followed by a clean stop succeeds", () => {
  const { rpc, assistant } = lifecycle(false);
  assistant({ stopReason: "toolUse", content: text("calling a tool") });
  assistant({ stopReason: "aborted" });
  assistant({ stopReason: "stop", content: text("done") });
  assert.equal(rpc.getFinalError(), null);
  assert.equal(rpc.getFinalText(), "done");
});

test("pi lifecycle: preview is the last assistant message's text, not an earlier one", () => {
  const { rpc, assistant } = lifecycle(false);
  assistant({ stopReason: "toolUse", content: text("Let me check the logs") });
  assistant({ stopReason: "stop", content: [] });
  assert.equal(rpc.getFinalText(), null);
});
