import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { Keypair } from "@solana/web3.js";
import { startFakeNosanaApi, startRequestCounter, FAKE_MARKETS } from "./fakeNosanaApi.js";

// A training job's Nosana deployment is stopped, and handed to the orphan
// sweep, through the credential that CREATED it. services/trainingNosana.ts
// driven by the REAL NosanaClient and @nosana/sdk against the fake Nosana REST
// API on loopback, and then the sweep reading the record it wrote.

const fake = await startFakeNosanaApi();
const rpc = await startRequestCounter();
after(async () => {
  await fake.close();
  await rpc.close();
});

// Before any app module loads: config/env.ts and config/nosanaAccess.ts read these.
process.env.NODE_ENV = "development";
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "12345678901234567890123456789012";
process.env.SOLANA_RPC_URL = rpc.url;
process.env.SOLANA_NETWORK = "devnet";
process.env.NOSANA_API_KEY = fake.apiKey;
process.env.NOSANA_API_URL = fake.url;
process.env.NOSANA_CREDITS_CACHE_MS = "0";
process.env.NOSANA_COST_CACHE_MS = "0";
for (const name of [
  "NOSANA_WALLET_PRIVATE_KEY",
  "NOSANA_ACCESS_MODE",
  "NOSANA_NETWORK",
  "NOSANA_TIMEOUT_UNIT",
  "NOSANA_MIN_CREDITS_USD",
  "NOSANA_MARKETS_JSON",
  "NOSANA_JOB_TIMEOUT_SECONDS",
  "NOSANA_BATCH_JOB_TIMEOUT_SECONDS",
  "ALLOW_NOSANA_MOCK",
  "SOLANA_WALLET",
  "ANCHOR_PROVIDER_URL",
]) {
  delete process.env[name];
}

const { NosanaClient } = await import("../services/nosana.js");
const { NosanaLifecycleError } = await import("../services/nosanaDeploymentLifecycle.js");
const { resetNosanaAccessConfigForTests, rowAccessMode } = await import("../config/nosanaAccess.js");
const { recordNosanaOrphan } = await import("../services/nosanaOrphans.js");
const { recordFailedTrainingSubmit, stopCancelledTrainingJob, trainingSubmitStamp } = await import(
  "../services/trainingNosana.js"
);

type Client = InstanceType<typeof NosanaClient>;

const DEFINITION = { version: "0.1", type: "container", meta: { trigger: "wheelsai" }, ops: [] };

function resetFake() {
  fake.rotateApiKey(fake.apiKey);
  fake.setBalance({ assignedCredits: 100, reservedCredits: 0, settledCredits: 0 });
  fake.setMarkets(FAKE_MARKETS);
  fake.setOwner("11111111111111111111111111111111");
  fake.setInsufficientFunds(false);
  fake.requests.length = 0;
}

function sent(method: string, path: RegExp) {
  return fake.requests.filter((r) => r.method === method && path.test(r.path));
}

async function apiClient(): Promise<Client> {
  resetNosanaAccessConfigForTests();
  const client = new NosanaClient();
  await client.initialize();
  return client;
}

/** A wallet client that records every call made of it. */
function walletSdk() {
  const ops: string[] = [];
  return {
    ops,
    sdk: {
      deployments: {
        create: async () => {
          ops.push("create");
          throw new Error("the wallet must not create here");
        },
        get: async (id: string) => {
          ops.push(`get:${id}`);
          throw new Error(`deployment ${id} not found`);
        },
      },
    },
  };
}

/** The operator moved the primary mode to the wallet and kept the key. */
async function walletPrimaryClient() {
  const client = await apiClient();
  const wallet = walletSdk();
  (client as any).sdk = wallet.sdk;
  (client as any).wallet = Keypair.generate();
  (client as any).primaryMode = "wallet";
  return { client, wallet };
}

function orphanDb() {
  const rows: Array<Record<string, unknown>> = [];
  return {
    rows,
    db: {
      nosanaOrphanDeployment: {
        createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
          rows.push(...data);
          return { count: data.length };
        },
      },
    },
  };
}

