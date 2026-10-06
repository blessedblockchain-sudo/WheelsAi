import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Drives restartModelDeployment (services/modelDeploymentLifecycle.ts)
// directly, the way a scheduled health check reaches it. The route's own
// tests (deploymentRoutes.unit.test.ts) cover every race through HTTP; what is
// pinned here is the contract a non-HTTP caller relies on: a refusal is a
// value with the route's reason and changes nothing, the lookup is scoped to
// the organization, and a success has claimed the run, reserved credits by a
// conditional debit with a ledger row, and started the submit for the new run.

process.env.NODE_ENV ??= "development";
process.env.LOG_LEVEL ??= "error";
process.env.DATABASE_URL ??= "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
process.env.JWT_SECRET ??= "12345678901234567890123456789012";

const NOW = new Date("2026-10-06T12:00:00.000Z");
// 4090 retail = $0.00025/s -> one billing hour = 90 cents per replica.
const HOUR_4090_CENTS = 90n;

interface Row {
  id: string;
  orgId: string;
  modelId: string;
  engine: string;
  gpuTier: string;
  replicas: number;
  config: Record<string, unknown>;
  status: string;
  nosanaJobIds: string[];
  runGeneration: number;
  vaultReclaimedAt: Date | null;
  reservationCents: bigint | null;
  reservationReleasedAt: Date | null;
  stoppedAt: Date | null;
  statusReason: string | null;
  billedThroughAt: Date | null;
  autoRestartCount?: number;
  lastAutoRestartAt?: Date | null;
  model: { hfId: string };
}

function row(over: Partial<Row> = {}): Row {
  return {
    id: "dep_1",
    orgId: "org_1",
    modelId: "llama-3.1-8b",
    engine: "vllm",
    gpuTier: "4090",
    replicas: 1,
    config: { maxTokens: 2048 },
    status: "stopped",
    nosanaJobIds: [],
    runGeneration: 3,
    vaultReclaimedAt: NOW,
    reservationCents: HOUR_4090_CENTS,
    reservationReleasedAt: NOW,
    stoppedAt: NOW,
    statusReason: "user_stopped",
    billedThroughAt: null,
    model: { hfId: "meta-llama/Meta-Llama-3.1-8B-Instruct" },
    ...over,
  };
}

function world(opts: { rows?: Row[]; balance?: bigint; reclaim?: boolean; preflight?: Error } = {}) {
  const state = {
    rows: opts.rows ?? [row()],
    balance: opts.balance ?? 1_000n,
    ledger: [] as Array<{ amountCents: bigint; type: string; referenceId: string; balanceAfter: bigint }>,
    writes: 0,
    reclaimed: [] as string[],
    submits: [] as unknown[][],
  };
  const find = (id: string) => state.rows.find((r) => r.id === id) ?? null;
  let queue: Promise<unknown> = Promise.resolve();
  const tx = {
    deployment: {
      updateMany: async ({ where, data }: any) => {
        const r = find(where.id);
        const idsMatch = where.nosanaJobIds?.has
          ? r?.nosanaJobIds.includes(where.nosanaJobIds.has)
          : r?.nosanaJobIds.length === 0;
        if (!r || !where.status.in.includes(r.status) || r.runGeneration !== where.runGeneration || !idsMatch) {
          return { count: 0 };
        }
        // The automatic restart's extra condition: not stopped by the owner.
        const notOwnerStopped = (where.OR as any[] | undefined)?.some((c) =>
          c.statusReason === null ? r.statusReason === null : r.statusReason !== null && r.statusReason !== c.statusReason.not,
        );
        if (where.OR && !notOwnerStopped) return { count: 0 };
        state.writes += 1;
        const { runGeneration, ...rest } = data;
        Object.assign(r, rest, { runGeneration: r.runGeneration + runGeneration.increment });
        return { count: 1 };
      },
      findUnique: async ({ where }: any) => find(where.id),
      update: async ({ where, data }: any) => {
        state.writes += 1;
        return Object.assign(find(where.id)!, data);
      },
    },
    creditBalance: {
      updateMany: async ({ where, data }: any) => {
        if (state.balance < where.balanceCents.gte) return { count: 0 };
        state.balance -= data.balanceCents.decrement;
        return { count: 1 };
      },
      findUnique: async () => ({ balanceCents: state.balance }),
    },
    creditTransaction: {
      create: async ({ data }: any) => {
        state.ledger.push(data);
      },
    },
  };
  const prisma = {
    deployment: {
      // Scoped by the caller's organization, as the real query is.
      // A read is a snapshot: later writes do not show through it.
      findFirst: async ({ where }: any) =>
        structuredClone(state.rows.find((r) => r.id === where.id && r.orgId === where.orgId) ?? null),
      count: async ({ where }: any) =>
        state.rows.filter((r) => r.orgId === where.orgId && where.status.in.includes(r.status)).length,
    },
    // One at a time (the claim's row lock), rolled back when the callback throws.
    $transaction: (fn: (t: typeof tx) => Promise<unknown>) => {
      const run = async () => {
        const snapshot = structuredClone({ rows: state.rows, balance: state.balance, ledger: state.ledger });
        try {
          return await fn(tx);
        } catch (err) {
          state.rows.splice(0, state.rows.length, ...snapshot.rows);
          state.balance = snapshot.balance;
          state.ledger = snapshot.ledger;
          throw err;
        }
      };
      const result = queue.then(run, run);
      queue = result.catch(() => {});
      return result;
    },
  };
  const deps = {
    prisma: prisma as never,
    getNosana: async () =>
      ({
        assertCanDeploy: () => {
          if (opts.preflight) throw opts.preflight;
        },
        reclaimDeploymentVault: async (id: string) => {
          state.reclaimed.push(id);
          return { reclaimed: opts.reclaim ?? true };
        },
      }) as never,
    now: () => NOW,
    submit: async (...args: unknown[]) => {
      state.submits.push(args);
    },
    maxActiveDeployments: 2,
  };
  return { state, deps };
}

