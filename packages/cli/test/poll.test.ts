import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { WheelsAIError } from "@wheelsai/sdk";

import { isFatal, waitForDeployment, type PollEvent } from "../src/lib/poll.js";
import { deployment, fakeClock } from "./helpers.js";

/** A fetchDeployment that answers from a script: a status, a lastError/endpoint object, or an Error to throw. */
function scripted(...steps: Array<string | Error | Parameters<typeof deployment>[0]>) {
  let index = 0;
  const fetch = async () => {
    fetch.calls += 1;
    const step = steps[Math.min(index++, steps.length - 1)]!;
    if (step instanceof Error) throw step;
    return deployment(typeof step === "string" ? { status: step as never } : step);
  };
  /** How many times the deployment was asked for. */
  fetch.calls = 0;
  return fetch;
}

describe("waitForDeployment", () => {
  it("reports each status the API returns, in order, until running", async () => {
    const clock = fakeClock();
    const transitions: Array<[string | null, string]> = [];
    const result = await waitForDeployment({
      fetchDeployment: scripted("pending", "building", "building", "deploying", { status: "running", endpoint: "https://x.test/agent" }),
      knownStatus: "pending",
      timeoutMs: 600_000,
      intervalMs: 3_000,
      ...clock,
      onTransition: (event: PollEvent) => transitions.push([event.previous, event.status]),
    });
    assert.equal(result.outcome, "running");
    assert.equal(result.deployment?.endpoint, "https://x.test/agent");
    // The first poll matched the known status, so it is not a transition.
    assert.deepEqual(transitions, [
      ["pending", "building"],
      ["building", "deploying"],
      ["deploying", "running"],
    ]);
    assert.equal(result.elapsedMs, 12_000, "four sleeps of 3s between five polls");
  });

  it("treats the first status as a transition when none was known", async () => {
    const seen: Array<string | null> = [];
    await waitForDeployment({
      fetchDeployment: scripted("running"),
      timeoutMs: 1_000,
      intervalMs: 100,
      ...fakeClock(),
      onTransition: (event) => seen.push(event.previous),
    });
    assert.deepEqual(seen, [null]);
  });

  it("stops on failed and hands back the deployment with its lastError", async () => {
    const result = await waitForDeployment({
      fetchDeployment: scripted("building", { status: "failed", lastError: "no capacity" }),
      timeoutMs: 600_000,
      intervalMs: 1_000,
      ...fakeClock(),
    });
    assert.equal(result.outcome, "failed");
    assert.equal(result.deployment?.lastError, "no capacity");
  });

  it("stops on stopped", async () => {
    const result = await waitForDeployment({ fetchDeployment: scripted("stopped"), timeoutMs: 5_000, intervalMs: 100, ...fakeClock() });
    assert.equal(result.outcome, "stopped");
  });

  it("times out with the last status it saw", async () => {
    const result = await waitForDeployment({
      fetchDeployment: scripted("pending", "deploying"),
      timeoutMs: 10_000,
      intervalMs: 3_000,
      ...fakeClock(),
    });
    assert.equal(result.outcome, "timeout");
    assert.equal(result.deployment?.status, "deploying");
    assert.ok(result.elapsedMs >= 10_000);
  });

  it("keeps waiting through unknown statuses the API may add", async () => {
    const result = await waitForDeployment({
      fetchDeployment: scripted("scheduling", "warming", "running"),
      timeoutMs: 60_000,
      intervalMs: 1_000,
      ...fakeClock(),
    });
    assert.equal(result.outcome, "running");
  });

  it("retries a transient failure and carries on", async () => {
    const retries: number[] = [];
    const result = await waitForDeployment({
      fetchDeployment: scripted(new WheelsAIError(502, "Bad Gateway"), new WheelsAIError(0, "Could not reach"), "running"),
      timeoutMs: 60_000,
      intervalMs: 1_000,
      ...fakeClock(),
      onRetry: (_error, attempt) => retries.push(attempt),
    });
    assert.equal(result.outcome, "running");
    assert.deepEqual(retries, [1, 2]);
  });

  it("gives up after too many consecutive transient failures", async () => {
    const fetchDeployment = scripted(new WheelsAIError(503, "Service Unavailable"));
    const retries: number[] = [];
    await assert.rejects(
      waitForDeployment({
        fetchDeployment,
        timeoutMs: 600_000,
        intervalMs: 1_000,
        maxConsecutiveErrors: 3,
        ...fakeClock(),
        onRetry: (_error, attempt) => retries.push(attempt),
      }),
      { status: 503 },
    );
    assert.equal(fetchDeployment.calls, 4, "three retries after the first failure, then it gives up");
    assert.deepEqual(retries, [1, 2, 3]);
  });

  it("does not retry a refusal: bad credentials or a vanished deployment end the wait", async () => {
    for (const status of [401, 403, 404]) {
      const fetchDeployment = scripted(new WheelsAIError(status, "no"));
      const retries: number[] = [];
      const clock = fakeClock();
      await assert.rejects(
        waitForDeployment({
          fetchDeployment,
          timeoutMs: 600_000,
          intervalMs: 1_000,
          ...clock,
          onRetry: (_error, attempt) => retries.push(attempt),
        }),
        { status },
      );
      assert.equal(fetchDeployment.calls, 1, `${status} is asked exactly once`);
      assert.deepEqual(retries, []);
      assert.deepEqual(clock.sleeps, [], "and nothing is waited for");
    }
  });

  it("without a retry limit, transient failures last until the timeout, not until a count", async () => {
    const failures = Array.from({ length: 20 }, () => new WheelsAIError(503, "Service Unavailable"));
    const fetchDeployment = scripted(...failures, "running");
    const result = await waitForDeployment({ fetchDeployment, timeoutMs: 600_000, intervalMs: 3_000, ...fakeClock() });
    assert.equal(result.outcome, "running");
    assert.equal(fetchDeployment.calls, 21);
  });

  it("times out, saying why, when status checks are still failing at the end", async () => {
    const result = await waitForDeployment({
      fetchDeployment: scripted("building", new WheelsAIError(503, "Service Unavailable")),
      timeoutMs: 10_000,
      intervalMs: 3_000,
      ...fakeClock(),
    });
    assert.equal(result.outcome, "timeout");
    assert.equal(result.deployment?.status, "building", "the last status that was read");
    assert.equal(result.lastError?.message, "Service Unavailable");
  });

  it("clears the failure once a status check succeeds again", async () => {
    const result = await waitForDeployment({
      fetchDeployment: scripted(new WheelsAIError(503, "Service Unavailable"), "building"),
      timeoutMs: 10_000,
      intervalMs: 3_000,
      ...fakeClock(),
    });
    assert.equal(result.outcome, "timeout");
    assert.equal(result.lastError, undefined);
  });

  it("retries a 408 and a rate-limit 429, which pass with time", async () => {
    const rateLimited = new WheelsAIError(429, "Rate limit exceeded, retry in 1 minute", { statusCode: 429, error: "Too Many Requests" }, "Too Many Requests");
    const fetchDeployment = scripted(new WheelsAIError(408, "Request Timeout"), rateLimited, rateLimited, "running");
    const retries: number[] = [];
    const result = await waitForDeployment({
      fetchDeployment,
      timeoutMs: 600_000,
      intervalMs: 30_000,
      ...fakeClock(),
      onRetry: (_error, attempt) => retries.push(attempt),
    });
    assert.equal(result.outcome, "running");
    assert.deepEqual(retries, [1, 2, 3]);
    assert.equal(fetchDeployment.calls, 4);
  });

  it("does not retry a 429 that is a spent quota: asking again only spends more of it", async () => {
    for (const code of ["plan_limit_reached", "deployment_quota_exceeded"]) {
      const fetchDeployment = scripted(new WheelsAIError(429, "limit reached", { error: code }, code));
      await assert.rejects(
        waitForDeployment({ fetchDeployment, timeoutMs: 600_000, intervalMs: 30_000, ...fakeClock() }),
        { status: 429, code },
      );
      assert.equal(fetchDeployment.calls, 1, code);
    }
  });

  it("classifies errors: refusals are final, trouble that passes is not", () => {
    for (const status of [400, 401, 403, 404, 409, 422]) assert.equal(isFatal(new WheelsAIError(status, "no")), true, String(status));
    for (const status of [0, 408, 429, 500, 502, 503]) assert.equal(isFatal(new WheelsAIError(status, "later")), false, String(status));
    assert.equal(isFatal(new WheelsAIError(429, "used up", {}, "plan_limit_reached")), true);
    assert.equal(isFatal(new Error("socket hang up")), false);
  });

  it("backs off from the first interval to the steady one, and never sleeps past the timeout", async () => {
    const clock = fakeClock();
    const result = await waitForDeployment({
      fetchDeployment: scripted("pending"),
      timeoutMs: 100_000,
      intervalMs: 30_000,
      initialIntervalMs: 5_000,
      ...clock,
    });
    assert.equal(result.outcome, "timeout");
    assert.deepEqual(clock.sleeps, [5_000, 10_000, 20_000, 30_000, 30_000, 5_000]);
  });

  it("keeps a fixed interval when no first interval is given", async () => {
    const clock = fakeClock();
    await waitForDeployment({ fetchDeployment: scripted("pending"), timeoutMs: 9_000, intervalMs: 3_000, ...clock });
    assert.deepEqual(clock.sleeps, [3_000, 3_000, 3_000]);
  });

  it("makes at least one poll even with a zero timeout", async () => {
    const result = await waitForDeployment({ fetchDeployment: scripted("pending"), timeoutMs: 0, intervalMs: 1_000, ...fakeClock() });
    assert.equal(result.outcome, "timeout");
    assert.equal(result.deployment?.status, "pending");
  });
});
