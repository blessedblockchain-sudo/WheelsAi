import assert from "node:assert/strict";
import test from "node:test";
import { NosanaCreditsError } from "../services/nosanaCredits.js";
import {
  createAndStartDeployment,
  creditsFunding,
  ensureVaultRunway,
  NosanaLifecycleError,
  reclaimVault,
  scaleDeployment,
  stopAndReclaim,
  vaultFunding,
  type DeploymentState,
  type NosanaDeploymentsPort,
  type SdkDeploymentLike,
  DRAFT_START_HOLD_MS,
  startMayBeInFlight,
} from "../services/nosanaDeploymentLifecycle.js";

// The funding seam with CREDITS funding (API-key access), over a fake port:
// no vault exists, nothing is topped up or withdrawn, the gate runs before
// anything is created and "released" is decided from Nosana's state. The
// wallet path through the same seam is pinned by nosanaDeploymentLifecycle.unit.test.ts.

const MARKET = "7AtiXMSH6R1jjBxrcYjehCkkSF7zvYWte63gwEDBcGHq";
const ALL_STATES: Array<[string, DeploymentState]> = [
  ["DRAFT", "draft"],
  ["STARTING", "starting"],
  ["RUNNING", "running"],
  ["STOPPING", "stopping"],
  ["STOPPED", "stopped"],
  ["INSUFFICIENT_FUNDS", "insufficient_funds"],
  ["ERROR", "error"],
  ["ARCHIVED", "archived"],
];

interface FakeOpts {
  status?: string;
  /** What a successful stop() leaves the deployment in. Default STOPPING. */
  afterStop?: string;
  stopError?: Error;
  startError?: Error;
  createError?: Error;
  getErrorAfterFirst?: Error;
  replicas?: number;
}

/** A port whose deployments have NO vault, like the SDK's API-key objects. */
function fakePort(opts: FakeOpts = {}) {
  const ops: string[] = [];
  const state = { status: opts.status ?? "DRAFT", replicas: opts.replicas ?? 1, gets: 0 };
  const deployment = (): SdkDeploymentLike => ({
    id: "dm_credits",
    // A snapshot, as the SDK returns: it does not follow later server changes.
    status: state.status,
    replicas: state.replicas,
    start: async () => {
      ops.push("start");
      if (opts.startError) throw opts.startError;
      state.status = "STARTING";
    },
    stop: async () => {
      ops.push("stop");
      if (opts.stopError) throw opts.stopError;
      state.status = opts.afterStop ?? "STOPPING";
    },
    updateReplicaCount: async (n: number) => {
      ops.push(`scale:${n}`);
      state.replicas = n;
    },
  });
  const port: NosanaDeploymentsPort = {
    create: async () => {
      ops.push("create");
      if (opts.createError) throw opts.createError;
      return deployment();
    },
    get: async (id: string) => {
      ops.push(`get:${id}`);
      state.gets += 1;
      if (opts.getErrorAfterFirst && state.gets > 1) throw opts.getErrorAfterFirst;
      return deployment();
    },
    getMarketJobPrice: async () => {
      ops.push("getMarket");
      throw new Error("the chain price must never be read with credits");
    },
  };
  return { port, ops, state };
}

function funding(opts: { availableMicroUsd?: bigint; cost?: bigint; min?: bigint; balanceError?: Error } = {}) {
  const calls = { balance: 0, cached: 0, cost: [] as string[] };
  const f = creditsFunding({
    getAvailableMicroUsd: async () => {
      calls.balance += 1;
      if (opts.balanceError) throw opts.balanceError;
      return opts.availableMicroUsd ?? 100_000_000n;
    },
    getCachedAvailableMicroUsd: async () => {
      calls.cached += 1;
      if (opts.balanceError) throw opts.balanceError;
      return opts.availableMicroUsd ?? 100_000_000n;
    },
    costMicroUsdPerSecond: async (market) => {
      calls.cost.push(market);
      return opts.cost ?? 14n;
    },
    minMicroUsd: opts.min ?? 5_000_000n,
  });
  return { f, calls };
}

const PARAMS = {
  name: "wheelsai-model-abc",
  marketAddress: MARKET,
  replicas: 1,
  jobTimeoutSeconds: 7200,
  definition: { ops: [] },
  fundSeconds: 7200,
};

