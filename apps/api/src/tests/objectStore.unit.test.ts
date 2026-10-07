import "./unitEnv.js";

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import Fastify from "fastify";

import { loadTrainingConfig, type S3StoreConfig } from "../config/training.js";
import { validateEnv } from "../config/env.js";
import {
  LocalObjectStore,
  MAX_PRESIGN_TTL_SECONDS,
  ObjectNotFoundError,
  ObjectStoreNotConfiguredError,
  ObjectTooLargeError,
  S3ObjectStore,
  UnsafeObjectKeyError,
  buildS3ClientConfig,
  createObjectStore,
  isSafeObjectKey,
  issueTransferUrl,
  signTransferToken,
  verifyTransferToken,
  type TransferDeps,
} from "../services/objectStore.js";
import { createStorageTransferRoutes } from "../routes/storageTransfer.js";

// The object store behind datasets and adapters: both drivers, the transfer
// token that stands in for a presigned URL on the local driver, and the two
// routes that honour it. Nothing here opens a socket: the S3 driver is only
// built and asked to sign, which is local arithmetic.

const SECRET = "t".repeat(32);
const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);

async function tempDir(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wheelsai-objectstore-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function readStream(stream: Readable): Promise<string> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts).toString("utf8");
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => e.name);
}

const S3_CONFIG: S3StoreConfig = {
  driver: "s3",
  bucket: "wheelsai-test",
  region: "auto",
  endpoint: "http://127.0.0.1:9000",
  forcePathStyle: true,
  accessKeyId: "test-access-key",
  secretAccessKey: "test-secret-key",
};

// ============================================
// Configuration
// ============================================

test("config: nothing set means no storage, with the missing names as the reason", () => {
  const config = loadTrainingConfig({});
  assert.equal(config.storage.driver, null);
  assert.match((config.storage as { reason: string }).reason, /AWS_ACCESS_KEY_ID/);
  assert.equal(config.datasetMaxBytes, 200 * 1024 * 1024);
  assert.equal(config.datasetMaxRows, 200_000);
});

test("config: key, secret and bucket select the s3 driver; an endpoint defaults the region to auto", () => {
  const base = {
    AWS_ACCESS_KEY_ID: "k",
    AWS_SECRET_ACCESS_KEY: "s",
    DATASETS_BUCKET: "b",
  };
  const aws = loadTrainingConfig(base).storage;
  assert.deepEqual(aws, {
    driver: "s3",
    bucket: "b",
    region: "us-east-1",
    endpoint: undefined,
    forcePathStyle: false,
    accessKeyId: "k",
    secretAccessKey: "s",
  });

  const minio = loadTrainingConfig({
    ...base,
    S3_ENDPOINT: "http://127.0.0.1:9000",
    S3_FORCE_PATH_STYLE: "true",
  }).storage;
  assert.equal(minio.driver, "s3");
  assert.equal((minio as S3StoreConfig).region, "auto");
  assert.equal((minio as S3StoreConfig).endpoint, "http://127.0.0.1:9000");
  assert.equal((minio as S3StoreConfig).forcePathStyle, true);

  // Two of three is not configured, and the bucket never falls back to a name.
  assert.equal(loadTrainingConfig({ ...base, DATASETS_BUCKET: "" }).storage.driver, null);
});

test("config: the local driver exists in development only", () => {
  const dev = loadTrainingConfig({
    NODE_ENV: "development",
    STORAGE_DRIVER: "local",
    STORAGE_LOCAL_DIR: "/tmp/somewhere",
  }).storage;
  assert.deepEqual(dev, { driver: "local", dir: "/tmp/somewhere" });

  for (const NODE_ENV of ["staging", "production"]) {
    const deployed = loadTrainingConfig({
      NODE_ENV,
      STORAGE_DRIVER: "local",
      // Even with a complete s3 configuration beside it: asking for local
      // outside development is refused, not quietly swapped for a bucket.
      AWS_ACCESS_KEY_ID: "k",
      AWS_SECRET_ACCESS_KEY: "s",
      DATASETS_BUCKET: "b",
    }).storage;
    assert.equal(deployed.driver, null, NODE_ENV);
    assert.equal(createObjectStore(deployed), null);
  }
});

