"use client";

import { useEffect, useState } from "react";
import { formatLatencyValue, readPublicLatency, type PublicLatencyFigure } from "@wheelsai/shared/latency";

import { API_BASE_URL } from "@/lib/api";

/**
 * GET /api/public/stats, asked once per page load however many components
 * read it: the landing page's stat tiles and its latency line show one
 * answer, from one request.
 *
 * The product counts have a fallback in the component that shows them (they
 * are constants of the build). The latency has none: without an answer there
 * is no figure, and the line says so.
 */

export interface PublicStatsAnswer {
  frameworks: number | null;
  models: number | null;
  pricingModels: number | null;
  channels: number | null;
  /** null when the API answered without a latency block (one that predates the measurement). */
  latency: PublicLatencyFigure | null;
}

export type PublicStatsState =
  | { phase: "loading" }
  | { phase: "ready"; stats: PublicStatsAnswer }
  /** The request failed or did not answer with stats. */
  | { phase: "failed" };

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** The stats from a response body, or null when the body is not stats. */
export function readPublicStats(body: unknown): PublicStatsAnswer | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const raw = body as Record<string, unknown>;
  return {
    frameworks: count(raw.frameworks),
    models: count(raw.models),
    pricingModels: count(raw.pricingModels),
    channels: count(raw.channels),
    latency: readPublicLatency(raw.latency),
  };
}

type Settled = Exclude<PublicStatsState, { phase: "loading" }>;

/**
 * A reader that shares one request among everyone who asks while it is in
 * flight or after it succeeded. A failure is not kept: the next page that
 * mounts asks again. Never rejects.
 */
export function createPublicStatsReader(
  request: () => Promise<{ ok: boolean; json: () => Promise<unknown> }>,
): () => Promise<Settled> {
  let shared: Promise<Settled> | null = null;
  return () => {
    if (shared) return shared;
    const attempt: Promise<Settled> = (async (): Promise<Settled> => {
      try {
        const res = await request();
        const stats = res.ok ? readPublicStats(await res.json()) : null;
        return stats ? { phase: "ready", stats } : { phase: "failed" };
      } catch {
        return { phase: "failed" };
      }
    })();
    shared = attempt;
    void attempt.then((settled) => {
      if (settled.phase === "failed" && shared === attempt) shared = null;
    });
    return attempt;
  };
}

const readOnce = createPublicStatsReader(() =>
  fetch(`${API_BASE_URL}/api/public/stats`, { credentials: "omit" }),
);

/** "loading" on the server and until the answer arrives. */
export function usePublicStats(): PublicStatsState {
  const [state, setState] = useState<PublicStatsState>({ phase: "loading" });
  useEffect(() => {
    let mounted = true;
    void readOnce().then((settled) => {
      if (mounted) setState(settled);
    });
    return () => {
      mounted = false;
    };
  }, []);
  return state;
}

/** What the latency line is given for a state of the stats request. */
export function latencyLineInput(state: PublicStatsState): "loading" | PublicLatencyFigure | null {
  if (state.phase === "loading") return "loading";
  return state.phase === "ready" ? state.stats.latency : null;
}

/**
 * The value after "Latency:" on the landing page: the shared formatter's
 * text, except below the publication thresholds, where the landing page says
 * only that the figure is being measured. How many requests are in so far is
 * a fact for /status (where the caption links) and the CLI, not for the
 * first page a visitor reads.
 */
export function landingLatencyValue(input: "loading" | PublicLatencyFigure | null): string {
  if (input !== "loading" && input?.status === "insufficient_data") return "measuring";
  return formatLatencyValue(input);
}
