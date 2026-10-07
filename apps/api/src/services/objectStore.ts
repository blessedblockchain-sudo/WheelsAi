/**
 * Object storage for training data and adapters.
 *
 * One interface, two drivers:
 *
 *   s3     any S3-compatible store. With S3_ENDPOINT and S3_FORCE_PATH_STYLE
 *          the same code reaches AWS S3, Cloudflare R2 and MinIO. Bytes move
 *          over presigned URLs and never pass through this server.
 *   local  files under one directory, for development on one machine (config/
 *          training.ts refuses it outside NODE_ENV=development). It cannot
 *          presign, so its bytes move through routes/storageTransfer.ts under
 *          a signed, expiring token.
 *
 * Callers do not pick between the two: issueTransferUrl() returns a URL a
 * browser or a training container can PUT to or GET from, whichever driver is
 * configured.
 *
 * Nothing is built at import. The driver is created from a parsed config
 * object on first use, so a test can build one with its own settings and no
 * environment, and no client exists in a process that never touches storage.
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import {
  getTrainingConfig,
  type LocalStoreConfig,
  type ObjectStoreConfig,
  type S3StoreConfig,
} from "../config/training.js";

// ============================================
// Interface
// ============================================

export interface ObjectHead {
  size: number;
  etag?: string;
}

/** Inclusive byte range, as in an HTTP Range header. */
export interface ByteRange {
  start: number;
  end?: number;
}

export interface ObjectStore {
  readonly kind: "s3" | "local";
  /** null when the object does not exist. */
  head(key: string): Promise<ObjectHead | null>;
  /** Throws ObjectNotFoundError when the object does not exist. */
  getStream(key: string, range?: ByteRange): Promise<Readable>;
  put(key: string, body: Buffer | string, contentType?: string): Promise<void>;
  /** Deleting an object that is not there is not an error. */
  delete(key: string): Promise<void>;
  /** Every object under `prefix` (which must end with "/"); returns how many. */
  deletePrefix(prefix: string): Promise<number>;
  /** null from a driver that cannot presign (local). */
  presignGet(key: string, ttlSeconds: number): Promise<string | null>;
  presignPut(
    key: string,
    ttlSeconds: number,
    options?: PresignPutOptions,
  ): Promise<string | null>;
}

export interface PresignPutOptions {
  /** Signed into the URL: the upload must send exactly this Content-Type. */
  contentType?: string;
  /** Signed into the URL: the upload must be exactly this many bytes. */
  contentLength?: number;
}

export class ObjectStoreNotConfiguredError extends Error {
  readonly code = "object_storage_not_configured";
  constructor() {
    super("Object storage is not configured");
    this.name = "ObjectStoreNotConfiguredError";
  }
}

export class UnsafeObjectKeyError extends Error {
  readonly code = "unsafe_object_key";
  constructor() {
    // The key is not echoed: it is whatever a caller managed to pass in.
    super("Object key is not allowed");
    this.name = "UnsafeObjectKeyError";
  }
}

export class ObjectNotFoundError extends Error {
  readonly code = "object_not_found";
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
  }
}

export class ObjectTooLargeError extends Error {
  readonly code = "object_too_large";
  constructor(readonly maxBytes: number) {
    super(`Object is larger than ${maxBytes} bytes`);
    this.name = "ObjectTooLargeError";
  }
}

// ============================================
// Keys
// ============================================

/**
 * The provider limit on a presigned URL's lifetime (SigV4: 7 days). A caller
 * decides how long a URL lives; the store only refuses to promise more than
 * the provider gives.
 */
export const MAX_PRESIGN_TTL_SECONDS = 7 * 24 * 60 * 60;

const MAX_KEY_LENGTH = 512;
// A segment starts with a letter, digit or underscore: no "." or "..", no
// hidden names (the local driver keeps its temp files under ".tmp").
const SAFE_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/**
 * Keys are minted by this server (datasets/<orgId>/<datasetId>/data.jsonl),
 * so an allowlist costs nothing and removes every traversal question: no
 * absolute path, no empty, "." or ".." segment, no backslash, no odd bytes.
 */
export function isSafeObjectKey(key: unknown): key is string {
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY_LENGTH) return false;
  return key.split("/").every((segment) => SAFE_SEGMENT.test(segment));
}

export function assertSafeObjectKey(key: unknown): asserts key is string {
  if (!isSafeObjectKey(key)) throw new UnsafeObjectKeyError();
}

function assertSafePrefix(prefix: string): string {
  // The trailing slash is required so "datasets/org1" can never also match
  // "datasets/org10/...".
  if (!prefix.endsWith("/")) throw new UnsafeObjectKeyError();
  assertSafeObjectKey(prefix.slice(0, -1));
  return prefix;
}

