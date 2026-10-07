/**
 * Measured latency: the one record every stated latency is computed from
 * (model `RequestLatencySample`, one row per chat request that reached a
 * model).
 *
 * Why a row per request rather than a histogram per hour: a public figure has
 * to be the time of a request that was actually served, exact and
 * re-derivable from what is stored. Bucketed counts can only answer "at most
 * this bucket's ceiling", and two stores would answer the same question two
 * ways. So percentiles everywhere are percentile_disc over these rows
 * (services/latencyQueries.ts); the hourly usage rollups keep counts and
 * tokens.
 *
 * Three rules a sample keeps:
 *   - a value that was not measured is absent, never zero: a NaN, negative or
 *     infinite total yields no sample at all, and a bad part (upstream, first
 *     token, tokens) is stored as null
 *   - the parts of a request never exceed the request
 *   - recording can neither slow nor fail the request it describes: the sink
 *     takes a sample synchronously, never throws, and writes in the
 *     background; under pressure it drops samples (and counts them) rather
 *     than hold memory or a request
 *
 * Pure: the sink's one effect, the batch insert, is a dependency
 * (services/buildLatencySampleDeps.ts binds it).
 */

import { isMockNosanaId } from "./nosanaIds.js";

// ============================================
// The sample
// ============================================

/**
 * Which way a request came in. A model deployment is reached through the
 * OpenAI-compatible API ("v1"), the dashboard ("deployment_chat") or a
 * workflow / job step ("deployment_step"); an agent chat is named by its
 * source.
 */
export const DEPLOYMENT_SURFACES = ["v1", "deployment_chat", "deployment_step"] as const;
export type DeploymentSurface = (typeof DEPLOYMENT_SURFACES)[number];

const AGENT_SURFACE_PREFIX = "agent_";
const AGENT_SOURCE_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

/** The surface of an agent chat, or null for a source that is not a name. */
export function agentSurface(source: string): string | null {
  return AGENT_SOURCE_PATTERN.test(source) ? `${AGENT_SURFACE_PREFIX}${source}` : null;
}

/**
 * The surfaces behind the public figure: a person or a program waiting for a
 * chat answer. Scheduled runs, workflow and job steps, hired jobs and test
 * runs are measured too, and are left out because nobody is waiting on them
 * the way the headline implies.
 */
export const PUBLIC_LATENCY_SURFACES: readonly string[] = [
  "v1",
  "deployment_chat",
  "agent_api",
  "agent_playground",
  "agent_widget",
  "agent_trial",
];

export const LATENCY_OUTCOMES = ["ok", "error", "timeout", "cancelled"] as const;
export type LatencyOutcome = (typeof LATENCY_OUTCOMES)[number];

/** A request slower than this was not a chat: the value is capped, not kept. */
export const MAX_SAMPLE_MS = 24 * 60 * 60 * 1000;

const MAX_MODEL_CHARS = 200;
const MAX_LABEL_CHARS = 64;
const INT4_MAX = 2_147_483_647;

/**
 * How many of one organization's most recent answers count toward the public
 * figure: an equal share of the publication minimum. A figure that has just
 * reached the minimum therefore rests on no organization for more than about
 * 1/minOrgs of its samples, and sending more requests adds nothing once the
 * share is full - so one customer's traffic, however much of it there is, is
 * never the platform's number.
 */
export function publicLatencyOrgCap(minSamples: number, minOrgs: number): number {
  const samples = Number.isFinite(minSamples) && minSamples >= 1 ? Math.floor(minSamples) : 1;
  const orgs = Number.isFinite(minOrgs) && minOrgs >= 1 ? Math.floor(minOrgs) : 1;
  return Math.max(1, Math.ceil(samples / orgs));
}

export interface LatencySampleInput {
  orgId: string;
  surface: string;
  agentId?: string | null;
  deploymentId?: string | null;
  model?: string | null;
  provider: string;
  streamed: boolean;
  outcome: LatencyOutcome;
  statusCode?: number | null;
  /** From the API receiving the request to the end of the answer. */
  totalMs: number;
  upstreamMs?: number | null;
  firstTokenMs?: number | null;
  outputTokens?: number | null;
}