test("config: bad values are named, not ignored", () => {
  assert.throws(() => loadTrainingConfig({ S3_ENDPOINT: "not a url" }), /S3_ENDPOINT/);
  assert.throws(() => loadTrainingConfig({ STORAGE_DRIVER: "gcs" }), /STORAGE_DRIVER/);
  assert.throws(() => loadTrainingConfig({ TRAINING_DATASET_MAX_BYTES: "12" }), /MAX_BYTES/);
});

test("env: a deployed environment refuses to boot with STORAGE_DRIVER=local", () => {
  const deployed = {
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://u:p@db.internal:5432/wheelsai",
    JWT_SECRET: "j".repeat(32),
    ENCRYPTION_KEY: "e".repeat(32),
    CORS_ORIGIN: "https://app.example.com",
    STORAGE_DRIVER: "local",
  };
  assert.throws(() => validateEnv(deployed), /STORAGE_DRIVER=local/);
});

// ============================================
// Keys
// ============================================

test("keys: only plain relative paths are keys", () => {
  for (const key of [
    "datasets/org/ds/data.jsonl",
    "adapters/0d4f7b1e-3a52-4b8e-9f60-1c2d3e4f5a6b/adapter.tar.gz",
    "a",
  ]) {
    assert.equal(isSafeObjectKey(key), true, key);
  }
  for (const key of [
    "",
    "/etc/passwd",
    "../outside",
    "datasets/../../outside",
    "datasets/./x",
    "datasets//x",
    "datasets/x/",
    "datasets\\..\\x",
    "datasets/.hidden",
    ".tmp/x",
    "datasets/x\u0000y",
    "datasets/%2e%2e/x",
    "datasets/x y",
    "x".repeat(600),
    42,
    null,
  ]) {
    assert.equal(isSafeObjectKey(key), false, String(key));
  }
});

// ============================================
// Local driver
// ============================================

test("local driver: put, head, get, ranged get, delete and deletePrefix", async (t) => {
  const store = new LocalObjectStore({ driver: "local", dir: await tempDir(t) });
  assert.equal(store.kind, "local");

  assert.equal(await store.head("datasets/o/d/data.jsonl"), null);
  await assert.rejects(store.getStream("datasets/o/d/data.jsonl"), ObjectNotFoundError);

  await store.put("datasets/o/d/data.jsonl", "0123456789");
  const head = await store.head("datasets/o/d/data.jsonl");
  assert.equal(head!.size, 10);
  // An ETag that moves when the object is replaced, also by same-size bytes.
  await new Promise((resolve) => setTimeout(resolve, 5));
  await store.put("datasets/o/d/data.jsonl", "9876543210");
  assert.notEqual((await store.head("datasets/o/d/data.jsonl"))!.etag, head!.etag);
  await store.put("datasets/o/d/data.jsonl", "0123456789");
  assert.equal(await readStream(await store.getStream("datasets/o/d/data.jsonl")), "0123456789");
  assert.equal(
    await readStream(await store.getStream("datasets/o/d/data.jsonl", { start: 6, end: 9 })),
    "6789",
  );

  // A local store cannot presign; issueTransferUrl is what covers for it.
  assert.equal(await store.presignGet(), null);
  assert.equal(await store.presignPut(), null);

  await store.delete("datasets/o/d/data.jsonl");
  assert.equal(await store.head("datasets/o/d/data.jsonl"), null);
  await store.delete("datasets/o/d/data.jsonl"); // gone already: not an error

  await store.put("adapters/o/m1/adapter.tar.gz", "a");
  await store.put("adapters/o/m1/metrics.json", "{}");
  await store.put("adapters/o/m10/adapter.tar.gz", "b");
  assert.equal(await store.deletePrefix("adapters/o/m1/"), 2);
  assert.equal(await store.head("adapters/o/m1/metrics.json"), null);
  // The neighbour whose name merely starts the same is untouched.
  assert.equal((await store.head("adapters/o/m10/adapter.tar.gz"))!.size, 1);
  assert.equal(await store.deletePrefix("adapters/o/missing/"), 0);
  await assert.rejects(store.deletePrefix("adapters/o/m1"), UnsafeObjectKeyError);
});