function clampTtl(ttlSeconds: number): number {
  if (!Number.isFinite(ttlSeconds) || ttlSeconds < 1) {
    throw new RangeError("ttlSeconds must be a positive number");
  }
  return Math.min(Math.floor(ttlSeconds), MAX_PRESIGN_TTL_SECONDS);
}

// ============================================
// S3-compatible driver
// ============================================

/** Pure: what the S3 client is built with. Exported for the unit test. */
export function buildS3ClientConfig(config: S3StoreConfig): S3ClientConfig {
  return {
    region: config.region,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    // The SDK otherwise adds a CRC32 checksum parameter to every presigned
    // PUT, which a browser upload does not send and R2 rejects.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  };
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return (
    e?.name === "NotFound" || e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404
  );
}

export class S3ObjectStore implements ObjectStore {
  readonly kind = "s3" as const;
  readonly client: S3Client;
  readonly bucket: string;

  constructor(config: S3StoreConfig, client?: S3Client) {
    this.bucket = config.bucket;
    this.client = client ?? new S3Client(buildS3ClientConfig(config));
  }

  async head(key: string): Promise<ObjectHead | null> {
    assertSafeObjectKey(key);
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return { size: result.ContentLength ?? 0, etag: result.ETag };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async getStream(key: string, range?: ByteRange): Promise<Readable> {
    assertSafeObjectKey(key);
    try {
      const result = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          ...(range ? { Range: `bytes=${range.start}-${range.end ?? ""}` } : {}),
        }),
      );
      if (!result.Body) throw new ObjectNotFoundError();
      // In Node the SDK hands back the HTTP response stream.
      return result.Body as Readable;
    } catch (err) {
      if (isNotFound(err)) throw new ObjectNotFoundError();
      throw err;
    }
  }

  async put(key: string, body: Buffer | string, contentType?: string): Promise<void> {
    assertSafeObjectKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ...(contentType ? { ContentType: contentType } : {}),
      }),
    );
  }

  async delete(key: string): Promise<void> {
    assertSafeObjectKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async deletePrefix(prefix: string): Promise<number> {
    assertSafePrefix(prefix);
    let deleted = 0;
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      const keys = (page.Contents ?? [])
        .map((object) => object.Key)
        .filter((key): key is string => typeof key === "string");
      if (keys.length > 0) {
        // One page is at most 1000 keys, which is also DeleteObjects' limit.
        const result = await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
          }),
        );
        deleted += keys.length - (result.Errors?.length ?? 0);
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return deleted;
  }

  async presignGet(key: string, ttlSeconds: number): Promise<string> {
    assertSafeObjectKey(key);
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: clampTtl(ttlSeconds),
    });
  }

  async presignPut(
    key: string,
    ttlSeconds: number,
    options: PresignPutOptions = {},
  ): Promise<string> {
    assertSafeObjectKey(key);
    // The presigner leaves Content-Type out of the signature unless told
    // otherwise. Signing both makes the store itself refuse an upload of
    // another type or another size than the one that was authorised.
    const signableHeaders = new Set<string>();
    if (options.contentType) signableHeaders.add("content-type");
    if (options.contentLength !== undefined) signableHeaders.add("content-length");
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(options.contentType ? { ContentType: options.contentType } : {}),
        ...(options.contentLength !== undefined ? { ContentLength: options.contentLength } : {}),
      }),
      {
        expiresIn: clampTtl(ttlSeconds),
        ...(signableHeaders.size > 0 ? { signableHeaders } : {}),
      },
    );
  }
}

// ============================================
// Local driver (development only)
// ============================================

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

export class LocalObjectStore implements ObjectStore {
  readonly kind = "local" as const;
  readonly root: string;

  constructor(config: LocalStoreConfig) {
    this.root = path.resolve(config.dir);
  }

  /**
   * Key to path. The allowlist already excludes every traversal; the prefix
   * check after resolving is the second lock on the same door.
   */
  private resolve(key: string): string {
    assertSafeObjectKey(key);
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new UnsafeObjectKeyError();
    return full;
  }

  private async tempPath(): Promise<string> {
    const dir = path.join(this.root, ".tmp");
    await fs.mkdir(dir, { recursive: true });
    return path.join(dir, randomUUID());
  }

