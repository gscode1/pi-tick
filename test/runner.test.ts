import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { runJob, pruneTranscripts } from "../extensions/tick/bin/runner.mjs";
import { loadCatalog, saveCatalog } from "../extensions/tick/bin/catalog.mjs";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, statSync, readFileSync, mkdirSync, utimesSync, chmodSync, symlinkSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

let tempDir;
let originalDataDir;

before(() => {
  tempDir = mkdtempSync(join(tmpdir(), "pi-tick-test-"));
  originalDataDir = process.env.PI_TICK_DATA_DIR;
  process.env.PI_TICK_DATA_DIR = tempDir;
});

after(() => {
  if (originalDataDir === undefined) {
    delete process.env.PI_TICK_DATA_DIR;
  } else {
    process.env.PI_TICK_DATA_DIR = originalDataDir;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

function createMockChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = (signal) => {
    if (child.killedWith !== undefined) return; // a real child closes once
    child.killedWith = signal;
    child.emit("close", null, signal);
  };
  return child;
}

function getDefaultOptions() {
  return {
    nodePath: "/usr/bin/node",
    piPath: "/usr/bin/pi",
    transcriptsDir: join(tempDir, "transcripts"),
    logsDir: join(tempDir, "logs"),
    envPath: "/usr/bin",
    stderr: { write: () => {} },
  };
}

const defaultJob = {
  id: "test-job",
  prompt: "do something",
  cwd: "/tmp",
};

test("runJob - exit_code", async () => {
  let child;
  const res = await runJob(defaultJob, "external", {
    ...getDefaultOptions(),
    spawnFn: () => {
      child = createMockChild();
      setTimeout(() => child.emit("close", 0, null), 10);
      return child;
    }
  });
  assert.equal(res.exitCode, 0);
  assert.equal(res.reason, "exit_code");
});

function assistantEnd(extra) {
  return JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], usage: { input: 0, output: 0 }, ...extra } }) + "\n";
}

test("runJob - model_error when final assistant message errored but pi exits 0", async () => {
  const res = await runJob(defaultJob, "external", {
    ...getDefaultOptions(),
    spawnFn: () => {
      const child = createMockChild();
      setTimeout(() => {
        child.stdout.emit("data", Buffer.from(assistantEnd({ stopReason: "error", errorMessage: "Codex error: model not supported" })));
        child.emit("close", 0, null);
      }, 10);
      return child;
    }
  });
  assert.equal(res.reason, "model_error");
  assert.equal(res.exitCode, 1);
  assert.equal(res.error, "Codex error: model not supported");
});

test("runJob - an errored message followed by a successful one stays a success", async () => {
  const res = await runJob(defaultJob, "external", {
    ...getDefaultOptions(),
    spawnFn: () => {
      const child = createMockChild();
      setTimeout(() => {
        child.stdout.emit("data", Buffer.from(assistantEnd({ stopReason: "error", errorMessage: "transient" })));
        child.stdout.emit("data", Buffer.from(assistantEnd({ stopReason: "stop", content: [{ type: "text", text: "OK" }] })));
        child.emit("close", 0, null);
      }, 10);
      return child;
    }
  });
  assert.equal(res.reason, "exit_code");
  assert.equal(res.exitCode, 0);
  assert.equal(res.error, null);
  assert.equal(res.finalTextPreview, "OK");
});

// Issue #55 — cmdAdd now stores `null` (not an evaluated default) for
// timeoutMs/idleTimeoutMs/maxOutputBytes/killGraceMs when the user omits
// the flag. runJob must treat a stored null exactly like the field being
// absent: fall back to its own DEFAULT_* constant, not NaN/0/immediate-kill.
test("runJob falls back to its own defaults when runtime-control fields are explicitly null", async () => {
  let child;
  const res = await runJob(
    { ...defaultJob, timeoutMs: null, idleTimeoutMs: null, maxOutputBytes: null, killGraceMs: null },
    "external",
    {
      ...getDefaultOptions(),
      spawnFn: () => {
        child = createMockChild();
        setTimeout(() => child.emit("close", 0, null), 10);
        return child;
      },
    },
  );
  assert.equal(res.exitCode, 0);
  assert.equal(res.reason, "exit_code");
});

test("runJob - spawn_error", async () => {
  let child;
  const res = await runJob(defaultJob, "external", {
    ...getDefaultOptions(),
    spawnFn: () => {
      child = createMockChild();
      setTimeout(() => {
        child.emit("error", new Error("ENOENT"));
        child.emit("close", -1, null);
      }, 10);
      return child;
    }
  });
  assert.equal(res.exitCode, 1);
  assert.equal(res.reason, "spawn_error");
  assert.equal(res.error, "spawn failed: ENOENT");
});

