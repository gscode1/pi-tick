#!/usr/bin/env node
// scripts/install.mjs — install the pi-tick CLI from a source checkout
// without opening a pi session: sync the bundled CLI to its stable path
// (as session_start does) and symlink it as ~/.local/bin/pi-tick
// (override the directory with PI_TICK_BIN_DIR).
//
// Refuses while a job is running (the sync would replace its modules
// mid-run) and never replaces a regular file at the link path.
import { mkdirSync, lstatSync, symlinkSync, unlinkSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stableCliPath } from "../extensions/tick/bin/paths.mjs";
import { getActiveRun, activeRunsDir } from "../extensions/tick/bin/run-registry.mjs";

const active = activeRunsDir();
let entries = [];
try { entries = readdirSync(active); } catch (err) { if (err.code !== "ENOENT") throw err; }
for (const file of entries) {
  if (file.endsWith(".json") && getActiveRun(file.slice(0, -5))) {
    throw new Error(`Wait for active job ${file.slice(0, -5)} before installing`);
  }
}
const binDir = process.env.PI_TICK_BIN_DIR || join(homedir(), ".local", "bin");
mkdirSync(binDir, { recursive: true });
const link = join(binDir, "pi-tick");
let existing;
try { existing = lstatSync(link); } catch (err) { if (err.code !== "ENOENT") throw err; }
if (existing && !existing.isSymbolicLink()) throw new Error(`Refusing to replace non-symlink ${link}`);
await import("./sync-cli.mjs");
if (existing) unlinkSync(link);
symlinkSync(stableCliPath(), link);
console.log(`Installed ${link}; add ${binDir} to PATH if needed.`);