  async head(key: string): Promise<ObjectHead | null> {
    try {
      const stat = await fs.stat(this.resolve(key));
      if (!stat.isFile()) return null;
      // Not a content hash: it changes when the file is replaced (a put is a
      // rename, so the modification time moves), which is all a caller
      // comparing two heads needs.
      const etag = `"${stat.size.toString(16)}-${Math.round(stat.mtimeMs * 1000).toString(16)}"`;
      return { size: stat.size, etag };
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  async getStream(key: string, range?: ByteRange): Promise<Readable> {
    const full = this.resolve(key);
    if (!(await this.head(key))) throw new ObjectNotFoundError();
    return createReadStream(full, range ? { start: range.start, end: range.end } : {});
  }

  async put(key: string, body: Buffer | string): Promise<void> {
    const full = this.resolve(key);
    const temp = await this.tempPath();
    try {
      await fs.writeFile(temp, body);
      await fs.mkdir(path.dirname(full), { recursive: true });
      // Written whole, then renamed: a reader never sees half an object.
      await fs.rename(temp, full);
    } catch (err) {
      await fs.rm(temp, { force: true });
      throw err;
    }
  }

  /**
   * Store a body of unknown length, refusing it once it passes `maxBytes`.
   * The count is taken while streaming, so an oversize upload is cut off at
   * the limit and never lands under its key.
   */
  async putStream(key: string, source: Readable, maxBytes: number): Promise<{ size: number }> {
    const full = this.resolve(key);
    const temp = await this.tempPath();
    let size = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > maxBytes) callback(new ObjectTooLargeError(maxBytes));
        else callback(null, chunk);
      },
    });
    try {
      await pipeline(source, limiter, createWriteStream(temp));
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.rename(temp, full);
    } catch (err) {
      await fs.rm(temp, { force: true });
      throw err;
    }
    return { size };
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.resolve(key), { force: true });
  }

  async deletePrefix(prefix: string): Promise<number> {
    assertSafePrefix(prefix);
    const dir = this.resolve(prefix.slice(0, -1));
    let entries: string[];
    try {
      entries = await fs.readdir(dir, { recursive: true });
    } catch (err) {
      if (isMissing(err)) return 0;
      throw err;
    }
    let files = 0;
    for (const entry of entries) {
      if ((await fs.stat(path.join(dir, entry))).isFile()) files += 1;
    }
    await fs.rm(dir, { recursive: true, force: true });
    return files;
  }

  async presignGet(): Promise<null> {
    return null;
  }

  async presignPut(): Promise<null> {
    return null;
  }
}

// ============================================
// Factory
// ============================================

/** A driver for a parsed config, or null when storage is not configured. */
export function createObjectStore(config: ObjectStoreConfig): ObjectStore | null {
  if (config.driver === "s3") return new S3ObjectStore(config);
  if (config.driver === "local") return new LocalObjectStore(config);
  return null;
}

let cached: { config: ObjectStoreConfig; store: ObjectStore | null } | null = null;

/**
 * The process-wide store, built on first use from config/training.ts. Keyed
 * on the config object, so a re-parsed config (tests) gets a fresh driver.
 */
export function getObjectStore(
  config: ObjectStoreConfig = getTrainingConfig().storage,
): ObjectStore | null {
  if (cached?.config !== config) cached = { config, store: createObjectStore(config) };
  return cached.store;
}

// ============================================
// Transfer tokens (local driver)
// ============================================

export type TransferOp = "get" | "put";

export interface TransferTokenPayload {
  v: 1;
  op: TransferOp;
  key: string;
  /** Expiry, unix seconds. */
  exp: number;
  /** Largest body a PUT may carry. */
  max?: number;
}

export type TransferTokenVerdict =
  | { ok: true; payload: TransferTokenPayload }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" | "wrong_operation" };

const TRANSFER_DOMAIN = "storage-transfer-v1";

function transferMac(encodedPayload: string, secret: string): Buffer {
  // The domain string keeps this MAC apart from every other use of the same
  // server secret (sessions, webhook tokens).
  return createHmac("sha256", secret).update(`${TRANSFER_DOMAIN}.${encodedPayload}`).digest();
}

