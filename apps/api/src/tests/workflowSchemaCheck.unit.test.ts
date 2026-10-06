import assert from "node:assert/strict";
import test from "node:test";

import {
  checkAgainstSchema,
  findUnsupportedSchemaKeyword,
  isEmptySchema,
} from "../services/workflowSchemaCheck.js";

// Drives services/workflowSchemaCheck.ts. A workflow's inputSchema and
// outputSchema used to be stored and never read. The rule now: a schema
// keyword is either enforced or refused when the workflow is saved.

test("an empty schema constrains nothing", () => {
  assert.equal(isEmptySchema({}), true);
  assert.equal(isEmptySchema(null), true);
  assert.equal(isEmptySchema({ type: "object" }), false);
  assert.deepEqual(checkAgainstSchema({}, { anything: 1 }), []);
  assert.deepEqual(checkAgainstSchema(null, "x"), []);
});

test("types, required properties and nested objects are enforced", () => {
  const schema = {
    type: "object",
    required: ["topic", "count"],
    properties: {
      topic: { type: "string", minLength: 3, maxLength: 10 },
      count: { type: "integer", minimum: 1, maximum: 5 },
      tags: { type: "array", items: { type: "string" }, maxItems: 2 },
      mode: { enum: ["fast", "deep"] },
    },
    additionalProperties: false,
  };
  assert.deepEqual(checkAgainstSchema(schema, { topic: "tides", count: 2, tags: ["a"], mode: "deep" }), []);

  const errors = checkAgainstSchema(schema, {
    topic: "ab",
    count: 9.5,
    tags: ["a", 2, "c"],
    mode: "slow",
    extra: true,
  });
  assert.deepEqual(errors, [
    "topic must be at least 3 characters",
    "count must be integer, got number",
    "tags must have at most 2 items",
    "tags[1] must be string, got integer",
    'mode must be one of ["fast","deep"]',
    "extra is not allowed",
  ]);
  assert.deepEqual(checkAgainstSchema(schema, {}), ["topic is required", "count is required"]);
  assert.deepEqual(checkAgainstSchema(schema, "nope"), ["value must be object, got string"]);
});

test("an integer satisfies type number, and a type list accepts any member", () => {
  assert.deepEqual(checkAgainstSchema({ type: "number" }, 3), []);
  assert.deepEqual(checkAgainstSchema({ type: ["string", "null"] }, null), []);
  assert.deepEqual(checkAgainstSchema({ type: ["string", "null"] }, 3), [
    "value must be string or null, got integer",
  ]);
});

test("a keyword this checker cannot enforce is refused, with its path", () => {
  assert.equal(findUnsupportedSchemaKeyword({ type: "object", title: "ok", description: "ok" }), null);
  assert.match(
    findUnsupportedSchemaKeyword({ type: "string", pattern: "^a+$" })!,
    /schema uses "pattern", which is not supported/,
  );
  assert.match(
    findUnsupportedSchemaKeyword({
      type: "object",
      properties: { a: { type: "array", items: { oneOf: [] } } },
    })!,
    /schema\.properties\.a\.items uses "oneOf"/,
  );
  assert.match(findUnsupportedSchemaKeyword({ type: "text" })!, /schema\.type must be one of/);
  assert.match(findUnsupportedSchemaKeyword({ $ref: "#/x" })!, /"\$ref"/);
});
