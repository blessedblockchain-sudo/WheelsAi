import assert from "node:assert/strict";
import test from "node:test";

import {
  ajvVersion,
  compileUserSchema,
  createSchemaCompiler,
  JsonSchemaError,
  MAX_DATA_DEPTH,
  MAX_REFERENCE_FAN_OUT,
  MAX_SCHEMA_BYTES,
  MAX_SCHEMA_DEPTH,
  MAX_SUBSCHEMAS,
} from "../services/jsonSchema.js";

// A publisher's JSON Schema validates a buyer's input, and a deliverable's
// JSON, inside the API process. What these pin: it is real JSON Schema (the
// old "json_schema" assertion only looked for top-level keys), a `pattern`
// cannot stall the server, and the limits that keep compile and validation
// bounded are enforced.

const issuesOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof JsonSchemaError, String(err));
    return err.issues;
  }
  assert.fail("expected the schema to be refused");
};

test("the ajv that loads is version 8, not the 6.x the repository root hoists", () => {
  assert.equal(ajvVersion().split(".")[0], "8");
});

test("a draft-07 schema validates types, required, enum, nested objects and formats", () => {
  const schema = compileUserSchema({
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    required: ["url", "depth"],
    additionalProperties: false,
    properties: {
      url: { type: "string", format: "uri" },
      depth: { type: "integer", minimum: 1, maximum: 5 },
      tone: { enum: ["formal", "casual"] },
      contact: {
        type: "object",
        required: ["email"],
        properties: { email: { type: "string", format: "email" } },
      },
      tags: { type: "array", items: { type: "string" }, maxItems: 3 },
    },
  });
  assert.deepEqual(
    schema.validate({ url: "https://example.com", depth: 2, tone: "formal", contact: { email: "a@b.co" }, tags: ["x"] }),
    { valid: true },
  );
  const bad: Array<[unknown, string, RegExp]> = [
    [{ url: "https://example.com" }, "/depth", /is required/],
    [{ url: "https://example.com", depth: 9 }, "/depth", /<= 5/],
    [{ url: "https://example.com", depth: 1.5 }, "/depth", /integer/],
    [{ url: "not a url", depth: 1 }, "/url", /format/],
    [{ url: "https://example.com", depth: 1, tone: "rude" }, "/tone", /one of: "formal", "casual"/],
    [{ url: "https://example.com", depth: 1, contact: {} }, "/contact/email", /is required/],
    [{ url: "https://example.com", depth: 1, contact: { email: "nope" } }, "/contact/email", /format/],
    [{ url: "https://example.com", depth: 1, extra: true }, "", /must not have the property "extra"/],
    [{ url: "https://example.com", depth: 1, tags: ["a", "b", "c", "d"] }, "/tags", /more than 3/],
    ["a string", "", /object/],
  ];
  for (const [data, path, message] of bad) {
    const result = schema.validate(data);
    assert.equal(result.valid, false, JSON.stringify(data));
    if (!result.valid) {
      // One error: validation stops at the first failure.
      assert.equal(result.errors.length, 1);
      assert.equal(result.errors[0]!.path, path, JSON.stringify(data));
      assert.match(result.errors[0]!.message, message);
    }
  }
});

test("a draft 2020-12 schema is compiled as 2020-12", () => {
  const schema = compileUserSchema({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: { pair: { type: "array", prefixItems: [{ type: "string" }, { type: "number" }], items: false } },
    $defs: { unused: { type: "string" } },
  });
  assert.equal(schema.validate({ pair: ["a", 1] }).valid, true);
  assert.equal(schema.validate({ pair: ["a", "b"] }).valid, false);
  assert.equal(schema.validate({ pair: ["a", 1, 2] }).valid, false);
});