async function restart(w: ReturnType<typeof world>, orgId = "org_1", automatic?: boolean) {
  const { restartModelDeployment } = await import("../services/modelDeploymentLifecycle.js");
  return restartModelDeployment(w.deps, { deploymentId: "dep_1", orgId, automatic });
}

test("a restart claims the run, takes a fresh reservation and submits the NEW run", async () => {
  const w = world();
  const result = await restart(w);
  assert.deepEqual(result, { ok: true, deploymentId: "dep_1", status: "pending", runGeneration: 4 });

  const r = w.state.rows[0]!;
  assert.equal(r.status, "pending");
  assert.equal(r.runGeneration, 4, "every late write of run 3 now misses");
  assert.equal(r.stoppedAt, null);
  assert.equal(r.vaultReclaimedAt, null);
  assert.equal(r.reservationCents, HOUR_4090_CENTS);
  assert.equal(r.reservationReleasedAt, null, "the new hold is live");

  // One conditional debit, one ledger row carrying the balance after it.
  assert.equal(w.state.balance, 1_000n - HOUR_4090_CENTS);
  assert.deepEqual(w.state.ledger, [
    {
      orgId: "org_1",
      amountCents: -HOUR_4090_CENTS,
      type: "deployment_reservation",
      description: "GPU deployment reservation (4090 x1, 1h)",
      referenceId: "dep_1",
      balanceAfter: 1_000n - HOUR_4090_CENTS,
    },
  ]);

  assert.equal(w.state.submits.length, 1);
  const [id, config, gpuTier, replicas, runGeneration] = w.state.submits[0]!;
  assert.equal(id, "dep_1");
  assert.deepEqual(config, {
    modelId: "llama-3.1-8b",
    hfModelId: "meta-llama/Meta-Llama-3.1-8B-Instruct",
    engine: "vllm",
    maxTokens: 2048,
    gpuMemoryUtilization: 0.9,
  });
  assert.deepEqual([gpuTier, replicas, runGeneration], ["4090", 1, 4]);
});

test("another organization's deployment is not found and nothing is touched", async () => {
  const w = world();
  const result = await restart(w, "org_2");
  assert.deepEqual(result, { ok: false, code: "not_found", message: "Deployment not found" });
  assert.equal(w.state.writes, 0);
  assert.equal(w.state.balance, 1_000n);
  assert.deepEqual(w.state.submits, []);
});