function lifecycleError(code: string, stage?: string) {
  return (err: unknown) =>
    err instanceof NosanaLifecycleError && err.code === code && (stage === undefined || err.stage === stage);
}

// ============================================
// create -> start
// ============================================

test("credits create: gate, create, start - no chain price, no vault, an estimate instead of a plan", async () => {
  const { port, ops } = fakePort();
  const { f, calls } = funding();
  const result = await createAndStartDeployment(port, PARAMS, f);

  assert.deepEqual(ops, ["create", "start"]);
  assert.deepEqual(calls.cost, [MARKET]);
  assert.equal(calls.balance, 1, "the balance is read once, fresh");
  assert.equal(calls.cached, 0, "a cached balance never admits a deployment");
  assert.equal(result.deploymentId, "dm_credits");
  assert.equal(result.vaultAddress, undefined);
  assert.equal(result.funding, null);
  assert.equal(result.fundingKind, "credits");
  assert.equal(result.estimateMicroUsd, 14n * 7200n);
  assert.equal(result.strategy, "SIMPLE-EXTEND");
});

test("credits create: a balance below estimate + floor refuses BEFORE anything is created", async () => {
  const { port, ops } = fakePort();
  // estimate 100800 + floor 5000000 = 5100800 needed
  const { f } = funding({ availableMicroUsd: 5_100_799n });
  await assert.rejects(createAndStartDeployment(port, PARAMS, f), (err: unknown) => {
    assert.ok(lifecycleError("nosana_credits_low", "create")(err));
    assert.equal((err as NosanaLifecycleError).mayExistOnNosana, false, "nothing was sent to Nosana");
    assert.doesNotMatch((err as Error).message, /\d/, "no amount in a message that can reach a user");
    return true;
  });
  assert.deepEqual(ops, []);

  const exact = funding({ availableMicroUsd: 5_100_800n });
  await createAndStartDeployment(port, PARAMS, exact.f);
  assert.deepEqual(ops, ["create", "start"]);
});

test("credits create: an unreadable balance fails closed, with the reason kept", async () => {
  for (const [error, code] of [
    [new NosanaCreditsError("nosana_credits_unavailable", "HTTP 500"), "nosana_credits_unavailable"],
    [new NosanaCreditsError("nosana_auth_failed", "HTTP 401"), "nosana_auth_failed"],
    [new Error("socket hang up"), "nosana_credits_unavailable"],
  ] as const) {
    const { port, ops } = fakePort();
    const { f } = funding({ balanceError: error });
    await assert.rejects(createAndStartDeployment(port, PARAMS, f), lifecycleError(code, "create"));
    assert.deepEqual(ops, [], `${code}: nothing created`);
  }
});

test("credits create: the estimate scales with replicas and fundSeconds", async () => {
  const { port } = fakePort();
  const { f } = funding({ cost: 112n });
  const result = await createAndStartDeployment(port, { ...PARAMS, replicas: 3, fundSeconds: 21_600, jobTimeoutSeconds: 21_600 }, f);
  assert.equal(result.estimateMicroUsd, 112n * 3n * 21_600n);
});

test("a throw at the create stage is flagged 'may exist on Nosana' and carries the name", async () => {
  // The SDK parses `owner` as a public key AFTER the server created the deployment.
  const { port, ops } = fakePort({ createError: new Error("Non-base58 character") });
  const { f } = funding();
  await assert.rejects(createAndStartDeployment(port, PARAMS, f), (err: unknown) => {
    assert.ok(lifecycleError("nosana_create_failed", "create")(err));
    const e = err as NosanaLifecycleError;
    assert.equal(e.mayExistOnNosana, true);
    assert.equal(e.deploymentName, "wheelsai-model-abc");
    assert.equal(e.deploymentId, undefined);
    return true;
  });
  assert.deepEqual(ops, ["create"]);

  // The same flag in wallet mode: the parse happens there too.
  const wallet = fakePort({ createError: new Error("Non-base58 character") });
  wallet.port.getMarketJobPrice = async () => 24n;
  await assert.rejects(
    createAndStartDeployment(wallet.port, PARAMS),
    (err: unknown) => err instanceof NosanaLifecycleError && err.mayExistOnNosana && err.deploymentName === PARAMS.name,
  );
});

