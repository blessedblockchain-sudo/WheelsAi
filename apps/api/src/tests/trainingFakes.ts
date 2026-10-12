/**
 * Stand-ins for the training job service's dependencies: an in-memory
 * database that behaves like the ledger (conditional writes, transactions
 * that roll back, unique keys), a scriptable Nosana port, an in-memory object
 * store and a clock a test moves by hand. No network, no database.
 */

import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import type { ObjectStore } from "../services/objectStore.js";
import type {
  TrainingDeps,
  TrainingJobRow,
  TrainingPrisma,
  TrainingRuntime,
  TrainingWebhookEvent,
} from "../services/trainingJobs.js";
import { trainingArtifactKeys } from "../services/trainingJobs.js";
import { deriveTrainingCallbackSecret, signTrainingCallback } from "../services/trainingWebhookAuth.js";

export const ORG = "11111111-1111-4111-8111-111111111111";
export const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
export const DATASET = "33333333-3333-4333-8333-333333333333";
export const SERVER_SECRET = "s".repeat(32);
export const T0 = new Date("2026-10-12T10:00:00.000Z");
export const IMAGE = `registry.example.com/wheelsai/trainer@sha256:${"a".repeat(64)}`;

type Row = Record<string, unknown>;

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b || (a == null && b == null);
}

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, cond]) => {
    const value = row[key];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as Row;
      if ("in" in c) return (c.in as unknown[]).some((item) => same(item, value));
      if ("lt" in c) return (value as number) < (c.lt as number);
      if ("gte" in c) return (value as bigint) >= (c.gte as bigint);
      if ("not" in c) return !same(value, c.not);
      throw new Error(`fake db: unsupported condition on ${key}`);
    }
    return same(value, cond);
  });
}

type OrderDirection = "asc" | "desc" | { sort: "asc" | "desc"; nulls?: "first" | "last" };
type OrderBy = Record<string, OrderDirection> | Array<Record<string, OrderDirection>>;

/** Prisma's orderBy: one field or a list, each asc or desc, nulls first or last. */
function comparator(orderBy: OrderBy): (a: Row, b: Row) => number {
  const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap((entry) => Object.entries(entry));
  const value = (v: unknown) => (v instanceof Date ? v.getTime() : typeof v === "bigint" ? Number(v) : (v as number));
  return (a, b) => {
    for (const [key, direction] of keys) {
      const { sort, nulls } = typeof direction === "string" ? { sort: direction, nulls: undefined } : direction;
      const av = a[key];
      const bv = b[key];
      if (av == null || bv == null) {
        if (av == null && bv == null) continue;
        // Postgres: nulls are largest unless told otherwise.
        const nullFirst = nulls ? nulls === "first" : sort === "desc";
        return (av == null) === nullFirst ? -1 : 1;
      }
      const d = value(av) - value(bv);
      if (d !== 0) return sort === "desc" ? -d : d;
    }
    return 0;
  };
}

function assign(row: Row, data: Row, now: Date): void {
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && typeof value === "object" && !(value instanceof Date)) {
      const v = value as Row;
      if ("increment" in v) {
        row[key] = (row[key] as bigint) + (v.increment as bigint);
        continue;
      }
      if ("decrement" in v) {
        row[key] = (row[key] as bigint) - (v.decrement as bigint);
        continue;
      }
    }
    row[key] = value;
  }
  row.updatedAt = now;
}

export function uniqueViolation(): Error {
  return Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
}

