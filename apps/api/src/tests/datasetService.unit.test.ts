import "./unitEnv.js";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DatasetNameTakenError,
  FINISHED_TRAINING_JOB_STATUSES,
  MAX_ERROR_MESSAGE_CHARS,
  MAX_SAMPLE_BYTES,
  createDataset,
  datasetObjectKey,
  datasetObjectState,
  deleteDataset,
  describeDatasetStorage,
  knownDatasetRowCount,
  rowCountUnknownRefusal,
  serializeDataset,
  validateStoredDataset,
  type DatasetDb,
  type DatasetDeps,
  type DatasetRecord,
} from "../services/dataset.js";
import { DATASET_SUMMARY_SELECT, prismaDatasetDb } from "../services/buildDatasetDeps.js";
import { parquetFixture } from "./parquetFixtures.js";
import {
  LocalObjectStore,
  S3ObjectStore,
  issueTransferUrl,
  verifyTransferToken,
  type ObjectStore,
} from "../services/objectStore.js";

// The dataset service end to end over a real (temporary) local object store
// and an in-memory table: what is refused before an upload, what validation
// records, and what delete does and refuses.

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const SECRET = "d".repeat(32);
const NOW = new Date("2026-10-11T12:00:00.000Z");

interface FakeJob {
  datasetId: string;
  status: string;
}

/** What JSON.stringify writes for the two things a jsonb column refuses. */
const JSONB_REFUSES = /\\u0000|\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f][0-9a-f]{2})|(?<!\\ud[89ab][0-9a-f]{2})\\ud[c-f][0-9a-f]{2}/i;

/** The datasets table, with the one rule the database enforces: live names are unique. */
function fakeDb() {
  const rows = new Map<string, DatasetRecord & { liveName: string | null }>();
  const jobs: FakeJob[] = [];
  const live = (orgId: string, id: string) => {
    const row = rows.get(id);
    return row && row.orgId === orgId && row.deletedAt === null ? row : null;
  };
  const unfinished = (datasetId: string) =>
    jobs.filter(
      (j) =>
        j.datasetId === datasetId &&
        !(FINISHED_TRAINING_JOB_STATUSES as readonly string[]).includes(j.status),
    ).length;

  const db: DatasetDb = {
    list: async (orgId) =>
      [...rows.values()].filter((r) => r.orgId === orgId && r.deletedAt === null),
    find: async (orgId, id) => live(orgId, id),
    nameTaken: async (orgId, name) =>
      [...rows.values()].some((r) => r.orgId === orgId && r.liveName === name),
    create: async (data) => {
      if ([...rows.values()].some((r) => r.orgId === data.orgId && r.liveName === data.name)) {
        throw new DatasetNameTakenError();
      }
      const row = {
        ...data,
        description: data.description ?? null,
        liveName: data.name,
        schemaFormat: null,
        sizeBytes: 0n,
        rowCount: 0,
        rowCountKnown: true,
        avgTokensPerRow: null,
        totalTokens: null,
        contentSha256: null,
        contentEtag: null,
        isValidated: false,
        validationErrors: null,
        sampleRows: null,
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
      };
      rows.set(row.id, row);
      return row;
    },
    saveValidation: async (orgId, id, update) => {
      const row = live(orgId, id);
      if (!row) return false;
      // The two JSON columns are jsonb: Postgres refuses a NUL and a
      // surrogate without its pair ("unsupported Unicode escape sequence").
      const json = JSON.stringify([update.validationErrors, update.sampleRows]);
      if (JSONB_REFUSES.test(json)) throw new Error("unsupported Unicode escape sequence");
      const { schemaFormat, ...rest } = update;
      Object.assign(row, rest, schemaFormat !== undefined ? { schemaFormat } : {});
      return true;
    },
    countUnfinishedJobs: async (id) => unfinished(id),
    softDeleteIfUnused: async (orgId, id, now) => {
      const row = live(orgId, id);
      if (!row || unfinished(id) > 0) return false;
      row.deletedAt = now;
      row.liveName = null;
      return true;
    },
  };
  return { db, rows, jobs };
}

async function harness(
  t: { after: (fn: () => Promise<void>) => void },
  overrides: { store?: ObjectStore | null; maxBytes?: number; maxRows?: number } = {},
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wheelsai-dataset-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store =
    overrides.store !== undefined ? overrides.store : new LocalObjectStore({ driver: "local", dir });
  const fake = fakeDb();
  let ids = 0;
  const issued: Array<Parameters<DatasetDeps["issueUploadUrl"]>[0]> = [];
  const deps: DatasetDeps = {
    db: fake.db,
    getStore: () => store,
    getLimits: () => ({
      maxBytes: overrides.maxBytes ?? 50 * 1024 * 1024,
      maxRows: overrides.maxRows ?? 1000,
    }),
    issueUploadUrl: (args) => {
      issued.push(args);
      return issueTransferUrl(
        { op: "put", ...args },
        { store, secret: SECRET, publicOrigin: "http://localhost:4300", now: () => NOW.getTime() },
      );
    },
    now: () => NOW,
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
  };
  /** Create a dataset and put `content` where its upload URL points. */
  const upload = async (name: string, fileName: string, content: string | Buffer, extra = {}) => {
    const bytes = Buffer.from(content);
    const created = await createDataset(deps, ORG, {
      name,
      fileName,
      sizeBytes: bytes.length,
      ...extra,
    });
    assert.ok(created.ok, created.ok ? "" : created.body.error);
    const key = datasetObjectKey(created.dataset.storageUrl, store!)!;
    await store!.put(key, bytes);
    return { id: created.dataset.id, key };
  };
  return { deps, store, dir, issued, upload, ...fake };
}