test("every create sends its idempotency key (the name unless given); a key Nosana would refuse creates nothing", async () => {
  const bodies: unknown[] = [];
  const { port, ops } = fakePort();
  const create = port.create;
  port.create = async (body) => {
    bodies.push(body);
    return create(body);
  };
  await createAndStartDeployment(port, PARAMS, funding().f);
  await createAndStartDeployment(port, { ...PARAMS, idempotencyKey: "wheelsai-train-x:1/a_b.c" }, funding().f);
  assert.deepEqual(
    bodies.map((b) => (b as { idempotency_key?: string }).idempotency_key),
    ["wheelsai-model-abc", "wheelsai-train-x:1/a_b.c"],
  );
  assert.ok(bodies.every((b) => (b as { autostart?: unknown }).autostart === undefined), "never autostart");

  for (const bad of ["has space", "x".repeat(129), "", "ünïcode"]) {
    const before = ops.length;
    await assert.rejects(createAndStartDeployment(port, { ...PARAMS, idempotencyKey: bad }, funding().f), RangeError, bad);
    assert.equal(ops.length, before, `${JSON.stringify(bad)}: nothing created`);
  }
});

/** fakePort plus an idempotency-key lookup that answers `found`. */
function keyedPort(opts: FakeOpts & { found?: string | null; lookupError?: Error }) {
  const fake = fakePort(opts);
  const lookups: string[] = [];
  fake.port.findByIdempotencyKey = async (key: string) => {
    lookups.push(key);
    if (opts.lookupError) throw opts.lookupError;
    return opts.found === undefined ? "dm_credits" : opts.found;
  };
  return { ...fake, lookups };
}

test("a create that threw is looked up by its key: an unstarted DRAFT is taken on and started", async () => {
  const { port, ops, lookups } = keyedPort({ createError: new Error("Error creating deployment: Conflict") });
  const result = await createAndStartDeployment(port, PARAMS, funding().f);
  assert.deepEqual(lookups, ["wheelsai-model-abc"]);
  assert.deepEqual(ops, ["create", "get:dm_credits", "start"]);
  assert.equal(result.deploymentId, "dm_credits");
  assert.equal(result.recoveredFromCreateError, "Error creating deployment: Conflict");
});

test("a create that threw, and the key finds nothing or cannot be asked: may exist, no id, nothing started", async () => {
  for (const [opts, message] of [
    [{ found: null }, /no deployment holds its idempotency key/],
    [{ lookupError: new Error("HTTP 502") }, /looking it up by its idempotency key failed too: HTTP 502/],
  ] as const) {
    const { port, ops } = keyedPort({ createError: new Error("timeout"), ...opts });
    await assert.rejects(createAndStartDeployment(port, PARAMS, funding().f), (err: unknown) => {
      assert.ok(lifecycleError("nosana_create_failed", "create")(err));
      const e = err as NosanaLifecycleError;
      assert.equal(e.mayExistOnNosana, true);
      assert.equal(e.deploymentId, undefined);
      assert.equal(e.deploymentName, "wheelsai-model-abc");
      assert.match(e.message, message);
      return true;
    });
    assert.deepEqual(ops, ["create"]);
  }
});

test("a create that threw, and the key finds a deployment that cannot be read: its id is carried, nothing started", async () => {
  const { port, ops } = keyedPort({ createError: new Error("Non-base58 character") });
  port.get = async () => {
    ops.push("get");
    throw new Error("Non-base58 character");
  };
  await assert.rejects(createAndStartDeployment(port, PARAMS, funding().f), (err: unknown) => {
    const e = err as NosanaLifecycleError;
    assert.ok(lifecycleError("nosana_create_failed", "create")(err));
    assert.equal(e.deploymentId, "dm_credits");
    assert.equal(e.mayExistOnNosana, false);
    assert.equal(e.cleanup, undefined);
    return true;
  });
  assert.deepEqual(ops, ["create", "get"]);
});

test("a create that threw, and the key finds a deployment already past DRAFT: stopped and released as after a failed start, id carried", async () => {
  const { port, ops } = keyedPort({ createError: new Error("Conflict"), status: "RUNNING", afterStop: "STOPPED" });
  await assert.rejects(createAndStartDeployment(port, PARAMS, funding().f), (err: unknown) => {
    const e = err as NosanaLifecycleError;
    assert.ok(lifecycleError("nosana_create_failed", "create")(err));
    assert.equal(e.deploymentId, "dm_credits");
    assert.deepEqual(e.cleanup, { stopped: true, reclaimed: true, errors: [] });
    assert.match(e.message, /already running/);
    return true;
  });
  assert.deepEqual(ops, ["create", "get:dm_credits", "stop", "get:dm_credits"]);
});

