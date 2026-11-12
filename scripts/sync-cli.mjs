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

import { copyFileSync, existsSync, chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { bundledPath, installedPath, listBundleFiles } from "../extensions/tick/bundle.mjs";

const files = listBundleFiles();
const cliSource = bundledPath("pi-tick.mjs");
if (!existsSync(cliSource)) {
  process.stderr.write(`sync-cli: bundled CLI not found at ${cliSource}\n`);
  process.exit(1);
}

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

let changed = false;
for (const rel of files) {
  if (syncOne(bundledPath(rel), installedPath(rel))) changed = true;
}

const verb = changed ? "synced" : "up-to-date";
process.stdout.write(`sync-cli: ${verb} ${installedPath("pi-tick.mjs")}\n`);

