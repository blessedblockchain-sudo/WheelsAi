import assert from "node:assert/strict";
import test from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
}

// Drives apps/api/src/lib/errorHandler.ts — the global Fastify error
// handler (remediation F1). ~14 route files validate with a bare
// schema.parse(), which throws ZodError; the handler must surface that as
// a 400, not a 500, while still hiding genuine internal-error messages.

async function appThrowing(
  thrower: (request: import("fastify").FastifyRequest) => void,
): Promise<FastifyInstance> {
  setupEnv();
  const { globalErrorHandler } = await import("../lib/errorHandler.js");
  const app = Fastify();
  app.setErrorHandler(globalErrorHandler);
  app.post("/t", async (request) => {
    thrower(request);
    return { ok: true };
  });
  await app.ready();
  return app;
}

test("ZodError from a bare .parse() becomes 400 validation_failed with flattened details", async () => {
  const app = await appThrowing((request) => {
    z.object({ name: z.string() }).parse(request.body);
  });
  const res = await app.inject({
    method: "POST",
    url: "/t",
    payload: { name: 123 }, // wrong type → ZodError
  });
  assert.equal(res.statusCode, 400);
  const body = res.json();
  assert.equal(body.error, "validation_failed");
  assert.ok(
    body.details?.fieldErrors?.name,
    "flattened field errors should name the offending field",
  );
  await app.close();
});

test("a generic thrown Error maps to 500 and never leaks the internal message", async () => {
  const app = await appThrowing(() => {
    throw new Error("secret connection string in here");
  });
  const res = await app.inject({ method: "POST", url: "/t", payload: {} });
  assert.equal(res.statusCode, 500);
  const body = res.json();
  assert.equal(body.error, "InternalError");
  assert.equal(body.message, "Internal Server Error");
  assert.ok(
    !JSON.stringify(body).includes("secret connection string"),
    "internal error message must not be sent to the client",
  );
  await app.close();
});

test("an error carrying a statusCode passes through with its name and message", async () => {
  const app = await appThrowing(() => {
    const e = new Error("I'm a teapot") as Error & {
      statusCode?: number;
    };
    e.statusCode = 418;
    e.name = "TeapotError";
    throw e;
  });
  const res = await app.inject({ method: "POST", url: "/t", payload: {} });
  assert.equal(res.statusCode, 418);
  const body = res.json();
  assert.equal(body.error, "TeapotError");
  assert.equal(body.message, "I'm a teapot");
  await app.close();
});

// A validation failure also carries `message` (one plain sentence) and
// `fields` (field name to plain sentence). `error` and `details` stay as they
// were, so a client that reads them does not break.

test("a validation failure carries message and fields beside the unchanged error and details", async () => {
  const schema = z.object({ name: z.string().min(3), replicas: z.number().int().max(5) });
  const app = await appThrowing((request) => {
    schema.parse(request.body);
  });
  const payload = { name: "ab", replicas: 9 };
  const res = await app.inject({ method: "POST", url: "/t", payload });
  assert.equal(res.statusCode, 400);
  const body = res.json();
  assert.deepEqual(Object.keys(body).sort(), ["details", "error", "fields", "message"]);
  assert.equal(body.error, "validation_failed");
  assert.deepEqual(body.fields, {
    name: '"name" must be at least 3 characters.',
    replicas: '"replicas" must be 5 or less.',
  });
  assert.equal(body.message, '"name" must be at least 3 characters.', "the first problem");
  // Exactly what the handler sent before this change.
  const before = schema.safeParse(payload);
  assert.ok(!before.success);
  assert.deepEqual(body.details, JSON.parse(JSON.stringify(before.error.flatten())));
  await app.close();
});

test("only a field that was left out is called required", async () => {
  const schema = z.object({ name: z.string(), description: z.string().optional(), replicas: z.number().optional() });
  const app = await appThrowing((request) => {
    schema.parse(request.body);
  });
  const res = await app.inject({ method: "POST", url: "/t", payload: { description: null, replicas: null } });
  assert.deepEqual(res.json().fields, {
    name: '"name" is required.',
    description: '"description" must be text.',
    replicas: '"replicas" must be a number.',
  });
  await app.close();
});

test("a sentence the route wrote itself is passed through as it is", async () => {
  const app = await appThrowing((request) => {
    z.object({ name: z.string().min(3, "Give your agent a name of at least 3 characters.") }).parse(request.body);
  });
  const res = await app.inject({ method: "POST", url: "/t", payload: { name: "ab" } });
  assert.equal(res.json().message, "Give your agent a name of at least 3 characters.");
  assert.deepEqual(res.json().fields, { name: "Give your agent a name of at least 3 characters." });
  await app.close();
});

test("nested fields are named by their path, and a body that is not an object is one plain sentence", async () => {
  const schema = z.object({
    tools: z.array(z.object({ type: z.enum(["function", "api"]) })),
    modelConfig: z.object({ temperature: z.number().min(0) }),
    agentId: z.string().uuid(),
  });
  const app = await appThrowing((request) => {
    schema.parse(request.body);
  });
  const res = await app.inject({
    method: "POST",
    url: "/t",
    payload: { tools: [{ type: "function" }, { type: "magic" }], modelConfig: { temperature: "hot" } },
  });
  assert.deepEqual(res.json().fields, {
    "tools[1].type": '"tools[1].type" must be one of: function, api.',
    "modelConfig.temperature": '"modelConfig.temperature" must be a number.',
    agentId: '"agentId" is required.',
  });

  const list = await app.inject({ method: "POST", url: "/t", payload: ["not", "an", "object"] });
  assert.equal(list.statusCode, 400);
  assert.equal(list.json().message, "Send the request as a JSON object.");
  assert.deepEqual(list.json().fields, { body: "Send the request as a JSON object." });
  await app.close();
});

