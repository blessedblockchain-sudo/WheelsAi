import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
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
  const { isDatasetStorageConfigured, getDatasetStorageHandle } = await import(
    "../services/dataset.js"
  );
  const { resetTrainingConfigForTests } = await import("../config/training.js");
  const names = [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "DATASETS_BUCKET",
    "STORAGE_DRIVER",
    "STORAGE_LOCAL_DIR",
    "S3_ENDPOINT",
    "S3_FORCE_PATH_STYLE",
  ] as const;
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  // The config is parsed once per process; each change below is re-read.
  const configured = () => {
    resetTrainingConfigForTests();
    return isDatasetStorageConfigured();
  };
  try {
    for (const name of names) delete process.env[name];
    assert.equal(configured(), false);

    process.env.AWS_ACCESS_KEY_ID = "AKIA_TEST";
    process.env.AWS_SECRET_ACCESS_KEY = "secret";
    assert.equal(configured(), false); // bucket still missing

    process.env.DATASETS_BUCKET = "wheelsai-datasets-test";
    assert.equal(configured(), true);
    // The handle agent files share is the s3 driver's own client and bucket.
    assert.equal(getDatasetStorageHandle()?.bucket, "wheelsai-datasets-test");

    // The local driver stores datasets but has no S3 client to share.
    process.env.STORAGE_DRIVER = "local";
    assert.equal(configured(), true);
    assert.equal(getDatasetStorageHandle(), null);
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    resetTrainingConfigForTests();
  }
});

// ============================================
// Row formats
// ============================================

test("every row format validates from JSONL, with token figures over all rows", async () => {
  const { validateJsonl } = await import("../services/dataset.js");
  const cases: Array<{ format: string; row: Record<string, unknown>; chars: number }> = [
    { format: "alpaca", row: { instruction: "abcd", input: "efgh", output: "ijkl" }, chars: 12 },
    {
      format: "sharegpt",
      row: {
        conversations: [
          { from: "system", value: "abcd" },
          { from: "human", value: "efgh" },
          { from: "gpt", value: "ijklmnop" },
        ],
      },
      chars: 16,
    },
    { format: "completion", row: { prompt: "abcdefgh", completion: "ijkl" }, chars: 12 },
    { format: "text", row: { text: "abcdefghijklmnopqrst" }, chars: 20 },
  ];
  for (const c of cases) {
    const content = Array.from({ length: 20 }, () => JSON.stringify(c.row)).join("\n");
    const { errors, warnings } = fresh();
    const result = validateJsonl(content, content.length, errors, warnings);
    assert.equal(result.isValid, true, c.format);
    assert.equal(result.fileType, "jsonl", c.format);
    assert.equal(result.schemaFormat, c.format, c.format);
    assert.equal(result.rowCount, 20, c.format);
    assert.deepEqual(
      result.stats,
      {
        totalTokens: Math.ceil((c.chars * 20) / 4),
        avgTokensPerRow: Math.ceil(c.chars / 4),
        minTokens: Math.ceil(c.chars / 4),
        maxTokens: Math.ceil(c.chars / 4),
      },
      c.format,
    );
  }
});

test("a declared row format holds every row to it, and is what validation reports", async () => {
  const { validateJsonl } = await import("../services/dataset.js");
  const alpaca = JSON.stringify({ instruction: "q", output: "a" });
  const sharegpt = JSON.stringify({
    conversations: [
      { from: "human", value: "q" },
      { from: "gpt", value: "a" },
    ],
  });

  // Declared alpaca / sharegpt used to be "Unsupported format".
  for (const [declared, line] of [
    ["alpaca", alpaca],
    ["sharegpt", sharegpt],
  ] as const) {
    const { errors, warnings } = fresh();
    const result = validateJsonl(line, 10, errors, warnings, { declaredFormat: declared });
    assert.equal(result.isValid, true, declared);
    assert.equal(result.schemaFormat, declared);
  }

  // Declared sharegpt, but the rows are alpaca: an error on each row.
  const { errors, warnings } = fresh();
  const mismatch = validateJsonl(alpaca, 10, errors, warnings, { declaredFormat: "sharegpt" });
  assert.equal(mismatch.isValid, false);
  assert.equal(errors[0]!.field, "conversations");

  // A declared FILE type says nothing about the rows: they are detected.
  const detected = validateJsonl(alpaca, 10, [], [], { declaredFormat: "jsonl" });
  assert.equal(detected.schemaFormat, "alpaca");
});

