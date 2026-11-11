// Shared test helpers. Kept minimal — no external deps.
//
// Usage:
//   import { setupEnv, withTempDir, writeStub } from "./_helpers.ts";
//
//   await withTempDir(async (dir) => {
//     const env = setupEnv({ dataDir: dir, plistDir: join(dir, "agents") });
//     // env.HOME, env.PI_TICK_DATA_DIR, env.PI_TICK_PLIST_DIR, env.PATH
//   });

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep, delimiter } from "node:path";
import { spawnSync } from "node:child_process";

export type TestEnv = {
  HOME: string;
  PI_TICK_DATA_DIR: string;
  PI_TICK_PLIST_DIR: string;
  PATH: string;
  __tmpDir: string;
  __stubDir: string;
};

export function withTempDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  return new Promise((resolve, reject) => {
    const dir = mkdtempSync(join(tmpdir(), "pi-tick-test-"));
    let result: T;
    let error: unknown;
    Promise.resolve()
      .then(() => fn(dir))
      .then((r) => { result = r; })
      .catch((e) => { error = e; })
      .finally(() => {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
        if (error !== undefined) reject(error);
        else resolve(result as T);
      });
  });
}

export function setupEnv(opts: {
  dataDir: string;
  plistDir: string;
  home?: string;
  pathPrepend?: string;
  isolatedPath?: boolean;
}): TestEnv {
  const tmpDir = opts.dataDir; // alias for clarity
  const stubDir = mkdtempSync(join(tmpdir(), "pi-tick-stubs-"));
  // By default, the test PATH is the stub dir only (no leak from the user's PATH).
  // Set isolatedPath: false to include the user's PATH (e.g. for tests that need the real `node`).
  const userPath = opts.isolatedPath === false ? (process.env.PATH ?? "") : "";
  // Always include basic system bin dirs so stub scripts can use
  // builtins like `rm` / `cat` / `env` (not just our test stubs).
  // Without this, stubs that try to truncate a file via `rm -f` would
  // silently fail and the file would just get appended to.
  const systemPath = "/usr/bin:/bin";
  return {
    HOME: opts.home ?? tmpDir,
    PI_TICK_DATA_DIR: opts.dataDir,
    PI_TICK_PLIST_DIR: opts.plistDir,
    PATH: [opts.pathPrepend ?? stubDir, systemPath, userPath].filter(Boolean).join(delimiter),
    __tmpDir: tmpDir,
    __stubDir: stubDir,
  };
}

// Cleanup the stub dir when done.
export function teardownEnv(env: TestEnv) {
  try { rmSync(env.__stubDir, { recursive: true, force: true }); } catch { /* */ }
}

// Write a stub script into the stub dir with the given name (no extension).
// The script is the body of a shell script (a shebang is added automatically)
// and is chmod +x'd. Uses /bin/sh for portability — tests must use POSIX syntax.
export function writeStub(env: TestEnv, name: string, body: string, opts: { log?: string } = {}): string {
  const path = join(env.__stubDir, name);
  const logPath = opts.log ? join(env.__stubDir, opts.log) : null;
  // Use /bin/sh (POSIX) so the test works in an isolated PATH where bash is absent.
  const shebang = "#!/bin/sh\n";
  // `set -e` is intentionally omitted; tests want to control exit codes.
  // We pre-truncate the log so stale entries from prior runs don't leak.
  if (logPath) {
    try { writeFileSync(logPath, "", "utf8"); } catch { /* */ }
  }
  const prelude = logPath
    ? `LOG="${logPath}"\nlog() { echo "$@" >> "$LOG"; }\n`
    : "";
  writeFileSync(path, shebang + prelude + body + "\n", { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

// Read a stub's log file.
export function readStubLog(env: TestEnv, name: string): string {
  const p = join(env.__stubDir, name);
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

// Run a function with a clean env, restoring the original env after.
export function withEnv<T>(env: TestEnv, fn: () => Promise<T> | T): Promise<T> {
  const saved = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith("__")) continue;
    process.env[k] = String(v);
  }
  return Promise.resolve()
    .then(() => fn())
    .finally(() => {
      for (const k of Object.keys(process.env)) {
        if (!(k in saved)) delete process.env[k];
      }
      for (const [k, v] of Object.entries(saved)) {
        process.env[k] = v as string;
      }
    });
}

// Run a node subprocess with the given env, capturing stdout/stderr/exitCode.
export function runNode(script: string, args: string[], env: TestEnv): { stdout: string; stderr: string; code: number } {
  const fullEnv = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith("__")) continue;
    fullEnv[k] = String(v);
  }
  const result = spawnSync(process.execPath, [script, ...args], {
    env: fullEnv,
    encoding: "utf8",
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    code: result.status ?? 1,
  };
}

// Get the absolute path of the CLI.
export function cliScript(): string {
  return new URL("../extensions/tick/bin/pi-tick.mjs", import.meta.url).pathname;
}

// Reset process.env to a known state for direct module tests.
export function importCliFresh() {
  // Re-import the CLI module with the current env.
  // Cache-bust via query string.
  return import(`../extensions/tick/bin/pi-tick.mjs?t=${Date.now()}`);
}

// Validate a file's mode.
export function fileMode(path: string): number {
  return statSync(path).mode & 0o777;
}
