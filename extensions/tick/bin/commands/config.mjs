// commands/config.mjs — `pi-tick config <set|get|unset> <key> [value]`.

import { ensureDataDirs, loadConfig, saveConfig } from "../catalog.mjs";
import { parseFlags } from "../argv.mjs";
import { fail } from "../errors.mjs";

// Tick-scoped config commands. The only key today is `default-model`,
// applied at run time when a job doesn't pin one. Designed for one key
// at a time; extend the table below if more land.
export const CONFIG_KEYS = {
  "default-model": {
    read: (cfg) => cfg.defaultModel,
    write: (cfg, value) => ({ ...cfg, defaultModel: value }),
  },
};

export function cmdConfig(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const flags = parseFlags(argv);
  const pos = flags._;
  if (pos.length < 1) fail(`config requires a subcommand: set|get|unset`, 2);
  const sub = pos[0];
  const key = pos[1];
  if (!key || !(key in CONFIG_KEYS)) {
    fail(`config: unknown or missing key '${key ?? ""}'; supported: ${Object.keys(CONFIG_KEYS).join(", ")}`, 2);
  }
  const entry = CONFIG_KEYS[key];
  ensureDataDirs();

  if (sub === "get") {
    const value = entry.read(loadConfig());
    stdout.write(value ?? "");
    stdout.write("\n");
    return 0;
  }

  if (sub === "set") {
    const raw = pos[2];
    if (raw === undefined) fail(`config set ${key} requires a value`, 2);
    const trimmed = String(raw).trim();
    if (trimmed.length === 0) fail(`config set ${key}: value must be non-empty`, 2);
    const cfg = loadConfig();
    saveConfig(entry.write(cfg, trimmed));
    stdout.write(`${key}=${trimmed}\n`);
    return 0;
  }

  if (sub === "unset") {
    const cfg = loadConfig();
    saveConfig(entry.write(cfg, null));
    stdout.write(`${key} unset\n`);
    return 0;
  }

  fail(`config: unknown subcommand '${sub}'; expected set|get|unset`, 2);
}