const JOB_DEFAULTS: Partial<TrainingJobRow> = {
  hyperparams: null,
  datasetSha256: null,
  gpuCount: 1,
  status: "pending",
  progress: 0,
  currentEpoch: null,
  totalEpochs: null,
  currentStep: null,
  totalSteps: null,
  failureCode: null,
  maxRuntimeSeconds: null,
  nosanaTimeoutSeconds: null,
  submitNonce: null,
  submitStartedAt: null,
  queuedAt: null,
  cancelRequestedAt: null,
  gpuStoppedAt: null,
  lastEventSeq: 0,
  lastEventAt: null,
  reportedOutcome: null,
  lastReconciledAt: null,
  nosanaJobId: null,
  nosanaJobAddress: null,
  nosanaAccessMode: null,
  outputModelId: null,
  outputPath: null,
  trainingLoss: null,
  evalLoss: null,
  metrics: null,
  logs: null,
  lastError: null,
  estimatedCostCents: null,
  actualCostCents: null,
  reservationCents: null,
  priceMicroUsdPerSecond: null,
  billedSeconds: null,
  settledAt: null,
  startedAt: null,
  completedAt: null,
};

export interface FakeDb {
  prisma: TrainingPrisma;
  jobs: TrainingJobRow[];
  datasets: Row[];
  models: Row[];
  fineTuned: Row[];
  balances: Array<{ orgId: string; balanceCents: bigint }>;
  ledger: Array<{
    id: string;
    orgId: string;
    type: string;
    amountCents: bigint;
    balanceAfter: bigint;
    referenceId: string;
    description: string;
    createdAt: Date;
  }>;
  /** Make the next n transactions throw after their work (a commit that failed). */
  failNextTransactions(n: number): void;
  job(id: string): TrainingJobRow;
  balance(orgId?: string): bigint;
  ledgerOf(jobId: string): Array<{ type: string; amountCents: bigint; balanceAfter: bigint }>;
  insertJob(row: Partial<TrainingJobRow> & { id: string }): TrainingJobRow;
}

