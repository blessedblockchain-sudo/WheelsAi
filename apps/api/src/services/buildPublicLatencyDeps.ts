/**
 * Composition root for the public latency figure (services/publicLatency.ts):
 * binds the cached reader to the sample table and to the publication
 * settings.
 *
 * One reader per process (processPublicLatency), so GET /api/public/stats and
 * GET /api/status state the same figure from the same read, and no amount of
 * public traffic runs more than one read a minute.
 */

import { env } from "../config/env.js";
import {
  buildLatencySampleDeps,
  latencyConfigFromEnv,
  type LatencySampleDeps,
} from "./buildLatencySampleDeps.js";
import {
  createPublicLatencyReader,
  type PublicLatencyReader,
  type PublicLatencyReaderDeps,
  type PublicLatencyThresholds,
} from "./publicLatency.js";

export function publicLatencyThresholdsFromEnv(e: {
  PUBLIC_LATENCY_WINDOW_HOURS: number;
  PUBLIC_LATENCY_MIN_SAMPLES: number;
  PUBLIC_LATENCY_MIN_ORGS: number;
}): PublicLatencyThresholds {
  return {
    windowHours: e.PUBLIC_LATENCY_WINDOW_HOURS,
    minSamples: e.PUBLIC_LATENCY_MIN_SAMPLES,
    minOrgs: e.PUBLIC_LATENCY_MIN_ORGS,
  };
}

export interface BuildPublicLatencyReaderInput {
  samples: Pick<
    LatencySampleDeps,
    "loadPublicLatencyRow" | "loadOutcomeCounts" | "loadLatencyHistogram"
  >;
  thresholds: PublicLatencyThresholds;
  cache?: Pick<PublicLatencyReaderDeps, "now" | "ttlMs" | "maxStaleMs" | "timeoutMs" | "retryMs">;
}

export function buildPublicLatencyReader(input: BuildPublicLatencyReaderInput): PublicLatencyReader {
  const { samples } = input;
  return createPublicLatencyReader({
    ...input.cache,
    thresholds: input.thresholds,
    // Three reads of one window. All must succeed: a figure with half its
    // proof missing is not stated.
    loadSnapshot: async () => {
      const [window, outcomes, histogram] = await Promise.all([
        samples.loadPublicLatencyRow(),
        samples.loadOutcomeCounts(),
        samples.loadLatencyHistogram(),
      ]);
      return { window, outcomes, histogram };
    },
  });
}

let processReader: PublicLatencyReader | null = null;

/** The process's reader, built on first use so importing this opens nothing. */
export function processPublicLatency(): PublicLatencyReader {
  return (processReader ??= buildPublicLatencyReader({
    samples: buildLatencySampleDeps({ config: latencyConfigFromEnv(env) }),
    thresholds: publicLatencyThresholdsFromEnv(env),
  }));
}
