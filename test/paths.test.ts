import { test } from "node:test";
import assert from "node:assert/strict";
import { userInfo, tmpdir } from "node:os";
import { join } from "node:path";
import { dataDir } from "../extensions/tick/bin/paths.mjs";

// Issue #23: the suite must never touch the developer's real ~/.pi data.
// `npm test` sets HOME to a temp dir; the guard in dataDir() additionally
// refuses the passwd-database home (which ignores $HOME) under node --test.
const realHome = userInfo().homedir;

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

test("node --test sets NODE_TEST_CONTEXT (the guard's trigger)", () => {
  assert.ok(process.env.NODE_TEST_CONTEXT);
});

test("dataDir refuses the default location when HOME is the real home", () => {
  withEnv({ PI_TICK_DATA_DIR: undefined, HOME: realHome }, () => {
    assert.throws(() => dataDir(), /refusing to use real data dir/);
  });
});

test("dataDir refuses an explicit PI_TICK_DATA_DIR under the real ~/.pi", () => {
  withEnv({ PI_TICK_DATA_DIR: join(realHome, ".pi", "agent", "tick") }, () => {
    assert.throws(() => dataDir(), /refusing to use real data dir/);
  });
});

test("dataDir allows a temp dir under test", () => {
  const d = join(tmpdir(), "pi-tick-paths-test");
  withEnv({ PI_TICK_DATA_DIR: d }, () => assert.equal(dataDir(), d));
});