export function makeFakeDb(clock: { now: Date }): FakeDb {
  const state = {
    jobs: [] as TrainingJobRow[],
    datasets: [] as Row[],
    models: [] as Row[],
    fineTuned: [] as Row[],
    balances: [] as Array<{ orgId: string; balanceCents: bigint }>,
    ledger: [] as FakeDb["ledger"],
  };
  let failTransactions = 0;
  let chain: Promise<unknown> = Promise.resolve();
  let seq = 0;

  const table = (rows: () => Row[]) => ({
    findFirst: async ({ where }: { where: Row }) => {
      const found = rows().find((row) => matches(row, where));
      return found ? { ...found } : null;
    },
    findMany: async ({ where, orderBy, take }: { where: Row; orderBy?: OrderBy; take?: number }) => {
      let found = rows().filter((row) => matches(row, where));
      if (orderBy) found = [...found].sort(comparator(orderBy));
      return found.slice(0, take ?? found.length).map((row) => ({ ...row }));
    },
    count: async ({ where }: { where: Row }) => rows().filter((row) => matches(row, where)).length,
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const found = rows().filter((row) => matches(row, where));
      for (const row of found) assign(row, data, clock.now);
      return { count: found.length };
    },
  });

  const jobs = table(() => state.jobs as unknown as Row[]);
  const client = {
    trainingJob: {
      ...jobs,
      findUnique: async ({ where }: { where: { id: string } }) => jobs.findFirst({ where }),
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = state.jobs.find((job) => job.id === where.id);
        if (!row) throw new Error("fake db: job not found");
        assign(row as unknown as Row, data, clock.now);
        return { ...row };
      },
      create: async ({ data }: { data: Row }) => {
        const row = { ...JOB_DEFAULTS, createdAt: clock.now, updatedAt: clock.now, ...data } as TrainingJobRow;
        state.jobs.push(row);
        return { ...row };
      },
    },
    dataset: table(() => state.datasets),
    model: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        table(() => state.models).findFirst({ where }),
      findMany: table(() => state.models).findMany,
    },
    fineTunedModel: {
      findUnique: async ({ where }: { where: Row }) => table(() => state.fineTuned).findFirst({ where }),
      create: async ({ data }: { data: Row }) => {
        if (
          state.fineTuned.some(
            (row) =>
              row.trainingJobId === data.trainingJobId ||
              (row.orgId === data.orgId && row.liveSlug === data.liveSlug),
          )
        ) {
          throw uniqueViolation();
        }
        const row = { createdAt: clock.now, ...data };
        state.fineTuned.push(row);
        return { ...row };
      },
    },
    creditBalance: {
      findUnique: async ({ where }: { where: { orgId: string } }) => {
        const row = state.balances.find((balance) => balance.orgId === where.orgId);
        return row ? { ...row } : null;
      },
      updateMany: table(() => state.balances as unknown as Row[]).updateMany,
      update: async ({ where, data }: { where: { orgId: string }; data: Row }) => {
        const row = state.balances.find((balance) => balance.orgId === where.orgId);
        if (!row) throw new Error("fake db: no credit balance");
        assign(row as unknown as Row, data, clock.now);
        return { ...row };
      },
    },
    creditTransaction: {
      create: async ({ data }: { data: Row }) => {
        seq += 1;
        const row = { id: `ledger-${seq}`, createdAt: new Date(clock.now.getTime() + seq), ...data };
        state.ledger.push(row as FakeDb["ledger"][number]);
        return row;
      },
      findMany: table(() => state.ledger as unknown as Row[]).findMany,
    },
    // One transaction at a time; a throw restores everything it touched.
    $transaction: <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const run = async () => {
        const snapshot = structuredClone({ ...state });
        try {
          const result = await fn(client);
          if (failTransactions > 0) {
            failTransactions -= 1;
            throw new Error("fake db: commit failed");
          }
          return result;
        } catch (err) {
          for (const key of Object.keys(state) as Array<keyof typeof state>) {
            (state[key] as unknown[]).splice(0, state[key].length, ...(snapshot[key] as unknown[]));
          }
          throw err;
        }
      };
      const next = chain.then(run, run);
      chain = next.catch(() => undefined);
      return next;
    },
  };

  return {
    prisma: client as unknown as TrainingPrisma,
    ...state,
    failNextTransactions: (n) => {
      failTransactions = n;
    },
    job: (id) => {
      const row = state.jobs.find((job) => job.id === id);
      if (!row) throw new Error(`no job ${id}`);
      return row;
    },
    balance: (orgId = ORG) => state.balances.find((b) => b.orgId === orgId)?.balanceCents ?? 0n,
    ledgerOf: (jobId) =>
      state.ledger
        .filter((row) => row.referenceId === jobId)
        .map(({ type, amountCents, balanceAfter }) => ({ type, amountCents, balanceAfter })),
    insertJob: (row) => {
      const full = {
        ...JOB_DEFAULTS,
        orgId: ORG,
        name: "old job",
        baseModelId: "phi-3-mini",
        baseModelHfId: "microsoft/Phi-3-mini-4k-instruct",
        datasetId: DATASET,
        method: "lora",
        config: {},
        gpuTier: "4090",
        createdAt: clock.now,
        updatedAt: clock.now,
        ...row,
      } as TrainingJobRow;
      state.jobs.push(full);
      return full;
    },
  };
}

/**
 * The fake database with transactions that run CONCURRENTLY, as Postgres
 * runs them under READ COMMITTED, instead of one after another: every read
 * sees whatever is written at that moment, and the only thing that makes one
 * transaction wait for another is a row lock. An update of an organization's
 * credit_balances row takes that row's lock until the transaction ends, as
 * an UPDATE does. There is no rollback here: use it only where a refused
 * transaction writes nothing before it refuses.
 */