const alpacaRows = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    JSON.stringify({ instruction: `question ${i}`, input: "", output: `answer ${i}` }),
  ).join("\n");

// ============================================
// Create
// ============================================

test("create: issues an upload link bound to the declared size and writes a pending row", async (t) => {
  const h = await harness(t);
  const result = await createDataset(h.deps, ORG, {
    name: "support",
    description: "tickets",
    fileName: "Tickets.JSONL",
    sizeBytes: 4096,
    format: "alpaca",
    contentType: "application/jsonl",
  });
  assert.ok(result.ok);

  const id = "00000000-0000-4000-8000-000000000001";
  const key = `datasets/${ORG}/${id}/data.jsonl`;
  assert.deepEqual(h.issued, [
    {
      key,
      // The lifetime is this caller's choice (one hour), not the store's.
      ttlSeconds: 3600,
      maxBytes: 50 * 1024 * 1024,
      contentType: "application/jsonl",
      contentLength: 4096,
    },
  ]);
  assert.equal(result.upload.method, "PUT");
  assert.equal(result.upload.maxBytes, 4096);
  assert.deepEqual(result.upload.headers, { "Content-Type": "application/jsonl" });
  const verdict = verifyTransferToken(result.upload.url.split("/t/")[1], SECRET, {
    op: "put",
    nowMs: NOW.getTime(),
  });
  assert.ok(verdict.ok);
  assert.equal(verdict.payload.key, key);
  assert.equal(verdict.payload.max, 4096);

  const row = h.rows.get(id)!;
  assert.equal(row.storageUrl, `store://${key}`);
  assert.equal(row.storageType, "local");
  assert.equal(row.fileType, "jsonl"); // from the extension
  assert.equal(row.format, "alpaca"); // as declared
  assert.equal(row.schemaFormat, null); // nothing detected yet
  assert.equal(row.isValidated, false);
});

test("create: every refusal happens before a link is issued or a row written", async (t) => {
  const none = await harness(t, { store: null });
  const base = { name: "n", fileName: "a.jsonl", sizeBytes: 10 };
  const refusal = async (
    h: Awaited<ReturnType<typeof harness>>,
    input: object,
  ): Promise<Record<string, unknown> | null> => {
    const result = await createDataset(h.deps, ORG, { ...base, ...input });
    assert.equal(result.ok, false);
    assert.equal(h.issued.length, 0);
    assert.equal(h.rows.size, 0);
    return result.ok ? null : { status: result.status, ...result.body };
  };

  // Storage is checked first: nothing else matters without it.
  assert.equal((await refusal(none, { sizeBytes: 10 ** 12 }))!.error, "dataset_storage_not_configured");
  assert.equal((await refusal(none, {}))!.status, 503);

  const h = await harness(t, { maxBytes: 1000, maxRows: 500 });
  const type = await refusal(h, { fileName: "notes.txt" });
  assert.deepEqual([type!.status, type!.error], [400, "unsupported_file_type"]);

  const big = await refusal(h, { sizeBytes: 1001 });
  assert.deepEqual([big!.status, big!.error, big!.maxBytes], [413, "dataset_too_large", 1000]);

  const rows = await refusal(h, { rowCount: 501 });
  assert.deepEqual([rows!.status, rows!.error, rows!.maxRows], [413, "dataset_too_many_rows", 500]);

  // Exactly at both limits is accepted.
  const atLimit = await createDataset(h.deps, ORG, { ...base, sizeBytes: 1000, rowCount: 500 });
  assert.equal(atLimit.ok, true);
});

test("create: a live name is taken (409); another organization's name is not", async (t) => {
  const h = await harness(t);
  assert.equal((await createDataset(h.deps, ORG, { name: "a", fileName: "a.csv", sizeBytes: 1 })).ok, true);

  const again = await createDataset(h.deps, ORG, { name: "a", fileName: "b.csv", sizeBytes: 1 });
  assert.equal(again.ok, false);
  assert.deepEqual(again.ok ? null : [again.status, again.body.error], [409, "dataset_name_taken"]);
  assert.equal(h.issued.length, 1); // no second link

  assert.equal(
    (await createDataset(h.deps, OTHER_ORG, { name: "a", fileName: "a.csv", sizeBytes: 1 })).ok,
    true,
  );

  // Two requests that both passed the name check: the unique index decides,
  // and the loser is told the same 409.
  h.deps.db.nameTaken = async () => false;
  const raced = await createDataset(h.deps, ORG, { name: "a", fileName: "c.csv", sizeBytes: 1 });
  assert.deepEqual(raced.ok ? null : [raced.status, raced.body.error], [409, "dataset_name_taken"]);
});

