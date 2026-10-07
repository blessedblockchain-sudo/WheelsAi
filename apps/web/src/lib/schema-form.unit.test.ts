/**
 * The hire form's core. Run with:
 *   cd apps/web && npx tsx --test src/lib/schema-form.unit.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FREEFORM_FIELD,
  buildInput,
  fieldsFromSchema,
  initialValues,
  issuesByField,
  labelFromName,
} from "./schema-form";

const schema = {
  type: "object",
  required: ["topic", "count"],
  properties: {
    topic: { type: "string", title: "Topic", minLength: 3, maxLength: 120, description: "What to write about" },
    notes: { type: "string" },
    audience: { type: "string", enum: ["investors", "engineers"], default: "engineers" },
    count: { type: "integer", minimum: 1, maximum: 10 },
    temperature: { type: "number" },
    urgent: { type: "boolean" },
    links: { type: "array", items: { type: "string", format: "uri" } },
    site: { type: "string", format: "uri" },
    options: { type: "object" },
    max_results: { type: "integer", enum: [5, 10] },
  },
};

test("fields come out in the publisher's order with the right control for each", () => {
  const { fields, freeform } = fieldsFromSchema(schema);
  assert.equal(freeform, false);
  assert.deepEqual(
    fields.map((f) => [f.name, f.kind]),
    [
      ["topic", "string"],
      ["notes", "text"],
      ["audience", "enum"],
      ["count", "integer"],
      ["temperature", "number"],
      ["urgent", "boolean"],
      ["links", "string-array"],
      ["site", "string"],
      ["options", "json"],
      ["max_results", "enum"],
    ],
  );
  const topic = fields[0]!;
  assert.equal(topic.required, true);
  assert.equal(topic.title, "Topic");
  assert.equal(topic.description, "What to write about");
  assert.equal(topic.maxLength, 120);
  assert.equal(fields[3]!.min, 1);
  assert.equal(fields[3]!.max, 10);
  assert.equal(fields[7]!.format, "uri");
  assert.equal(fields[9]!.title, "Max results");
});

test("a schema with nothing to draw is edited as one JSON object", () => {
  for (const nothing of [null, undefined, {}, { type: "object" }, { type: "object", properties: {} }, "x", []]) {
    assert.deepEqual(fieldsFromSchema(nothing), { fields: [], freeform: true });
  }
  assert.deepEqual(initialValues(null), { [FREEFORM_FIELD]: "{}" });
  assert.deepEqual(buildInput(null, { [FREEFORM_FIELD]: '{"a": 1}' }), { input: { a: 1 }, errors: {} });
  assert.deepEqual(buildInput(null, { [FREEFORM_FIELD]: "  " }), { input: {}, errors: {} });
  assert.equal(buildInput(null, { [FREEFORM_FIELD]: "{nope" }).errors[FREEFORM_FIELD], "This is not valid JSON");
  assert.match(buildInput(null, { [FREEFORM_FIELD]: "[1]" }).errors[FREEFORM_FIELD]!, /must be a JSON object/);
});

test("names without a title are made readable", () => {
  assert.equal(labelFromName("max_results"), "Max results");
  assert.equal(labelFromName("maxResults"), "Max results");
  assert.equal(labelFromName("target-url"), "Target url");
  assert.equal(labelFromName("x"), "X");
});

test("the form starts from the schema's defaults, or from a sample", () => {
  const blank = initialValues(schema);
  assert.equal(blank.topic, "");
  assert.equal(blank.audience, "engineers");
  assert.equal(blank.urgent, false);

  const fromSample = initialValues(schema, {
    topic: "GPU prices",
    count: 3,
    urgent: true,
    links: ["https://a.test", "https://b.test"],
    options: { depth: 2 },
    unknown: "ignored",
  });
  assert.equal(fromSample.topic, "GPU prices");
  assert.equal(fromSample.count, "3");
  assert.equal(fromSample.urgent, true);
  assert.equal(fromSample.links, "https://a.test\nhttps://b.test");
  assert.equal(fromSample.options, '{\n  "depth": 2\n}');
  // A sample that leaves a field out falls back to the default.
  assert.equal(fromSample.audience, "engineers");
  assert.equal("unknown" in fromSample, false);
});

test("what was typed becomes the typed object, with empty optional fields left out", () => {
  const { input, errors } = buildInput(schema, {
    topic: "GPU prices",
    notes: "   ",
    audience: "investors",
    count: "3",
    temperature: "0.5",
    urgent: false,
    links: "https://a.test\n\n  https://b.test  \n",
    site: "",
    options: '{"depth": 2}',
    max_results: "10",
  });
  assert.deepEqual(errors, {});
  assert.deepEqual(input, {
    topic: "GPU prices",
    audience: "investors",
    count: 3,
    temperature: 0.5,
    links: ["https://a.test", "https://b.test"],
    options: { depth: 2 },
    // The schema's number, not the text of the option that was picked.
    max_results: 10,
  });
});

test("a round trip through a sample sends the sample back", () => {
  const sample = { topic: "GPU prices", audience: "investors", count: 2, urgent: true, links: ["https://a.test"] };
  assert.deepEqual(buildInput(schema, initialValues(schema, sample)).input, sample);
});

test("what the server would refuse anyway is caught before sending", () => {
  const { errors } = buildInput(schema, {
    topic: "",
    count: "2.5",
    temperature: "warm",
    audience: "nobody",
    options: "{",
    urgent: false,
  });
  assert.equal(errors.topic, "Topic is required");
  assert.equal(errors.count, "Enter a whole number");
  assert.equal(errors.temperature, "Enter a number");
  assert.equal(errors.audience, "Choose one of the options");
  assert.equal(errors.options, "This is not valid JSON");
});

test("a required or defaulted switch is always sent; an optional untouched one is not", () => {
  const s = {
    type: "object",
    required: ["agree"],
    properties: { agree: { type: "boolean" }, loud: { type: "boolean", default: false }, extra: { type: "boolean" } },
  };
  assert.deepEqual(buildInput(s, { agree: false, loud: false, extra: false }).input, { agree: false, loud: false });
  assert.deepEqual(buildInput(s, { agree: true, loud: true, extra: true }).input, { agree: true, loud: true, extra: true });
});

test("the server's problems land on the field they are about", () => {
  const byField = issuesByField(schema, [
    { path: "/topic", message: "must NOT have fewer than 3 characters" },
    { path: "/links/1", message: 'must match format "uri"' },
    { path: "", message: "must have required property 'count'" },
    { path: "", message: "must NOT have additional properties" },
    { path: "/ghost", message: "is not allowed" },
    { path: "/topic", message: "must match pattern" },
  ]);
  assert.equal(byField.topic, "must NOT have fewer than 3 characters; must match pattern");
  assert.equal(byField.links, 'must match format "uri"');
  assert.equal(byField.count, "This is required");
  assert.equal(byField[""], "must NOT have additional properties; ghost: is not allowed");
});

test("with no fields, every problem is shown on the JSON box", () => {
  assert.deepEqual(issuesByField(null, [{ path: "/a", message: "must be string" }]), {
    [FREEFORM_FIELD]: "a: must be string",
  });
});

test("a JSON pointer's escapes are undone", () => {
  const s = { type: "object", properties: { "a/b": { type: "string" } } };
  assert.deepEqual(issuesByField(s, [{ path: "/a~1b", message: "bad" }]), { "a/b": "bad" });
});