function depsFor(client: Client, orphans: ReturnType<typeof orphanDb>) {
  const stopErrors: unknown[] = [];
  return {
    stopErrors,
    deps: {
      stopDeployment: (id: string, mode?: "wallet" | "api_key") => client.stopDeployment(id, mode),
      recordOrphan: (args: Parameters<typeof recordNosanaOrphan>[1]) =>
        recordNosanaOrphan(orphans.db, args),
      onStopError: (err: unknown) => void stopErrors.push(err),
    },
  };
}

async function submitTraining(client: Client) {
  return client.createDeployment(DEFINITION as never, "3060", 1, { kind: "batch" });
}

test("a training job submitted with the API key is stamped api_key in the same write as its id", async () => {
  resetFake();
  const client = await apiClient();
  const nosanaJob = await submitTraining(client);
  assert.deepEqual(trainingSubmitStamp(nosanaJob), {
    nosanaJobId: nosanaJob.id,
    nosanaAccessMode: "api_key",
  });
  // The dev mock has no account.
  assert.deepEqual(trainingSubmitStamp({ id: "mock_dm_1" }), {
    nosanaJobId: "mock_dm_1",
    nosanaAccessMode: null,
  });
});

test("cancel after the primary mode moved to the wallet: the stop goes to the API key, and the pending release is recorded as api_key", async () => {
  resetFake();
  const stamp = trainingSubmitStamp(await submitTraining(await apiClient()));
  fake.settle(stamp.nosanaJobId);
  fake.requests.length = 0;

  const { client, wallet } = await walletPrimaryClient();
  const orphans = orphanDb();
  const { deps, stopErrors } = depsFor(client, orphans);

  const outcome = await stopCancelledTrainingJob(deps, { id: "job_1", ...stamp });

  assert.equal(sent("POST", new RegExp(`/${stamp.nosanaJobId}/stop$`)).length, 1);
  assert.deepEqual(wallet.ops, [], "the wallet account was never asked about an API-key deployment");
  assert.deepEqual(stopErrors, []);
  // The fake answers STOPPING: not released yet, so the sweep keeps it.
  assert.equal(outcome.settled, false);
  assert.deepEqual(orphans.rows, [
    {
      nosanaDeploymentId: stamp.nosanaJobId,
      sourceKind: "training",
      sourceId: "job_1",
      reason: "training_cancelled",
      accessMode: "api_key",
    },
  ]);

  // The sweep reads the record's mode and reaches the deployment with it.
  const record = orphans.rows[0]!;
  const reclaim = await client.reclaimDeploymentVault(
    record.nosanaDeploymentId as string,
    rowAccessMode(record.accessMode as string),
  );
  assert.equal(reclaim.deploymentId, stamp.nosanaJobId);
  assert.deepEqual(wallet.ops, []);
});

test("a cancel whose stop fails leaves a record the sweep can act on: api_key, and the sweep then stops the deployment", async () => {
  resetFake();
  const client = await apiClient();
  const stamp = trainingSubmitStamp(await submitTraining(client));
  fake.settle(stamp.nosanaJobId);
  const orphans = orphanDb();
  const { deps, stopErrors } = depsFor(client, orphans);
  fake.failNext(
    { method: "POST", path: new RegExp(`/${stamp.nosanaJobId}/stop$`) },
    { status: 500, body: { error: "manager down" } },
  );

  const outcome = await stopCancelledTrainingJob(deps, { id: "job_2", ...stamp });
  assert.equal(outcome.settled, false);
  assert.equal(stopErrors.length, 1);
  assert.equal(orphans.rows.length, 1);
  assert.equal(orphans.rows[0]!.accessMode, "api_key");
  assert.notEqual(fake.deployments.get(stamp.nosanaJobId)!.status, "STOPPED", "still running on platform credits");

  // What the status tick does with the record. Stamped wallet (the defect),
  // this call could never reach the deployment from an API-key process.
  await assert.rejects(
    client.reclaimDeploymentVault(stamp.nosanaJobId, "wallet"),
    (err: unknown) => (err as { code?: string }).code === "nosana_access_mode_unavailable",
  );
  fake.requests.length = 0;
  await client.reclaimDeploymentVault(stamp.nosanaJobId, rowAccessMode(orphans.rows[0]!.accessMode as string));
  assert.equal(sent("POST", new RegExp(`/${stamp.nosanaJobId}/stop$`)).length, 1, "the sweep stopped it");
});

