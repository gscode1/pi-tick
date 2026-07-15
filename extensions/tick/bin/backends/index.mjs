// backends/index.mjs — platform dispatch.
//
// Picks the right backend for the current platform, with explicit
// env-var overrides for tests and exotic setups:
//   PI_TICK_BACKEND=launchd  → force launchd
//   PI_TICK_BACKEND=cron     → force cron
//
// Default: launchd on darwin, cron everywhere else.

import { launchdBackend } from "./launchd.mjs";
import { cronBackend } from "./cron.mjs";

export function getBackend() {
  const override = process.env.PI_TICK_BACKEND;
  if (override === "launchd") return launchdBackend;
  if (override === "cron") return cronBackend;
  if (process.platform === "darwin") return launchdBackend;
  return cronBackend;
}

export { launchdBackend, cronBackend };
