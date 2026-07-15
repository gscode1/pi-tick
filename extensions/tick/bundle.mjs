// bundle.mjs — the manifest for the synced stable CLI.
//
// The standalone pi-tick CLI (synced to ~/.pi/agent/tick/ so launchd/cron can
// invoke it as a subprocess) needs every .mjs file in tick-core.mjs's static
// import closure installed alongside pi-tick.mjs. That list used to be
// hand-transcribed in three places — the extension's bundled*Path()
// functions, paths.mjs's installed*Path() functions, and one syncOneFile
// call per file — and a module split that forgot one of the three broke
// scheduled runs with a "Cannot find module" only a real launchd/cron fire
// would surface (issue #60).
//
// Deriving the manifest by walking bin/ removes the chance to forget: any
// .mjs file dropped under bin/ (including bin/backends/) is part of the
// bundle automatically.

import { readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir } from "./bin/paths.mjs";

function binDir() {
  return join(dirname(fileURLToPath(import.meta.url)), "bin");
}

// Every .mjs file under bin/, as paths relative to bin/ (e.g. "pi-tick.mjs",
// "backends/cron.mjs"). Sorted for determinism.
export function listBundleFiles() {
  const root = binDir();
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (entry.endsWith(".mjs")) out.push(relative(root, full));
    }
  };
  walk(root);
  return out.sort();
}

// Absolute path to a bundled (source-tree) file, given its bin/-relative path.
export function bundledPath(rel) {
  return join(binDir(), rel);
}

// Absolute path to where a bundled file is installed under the data dir,
// given its bin/-relative path. Mirrors bin/'s layout 1:1 (e.g.
// "backends/cron.mjs" installs to "<dataDir>/backends/cron.mjs").
export function installedPath(rel) {
  return join(dataDir(), rel);
}
