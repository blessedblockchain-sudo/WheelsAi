/**
 * Object storage smoke test: proves the configured store end to end with the
 * same driver code the API runs.
 *
 *   presigned PUT (signed for a content type and an exact length)
 *   the same link refusing another length and another content type
 *   head, presigned GET, ranged read, a server-side put, deletePrefix, delete
 *   a link that has expired
 *
 * It reads the store from the environment exactly as the API does
 * (apps/api/src/config/training.ts), so the run that passes here is the
 * configuration the server will use: an S3-compatible bucket (AWS S3,
 * Cloudflare R2, MinIO) or, in development, the local directory.
 *
 * Usage, from apps/api:
 *
 *   STORAGE_DRIVER=s3 S3_ENDPOINT=... S3_FORCE_PATH_STYLE=true \
 *   AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... DATASETS_BUCKET=... \
 *   npx tsx scripts/object-store-smoke.ts [--create-bucket]
 *
 * --create-bucket creates the bucket first (a fresh MinIO has none). Leave it
 * off for a real bucket.
 *
 * Everything is written under smoke/<random>/ and removed at the end. No
 * credential is printed: signatures and key ids in the URLs are masked.
 * Exits 1 when any check does not hold.
 */
/* eslint-disable no-console */

import { createHash, randomBytes } from "node:crypto";
import { CreateBucketCommand } from "@aws-sdk/client-s3";

import { loadTrainingConfig } from "../src/config/training.js";
import {
  S3ObjectStore,
  createObjectStore,
  issueTransferUrl,
} from "../src/services/objectStore.js";

const mask = (url: string) =>
  url
    .replace(/(X-Amz-Signature=)[0-9a-f]+/, "$1<signature>")
    .replace(/(X-Amz-Credential=)[^%&]+/, "$1<key id>");

const sha256 = (data: Buffer | Uint8Array) => createHash("sha256").update(data).digest("hex");

let failed = false;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed = true;
}

async function readAll(stream: AsyncIterable<Buffer | Uint8Array | string>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(parts);
}

async function main(): Promise<void> {
  const config = loadTrainingConfig(process.env).storage;
  if (config.driver === null) {
    console.log(`Object storage is not configured: ${config.reason}`);
    process.exit(1);
  }
  const store = createObjectStore(config)!;
  console.log(
    config.driver === "s3"
      ? `driver=s3 endpoint=${config.endpoint ?? "(AWS)"} pathStyle=${config.forcePathStyle} region=${config.region} bucket=${config.bucket}`
      : `driver=local dir=${config.dir}`,
  );

  if (process.argv.includes("--create-bucket") && store instanceof S3ObjectStore) {
    await store.client.send(new CreateBucketCommand({ Bucket: store.bucket }));
    console.log(`created bucket ${store.bucket}`);
  }
  if (!(store instanceof S3ObjectStore)) {
    // The local driver has no presigned URLs; its transfer links are served
    // by the API (routes/storageTransfer.ts) and proven through it.
    const key = `smoke/${randomBytes(6).toString("hex")}/data.jsonl`;
    await store.put(key, "hello");
    check("put + head", (await store.head(key))?.size === 5);
    await store.delete(key);
    check("delete", (await store.head(key)) === null);
    process.exit(failed ? 1 : 0);
  }

  const prefix = `smoke/${randomBytes(6).toString("hex")}/`;
  const key = `${prefix}data.jsonl`;
  const body = Buffer.from(
    Array.from({ length: 2000 }, (_, i) => JSON.stringify({ text: `row ${i}` })).join("\n"),
  );
  const deps = { store, secret: "unused-by-the-s3-driver", publicOrigin: "", now: Date.now };

  // ---- presigned PUT -------------------------------------------------------
  const put = await issueTransferUrl(
    {
      op: "put",
      key,
      ttlSeconds: 300,
      maxBytes: 1024 * 1024,
      contentType: "application/jsonl",
      contentLength: body.length,
    },
    deps,
  );
  console.log(`PUT ${mask(put.url)}`);
  check("no head before the upload", (await store.head(key)) === null);

  const wrongLength = await fetch(put.url, {
    method: "PUT",
    headers: put.headers,
    body: Buffer.concat([body, Buffer.from("x")]),
  });
  check("PUT of another length is refused", wrongLength.status === 403, `HTTP ${wrongLength.status}`);

  const wrongType = await fetch(put.url, {
    method: "PUT",
    headers: { "Content-Type": "text/plain" },
    body,
  });
  check("PUT of another content type is refused", wrongType.status === 403, `HTTP ${wrongType.status}`);
  check("nothing stored by the refused uploads", (await store.head(key)) === null);

  const uploaded = await fetch(put.url, { method: "PUT", headers: put.headers, body });
  check("presigned PUT", uploaded.status === 200, `HTTP ${uploaded.status}, ${body.length} bytes`);

  // ---- head ----------------------------------------------------------------
  const head = await store.head(key);
  check("head", head?.size === body.length, `size=${head?.size} etag=${head?.etag}`);

  // ---- presigned GET -------------------------------------------------------
  const get = await issueTransferUrl({ op: "get", key, ttlSeconds: 300 }, deps);
  console.log(`GET ${mask(get.url)}`);
  const downloaded = await fetch(get.url);
  const bytes = Buffer.from(await downloaded.arrayBuffer());
  check(
    "presigned GET returns the same bytes",
    downloaded.status === 200 && sha256(bytes) === sha256(body),
    `HTTP ${downloaded.status}, sha256 ${sha256(bytes).slice(0, 16)}...`,
  );
  const unsigned = await fetch(get.url.split("?")[0]!);
  check("the same URL without its signature is refused", unsigned.status === 403, `HTTP ${unsigned.status}`);

  // ---- streams, as dataset validation reads them ---------------------------
  const ranged = await readAll(await store.getStream(key, { start: 0, end: 15 }));
  check("ranged read", ranged.equals(body.subarray(0, 16)), `${ranged.length} bytes`);
  const whole = await readAll(await store.getStream(key));
  check("full stream read", whole.equals(body), `${whole.length} bytes`);

  // ---- an expired link -----------------------------------------------------
  const brief = await issueTransferUrl({ op: "get", key, ttlSeconds: 1 }, deps);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const expired = await fetch(brief.url);
  check("a link past its lifetime is refused", expired.status === 403, `HTTP ${expired.status}`);

  // ---- server-side put, deletePrefix, delete -------------------------------
  await store.put(`${prefix}metrics.json`, '{"schema":1}', "application/json");
  check("server-side put", (await store.head(`${prefix}metrics.json`))?.size === 12);
  await store.delete(key);
  check("delete", (await store.head(key)) === null);
  await store.delete(key);
  check("deleting again is not an error", true);
  const removed = await store.deletePrefix(prefix);
  check(
    "deletePrefix",
    removed === 1 && (await store.head(`${prefix}metrics.json`)) === null,
    `${removed} object`,
  );

  console.log(failed ? "FAILED" : "all checks passed");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  // The SDK's error message names the operation and status, not a credential.
  console.error(`smoke test failed: ${err instanceof Error ? `${err.name}: ${err.message}` : err}`);
  process.exit(1);
});