test("runJob records a synchronous spawn failure", async () => {
  const job = { ...defaultJob, id: "sync-spawn-failure" };
  saveCatalog({ version: 1, jobs: [job] });

  const res = await runJob(job, "external", {
    ...getDefaultOptions(),
    spawnFn: () => { throw new Error("ENOENT"); },
  });

  assert.equal(res.exitCode, 1);
  assert.equal(res.reason, "spawn_error");
  assert.equal(res.transcriptPath && statSync(res.transcriptPath).isFile(), true);
  const records = readFileSync(join(tempDir, "runs.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(records.some(record => record.runId === res.runId && record.reason === "spawn_error"));
  assert.equal(loadCatalog().jobs[0].lastRun.reason, "spawn_error");
});

test("runJob treats transcript setup failure as a failed run", async () => {
  const blocked = join(tempDir, "not-a-directory");
  writeFileSync(blocked, "x");
  let child;
  const res = await runJob(defaultJob, "external", {
    ...getDefaultOptions(),
    transcriptsDir: blocked,
    spawnFn: () => {
      child = createMockChild();
      setTimeout(() => child.emit("close", 0, null), 10);
      return child;
    },
  });

  assert.equal(res.exitCode, 1);
  assert.match(res.error, /^transcript write failed:/);
  assert.equal(res.transcriptPath, null);
});

test("runJob treats timeoutMs 0 as disabled (child outliving a tiny interval is not killed)", async () => {
  let child;
  const res = await runJob({ ...defaultJob, timeoutMs: 0 }, "external", {
    ...getDefaultOptions(),
    spawnFn: () => {
      child = createMockChild();
      setTimeout(() => child.emit("close", 0, null), 150);
      return child;
    },
  });
  assert.equal(res.exitCode, 0);
  assert.equal(res.reason, "exit_code");
  assert.equal(child.killedWith, undefined);
});

test("runJob - timeout", async () => {
  let child;
  const job = { ...defaultJob, timeoutMs: 50 };
  const res = await runJob(job, "external", {
    ...getDefaultOptions(),
    spawnFn: () => {
      child = createMockChild();
      return child;
    }
  });
  
  assert.equal(res.exitCode, 124);
  assert.equal(res.reason, "timeout");
  assert.equal(res.error, "timeout");
  assert.equal(child.killedWith, "SIGTERM");
});

test("runJob - idle_timeout", async () => {
  let child;
  const job = { ...defaultJob, idleTimeoutMs: 50 };
  const res = await runJob(job, "external", {
    ...getDefaultOptions(),
    spawnFn: () => {
      child = createMockChild();
      return child;
    }
  });
  
  assert.equal(res.exitCode, 124);
  assert.equal(res.reason, "idle_timeout");
  assert.equal(res.error, "idle_timeout");
  assert.equal(child.killedWith, "SIGTERM");
});

test("runJob - output_cap", async () => {
  let child;
  const job = { ...defaultJob, maxOutputBytes: 5 };
  const res = await runJob(job, "external", {
    ...getDefaultOptions(),
    spawnFn: () => {
      child = createMockChild();
      setTimeout(() => {
        child.stdout.emit("data", Buffer.from("1234567890"));
      }, 10);
      return child;
    }
  });
  
  assert.equal(res.exitCode, 124);
  assert.equal(res.reason, "output_cap");
  assert.equal(res.error, "output_cap");
  assert.equal(child.killedWith, "SIGTERM");
});

// Issue #56 — chunk.toString("utf8") before capping corrupted multi-byte
// UTF-8 characters that straddle a chunk boundary into U+FFFD. A
// StringDecoder per stream now absorbs the boundary instead.
test("runJob decodes a multi-byte UTF-8 character split across two chunks correctly", async () => {
  let child;
  const fullBuf = Buffer.from("café", "utf8"); // "é" is 2 bytes (0xC3 0xA9)
  const splitAt = fullBuf.length - 1; // splits inside the 2-byte "é"
  const chunk1 = fullBuf.subarray(0, splitAt);
  const chunk2 = fullBuf.subarray(splitAt);
  const res = await runJob(defaultJob, "external", {
    ...getDefaultOptions(),
    spawnFn: () => {
      child = createMockChild();
      setTimeout(() => {
        child.stdout.emit("data", chunk1);
        setTimeout(() => {
          child.stdout.emit("data", chunk2);
          setTimeout(() => child.emit("close", 0, null), 10);
        }, 10);
      }, 10);
      return child;
    },
  });
  assert.equal(res.exitCode, 0);
  const content = readFileSync(res.transcriptPath, "utf8");
  assert.equal(content, "café", "multi-byte char split across chunks must decode cleanly");
  assert.ok(!content.includes("�"), "no replacement characters from a torn chunk boundary");
});

// Issue #56 — capping by character count on a multi-byte string let more
// bytes through than maxOutputBytes allows (the cap is a byte cap). Caps
// must now be enforced on the raw Buffer (chunk.subarray), before decoding.
test("runJob caps stdout by BYTES, not characters, for multi-byte content", async () => {
  let child;
  const job = { ...defaultJob, maxOutputBytes: 3 };
  const fullInput = Buffer.from("éé", "utf8"); // 4 bytes, 2 characters
  const res = await runJob(job, "external", {
    ...getDefaultOptions(),
    spawnFn: () => {
      child = createMockChild();
      setTimeout(() => child.stdout.emit("data", fullInput), 10);
      return child;
    },
  });
  assert.equal(res.reason, "output_cap");
  const transcriptBytes = statSync(res.transcriptPath).size;
  assert.ok(
    transcriptBytes < fullInput.length,
    `transcript (${transcriptBytes}B) must be capped below the full input (${fullInput.length}B) — ` +
      `a character-count cap would let the whole multi-byte chunk through uncapped`,
  );
});

test("runJob - signal", async () => {
  let child;
  const res = await runJob(defaultJob, "external", {
    ...getDefaultOptions(),
    spawnFn: () => {
      child = createMockChild();
      setTimeout(() => child.emit("close", null, "SIGINT"), 10);
      return child;
    }
  });
  assert.equal(res.exitCode, 1);
  assert.equal(res.reason, "signal");
  assert.equal(res.error, "killed by SIGINT");
});

test("runJob - async transcripts write", async () => {
  let child;
  const opts = getDefaultOptions();
  const res = await runJob(defaultJob, "external", {
    ...opts,
    spawnFn: () => {
      child = createMockChild();
      setTimeout(() => {
        child.stdout.emit("data", Buffer.from("hello world\n"));
        setTimeout(() => child.emit("close", 0, null), 10);
      }, 10);
      return child;
    }
  });
  
  assert.equal(res.exitCode, 0);
  assert.ok(res.transcriptPath);
  
  const content = readFileSync(res.transcriptPath, "utf8");
  assert.equal(content, "hello world\n");
});

test("pruneTranscripts - eviction logic", () => {
  const tDir = join(tempDir, "transcripts_test_prune");
  const jobDir = join(tDir, "test-job");
  
  const now = Date.now();
  const writeOld = (name, ageDays, size) => {
    const p = join(jobDir, name);
    writeFileSync(p, Buffer.alloc(size));
    // Set mtime
    const mtime = new Date(now - ageDays * 86400 * 1000);
    utimesSync(p, mtime, mtime);
  };
  
  
  mkdirSync(jobDir, { recursive: true });
  
  // Write old file (should be deleted by age, > 7 days)
  writeOld("old1.jsonl", 10, 10);
  
  // Write new files (should be kept by age, but oldest deleted by size cap)
  writeOld("new1.jsonl", 2, 100); // oldest new
  writeOld("new2.jsonl", 1, 100); // newest new
  
  // Prune with a max size of 150 bytes
  pruneTranscripts("test-job", tDir, { now, maxBytes: 150 });
  
  const files = readdirSync(jobDir);
  assert.ok(!files.includes("old1.jsonl"), "old file should be pruned by age");
  assert.ok(!files.includes("new1.jsonl"), "new1 should be pruned by size");
  assert.ok(files.includes("new2.jsonl"), "new2 should be kept");
  });

// Exercise real OS process launching: the old node <pi> path failed on the
// Homebrew shell wrapper, even though the mocked spawn tests passed.
for (const kind of ["homebrew-wrapper", "npm-shebang", "npm-symlink", "native"]) {
  test(`runJob launches an executable ${kind} with literal argv`, async () => {
    const dir = join(tempDir, kind + " space;literal");
    mkdirSync(dir);
    const argvFile = join(dir, "argv.json");
    const js = join(dir, "cli.mjs");
    writeFileSync(js, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "LAUNCH_OK" }] } }));
