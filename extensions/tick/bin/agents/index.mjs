// agents/index.mjs — adapter registry. An adapter owns how a job's agent is
// invoked (`plan`: argv + mode) and how its output is interpreted
// (`lifecycle`); runner.mjs drives the process through this interface.
import { buildRunArgs as piPlan, createRpcLifecycle } from "./pi.mjs";

const adapters = {
  pi: { id: "pi", plan: piPlan, lifecycle: createRpcLifecycle },
};

export function agentAdapter(id = "pi") {
  const adapter = adapters[id ?? "pi"];
  if (!adapter) throw new Error(`unknown agent: ${id}; expected ${Object.keys(adapters).join(", ")}`);
  return adapter;
}