test("a ReDoS `pattern` validates in bounded time, on the linear-time engine", () => {
  const schema = compileUserSchema({
    type: "object",
    properties: { code: { type: "string", pattern: "^(a+)+$" } },
  });
  const start = performance.now();
  const result = schema.validate({ code: "a".repeat(30) + "!" });
  const ms = performance.now() - start;
  assert.equal(result.valid, false);
  assert.ok(ms < 100, `took ${ms.toFixed(1)}ms`);
  assert.equal(schema.validate({ code: "aaaa" }).valid, true);
});

test("two different patterns in one schema are both applied (ajv caches patterns by toString)", () => {
  const schema = compileUserSchema({
    type: "object",
    properties: {
      digits: { type: "string", pattern: "^[0-9]+$" },
      letters: { type: "string", pattern: "^[a-z]+$" },
    },
    patternProperties: { "^x-": { type: "number" } },
  });
  assert.equal(schema.validate({ digits: "123", letters: "abc", "x-rate": 2 }).valid, true);
  // With one shared compiled pattern, exactly one of these would wrongly pass.
  assert.equal(schema.validate({ digits: "abc", letters: "abc" }).valid, false);
  assert.equal(schema.validate({ digits: "123", letters: "123" }).valid, false);
  assert.equal(schema.validate({ digits: "1", letters: "a", "x-rate": "fast" }).valid, false);
});

test("a pattern the linear-time engine cannot express fails the compile with its reason", () => {
  const issues = issuesOf(() =>
    compileUserSchema({ type: "object", properties: { a: { type: "string", pattern: "(a)\\1" } } }),
  );
  assert.match(issues[0]!.message, /backreferences/);
});

test("the root must be a schema object, and an input schema must describe an object", () => {
  for (const notSchema of [null, true, "string", 4, [], [{ type: "object" }]]) {
    assert.match(issuesOf(() => compileUserSchema(notSchema))[0]!.message, /must be an object/);
  }
  assert.deepEqual(issuesOf(() => compileUserSchema({ type: "string" }, { root: "object" })), [
    { path: "/type", message: 'the schema\'s root must have "type": "object"' },
  ]);
  assert.match(issuesOf(() => compileUserSchema({}, { root: "object" }))[0]!.message, /"type": "object"/);
  // A deliverable check may describe any JSON value.
  assert.equal(compileUserSchema({ type: "array", items: { type: "number" } }).validate([1, 2]).valid, true);
});

test("oversize and too-deep schemas are refused, without overflowing the stack", () => {
  const big = { type: "object", description: "x".repeat(MAX_SCHEMA_BYTES) };
  assert.match(issuesOf(() => compileUserSchema(big))[0]!.message, /larger than 32 KB/);

  const nest = (levels: number) => {
    let schema: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < levels; i++) schema = { type: "object", properties: { a: schema } };
    return schema;
  };
  assert.doesNotThrow(() => compileUserSchema(nest(MAX_SCHEMA_DEPTH - 1)));
  assert.match(issuesOf(() => compileUserSchema(nest(MAX_SCHEMA_DEPTH + 1)))[0]!.message, /nests deeper than 16/);

  // Compiling is quadratic in the number of subschemas: the 2,000 that fit
  // in 32 KB took one to two seconds.
  const flat = (count: number) => ({ allOf: Array.from({ length: count }, () => ({ minimum: 1 })) });
  assert.doesNotThrow(() => compileUserSchema(flat(MAX_SUBSCHEMAS - 1)));
  const start = performance.now();
  assert.match(issuesOf(() => compileUserSchema(flat(2000)))[0]!.message, /more than 500 subschemas/);
  // The same square law without one subschema object: boolean schemas, and
  // the names of a dependency list (3.5 seconds at 2,500 names, unfixed).
  const names = Array.from({ length: 2500 }, (_, i) => `q${i}`);
  for (const wide of [
    { dependencies: { x: names } },
    { $schema: "https://json-schema.org/draft/2020-12/schema", dependentRequired: { x: names } },
    { oneOf: names.map(() => false) },
    { type: "object", patternProperties: Object.fromEntries(names.slice(0, 1500).map((name) => [`^${name}`, true])) },
  ]) {
    assert.match(issuesOf(() => compileUserSchema(wide))[0]!.message, /more than 500 subschemas/);
  }
  assert.ok(performance.now() - start < 200, `took ${(performance.now() - start).toFixed(0)}ms`);
  // What is only data stays unlimited inside the size cap: enum members, required names.
  const many = names.slice(0, 1500);
  assert.doesNotThrow(() => compileUserSchema({ type: "object", required: many, properties: { kind: { enum: many } } }));
});

