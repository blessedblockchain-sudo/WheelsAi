import assert from "node:assert/strict";
import test from "node:test";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}
setupEnv();

// Drives apps/api/src/services/embeddings.ts (W2 RAG) — the
// OpenAI-compatible embeddings client. The dangerous failure here is
// SILENT mis-pairing: a vector attached to the wrong chunk looks fine
// until search quality dies, so ordering and length are checked hard.

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const BASE = {
  baseUrl: "https://api.example.com/v1",
  apiKey: "k",
  model: "text-embedding-3-small",
};

test("vectors come back in input order and dimensions are reported", async () => {
  const { createEmbeddings } = await import("../services/embeddings.js");
  const res = await createEmbeddings({
    ...BASE,
    input: ["a", "b"],
    fetchImpl: (async () =>
      jsonResponse({
        data: [
          { index: 0, embedding: [1, 0, 0] },
          { index: 1, embedding: [0, 1, 0] },
        ],
        model: "text-embedding-3-small",
      })) as unknown as typeof fetch,
  });
  assert.deepEqual(res.vectors, [
    [1, 0, 0],
    [0, 1, 0],
  ]);
  assert.equal(res.dimensions, 3);
});

test("out-of-order provider responses are re-sorted by index", async () => {
  const { createEmbeddings } = await import("../services/embeddings.js");
  const res = await createEmbeddings({
    ...BASE,
    input: ["first", "second"],
    fetchImpl: (async () =>
      jsonResponse({
        data: [
          { index: 1, embedding: [0, 1] },
          { index: 0, embedding: [1, 0] },
        ],
      })) as unknown as typeof fetch,
  });
  assert.deepEqual(
    res.vectors,
    [
      [1, 0],
      [0, 1],
    ],
    "index 0's vector must pair with the first input",
  );
});

test("a short response is a hard error, never a partial pairing", async () => {
  const { createEmbeddings } = await import("../services/embeddings.js");
  await assert.rejects(
    createEmbeddings({
      ...BASE,
      input: ["a", "b", "c"],
      fetchImpl: (async () =>
        jsonResponse({ data: [{ index: 0, embedding: [1] }] })) as unknown as typeof fetch,
    }),
    /length mismatch/,
  );
});

test("mixed dimensions in one response are refused", async () => {
  const { createEmbeddings } = await import("../services/embeddings.js");
  await assert.rejects(
    createEmbeddings({
      ...BASE,
      input: ["a", "b"],
      fetchImpl: (async () =>
        jsonResponse({
          data: [
            { index: 0, embedding: [1, 0, 0] },
            { index: 1, embedding: [0, 1] },
          ],
        })) as unknown as typeof fetch,
    }),
    /mixed dimensions/,
  );
});

test("a provider error surfaces its status and body", async () => {
  const { createEmbeddings } = await import("../services/embeddings.js");
  await assert.rejects(
    createEmbeddings({
      ...BASE,
      input: ["a"],
      fetchImpl: (async () =>
        new Response("model_not_found", { status: 404 })) as unknown as typeof fetch,
    }),
    /404.*model_not_found/s,
  );
});

test("an empty input list short-circuits without a request", async () => {
  const { createEmbeddings } = await import("../services/embeddings.js");
  let called = 0;
  const res = await createEmbeddings({
    ...BASE,
    input: [],
    fetchImpl: (async () => {
      called += 1;
      return jsonResponse({ data: [] });
    }) as unknown as typeof fetch,
  });
  assert.equal(called, 0);
  assert.deepEqual(res.vectors, []);
});

// ============================================
// pgvector literal formatting
// ============================================

test("toVectorLiteral formats a pgvector literal", async () => {
  const { toVectorLiteral } = await import("../services/embeddings.js");
  assert.equal(toVectorLiteral([1, 0.5, -0.25]), "[1,0.5,-0.25]");
});

test("toVectorLiteral refuses non-finite values rather than emitting NaN", async () => {
  const { toVectorLiteral } = await import("../services/embeddings.js");
  assert.throws(() => toVectorLiteral([1, Number.NaN]), /non-finite/);
  assert.throws(() => toVectorLiteral([Number.POSITIVE_INFINITY]), /non-finite/);
  assert.throws(() => toVectorLiteral([]), /empty vector/);
});

// ============================================
// Provider config + boot gates
// ============================================

test("groq is refused BY NAME — it has no embeddings endpoint", async () => {
  const { validateEnv, EnvValidationError } = await import("../config/env.js");
  assert.throws(
    () =>
      validateEnv({
        NODE_ENV: "development",
        DATABASE_URL: "postgresql://u:p@db:5432/app",
        JWT_SECRET: "a".repeat(32),
        EMBEDDING_PROVIDER: "groq",
        GROQ_API_KEY: "gsk_x",
        EMBEDDING_MODEL: "whatever",
      }),
    (err: unknown) =>
      err instanceof EnvValidationError && /no \/embeddings endpoint/.test(err.message),
  );
});

test("a configured provider demands its key AND an explicit model", async () => {
  const { validateEnv, EnvValidationError } = await import("../config/env.js");
  const base = {
    NODE_ENV: "development",
    DATABASE_URL: "postgresql://u:p@db:5432/app",
    JWT_SECRET: "a".repeat(32),
  };
  // Missing key.
  assert.throws(
    () => validateEnv({ ...base, EMBEDDING_PROVIDER: "openai", EMBEDDING_MODEL: "m" }),
    EnvValidationError,
  );
  // Missing model — never guessed, since its dimensions define every
  // stored vector.
  assert.throws(
    () => validateEnv({ ...base, EMBEDDING_PROVIDER: "openai", OPENAI_API_KEY: "k" }),
    EnvValidationError,
  );
  // Fully specified.
  assert.doesNotThrow(() =>
    validateEnv({
      ...base,
      EMBEDDING_PROVIDER: "openai",
      OPENAI_API_KEY: "k",
      EMBEDDING_MODEL: "text-embedding-3-small",
    }),
  );
});

test("an unknown provider is named in the error", async () => {
  const { validateEnv, EnvValidationError } = await import("../config/env.js");
  assert.throws(
    () =>
      validateEnv({
        NODE_ENV: "development",
        DATABASE_URL: "postgresql://u:p@db:5432/app",
        JWT_SECRET: "a".repeat(32),
        EMBEDDING_PROVIDER: "cohere",
      }),
    (err: unknown) =>
      err instanceof EnvValidationError && /cohere/.test(err.message),
  );
});

test("no provider configured is a legal state (semantic search simply off)", async () => {
  const { validateEnv } = await import("../config/env.js");
  assert.doesNotThrow(() =>
    validateEnv({
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://u:p@db:5432/app",
      JWT_SECRET: "a".repeat(32),
    }),
  );
});
