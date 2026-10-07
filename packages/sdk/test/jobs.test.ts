/**
 * Offerings and jobs: what the pinned route table cannot say. A hire carries its
 * Idempotency-Key, never loses the configured credential to a caller's header, and the
 * refusals a buying agent has to tell apart reach it as a status and a code.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { WheelsAI, WheelsAIError } from "../src/index.js";
import { API_KEY, BASE_URL, jsonResponse, recordingFetch } from "./helpers.js";

const OFFERING = "44444444-4444-4444-8444-444444444444";
const JOB = "55555555-5555-4555-8555-555555555555";

function client(respond?: Parameters<typeof recordingFetch>[0]) {
  const { fetch, calls } = recordingFetch(respond);
  return { wheels: new WheelsAI({ baseUrl: BASE_URL, apiKey: API_KEY, fetch }), calls };
}

async function refusal(run: () => Promise<unknown>): Promise<WheelsAIError> {
  try {
    await run();
  } catch (err) {
    assert.ok(err instanceof WheelsAIError);
    return err;
  }
  throw new assert.AssertionError({ message: "expected the call to be refused" });
}

describe("offerings.hire", () => {
  it("sends the Idempotency-Key header and the input", async () => {
    const { wheels, calls } = client(() => jsonResponse({ job: { id: JOB, status: "funded" } }, 201));
    const { job } = await wheels.offerings.hire(OFFERING, { topic: "gpu prices" }, { idempotencyKey: "order-42" });

    assert.equal(job.id, JOB);
    const call = calls[0]!;
    assert.equal(call.method, "POST");
    assert.equal(call.url.pathname, `/api/offerings/${OFFERING}/hire`);
    assert.equal(call.headers.get("idempotency-key"), "order-42");
    assert.deepEqual(call.body, { input: { topic: "gpu prices" } });
  });

  it("given the offering as it was read, sends its terms as `expected`", async () => {
    const { wheels, calls } = client(() => jsonResponse({ job: { id: JOB, status: "funded" } }, 201));
    const offering = { id: OFFERING, priceCents: 500, slaSeconds: 3600, termsVersion: "0123abcd", title: "Brief" };
    await wheels.offerings.hire(offering, { topic: "gpu prices" });
    assert.equal(calls[0]!.url.pathname, `/api/offerings/${OFFERING}/hire`);
    assert.deepEqual(calls[0]!.body, {
      input: { topic: "gpu prices" },
      expected: { priceCents: 500, slaSeconds: 3600, termsVersion: "0123abcd" },
    });

    // By id, only what the caller says it expects; options.expected wins over the object.
    await wheels.offerings.hire(OFFERING, {}, { expected: { priceCents: 500 } });
    assert.deepEqual(calls[1]!.body, { input: {}, expected: { priceCents: 500 } });
    await wheels.offerings.hire(offering, {}, { expected: { priceCents: 400 } });
    assert.deepEqual(calls[2]!.body, { input: {}, expected: { priceCents: 400 } });
  });

  it("409: the offering changed since it was read, with the terms as they are now", async () => {
    const current = { priceCents: 100000, slaSeconds: 3600, termsVersion: "ffff0000" };
    const { wheels } = client(() =>
      jsonResponse(
        { error: "offering_terms_changed", message: "This offering changed after you opened it.", current, changed: ["priceCents", "termsVersion"] },
        409,
      ),
    );
    const err = await refusal(() =>
      wheels.offerings.hire({ id: OFFERING, priceCents: 500, slaSeconds: 3600, termsVersion: "0123abcd" }),
    );
    assert.equal(err.status, 409);
    assert.equal(err.code, "offering_terms_changed");
    assert.deepEqual((err.data as { current: unknown }).current, current);
    assert.deepEqual((err.data as { changed: string[] }).changed, ["priceCents", "termsVersion"]);
  });

  it("sends no Idempotency-Key unless one is given", async () => {
    const { wheels, calls } = client();
    await wheels.offerings.hire(OFFERING);
    assert.equal(calls[0]!.headers.has("idempotency-key"), false);
    assert.deepEqual(calls[0]!.body, { input: {} });
  });

  it("keeps the configured credential when a caller passes an Authorization header", async () => {
    const { wheels, calls } = client();
    await wheels.offerings.hire(OFFERING, {}, { headers: { Authorization: "Bearer someone-else" } });
    assert.equal(calls[0]!.headers.get("authorization"), `Bearer ${API_KEY}`);
  });

  it("402: not enough credits, with what was needed", async () => {
    const { wheels } = client(() =>
      jsonResponse(
        { error: "insufficient_credits", message: "Not enough credits", requiredCents: 200, balanceCents: 40 },
        402,
      ),
    );
    const err = await refusal(() => wheels.offerings.hire(OFFERING, {}));
    assert.equal(err.status, 402);
    assert.equal(err.code, "insufficient_credits");
    assert.deepEqual(err.data, {
      error: "insufficient_credits",
      message: "Not enough credits",
      requiredCents: 200,
      balanceCents: 40,
    });
  });

  it("403: a key that was not granted jobs:hire", async () => {
    const { wheels } = client(() =>
      jsonResponse(
        { error: "missing_scope", message: 'This API key does not have the "jobs:hire" scope.', scope: "jobs:hire" },
        403,
      ),
    );
    const err = await refusal(() => wheels.offerings.hire(OFFERING, {}));
    assert.equal(err.status, 403);
    assert.equal(err.code, "missing_scope");
    assert.equal((err.data as { scope: string }).scope, "jobs:hire");
  });

  it("403: a job above the key's spend cap", async () => {
    const { wheels } = client(() =>
      jsonResponse(
        { error: "api_key_daily_cap_exceeded", message: "Past the daily cap", priceCents: 200, dailySpendCapCents: 300 },
        403,
      ),
    );
    const err = await refusal(() => wheels.offerings.hire(OFFERING, {}));
    assert.equal(err.code, "api_key_daily_cap_exceeded");
  });

  it("422: the input does not match the offering's schema, with each field's problem", async () => {
    const { wheels } = client(() =>
      jsonResponse(
        {
          error: "input_invalid",
          message: "The input does not match this offering's input schema",
          errors: [{ path: "/topic", message: "must have required property 'topic'" }],
        },
        422,
      ),
    );
    const err = await refusal(() => wheels.offerings.hire(OFFERING, {}));
    assert.equal(err.status, 422);
    assert.equal(err.code, "input_invalid");
    assert.deepEqual((err.data as { errors: unknown[] }).errors, [
      { path: "/topic", message: "must have required property 'topic'" },
    ]);
  });

  it("a repeated key answers the first job (200) like a first hire (201)", async () => {
    const { wheels } = client(() => jsonResponse({ job: { id: JOB, status: "submitted" } }, 200));
    const { job } = await wheels.offerings.hire(OFFERING, {}, { idempotencyKey: "order-42" });
    assert.equal(job.status, "submitted");
  });
});

describe("jobs", () => {
  it("accept sends the rating and returns the released job", async () => {
    const { wheels, calls } = client(() =>
      jsonResponse({ job: { id: JOB, status: "completed", escrow: { status: "released", amountCents: 200 } } }),
    );
    const { job } = await wheels.jobs.accept(JOB, { rating: 5, review: "Great" });
    assert.deepEqual(calls[0]!.body, { rating: 5, review: "Great" });
    assert.equal(job.escrow?.status, "released");
  });

  it("accept with nothing to say still sends a JSON body", async () => {
    const { wheels, calls } = client();
    await wheels.jobs.accept(JOB);
    assert.deepEqual(calls[0]!.body, {});
  });

  it("reject sends the reason and returns what was refunded", async () => {
    const { wheels, calls } = client(() =>
      jsonResponse({ job: { id: JOB, status: "rejected" }, refundedCents: 200 }),
    );
    const res = await wheels.jobs.reject(JOB, "Off topic");
    assert.deepEqual(calls[0]!.body, { reason: "Off topic" });
    assert.equal(res.refundedCents, 200);
  });

  it("reject after the review window is a 409 the caller can tell apart", async () => {
    const { wheels } = client(() =>
      jsonResponse({ error: "review_window_closed", message: "The review window for this job has closed" }, 409),
    );
    const err = await refusal(() => wheels.jobs.reject(JOB, "Too late"));
    assert.equal(err.status, 409);
    assert.equal(err.code, "review_window_closed");
  });

  it("cancel sends the reason only when there is one", async () => {
    const { wheels, calls } = client();
    await wheels.jobs.cancel(JOB, "Changed my mind");
    await wheels.jobs.cancel(JOB);
    assert.deepEqual(calls[0]!.body, { reason: "Changed my mind" });
    assert.deepEqual(calls[1]!.body, {});
  });

  it("rate leaves the review out when there is none", async () => {
    const { wheels, calls } = client();
    await wheels.jobs.rate(JOB, 3);
    assert.deepEqual(calls[0]!.body, { rating: 3 });
  });

  it("an id cannot change the route", async () => {
    const { wheels, calls } = client();
    await wheels.jobs.get("a/b?c");
    assert.equal(calls[0]!.url.pathname, "/api/jobs/a%2Fb%3Fc");
    assert.throws(() => wheels.jobs.get(".."), WheelsAIError);
  });
});

describe("auth.createApiKey", () => {
  it("sends the spend scope with both caps", async () => {
    const { wheels, calls } = client();
    await wheels.auth.createApiKey({
      name: "buyer agent",
      scopes: ["jobs:hire", "jobs:read"],
      maxJobPriceCents: 500,
      dailySpendCapCents: 2000,
    });
    assert.deepEqual(calls[0]!.body, {
      name: "buyer agent",
      scopes: ["jobs:hire", "jobs:read"],
      maxJobPriceCents: 500,
      dailySpendCapCents: 2000,
    });
  });
});