test("schemas that are unsafe to run on untrusted data are refused", () => {
  // Quadratic deep comparison with no bound on the array.
  const unique = issuesOf(() =>
    compileUserSchema({ type: "array", uniqueItems: true, items: { type: "object" } }),
  );
  assert.equal(unique[0]!.path, "/uniqueItems");
  assert.match(unique[0]!.message, /maxItems/);
  assert.doesNotThrow(() =>
    compileUserSchema({ type: "array", uniqueItems: true, maxItems: 50, items: { type: "object" } }),
  );
  assert.doesNotThrow(() => compileUserSchema({ type: "array", uniqueItems: true, items: { type: "string" } }));

  // Nothing outside the schema is ever resolved or fetched.
  for (const ref of ["https://example.com/schema.json", "other.json#/definitions/a", "urn:x"]) {
    const issues = issuesOf(() => compileUserSchema({ type: "object", properties: { a: { $ref: ref } } }));
    assert.equal(issues[0]!.path, "/properties/a/$ref");
    assert.match(issues[0]!.message, /nothing is fetched/);
  }
  const local = compileUserSchema({
    type: "object",
    properties: { a: { $ref: "#/definitions/name" } },
    definitions: { name: { type: "string", minLength: 2 } },
  });
  assert.equal(local.validate({ a: "ok" }).valid, true);
  assert.equal(local.validate({ a: "x" }).valid, false);

  // A typo must not silently validate nothing; nor an unknown format.
  assert.match(issuesOf(() => compileUserSchema({ type: "object", requried: ["a"] }))[0]!.message, /requried/);
  assert.match(
    issuesOf(() => compileUserSchema({ type: "string", format: "regex" }))[0]!.message,
    /unknown format "regex"/,
  );
  assert.match(issuesOf(() => compileUserSchema({ type: "strnig" }))[0]!.message, /type/);
});

test("a property literally named like a keyword is data, not a schema to police", () => {
  const schema = compileUserSchema({
    type: "object",
    properties: { $ref: { type: "string" }, uniqueItems: { type: "boolean" }, enum: { type: "string" } },
    required: ["$ref"],
    enum: [{ $ref: "https://example.com", uniqueItems: true }],
  });
  assert.equal(schema.validate({ $ref: "https://example.com", uniqueItems: true }).valid, true);
});

test("data nested too deeply is refused before the validator recurses into it", () => {
  const schema = compileUserSchema({ $ref: "#/definitions/node", definitions: { node: { type: "array", items: { $ref: "#/definitions/node" } } } });
  let ok: unknown = [];
  for (let i = 0; i < MAX_DATA_DEPTH - 1; i++) ok = [ok];
  assert.equal(schema.validate(ok).valid, true);
  let deep: unknown = [];
  for (let i = 0; i < 50_000; i++) deep = [deep];
  const result = schema.validate(deep);
  assert.equal(result.valid, false);
  if (!result.valid) assert.match(result.errors[0]!.message, /nested deeper than 64/);
});