test("credits create: a failed start is stopped, and cleanup reports the state Nosana gives back", async () => {
  // The stop is refused while the deployment reads DRAFT. A start that failed
  // may still land on Nosana, so the refusal is waited out a bounded number of
  // times; it stays DRAFT, which costs nothing now but cannot be stopped:
  // neither "stopped" nor released, so the sweep keeps reading it.
  const draft = fakePort({ startError: new Error("manager 500"), stopError: new Error("cannot stop a draft") });
  const sleeps: number[] = [];
  const stopRetry = { attempts: 3, delayMs: 2_500, sleep: async (ms: number) => void sleeps.push(ms) };
  await assert.rejects(createAndStartDeployment(draft.port, { ...PARAMS, stopRetry }, funding().f), (err: unknown) => {
    assert.ok(lifecycleError("nosana_start_failed", "start")(err));
    const e = err as NosanaLifecycleError;
    assert.equal(e.deploymentId, "dm_credits");
    assert.equal(e.deploymentName, "wheelsai-model-abc");
    assert.deepEqual(e.cleanup, {
      stopped: false,
      reclaimed: false,
      errors: ["stop: cannot stop a draft", "withdraw: still draft on Nosana while a start may be in flight"],
    });
    return true;
  });
  assert.deepEqual(draft.ops, [
    "create",
    "start",
    ...["stop", "get:dm_credits", "stop", "get:dm_credits", "stop", "get:dm_credits"],
    "get:dm_credits",
  ]);
  assert.deepEqual(sleeps, [2_500, 2_500]);

  // The stop is accepted and Nosana is still winding down: not released yet.
  const stopping = fakePort({ startError: new Error("manager 500") });
  await assert.rejects(createAndStartDeployment(stopping.port, PARAMS, funding().f), (err: unknown) => {
    const e = err as NosanaLifecycleError;
    assert.equal(e.cleanup?.stopped, true);
    assert.equal(e.cleanup?.reclaimed, false);
    assert.deepEqual(e.cleanup?.errors, ["withdraw: still stopping on Nosana"]);
    return true;
  });
});

test("an authentication failure keeps its code through the start wrapper", async () => {
  const auth = new NosanaLifecycleError("Nosana rejected the platform API key", "read", { code: "nosana_auth_failed" });
  const { port } = fakePort({ startError: auth, stopError: auth });
  await assert.rejects(createAndStartDeployment(port, PARAMS, funding().f), lifecycleError("nosana_auth_failed", "start"));
});

// ============================================
// release: every Nosana state
// ============================================

test("release: released unless Nosana is starting, running or stopping it, or halted with no stop accepted", async () => {
  const { f } = funding();
  const deployment = fakePort().port.get("x");
  const held = new Set<DeploymentState>(["starting", "running", "stopping"]);
  const halted = new Set<DeploymentState>(["error", "insufficient_funds"]);
  for (const [, state] of ALL_STATES) {
    for (const context of [undefined, {}, { stopAccepted: false }, { stopAccepted: true }]) {
      const outcome = await f.release(await deployment, state, context);
      if (held.has(state)) {
        assert.deepEqual(outcome, { reclaimed: false, remainingNosBaseUnits: null, error: `still ${state} on Nosana` });
      } else if (halted.has(state) && context?.stopAccepted !== true) {
        // INSUFFICIENT_FUNDS comes back to life after a top-up of the shared
        // account: halted is not released until a stop has been accepted.
        assert.equal(outcome.reclaimed, false, state);
        assert.equal(outcome.remainingNosBaseUnits, null);
        assert.match(outcome.error ?? "", new RegExp(`still ${state} on Nosana and no stop was accepted`));
      } else {
        assert.deepEqual(outcome, { reclaimed: true, remainingNosBaseUnits: 0n }, state);
      }
    }
  }
  const unread = await f.release(await deployment, null);
  assert.equal(unread.reclaimed, false);
  assert.equal(unread.remainingNosBaseUnits, null);
  assert.match(unread.error ?? "", /could not be read back/);
});

