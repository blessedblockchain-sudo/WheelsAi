/**
 * The order of a form's questions (services/schemaOrder.ts).
 *
 * What is pinned here: the order is read from the schema as it arrives; a
 * schema whose keys were shuffled in storage gets its questions back in the
 * saved order; keys the order does not name follow it and keys the schema
 * lacks are ignored; anything that is not an object schema is left alone;
 * and nothing but the order of `properties` ever changes.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { schemaOrderOf, withSchemaOrder } from "../services/schemaOrder.js";

const FORM = {
  type: "object",
  additionalProperties: false,
  required: ["topic", "audience"],
  properties: {
    topic: { type: "string", title: "Topic", maxLength: 200 },
    audience: { type: "string", title: "Who is it for?" },
    length: { type: "string", enum: ["short", "long"] },
    notes: { type: "string" },
  },
};

/**
 * What storage does to an object: the same values come back with keys in an
 * order of its own (JSONB sorts by key length, then by bytes).
 */
function stored(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stored);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort(
    (a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0),
  );
  return Object.fromEntries(keys.map((k) => [k, stored(record[k])]));
}

describe("schemaOrderOf", () => {
  it("gives the questions in the order they were written", () => {
    assert.deepEqual(schemaOrderOf(FORM), ["topic", "audience", "length", "notes"]);
  });

  it("reads the order of the text as it was received", () => {
    const received = JSON.parse(
      '{"properties":{"zeta":{"type":"string"},"alpha":{"type":"string"},"mid":{"type":"number"}},"type":"object"}',
    );
    assert.deepEqual(schemaOrderOf(received), ["zeta", "alpha", "mid"]);
  });

  it("is empty for a missing or non-object schema", () => {
    for (const schema of [undefined, null, "object", 7, true, [], [FORM]]) {
      assert.deepEqual(schemaOrderOf(schema), []);
    }
  });

  it("is empty when there are no properties to order", () => {
    assert.deepEqual(schemaOrderOf({}), []);
    assert.deepEqual(schemaOrderOf({ type: "string" }), []);
    assert.deepEqual(schemaOrderOf({ type: "object", properties: {} }), []);
    assert.deepEqual(schemaOrderOf({ type: "object", properties: null }), []);
    assert.deepEqual(schemaOrderOf({ type: "object", properties: ["a"] }), []);
    assert.deepEqual(schemaOrderOf({ type: "object", properties: "a" }), []);
  });

  it("returns a new list each time", () => {
    const first = schemaOrderOf(FORM);
    first.push("extra");
    assert.deepEqual(schemaOrderOf(FORM), ["topic", "audience", "length", "notes"]);
  });
});