test("the compiled-validator cache is bounded, and evicted schemas still validate when seen again", () => {
  const compiler = createSchemaCompiler({ maxEntries: 3 });
  const schemaFor = (n: number) => ({ type: "object", properties: { n: { const: n } }, required: ["n"] });
  for (let n = 0; n < 10; n++) {
    assert.equal(compiler.compile(schemaFor(n)).validate({ n }).valid, true);
    assert.ok(compiler.size() <= 3);
  }
  assert.equal(compiler.size(), 3);
  // Same schema, different object: one entry.
  compiler.compile(schemaFor(9));
  compiler.compile(JSON.parse(JSON.stringify(schemaFor(9))));
  assert.equal(compiler.size(), 3);
  // Evicted long ago; compiles and validates again.
  const again = compiler.compile(schemaFor(0));
  assert.equal(again.validate({ n: 0 }).valid, true);
  assert.equal(again.validate({ n: 1 }).valid, false);
  // A schema that fails to compile is not cached.
  assert.throws(() => compiler.compile({ type: "nope" }), JsonSchemaError);
  assert.equal(compiler.size(), 3);
});

test("a schema with an $id can be compiled by two organizations without colliding", () => {
  const compiler = createSchemaCompiler({ maxEntries: 5 });
  const a = compiler.compile({ $id: "https://example.com/input.json", type: "object", required: ["a"] });
  const b = compiler.compile({ $id: "https://example.com/input.json", type: "object", required: ["b"] });
  assert.equal(a.validate({ a: 1 }).valid, true);
  assert.equal(b.validate({ a: 1 }).valid, false);
});

// ---------------------------------------------------------------------------
// One validation has a total work budget. Before it, only each single regex
// match was bounded, and these schemas (both a few kilobytes, both accepted)
// blocked the event loop for seconds to days.
// ---------------------------------------------------------------------------

const timed = <T>(fn: () => T): { value: T; ms: number } => {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
};

/** A chain of definitions, each applying the next one twice: 2^n evaluations of `{}`. */
const fanOut = (n: number, keyword: "allOf" | "anyOf" = "allOf") => {
  const definitions: Record<string, unknown> = {};
  for (let i = 0; i < n; i++) {
    definitions[`a${i}`] = { [keyword]: [{ $ref: `#/definitions/a${i + 1}` }, { $ref: `#/definitions/a${i + 1}` }] };
  }
  definitions[`a${n}`] = { type: "object" };
  return { type: "object", allOf: [{ $ref: "#/definitions/a0" }], definitions };
};

test("references that fan out exponentially are refused when the schema is compiled", () => {
  // 2^28 evaluations of {}: about two seconds unfixed, doubling with each step.
  const { value: issues, ms } = timed(() => issuesOf(() => compileUserSchema(fanOut(28), { root: "object" })));
  assert.match(issues[0]!.message, /schema evaluations/);
  assert.match(issues[0]!.message, new RegExp(MAX_REFERENCE_FAN_OUT.toLocaleString("en-US")));
  assert.ok(ms < 500, `took ${ms.toFixed(0)}ms`);
  // The size the review measured at "about ten days".
  assert.match(issuesOf(() => compileUserSchema(fanOut(45, "anyOf")))[0]!.message, /schema evaluations/);

  // A loop that never moves into the data would recurse until the stack ran out.
  const loop = issuesOf(() => compileUserSchema({ allOf: [{ $ref: "#/definitions/a" }], definitions: { a: { not: { $ref: "#" } } } }));
  assert.match(loop[0]!.message, /loop/);

  // Sharing a definition is not fan-out, and a tree is not a loop.
  const shared = compileUserSchema(fanOut(8), { root: "object" });
  assert.deepEqual(shared.validate({}), { valid: true });
  const tree = compileUserSchema({
    $ref: "#/definitions/node",
    definitions: {
      node: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" }, children: { type: "array", items: { $ref: "#/definitions/node" } } },
      },
    },
  });
  assert.deepEqual(tree.validate({ name: "a", children: [{ name: "b", children: [{ name: "c" }] }] }), { valid: true });
  assert.equal(tree.validate({ name: "a", children: [{ children: [] }] }).valid, false);
});

