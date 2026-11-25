// commands/config.mjs — `pi-tick config <set|get|unset> <key> [value]`.

import { ensureDataDirs, loadConfig, saveConfig } from "../catalog.mjs";
import { parseFlags } from "../argv.mjs";
import { fail } from "../errors.mjs";
import { isAbsolute, resolve } from "node:path";

// Tick-scoped config commands. Keys: `default-model`, applied at run time
// when a job doesn't pin one, and `worktree-dir`, the root for
// `--isolate worktree` runs of jobs without their own `--worktree-dir`.
// Designed for one key at a time; extend the table below if more land.
// `normalize` (optional) validates a value being set and returns what to store.
export const CONFIG_KEYS = {
  "default-model": {
    read: (cfg) => cfg.defaultModel,
    write: (cfg, value) => ({ ...cfg, defaultModel: value }),
  },
  "worktree-dir": {
    read: (cfg) => cfg.worktreeDir,
    write: (cfg, value) => ({ ...cfg, worktreeDir: value }),
    normalize: (value) => {
      if (!isAbsolute(value)) fail(`config set worktree-dir: value must be an absolute path (got '${value}')`, 2);
      return resolve(value);
    },
  },
};

export function cmdConfig(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const flags = parseFlags(argv);
  const pos = flags._;
  if (pos.length < 1) fail(`config requires a subcommand: set|get|unset`, 2);
  const sub = pos[0];
  const key = pos[1];
  if (!key || !Object.hasOwn(CONFIG_KEYS, key)) {
    fail(`config: unknown or missing key '${key ?? ""}'; supported: ${Object.keys(CONFIG_KEYS).join(", ")}`, 2);
  }
  const entry = CONFIG_KEYS[key];
  ensureDataDirs();

  if (sub === "get") {
    const value = entry.read(loadConfig({ stderr, strict: true }));
    stdout.write(value ?? "");
    stdout.write("\n");
    return 0;
  }

  if (sub === "set") {
    const raw = pos[2];
    if (raw === undefined) fail(`config set ${key} requires a value`, 2);
    const trimmed = String(raw).trim();
    if (trimmed.length === 0) fail(`config set ${key}: value must be non-empty`, 2);
    const value = entry.normalize ? entry.normalize(trimmed) : trimmed;
    const cfg = loadConfig({ stderr });
    saveConfig(entry.write(cfg, value));
    stdout.write(`${key}=${value}\n`);
    return 0;
  }

  if (sub === "unset") {
    const cfg = loadConfig({ stderr });
    saveConfig(entry.write(cfg, null));
    stdout.write(`${key} unset\n`);
    return 0;
  }

  fail(`config: unknown subcommand '${sub}'; expected set|get|unset`, 2);
}