test("rows the trainer could not use are errors, not valid rows", async () => {
  const { validateJsonl } = await import("../services/dataset.js");
  const check = (lines: unknown[]) => {
    const { errors, warnings } = fresh();
    const content = lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n");
    return { result: validateJsonl(content, 1, errors, warnings), errors };
  };

  // No recognisable format at all used to pass as valid with format "unknown".
  const unknown = check([{ foo: "bar" }]);
  assert.equal(unknown.result.isValid, false);
  assert.equal(unknown.result.schemaFormat, "unknown");
  assert.match(unknown.errors[0]!.message, /none of the supported formats/);

  assert.match(check(["[1,2,3]"]).errors[0]!.message, /JSON array/);
  assert.match(check(['"just a string"']).errors[0]!.message, /must be a JSON object/);
  assert.match(check([{ instruction: "q", output: "  " }]).errors[0]!.message, /output is empty/);
  assert.match(
    check([{ conversations: [{ from: "human", value: "only a question" }] }]).errors[0]!.message,
    /no 'gpt' turn/,
  );
  assert.match(
    check([{ conversations: [{ from: "human", value: 7 }] }]).errors[0]!.message,
    /'from' and 'value'/,
  );

  // An unrecognisable first row does not decide the format for the rest.
  const late = check([{ foo: 1 }, { text: "fine" }]);
  assert.equal(late.result.schemaFormat, "text");
  assert.equal(late.result.rowCount, 1);
  assert.equal(late.result.isValid, false);
});

test("errors are capped at fifty in the list while the count stays true", async () => {
  const { validateJsonl, MAX_REPORTED_ERRORS } = await import("../services/dataset.js");
  const content = Array.from({ length: 300 }, () => "{broken").join("\n");
  const { errors, warnings } = fresh();
  const result = validateJsonl(content, 1, errors, warnings);
  assert.equal(result.isValid, false);
  assert.equal(result.errors.length, MAX_REPORTED_ERRORS);
  assert.equal(result.errorCount, 300);
});

// ============================================
// CSV
// ============================================

test("validateCsv: quoted fields may hold commas, quotes and line breaks", async () => {
  const { validateCsv } = await import("../services/dataset.js");
  const content = [
    "prompt,completion",
    '"Summarise:\nline one\nline two","A ""short"" summary, in one line"',
    "plain,row",
  ].join("\r\n");
  const { errors, warnings } = fresh();
  const result = validateCsv(content, 1, errors, warnings);
  assert.equal(result.isValid, true, JSON.stringify(errors));
  assert.equal(result.rowCount, 2);
  assert.equal(result.fileType, "csv");
  assert.equal(result.schemaFormat, "completion");
  assert.deepEqual(result.sampleRows[0], {
    prompt: "Summarise:\nline one\nline two",
    completion: 'A "short" summary, in one line',
  });
});

test("validateCsv: a header the trainer cannot map is an error", async () => {
  const { validateCsv } = await import("../services/dataset.js");
  const { errors, warnings } = fresh();
  const result = validateCsv(["question,answer", "a,b"].join("\n"), 1, errors, warnings);
  assert.equal(result.isValid, false);
  assert.equal(result.schemaFormat, "unknown");
  assert.match(errors[0]!.message, /'prompt' and 'completion' columns, or a 'text' column/);

  const open = validateCsv(["text", '"never closed'].join("\n"), 1, [], []);
  assert.equal(open.isValid, false);
  assert.match(open.errors.map((e) => e.message).join("|"), /never closed/);
});

// ============================================
// Streaming validation
// ============================================

/** `repeats` copies of `block`, handed out in pieces that ignore row boundaries. */
async function* repeated(block: Buffer, repeats: number, pieceBytes: number, tail?: Buffer) {
  const total = block.length * repeats;
  for (let position = 0; position < total; position += pieceBytes) {
    const size = Math.min(pieceBytes, total - position);
    const piece = Buffer.allocUnsafe(size);
    for (let written = 0; written < size; ) {
      const offset = (position + written) % block.length;
      written += block.copy(piece, written, offset, Math.min(block.length, offset + size - written));
    }
    yield piece;
  }
  if (tail) yield tail;
}

