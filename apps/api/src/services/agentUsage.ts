/**
 * Agent chat usage: the hourly rollup behind an agent's request, token and
 * latency numbers (model `AgentUsageRecord`).
 *
 * Model deployments have had `UsageRecord` since the start; agent chats had
 * only a per-day, per-model request counter that skipped streamed chats, so
 * nothing could say how much traffic an agent's API took or how fast it
 * answered. The shared agent-chat service writes one row per (agent, source,
 * UTC hour) here, for every chat that was admitted.
 *
 * Three rules the numbers keep:
 *   - tokens are added only when the provider reported them; a chat that
 *     reported none is counted in `usageUnreportedCount` instead of being
 *     passed off as zero tokens
 *   - latency (total and histogram) covers answered chats only, so a burst of
 *     fast failures cannot make an agent look quick
 *   - a client that hung up is a request, not an error
 *
 * The pure parts (bucketing, the row a chat becomes) are separate from the
 * one statement that writes them.
 *
 * Every chat recorded here also leaves one per-request latency sample
 * (services/latencySamples.ts). That table is the ONLY place a latency is
 * read from - averages, percentiles, the public figure, latency alerts; this
 * rollup keeps the counts and tokens. Its latency sum and histogram are
 * still written, and nothing reads them as a latency: a summary takes its
 * latency from the samples (summarizeAgentUsage). Recording both from the
 * one hook every agent chat passes is what keeps them describing the same
 * requests.
 */

import { Prisma } from "@wheelsai/db";

import { recordLatencySample } from "./buildLatencySampleDeps.js";
import {
  agentSurface,
  buildLatencySample,
  providerOfModelId,
  type LatencySample,
  type RecordLatency,
} from "./latencySamples.js";

/**
 * Upper bounds, in ms, of the latency buckets. One more bucket follows for
 * everything slower than the last bound. Changing this list changes what
 * stored histograms mean: add to the end only.
 */
export const LATENCY_BUCKETS_MS = [
  250, 500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 60_000, 120_000,
] as const;

export const LATENCY_BUCKET_COUNT = LATENCY_BUCKETS_MS.length + 1;

export function latencyBucket(latencyMs: number): number {
  const index = LATENCY_BUCKETS_MS.findIndex((bound) => latencyMs <= bound);
  return index === -1 ? LATENCY_BUCKETS_MS.length : index;
}

/** A histogram with one answered chat in the bucket `latencyMs` falls in. */
export function histogramOf(latencyMs: number): number[] {
  const histogram = new Array<number>(LATENCY_BUCKET_COUNT).fill(0);
  histogram[latencyBucket(latencyMs)] = 1;
  return histogram;
}

export function addHistograms(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(LATENCY_BUCKET_COUNT).fill(0);
  for (let i = 0; i < LATENCY_BUCKET_COUNT; i++) out[i] = (a[i] ?? 0) + (b[i] ?? 0);
  return out;
}

/** Start of the UTC hour `at` falls in. */
export function usagePeriodStart(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), at.getUTCHours()));
}

export interface AgentChatUsageEvent {
  orgId: string;
  agentId: string;
  source: string;
  /** The model that answered ("graph" for a graph agent); names the provider. */
  modelId?: string;
  streamed: boolean;
  /** A real answer (or a function-calling hand-back) was produced. */
  ok: boolean;
  /** The caller hung up before the answer; neither an answer nor an error. */
  clientGone: boolean;
  /** null = the provider did not report usage. */
  usage: { inputTokens: number; outputTokens: number } | null;
  toolCallCount: number;
  latencyMs: number;
}

export interface AgentUsageIncrement {
  orgId: string;
  agentId: string;
  source: string;
  periodStart: Date;
  requestCount: number;
  errorCount: number;
  streamedCount: number;
  inputTokens: number;
  outputTokens: number;
  usageUnreportedCount: number;
  totalLatencyMs: number;
  toolCallCount: number;
  latencyHistogram: number[];
}

/** What one chat adds to its hour's row. Pure. */
export function usageIncrement(event: AgentChatUsageEvent, at: Date): AgentUsageIncrement {
  const latencyMs = Math.max(0, Math.round(event.latencyMs));
  return {
    orgId: event.orgId,
    agentId: event.agentId,
    source: event.source,
    periodStart: usagePeriodStart(at),
    requestCount: 1,
    errorCount: !event.ok && !event.clientGone ? 1 : 0,
    streamedCount: event.streamed ? 1 : 0,
    inputTokens: event.ok ? (event.usage?.inputTokens ?? 0) : 0,
    outputTokens: event.ok ? (event.usage?.outputTokens ?? 0) : 0,
    usageUnreportedCount: event.ok && !event.usage ? 1 : 0,
    totalLatencyMs: event.ok ? latencyMs : 0,
    toolCallCount: event.toolCallCount,
    latencyHistogram: event.ok
      ? histogramOf(latencyMs)
      : new Array<number>(LATENCY_BUCKET_COUNT).fill(0),
  };
}

/**
 * The per-request latency sample of one chat. Unlike the rollup's latency
 * sum, a chat that failed or was abandoned leaves a sample too, marked by its
 * outcome, so a reader chooses which endings count instead of never seeing
 * them. null when the chat's time is not a measurement. Pure.
 */
export function agentLatencySample(event: AgentChatUsageEvent, at: Date): LatencySample | null {
  const surface = agentSurface(event.source);
  if (!surface) return null;
  return buildLatencySample(
    {
      orgId: event.orgId,
      surface,
      agentId: event.agentId,
      model: event.modelId ?? null,
      provider: providerOfModelId(event.modelId),
      streamed: event.streamed,
      outcome: event.ok ? "ok" : event.clientGone ? "cancelled" : "error",
      totalMs: event.latencyMs,
      outputTokens: event.ok ? (event.usage?.outputTokens ?? null) : null,
    },
    at,
  );
}

