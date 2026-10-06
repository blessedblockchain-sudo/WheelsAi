/**
 * Where the server-side half of a function-calling turn waits for the caller.
 *
 * When a model turn mixes the agent's own tools with the caller's, the agent's
 * run here and the caller's are handed back. The caller then replays only what
 * it was shown (the assistant turn with ITS calls, plus its results). The
 * server rounds - which tools ran and what they returned - are kept here,
 * keyed by the handed-back call ids, and spliced back in when the caller
 * returns.
 *
 * Fail-soft by contract: a miss, an eviction, an oversized entry or a Redis
 * error all read as "nothing stored". The conversation the caller replays is
 * still valid on its own; the model may simply call a server tool again.
 * Nothing here can fail a request.
 */

import type { ModelMessage } from "./toolLoop.js";

export interface ContinuationKey {
  orgId: string;
  agentId: string;
  /** A handed-back tool call id (`call_<32 hex>`, assigned by the tool loop). */
  callId: string;
}

export interface ToolContinuationStore {
  /** The stored transcript, or null. Never throws. */
  load(key: ContinuationKey): Promise<ModelMessage[] | null>;
  /** Stores the transcript under every given call id. Never throws. */
  save(
    scope: { orgId: string; agentId: string },
    callIds: string[],
    transcript: ModelMessage[],
  ): Promise<void>;
}

export const DEFAULT_CONTINUATION_TTL_SECONDS = 3_600;
export const MAX_CONTINUATION_BYTES = 256 * 1024;

/** Scoped by org AND agent: a call id from one tenant can never read another's. */
export function continuationRedisKey(key: ContinuationKey): string {
  return `agentchat:cont:${key.orgId}:${key.agentId}:${key.callId}`;
}

const VALID_ROLES = new Set(["system", "user", "assistant", "tool"]);

/** null unless `raw` is a JSON array of messages in the stored shape. */
export function parseStoredTranscript(raw: string | null | undefined): ModelMessage[] | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) return null;
    const message = entry as Record<string, unknown>;
    if (typeof message.role !== "string" || !VALID_ROLES.has(message.role)) return null;
    if (message.content !== null && typeof message.content !== "string") return null;
  }
  return parsed as ModelMessage[];
}

/** The serialized transcript, or null when it is too large to keep. */
export function serializeTranscript(
  transcript: ModelMessage[],
  maxBytes = MAX_CONTINUATION_BYTES,
): string | null {
  if (transcript.length === 0) return null;
  const json = JSON.stringify(transcript);
  return Buffer.byteLength(json, "utf8") > maxBytes ? null : json;
}

/** The slice of a Redis client this store uses. */
export interface ContinuationRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
}

export function createRedisToolContinuationStore(options: {
  redis: ContinuationRedis;
  ttlSeconds?: number;
  maxBytes?: number;
  onError?: (err: unknown, op: "load" | "save") => void;
}): ToolContinuationStore {
  const ttl = options.ttlSeconds ?? DEFAULT_CONTINUATION_TTL_SECONDS;
  return {
    async load(key) {
      try {
        return parseStoredTranscript(await options.redis.get(continuationRedisKey(key)));
      } catch (err) {
        options.onError?.(err, "load");
        return null;
      }
    },
    async save(scope, callIds, transcript) {
      const json = serializeTranscript(transcript, options.maxBytes);
      if (json === null) return;
      try {
        await Promise.all(
          callIds.map((callId) =>
            options.redis.set(continuationRedisKey({ ...scope, callId }), json, "EX", ttl),
          ),
        );
      } catch (err) {
        options.onError?.(err, "save");
      }
    },
  };
}

/** For tests and single-process use: same contract, a Map, real expiry. */
export function createMemoryToolContinuationStore(
  options: { ttlSeconds?: number; maxBytes?: number; now?: () => number } = {},
): ToolContinuationStore {
  const ttlMs = (options.ttlSeconds ?? DEFAULT_CONTINUATION_TTL_SECONDS) * 1000;
  const now = options.now ?? Date.now;
  const entries = new Map<string, { json: string; expiresAt: number }>();
  return {
    async load(key) {
      const redisKey = continuationRedisKey(key);
      const entry = entries.get(redisKey);
      if (!entry) return null;
      if (entry.expiresAt <= now()) {
        entries.delete(redisKey);
        return null;
      }
      return parseStoredTranscript(entry.json);
    },
    async save(scope, callIds, transcript) {
      const json = serializeTranscript(transcript, options.maxBytes);
      if (json === null) return;
      for (const callId of callIds) {
        entries.set(continuationRedisKey({ ...scope, callId }), { json, expiresAt: now() + ttlMs });
      }
    },
  };
}