test("each refusal is a value with the route's reason, and changes nothing", async () => {
  const cases: Array<[string, ReturnType<typeof world>, string, RegExp]> = [
    [
      "a running deployment",
      world({ rows: [row({ status: "running" })] }),
      "deployment_not_restartable",
      /Only stopped or failed deployments can be restarted \(status: running\)\./,
    ],
    [
      "a platform that cannot deploy the tier",
      world({ preflight: new Error("Nosana is not configured on this server") }),
      "preflight_failed",
      /Nosana is not configured on this server/,
    ],
    [
      "an organization at its quota",
      world({ rows: [row(), row({ id: "a", status: "running" }), row({ id: "b", status: "provisioning" })] }),
      "deployment_quota_exceeded",
      /already has 2 active deployments \(limit 2\)/,
    ],
    [
      "a previous run whose vault is not back yet",
      world({ rows: [row({ nosanaJobIds: ["dm_old"], vaultReclaimedAt: null })], reclaim: false }),
      "previous_run_winding_down",
      /still being wound down on Nosana/,
    ],
    [
      "an organization that cannot cover the reservation",
      world({ balance: HOUR_4090_CENTS - 1n }),
      "insufficient_credits",
      /Restarting requires a reservation of \$0\.90 in credits/,
    ],
  ];
  for (const [name, w, code, message] of cases) {
    const before = structuredClone(w.state.rows);
    const balance = w.state.balance;
    const result = await restart(w);
    assert.equal(result.ok, false, name);
    if (result.ok) continue;
    assert.equal(result.code, code, name);
    assert.match(result.message, message, name);
    assert.deepEqual(w.state.rows, before, `${name}: the row is as it was (a failed claim rolls back)`);
    assert.equal(w.state.balance, balance, name);
    assert.deepEqual(w.state.ledger, [], name);
    assert.deepEqual(w.state.submits, [], name);
  }
});

test("the previous run's vault is reclaimed before its id is forgotten", async () => {
  const w = world({ rows: [row({ nosanaJobIds: ["dm_old"], vaultReclaimedAt: null })] });
  const result = await restart(w);
  assert.equal(result.ok, true);
  assert.deepEqual(w.state.reclaimed, ["dm_old"]);
  assert.deepEqual(w.state.rows[0]!.nosanaJobIds, []);
});