test("streaming: a JSONL far past the old 10 MB cut-off is read to its last row with bounded memory", async () => {
  const { validateDatasetStream } = await import("../services/dataset.js");
  const row = (i: number) =>
    `${JSON.stringify({ instruction: `question ${i} ${"x".repeat(60)}`, input: "", output: `answer ${i}` })}\n`;
  const block = Buffer.from(Array.from({ length: 1000 }, (_, i) => row(i)).join(""));
  const repeats = Math.ceil((24 * 1024 * 1024) / block.length);
  const sizeBytes = block.length * repeats;
  assert.ok(sizeBytes > 2 * 10_485_760, "more than twice the old limit");

  const result = await validateDatasetStream(repeated(block, repeats, 65_537), {
    fileType: "jsonl",
    sizeBytes,
  });
  assert.equal(result.isValid, true, JSON.stringify(result.errors.slice(0, 2)));
  assert.equal(result.rowCount, 1000 * repeats);
  assert.equal(result.schemaFormat, "alpaca");
  assert.equal(result.sampleRows.length, 5);
  assert.ok(result.stats && result.stats.totalTokens > 1_000_000);
  // The only thing ever held is the row being assembled.
  assert.ok(result.peakBufferedBytes < 512, `held ${result.peakBufferedBytes} bytes`);

  // The old reader cut the file at 10 MB mid-row and called that row invalid.
  // A bad row placed at the very end proves the end is what was read.
  const withBadTail = await validateDatasetStream(
    repeated(block, repeats, 65_537, Buffer.from("{this is the last row\n")),
    { fileType: "jsonl", sizeBytes },
  );
  assert.equal(withBadTail.isValid, false);
  assert.equal(withBadTail.errorCount, 1);
  assert.equal(withBadTail.errors[0]!.row, 1000 * repeats + 1);
  assert.equal(withBadTail.rowCount, 1000 * repeats);
});

test("streaming: rows split across chunks, CRLF, a BOM, a missing final newline and bad UTF-8", async () => {
  const { validateDatasetStream } = await import("../services/dataset.js");
  const text =
    "﻿" +
    ['{"text":"first"}', '{"text":"café ☃"}', '{"text":"third"}'].join("\r\n"); // no trailing newline
  const bytes = Buffer.from(text, "utf8");
  // One byte at a time: every multi-byte character is split.
  const oneByOne = (async function* () {
    for (const byte of bytes) yield Buffer.from([byte]);
  })();
  const result = await validateDatasetStream(oneByOne, { fileType: "jsonl", sizeBytes: bytes.length });
  assert.equal(result.isValid, true, JSON.stringify(result.errors));
  assert.equal(result.rowCount, 3);
  assert.deepEqual(result.sampleRows[1], { text: "café ☃" });

  const invalid = Buffer.concat([
    Buffer.from('{"text":"ok"}\n{"text":"'),
    Buffer.from([0xff, 0xfe]),
    Buffer.from('"}\n'),
  ]);
  const bad = await validateDatasetStream([invalid], { fileType: "jsonl", sizeBytes: invalid.length });
  assert.equal(bad.isValid, false);
  assert.deepEqual(
    bad.errors.map((e) => [e.row, e.message]),
    [[2, "Row is not valid UTF-8"]],
  );
});

test("streaming: a row longer than the row limit is an error and is never buffered", async () => {
  const { validateDatasetStream, MAX_ROW_BYTES } = await import("../services/dataset.js");
  const huge = (async function* () {
    yield Buffer.from('{"text":"ok"}\n{"text":"');
    for (let sent = 0; sent < MAX_ROW_BYTES + 1024 * 1024; sent += 65_536) {
      yield Buffer.alloc(65_536, "z");
    }
    yield Buffer.from('"}\n{"text":"after"}\n');
  })();
  const result = await validateDatasetStream(huge, { fileType: "jsonl", sizeBytes: 1 });
  assert.equal(result.isValid, false);
  assert.equal(result.rowCount, 2); // the rows on either side still count
  assert.deepEqual(
    result.errors.map((e) => e.row),
    [2],
  );
  assert.match(result.errors[0]!.message, /longer than/);
  assert.ok(result.peakBufferedBytes <= MAX_ROW_BYTES);
});