export function withRowLocks(db: FakeDb): TrainingPrisma {
  const base = db.prisma as unknown as Record<string, Record<string, (...args: never[]) => unknown>>;
  const holders = new Map<string, Promise<void>>();
  return {
    ...(base as unknown as TrainingPrisma),
    $transaction: async <T>(fn: (tx: never) => Promise<T>): Promise<T> => {
      let release!: () => void;
      const done = new Promise<void>((resolve) => (release = resolve));
      const held = new Set<string>();
      const lock = async (orgId: string) => {
        if (held.has(orgId)) return;
        while (holders.has(orgId)) await holders.get(orgId);
        holders.set(orgId, done);
        held.add(orgId);
      };
      const balances = base.creditBalance!;
      const tx = {
        ...base,
        creditBalance: {
          ...balances,
          updateMany: async (args: { where: { orgId: string } }) => {
            await lock(args.where.orgId);
            return (balances.updateMany as (a: unknown) => unknown)(args);
          },
          update: async (args: { where: { orgId: string } }) => {
            await lock(args.where.orgId);
            return (balances.update as (a: unknown) => unknown)(args);
          },
        },
      };
      try {
        return await fn(tx as never);
      } finally {
        for (const orgId of held) holders.delete(orgId);
        release();
      }
    },
  };
}

// ============================================
// Object store
// ============================================

export interface FakeStore extends ObjectStore {
  objects: Map<string, Buffer>;
  failHead: boolean;
}

export function makeFakeStore(): FakeStore {
  const objects = new Map<string, Buffer>();
  const store: FakeStore = {
    kind: "local",
    objects,
    failHead: false,
    head: async (key) => {
      if (store.failHead) throw new Error("storage unreachable");
      const body = objects.get(key);
      return body ? { size: body.length, etag: createHash("md5").update(body).digest("hex") } : null;
    },
    getStream: async (key) => {
      const body = objects.get(key);
      if (!body) throw new Error("not found");
      return Readable.from([body]);
    },
    put: async (key, body) => void objects.set(key, Buffer.from(body)),
    delete: async (key) => void objects.delete(key),
    deletePrefix: async () => 0,
    presignGet: async () => null,
    presignPut: async () => null,
  };
  return store;
}

// ============================================
// Nosana
// ============================================

export interface FakeNosanaDeployment {
  id: string;
  name: string;
  status: string;
  accessMode: "wallet" | "api_key";
  jobs: Array<{ job: string; status: string }>;
  /** What getDeploymentJob answers; null = it throws. */
  job: null | {
    state: "queued" | "running" | "completed" | "stopped" | "unknown";
    timeStart: Date | null;
    timeEnd: Date | null;
    jobResult: unknown;
  };
  definition: unknown;
  timeoutSeconds: number | undefined;
}