// ============================================
// Validate
// ============================================

test("validate: records type, detected format, counts and token figures; the declared format stays", async (t) => {
  const h = await harness(t);
  const content = alpacaRows(40);
  const { id } = await h.upload("support", "support.jsonl", content, { format: "jsonl" });

  const first = await validateStoredDataset(h.deps, ORG, id);
  assert.ok(first.ok);
  assert.equal(first.validation.isValid, true);
  assert.equal(first.validation.fileType, "jsonl");
  assert.equal(first.validation.schemaFormat, "alpaca");
  assert.equal(first.validation.rowCount, 40);
  assert.equal(first.validation.sizeBytes, Buffer.byteLength(content));

  const row = h.rows.get(id)!;
  assert.equal(row.isValidated, true);
  assert.equal(row.format, "jsonl"); // NOT overwritten with "alpaca"
  assert.equal(row.fileType, "jsonl");
  assert.equal(row.schemaFormat, "alpaca");
  assert.equal(row.rowCount, 40);
  assert.equal(row.rowCountKnown, true);
  assert.equal(row.sizeBytes, BigInt(Buffer.byteLength(content)));
  assert.equal(row.avgTokensPerRow, first.validation.stats!.avgTokensPerRow);
  assert.equal(row.totalTokens, BigInt(first.validation.stats!.totalTokens));
  assert.ok(row.avgTokensPerRow! > 0);
  assert.equal(row.validationErrors, null);
  assert.equal((row.sampleRows as unknown[]).length, 5);

  // Validating again used to fail ("Unsupported format: alpaca").
  const second = await validateStoredDataset(h.deps, ORG, id);
  assert.ok(second.ok);
  assert.deepEqual(second.validation, first.validation);
  assert.equal(h.rows.get(id)!.format, "jsonl");
});

test("validate: a dataset declared alpaca or sharegpt validates, twice", async (t) => {
  const h = await harness(t);
  const sharegpt = Array.from({ length: 12 }, (_, i) =>
    JSON.stringify({
      conversations: [
        { from: "human", value: `q${i}` },
        { from: "gpt", value: `a${i}` },
      ],
    }),
  ).join("\n");
  for (const [format, content] of [
    ["alpaca", alpacaRows(12)],
    ["sharegpt", sharegpt],
  ] as const) {
    const { id } = await h.upload(`declared-${format}`, "data.jsonl", content, { format });
    for (const run of [1, 2]) {
      const result = await validateStoredDataset(h.deps, ORG, id);
      assert.ok(result.ok && result.validation.isValid, `${format} run ${run}`);
      assert.equal(result.validation.schemaFormat, format);
    }
    assert.equal(h.rows.get(id)!.format, format);
    assert.equal(h.rows.get(id)!.schemaFormat, format);
  }
});

test("validate: errors are stored, and cleared by a later clean validation", async (t) => {
  const h = await harness(t);
  const { id, key } = await h.upload("fixme", "fixme.jsonl", `${alpacaRows(3)}\n{broken`);

  const bad = await validateStoredDataset(h.deps, ORG, id);
  assert.ok(bad.ok);
  assert.equal(bad.validation.isValid, false);
  assert.equal(h.rows.get(id)!.isValidated, false);
  assert.equal((h.rows.get(id)!.validationErrors as unknown[]).length, 1);

  await h.store!.put(key, alpacaRows(3));
  const good = await validateStoredDataset(h.deps, ORG, id);
  assert.ok(good.ok && good.validation.isValid);
  assert.equal(h.rows.get(id)!.isValidated, true);
  assert.equal(h.rows.get(id)!.validationErrors, null);
});

test("validate: CSV and Parquet take their own readers; a Parquet row count is unknown", async (t) => {
  const h = await harness(t);
  const csv = await h.upload("csv", "pairs.csv", "prompt,completion\nhi,there\nfoo,bar\n");
  const csvResult = await validateStoredDataset(h.deps, ORG, csv.id);
  assert.ok(csvResult.ok && csvResult.validation.isValid);
  assert.equal(h.rows.get(csv.id)!.fileType, "csv");
  assert.equal(h.rows.get(csv.id)!.schemaFormat, "completion");
  assert.equal(h.rows.get(csv.id)!.rowCount, 2);

  const parquet = Buffer.concat([Buffer.from("PAR1"), Buffer.alloc(2000, 1), Buffer.from("PAR1")]);
  const pq = await h.upload("pq", "table.parquet", parquet);
  const pqResult = await validateStoredDataset(h.deps, ORG, pq.id);
  assert.ok(pqResult.ok && pqResult.validation.isValid);
  assert.equal(pqResult.validation.rowCount, null);
  const row = h.rows.get(pq.id)!;
  assert.equal(row.isValidated, true);
  assert.equal(row.fileType, "parquet");
  assert.equal(row.rowCountKnown, false);
  assert.equal(row.avgTokensPerRow, null);
  assert.equal(row.totalTokens, null);
  assert.equal(row.sizeBytes, BigInt(parquet.length));
  // The API says "unknown" (null), never "0 rows".
  assert.equal(serializeDataset(row).rowCount, null);
  assert.equal(serializeDataset(h.rows.get(csv.id)!).rowCount, 2);

  const fake = await h.upload("fake", "fake.parquet", alpacaRows(5));
  const fakeResult = await validateStoredDataset(h.deps, ORG, fake.id);
  assert.ok(fakeResult.ok);
  assert.equal(fakeResult.validation.isValid, false);
  assert.equal(h.rows.get(fake.id)!.isValidated, false);
});