test("no sentence carries zod's own wording, whatever the kind of problem", async () => {
  const { plainIssue, validationFailure, validationFailureFromFields, fieldPath } = await import(
    "../lib/validationFailure.js"
  );
  const schema = z
    .object({
      text: z.string(),
      short: z.string().min(1),
      long: z.string().max(5),
      exact: z.string().length(4),
      email: z.string().email(),
      link: z.string().url(),
      id: z.string().uuid(),
      pattern: z.string().regex(/^[a-z]+$/),
      whole: z.number().int(),
      positive: z.number().positive(),
      below: z.number().lt(10),
      step: z.number().multipleOf(5),
      flag: z.boolean(),
      list: z.array(z.string()).min(1).max(2),
      many: z.array(z.string()).max(1),
      choice: z.enum(["a", "b"]),
      literal: z.literal("yes"),
      either: z.union([z.string(), z.number()]),
      when: z.coerce.date(),
      nested: z.object({ inner: z.string() }),
      refined: z.string().refine((value) => value === "ok"),
      explained: z.string().refine((value) => value === "ok", "Type ok to continue."),
    })
    .strict();
  const result = schema.safeParse({
    text: 1,
    short: "",
    long: "too long",
    exact: "abc",
    email: "nope",
    link: "nope",
    id: "nope",
    pattern: "ABC",
    whole: 1.5,
    positive: 0,
    below: 10,
    step: 7,
    flag: "yes",
    list: [],
    many: ["a", "b"],
    choice: "c",
    literal: "no",
    either: true,
    when: "not a date",
    nested: "flat",
    refined: "no",
    explained: "no",
    extra: 1,
  });
  assert.ok(!result.success);
  const failure = validationFailure(result.error);

  assert.deepEqual(failure.fields, {
    text: '"text" must be text.',
    short: '"short" cannot be empty.',
    long: '"long" must be at most 5 characters.',
    exact: '"exact" must be exactly 4 characters.',
    email: '"email" must be a valid email address.',
    link: '"link" must be a valid link.',
    id: '"id" must be a valid id.',
    pattern: '"pattern" is not in the right format.',
    whole: '"whole" must be a whole number.',
    positive: '"positive" must be more than 0.',
    below: '"below" must be less than 10.',
    step: '"step" must be a multiple of 5.',
    flag: '"flag" must be true or false.',
    list: '"list" needs at least 1 item.',
    many: '"many" can have at most 1 item.',
    choice: '"choice" must be one of: a, b.',
    literal: '"literal" is not valid.',
    either: '"either" is not valid.',
    when: '"when" must be a valid date.',
    nested: '"nested" must be an object.',
    refined: '"refined" is not valid.',
    explained: "Type ok to continue.",
    body: '"extra" is not accepted here.',
  });
  for (const sentence of [failure.message, ...Object.values(failure.fields)]) {
    assert.doesNotMatch(sentence, /Invalid|Expected|Required|received|character\(s\)|element\(s\)|Unrecognized/);
    assert.match(sentence, /\.$/);
  }
  assert.equal(result.error.issues.map(plainIssue).length, result.error.issues.length);

  assert.equal(fieldPath(["a", 0, "b", 2]), "a[0].b[2]");
  assert.equal(fieldPath([]), "");

  // Problems a route found itself take the same shape.
  assert.deepEqual(validationFailureFromFields({ "kindConfig.task.fields[0].label": "Give this question a label.", agentKind: "Choose one." }), {
    error: "validation_failed",
    message: "Give this question a label.",
    fields: { "kindConfig.task.fields[0].label": "Give this question a label.", agentKind: "Choose one." },
    details: {
      formErrors: [],
      fieldErrors: { kindConfig: ["Give this question a label."], agentKind: ["Choose one."] },
    },
  });
  assert.equal(validationFailureFromFields({}).message, "Some of what was sent could not be accepted. Check it and try again.");
});

test("Fastify's own schema failures and plan limits are answered as before", async () => {
  setupEnv();
  const { globalErrorHandler } = await import("../lib/errorHandler.js");
  const { PlanLimitError } = await import("../services/plans.js");
  const app = Fastify();
  app.setErrorHandler(globalErrorHandler);
  app.post(
    "/schema",
    { schema: { body: { type: "object", required: ["name"], properties: { name: { type: "string" } } } } },
    async () => ({ ok: true }),
  );
  app.post("/limit", async () => {
    throw new PlanLimitError("The Starter plan includes up to 3 agents.", "starter", "maxAgents");
  });
  await app.ready();

  const schema = await app.inject({ method: "POST", url: "/schema", payload: {} });
  assert.equal(schema.statusCode, 400);
  assert.equal(schema.json().error, "Validation Error");
  assert.ok(Array.isArray(schema.json().details));

  const limit = await app.inject({ method: "POST", url: "/limit", payload: {} });
  assert.equal(limit.statusCode, 403);
  assert.deepEqual(limit.json(), {
    error: "plan_limit_reached",
    message: "The Starter plan includes up to 3 agents.",
    plan: "starter",
    limit: "maxAgents",
    upgradeUrl: "/dashboard/billing?upgrade=pro",
  });
  await app.close();
});