test("fan-out that only the data unlocks is stopped by the validation's work budget", () => {
  // Each level of the document doubles the evaluations: 2^30 for this one.
  for (const keyword of ["allOf", "anyOf"] as const) {
    const schema = compileUserSchema({
      $ref: "#/definitions/a",
      definitions: {
        a: {
          type: "object",
          properties: { x: { [keyword]: [{ $ref: "#/definitions/a" }, { $ref: "#/definitions/a" }] } },
        },
      },
    });
    // With anyOf every evaluation FAILS (the leaf is not an object), so this
    // also pins that work is charged before a subschema can fail.
    let data: unknown = keyword === "anyOf" ? "leaf" : {};
    for (let i = 0; i < 30; i++) data = { x: data };
    const { value: result, ms } = timed(() => schema.validate(data));
    assert.equal(result.valid, false);
    assert.equal(!result.valid && result.code, "validation_too_expensive", keyword);
    assert.ok(ms < 500, `${keyword} took ${ms.toFixed(0)}ms`);
    // The same schema on a small document is simply validated.
    assert.deepEqual(schema.validate({ x: { x: {} } }), { valid: true });
    assert.equal(schema.validate({ x: { x: "leaf" } }).valid, false);
    assert.equal(schema.validate({ x: { x: "leaf" } }).code, undefined);
  }
});

test("many near-limit patterns that all match cannot add up: a validation's matching has one budget", () => {
  const heavy = (count: number) => ({
    type: "object",
    properties: {
      xs: {
        type: "array",
        items: { type: "string", allOf: Array.from({ length: count }, (_, i) => ({ pattern: `[a-z]{${1000 - i}}$` })) },
      },
    },
  });
  const strings = (count: number) => ({ xs: Array.from({ length: count }, () => "a".repeat(1990)) });

  // The review's schema (40 patterns, 1.1 KB) is refused outright: its
  // patterns compile to more instructions than one schema may carry.
  assert.match(issuesOf(() => compileUserSchema(heavy(40)))[0]!.message, /patterns/);

  // Five of them compile. Each match is just inside the per-match limit, so
  // 5 patterns x 4 strings ran every match: over a second, unfixed.
  const schema = compileUserSchema(heavy(5));
  const { value: result, ms } = timed(() => schema.validate(strings(4)));
  assert.equal(result.valid, false);
  assert.equal(!result.valid && result.code, "validation_too_expensive");
  assert.ok(ms < 500, `took ${ms.toFixed(0)}ms`);
  // patternProperties draw on the same budget.
  const keyed = compileUserSchema({
    type: "object",
    patternProperties: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`[a-z]{${1000 - i}}$`, {}])),
  });
  const wide = Object.fromEntries(Array.from({ length: 4 }, (_, i) => ["a".repeat(1986) + i, 1]));
  assert.equal(keyed.validate(wide).code, "validation_too_expensive");

  // An ordinary pattern on ordinary data is nowhere near it.
  const plain = compileUserSchema({ type: "array", items: { type: "string", pattern: "^[A-Z]{2}-[0-9]{4}$" } });
  assert.deepEqual(plain.validate(Array.from({ length: 2000 }, (_, i) => `AB-${1000 + i}`)), { valid: true });
});

test("work that is quadratic or multiplies schema size by data size is charged for what it costs", () => {
  // uniqueItems without scalar item types compares every pair.
  const unique = compileUserSchema({ type: "array", uniqueItems: true, maxItems: 1_000_000 });
  assert.deepEqual(unique.validate(Array.from({ length: 300 }, (_, i) => [i])), { valid: true });
  const { value: many, ms } = timed(() => unique.validate(Array.from({ length: 30_000 }, (_, i) => i)));
  assert.equal(many.code, "validation_too_expensive");
  assert.ok(ms < 500, `took ${ms.toFixed(0)}ms`);
  // With scalar items it is one pass, and stays allowed.
  const scalars = compileUserSchema({ type: "array", uniqueItems: true, items: { type: "integer" } });
  assert.deepEqual(scalars.validate(Array.from({ length: 30_000 }, (_, i) => i)), { valid: true });

  // Four hundred subschemas applied to each of fifty thousand items.
  const wide = compileUserSchema({
    type: "array",
    items: { allOf: Array.from({ length: 400 }, (_, i) => ({ minimum: -i })) },
  });
  const { value: result, ms: wideMs } = timed(() => wide.validate(Array.from({ length: 50_000 }, () => 1)));
  assert.equal(result.code, "validation_too_expensive");
  assert.ok(wideMs < 500, `took ${wideMs.toFixed(0)}ms`);
});