test("local driver: no key can leave the storage directory", async (t) => {
  const outer = await tempDir(t);
  const root = path.join(outer, "store");
  const store = new LocalObjectStore({ driver: "local", dir: root });
  await fs.writeFile(path.join(outer, "secret.txt"), "outside");

  for (const key of ["../secret.txt", "a/../../secret.txt", "/etc/hostname", "a/..", ".tmp/x"]) {
    await assert.rejects(store.head(key), UnsafeObjectKeyError, key);
    await assert.rejects(store.getStream(key), UnsafeObjectKeyError, key);
    await assert.rejects(store.put(key, "x"), UnsafeObjectKeyError, key);
    await assert.rejects(store.delete(key), UnsafeObjectKeyError, key);
    await assert.rejects(
      store.putStream(key, Readable.from([Buffer.from("x")]), 10),
      UnsafeObjectKeyError,
      key,
    );
  }
  await assert.rejects(store.deletePrefix("../"), UnsafeObjectKeyError);
  assert.equal(await fs.readFile(path.join(outer, "secret.txt"), "utf8"), "outside");
});

test("local driver: a streamed upload is cut off at the limit and leaves nothing behind", async (t) => {
  const root = await tempDir(t);
  const store = new LocalObjectStore({ driver: "local", dir: root });

  const ok = await store.putStream("datasets/o/d/data.jsonl", Readable.from([Buffer.alloc(100)]), 100);
  assert.deepEqual(ok, { size: 100 });

  let produced = 0;
  const endless = new Readable({
    read() {
      produced += 1;
      this.push(Buffer.alloc(64 * 1024));
    },
  });
  await assert.rejects(
    store.putStream("datasets/o/big/data.jsonl", endless, 1024 * 1024),
    ObjectTooLargeError,
  );
  // Stopped near the limit, not after reading "everything".
  assert.ok(produced < 64, `read ${produced} chunks`);
  assert.equal(await store.head("datasets/o/big/data.jsonl"), null);
  assert.deepEqual(await listFiles(root), ["data.jsonl"]); // no temp file left
});

// ============================================
// S3-compatible driver (built and asked to sign; no request is sent)
// ============================================

test("s3 driver: the client is built with the endpoint, path style and region from config", async () => {
  const clientConfig = buildS3ClientConfig(S3_CONFIG);
  assert.equal(clientConfig.endpoint, "http://127.0.0.1:9000");
  assert.equal(clientConfig.forcePathStyle, true);
  assert.equal(clientConfig.region, "auto");
  assert.equal(clientConfig.requestChecksumCalculation, "WHEN_REQUIRED");
  // AWS itself: no endpoint key at all, so the SDK resolves the regional one.
  assert.equal("endpoint" in buildS3ClientConfig({ ...S3_CONFIG, endpoint: undefined }), false);

  const store = createObjectStore(S3_CONFIG);
  assert.ok(store instanceof S3ObjectStore);
  assert.equal(store.kind, "s3");
  assert.equal(store.bucket, "wheelsai-test");
  const endpoint = await (
    store.client.config.endpoint as unknown as () => Promise<{ hostname: string; port: number }>
  )();
  assert.equal(endpoint.hostname, "127.0.0.1");
  assert.equal(endpoint.port, 9000);
  assert.equal(store.client.config.forcePathStyle, true);
  assert.equal(await store.client.config.region(), "auto");
});