/** A row of `request_latency_samples`, minus the id the database layer adds. */
export interface LatencySample {
  orgId: string;
  surface: string;
  agentId: string | null;
  deploymentId: string | null;
  model: string | null;
  provider: string;
  streamed: boolean;
  outcome: LatencyOutcome;
  statusCode: number | null;
  totalMs: number;
  upstreamMs: number | null;
  firstTokenMs: number | null;
  outputTokens: number | null;
  createdAt: Date;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Control characters, and half of a surrogate pair. Postgres text cannot hold
// U+0000 at all, and samples are written many to a statement: one such
// character in a caller-chosen model name would fail every other request's
// row in the same insert.
const UNSTORABLE_CHARS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** Text a row can hold, or "" when nothing storable is left. */
function storableText(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return "";
  // Cut by code point, so the limit never leaves half a pair behind.
  return Array.from(value.replace(UNSTORABLE_CHARS, "").trim()).slice(0, maxChars).join("");
}

const uuidOrNull = (value: unknown): string | null =>
  typeof value === "string" && UUID_PATTERN.test(value) ? value : null;

/** A whole number of ms, or null when the value is not a measurement. */
function measuredMs(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

/**
 * The row one request becomes, or null when its total time is not a
 * measurement - the request then leaves no sample rather than a zero that
 * would pull every percentile down.
 *
 * Every field is made storable here, because the row shares its insert with
 * other organizations' rows: text loses what Postgres would refuse, an id
 * that is not a UUID is dropped (the sample with it, when it is the
 * organization's), and an ending outside the list yields no sample.
 */
export function buildLatencySample(input: LatencySampleInput, now: Date): LatencySample | null {
  const measured = measuredMs(input.totalMs);
  if (measured === null) return null;
  const orgId = uuidOrNull(input.orgId);
  const surface = storableText(input.surface, MAX_LABEL_CHARS);
  if (orgId === null || surface.length === 0) return null;
  if (!(LATENCY_OUTCOMES as readonly string[]).includes(input.outcome)) return null;
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return null;
  const totalMs = Math.min(measured, MAX_SAMPLE_MS);

  const part = (value: number | null | undefined): number | null => {
    const ms = measuredMs(value);
    return ms === null ? null : Math.min(ms, totalMs);
  };
  const model = storableText(input.model, MAX_MODEL_CHARS);
  const outputTokens = measuredMs(input.outputTokens);
  const statusCode =
    typeof input.statusCode === "number" &&
    Number.isInteger(input.statusCode) &&
    input.statusCode >= 100 &&
    input.statusCode <= 599
      ? input.statusCode
      : null;

  return {
    orgId,
    surface,
    agentId: uuidOrNull(input.agentId),
    deploymentId: uuidOrNull(input.deploymentId),
    model: model.length > 0 ? model : null,
    provider: storableText(input.provider, MAX_LABEL_CHARS) || "unknown",
    streamed: input.streamed === true,
    outcome: input.outcome,
    statusCode,
    totalMs,
    upstreamMs: part(input.upstreamMs),
    firstTokenMs: part(input.firstTokenMs),
    outputTokens: outputTokens !== null && outputTokens <= INT4_MAX ? outputTokens : null,
    createdAt: now,
  };
}

// ============================================
// Classification
// ============================================

/**
 * How a call to a node or provider ended. The caller hanging up is neither
 * an answer nor a failure of ours; a deadline that fired is a timeout even
 * though it surfaces as a failed fetch; "ok" needs both an OK status AND an
 * answer in the body, because an inference server can say 200 with an error
 * inside.
 */
export function classifyUpstreamOutcome(result: {
  clientGone?: boolean;
  timedOut?: boolean;
  httpOk?: boolean;
  hasAnswer?: boolean;
}): LatencyOutcome {
  if (result.clientGone) return "cancelled";
  if (result.timedOut) return "timeout";
  return result.httpOk === true && result.hasAnswer === true ? "ok" : "error";
}

const KNOWN_PROVIDERS = new Set(["groq", "google", "together", "openai", "anthropic", "openclaw"]);
// How the model catalog spells a provider, where it differs from the name
// used here.
const PROVIDER_ALIASES: Record<string, string> = { gemini: "google" };

/**
 * The provider an agent's model id names: `free/groq/llama-3.3-70b` is groq,
 * `openai/gpt-4` is openai, `wheelsai/<model>` is the organization's own
 * deployment on Nosana. Anything else is "unknown", never a guess.
 */
export function providerOfModelId(modelId: string | null | undefined): string {
  if (!modelId) return "unknown";
  const parts = modelId.toLowerCase().split("/");
  if (parts.length < 2) return "unknown";
  if (parts[0] === "wheelsai") return "nosana";
  const named = parts[0] === "free" ? parts[1] : parts[0];
  if (!named) return "unknown";
  const provider = PROVIDER_ALIASES[named] ?? named;
  return KNOWN_PROVIDERS.has(provider) ? provider : "unknown";
}

/**
 * Whether a model deployment runs on a real Nosana GPU or on the dev-only
 * mock. The mock answers without doing any inference, so its timings are kept
 * apart and never count toward a published figure.
 */
export function providerForDeployment(deployment: {
  nosanaJobIds?: readonly string[] | null;
}): string {
  const id = Array.isArray(deployment.nosanaJobIds) ? deployment.nosanaJobIds[0] : undefined;
  if (typeof id !== "string" || id.length === 0) return "unknown";
  return isMockNosanaId(id) ? "nosana_mock" : "nosana";
}

// ============================================
// The sink
// ============================================

export type RecordLatency = (sample: LatencySample | null) => void;

export interface LatencySinkStats {
  /** Samples waiting for the next write. */
  buffered: number;
  written: number;
  /** Dropped because the buffer was full. */
  droppedOverflow: number;
  /** Dropped because they could not be written. */
  droppedFailed: number;
}

export interface LatencySampleSink {
  /** Synchronous; never throws. A null (unmeasured) sample is ignored. */
  push: RecordLatency;
  /** Writes what is buffered now. Never rejects. */
  flush(): Promise<void>;
  /** Flushes and stops the timer; for shutdown. */
  close(): Promise<void>;
  stats(): LatencySinkStats;
}

export interface LatencySinkTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface LatencySinkOptions {
  insertMany(samples: LatencySample[]): Promise<unknown>;
  flushIntervalMs?: number;
  /** Samples held between writes; beyond it new ones are dropped. */
  maxBuffer?: number;
  /** Rows per insert statement. */
  maxBatch?: number;
  /**
   * After a statement fails, how many more may be spent finding the rows that
   * can still be written. Bounded so no batch costs one statement per row.
   */
  maxSalvageInserts?: number;
  timers?: LatencySinkTimers;
  logger?: { warn(obj: unknown, msg: string): void };
}

// unref'd: a pending write must never keep a process (or a test run) alive.
const defaultTimers: LatencySinkTimers = {
  set: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Buffers samples and writes them in the background, one insert per
 * interval. Up to one interval of samples is lost if the process dies
 * without close(); that is the price of keeping the write off the request.
 *
 * Rows of every organization share a statement, so a statement that fails is
 * halved and retried until the row that cannot be stored is alone: only that
 * row is dropped, never its neighbours. If nothing at all can be written the
 * database is down, and the search stops after about one path down the
 * halves.
 */
export function createLatencySampleSink(options: LatencySinkOptions): LatencySampleSink {
  const flushIntervalMs = options.flushIntervalMs ?? 1_000;
  const maxBuffer = options.maxBuffer ?? 5_000;
  const maxBatch = options.maxBatch ?? 1_000;
  const timers = options.timers ?? defaultTimers;

  const buffer: LatencySample[] = [];
  let timer: unknown = null;
  let writing: Promise<void> = Promise.resolve();
  let written = 0;
  let droppedOverflow = 0;
  let droppedFailed = 0;

  const maxSalvageInserts = options.maxSalvageInserts ?? 200;

  const warn = (obj: Record<string, unknown>, msg: string): void => {
    try {
      options.logger?.warn(obj, msg);
    } catch {
      // A logger that throws must not surface either.
    }
  };

  const writeBatch = async (batch: LatencySample[]): Promise<void> => {
    let salvageLeft = maxSalvageInserts;
    // One bad row is found within log2(batch) failures and the statement
    // after it succeeds. Failing for longer than that with nothing written
    // means the database, not a row.
    const downAfter = Math.ceil(Math.log2(Math.max(batch.length, 2))) + 4;
    let attempts = 0;
    let wroteAny = false;
    let dropped = 0;
    let lastError: unknown = null;
    // Depth-first over halves; a part that writes is done, a single row that
    // does not is the one being looked for.
    const pending: LatencySample[][] = [batch];
    let first = true;
    while (pending.length > 0) {
      const part = pending.pop()!;
      if (!first) {
        // Out of statements: what is left is dropped, not queued - a database
        // that is down must not turn the sink into an ever-growing queue.
        if (salvageLeft <= 0 || (!wroteAny && attempts >= downAfter)) {
          dropped += part.length;
          continue;
        }
        salvageLeft -= 1;
      }
      first = false;
      attempts += 1;
      try {
        await options.insertMany(part);
        written += part.length;
        wroteAny = true;
      } catch (err) {
        lastError = err;
        if (part.length === 1) {
          dropped += 1;
        } else {
          const half = Math.ceil(part.length / 2);
          pending.push(part.slice(half), part.slice(0, half));
        }
      }
    }
    if (dropped > 0) {
      droppedFailed += dropped;
      warn(
        { err: lastError, dropped, batch: batch.length },
        "Failed to write latency samples; unwritable rows dropped",
      );
    }
  };

  const writeBuffered = async (): Promise<void> => {
    while (buffer.length > 0) {
      await writeBatch(buffer.splice(0, maxBatch));
    }
  };

  // Writes run one after another, so a slow insert never overlaps the next.
  const flush = (): Promise<void> => {
    writing = writing.then(writeBuffered, writeBuffered);
    return writing;
  };

  const push: RecordLatency = (sample) => {
    try {
      if (!sample) return;
      if (buffer.length >= maxBuffer) {
        droppedOverflow += 1;
        return;
      }
      buffer.push(sample);
      // Armed by the first sample, so an idle process holds no timer.
      if (timer === null) {
        timer = timers.set(() => {
          timer = null;
          void flush();
        }, flushIntervalMs);
      }
    } catch {
      // Recording is never a reason for a request to fail.
    }
  };

  return {
    push,
    flush,
    close: async () => {
      if (timer !== null) {
        timers.clear(timer);
        timer = null;
      }
      await flush();
    },
    stats: () => ({ buffered: buffer.length, written, droppedOverflow, droppedFailed }),
  };
}
