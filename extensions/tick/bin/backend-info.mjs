// backend-info.mjs — the active scheduler backend (launchd on macOS, cron
// elsewhere; override with PI_TICK_BACKEND=launchd|cron for tests).

import { getBackend } from "./backends/index.mjs";

export function activeBackend() {
  return getBackend();
}

export function getMinIntervalSeconds() {
  return activeBackend().minimumIntervalSeconds;
}