test("validate: the limits are enforced again on what was actually stored", async (t) => {
  const h = await harness(t, { maxBytes: 2000, maxRows: 20 });

  // The client declared a small file and then stored a larger one.
  const big = await h.upload("big", "big.jsonl", "x", {});
  await h.store!.put(big.key, alpacaRows(100));
  const tooLarge = await validateStoredDataset(h.deps, ORG, big.id);
  assert.deepEqual(tooLarge.ok ? null : [tooLarge.status, tooLarge.body.error, tooLarge.body.maxBytes], [
    413,
    "dataset_too_large",
    2000,
  ]);
  assert.equal(await h.store!.head(big.key), null); // the object does not stay
  assert.equal(h.rows.get(big.id)!.isValidated, false);
  assert.match(JSON.stringify(h.rows.get(big.id)!.validationErrors), /larger than the 2000 byte limit/);

  const many = await h.upload("many", "many.jsonl", "x");
  await h.store!.put(many.key, Array.from({ length: 21 }, () => '{"text":"r"}').join("\n"));
  const tooMany = await validateStoredDataset(h.deps, ORG, many.id);
  assert.deepEqual(tooMany.ok ? null : [tooMany.status, tooMany.body.error, tooMany.body.maxRows], [
    413,
    "dataset_too_many_rows",
    20,
  ]);
  assert.equal(await h.store!.head(many.key), null);
  assert.equal(h.rows.get(many.id)!.isValidated, false);

  const atLimit = await h.upload("ok", "ok.jsonl", "x");
  await h.store!.put(atLimit.key, Array.from({ length: 20 }, () => '{"text":"r"}').join("\n"));
  const ok = await validateStoredDataset(h.deps, ORG, atLimit.id);
  assert.ok(ok.ok && ok.validation.isValid);
});

test("validate: honest refusals for a missing dataset, a missing upload and missing or failing storage", async (t) => {
  const h = await harness(t);
  const code = (r: Awaited<ReturnType<typeof validateStoredDataset>>) =>
    r.ok ? "ok" : `${r.status} ${r.body.error}`;

  const created = await createDataset(h.deps, ORG, { name: "a", fileName: "a.jsonl", sizeBytes: 5 });
  assert.ok(created.ok);
  const id = created.dataset.id;

  assert.equal(
    code(await validateStoredDataset(h.deps, ORG, "99999999-9999-4999-8999-999999999999")),
    "404 dataset_not_found",
  );
  // Another organization cannot validate (or learn of) this dataset.
  assert.equal(code(await validateStoredDataset(h.deps, OTHER_ORG, id)), "404 dataset_not_found");
  assert.equal(code(await validateStoredDataset(h.deps, ORG, id)), "409 dataset_not_uploaded");
  assert.equal(h.rows.get(id)!.isValidated, false);

  assert.equal(
    code(await validateStoredDataset({ ...h.deps, getStore: () => null }, ORG, id)),
    "503 dataset_storage_not_configured",
  );

  // The store failing is not a verdict on the data: the row is left alone.
  const key = datasetObjectKey(created.dataset.storageUrl, h.store!)!;
  await h.store!.put(key, alpacaRows(3));
  assert.equal(code(await validateStoredDataset(h.deps, ORG, id)), "ok");
  const failing: ObjectStore = Object.assign(Object.create(h.store!), {
    getStream: async () => {
      throw new Error("connection reset");
    },
  });
  assert.equal(
    code(await validateStoredDataset({ ...h.deps, getStore: () => failing }, ORG, id)),
    "503 dataset_storage_unavailable",
  );
  assert.equal(h.rows.get(id)!.isValidated, true);
  assert.equal(h.rows.get(id)!.rowCount, 3);
});

// ============================================
// Delete
// ============================================

