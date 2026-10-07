import "./unitEnv.js";
import assert from "node:assert/strict";
import test from "node:test";

import { NosanaDeadlineError, redactNosanaErrorBody, withDeadline } from "../services/nosana.js";

// The two pure helpers around every Nosana SDK call: the deadline (neither
// SDK 0.4.x nor the API client under it sets one) and the redaction of a
// refused create's answer before it is logged. No network: nothing here
// opens a socket.

test("withDeadline: a call that settles in time passes through, value or error", async () => {
  assert.equal(await withDeadline(Promise.resolve(42), 1_000, "fast"), 42);
  await assert.rejects(withDeadline(Promise.reject(new Error("refused")), 1_000, "fast"), /refused/);
});

test("withDeadline: a call that outlives it fails as nosana_timeout, naming the call; its late answer is ignored", async () => {
  let resolveLate: (value: string) => void = () => undefined;
  const late = new Promise<string>((resolve) => {
    resolveLate = resolve;
  });
  const started = Date.now();
  await assert.rejects(withDeadline(late, 50, "Creating a Nosana deployment"), (err: unknown) => {
    assert.ok(err instanceof NosanaDeadlineError);
    assert.equal(err.code, "nosana_timeout");
    assert.equal(err.ms, 50);
    assert.match(err.message, /^Creating a Nosana deployment did not answer within 50 ms$/);
    return true;
  });
  assert.ok(Date.now() - started < 1_000);
  resolveLate("too late"); // nothing is listening, and nothing breaks
});

test("withDeadline: a call that rejects after the deadline is not an unhandled rejection", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => void unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const late = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("late failure")), 30));
    await assert.rejects(withDeadline(late, 5, "Stopping"), NosanaDeadlineError);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("redactNosanaErrorBody keeps the validator's reason and drops every value that could be a secret", () => {
  const body = JSON.stringify({
    statusCode: 400,
    code: "FST_ERR_VALIDATION",
    error: "Bad Request",
    message: "job_definition$input.ops[0].args.required_vram: undefined",
    errors: [
      { path: "$input.ops[0].args.env.HF_TOKEN", expected: "string", value: "hf_abcdefghijklmnop" },
      { path: "$input.ops[0].args.cmd", expected: "string[]", value: ["sh", "-c", "curl https://s3/x?X-Amz-Signature=deadbeef"] },
    ],
    job_definition: { ops: [{ args: { env: { HF_TOKEN: "hf_abcdefghijklmnop" } } }] },
  });
  const redacted = redactNosanaErrorBody(body) as Record<string, unknown>;
  assert.equal(redacted.code, "FST_ERR_VALIDATION");
  assert.equal(redacted.message, "job_definition$input.ops[0].args.required_vram: undefined");
  assert.deepEqual(redacted.errors, [
    { path: "$input.ops[0].args.env.HF_TOKEN", expected: "string", value: "[redacted]" },
    { path: "$input.ops[0].args.cmd", expected: "string[]", value: "[redacted]" },
  ]);
  assert.equal(redacted.job_definition, "[redacted]");
  assert.doesNotMatch(JSON.stringify(redacted), /hf_abc|deadbeef/);
});

test("redactNosanaErrorBody scrubs key- and signature-shaped text in messages, and bounds the size", () => {
  const scrubbed = redactNosanaErrorBody(
    JSON.stringify({ error: "Bearer nos_live_123456789 rejected; see https://bucket/x?sig=abc&y=1 and hf_tokentoken" }),
  ) as Record<string, unknown>;
  assert.doesNotMatch(String(scrubbed.error), /nos_live|sig=abc|hf_tokentoken/);
  assert.match(String(scrubbed.error), /\[redacted\] rejected/);

  // Not JSON: cut-down, scrubbed text.
  const text = redactNosanaErrorBody(`<html>${"x".repeat(5_000)} nos_secret_key_1234</html>`);
  assert.equal(typeof text, "string");
  assert.ok((text as string).length <= 1_003);
  assert.doesNotMatch(text as string, /nos_secret/);

  // A huge JSON answer is bounded too.
  const huge = redactNosanaErrorBody(JSON.stringify({ items: Array.from({ length: 500 }, (_, i) => ({ path: `p${i}`, note: "y".repeat(200) })) }));
  assert.ok(JSON.stringify(huge).length <= 4_100);
});
