#!/usr/bin/env node
// scripts/sync-cli.mjs — copy the bundled CLI (and its backends/) to the
// stable path.
//
// `npm run sync` (or `node scripts/sync-cli.mjs`) is the dev-loop shortcut
// for getting edited files into the install location that the slash
// commands and launchd plist / crontab reference, without having to
// reinstall the package or open a pi session.
//
// In production, the extension's session_start handler does this same
// copy. This script just makes the dev loop faster.

import { copyFileSync, existsSync, statSync, chmodSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { backendsDir, dataDir, installedPathsPath, installedCorePath } from "../extensions/tick/bin/paths.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const src = join(pkgRoot, "extensions", "tick", "bin", "pi-tick.mjs");
const coreSrc = join(pkgRoot, "extensions", "tick", "bin", "tick-core.mjs");
const backendsSrc = join(pkgRoot, "extensions", "tick", "bin", "backends");
const pathsSrc = join(pkgRoot, "extensions", "tick", "bin", "paths.mjs");
const runnerSrc = join(pkgRoot, "extensions", "tick", "bin", "runner.mjs");
const catalogSrc = join(pkgRoot, "extensions", "tick", "bin", "catalog.mjs");

if (!existsSync(src)) {
  process.stderr.write(`sync-cli: bundled CLI not found at ${src}\n`);
  process.exit(1);
}

// Stable path: respect PI_TICK_DATA_DIR (used by tests), default to the real one.
const dataDirValue = dataDir();
const dest = join(dataDirValue, "pi-tick.mjs");
const coreDest = installedCorePath();
const backendsDest = backendsDir();
const pathsDest = installedPathsPath();
const runnerDest = join(dataDirValue, "runner.mjs");
const catalogDest = join(dataDirValue, "catalog.mjs");

function syncOne(srcPath, destPath) {
  if (!existsSync(srcPath)) return false;
  let needsWrite = true;
  if (existsSync(destPath)) {
    try {
      const a = readFileSync(srcPath);
      const b = readFileSync(destPath);
      if (a.equals(b)) needsWrite = false;
    } catch { /* fall through */ }
  }
  if (needsWrite) {
    mkdirSync(dirname(destPath), { recursive: true, mode: 0o700 });
    copyFileSync(srcPath, destPath);
  }
  try { chmodSync(destPath, 0o755); } catch { /* best effort */ }
  return needsWrite;
}

const cliChanged = syncOne(src, dest);
const coreChanged = syncOne(coreSrc, coreDest);
const pathsChanged = syncOne(pathsSrc, pathsDest);
const runnerChanged = syncOne(runnerSrc, runnerDest);
const catalogChanged = syncOne(catalogSrc, catalogDest);

// Sync the backends/ subdirectory. The dir may not exist yet on a fresh
// install.
let backendsChanged = false;
if (existsSync(backendsSrc)) {
  mkdirSync(backendsDest, { recursive: true, mode: 0o700 });
  for (const f of readdirSync(backendsSrc)) {
    if (f.endsWith(".mjs")) {
      if (syncOne(join(backendsSrc, f), join(backendsDest, f))) backendsChanged = true;
    }
  }
}

const verb = (cliChanged || coreChanged || pathsChanged || runnerChanged || catalogChanged || backendsChanged) ? "synced" : "up-to-date";
process.stdout.write(`sync-cli: ${verb} ${dest}\n`);