test("delete: soft delete removes the object, hides the row and frees the name", async (t) => {
  const h = await harness(t);
  const first = await h.upload("support", "support.jsonl", alpacaRows(3));
  // A finished job used it: the row must survive for that job.
  h.jobs.push({ datasetId: first.id, status: "completed" });

  const deleted = await deleteDataset(h.deps, ORG, first.id);
  assert.deepEqual(deleted, { ok: true, objectDeleted: true });
  assert.equal(await h.store!.head(first.key), null);

  const row = h.rows.get(first.id)!;
  assert.equal(row.deletedAt, NOW);
  assert.equal(row.name, "support"); // history keeps the name
  assert.equal(await h.db.find(ORG, first.id), null);
  assert.deepEqual(await h.db.list(ORG), []);

  // Gone is gone: it cannot be validated or deleted a second time.
  assert.equal((await validateStoredDataset(h.deps, ORG, first.id)).ok, false);
  const again = await deleteDataset(h.deps, ORG, first.id);
  assert.deepEqual(again.ok ? null : [again.status, again.body.error], [404, "dataset_not_found"]);

  // The name is free for a new upload, which is a different dataset.
  const second = await h.upload("support", "support.jsonl", alpacaRows(4));
  assert.notEqual(second.id, first.id);
  assert.deepEqual(
    (await h.db.list(ORG)).map((d) => d.id),
    [second.id],
  );
});

test("delete: refused only while a job that has not finished uses the dataset", async (t) => {
  const h = await harness(t);
  const { id, key } = await h.upload("in-use", "in-use.jsonl", alpacaRows(3));

  // Today's unfinished states, and ones the job service will add.
  for (const status of ["pending", "queued", "running", "submitting", "finalizing", "cancelling"]) {
    h.jobs.length = 0;
    h.jobs.push({ datasetId: id, status: "completed" }, { datasetId: id, status });
    const result = await deleteDataset(h.deps, ORG, id);
    assert.deepEqual(
      result.ok ? null : [result.status, result.body.error, result.body.activeJobs],
      [409, "dataset_in_use", 1],
      status,
    );
    assert.equal(h.rows.get(id)!.deletedAt, null, status);
    assert.equal((await h.store!.head(key))!.size, Buffer.byteLength(alpacaRows(3)), status);
  }

  // Every job finished, however it ended: the dataset can go.
  h.jobs.length = 0;
  for (const status of FINISHED_TRAINING_JOB_STATUSES) h.jobs.push({ datasetId: id, status });
  assert.deepEqual(await deleteDataset(h.deps, ORG, id), { ok: true, objectDeleted: true });
});

test("delete: another organization's dataset is not found, and a failed object delete does not block", async (t) => {
  const h = await harness(t);
  const { id } = await h.upload("mine", "mine.jsonl", alpacaRows(3));

  const foreign = await deleteDataset(h.deps, OTHER_ORG, id);
  assert.deepEqual(foreign.ok ? null : foreign.status, 404);
  assert.equal(h.rows.get(id)!.deletedAt, null);

  const broken: ObjectStore = Object.assign(Object.create(h.store!), {
    delete: async () => {
      throw new Error("storage is down");
    },
  });
  const result = await deleteDataset({ ...h.deps, getStore: () => broken }, ORG, id);
  // The row is deleted; the object is reported as left behind (and logged).
  assert.deepEqual(result, { ok: true, objectDeleted: false });
  assert.equal(h.rows.get(id)!.deletedAt, NOW);
});

// ============================================
// Storage URLs and the page's storage state
// ============================================

test("datasetObjectKey: new store:// rows, and older s3:// rows of the configured bucket only", async (t) => {
  const h = await harness(t);
  const s3 = new S3ObjectStore({
    driver: "s3",
    bucket: "wheelsai-datasets",
    region: "auto",
    endpoint: "http://127.0.0.1:9000",
    forcePathStyle: true,
    accessKeyId: "k",
    secretAccessKey: "s",
  });
  assert.equal(datasetObjectKey("store://datasets/o/d/data.jsonl", h.store!), "datasets/o/d/data.jsonl");
  assert.equal(datasetObjectKey("store://datasets/o/d/data.jsonl", s3), "datasets/o/d/data.jsonl");
  assert.equal(datasetObjectKey("s3://wheelsai-datasets/datasets/o/d/data.csv", s3), "datasets/o/d/data.csv");
  assert.equal(
    datasetObjectKey("https://wheelsai-datasets.s3.us-east-1.amazonaws.com/datasets/o/d/data.csv", s3),
    "datasets/o/d/data.csv",
  );
  // Another bucket, or an s3 row read by the local driver: not ours to touch.
  assert.equal(datasetObjectKey("s3://someone-else/datasets/o/d/data.csv", s3), null);
  assert.equal(datasetObjectKey("s3://wheelsai-datasets/datasets/o/d/data.csv", h.store!), null);
  assert.equal(datasetObjectKey("ipfs://whatever", s3), null);
  assert.equal(datasetObjectKey("store://", s3), null);
});

test("describeDatasetStorage: what a page needs to offer an upload or say why it cannot", async (t) => {
  const h = await harness(t, { maxBytes: 1234, maxRows: 56 });
  assert.deepEqual(describeDatasetStorage(h.deps), {
    configured: true,
    maxDatasetBytes: 1234,
    maxDatasetRows: 56,
  });
  assert.equal(describeDatasetStorage({ ...h.deps, getStore: () => null }).configured, false);
});