test("s3 driver: presigned URLs are path-style on the endpoint, sign type and length, and cap at seven days", async () => {
  const store = new S3ObjectStore(S3_CONFIG);

  const put = new URL(
    await store.presignPut("datasets/o/d/data.jsonl", 3600, {
      contentType: "application/jsonl",
      contentLength: 1234,
    }),
  );
  assert.equal(put.origin, "http://127.0.0.1:9000");
  assert.equal(put.pathname, "/wheelsai-test/datasets/o/d/data.jsonl");
  assert.equal(put.searchParams.get("X-Amz-Expires"), "3600");
  assert.equal(put.searchParams.get("X-Amz-SignedHeaders"), "content-length;content-type;host");
  assert.match(put.searchParams.get("X-Amz-Credential") ?? "", /\/auto\/s3\/aws4_request$/);
  // No checksum parameter a browser upload would have to reproduce.
  assert.equal([...put.searchParams.keys()].some((k) => /checksum/i.test(k)), false);
  // The secret is used to sign; it is never part of the URL.
  assert.equal(put.href.includes(S3_CONFIG.secretAccessKey), false);

  const get = new URL(await store.presignGet("datasets/o/d/data.jsonl", 30 * 24 * 3600));
  assert.equal(get.pathname, "/wheelsai-test/datasets/o/d/data.jsonl");
  assert.equal(get.searchParams.get("X-Amz-Expires"), String(MAX_PRESIGN_TTL_SECONDS));
  assert.equal(get.searchParams.get("X-Amz-SignedHeaders"), "host");

  await assert.rejects(store.presignGet("../x", 60), UnsafeObjectKeyError);
  await assert.rejects(store.presignPut("datasets/o/d/data.jsonl", 0), RangeError);
});

test("s3 driver: without path style the bucket is a subdomain of the endpoint", async () => {
  const store = new S3ObjectStore({
    ...S3_CONFIG,
    endpoint: "https://account.r2.example.com",
    forcePathStyle: false,
  });
  const url = new URL(await store.presignGet("datasets/o/d/data.csv", 60));
  assert.equal(url.host, "wheelsai-test.account.r2.example.com");
  assert.equal(url.pathname, "/datasets/o/d/data.csv");
});

// ============================================
// Transfer tokens
// ============================================

test("transfer token: accepted as issued; forged, altered, expired and wrong-operation ones are not", () => {
  const exp = Math.floor(NOW / 1000) + 600;
  const payload = { v: 1 as const, op: "put" as const, key: "datasets/o/d/data.jsonl", exp, max: 1000 };
  const token = signTransferToken(payload, SECRET);

  assert.deepEqual(verifyTransferToken(token, SECRET, { op: "put", nowMs: NOW }), {
    ok: true,
    payload,
  });

  const reason = (t: unknown, op: "get" | "put" = "put", nowMs = NOW, secret = SECRET) => {
    const verdict = verifyTransferToken(t, secret, { op, nowMs });
    return verdict.ok ? "ok" : verdict.reason;
  };

  // Signed with another secret.
  assert.equal(reason(signTransferToken(payload, "x".repeat(32))), "bad_signature");
  assert.equal(reason(token, "put", NOW, "y".repeat(32)), "bad_signature");
  // The payload swapped for one naming another key, the signature kept.
  const [, mac] = token.split(".");
  const swapped = Buffer.from(
    JSON.stringify({ ...payload, key: "datasets/other/d/data.jsonl" }),
  ).toString("base64url");
  assert.equal(reason(`${swapped}.${mac}`), "bad_signature");
  // The limit raised.
  const raised = Buffer.from(JSON.stringify({ ...payload, max: 10 ** 12 })).toString("base64url");
  assert.equal(reason(`${raised}.${mac}`), "bad_signature");
  // A truncated signature.
  assert.equal(reason(token.slice(0, -4)), "bad_signature");

  assert.equal(reason(token, "put", exp * 1000), "expired");
  assert.equal(reason(token, "put", exp * 1000 + 1), "expired");
  assert.equal(reason(token, "put", exp * 1000 - 1), "ok");
  assert.equal(reason(token, "get"), "wrong_operation");

  for (const junk of ["", "abc", "a.b.c", ".", 12, null, undefined, "x".repeat(5000)]) {
    assert.equal(reason(junk), "malformed", String(junk));
  }
  // Correctly signed, but for a key that could leave the directory: the
  // signature alone is not enough.
  const escaping = signTransferToken({ ...payload, key: "../../etc/passwd" }, SECRET);
  assert.equal(reason(escaping), "malformed");
});