test("streaming: reading stops at the row limit", async () => {
  const { validateDatasetStream } = await import("../services/dataset.js");
  let produced = 0;
  const endless = (async function* () {
    for (;;) {
      produced += 1;
      yield Buffer.from('{"text":"row"}\n'.repeat(100));
    }
  })();
  const result = await validateDatasetStream(endless, {
    fileType: "jsonl",
    sizeBytes: 1,
    maxRows: 250,
  });
  assert.equal(result.rowLimitExceeded, true);
  assert.equal(result.isValid, false);
  assert.equal(result.rowCount, 250);
  assert.match(result.errors[0]!.message, /more than 250 rows/);
  assert.ok(produced <= 4, `asked the source for ${produced} chunks`);
});

test("streaming: CSV goes through the same reader", async () => {
  const { validateDatasetStream } = await import("../services/dataset.js");
  const csv = Buffer.from('text\n"one\ntwo"\nthree\n');
  const result = await validateDatasetStream([csv.subarray(0, 9), csv.subarray(9)], {
    fileType: "csv",
    sizeBytes: csv.length,
  });
  assert.equal(result.isValid, true, JSON.stringify(result.errors));
  assert.equal(result.fileType, "csv");
  assert.equal(result.schemaFormat, "text");
  assert.equal(result.rowCount, 2);
  assert.deepEqual(result.sampleRows, [{ text: "one\ntwo" }, { text: "three" }]);
});

// ============================================
// Parquet
// ============================================

/** A store over one buffer that records which byte ranges were asked for. */
function parquetStoreOf(bytes: Buffer) {
  const ranges: Array<[number, number | undefined] | "all"> = [];
  return {
    ranges,
    getStream: async (_key: string, range?: { start: number; end?: number }) => {
      ranges.push(range ? [range.start, range.end] : "all");
      const start = range?.start ?? 0;
      return Readable.from([bytes.subarray(start, (range?.end ?? bytes.length - 1) + 1)]);
    },
  };
}

test("parquet: recognised by PAR1 at both ends; an unreadable footer is an unknown count, not zero", async () => {
  const { validateParquetObject } = await import("../services/dataset.js");
  const storeOf = parquetStoreOf;
  const body = Buffer.alloc(5000, 7);
  const magic = Buffer.from("PAR1");

  const good = storeOf(Buffer.concat([magic, body, magic]));
  const result = await validateParquetObject(good, "datasets/o/d/data.parquet", 5008);
  assert.equal(result.isValid, true);
  assert.equal(result.fileType, "parquet");
  assert.equal(result.rowCount, null);
  assert.equal(result.stats, null);
  assert.equal(result.schemaFormat, "unknown");
  assert.match(result.warnings[0]!.message, /could not be counted/);
  // The markers and the footer length, then one pass for the sha256. The
  // footer length here (0x07070707) is longer than the file: nothing to read.
  assert.deepEqual(good.ranges, [[0, 3], [5000, 5007], "all"]);
  assert.equal(
    result.contentSha256,
    createHash("sha256").update(Buffer.concat([magic, body, magic])).digest("hex"),
  );

  for (const [name, bytes] of [
    ["no magic at the end", Buffer.concat([magic, body, Buffer.from("XXXX")])],
    ["no magic at the start", Buffer.concat([Buffer.from("XXXX"), body, magic])],
    ["a JSONL renamed .parquet", Buffer.from('{"text":"hello"}\n{"text":"world"}\n')],
    ["encrypted footer", Buffer.concat([Buffer.from("PARE"), body, Buffer.from("PARE")])],
  ] as const) {
    const bad = await validateParquetObject(storeOf(bytes), "k", bytes.length);
    assert.equal(bad.isValid, false, name);
    assert.match(bad.errors[0]!.message, /not a Parquet file/, name);
    // Not worth a pass over the file.
    assert.equal(bad.contentSha256, null, name);
  }
  // Too short to hold both markers: refused without a read.
  const tiny = storeOf(Buffer.from("PAR1PAR1"));
  assert.equal((await validateParquetObject(tiny, "k", 8)).isValid, false);
  assert.deepEqual(tiny.ranges, []);
});