test("stopAndReclaim with credits, for every Nosana state (the stop is accepted)", async () => {
  const expected: Record<string, { ops: string[]; alreadyStopped: boolean; reclaimed: boolean }> = {
    // Nothing asked of Nosana, nothing to re-read.
    DRAFT: { ops: ["get:d"], alreadyStopped: true, reclaimed: true },
    STOPPED: { ops: ["get:d"], alreadyStopped: true, reclaimed: true },
    ARCHIVED: { ops: ["get:d"], alreadyStopped: true, reclaimed: true },
    // Already stopping: re-read, still stopping, so not released yet.
    STOPPING: { ops: ["get:d", "get:d"], alreadyStopped: true, reclaimed: false },
    // Stopped now; Nosana reports STOPPING until the job has ended.
    STARTING: { ops: ["get:d", "stop", "get:d"], alreadyStopped: false, reclaimed: false },
    RUNNING: { ops: ["get:d", "stop", "get:d"], alreadyStopped: false, reclaimed: false },
    INSUFFICIENT_FUNDS: { ops: ["get:d", "stop", "get:d"], alreadyStopped: false, reclaimed: false },
    ERROR: { ops: ["get:d", "stop", "get:d"], alreadyStopped: false, reclaimed: false },
  };
  for (const [raw] of ALL_STATES) {
    const { port, ops } = fakePort({ status: raw });
    const result = await stopAndReclaim(port, "d", funding().f);
    assert.deepEqual(ops, expected[raw]!.ops, raw);
    assert.equal(result.stopped, true, raw);
    assert.equal(result.alreadyStopped, expected[raw]!.alreadyStopped, raw);
    assert.equal(result.reclaimed, expected[raw]!.reclaimed, raw);
    assert.equal(result.remainingNosBaseUnits, expected[raw]!.reclaimed ? 0n : null, raw);
    assert.equal(result.reclaimError !== undefined, !expected[raw]!.reclaimed, raw);
  }
});

test("stopAndReclaim with credits: a stop that settles at once is released in the same call", async () => {
  const { port, ops } = fakePort({ status: "RUNNING", afterStop: "STOPPED" });
  const result = await stopAndReclaim(port, "d", funding().f);
  assert.deepEqual(ops, ["get:d", "stop", "get:d"]);
  assert.deepEqual(result, {
    deploymentId: "d",
    stopped: true,
    alreadyStopped: false,
    reclaimed: true,
    remainingNosBaseUnits: 0n,
  });
});

test("stopAndReclaim with credits: a halted deployment that refuses the stop leaves service but is not released", async () => {
  // Nothing serves, so the user's stop goes through; but Nosana could revive
  // it after a top-up, so it is left for the sweep to stop.
  for (const raw of ["INSUFFICIENT_FUNDS", "ERROR"]) {
    const { port, ops } = fakePort({ status: raw, stopError: new Error("nothing to stop") });
    const result = await stopAndReclaim(port, "d", funding().f);
    assert.deepEqual(ops, ["get:d", "stop", "get:d"], raw);
    assert.equal(result.stopped, true);
    assert.equal(result.alreadyStopped, true);
    assert.equal(result.stopRefused, true);
    assert.equal(result.reclaimed, false, raw);
    assert.equal(result.remainingNosBaseUnits, null);
    assert.match(result.reclaimError ?? "", /no stop was accepted/);
  }
});

test("stopAndReclaim with credits: a halted deployment whose stop is accepted is released while Nosana still reads it halted", async () => {
  for (const raw of ["INSUFFICIENT_FUNDS", "ERROR"]) {
    const { port } = fakePort({ status: raw, afterStop: raw });
    const result = await stopAndReclaim(port, "d", funding().f);
    assert.equal(result.stopRefused, undefined);
    assert.equal(result.reclaimed, true, raw);
  }
});

