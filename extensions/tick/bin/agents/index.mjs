// agents/index.mjs — adapter registry. An adapter owns how a job's agent is
// invoked (`plan`: argv + mode), how its output is interpreted
// (`lifecycle`), and which executable runs it (`resolve`); runner.mjs drives
// the process through this interface.
import { existsSync } from "node:fs";
import { resolvePiPath } from "../bin-resolve.mjs";
import { buildRunArgs as piPlan, createRpcLifecycle } from "./pi.mjs";
import { buildRunArgs as commandPlan, createLifecycle as commandLifecycle, COMMAND_SHELL } from "./command.mjs";

const adapters = {
  pi: {
    id: "pi", plan: piPlan, lifecycle: createRpcLifecycle,
    resolve: (job) => (job.piPath && existsSync(job.piPath) ? job.piPath : resolvePiPath()),
  },
  command: {
    id: "command", plan: commandPlan, lifecycle: commandLifecycle,
    resolve: () => COMMAND_SHELL,
  },
};

export const AGENT_IDS = Object.keys(adapters);

export function agentAdapter(id = "pi") {
  const adapter = adapters[id ?? "pi"];
  if (!adapter) throw new Error(`unknown agent: ${id}; expected ${AGENT_IDS.join(" or ")}`);
  return adapter;
}