// ============================================
// issueTransferUrl
// ============================================

function transferDeps(store: TransferDeps["store"]): TransferDeps {
  return { store, secret: SECRET, publicOrigin: "http://localhost:4300", now: () => NOW };
}

test("issueTransferUrl: no store is an error, not a URL", async () => {
  await assert.rejects(
    issueTransferUrl({ op: "get", key: "a/b", ttlSeconds: 60 }, transferDeps(null)),
    ObjectStoreNotConfiguredError,
  );
});

test("issueTransferUrl (local): a token URL on this API carrying op, key, expiry and limit", async (t) => {
  const store = new LocalObjectStore({ driver: "local", dir: await tempDir(t) });
  const deps = transferDeps(store);

  const put = await issueTransferUrl(
    {
      op: "put",
      key: "datasets/o/d/data.jsonl",
      ttlSeconds: 3600,
      maxBytes: 5000,
      contentType: "application/jsonl",
      contentLength: 1200,
    },
    deps,
  );
  assert.equal(put.method, "PUT");
  assert.deepEqual(put.headers, { "Content-Type": "application/jsonl" });
  assert.equal(put.expiresAt.getTime(), NOW + 3600_000);
  // The declared size is the tighter bound, so it is the one enforced.
  assert.equal(put.maxBytes, 1200);
  assert.ok(put.url.startsWith("http://localhost:4300/api/storage/t/"));
  const token = put.url.split("/t/")[1]!;
  const verdict = verifyTransferToken(token, SECRET, { op: "put", nowMs: NOW });
  assert.ok(verdict.ok);
  assert.deepEqual(verdict.payload, {
    v: 1,
    op: "put",
    key: "datasets/o/d/data.jsonl",
    exp: Math.floor(NOW / 1000) + 3600,
    max: 1200,
  });

  const get = await issueTransferUrl({ op: "get", key: "datasets/o/d/data.jsonl", ttlSeconds: 60 }, deps);
  assert.equal(get.method, "GET");
  assert.deepEqual(get.headers, {});
  assert.equal(get.maxBytes, null);

  // The caller picks the lifetime; the store only caps it.
  const long = await issueTransferUrl(
    { op: "get", key: "datasets/o/d/data.jsonl", ttlSeconds: 90 * 24 * 3600 },
    deps,
  );
  assert.equal(long.expiresAt.getTime(), NOW + MAX_PRESIGN_TTL_SECONDS * 1000);

  await assert.rejects(
    issueTransferUrl({ op: "put", key: "datasets/o/d/data.jsonl", ttlSeconds: 60 }, deps),
    /maxBytes is required/,
  );
  await assert.rejects(
    issueTransferUrl({ op: "get", key: "../escape", ttlSeconds: 60 }, deps),
    UnsafeObjectKeyError,
  );
});

