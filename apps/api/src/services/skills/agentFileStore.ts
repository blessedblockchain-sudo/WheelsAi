/**
 * Per-agent file storage for the `file_read` / `file_write` skills.
 *
 * Backed by the same S3-compatible object store the datasets use (services/
 * dataset.ts: real S3 or R2), under a key prefix that is DERIVED FROM THE
 * CALLER'S TRUSTED CONTEXT - `agent-files/<orgId>/<agentId>/` - and never from
 * anything the model says. The model only supplies a relative path, which is
 * sanitised here with an allowlist (no traversal, no absolute paths, no odd
 * characters) before it is appended to the prefix.
 *
 * The store is an interface so the skills are unit-testable without a bucket
 * and so a different backend can replace S3 without touching them.
 */

import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";

export interface StoredFile {
  /** Path relative to the agent's prefix. */
  path: string;
  size: number;
}

/** A stored object exceeds the read limit; the message is safe to show. */
export class StoredFileTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`stored file is larger than ${maxBytes} bytes`);
    this.name = "StoredFileTooLargeError";
  }
}

/**
 * There is deliberately no `delete`: the write path once "rolled back" its
 * own key and removed a concurrent writer's file with it. Writers take turns
 * (agentFileLock.ts) instead, and nothing a skill does removes an object.
 */
export interface AgentFileStore {
  /** `signal` abandons the upload (the writer's lock lease is running out). */
  put(key: string, body: string, signal?: AbortSignal): Promise<void>;
  /** null when the object does not exist. Throws when it exceeds maxBytes. */
  get(key: string, maxBytes: number): Promise<string | null>;
  /** Every object under the prefix, keys relative to it. */
  list(prefix: string): Promise<StoredFile[]>;
}

// ============================================
// Keys and path sanitisation
// ============================================

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

export const MAX_FILE_PATH_LENGTH = 200;
export const MAX_FILE_PATH_SEGMENTS = 8;

export type PathVerdict =
  | { ok: true; path: string }
  | { ok: false; reason: string };

/**
 * Validates a model-supplied relative path. Allowlist, not blocklist: each
 * segment may only contain letters, digits, dot, dash and underscore, and
 * `.` / `..` / empty segments are refused outright - so `../x`, `/etc/passwd`,
 * `a//b`, `a\b` and NUL-byte tricks all fail without a regex that has to
 * anticipate them.
 */
export function sanitizeAgentFilePath(input: unknown): PathVerdict {
  if (typeof input !== "string") return { ok: false, reason: "path must be a string" };
  const path = input.trim();
  if (path.length === 0) return { ok: false, reason: "path is empty" };
  if (path.length > MAX_FILE_PATH_LENGTH) {
    return { ok: false, reason: `path is longer than ${MAX_FILE_PATH_LENGTH} characters` };
  }
  if (path.startsWith("/")) {
    return { ok: false, reason: "path must be relative (no leading /)" };
  }
  if (path.endsWith("/")) {
    return { ok: false, reason: "path must name a file, not a directory" };
  }
  const segments = path.split("/");
  if (segments.length > MAX_FILE_PATH_SEGMENTS) {
    return { ok: false, reason: `path has more than ${MAX_FILE_PATH_SEGMENTS} segments` };
  }
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      return { ok: false, reason: 'path may not contain empty, "." or ".." segments' };
    }
    if (!SAFE_SEGMENT.test(segment)) {
      return {
        ok: false,
        reason: "path segments may only contain letters, digits, '.', '-' and '_'",
      };
    }
  }
  return { ok: true, path };
}

/** `agent-files/<orgId>/<agentId>/` - throws on ids that could escape it. */
export function agentFilePrefix(orgId: string, agentId: string): string {
  if (!SAFE_ID.test(orgId) || !SAFE_ID.test(agentId)) {
    throw new Error("refusing to build a file prefix from an unexpected id");
  }
  return `agent-files/${orgId}/${agentId}/`;
}

// ============================================
// S3 implementation
// ============================================

export class S3AgentFileStore implements AgentFileStore {
  constructor(
    private readonly client: Pick<S3Client, "send">,
    private readonly bucket: string,
  ) {}

  async put(key: string, body: string, signal?: AbortSignal): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: "text/plain; charset=utf-8",
      }),
      { abortSignal: signal },
    );
  }

  async get(key: string, maxBytes: number): Promise<string | null> {
    let res;
    try {
      res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === "NoSuchKey" || name === "NotFound") return null;
      throw err;
    }
    if ((res.ContentLength ?? 0) > maxBytes) {
      throw new StoredFileTooLargeError(maxBytes);
    }
    return (await res.Body?.transformToString("utf-8")) ?? "";
  }

  async list(prefix: string): Promise<StoredFile[]> {
    const files: StoredFile[] = [];
    let token: string | undefined;
    // Bounded: 1000 keys per page, and an agent holds tens of files, so a
    // runaway listing means something is wrong rather than something big.
    for (let page = 0; page < 20; page++) {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      for (const obj of res.Contents ?? []) {
        if (!obj.Key || !obj.Key.startsWith(prefix)) continue;
        files.push({ path: obj.Key.slice(prefix.length), size: obj.Size ?? 0 });
      }
      if (!res.IsTruncated || !res.NextContinuationToken) break;
      token = res.NextContinuationToken;
    }
    return files;
  }
}

// ============================================
// In-memory implementation (tests, local experiments)
// ============================================

export class InMemoryAgentFileStore implements AgentFileStore {
  readonly objects = new Map<string, string>();

  async put(key: string, body: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.objects.set(key, body);
  }

  async get(key: string, maxBytes: number): Promise<string | null> {
    const body = this.objects.get(key);
    if (body === undefined) return null;
    if (Buffer.byteLength(body, "utf8") > maxBytes) {
      throw new StoredFileTooLargeError(maxBytes);
    }
    return body;
  }

  async list(prefix: string): Promise<StoredFile[]> {
    return [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, body]) => ({
        path: key.slice(prefix.length),
        size: Buffer.byteLength(body, "utf8"),
      }));
  }
}