export interface AgentUsageWriter {
  $executeRaw(query: Prisma.Sql): Promise<number>;
}

/**
 * Adds one chat to its hour's row, creating the row when it is the first.
 *
 * One statement, so concurrent chats of the same agent cannot lose each
 * other's counts. Raw SQL because the histogram is incremented element by
 * element, which a Prisma upsert cannot express.
 *
 * The latency sample is handed over first and synchronously: it does not
 * depend on the rollup being written, and it cannot fail this call.
 */
export async function recordAgentUsage(
  db: AgentUsageWriter,
  event: AgentChatUsageEvent,
  at: Date = new Date(),
  recordLatency: RecordLatency = recordLatencySample,
): Promise<void> {
  try {
    recordLatency(agentLatencySample(event, at));
  } catch {
    // An injected recorder that throws must not cost the rollup its row.
  }
  const row = usageIncrement(event, at);
  await db.$executeRaw(Prisma.sql`
    INSERT INTO "agent_usage_records" AS r (
      "id", "org_id", "agent_id", "source", "period_start",
      "request_count", "error_count", "streamed_count",
      "input_tokens", "output_tokens", "usage_unreported_count",
      "total_latency_ms", "tool_call_count", "latency_histogram",
      "created_at", "updated_at"
    ) VALUES (
      gen_random_uuid(), ${row.orgId}::uuid, ${row.agentId}::uuid, ${row.source}, ${row.periodStart},
      ${row.requestCount}, ${row.errorCount}, ${row.streamedCount},
      ${row.inputTokens}, ${row.outputTokens}, ${row.usageUnreportedCount},
      ${row.totalLatencyMs}, ${row.toolCallCount}, ${row.latencyHistogram}::int[],
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
    ON CONFLICT ("agent_id", "source", "period_start") DO UPDATE SET
      "request_count" = r."request_count" + EXCLUDED."request_count",
      "error_count" = r."error_count" + EXCLUDED."error_count",
      "streamed_count" = r."streamed_count" + EXCLUDED."streamed_count",
      "input_tokens" = r."input_tokens" + EXCLUDED."input_tokens",
      "output_tokens" = r."output_tokens" + EXCLUDED."output_tokens",
      "usage_unreported_count" = r."usage_unreported_count" + EXCLUDED."usage_unreported_count",
      "total_latency_ms" = r."total_latency_ms" + EXCLUDED."total_latency_ms",
      "tool_call_count" = r."tool_call_count" + EXCLUDED."tool_call_count",
      "latency_histogram" = (
        SELECT array_agg(COALESCE(u.a, 0) + COALESCE(u.b, 0) ORDER BY u.i)
        FROM unnest(r."latency_histogram", EXCLUDED."latency_histogram") WITH ORDINALITY AS u(a, b, i)
      ),
      "updated_at" = CURRENT_TIMESTAMP
  `);
}

// ============================================
// Reading
// ============================================

/** The columns a summary is built from (a row, or several rows' worth). */
export interface AgentUsageRow {
  requestCount: number;
  errorCount: number;
  streamedCount: number;
  inputTokens: bigint | number;
  outputTokens: bigint | number;
  usageUnreportedCount: number;
  totalLatencyMs: bigint | number;
  toolCallCount: number;
  latencyHistogram: number[];
}

export interface AgentUsageSummary {
  requests: number;
  errors: number;
  streamed: number;
  /** Chats that produced an answer: the base of the latency numbers. */
  answered: number;
  inputTokens: number;
  outputTokens: number;
  /** Answered chats whose tokens are NOT in the sums above. */
  usageUnreported: number;
  toolCalls: number;
  /**
   * End-to-end time of answered chats, from the per-request latency samples:
   * exact, not bucket ceilings. null when no sample was read for these rows.
   */
  avgLatencyMs: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  /** errors / requests, 0..1. */
  errorRate: number;
}

/** The measured latency of the same chats the rows count (latencyQueries.ts). */
export interface MeasuredLatency {
  avgMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
}

/**
 * Sums rows into what a dashboard shows. Pure.
 *
 * Latency is not derived from the rows: the hourly histogram can only say
 * which bucket a percentile fell in, and the samples say what it was. The
 * caller reads it for the same scope and passes it in; without it the
 * summary states no latency.
 */
export function summarizeAgentUsage(
  rows: readonly AgentUsageRow[],
  latency: MeasuredLatency | null = null,
): AgentUsageSummary {
  let requests = 0;
  let errors = 0;
  let streamed = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let usageUnreported = 0;
  let toolCalls = 0;
  let histogram: number[] = new Array<number>(LATENCY_BUCKET_COUNT).fill(0);
  for (const row of rows) {
    requests += row.requestCount;
    errors += row.errorCount;
    streamed += row.streamedCount;
    inputTokens += Number(row.inputTokens);
    outputTokens += Number(row.outputTokens);
    usageUnreported += row.usageUnreportedCount;
    toolCalls += row.toolCallCount;
    histogram = addHistograms(histogram, row.latencyHistogram);
  }
  const answered = histogram.reduce((sum, count) => sum + count, 0);
  return {
    requests,
    errors,
    streamed,
    answered,
    inputTokens,
    outputTokens,
    usageUnreported,
    toolCalls,
    avgLatencyMs: latency?.avgMs ?? null,
    p50LatencyMs: latency?.p50Ms ?? null,
    p95LatencyMs: latency?.p95Ms ?? null,
    errorRate: requests > 0 ? errors / requests : 0,
  };
}