`, { mode: 0o755 });
    const piPath = kind === "native" ? "/bin/echo" : join(dir, "pi");
    if (kind === "homebrew-wrapper") {
      // Match Homebrew's environment assignment + exec wrapper.
      writeFileSync(piPath, `#!/bin/bash\nPI_SKIP_VERSION_CHECK="1" exec '${process.execPath}' '${js}' "$@"\n`, { mode: 0o755 });
    } else if (kind === "npm-symlink") {
      symlinkSync(js, piPath);
    } else if (kind === "npm-shebang") {
      writeFileSync(piPath, readFileSync(js), { mode: 0o755 });
    }
    const sentinel = join(dir, "INJECTED");
    const prompt = `literal spaces ' " ; touch ${sentinel}; $(touch ${sentinel}) \`touch ${sentinel}\`\nnext line`;
    const result = await runJob({ ...defaultJob, id: kind, prompt, cwd: dir }, "manual", {
      ...getDefaultOptions(),
      nodePath: process.execPath, // A real Node must not parse a shell/native launcher.
      piPath,
      envPath: `${dirname(process.execPath)}:/usr/bin:/bin`,
    });
    assert.equal(result.exitCode, 0, result.error ?? "launcher failed");
    assert.equal(existsSync(sentinel), false, "prompt must never be interpreted by a shell");
    const expected = ["--mode", "json", "-p", "--no-session", prompt];
    if (kind === "native") {
      assert.equal(readFileSync(result.transcriptPath, "utf8"), expected.join(" ") + "\n");
    } else {
      assert.deepEqual(JSON.parse(readFileSync(argvFile, "utf8")), expected);
      assert.match(readFileSync(result.transcriptPath, "utf8"), /LAUNCH_OK/);
    }
  });
}