test("two restarts at once: one claims the run, one reservation is taken", async () => {
  const w = world();
  const results = await Promise.all([restart(w), restart(w)]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  const lost = results.find((r) => !r.ok)!;
  assert.ok(!lost.ok && lost.code === "deployment_not_restartable");
  assert.equal(w.state.balance, 1_000n - HOUR_4090_CENTS);
  assert.equal(w.state.submits.length, 1);
  assert.equal(w.state.rows[0]!.runGeneration, 4);
});

// ============================================
// An automatic restart (a health check's remediation)
// ============================================

test("an automatic restart refuses a deployment its owner stopped, and changes nothing", async () => {
  const w = world({ rows: [row({ status: "stopped", statusReason: "user_stopped" })] });
  const before = structuredClone(w.state.rows);
  const result = await restart(w, "org_1", true);
  assert.deepEqual(result, {
    ok: false,
    code: "deployment_not_restartable",
    message: "The deployment was stopped by its owner; it is not restarted automatically.",
  });
  assert.deepEqual(w.state.rows, before);
  assert.equal(w.state.balance, 1_000n);
  assert.deepEqual(w.state.ledger, []);
  assert.deepEqual(w.state.submits, []);

  // The owner's own restart of the same row goes through.
  assert.equal((await restart(w)).ok, true);
});

test("an automatic restart goes through for a deployment that failed or that the platform stopped", async () => {
  for (const over of [
    { status: "failed", statusReason: "nosana_error" },
    { status: "failed", statusReason: null },
    { status: "stopped", statusReason: "insufficient_credits" },
  ]) {
    const w = world({ rows: [row(over)] });
    const result = await restart(w, "org_1", true);
    assert.equal(result.ok, true, JSON.stringify(over));
    assert.equal(w.state.rows[0]!.status, "pending");
    assert.equal(w.state.submits.length, 1);
  }
});

test("a Stop that lands while an automatic restart is being prepared wins: the claim misses and nothing is reserved", async () => {
  const w = world({
    rows: [row({ status: "failed", statusReason: "nosana_error", nosanaJobIds: ["nos_1"], vaultReclaimedAt: null })],
  });
  const getNosana = w.deps.getNosana;
  w.deps.getNosana = (async () => ({
    ...((await getNosana()) as object),
    // After the row was read and before the claim: the owner marks it stopped.
    reclaimDeploymentVault: async () => {
      Object.assign(w.state.rows[0]!, { status: "stopped", statusReason: "user_stopped" });
      return { reclaimed: true };
    },
  })) as never;

  const result = await restart(w, "org_1", true);
  assert.equal(result.ok, false);
  assert.equal((result as { code: string }).code, "deployment_not_restartable");
  assert.equal(w.state.rows[0]!.status, "stopped");
  assert.equal(w.state.rows[0]!.runGeneration, 3);
  assert.equal(w.state.balance, 1_000n);
  assert.deepEqual(w.state.ledger, []);
  assert.deepEqual(w.state.submits, []);
});

test("a restart by hand clears the record of automatic restarts; an automatic one leaves it to the health check", async () => {
  const counted = { status: "failed", statusReason: "nosana_error", autoRestartCount: 5, lastAutoRestartAt: NOW };

  const byHand = world({ rows: [row(counted)] });
  assert.equal((await restart(byHand)).ok, true);
  assert.equal(byHand.state.rows[0]!.autoRestartCount, 0);
  assert.equal(byHand.state.rows[0]!.lastAutoRestartAt, null);

  const automatic = world({ rows: [row(counted)] });
  assert.equal((await restart(automatic, "org_1", true)).ok, true);
  assert.equal(automatic.state.rows[0]!.autoRestartCount, 5);
  assert.deepEqual(automatic.state.rows[0]!.lastAutoRestartAt, NOW);
});

test("the health check's restart is the automatic one, and its record is claimed by compare-and-set in the caller's organization", () => {
  const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  assert.match(
    read("services/modelDeploymentLifecycle.ts"),
    /export async function restartDeploymentForOrg\([\s\S]*?\{ deploymentId, orgId, automatic: true \},/,
  );
  const tasks = read("services/scheduledTasks/buildScheduledTaskTypeDeps.ts");
  assert.match(tasks, /stoppedByOwner: row\.statusReason === OWNER_STOP_REASON,/);
  assert.match(
    tasks,
    /claimAutoRestart: async[\s\S]*?prisma\.deployment\.updateMany\(\{\s*where: \{\s*id: deploymentId,\s*orgId,\s*autoRestartCount: expected\.count,\s*lastAutoRestartAt: expected\.lastAt,\s*\},/,
  );
  // The owner's Stop writes the reason the refusal reads.
  assert.match(read("routes/deployments.ts"), /status: "stopped",\s*stoppedAt,\s*statusReason: OWNER_STOP_REASON,/);
});

// ============================================
// Wiring
// ============================================

test("the route and the health check task both restart through this one function", async () => {
  const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

  const route = read("routes/deployments.ts");
  assert.match(route, /const restarted = await restartModelDeployment\(/);
  assert.doesNotMatch(
    route,
    /runGeneration: \{ increment: 1 \}|reclaimDeploymentVault\(previousId\)/,
    "the route keeps no restart logic of its own",
  );

  const service = read("services/modelDeploymentLifecycle.ts");
  assert.match(
    service,
    /export async function restartDeploymentForOrg\([\s\S]*?const restarted = await restartModelDeployment\(/,
  );
  assert.match(service, /if \(!restarted\.ok\) throw new Error\(restarted\.message\)/);

  const tasks = read("services/scheduledTasks/buildScheduledTaskTypeDeps.ts");
  assert.match(
    tasks,
    /const DEPLOYMENT_RESTART: HealthCheckDeps\["restartDeployment"\] = restartDeploymentForOrg;/,
  );
  assert.match(tasks, /restartDeployment: DEPLOYMENT_RESTART,/);

  // The option is offered, and a task that asks for it can be saved.
  const { productionTaskTypeCapabilities } = await import(
    "../services/scheduledTasks/buildScheduledTaskTypeDeps.js"
  );
  assert.equal(productionTaskTypeCapabilities().deploymentRestartAvailable, true);
});