export function makeFakeNosana() {
  const state = {
    deployments: new Map<string, FakeNosanaDeployment>(),
    calls: [] as string[],
    preflightError: null as unknown,
    createError: null as unknown,
    /** Create the deployment on "Nosana" and THEN throw (the id never comes back). */
    createThenThrow: false,
    /** Runs while the create call is in flight. */
    duringCreate: null as null | (() => Promise<void>),
    readError: null as unknown,
    listError: null as unknown,
    stopError: null as unknown,
    stopReclaims: true,
    accessMode: "api_key" as "wallet" | "api_key",
    mock: false,
    seq: 0,
  };
  const need = (id: string) => {
    const deployment = state.deployments.get(id);
    if (!deployment) throw new Error(`deployment ${id} not found`);
    return deployment;
  };
  const port = {
    assertCanDeploy: () => undefined,
    preflightDeploy: async (tier: string, _replicas: number, kind: string, options: { timeoutSeconds?: number }) => {
      state.calls.push(`preflight:${tier}:${kind}:${options.timeoutSeconds}`);
      if (state.preflightError) throw state.preflightError;
    },
    createDeployment: async (
      definition: unknown,
      tier: string,
      _replicas: number,
      options: { kind?: string; name?: string; timeoutSeconds?: number },
    ) => {
      state.calls.push(`create:${tier}:${options.kind}:${options.name}:${options.timeoutSeconds}`);
      if (state.createError) throw state.createError;
      if (state.mock) return { id: "mock_deploy_1", mock: true };
      state.seq += 1;
      const id = `dep-${state.seq}`;
      state.deployments.set(id, {
        id,
        name: options.name ?? "",
        status: "starting",
        accessMode: state.accessMode,
        jobs: [],
        job: null,
        definition,
        timeoutSeconds: options.timeoutSeconds,
      });
      if (state.duringCreate) await state.duringCreate();
      if (state.createThenThrow) {
        throw Object.assign(new Error("create threw after the server acted"), {
          code: "nosana_create_failed",
          mayExistOnNosana: true,
          deploymentName: options.name,
        });
      }
      return { id, accessMode: state.accessMode };
    },
    getDeploymentStatus: async (id: string, mode?: string) => {
      state.calls.push(`status:${id}:${mode}`);
      if (state.readError) throw state.readError;
      const d = need(id);
      return { id, status: d.status, jobs: d.jobs, endpoints: [], events: [], replicas: 1, invalidEndpointCount: 0 };
    },
    getDeploymentJob: async (id: string, job: string, mode?: string) => {
      state.calls.push(`job:${id}:${job}:${mode}`);
      const d = need(id);
      if (!d.job) throw new Error("job unreadable");
      return { deploymentId: id, job, rawState: null, jobStatus: null, node: null, market: null, revision: 1, listedAt: null, raw: {}, ...d.job };
    },
    findDeploymentByIdempotencyKey: async (key: string) => {
      state.calls.push(`key:${key}`);
      if (state.listError) throw state.listError;
      // Every deployment here was created with its name as the key.
      const found = [...state.deployments.values()].find((d) => d.name === key);
      return found ? { id: found.id, name: key, status: found.status, accessMode: found.accessMode } : null;
    },
    findDeploymentByName: async (name: string) => {
      state.calls.push(`find:${name}`);
      if (state.listError) throw state.listError;
      const found = [...state.deployments.values()].find((d) => d.name === name);
      return found ? { id: found.id, name, status: found.status, accessMode: found.accessMode } : null;
    },
    stopDeployment: async (id: string, mode?: string) => {
      state.calls.push(`stop:${id}:${mode}`);
      if (state.stopError) throw state.stopError;
      const d = need(id);
      d.status = "stopped";
      return { deploymentId: id, stopped: true, alreadyStopped: false, reclaimed: state.stopReclaims, remainingNosBaseUnits: 0n };
    },
  };
  return {
    state,
    port,
    deployments: state.deployments,
    calls: state.calls,
    only: () => {
      const all = [...state.deployments.values()];
      if (all.length !== 1) throw new Error(`expected one deployment, found ${all.length}`);
      return all[0]!;
    },
    stops: () => state.calls.filter((call) => call.startsWith("stop:")),
  };
}

/** A Nosana job result as the API types describe it: one op, its exit code, its log. */
export function jobResult(exitCode: number | null, logLines: string[] = []): unknown {
  return {
    status: "success",
    opStates: [
      {
        operationId: "train",
        exitCode,
        logs: logLines.map((log) => ({ type: "stdout", log })),
      },
    ],
  };
}

// ============================================
// Trainer events
// ============================================

export function trainerEvent(seq: number, type: string, fields: Record<string, unknown> = {}) {
  const defaults: Record<string, Record<string, unknown>> = {
    started: { gpu: "RTX 4090", vramGb: 24, device: "cuda", method: "lora", baseModel: "microsoft/Phi-3-mini-4k-instruct", trainerVersion: "0.1.0" },
    phase: { phase: "train" },
    step: { step: 10, totalSteps: 100, epoch: 0.3, loss: 1.5, lr: 0.0002, tokensPerSecond: 900, etaSeconds: 120 },
    eval: { step: 10, evalLoss: 1.4 },
    uploaded: { adapterBytes: 0, adapterSha256: "0".repeat(64) },
    completed: { finalTrainLoss: 0.9, finalEvalLoss: null, trainSeconds: 500, steps: 100, totalSteps: 100, stopReason: "finished" },
    failed: { exitCode: 11, code: "dataset_row_invalid", message: "Row 3 has no completion", phase: "tokenize" },
  };
  return { v: 1, seq, ts: "2026-10-12T10:05:00.000Z", type, ...defaults[type], ...fields };
}