test("stopAndReclaim: a stop refused while STARTING is waited out and sent again; one that stays refused fails", async () => {
  // Nosana answers 500 INCORRECT_STATE to a stop until the LIST task has
  // moved STARTING to RUNNING, which takes seconds.
  const { port, ops, state } = fakePort({ status: "STARTING" });
  let refusals = 0;
  const original = port.get;
  port.get = async (id) => {
    const deployment = await original(id);
    const stop = deployment.stop;
    deployment.stop = async () => {
      if (state.status === "STARTING") {
        refusals += 1;
        ops.push("stop:refused");
        throw new Error("Deployment is in the incorrect state.");
      }
      return stop();
    };
    return deployment;
  };
  const sleeps: number[] = [];
  const stopRetry = {
    attempts: 4,
    delayMs: 2_500,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      if (sleeps.length === 2) state.status = "RUNNING"; // the LIST task was scheduled
    },
  };
  const result = await stopAndReclaim(port, "d", funding().f, { stopRetry });
  assert.equal(refusals, 2);
  assert.deepEqual(sleeps, [2_500, 2_500]);
  assert.equal(result.stopped, true);
  assert.equal(result.alreadyStopped, false);
  assert.equal(state.status, "STOPPING");
  assert.equal(result.reclaimed, false, "accepted, and winding down");

  // Never leaves STARTING: refused every time, then an error - never a quiet success.
  const stuck = fakePort({ status: "STARTING", stopError: new Error("Deployment is in the incorrect state.") });
  const waits: number[] = [];
  await assert.rejects(
    stopAndReclaim(stuck.port, "d", funding().f, { stopRetry: { attempts: 3, delayMs: 10, sleep: async (ms) => void waits.push(ms) } }),
    (err: unknown) => lifecycleError("nosana_stop_failed", "stop")(err) && /reports it starting/.test((err as Error).message),
  );
  assert.equal(stuck.ops.filter((op) => op === "stop").length, 3);
  assert.deepEqual(waits, [10, 10]);

  // A refusal while RUNNING is not waited out: it fails at once.
  const running = fakePort({ status: "RUNNING", stopError: new Error("manager 500") });
  const none: number[] = [];
  await assert.rejects(
    stopAndReclaim(running.port, "d", funding().f, { stopRetry: { attempts: 4, delayMs: 10, sleep: async (ms) => void none.push(ms) } }),
    lifecycleError("nosana_stop_failed", "stop"),
  );
  assert.deepEqual(none, []);
});

test("stopAndReclaim with credits: a running deployment whose stop fails still throws", async () => {
  const { port } = fakePort({ status: "RUNNING", stopError: new Error("manager 500") });
  await assert.rejects(stopAndReclaim(port, "d", funding().f), lifecycleError("nosana_stop_failed", "stop"));
});

test("stopAndReclaim with credits: an unreadable state after the stop is not called released", async () => {
  const { port } = fakePort({ status: "RUNNING", getErrorAfterFirst: new Error("timeout") });
  const result = await stopAndReclaim(port, "d", funding().f);
  assert.equal(result.stopped, true);
  assert.equal(result.reclaimed, false);
  assert.match(result.reclaimError ?? "", /could not be read back/);
});

// ============================================
// reclaimVault (the sweep, and restart's check)
// ============================================

test("reclaimVault with credits, for every Nosana state", async () => {
  const expected: Record<string, { ops: string[]; reclaimed: boolean }> = {
    DRAFT: { ops: ["get:d"], reclaimed: true },
    STOPPED: { ops: ["get:d"], reclaimed: true },
    ARCHIVED: { ops: ["get:d"], reclaimed: true },
    STOPPING: { ops: ["get:d"], reclaimed: false },
    // Terminal in our records but still up on Nosana: it is stopped here.
    STARTING: { ops: ["get:d", "stop", "get:d"], reclaimed: false },
    RUNNING: { ops: ["get:d", "stop", "get:d"], reclaimed: false },
    INSUFFICIENT_FUNDS: { ops: ["get:d", "stop", "get:d"], reclaimed: false },
    ERROR: { ops: ["get:d", "stop", "get:d"], reclaimed: false },
  };
  for (const [raw, state] of ALL_STATES) {
    const { port, ops } = fakePort({ status: raw });
    const result = await reclaimVault(port, "d", funding().f);
    assert.deepEqual(ops, expected[raw]!.ops, raw);
    assert.equal(result.state, state);
    assert.equal(result.reclaimed, expected[raw]!.reclaimed, raw);
    assert.equal(result.remainingNosBaseUnits, expected[raw]!.reclaimed ? 0n : null, raw);
  }
});