test("runJob records permission failure without interpreting a nonexecutable launcher", async () => {
  const piPath = join(tempDir, "nonexecutable-pi");
  writeFileSync(piPath, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
  chmodSync(piPath, 0o644);
  const result = await runJob({ ...defaultJob, id: "nonexecutable" }, "manual", {
    ...getDefaultOptions(), nodePath: process.execPath, piPath,
  });
  assert.equal(result.reason, "spawn_error");
  assert.match(result.error, /EACCES/);
});

// ─── Issues #20 / #21 ───────────────────────────────────────────────────
function writeShStub(name: string, body: string): string {
  const p = join(tempDir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return p;
}

test("runJob never arms a timer above 2^31-1 ms (legacy 4294967295 catalog value)", async () => {
  const piPath = writeShStub("slow-pi-legacy", "sleep 0.3\nexit 0");
  const res = await runJob(
    { ...defaultJob, id: "legacy-limits", timeoutMs: 4294967295, idleTimeoutMs: 4294967295, killGraceMs: 4294967295 },
    "manual",
    { ...getDefaultOptions(), piPath, envPath: "/usr/bin:/bin" },
  );
  assert.equal(res.reason, "exit_code", res.error ?? "");
  assert.equal(res.exitCode, 0);
});

test("runJob survives EPIPE on stdin for slash-command jobs", async () => {
  const piPath = writeShStub("epipe-pi", "exec 0<&-\nsleep 0.5\nexit 0");
  for (let i = 0; i < 3; i++) {
    const res = await runJob(
      { ...defaultJob, id: `epipe-${i}`, prompt: "/cmd x" },
      "manual",
      { ...getDefaultOptions(), piPath, envPath: "/usr/bin:/bin" },
    );
    assert.equal(res.exitCode, 0, res.error ?? "");
    assert.equal(res.reason, "exit_code");
  }
});

test("runJob parses a final stdout line without a trailing newline", async () => {
  const line = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "boom" } });
  const piPath = writeShStub("nonl-pi", `printf '%s' '${line}'\nexit 0`);
  const res = await runJob({ ...defaultJob, id: "no-trailing-nl" }, "manual", {
    ...getDefaultOptions(), piPath, envPath: "/usr/bin:/bin",
  });
  assert.equal(res.reason, "model_error");
});

test("runJob: a child 'error' after spawn is not recorded as spawn_error", async () => {
  const res = await runJob(defaultJob, "external", {
    ...getDefaultOptions(),
    spawnFn: () => {
      const child = createMockChild();
      child.pid = 999999; // spawned: has a pid (never signalled in this test)
      setTimeout(() => {
        child.emit("error", new Error("kill failed"));
        child.emit("close", 0, null);
      }, 10);
      return child;
    },
  });
  assert.equal(res.exitCode, 0);
  assert.equal(res.reason, "exit_code");
});