export const eventLine = (event: Record<string, unknown>) => `WHEELSAI_EVENT ${JSON.stringify(event)}`;

// ============================================
// The world
// ============================================

export function makeRuntime(overrides: Partial<TrainingRuntime> = {}): TrainingRuntime {
  const tiers = {
    "3060": { name: "NVIDIA 3060", vram: 12, pricePerSecond: 0.0001 },
    "4090": { name: "NVIDIA 4090", vram: 24, pricePerSecond: 0.00025 },
    a100: { name: "NVIDIA A100", vram: 40, pricePerSecond: 0.0008 },
  };
  return {
    image: { configured: true, reference: IMAGE, registry: null },
    hfToken: undefined,
    pollIntervalMs: 15_000,
    queueTimeoutSeconds: 1_800,
    setupAllowanceSeconds: 900,
    maxActiveJobsPerOrg: 2,
    freeFailuresPerDay: 3,
    orphanSweepEnabled: true,
    adapterMaxBytes: 1024 * 1024,
    datasetMaxBytes: 200 * 1024 * 1024,
    datasetMaxRows: 200_000,
    batchJobTimeoutSeconds: 21_600,
    gpuFacingApiUrl: "https://api.example.com",
    gpuNodesAreLocal: false,
    // The fake store's links are on a public name (issueTransferUrl below).
    storageLinkOrigin: null,
    nosanaMock: false,
    nosanaConfigured: true,
    tiers,
    allTiers: tiers,
    ...overrides,
  };
}

