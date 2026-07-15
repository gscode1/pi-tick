// bin-resolve.mjs — binary/PATH discovery for the `node`/`pi` executables a
// job spawns. Has no dependency on the catalog, a command's argv, or
// dispatch — pure OS-PATH archaeology, used by the enable and run
// subcommands.

import { statSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export function which(bin) {
  const pathEnv = process.env.PATH || "";
  const dirs = pathEnv.split(":");
  for (const d of dirs) {
    if (!d) continue;
    const p = join(d, bin);
    try {
      const s = statSync(p);
      // Must be a regular file and executable by owner.
      if (s.isFile() && (s.mode & 0o111)) return p;
    } catch {
      // not found, try next
    }
  }
  return null;
}

export function resolveNodePath() {
  const fromPath = which("node");
  if (fromPath) return fromPath;
  // Fallbacks per PRD §9.3.
  const fallbacks = [
    join(homedir(), ".local", "share", "mise", "installs", "node"),
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
  ];
  for (const f of fallbacks) {
    try {
      const s = statSync(f);
      if (s.isFile()) return f;
    } catch {
      // try next
    }
    // If it's a directory, look for *first* nested bin/node
    try {
      const s = statSync(f);
      if (s.isDirectory()) {
        const subs = readdirSync(f);
        for (const sub of subs) {
          const cand = join(f, sub, "bin", "node");
          try {
            const ss = statSync(cand);
            if (ss.isFile()) return cand;
          } catch {
            // not found
          }
        }
      }
    } catch {
      // not found
    }
  }
  return null;
}

export function resolvePiPath() {
  return which("pi");
}

// Build a PATH for spawned children (and the launchd plist) that survives the
// minimal environment a launchd/cron job inherits. macOS launchd starts jobs
// with PATH=/usr/bin:/bin:/usr/sbin:/sbin, which omits Homebrew
// (/opt/homebrew/bin — where `tea`/`gh` live), ~/.local/bin, and the version-
// manager node dir. That is why a scheduled run fails with "forge: tea not
// installed" even though the tools resolve fine in an interactive shell.
//
// We DERIVE the good dirs rather than hardcoding a machine-specific string:
//  - the dir of the node running THIS process (process.execPath is absolute and
//    reliable even under launchd; mise/nvm/volta colocate node + pi there),
//  - resolved node/pi dirs when discoverable,
//  - ~/.local/bin and mise shims,
//  - both Homebrew prefixes (Apple-silicon /opt/homebrew, Intel /usr/local),
//  - whatever PATH the caller already had (rich at enable time),
//  - the POSIX system dirs last (always present).
// Order favors discovered tool dirs first; duplicates are dropped.
export function augmentedPath(base = process.env.PATH || "") {
  const home = homedir();
  const parts = [];
  const add = (d) => { if (d && !parts.includes(d)) parts.push(d); };
  if (process.execPath) add(dirname(process.execPath));
  const np = resolveNodePath(); if (np) add(dirname(np));
  const pp = resolvePiPath(); if (pp) add(dirname(pp));
  add(join(home, ".local", "bin"));
  add(join(home, ".local", "share", "mise", "shims"));
  add("/opt/homebrew/bin");
  add("/usr/local/bin");
  for (const d of base.split(":")) add(d);
  for (const d of ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]) add(d);
  return parts.join(":");
}
