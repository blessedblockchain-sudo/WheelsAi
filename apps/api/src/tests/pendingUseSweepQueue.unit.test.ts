import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import "./unitEnv.js";
import { env } from "../config/env.js";
import {
  PENDING_USE_SWEEP_JOB_KEY,
  PENDING_USE_SWEEP_QUEUE,
  schedulePendingUseSweep,
  type RepeatableSchedule,
} from "../queues/pending-use-sweep.queue.js";

// The sweeper for charges per use runs: its setting, its schedule, and where
// the server starts and stops it. Nothing here opens a connection.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const source = (relative: string) => readFileSync(path.join(HERE, "..", relative), "utf8");

function fakeQueue(repeatable: Array<{ key: string; name: string }>) {
  const removed: string[] = [];
  const added: Array<{ name: string; opts: { repeat: { every: number }; jobId: string } }> = [];
  const target: RepeatableSchedule = {
    getRepeatableJobs: async () => repeatable,
    removeRepeatableByKey: async (key) => {
      removed.push(key);
    },
    add: async (name, _data, opts) => {
      added.push({ name, opts });
    },
  };
  return { target, removed, added };
}

const OLD_TICK = { key: "pending-use-sweep-tick:::60000", name: PENDING_USE_SWEEP_JOB_KEY };
const SOMEONE_ELSES = { key: "another-tick:::1000", name: "another-tick" };

test("with 0 nothing is scheduled and an old repeatable job is removed", async () => {
  const queue = fakeQueue([OLD_TICK, SOMEONE_ELSES]);
  assert.equal(await schedulePendingUseSweep(queue.target, 0), false);
  assert.deepEqual(queue.removed, [OLD_TICK.key]);
  assert.deepEqual(queue.added, []);
});

test("above 0 the old tick is replaced by one at the interval that is set", async () => {
  const queue = fakeQueue([OLD_TICK, SOMEONE_ELSES]);
  assert.equal(await schedulePendingUseSweep(queue.target, 45_000), true);
  assert.deepEqual(queue.removed, [OLD_TICK.key]);
  assert.deepEqual(queue.added, [
    { name: PENDING_USE_SWEEP_JOB_KEY, opts: { repeat: { every: 45_000 }, jobId: PENDING_USE_SWEEP_JOB_KEY } },
  ]);
});

test("a first start schedules one tick and removes nothing", async () => {
  const queue = fakeQueue([]);
  assert.equal(await schedulePendingUseSweep(queue.target, 60_000), true);
  assert.deepEqual(queue.removed, []);
  assert.equal(queue.added.length, 1);
});

test("the setting exists, is on by default at one minute, and 0 is allowed", () => {
  assert.match(
    source("config/env.ts"),
    /PENDING_USE_SWEEP_INTERVAL_MS: z\.coerce\.number\(\)\.int\(\)\.min\(0\)\.default\(60_000\)/,
  );
  assert.equal(env.PENDING_USE_SWEEP_INTERVAL_MS, 60_000);
});

test("the queue reads the setting, and a switched-off start opens no worker", () => {
  const queue = source("queues/pending-use-sweep.queue.ts");
  assert.match(queue, /const every = env\.PENDING_USE_SWEEP_INTERVAL_MS;/);
  const start = queue.slice(queue.indexOf("export async function startPendingUseSweepQueue"));
  assert.ok(
    start.indexOf("schedulePendingUseSweep(queue, every)") < start.indexOf("new Worker("),
    "the schedule is decided before a worker is opened",
  );
  assert.match(start, /if \(!\(await schedulePendingUseSweep\(queue, every\)\)\) \{\s+await queue\.close\(\);\s+queue = null;[^}]+return;/);
  assert.equal(PENDING_USE_SWEEP_QUEUE, "pending-use-sweep");
});

test("index.ts starts and stops the sweeper where the trial-charge reaper is", () => {
  const index = source("index.ts");
  assert.match(index, /await startTrialChargeReapQueue\(\);\n\s+await startPendingUseSweepQueue\(\);/);
  assert.match(index, /await stopTrialChargeReapQueue\(\);\n\s+await stopPendingUseSweepQueue\(\);/);
});

test("the queues barrel exports the sweeper's start and stop", async () => {
  const queues = await import("../queues/index.js");
  assert.equal(typeof queues.startPendingUseSweepQueue, "function");
  assert.equal(typeof queues.stopPendingUseSweepQueue, "function");
});