test("reclaimVault with credits: halted and refusing the stop is NOT released; released once a stop is accepted and it has stopped", async () => {
  for (const raw of ["INSUFFICIENT_FUNDS", "ERROR"]) {
    const refused = fakePort({ status: raw, stopError: new Error("nothing to stop") });
    const first = await reclaimVault(refused.port, "d", funding().f);
    assert.equal(first.reclaimed, false, raw);
    assert.match(first.reason ?? "", /no stop was accepted/);

    // The next sweep: the stop is accepted, Nosana winds it down, then reports it stopped.
    const accepted = fakePort({ status: raw });
    assert.equal((await reclaimVault(accepted.port, "d", funding().f)).reclaimed, false, `${raw}: stopping`);
    accepted.state.status = "STOPPED";
    assert.equal((await reclaimVault(accepted.port, "d", funding().f)).reclaimed, true, `${raw}: stopped`);

    // Accepted while Nosana still reads it halted: the accepted stop is what counts.
    const lagging = fakePort({ status: raw, afterStop: raw });
    assert.equal((await reclaimVault(lagging.port, "d", funding().f)).reclaimed, true, `${raw}: stop accepted`);
  }
  const running = fakePort({ status: "RUNNING" });
  assert.equal((await reclaimVault(running.port, "d", funding().f)).reclaimed, false);
  running.state.status = "STOPPED";
  assert.equal((await reclaimVault(running.port, "d", funding().f)).reclaimed, true);
});

test("reclaimVault with credits: a DRAFT whose start may still land is not released; it is stopped once the start lands", async () => {
  // Nosana refuses a stop of a DRAFT, so nothing is asked of it.
  const draft = fakePort({ status: "DRAFT" });
  const held = await reclaimVault(draft.port, "d", funding().f, { startMayBeInFlight: true });
  assert.equal(held.reclaimed, false);
  assert.match(held.reason ?? "", /a start may be in flight/);
  assert.deepEqual(draft.ops, ["get:d"]);

  // The start lands after all: the next sweep finds it started and stops it.
  draft.state.status = "STARTING";
  assert.equal((await reclaimVault(draft.port, "d", funding().f, { startMayBeInFlight: true })).reclaimed, false);
  assert.deepEqual(draft.ops.slice(1), ["get:d", "stop", "get:d"]);
  draft.state.status = "STOPPED";
  assert.equal((await reclaimVault(draft.port, "d", funding().f, { startMayBeInFlight: true })).reclaimed, true);

  // It never lands: once no start can still be on its way, the DRAFT is released.
  const never = fakePort({ status: "DRAFT" });
  assert.equal((await reclaimVault(never.port, "d", funding().f, { startMayBeInFlight: false })).reclaimed, true);

  // The window is counted from when the run ended in our records.
  const ended = new Date("2026-10-07T12:00:00.000Z");
  assert.equal(startMayBeInFlight(ended, new Date(ended.getTime() + DRAFT_START_HOLD_MS - 1)), true);
  assert.equal(startMayBeInFlight(ended, new Date(ended.getTime() + DRAFT_START_HOLD_MS)), false);
  assert.equal(startMayBeInFlight(null, ended), false);
  assert.ok(DRAFT_START_HOLD_MS >= 2 * 300_000, "at least twice the longest deadline a Nosana call may be given");
});

test("reclaimVault with credits: a running deployment that cannot be stopped throws", async () => {
  const { port } = fakePort({ status: "RUNNING", stopError: new Error("manager 500") });
  await assert.rejects(reclaimVault(port, "d", funding().f), lifecycleError("nosana_stop_failed", "stop"));
});

// ============================================
// scale
// ============================================

test("credits scale up: the gate covers the ADDED replicas, then the count changes; nothing is funded", async () => {
  const { port, ops, state } = fakePort({ status: "RUNNING", replicas: 1 });
  const { f, calls } = funding();
  const result = await scaleDeployment(port, "d", 3, { marketAddress: MARKET, fundSeconds: 7200 }, f);
  assert.deepEqual(ops, ["get:d", "scale:3"]);
  assert.equal(calls.balance, 1);
  assert.deepEqual(result, { deploymentId: "d", previousReplicas: 1, replicas: 3, funded: null });
  assert.equal(state.replicas, 3);
});

test("credits scale up: too little for the added replicas refuses before the count changes", async () => {
  const { port, ops } = fakePort({ status: "RUNNING", replicas: 1 });
  // two added replicas: 2 x 100800 + 5000000 = 5201600 needed
  const { f } = funding({ availableMicroUsd: 5_201_599n });
  await assert.rejects(
    scaleDeployment(port, "d", 3, { marketAddress: MARKET, fundSeconds: 7200 }, f),
    (err: unknown) => lifecycleError("nosana_credits_low", "scale")(err) && (err as NosanaLifecycleError).deploymentId === "d",
  );
  assert.deepEqual(ops, ["get:d"]);
});

