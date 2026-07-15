import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { runJob, pruneTranscripts } from "../extensions/tick/bin/runner.mjs";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, statSync, readFileSync, mkdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
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
