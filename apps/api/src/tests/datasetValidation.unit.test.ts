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

// Drives the pure validators in apps/api/src/services/dataset.ts —
// previously zero-tested despite gating every training-dataset upload
// (W0-5). These are the format/row checks; the S3 IO around them is
// exercised separately and refuses honestly when storage is
// unconfigured (isDatasetStorageConfigured).

import type {
  ValidationError,
  ValidationWarning,
} from "../services/dataset.js";

const fresh = () => ({
  errors: [] as ValidationError[],
  warnings: [] as ValidationWarning[],
});

// ============================================
// detectFormat
// ============================================

test("detectFormat: table", async () => {
  setupEnv();
  const { detectFormat } = await import("../services/dataset.js");

  const cases: Array<{ row: Record<string, unknown>; expected: string; why: string }> = [
    { row: { instruction: "sum", input: "1+1", output: "2" }, expected: "alpaca", why: "instruction+output" },
    { row: { instruction: "sum", output: "2" }, expected: "alpaca", why: "input optional" },
    { row: { conversations: [{ from: "human", value: "hi" }] }, expected: "sharegpt", why: "conversations array" },
    { row: { conversations: "not-an-array" }, expected: "unknown", why: "conversations must be an array" },
    { row: { prompt: "p", completion: "c" }, expected: "completion", why: "prompt+completion" },
    { row: { text: "raw corpus line" }, expected: "text", why: "bare text" },
    { row: { foo: "bar" }, expected: "unknown", why: "nothing recognizable" },
    // Precedence: alpaca keys win over text when both present.
    { row: { instruction: "i", output: "o", text: "t" }, expected: "alpaca", why: "alpaca outranks text" },
  ];
  for (const c of cases) {
    assert.equal(detectFormat(c.row), c.expected, c.why);
  }
});

// ============================================
// validateJsonl
// ============================================

test("validateJsonl: valid alpaca rows are counted, sampled, and schema-tagged", async () => {
  const { validateJsonl } = await import("../services/dataset.js");
  const rows = Array.from({ length: 12 }, (_, i) =>
    JSON.stringify({ instruction: `q${i}`, input: "", output: `a${i}` }),
  );
  const { errors, warnings } = fresh();
  const result = validateJsonl(rows.join("\n"), 1234, errors, warnings);

  assert.equal(result.isValid, true);
  assert.equal(result.format, "jsonl");
  assert.equal(result.rowCount, 12);
  assert.equal(result.sizeBytes, 1234);
  assert.equal(result.schema.detectedFormat, "alpaca");
  assert.equal(result.sampleRows.length, 5); // capped at 5 samples
  assert.equal(warnings.length, 0); // >= 10 rows → no small-dataset warning
});

test("validateJsonl: a malformed JSON line is a row-numbered error and fails validation", async () => {
  const { validateJsonl } = await import("../services/dataset.js");
  const content = [
    JSON.stringify({ instruction: "q", output: "a" }),
    "{not json at all",
  ].join("\n");
  const { errors, warnings } = fresh();
  const result = validateJsonl(content, 10, errors, warnings);

  assert.equal(result.isValid, false);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.row, 2);
  assert.match(errors[0]!.message, /Invalid JSON/);
});

test("validateJsonl: a missing required field is caught against the detected format", async () => {
  const { validateJsonl } = await import("../services/dataset.js");
  const content = [
    JSON.stringify({ instruction: "q", output: "a" }), // detects alpaca
    JSON.stringify({ instruction: "q2" }), // missing output
  ].join("\n");
  const { errors, warnings } = fresh();
  const result = validateJsonl(content, 10, errors, warnings);

  assert.equal(result.isValid, false);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.field, "output");
  assert.equal(errors[0]!.row, 2);
});

test("validateJsonl: fewer than 10 valid rows warns but does not invalidate", async () => {
  const { validateJsonl } = await import("../services/dataset.js");
  const content = JSON.stringify({ text: "only one row" });
  const { errors, warnings } = fresh();
  const result = validateJsonl(content, 10, errors, warnings);

  assert.equal(result.isValid, true);
  assert.equal(result.rowCount, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!.message, /only 1 valid rows/);
});

test("validateJsonl: sharegpt conversation entries are role-validated", async () => {
  const { validateJsonl } = await import("../services/dataset.js");
  const content = JSON.stringify({
    conversations: [
      { from: "human", value: "hi" },
      { from: "robot", value: "beep" }, // invalid role
    ],
  });
  const { errors, warnings } = fresh();
  const result = validateJsonl(content, 10, errors, warnings);

  assert.equal(result.isValid, false);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /Invalid role: robot/);
});

// ============================================
// validateCsv
// ============================================

test("validateCsv: header + rows parse, prompt/completion headers detect the format", async () => {
  const { validateCsv } = await import("../services/dataset.js");
  const content = ["prompt,completion", "hello,world", "foo,bar"].join("\n");
  const { errors, warnings } = fresh();
  const result = validateCsv(content, 42, errors, warnings);

  assert.equal(result.isValid, true);
  assert.equal(result.rowCount, 2);
  assert.equal(result.schema.detectedFormat, "completion");
  assert.deepEqual(result.sampleRows[0], { prompt: "hello", completion: "world" });
});

test("validateCsv: a column-count mismatch is a row-numbered error", async () => {
  const { validateCsv } = await import("../services/dataset.js");
  const content = ["text", "fine", "one,two"].join("\n");
  const { errors, warnings } = fresh();
  const result = validateCsv(content, 42, errors, warnings);

  assert.equal(result.isValid, false);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.row, 3);
  assert.match(errors[0]!.message, /2 columns, expected 1/);
});

test("validateCsv: header-only (or empty) input is rejected", async () => {
  const { validateCsv } = await import("../services/dataset.js");
  const { errors, warnings } = fresh();
  const result = validateCsv("text", 4, errors, warnings);

  assert.equal(result.isValid, false);
  assert.match(errors[0]!.message, /header row and at least one data row/);
});

// ============================================
// Storage configuration gate
// ============================================

test("isDatasetStorageConfigured requires all three of key, secret, and bucket", async () => {
  const { isDatasetStorageConfigured } = await import("../services/dataset.js");
  const saved = {
    key: process.env.AWS_ACCESS_KEY_ID,
    secret: process.env.AWS_SECRET_ACCESS_KEY,
    bucket: process.env.DATASETS_BUCKET,
  };
  try {
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.DATASETS_BUCKET;
    assert.equal(isDatasetStorageConfigured(), false);

    process.env.AWS_ACCESS_KEY_ID = "AKIA_TEST";
    process.env.AWS_SECRET_ACCESS_KEY = "secret";
    assert.equal(isDatasetStorageConfigured(), false); // bucket still missing

    process.env.DATASETS_BUCKET = "wheelsai-datasets-test";
    assert.equal(isDatasetStorageConfigured(), true);
  } finally {
    if (saved.key === undefined) delete process.env.AWS_ACCESS_KEY_ID;
    else process.env.AWS_ACCESS_KEY_ID = saved.key;
    if (saved.secret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
    else process.env.AWS_SECRET_ACCESS_KEY = saved.secret;
    if (saved.bucket === undefined) delete process.env.DATASETS_BUCKET;
    else process.env.DATASETS_BUCKET = saved.bucket;
  }
});