// ============================================
// What validation read stays bound to the object
// ============================================

const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

test("validate: stores the sha256 of the bytes it read; a later swap of the object is seen", async (t) => {
  const h = await harness(t);
  const content = alpacaRows(40);
  const { id, key } = await h.upload("support", "support.jsonl", content);

  assert.equal(await datasetObjectState(h.store!, h.rows.get(id)!), "not_validated");
  const first = await validateStoredDataset(h.deps, ORG, id);
  assert.ok(first.ok);
  assert.equal(first.validation.contentSha256, sha256(content));
  const row = h.rows.get(id)!;
  assert.equal(row.contentSha256, sha256(content));
  assert.ok(row.contentEtag);
  assert.equal(serializeDataset(row).contentSha256, sha256(content));
  assert.equal(await datasetObjectState(h.store!, row), "unchanged");

  // The upload link still works after validation: the same link, used again,
  // for a different file of the same length.
  const swapped = content.replace(/answer/g, "ANSWER");
  assert.equal(Buffer.byteLength(swapped), Buffer.byteLength(content));
  await new Promise((resolve) => setTimeout(resolve, 5));
  await h.store!.put(key, swapped);
  // The row still says validated, but it names the bytes it counted, and
  // they are not the bytes in the store.
  assert.equal(h.rows.get(id)!.isValidated, true);
  assert.equal(h.rows.get(id)!.contentSha256, sha256(content));
  assert.notEqual(h.rows.get(id)!.contentSha256, sha256(swapped));
  assert.equal(await datasetObjectState(h.store!, h.rows.get(id)!), "changed");

  // A different length is "changed" from the size alone, with no ETag at all.
  assert.equal(
    await datasetObjectState(
      { head: async () => ({ size: Buffer.byteLength(content) + 1 }) },
      { ...h.rows.get(id)!, contentEtag: null },
    ),
    "changed",
  );
  await h.store!.delete(key);
  assert.equal(await datasetObjectState(h.store!, h.rows.get(id)!), "missing");

  // Validating again binds the row to the new bytes.
  await h.store!.put(key, swapped);
  assert.ok((await validateStoredDataset(h.deps, ORG, id)).ok);
  assert.equal(h.rows.get(id)!.contentSha256, sha256(swapped));
  assert.equal(await datasetObjectState(h.store!, h.rows.get(id)!), "unchanged");
});

test("validate: no sha256 for a file that is invalid before its end; one for Parquet", async (t) => {
  const h = await harness(t, { maxRows: 10 });
  const array = await h.upload("array", "array.jsonl", JSON.stringify([{ text: "a" }]) + "\nmore\n");
  assert.ok((await validateStoredDataset(h.deps, ORG, array.id)).ok);
  assert.equal(h.rows.get(array.id)!.isValidated, false);
  assert.equal(h.rows.get(array.id)!.contentSha256, null);
  assert.equal(h.rows.get(array.id)!.contentEtag, null);

  const bytes = parquetFixture("text3");
  const pq = await h.upload("pq", "table.parquet", bytes);
  assert.ok((await validateStoredDataset(h.deps, ORG, pq.id)).ok);
  assert.equal(h.rows.get(pq.id)!.contentSha256, sha256(bytes));
  assert.equal(await datasetObjectState(h.store!, h.rows.get(pq.id)!), "unchanged");
});

// ============================================
// A Parquet row count is read, limited, and never priced as zero
// ============================================

test("validate: Parquet rows are counted from the footer and held to the row limit", async (t) => {
  const h = await harness(t, { maxRows: 6 });

  const three = await h.upload("three", "three.parquet", parquetFixture("text3"));
  const result = await validateStoredDataset(h.deps, ORG, three.id);
  assert.ok(result.ok && result.validation.isValid);
  assert.equal(result.validation.rowCount, 3);
  const row = h.rows.get(three.id)!;
  assert.equal(row.rowCount, 3);
  assert.equal(row.rowCountKnown, true);
  assert.equal(serializeDataset(row).rowCount, 3);
  assert.equal(knownDatasetRowCount(row), 3);

  // Seven rows against a limit of six: refused and removed, like a JSONL.
  const seven = await h.upload("seven", "seven.parquet", parquetFixture("pairs7"));
  const over = await validateStoredDataset(h.deps, ORG, seven.id);
  assert.ok(!over.ok);
  assert.equal(over.status, 413);
  assert.equal(over.body.error, "dataset_too_many_rows");
  assert.equal(await h.store!.head(seven.key), null);
  assert.equal(h.rows.get(seven.id)!.isValidated, false);

  const empty = await h.upload("empty", "empty.parquet", parquetFixture("empty"));
  const none = await validateStoredDataset(h.deps, ORG, empty.id);
  assert.ok(none.ok);
  assert.equal(none.validation.isValid, false);
  assert.match(none.validation.errors[0]!.message, /no rows/);
  assert.equal(h.rows.get(empty.id)!.isValidated, false);
});