test("issueTransferUrl (s3): a presigned URL; the size is enforced only when the exact length is known", async () => {
  const deps = transferDeps(new S3ObjectStore(S3_CONFIG));

  const exact = await issueTransferUrl(
    {
      op: "put",
      key: "datasets/o/d/data.jsonl",
      ttlSeconds: 600,
      maxBytes: 5000,
      contentType: "application/jsonl",
      contentLength: 1200,
    },
    deps,
  );
  assert.equal(exact.method, "PUT");
  assert.equal(exact.maxBytes, 1200);
  assert.deepEqual(exact.headers, { "Content-Type": "application/jsonl" });
  assert.match(exact.url, /X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost/);

  // A container uploading an adapter does not know its size up front: the URL
  // then promises no limit, and says so.
  const open = await issueTransferUrl(
    { op: "put", key: "adapters/o/j/adapter.tar.gz", ttlSeconds: 600, maxBytes: 5000 },
    deps,
  );
  assert.equal(open.maxBytes, null);

  const get = await issueTransferUrl(
    { op: "get", key: "datasets/o/d/data.jsonl", ttlSeconds: 10 ** 9 },
    deps,
  );
  assert.equal(get.method, "GET");
  assert.match(get.url, new RegExp(`X-Amz-Expires=${MAX_PRESIGN_TTL_SECONDS}`));
  assert.equal(get.expiresAt.getTime(), NOW + MAX_PRESIGN_TTL_SECONDS * 1000);
});

// ============================================
// Transfer routes
// ============================================

async function transferApp(
  t: { after: (fn: () => Promise<void>) => void },
  options: { store?: TransferDeps["store"]; now?: () => number } = {},
) {
  const root = await tempDir(t);
  const store =
    options.store !== undefined ? options.store : new LocalObjectStore({ driver: "local", dir: root });
  const app = Fastify({ logger: false });
  await app.register(
    createStorageTransferRoutes({
      getStore: () => store,
      getSecret: () => SECRET,
      now: options.now ?? (() => NOW),
    }),
    { prefix: "/api/storage" },
  );
  t.after(() => app.close());
  const deps = transferDeps(store);
  const urlFor = async (args: Parameters<typeof issueTransferUrl>[0]) =>
    new URL((await issueTransferUrl(args, deps)).url).pathname;
  return { app, store, root, urlFor };
}

test("transfer routes: upload through a signed link, then download through another", async (t) => {
  const { app, store, urlFor } = await transferApp(t);
  const key = "datasets/o/d/data.jsonl";
  // Larger than Fastify's default 1 MiB body limit: the body is streamed.
  const body = Buffer.alloc(3 * 1024 * 1024, "a");

  const put = await app.inject({
    method: "PUT",
    url: await urlFor({ op: "put", key, ttlSeconds: 60, maxBytes: body.length }),
    headers: { "content-type": "application/jsonl" },
    payload: body,
  });
  assert.equal(put.statusCode, 200, put.body);
  assert.deepEqual(put.json(), { stored: true, size: body.length });
  assert.equal((await store!.head(key))!.size, body.length);

  const get = await app.inject({
    method: "GET",
    url: await urlFor({ op: "get", key, ttlSeconds: 60 }),
  });
  assert.equal(get.statusCode, 200);
  assert.equal(get.headers["content-length"], String(body.length));
  assert.equal(get.rawPayload.equals(body), true);

  // A JSON content type is not parsed (and not limited) either.
  const json = await app.inject({
    method: "PUT",
    url: await urlFor({ op: "put", key: "adapters/o/j/metrics.json", ttlSeconds: 60, maxBytes: 100 }),
    headers: { "content-type": "application/json" },
    payload: '{"schema":1}',
  });
  assert.equal(json.statusCode, 200, json.body);
  assert.equal(await readStream(await store!.getStream("adapters/o/j/metrics.json")), '{"schema":1}');
});