export function makeWorld(options: { balanceCents?: bigint } = {}) {
  const clock = { now: new Date(T0) };
  const db = makeFakeDb(clock);
  const store = makeFakeStore();
  const nosana = makeFakeNosana();
  const world = {
    clock,
    db,
    store: store as FakeStore | null,
    realStore: store,
    nosana,
    runtime: makeRuntime(),
    deferred: [] as Array<() => Promise<unknown>>,
    emitted: [] as Array<{ orgId: string; event: TrainingWebhookEvent; data: Record<string, unknown> }>,
    orphans: [] as Array<Record<string, unknown>>,
    orphanRecordFails: false,
    ids: 0,
  };

  // A validated dataset whose stored object is the one validation read.
  const datasetKey = `datasets/${ORG}/${DATASET}/data.jsonl`;
  const datasetBytes = Buffer.from('{"prompt":"a","completion":"b"}\n'.repeat(50));
  store.objects.set(datasetKey, datasetBytes);
  db.datasets.push({
    id: DATASET,
    orgId: ORG,
    name: "support tickets",
    description: null,
    storageType: "local",
    storageUrl: `store://${datasetKey}`,
    format: "jsonl",
    fileType: "jsonl",
    schemaFormat: "completion",
    sizeBytes: BigInt(datasetBytes.length),
    rowCount: 50,
    rowCountKnown: true,
    avgTokensPerRow: 200,
    totalTokens: 10_000n,
    contentSha256: createHash("sha256").update(datasetBytes).digest("hex"),
    contentEtag: createHash("md5").update(datasetBytes).digest("hex"),
    isValidated: true,
    validationErrors: null,
    sampleRows: null,
    createdAt: T0,
    updatedAt: T0,
    deletedAt: null,
  });
  for (const [id, hfId] of [
    ["phi-3-mini", "microsoft/Phi-3-mini-4k-instruct"],
    ["llama-3.1-8b", "meta-llama/Meta-Llama-3.1-8B-Instruct"],
    ["gemma-2b", "google/gemma-2b-it"],
  ]) {
    db.models.push({ id, hfId, displayName: id, parameters: 3_800_000_000n, isActive: true });
  }
  db.balances.push({ orgId: ORG, balanceCents: options.balanceCents ?? 10_000n });

  const deps: TrainingDeps = {
    prisma: db.prisma,
    getNosana: async () => nosana.port as never,
    getRuntime: async () => world.runtime,
    getStore: () => world.store,
    issueTransferUrl: async (args) => ({
      url: `https://store.example.com/${args.key}?op=${args.op}&ttl=${args.ttlSeconds}&sig=abc`,
      method: args.op === "put" ? "PUT" : "GET",
      headers: {},
      expiresAt: new Date(clock.now.getTime() + args.ttlSeconds * 1000),
      maxBytes: args.maxBytes ?? null,
    }),
    callbackSecret: (jobId, nonce) => deriveTrainingCallbackSecret(jobId, nonce, SERVER_SECRET),
    recordOrphan: async (args) => {
      if (world.orphanRecordFails) return false;
      world.orphans.push({ ...args });
      return true;
    },
    emit: (orgId, event, data) => void world.emitted.push({ orgId, event, data }),
    defer: (task) => void world.deferred.push(task),
    now: () => new Date(clock.now),
    newId: () => {
      world.ids += 1;
      return `aaaaaaaa-0000-4000-8000-${String(world.ids).padStart(12, "0")}`;
    },
    newNonce: () => {
      world.ids += 1;
      return `nonce${String(world.ids).padStart(8, "0")}`;
    },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
  };

  return {
    ...world,
    world,
    deps,
    advance: (seconds: number) => {
      clock.now = new Date(clock.now.getTime() + seconds * 1000);
    },
    /** Runs everything that was deferred (and whatever those defer). */
    drain: async () => {
      while (world.deferred.length > 0) await world.deferred.shift()!();
    },
    events: () => world.emitted.map((entry) => entry.event),
    /** Stores an adapter and its metrics.json as the trainer would, and returns the `uploaded` fields. */
    storeAdapter: (jobId: string, body = Buffer.from("adapter-bytes"), metrics: Record<string, unknown> = {}) => {
      const keys = trainingArtifactKeys(ORG, jobId);
      const sha256 = createHash("sha256").update(body).digest("hex");
      store.objects.set(keys.adapterKey, body);
      store.objects.set(
        keys.metricsKey,
        Buffer.from(
          JSON.stringify({
            schema: 1,
            steps: 100,
            totalSteps: 100,
            stopReason: "finished",
            finalTrainLoss: 0.9,
            trainLoss: [{ step: 1, loss: 2 }, { step: 100, loss: 0.9 }],
            adapter: { bytes: body.length, sha256, r: 16 },
            ...metrics,
          }),
        ),
      );
      return { adapterBytes: body.length, adapterSha256: sha256 };
    },
    /** A signed callback for a job, as the container would send it. */
    callback: (jobId: string, event: Record<string, unknown>, opts: { nonce?: string; at?: Date; secretNonce?: string } = {}) => {
      const nonce = opts.nonce ?? (db.job(jobId).submitNonce as string);
      const rawBody = JSON.stringify({ ...event, jobId });
      const t = Math.floor((opts.at ?? clock.now).getTime() / 1000);
      const secret = deriveTrainingCallbackSecret(jobId, opts.secretNonce ?? nonce, SERVER_SECRET);
      return { jobId, nonce, rawBody, signatureHeader: signTrainingCallback(secret, t, rawBody) };
    },
  };
}

export type World = ReturnType<typeof makeWorld>;

export const JOB_INPUT = {
  name: "Support bot v1",
  baseModelId: "phi-3-mini",
  datasetId: DATASET,
  method: "lora",
  gpuTier: "4090",
  maxRuntimeSeconds: 3_600,
  hyperparams: { epochs: 2 },
};