test("pricing: a dataset whose rows are not counted has no row count to price, never 0", async (t) => {
  const h = await harness(t);
  // PAR1 at both ends, a footer nothing can read: valid, count unknown.
  const opaque = Buffer.concat([Buffer.from("PAR1"), Buffer.alloc(2000, 1), Buffer.from("PAR1")]);
  const pq = await h.upload("pq", "table.parquet", opaque);
  assert.ok((await validateStoredDataset(h.deps, ORG, pq.id)).ok);
  const row = h.rows.get(pq.id)!;
  assert.equal(row.isValidated, true);
  assert.equal(row.rowCountKnown, false);
  assert.equal(row.rowCount, 0); // the placeholder
  assert.equal(knownDatasetRowCount(row), null);

  const jsonl = await h.upload("rows", "rows.jsonl", alpacaRows(12));
  assert.equal(knownDatasetRowCount(h.rows.get(jsonl.id)!), null); // not validated yet
  assert.ok((await validateStoredDataset(h.deps, ORG, jsonl.id)).ok);
  assert.equal(knownDatasetRowCount(h.rows.get(jsonl.id)!), 12);

  const refusal = rowCountUnknownRefusal();
  assert.equal(refusal.status, 422);
  assert.equal(refusal.body.error, "dataset_row_count_unknown");
});

// ============================================
// Nothing an upload holds can break or bloat the row
// ============================================

test("validate: a NUL or an unpaired surrogate is a row error, and the save goes through", async (t) => {
  const h = await harness(t);
  const cases: Array<[string, string, string | Buffer, RegExp]> = [
    ["escaped NUL in a value", "a.jsonl", '{"text":"hello\\u0000world"}\n{"text":"fine"}\n', /Row contains a NUL character/],
    ["escaped NUL in a key", "b.jsonl", '{"text":"fine","no\\u0000te":"x"}\n', /Row contains a NUL character/],
    ["raw NUL outside a string", "c.jsonl", '\u0000{"text":"a"}\n{"text":"fine"}\n', /Invalid JSON/],
    ["NUL in a role name", "d.jsonl", '{"conversations":[{"from":"x\\u0000","value":"v"}]}\n', /Row contains a NUL character/],
    ["unpaired surrogate", "e.jsonl", '{"text":"a\\ud800b"}\n{"text":"fine"}\n', /unpaired surrogate/],
    ["raw NUL in a CSV cell", "f.csv", Buffer.from("text\nhel\u0000lo\nfine\n"), /Row contains a NUL character/],
    ["raw NUL in a CSV header", "g.csv", Buffer.from("te\u0000xt,text\na,b\n"), /Row contains a NUL character/],
  ];
  for (const [name, fileName, content, expected] of cases) {
    const { id } = await h.upload(name, fileName, content);
    // Before the fix the save threw here and the route answered 500, every time.
    const result = await validateStoredDataset(h.deps, ORG, id);
    assert.ok(result.ok, name);
    assert.equal(result.validation.isValid, false, name);
    assert.match(result.validation.errors[0]!.message, expected, name);
    assert.equal(result.validation.errors[0]!.row, 1 + Number(fileName.endsWith(".csv")), name);
    const row = h.rows.get(id)!;
    assert.equal(row.isValidated, false, name);
    assert.ok(Array.isArray(row.validationErrors), name);
    assert.equal(JSONB_REFUSES.test(JSON.stringify([row.validationErrors, row.sampleRows])), false, name);
  }
});

test("validate: what is kept of large rows and long messages is small", async (t) => {
  const h = await harness(t);
  // Five rows of about 1 MB each, then small ones.
  const big = Array.from({ length: 5 }, (_, i) =>
    JSON.stringify({ instruction: `q${i} ` + "x".repeat(1024 * 1024), input: "", output: "\u0001".repeat(4000) }),
  );
  const { id } = await h.upload("big", "big.jsonl", [...big, alpacaRows(10)].join("\n"));
  const result = await validateStoredDataset(h.deps, ORG, id);
  assert.ok(result.ok && result.validation.isValid);
  assert.equal(result.validation.rowCount, 15);
  const row = h.rows.get(id)!;
  const stored = Buffer.byteLength(JSON.stringify(row.sampleRows));
  assert.ok(stored <= MAX_SAMPLE_BYTES, `sample rows weigh ${stored} bytes`);
  // Still a preview of the first rows, each field cut short.
  const samples = row.sampleRows as Array<Record<string, string>>;
  assert.equal(samples.length, 5);
  assert.ok(samples[0]!.instruction!.startsWith("q0 xxx"));
  assert.ok(samples[0]!.instruction!.length <= 400);
  assert.ok(samples[0]!.instruction!.endsWith("\u2026"));
  // The token figures are still those of the whole rows.
  assert.ok(Number(row.totalTokens) > 5 * 1024 * 1024 / 4);

  // A wide and deep row is cut the same way.
  const wide: Record<string, unknown> = { text: "t" };
  for (let i = 0; i < 5000; i++) wide[`k${i}`] = [[[[[[[["deep"]]]]]]], "v".repeat(100)];
  const w = await h.upload("wide", "wide.jsonl", Array(6).fill(JSON.stringify(wide)).join("\n"));
  assert.ok((await validateStoredDataset(h.deps, ORG, w.id)).ok);
  assert.ok(Buffer.byteLength(JSON.stringify(h.rows.get(w.id)!.sampleRows)) <= MAX_SAMPLE_BYTES);

  // An error message that quotes the upload (a 100 KB role name) is cut too.
  const role = JSON.stringify({ conversations: [{ from: "r".repeat(100 * 1024), value: "v" }] });
  const r = await h.upload("roles", "roles.jsonl", Array(60).fill(role).join("\n"));
  const bad = await validateStoredDataset(h.deps, ORG, r.id);
  assert.ok(bad.ok);
  assert.equal(bad.validation.errorCount, 60);
  assert.equal(bad.validation.errors.length, 50);
  for (const error of bad.validation.errors) {
    assert.ok(error.message.length <= MAX_ERROR_MESSAGE_CHARS);
  }
  assert.ok(JSON.stringify(h.rows.get(r.id)!.validationErrors).length < 50 * 500);
});