describe("withSchemaOrder", () => {
  it("puts the questions back after storage shuffled them", () => {
    const order = schemaOrderOf(FORM);
    const shuffled = JSON.parse(JSON.stringify(stored(FORM)));
    // The shuffle is real: this is what a reader would see without the order.
    assert.notDeepEqual(schemaOrderOf(shuffled), order);

    const restored = withSchemaOrder(shuffled, order);
    assert.deepEqual(schemaOrderOf(restored), order);
    assert.deepEqual(Object.keys(restored.properties), ["topic", "audience", "length", "notes"]);
    // Same schema, by value.
    assert.deepEqual(restored, FORM);
  });

  it("survives being written out and read again", () => {
    const restored = withSchemaOrder(stored(FORM), schemaOrderOf(FORM));
    const again = JSON.parse(JSON.stringify(restored));
    assert.deepEqual(schemaOrderOf(again), ["topic", "audience", "length", "notes"]);
  });

  it("keeps keys the order does not name after it, in the order they had", () => {
    const result = withSchemaOrder(FORM, ["notes", "audience"]);
    assert.deepEqual(schemaOrderOf(result), ["notes", "audience", "topic", "length"]);
  });

  it("ignores keys the schema does not have, and a key named twice", () => {
    const result = withSchemaOrder(FORM, ["gone", "length", "topic", "length", "also-gone"]);
    assert.deepEqual(schemaOrderOf(result), ["length", "topic", "audience", "notes"]);
    assert.equal(Object.keys(result.properties).length, 4);
    assert.equal("gone" in result.properties, false);
  });

  it("ignores names that are only inherited, and keeps a question keyed __proto__", () => {
    const schema = JSON.parse(
      '{"type":"object","properties":{"a":{"type":"string"},"__proto__":{"type":"number"}}}',
    );
    const result = withSchemaOrder(schema, ["toString", "constructor", "__proto__", "a"]);
    assert.deepEqual(Object.keys(result.properties), ["__proto__", "a"]);
    assert.deepEqual(
      Object.getOwnPropertyDescriptor(result.properties, "__proto__")?.value,
      { type: "number" },
    );
    assert.equal(Object.getPrototypeOf(result.properties), Object.prototype);
  });

  it("leaves the order alone when no order was recorded", () => {
    const shuffled = stored(FORM);
    const result = withSchemaOrder(shuffled, []);
    assert.deepEqual(schemaOrderOf(result), schemaOrderOf(shuffled));
    assert.deepEqual(result, shuffled);
  });

  it("returns anything that is not an object schema untouched", () => {
    const list = [FORM];
    const noProperties = { type: "string", maxLength: 5 };
    const badProperties = { type: "object", properties: ["a", "b"] };
    for (const value of [undefined, null, "object", 7, false, list, noProperties, badProperties]) {
      assert.equal(withSchemaOrder(value, ["a", "b"]), value);
    }
    assert.deepEqual(noProperties, { type: "string", maxLength: 5 });
  });

  it("changes nothing but the order of properties", () => {
    const schema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      title: "Brief",
      required: ["b", "a", "missing"],
      properties: {
        a: { type: "object", properties: { z: { type: "string" }, y: { type: "string" } } },
        b: { type: "array", items: { type: "string" }, maxItems: 3 },
        c: { type: "string" },
      },
      additionalProperties: false,
      minProperties: 1,
    };
    const result = withSchemaOrder(schema, ["c", "b", "a"]);

    assert.deepEqual(Object.keys(result.properties), ["c", "b", "a"]);
    // Every keyword is in the place it had.
    assert.deepEqual(Object.keys(result), Object.keys(schema));
    // required is the same list, in the same order: it is not a question order.
    assert.equal(result.required, schema.required);
    assert.deepEqual(result.required, ["b", "a", "missing"]);
    // Each question's own schema is the same value; a nested form is not reordered.
    assert.equal(result.properties.a, schema.properties.a);
    assert.equal(result.properties.b, schema.properties.b);
    assert.deepEqual(Object.keys(result.properties.a.properties), ["z", "y"]);
    for (const keyword of Object.keys(schema) as Array<keyof typeof schema>) {
      if (keyword === "properties") continue;
      assert.equal(result[keyword], schema[keyword]);
    }
    assert.deepEqual(result, schema);
  });

  it("never modifies the schema it was given", () => {
    const schema = stored(FORM) as typeof FORM;
    const before = JSON.stringify(schema);
    const result = withSchemaOrder(schema, ["notes", "topic"]);
    assert.notEqual(result, schema);
    assert.notEqual(result.properties, schema.properties);
    assert.equal(JSON.stringify(schema), before);
  });

  it("cannot move keys that are whole numbers: JavaScript lists them first", () => {
    const schema = { type: "object", properties: { name: { type: "string" }, "2": {}, "1": {} } };
    assert.deepEqual(schemaOrderOf(schema), ["1", "2", "name"]);
    const result = withSchemaOrder(schema, ["name", "2", "1"]);
    assert.deepEqual(schemaOrderOf(result), ["1", "2", "name"]);
  });
});
