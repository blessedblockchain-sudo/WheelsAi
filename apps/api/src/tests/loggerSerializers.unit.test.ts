/**
 * A log line keeps the error it was given. An Error has no enumerable
 * fields, so a logger with no serializer for the key writes it as `{}`.
 */
import assert from "node:assert/strict";
import test from "node:test";

import pino from "pino";

import { logSerializers } from "../utils/logger.js";

/** A logger built the way utils/logger.ts builds its own, writing to memory. */
function capture() {
  const lines: string[] = [];
  const build = pino as unknown as (options: Record<string, unknown>, stream: { write(line: string): void }) => {
    error(fields: Record<string, unknown>, message: string): void;
    child(bindings: Record<string, unknown>): { error(fields: Record<string, unknown>, message: string): void };
  };
  const logger = build({ serializers: logSerializers }, { write: (line) => lines.push(line) });
  return { logger, lines, last: () => JSON.parse(lines[lines.length - 1] as string) as Record<string, any> };
}

test("an Error logged under `error` is written with its message and stack, as one under `err` is", () => {
  const { logger, last } = capture();
  logger.error({ jobId: "j1", error: new Error("connection refused at 10.0.0.5:5432") }, "Top-up reconcile job failed");
  const underError = last();
  assert.equal(underError.error.message, "connection refused at 10.0.0.5:5432");
  assert.equal(underError.error.type, "Error");
  assert.match(underError.error.stack, /connection refused/);
  assert.equal(underError.jobId, "j1");

  logger.error({ err: new TypeError("not a function") }, "failed");
  assert.equal(last().err.message, "not a function");
  assert.equal(last().err.type, "TypeError");
});

test("a logger made for one part of the API writes it the same way", () => {
  const { logger, last } = capture();
  logger.child({ context: "payout-executor" }).error({ error: new Error("blockhash not found") }, "Payout executor job failed");
  assert.equal(last().error.message, "blockhash not found");
  assert.equal(last().context, "payout-executor");
});

test("a value that is not an Error is written as it is", () => {
  const { logger, last } = capture();
  logger.error({ error: "insufficient_credits" }, "refused");
  assert.equal(last().error, "insufficient_credits");
  logger.error({ error: { code: 429, detail: "slow down" } }, "refused");
  assert.deepEqual(last().error, { code: 429, detail: "slow down" });
  logger.error({ error: null }, "nothing");
  assert.equal(last().error, null);
});

test("without the serializer the same line says nothing, which is what this guards against", () => {
  const lines: string[] = [];
  const bare = (pino as unknown as (options: Record<string, unknown>, stream: { write(line: string): void }) => { error(fields: Record<string, unknown>, message: string): void })(
    {},
    { write: (line) => lines.push(line) },
  );
  bare.error({ error: new Error("lost") }, "failed");
  assert.deepEqual(JSON.parse(lines[0] as string).error, {});
});