test("the largest documents the API accepts still validate against an ordinary schema", () => {
  const schema = compileUserSchema({
    type: "object",
    required: ["rows"],
    properties: {
      rows: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "label"],
          additionalProperties: false,
          properties: { id: { type: "integer" }, label: { type: "string", maxLength: 40 }, tags: { type: "array", items: { type: "string" } } },
        },
      },
    },
  });
  // About 500 KB of JSON: the size cap on a deliverable.
  const rows = Array.from({ length: 9000 }, (_, id) => ({ id, label: `row number ${id}`, tags: ["alpha", "beta"] }));
  assert.ok(JSON.stringify({ rows }).length > 480_000);
  assert.deepEqual(schema.validate({ rows }), { valid: true });
  assert.deepEqual(compileUserSchema({ type: "array", items: { type: "number" } }).validate(Array.from({ length: 250_000 }, () => 1)), { valid: true });

  // A wide record: thirty fields, all required, nothing else allowed, a thousand rows.
  const fields = Array.from({ length: 30 }, (_, i) => `field_${i}`);
  const wide = compileUserSchema({
    type: "array",
    items: {
      type: "object",
      required: fields,
      additionalProperties: false,
      properties: Object.fromEntries(fields.map((name) => [name, { type: "string", minLength: 1 }])),
    },
  });
  const record = Object.fromEntries(fields.map((name) => [name, "value"]));
  assert.deepEqual(wide.validate(Array.from({ length: 1000 }, () => record)), { valid: true });
  assert.equal(wide.validate([{ ...record, extra: 1 }]).valid, false);
});

test("the name the work meter rides under is not a keyword a publisher can write", () => {
  for (const schema of [
    { type: "object", "x-wheelsai-work": [0, 0] },
    { type: "object", properties: { a: { "x-wheelsai-work": [0, 0] } } },
  ]) {
    assert.match(issuesOf(() => compileUserSchema(schema))[0]!.message, /x-wheelsai-work/);
  }
  // As a property NAME it is data like any other.
  const named = compileUserSchema({ type: "object", properties: { "x-wheelsai-work": { type: "number" } } });
  assert.equal(named.validate({ "x-wheelsai-work": 1 }).valid, true);
  assert.equal(named.validate({ "x-wheelsai-work": "no" }).valid, false);
});

test("a reference may only name a schema inside this document", () => {
  // Into data (an enum member, a default): nothing there is a schema to meter.
  for (const ref of ["#/enum/0", "#/default", "#/definitions/missing"]) {
    const issues = issuesOf(() =>
      compileUserSchema({ enum: [{ allOf: [] }, 1], default: {}, properties: { a: { $ref: ref } } }),
    );
    assert.equal(issues[0]!.path, "/properties/a/$ref", ref);
  }
  // A nested $id would move where "#/..." points.
  assert.match(
    issuesOf(() => compileUserSchema({ definitions: { a: { $id: "https://example.com/a.json", type: "string" } } }))[0]!.message,
    /\$id/,
  );
  // Escaped names resolve.
  const escaped = compileUserSchema({
    properties: { a: { $ref: "#/definitions/a~1b" }, c: { $ref: "#/definitions/sp%20ace" } },
    definitions: { "a/b": { type: "string" }, "sp ace": { type: "number" } },
  });
  assert.deepEqual(escaped.validate({ a: "x", c: 1 }), { valid: true });
  assert.equal(escaped.validate({ a: 1 }).valid, false);
  assert.equal(escaped.validate({ c: "x" }).valid, false);
});