test("a job from before the stamp is the wallet's: stopped through the wallet, recorded as wallet", async () => {
  resetFake();
  const { client, wallet } = await walletPrimaryClient();
  const orphans = orphanDb();
  const { deps, stopErrors } = depsFor(client, orphans);

  await stopCancelledTrainingJob(deps, { id: "job_3", nosanaJobId: "dm_old_wallet", nosanaAccessMode: null });

  assert.deepEqual(wallet.ops, ["get:dm_old_wallet"]);
  assert.equal(stopErrors.length, 1);
  assert.equal(fake.requests.length, 0, "the API-key account was never asked about it");
  assert.equal(orphans.rows[0]!.accessMode, "wallet");
});

test("a settled stop records nothing", async () => {
  const orphans = orphanDb();
  const outcome = await stopCancelledTrainingJob(
    {
      stopDeployment: async () => ({ reclaimed: true }),
      recordOrphan: (args) => recordNosanaOrphan(orphans.db, args),
    },
    { id: "job_4", nosanaJobId: "dm_done", nosanaAccessMode: "api_key" },
  );
  assert.equal(outcome.settled, true);
  assert.deepEqual(orphans.rows, []);
});

test("a submit that fails after creation records the partial id with the mode the failed call used", async () => {
  resetFake();
  const client = await apiClient();
  const orphans = orphanDb();
  const deps = { recordOrphan: (args: Parameters<typeof recordNosanaOrphan>[1]) => recordNosanaOrphan(orphans.db, args) };
  // Created, then the start is refused and so is the clean-up stop.
  fake.failNext({ method: "POST", path: /\/start$/ }, { status: 500, body: { error: "cannot start" } });
  fake.failNext({ method: "POST", path: /\/stop$/ }, { status: 500, body: { error: "cannot stop" } }, 5);

  let error: unknown;
  try {
    await submitTraining(client);
  } catch (err) {
    error = err;
  }
  assert.ok(error instanceof NosanaLifecycleError);
  assert.ok(error.deploymentId, "the failure carries the id Nosana gave");
  assert.equal(error.accessMode, "api_key");

  assert.equal(await recordFailedTrainingSubmit(deps, "job_5", error), true);
  assert.deepEqual(orphans.rows, [
    {
      nosanaDeploymentId: error.deploymentId,
      sourceKind: "training",
      sourceId: "job_5",
      reason: "submit_failed",
      accessMode: "api_key",
    },
  ]);

  // Verified stopped and released by its own clean-up: nothing to sweep.
  const clean = new NosanaLifecycleError("start failed", "start", { deploymentId: "dm_clean" });
  (clean as any).cleanup = { stopped: true, reclaimed: true };
  assert.equal(await recordFailedTrainingSubmit(deps, "job_6", clean), false);
  // Failed before anything existed on Nosana.
  assert.equal(await recordFailedTrainingSubmit(deps, "job_7", new Error("no market")), false);
  assert.equal(orphans.rows.length, 1);
});

test("routes/training.ts stores the stamp with the id and cancels through the row's mode", () => {
  const source = readFileSync(new URL("../routes/training.ts", import.meta.url), "utf8");
  assert.match(source, /data: trainingSubmitStamp\(nosanaJob\)/);
  assert.match(source, /stopCancelledTrainingJob\(/);
  assert.match(source, /nosanaAccessMode: job\.nosanaAccessMode/);
  assert.match(source, /recordFailedTrainingSubmit\(/);
  assert.doesNotMatch(source, /\.stopDeployment\(job\.nosanaJobId\)/, "no stop without the row's mode");
});