// ============================================
// The Prisma adapter's queries
// ============================================

test("prismaDatasetDb: every query is scoped to live rows; delete is one conditional write", async () => {
  const calls: Array<{ op: string; args: any }> = [];
  const record = (op: string, result: unknown) => async (args: any) => {
    calls.push({ op, args });
    return result;
  };
  const prisma = {
    dataset: {
      findMany: record("findMany", []),
      findFirst: record("findFirst", null),
      create: async (args: any) => {
        calls.push({ op: "create", args });
        throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      },
      updateMany: record("updateMany", { count: 0 }),
    },
    trainingJob: { count: record("count", 2) },
  };
  const db = prismaDatasetDb(prisma as never);
  const unfinished = { status: { notIn: ["completed", "failed", "cancelled"] } };

  await db.list(ORG);
  await db.find(ORG, "d1");
  assert.equal(await db.nameTaken(ORG, "support"), false);
  assert.equal(await db.countUnfinishedJobs("d1"), 2);
  assert.equal(await db.softDeleteIfUnused(ORG, "d1", NOW), false);
  assert.equal(
    await db.saveValidation(ORG, "d1", {
      isValidated: true,
      rowCount: 3,
      rowCountKnown: true,
      sizeBytes: 10n,
      schemaFormat: "text",
      avgTokensPerRow: 4,
      totalTokens: 12n,
      contentSha256: "ab".repeat(32),
      contentEtag: '"e1"',
      validationErrors: null,
      sampleRows: [],
    }),
    false,
  );
  await assert.rejects(
    db.create({
      id: "d2",
      orgId: ORG,
      name: "support",
      description: undefined,
      storageType: "local",
      storageUrl: "store://datasets/o/d2/data.jsonl",
      format: "jsonl",
      fileType: "jsonl",
    }),
    DatasetNameTakenError,
  );

  const where = (op: string) => calls.find((c) => c.op === op)!.args.where;
  assert.deepEqual(where("findMany"), { orgId: ORG, deletedAt: null });
  assert.deepEqual(where("findFirst"), { id: "d1", orgId: ORG, deletedAt: null });
  // The name check is on liveName, which a deleted dataset no longer has.
  assert.deepEqual(calls.filter((c) => c.op === "findFirst")[1]!.args.where, {
    orgId: ORG,
    liveName: "support",
  });
  assert.deepEqual(where("count"), { datasetId: "d1", ...unfinished });

  const [softDelete, saveValidation] = calls.filter((c) => c.op === "updateMany");
  assert.deepEqual(softDelete!.args, {
    where: { id: "d1", orgId: ORG, deletedAt: null, trainingJobs: { none: unfinished } },
    data: { deletedAt: NOW, liveName: null },
  });
  assert.deepEqual(saveValidation!.args.where, { id: "d1", orgId: ORG, deletedAt: null });
  // The declared format is not among the columns a validation writes.
  assert.equal("format" in saveValidation!.args.data, false);
  assert.equal("fileType" in saveValidation!.args.data, false);
  assert.equal(saveValidation!.args.data.schemaFormat, "text");
  assert.equal(saveValidation!.args.data.contentSha256, "ab".repeat(32));
  assert.equal(saveValidation!.args.data.contentEtag, '"e1"');

  // A list never loads the two JSON columns written from uploaded content.
  const listSelect = calls.find((c) => c.op === "findMany")!.args.select;
  assert.equal(listSelect, DATASET_SUMMARY_SELECT);
  assert.equal("sampleRows" in listSelect, false);
  assert.equal("validationErrors" in listSelect, false);
  for (const column of ["id", "name", "rowCount", "rowCountKnown", "contentSha256", "isValidated"] as const) {
    assert.equal(listSelect[column], true, column);
  }

  assert.equal(calls.find((c) => c.op === "create")!.args.data.liveName, "support");
});
