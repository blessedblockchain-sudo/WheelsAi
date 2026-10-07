/**
 * How a measured latency is written, everywhere one is written: the landing
 * page's terminal line, the `wheelsai deploy` output, /status and the
 * dashboards.
 *
 * One rule: a number is printed only when it was measured. The public figure
 * (GET /api/public/stats `latency`) has three states, and only "measured"
 * carries a number; the other two say why there is none. Nothing here has a
 * default or fallback value.
 *
 * Self-contained on purpose (no imports): packages/cli ships compiled and
 * keeps a copy of the line formatter (packages/cli/src/lib/latency.ts), and
 * apps/api/src/tests/latencyLine.unit.test.ts holds the two to the same
 * output.
 */

export type PublicLatencyStatus = "measured" | "insufficient_data" | "unavailable";

/** The fields of GET /api/public/stats `latency` that are stated to a reader. */
export interface PublicLatencyFigure {
  status: PublicLatencyStatus;
  definition: string | null;
  windowHours: number | null;
  sampleCount: number | null;
  minSampleCount: number | null;
  minOrgCount: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  computedAt: string | null;
}

/**
 * What a surface knows about the figure: still asking, an answer, or no
 * answer (the request failed, or the API predates the measurement).
 */
export type LatencyLineInput = "loading" | PublicLatencyFigure | null | undefined;

const wholeNumber = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function measuredNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The figure from an API answer, or null when the answer is not one. A
 * "measured" answer without a usable p50 is not a measurement, so it reads
 * as unavailable instead of being printed as 0 or NaN.
 */
export function readPublicLatency(value: unknown): PublicLatencyFigure | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const status = raw.status;
  if (status !== "measured" && status !== "insufficient_data" && status !== "unavailable") return null;

  const p50Ms = measuredNumber(raw.p50Ms);
  const measured = status === "measured" && p50Ms !== null;
  return {
    status: status === "measured" && !measured ? "unavailable" : status,
    definition: text(raw.definition),
    windowHours: measuredNumber(raw.windowHours),
    sampleCount: measuredNumber(raw.sampleCount),
    minSampleCount: measuredNumber(raw.minSampleCount),
    minOrgCount: measuredNumber(raw.minOrgCount),
    p50Ms: measured ? p50Ms : null,
    p95Ms: measured ? measuredNumber(raw.p95Ms) : null,
    computedAt: text(raw.computedAt),
  };
}

/** "1,236 ms", or a dash for a latency that was not measured (never "0 ms"). */
export function formatLatencyMs(ms: number | null | undefined): string {
  const value = measuredNumber(ms);
  return value === null ? "—" : `${wholeNumber.format(Math.round(value))} ms`;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/**
 * The value after "Latency:" in the terminal line.
 *   loading            "measuring…"
 *   measured           "612 ms p50"
 *   insufficient_data  "measuring (12 of 50 requests)"
 *   unavailable        "live figure unavailable"
 */
export function formatLatencyValue(input: LatencyLineInput): string {
  if (input === "loading") return "measuring…";
  if (!input || input.status === "unavailable") return "live figure unavailable";
  if (input.status === "measured") {
    return input.p50Ms === null ? "live figure unavailable" : `${formatLatencyMs(input.p50Ms)} p50`;
  }

  const { sampleCount, minSampleCount, minOrgCount } = input;
  if (sampleCount === null || minSampleCount === null) return "measuring (not enough requests yet)";
  if (sampleCount < minSampleCount) {
    return `measuring (${wholeNumber.format(sampleCount)} of ${wholeNumber.format(minSampleCount)} requests)`;
  }
  // Enough requests and still no figure: they come from too few organizations.
  return minOrgCount === null
    ? "measuring (too few organizations yet)"
    : `measuring (requests from fewer than ${wholeNumber.format(minOrgCount)} ${plural(minOrgCount, "organization", "organizations")})`;
}

/** The sentence under the terminal: what the value is, or why there is none. */
export function formatLatencyCaption(input: LatencyLineInput): string {
  if (input === "loading") return "Reading the measured response time from the API.";
  if (!input || input.status === "unavailable") {
    return "The measured response time could not be read right now, so no figure is shown.";
  }

  const window = input.windowHours === null ? "the measurement window" : `the last ${wholeNumber.format(input.windowHours)} ${plural(input.windowHours, "hour", "hours")}`;
  if (input.status === "measured" && input.p50Ms !== null) {
    const over =
      input.sampleCount === null
        ? ""
        : ` over ${wholeNumber.format(input.sampleCount)} answered ${plural(input.sampleCount, "request", "requests")}`;
    return `Median time the API took to answer a chat request, measured${over} in ${window}.`;
  }

  const threshold =
    input.minSampleCount === null || input.minOrgCount === null
      ? "enough answered requests from enough organizations"
      : `at least ${wholeNumber.format(input.minSampleCount)} answered ${plural(input.minSampleCount, "request", "requests")} from at least ${wholeNumber.format(input.minOrgCount)} ${plural(input.minOrgCount, "organization", "organizations")}`;
  return `No figure yet: one is published once ${threshold} fall inside ${window}.`;
}