test("parquet: the row count is read from real footers, and only the footer is read for it", async () => {
  const { validateParquetObject, parseParquetRowCount } = await import("../services/dataset.js");
  const { PARQUET_FIXTURES, parquetFixture } = await import("./parquetFixtures.js");

  for (const name of ["text3", "sharegpt5", "pairs7"] as const) {
    const bytes = parquetFixture(name);
    const store = parquetStoreOf(bytes);
    const result = await validateParquetObject(store, "k", bytes.length, { maxRows: 100 });
    assert.equal(result.isValid, true, name);
    assert.equal(result.rowCount, PARQUET_FIXTURES[name].rows, name);
    assert.equal(result.rowLimitExceeded, false, name);
    assert.match(result.warnings[0]!.message, /counted from its footer/, name);
    const footerBytes = bytes.readUInt32LE(bytes.length - 8);
    assert.deepEqual(
      store.ranges,
      [[0, 3], [bytes.length - 8, bytes.length - 1], [bytes.length - 8 - footerBytes, bytes.length - 9], "all"],
      name,
    );
  }

  // The limit is the footer's count against maxRows; over it nothing is hashed.
  const seven = parquetFixture("pairs7");
  const sevenStore = parquetStoreOf(seven);
  const over = await validateParquetObject(sevenStore, "k", seven.length, { maxRows: 6 });
  assert.equal(over.isValid, false);
  assert.equal(over.rowLimitExceeded, true);
  assert.equal(over.rowCount, null);
  assert.equal(over.contentSha256, null);
  assert.equal(sevenStore.ranges.includes("all"), false);
  assert.equal((await validateParquetObject(parquetStoreOf(seven), "k", seven.length, { maxRows: 7 })).isValid, true);

  const empty = parquetFixture("empty");
  const none = await validateParquetObject(parquetStoreOf(empty), "k", empty.length);
  assert.equal(none.isValid, false);
  assert.match(none.errors[0]!.message, /no rows/);

  // The footer parser: garbage, a cut-off footer and hostile lengths all end
  // in "unknown", none of them in a throw or a long loop.
  const footer = (name: "text3" | "sharegpt5") => {
    const bytes = parquetFixture(name);
    return bytes.subarray(bytes.length - 8 - bytes.readUInt32LE(bytes.length - 8), bytes.length - 8);
  };
  assert.equal(parseParquetRowCount(footer("sharegpt5")), 5n);
  assert.equal(parseParquetRowCount(Buffer.alloc(0)), null);
  assert.equal(parseParquetRowCount(Buffer.alloc(64, 0xff)), null);
  assert.equal(parseParquetRowCount(Buffer.alloc(64, 0x19)), null);
  // A list that claims 2^60 elements, a string that claims 2^40 bytes.
  assert.equal(parseParquetRowCount(Buffer.from([0x15, 0x02, 0x19, 0xfc, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x10])), null);
  assert.equal(parseParquetRowCount(Buffer.from([0x18, 0x80, 0x80, 0x80, 0x80, 0x80, 0x20, 0x00])), null);
  // Structs nested deeper than any schema.
  assert.equal(parseParquetRowCount(Buffer.alloc(4096, 0x1c)), null);
  // Cut anywhere before num_rows: unknown. Every prefix is safe to parse.
  const whole = footer("sharegpt5");
  for (let length = 0; length < whole.length; length++) {
    const count = parseParquetRowCount(whole.subarray(0, length));
    assert.ok(count === null || count === 5n, `prefix of ${length} bytes`);
  }
});

// ============================================
// File type
// ============================================

test("resolveDatasetFileType: explicit type, then the extension, then a legacy format", async () => {
  const { resolveDatasetFileType } = await import("../services/dataset.js");
  const cases: Array<[Parameters<typeof resolveDatasetFileType>[0], string | null]> = [
    [{ fileName: "train.jsonl" }, "jsonl"],
    [{ fileName: "train.JSON" }, "jsonl"],
    [{ fileName: "train.ndjson" }, "jsonl"],
    [{ fileName: "train.csv", format: "jsonl" }, "csv"],
    [{ fileName: "train.parquet" }, "parquet"],
    [{ fileName: "train.bin", fileType: "parquet" }, "parquet"],
    [{ fileName: "train", format: "csv" }, "csv"],
    [{ fileName: "train.jsonl", format: "alpaca" }, "jsonl"],
    [{ fileName: "notes.txt", format: "alpaca" }, null],
    [{ fileName: "archive.zip" }, null],
  ];
  for (const [input, expected] of cases) {
    assert.equal(resolveDatasetFileType(input), expected, JSON.stringify(input));
  }
});
