/**
 * The one way a public latency is written (packages/shared/src/latency.ts),
 * used by the landing page's terminal line, /status and the dashboards, and
 * copied into the CLI.
 *
 * The landing page used to print "Latency: 47ms avg", a number nobody
 * measured. What is pinned here: a number is printed only from a "measured"
 * answer, every other state says why there is none, and the CLI's copy of
 * the formatter cannot drift from the shared one.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  formatLatencyCaption,
  formatLatencyMs,
  formatLatencyValue,
  readPublicLatency,
  type LatencyLineInput,
} from "@wheelsai/shared/latency";

/** GET /api/public/stats `latency`, as services/publicLatency.ts answers it. */
function answer(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "measured",
    metric: "response_time",
    definition: "Time the WheelsAI API took to produce the complete answer to a chat request.",
    surfaces: ["v1", "agent_api"],
    windowHours: 24,
    sampleCount: 1284,
    minSampleCount: 50,
    minOrgCount: 3,
    p50Ms: 612,
    p95Ms: 2140,
    firstTokenP50Ms: null,
    firstTokenSampleCount: 0,
    computedAt: "2026-10-07T00:00:00.000Z",
    ...over,
  };
}

const insufficient = (over: Record<string, unknown> = {}) =>
  answer({ status: "insufficient_data", sampleCount: 12, p50Ms: null, p95Ms: null, ...over });
const unavailable = () =>
  answer({ status: "unavailable", sampleCount: null, p50Ms: null, p95Ms: null, computedAt: null });

/** Any run of digits followed by "ms": what a stated latency looks like. */
const A_LATENCY = /\d\s?ms/;

describe("formatLatencyValue", () => {
  it("states the measured p50", () => {
    assert.equal(formatLatencyValue(readPublicLatency(answer())), "612 ms p50");
    assert.equal(formatLatencyValue(readPublicLatency(answer({ p50Ms: 1236 }))), "1,236 ms p50");
  });

  it("says how far the measurement is while it is below the sample threshold", () => {
    assert.equal(formatLatencyValue(readPublicLatency(insufficient())), "measuring (12 of 50 requests)");
    assert.equal(formatLatencyValue(readPublicLatency(insufficient({ sampleCount: 0 }))), "measuring (0 of 50 requests)");
  });

  it("names the organization threshold when the samples are enough and the figure is still withheld", () => {
    // Never "measuring (80 of 50 requests)".
    assert.equal(
      formatLatencyValue(readPublicLatency(insufficient({ sampleCount: 80 }))),
      "measuring (requests from fewer than 3 organizations)",
    );
    assert.equal(
      formatLatencyValue(readPublicLatency(insufficient({ sampleCount: 50, minOrgCount: 1 }))),
      "measuring (requests from fewer than 1 organization)",
    );
  });

  it("says the figure is unavailable when it could not be read or there is no answer", () => {
    for (const input of [readPublicLatency(unavailable()), null, undefined] as LatencyLineInput[]) {
      assert.equal(formatLatencyValue(input), "live figure unavailable");
    }
  });

  it("says measuring while the answer is on its way", () => {
    assert.equal(formatLatencyValue("loading"), "measuring…");
  });

  it("prints a number in exactly one state", () => {
    const withoutNumber: LatencyLineInput[] = [
      "loading",
      null,
      undefined,
      readPublicLatency(unavailable()),
      readPublicLatency(insufficient({ sampleCount: null })),
      readPublicLatency(insufficient({ minSampleCount: null })),
      // A number sent without the measured status is not printed.
      readPublicLatency(insufficient({ sampleCount: null, p50Ms: 47 })),
      readPublicLatency(answer({ status: "unavailable", sampleCount: null, p50Ms: 47 })),
      // "measured" without a usable p50 is not a measurement.
      readPublicLatency(answer({ p50Ms: null })),
      readPublicLatency(answer({ p50Ms: Number.NaN })),
      readPublicLatency(answer({ p50Ms: -1 })),
      readPublicLatency(answer({ p50Ms: "47" })),
    ];
    for (const input of withoutNumber) {
      assert.doesNotMatch(formatLatencyValue(input), A_LATENCY, JSON.stringify(input));
      assert.doesNotMatch(formatLatencyCaption(input), A_LATENCY, JSON.stringify(input));
    }
    assert.match(formatLatencyValue(readPublicLatency(answer())), A_LATENCY);
  });

  it("never prints the number the landing page used to invent", () => {
    const inputs: LatencyLineInput[] = ["loading", null, readPublicLatency(insufficient()), readPublicLatency(unavailable())];
    for (const input of inputs) {
      assert.ok(!formatLatencyValue(input).includes("47"));
      assert.ok(!formatLatencyCaption(input).includes("47"));
    }
  });
});