export function signTransferToken(payload: TransferTokenPayload, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${transferMac(encoded, secret).toString("base64url")}`;
}

/**
 * The signature is checked first and in constant time; nothing inside the
 * token is believed (or even parsed) before it holds.
 */
export function verifyTransferToken(
  token: unknown,
  secret: string,
  expect: { op: TransferOp; nowMs: number },
): TransferTokenVerdict {
  if (typeof token !== "string" || token.length > 4096) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  const [encoded, mac] = parts;
  if (parts.length !== 2 || !encoded || !mac) return { ok: false, reason: "malformed" };

  const presented = Buffer.from(mac, "base64url");
  const expected = transferMac(encoded, secret);
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return { ok: false, reason: "bad_signature" };
  }

  let payload: TransferTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    payload?.v !== 1 ||
    (payload.op !== "get" && payload.op !== "put") ||
    typeof payload.exp !== "number" ||
    !isSafeObjectKey(payload.key) ||
    (payload.max !== undefined && !(Number.isInteger(payload.max) && payload.max >= 0))
  ) {
    return { ok: false, reason: "malformed" };
  }
  if (payload.exp * 1000 <= expect.nowMs) return { ok: false, reason: "expired" };
  if (payload.op !== expect.op) return { ok: false, reason: "wrong_operation" };
  return { ok: true, payload };
}

// ============================================
// Transfer URLs
// ============================================

/** Where routes/storageTransfer.ts is mounted (index.ts). */
export const STORAGE_TRANSFER_PREFIX = "/api/storage";

export interface IssueTransferUrlArgs {
  op: TransferOp;
  key: string;
  /** Decided by the caller; capped at MAX_PRESIGN_TTL_SECONDS. */
  ttlSeconds: number;
  /** PUT: the largest body accepted. Required for a PUT on the local driver. */
  maxBytes?: number;
  /** PUT: the Content-Type the upload must send. */
  contentType?: string;
  /**
   * PUT: the exact size of the upload, when the caller knows it. This is the
   * only size limit a presigned S3 PUT can carry, so pass it whenever known.
   */
  contentLength?: number;
}

export interface TransferUrl {
  url: string;
  method: "GET" | "PUT";
  /** Headers the request must send for the URL to be honoured. */
  headers: Record<string, string>;
  expiresAt: Date;
  /**
   * The size limit the URL itself enforces, or null when it enforces none (a
   * presigned S3 PUT issued without contentLength): the caller must then
   * check the stored object's size afterwards.
   */
  maxBytes: number | null;
}

export interface TransferDeps {
  store: ObjectStore | null;
  /** Signs local-driver tokens. */
  secret: string;
  /** Absolute origin of this API, for local-driver URLs. No trailing slash. */
  publicOrigin: string;
  now: () => number;
}

/** Production wiring, read lazily so tests can set the environment first. */
export function buildTransferDeps(): TransferDeps {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is required to sign storage transfer tokens");
  // The local driver is development only, so localhost is an honest default
  // for it; the s3 driver never uses this value.
  const origin =
    process.env.PUBLIC_API_URL?.trim() || `http://localhost:${process.env.API_PORT ?? "4000"}`;
  return {
    store: getObjectStore(),
    secret,
    publicOrigin: origin.replace(/\/+$/, ""),
    now: Date.now,
  };
}

/**
 * A URL a browser or a container can use to move one object, with no other
 * credential. Presigned by the s3 driver; a signed token on this API for the
 * local driver. Throws ObjectStoreNotConfiguredError when there is no store.
 */
export async function issueTransferUrl(
  args: IssueTransferUrlArgs,
  deps: TransferDeps = buildTransferDeps(),
): Promise<TransferUrl> {
  const { store } = deps;
  if (!store) throw new ObjectStoreNotConfiguredError();
  assertSafeObjectKey(args.key);

  const ttl = clampTtl(args.ttlSeconds);
  const nowMs = deps.now();
  const expiresAt = new Date(nowMs + ttl * 1000);
  const method = args.op === "put" ? "PUT" : "GET";
  const headers: Record<string, string> =
    args.op === "put" && args.contentType ? { "Content-Type": args.contentType } : {};

  if (store.kind === "local") {
    const max = args.op === "put" ? (args.contentLength ?? args.maxBytes) : undefined;
    if (args.op === "put" && max === undefined) {
      throw new RangeError("maxBytes is required for a local upload URL");
    }
    const token = signTransferToken(
      {
        v: 1,
        op: args.op,
        key: args.key,
        exp: Math.floor(expiresAt.getTime() / 1000),
        ...(max !== undefined ? { max } : {}),
      },
      deps.secret,
    );
    return {
      url: `${deps.publicOrigin}${STORAGE_TRANSFER_PREFIX}/t/${token}`,
      method,
      headers,
      expiresAt,
      maxBytes: max ?? null,
    };
  }

  const url =
    args.op === "put"
      ? await store.presignPut(args.key, ttl, {
          contentType: args.contentType,
          contentLength: args.contentLength,
        })
      : await store.presignGet(args.key, ttl);
  if (!url) throw new ObjectStoreNotConfiguredError();
  return {
    url,
    method,
    headers,
    expiresAt,
    maxBytes: args.op === "put" ? (args.contentLength ?? null) : null,
  };
}