test("transfer routes: forged, expired and wrong-operation links are 401 and write nothing", async (t) => {
  let now = NOW;
  const { app, root, urlFor } = await transferApp(t, { now: () => now });
  const key = "datasets/o/d/data.jsonl";
  const putUrl = await urlFor({ op: "put", key, ttlSeconds: 60, maxBytes: 100 });
  const getUrl = await urlFor({ op: "get", key, ttlSeconds: 60 });

  const attempt = async (method: "GET" | "PUT", url: string) => {
    const res = await app.inject({ method, url, payload: method === "PUT" ? "hello" : undefined });
    return { status: res.statusCode, error: res.json().error };
  };
  const refused = { status: 401, error: "invalid_transfer_token" };

  // Forged: signed with a secret the server does not hold.
  const forged = signTransferToken(
    { v: 1, op: "put", key, exp: Math.floor(NOW / 1000) + 60, max: 100 },
    "f".repeat(32),
  );
  assert.deepEqual(await attempt("PUT", `/api/storage/t/${forged}`), refused);
  assert.deepEqual(await attempt("PUT", "/api/storage/t/not-a-token"), refused);
  // A download link cannot upload, and an upload link cannot download.
  assert.deepEqual(await attempt("PUT", getUrl), refused);
  assert.deepEqual(await attempt("GET", putUrl), refused);
  // Expired.
  now = NOW + 61_000;
  assert.deepEqual(await attempt("PUT", putUrl), refused);
  assert.deepEqual(await attempt("GET", getUrl), refused);

  assert.deepEqual(await listFiles(root), []);
});

test("transfer routes: an oversize body is 413 whether or not it declares its length", async (t) => {
  const { app, store, root, urlFor } = await transferApp(t);
  const key = "datasets/o/d/data.jsonl";
  const url = await urlFor({ op: "put", key, ttlSeconds: 60, maxBytes: 1000 });

  // Declared: refused on the header, before the body is read.
  const declared = await app.inject({ method: "PUT", url, payload: Buffer.alloc(1001) });
  assert.equal(declared.statusCode, 413);
  assert.equal(declared.json().error, "object_too_large");
  assert.equal(declared.json().maxBytes, 1000);

  // Not declared (a stream has no Content-Length): counted while it streams.
  const chunks = Array.from({ length: 40 }, () => Buffer.alloc(100));
  const streamed = await app.inject({ method: "PUT", url, payload: Readable.from(chunks) });
  assert.equal(streamed.statusCode, 413);
  assert.equal(streamed.json().error, "object_too_large");

  assert.equal(await store!.head(key), null);
  assert.deepEqual(await listFiles(root), []);

  // Exactly at the limit is fine.
  const atLimit = await app.inject({ method: "PUT", url, payload: Buffer.alloc(1000) });
  assert.equal(atLimit.statusCode, 200);
});

test("transfer routes: a signed link for a key outside the directory is refused", async (t) => {
  const { app, root, urlFor } = await transferApp(t);
  // The server never issues one...
  await assert.rejects(
    urlFor({ op: "put", key: "../../escape.txt", ttlSeconds: 60, maxBytes: 10 }),
    UnsafeObjectKeyError,
  );
  // ...and if its secret leaked and someone signed one, the key is still checked.
  for (const key of ["../../escape.txt", "/etc/cron.d/x", "datasets/../../x", ".tmp/x"]) {
    const token = signTransferToken(
      { v: 1, op: "put", key, exp: Math.floor(NOW / 1000) + 60, max: 10 },
      SECRET,
    );
    const res = await app.inject({ method: "PUT", url: `/api/storage/t/${token}`, payload: "x" });
    assert.equal(res.statusCode, 401, key);
  }
  assert.deepEqual(await listFiles(root), []);
  await assert.rejects(fs.access(path.resolve(root, "../../escape.txt")));
});

test("transfer routes: with the s3 driver or no storage they do not exist", async (t) => {
  for (const store of [null, new S3ObjectStore(S3_CONFIG)]) {
    const { app } = await transferApp(t, { store });
    const token = signTransferToken(
      { v: 1, op: "get", key: "datasets/o/d/data.jsonl", exp: Math.floor(NOW / 1000) + 60 },
      SECRET,
    );
    const res = await app.inject({ method: "GET", url: `/api/storage/t/${token}` });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error, "storage_transfer_unavailable");
  }
});

test("transfer routes: downloading an object that is not there is 404", async (t) => {
  const { app, urlFor } = await transferApp(t);
  const res = await app.inject({
    method: "GET",
    url: await urlFor({ op: "get", key: "datasets/o/missing/data.jsonl", ttlSeconds: 60 }),
  });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, "object_not_found");
});