describe("readPublicLatency", () => {
  it("reads a measured answer", () => {
    assert.deepEqual(readPublicLatency(answer()), {
      status: "measured",
      definition: "Time the WheelsAI API took to produce the complete answer to a chat request.",
      windowHours: 24,
      sampleCount: 1284,
      minSampleCount: 50,
      minOrgCount: 3,
      p50Ms: 612,
      p95Ms: 2140,
      computedAt: "2026-10-07T00:00:00.000Z",
    });
  });

  it("returns null for anything that is not the figure", () => {
    for (const value of [undefined, null, "measured", 612, [], {}, { status: "ok" }, { p50Ms: 612 }]) {
      assert.equal(readPublicLatency(value), null, JSON.stringify(value));
    }
  });

  it("drops percentiles that come with any status but measured", () => {
    const figure = readPublicLatency(insufficient({ p50Ms: 47, p95Ms: 90 }));
    assert.equal(figure?.status, "insufficient_data");
    assert.equal(figure?.p50Ms, null);
    assert.equal(figure?.p95Ms, null);
  });

  it("reads a measured status without a p50 as unavailable", () => {
    assert.equal(readPublicLatency(answer({ p50Ms: null }))?.status, "unavailable");
  });
});

describe("formatLatencyCaption", () => {
  it("says what the measured value is, over how many requests and how long", () => {
    assert.equal(
      formatLatencyCaption(readPublicLatency(answer())),
      "Median time the API took to answer a chat request, measured over 1,284 answered requests in the last 24 hours.",
    );
  });

  it("states the publication rule while there is no figure", () => {
    assert.equal(
      formatLatencyCaption(readPublicLatency(insufficient())),
      "No figure yet: one is published once at least 50 answered requests from at least 3 organizations fall inside the last 24 hours.",
    );
  });

  it("says so when the figure could not be read", () => {
    assert.equal(
      formatLatencyCaption(null),
      "The measured response time could not be read right now, so no figure is shown.",
    );
  });
});

describe("formatLatencyMs", () => {
  it("groups thousands and rounds to whole milliseconds", () => {
    assert.equal(formatLatencyMs(612), "612 ms");
    assert.equal(formatLatencyMs(1236.4), "1,236 ms");
    assert.equal(formatLatencyMs(0), "0 ms");
  });

  it("shows a dash for a latency that was not measured, never 0 ms", () => {
    for (const value of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -5]) {
      assert.equal(formatLatencyMs(value), "—");
    }
  });
});

describe("the CLI's copy", () => {
  it("is the shared formatter, unchanged", () => {
    // packages/cli ships compiled and cannot import @wheelsai/shared, so it
    // carries the formatter. Same text in, same text out: compare the source.
    const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
    const from = (source: string) => {
      const start = source.indexOf("export type PublicLatencyStatus");
      assert.ok(start >= 0);
      return source.slice(start);
    };
    assert.equal(
      from(read("../../../../packages/cli/src/lib/latency.ts")),
      from(read("../../../../packages/shared/src/latency.ts")),
    );
  });
});