test("credits scale down never reads the balance", async () => {
  const { port, ops } = fakePort({ status: "RUNNING", replicas: 3 });
  const { f, calls } = funding({ balanceError: new Error("must not be read") });
  const result = await scaleDeployment(port, "d", 1, { marketAddress: MARKET, fundSeconds: 7200 }, f);
  assert.deepEqual(ops, ["get:d", "scale:1"]);
  assert.equal(calls.balance, 0);
  assert.equal(result.funded, null);
});

// ============================================
// runway
// ============================================

test("credits runway: measured from the balance, never a top-up, reason credits", async () => {
  const { port, ops } = fakePort({ status: "RUNNING", replicas: 2 });
  const { f, calls } = funding({ availableMicroUsd: 1_000_000n, cost: 14n });
  const result = await ensureVaultRunway(
    port,
    "d",
    { marketAddress: MARKET, replicas: 2, minRunwaySeconds: 7200, fundSeconds: 14_400 },
    f,
  );
  assert.deepEqual(ops, ["get:d"]);
  assert.deepEqual(result, {
    deploymentId: "d",
    toppedUp: false,
    runwaySeconds: Number(1_000_000n / 28n),
    funded: null,
    reason: "credits",
  });
  assert.equal(calls.cached, 1, "a recent balance is enough for a measurement");
  assert.equal(calls.balance, 0);
});

test("credits runway: not running is not measured; an unreadable balance throws by name", async () => {
  const stopped = fakePort({ status: "STOPPED" });
  const first = funding();
  const result = await ensureVaultRunway(
    stopped.port,
    "d",
    { marketAddress: MARKET, replicas: 1, minRunwaySeconds: 1, fundSeconds: 1 },
    first.f,
  );
  assert.equal(result.reason, "not_running");
  assert.equal(first.calls.cached, 0);

  const running = fakePort({ status: "RUNNING" });
  await assert.rejects(
    ensureVaultRunway(
      running.port,
      "d",
      { marketAddress: MARKET, replicas: 1, minRunwaySeconds: 1, fundSeconds: 1 },
      funding({ balanceError: new NosanaCreditsError("nosana_auth_failed", "HTTP 401") }).f,
    ),
    lifecycleError("nosana_auth_failed", "read"),
  );
});

// ============================================
// the seam itself
// ============================================

test("vault funding passed explicitly runs the same statements as the default", async () => {
  const run = async (explicit: boolean) => {
    const ops: string[] = [];
    let nos = 0;
    const deployment: SdkDeploymentLike = {
      id: "dm_vault",
      status: "DRAFT",
      replicas: 1,
      vault: {
        publicKey: { toBase58: () => "VaultKey" },
        topup: async (o) => {
          ops.push(`topup:${o.NOS}:${o.SOL}`);
          nos += o.NOS ?? 0;
        },
        getBalance: async () => ({ SOL: 0, NOS: nos / 1e6 }),
        withdraw: async () => {
          ops.push("withdraw");
          nos = 0;
        },
      },
      start: async () => {
        ops.push("start");
      },
      stop: async () => {
        ops.push("stop");
      },
      updateReplicaCount: async () => {},
    };
    const port: NosanaDeploymentsPort = {
      create: async () => {
        ops.push("create");
        return deployment;
      },
      get: async () => deployment,
      getMarketJobPrice: async () => {
        ops.push("getMarket");
        return 24n;
      },
    };
    const result = explicit
      ? await createAndStartDeployment(port, PARAMS, vaultFunding(port))
      : await createAndStartDeployment(port, PARAMS);
    return { ops, vaultAddress: result.vaultAddress, nos: result.funding?.nosBaseUnits };
  };
  const byDefault = await run(false);
  assert.deepEqual(byDefault.ops, ["getMarket", "create", "topup:190080:10000000", "start"]);
  assert.deepEqual(await run(true), byDefault);
});

test("vault funding on a deployment with no vault names the problem in the runway check", async () => {
  const { port } = fakePort({ status: "RUNNING" });
  port.getMarketJobPrice = async () => 24n;
  await assert.rejects(
    ensureVaultRunway(port, "dm_credits", { marketAddress: MARKET, replicas: 1, minRunwaySeconds: 1, fundSeconds: 1 }),
    lifecycleError("nosana_vault_missing"),
  );
});
