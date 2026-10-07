// Dataset Service for WheelsAI
// Handles dataset upload, validation, and management
//
// Three things are kept apart here that used to share one column:
//
//   fileType      how the file is encoded: jsonl | csv | parquet. Decides the
//                 parser. Set once, at upload, from the file name.
//   format        what the uploader DECLARED (a file type, or a row format
//                 such as "alpaca"). Never overwritten after creation.
//   schemaFormat  what validation DETECTED in the rows: alpaca | sharegpt |
//                 completion | text. Written by every validation.
//
// Validation reads the whole object as a stream, one row at a time, so its
// memory does not grow with the file. The storage itself is services/
// objectStore.ts; this module never builds a client.
//
// What validation records is bound to the bytes it read: their sha256 (and
// the store's ETag) are stored with the counts. An upload link stays usable
// for its whole lifetime, so the object CAN change after validation; whoever
// trains on a dataset passes the stored sha256 to the trainer, which refuses
// any other bytes.

import { createHash } from "node:crypto";

import { createLogger } from "../utils/logger.js";
import type { S3Client } from "@aws-sdk/client-s3";

import {
  ObjectNotFoundError,
  S3ObjectStore,
  getObjectStore,
  type ObjectStore,
  type TransferUrl,
} from "./objectStore.js";

const logger = createLogger("dataset-service");

// ============================================
// Types
// ============================================

export const DATASET_FILE_TYPES = ["jsonl", "csv", "parquet"] as const;
export type DatasetFileType = (typeof DATASET_FILE_TYPES)[number];

export const DATASET_ROW_FORMATS = ["alpaca", "sharegpt", "completion", "text"] as const;
export type DatasetRowFormat = (typeof DATASET_ROW_FORMATS)[number];
export type DatasetSchemaFormat = DatasetRowFormat | "unknown";

/** Token figures are an estimate: characters / 4, over every valid row. */
export interface DatasetStats {
  totalTokens: number;
  avgTokensPerRow: number;
  minTokens: number;
  maxTokens: number;
}

export interface DatasetValidationResult {
  isValid: boolean;
  /** The file type. Kept under its old name for existing readers. */
  format: string;
  fileType: DatasetFileType;
  schemaFormat: DatasetSchemaFormat;
  /** Valid rows. null when the rows were not counted (Parquet). */
  rowCount: number | null;
  sizeBytes: number;
  /** At most MAX_REPORTED_ERRORS; errorCount is the true total. */
  errors: ValidationError[];
  errorCount: number;
  warnings: ValidationWarning[];
  sampleRows: Record<string, any>[];
  schema: DatasetSchema;
  /** null when no row was read (Parquet, or nothing valid). */
  stats: DatasetStats | null;
  /** Set when reading stopped at the row limit; the dataset is then invalid. */
  rowLimitExceeded: boolean;
  /** Most bytes held for a single row while reading. Bounded by MAX_ROW_BYTES. */
  peakBufferedBytes: number;
  /**
   * sha256 (hex) of the object's bytes as validation read them. null when
   * the object was not read to its end (reading stopped early, or the file
   * is invalid and was not worth a pass).
   */
  contentSha256: string | null;
}

export interface ValidationError {
  row?: number;
  field?: string;
  message: string;
  severity: "error";
}

export interface ValidationWarning {
  row?: number;
  field?: string;
  message: string;
  severity: "warning";
}

export interface DatasetSchema {
  fields: Array<{
    name: string;
    type: "string" | "number" | "array" | "object";
    required: boolean;
  }>;
  detectedFormat: DatasetSchemaFormat;
}

// ============================================
// Storage wrappers (kept for existing callers)
// ============================================

/**
 * Whether dataset storage is actually usable. The routes use this to refuse
 * up front with an honest 503 instead of failing mid-request.
 */
export function isDatasetStorageConfigured(): boolean {
  return getObjectStore() !== null;
}

/**
 * The dataset object store as a handle other features can share (per-agent
 * files, for one), or null when it is not configured. Reusing the one
 * client and bucket means a single place decides what "storage is
 * configured" means. Only the s3 driver has a client to share: with the
 * development-only local driver this is null and those features stay off.
 */
export function getDatasetStorageHandle(): { client: S3Client; bucket: string } | null {
  const store = getObjectStore();
  return store instanceof S3ObjectStore ? { client: store.client, bucket: store.bucket } : null;
}

/**
 * The object key behind a Dataset.storageUrl, or null when the URL does not
 * belong to this store. New rows hold "store://<key>"; rows written before
 * the object store existed hold "s3://<bucket>/<key>" (or the AWS https
 * form) and keep working as long as the bucket is still the configured one.
 */
export function datasetObjectKey(storageUrl: string, store: ObjectStore): string | null {
  if (storageUrl.startsWith("store://")) return storageUrl.slice("store://".length) || null;

  let bucket: string | undefined;
  let key: string | undefined;
  if (storageUrl.startsWith("s3://")) {
    const parts = storageUrl.slice(5).split("/");
    bucket = parts[0];
    key = parts.slice(1).join("/");
  } else {
    // https://bucket.s3.region.amazonaws.com/key
    const match = storageUrl.match(/^https?:\/\/([^.]+)\.s3\..*\.amazonaws\.com\/(.+)$/);
    bucket = match?.[1];
    key = match?.[2];
  }
  if (!bucket || !key) return null;
  if (!(store instanceof S3ObjectStore) || store.bucket !== bucket) return null;
  return key;
}

/**
 * Best-effort object deletion for a dataset's storageUrl. Failures are
 * logged, not thrown - an orphaned object must not block the row's delete.
 * Returns whether the object is known to be gone.
 */
export async function deleteDatasetObject(
  storageUrl: string,
  store: ObjectStore | null = getObjectStore(),
): Promise<boolean> {
  try {
    const key = store ? datasetObjectKey(storageUrl, store) : null;
    if (!store || !key) {
      logger.warn({ storageUrl }, "Dataset object not deleted: it is not in the configured store");
      return false;
    }
    await store.delete(key);
    logger.info({ storageUrl }, "Deleted dataset object");
    return true;
  } catch (error) {
    // Logged with the URL so a sweep can find what was left behind.
    logger.warn({ error, storageUrl }, "Failed to delete dataset object");
    return false;
  }
}

// ============================================
// Expected Schemas by Format
// ============================================

const FORMAT_SCHEMAS: Record<DatasetRowFormat, DatasetSchema> = {
  alpaca: {
    fields: [
      { name: "instruction", type: "string", required: true },
      { name: "input", type: "string", required: false },
      { name: "output", type: "string", required: true },
    ],
    detectedFormat: "alpaca",
  },
  sharegpt: {
    fields: [
      { name: "conversations", type: "array", required: true },
    ],
    detectedFormat: "sharegpt",
  },
  completion: {
    fields: [
      { name: "prompt", type: "string", required: true },
      { name: "completion", type: "string", required: true },
    ],
    detectedFormat: "completion",
  },
  text: {
    fields: [
      { name: "text", type: "string", required: true },
    ],
    detectedFormat: "text",
  },
};

function isRowFormat(value: unknown): value is DatasetRowFormat {
  return (DATASET_ROW_FORMATS as readonly string[]).includes(value as string);
}

// ============================================
// File type
// ============================================

const EXTENSION_FILE_TYPES: Record<string, DatasetFileType> = {
  jsonl: "jsonl",
  ndjson: "jsonl",
  json: "jsonl",
  csv: "csv",
  parquet: "parquet",
};

/**
 * Which parser a file gets. An explicit fileType wins, then the file name's
 * extension, then a legacy `format` that names a file type. null means the
 * file is of no supported type.
 */
export function resolveDatasetFileType(input: {
  fileName?: string;
  fileType?: string;
  format?: string;
}): DatasetFileType | null {
  const isFileType = (value: unknown): value is DatasetFileType =>
    (DATASET_FILE_TYPES as readonly string[]).includes(value as string);
  if (isFileType(input.fileType)) return input.fileType;
  const dot = input.fileName?.lastIndexOf(".") ?? -1;
  const extension = dot >= 0 ? input.fileName!.slice(dot + 1).toLowerCase() : "";
  const fromName = EXTENSION_FILE_TYPES[extension];
  if (fromName) return fromName;
  if (isFileType(input.format)) return input.format;
  return null;
}

// ============================================
// Row validation (shared by every reader)
// ============================================

export const MAX_REPORTED_ERRORS = 50;
export const MAX_SAMPLE_ROWS = 5;
/** Longest single row accepted. Also the bound on validation's memory. */
export const MAX_ROW_BYTES = 4 * 1024 * 1024;
/**
 * The most the sample rows of one dataset may weigh as JSON. A row can be
 * 4 MiB; what is kept of it for the preview is a cut-down copy, so the
 * stored column and the validate response stay small whatever was uploaded.
 */
export const MAX_SAMPLE_BYTES = 64 * 1024;
/** An error message can quote the uploader's own text; it is cut to this. */
export const MAX_ERROR_MESSAGE_CHARS = 300;
const MAX_ERROR_FIELD_CHARS = 120;

// Preview limits. Characters are budgeted per row; a character is at most six
// bytes of JSON (a \uXXXX escape), which keeps five rows under the cap.
const SAMPLE_ROW_CHAR_BUDGET = 2000;
const SAMPLE_STRING_CHARS = 400;
const SAMPLE_MAX_ITEMS = 20;
const SAMPLE_MAX_DEPTH = 6;
const SAMPLE_NODE_COST = 6;

// ============================================
// Text the database can hold
// ============================================

// Postgres refuses two things in a jsonb value that JSON itself allows: the
// NUL character and a surrogate without its pair. Both come straight out of
// JSON.parse ("\u0000", "\ud800"), and a tokenizer cannot encode the second.
const UNPAIRED_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const UNPAIRED_SURROGATES = new RegExp(UNPAIRED_SURROGATE.source, "g");

function unstorableReason(text: string): string | null {
  if (text.includes("\u0000")) return "Row contains a NUL character";
  if (UNPAIRED_SURROGATE.test(text)) return "Row contains an unpaired surrogate character";
  return null;
}

/**
 * Why a parsed row cannot be kept, or null. Every string in it is looked at,
 * keys included. A loop with its own stack, not recursion: the nesting depth
 * is the uploader's choice.
 */
function unstorableRowReason(row: unknown): string | null {
  const pending: unknown[] = [row];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
      const reason = unstorableReason(value);
      if (reason) return reason;
    } else if (Array.isArray(value)) {
      for (const item of value) pending.push(item);
    } else if (typeof value === "object" && value !== null) {
      for (const [key, item] of Object.entries(value)) {
        const reason = unstorableReason(key);
        if (reason) return reason;
        pending.push(item);
      }
    }
  }
  return null;
}

/** `text` cut to `maxChars` and made safe to store (U+FFFD for what is not). */
function storableText(text: string, maxChars: number): string {
  // Cut first: a cut can split a surrogate pair, and the replace mends that.
  const cut = text.length > maxChars ? `${text.slice(0, maxChars - 1)}\u2026` : text;
  return cut.replaceAll("\u0000", "\uFFFD").replace(UNPAIRED_SURROGATES, "\uFFFD");
}

/**
 * A cut-down copy of a row for the preview: long strings shortened, long
 * arrays and wide objects cut, all within one character budget, so the work
 * and the result are bounded however large the row is.
 */
function previewValue(value: unknown, budget: { left: number }, depth: number): unknown {
  budget.left -= SAMPLE_NODE_COST;
  if (typeof value === "string") {
    const text = storableText(value, Math.max(1, Math.min(SAMPLE_STRING_CHARS, budget.left)));
    budget.left -= text.length;
    return text;
  }
  if (typeof value !== "object" || value === null) {
    budget.left -= String(value).length;
    return value;
  }
  if (depth >= SAMPLE_MAX_DEPTH) return Array.isArray(value) ? [] : {};
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value) {
      if (items.length >= SAMPLE_MAX_ITEMS || budget.left <= 0) break;
      items.push(previewValue(item, budget, depth + 1));
    }
    return items;
  }
  const copy: Record<string, unknown> = {};
  let kept = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    if (kept >= SAMPLE_MAX_ITEMS || budget.left <= 0) break;
    const name = storableText(key, 100);
    budget.left -= name.length;
    copy[name] = previewValue((value as Record<string, unknown>)[key], budget, depth + 1);
    kept += 1;
  }
  return copy;
}

/** The preview of one row, or null when even the cut-down copy is too heavy. */
export function previewDatasetRow(row: Record<string, any>): Record<string, any> | null {
  const preview = previewValue(row, { left: SAMPLE_ROW_CHAR_BUDGET }, 0) as Record<string, any>;
  const bytes = Buffer.byteLength(JSON.stringify(preview));
  return bytes <= Math.floor(MAX_SAMPLE_BYTES / MAX_SAMPLE_ROWS) ? preview : null;
}

const UNSUPPORTED_ROW =
  "Row matches none of the supported formats (alpaca, sharegpt, completion, text)";

interface RowCheckerOptions {
  /** A row format the uploader declared; rows are then held to it. */
  declaredFormat?: string;
  /** Reading stops, and the dataset is invalid, past this many rows. */
  maxRows?: number;
}

/**
 * Collects rows one at a time; holds five cut-down samples and fifty short
 * errors at most. Nothing it keeps can be refused by a jsonb column.
 */
class RowChecker {
  expected: DatasetRowFormat | null;
  validRows = 0;
  seenRows = 0;
  errorCount = 0;
  rowLimitExceeded = false;
  readonly errors: ValidationError[] = [];
  readonly warnings: ValidationWarning[] = [];
  readonly sampleRows: Record<string, any>[] = [];
  private totalChars = 0;
  private minChars = Infinity;
  private maxChars = 0;
  private readonly maxRows: number;

  constructor(options: RowCheckerOptions = {}) {
    this.expected = isRowFormat(options.declaredFormat) ? options.declaredFormat : null;
    this.maxRows = options.maxRows ?? Infinity;
  }

  addError(error: Omit<ValidationError, "severity">): void {
    this.errorCount += 1;
    if (this.errors.length < MAX_REPORTED_ERRORS) {
      // A message or field can echo the uploader's text (a role name, the
      // snippet in a JSON parse error): bounded and made storable here, once.
      this.errors.push({
        ...error,
        ...(error.field !== undefined
          ? { field: storableText(error.field, MAX_ERROR_FIELD_CHARS) }
          : {}),
        message: storableText(error.message, MAX_ERROR_MESSAGE_CHARS),
        severity: "error",
      });
    }
  }

  /** false once the row limit is passed: the caller stops reading. */
  admitRow(): boolean {
    this.seenRows += 1;
    if (this.seenRows <= this.maxRows) return true;
    if (!this.rowLimitExceeded) {
      this.rowLimitExceeded = true;
      this.addError({ message: `Dataset has more than ${this.maxRows} rows` });
    }
    return false;
  }

  acceptRow(row: unknown, rowNumber: number): void {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      this.addError({ row: rowNumber, message: "Row must be a JSON object" });
      return;
    }
    const record = row as Record<string, any>;
    const unstorable = unstorableRowReason(record);
    if (unstorable) {
      this.addError({ row: rowNumber, message: unstorable });
      return;
    }
    if (!this.expected) {
      const detected = detectFormat(record);
      if (detected === "unknown") {
        this.addError({ row: rowNumber, message: UNSUPPORTED_ROW });
        return;
      }
      this.expected = detected;
    }

    const rowErrors = validateRow(record, this.expected, rowNumber);
    if (rowErrors.length > 0) {
      for (const error of rowErrors) this.addError(error);
      return;
    }

    this.validRows += 1;
    // The preview is taken from the first rows only, and cut down: see
    // MAX_SAMPLE_BYTES.
    if (this.validRows <= MAX_SAMPLE_ROWS) {
      const preview = previewDatasetRow(record);
      if (preview) this.sampleRows.push(preview);
    }
    const chars = rowChars(record, this.expected);
    this.totalChars += chars;
    this.minChars = Math.min(this.minChars, chars);
    this.maxChars = Math.max(this.maxChars, chars);
  }

  stats(): DatasetStats | null {
    if (this.validRows === 0) return null;
    return {
      totalTokens: Math.ceil(this.totalChars / 4),
      avgTokensPerRow: Math.ceil(this.totalChars / this.validRows / 4),
      minTokens: Math.ceil(this.minChars / 4),
      maxTokens: Math.ceil(this.maxChars / 4),
    };
  }

  result(
    fileType: DatasetFileType,
    sizeBytes: number,
    schema: DatasetSchema,
    peakBufferedBytes: number,
  ): DatasetValidationResult {
    // Check for minimum rows
    if (this.validRows < 10 && !this.rowLimitExceeded) {
      this.warnings.push({
        message: `Dataset has only ${this.validRows} valid rows. Recommend at least 100 examples for fine-tuning.`,
        severity: "warning",
      });
    }
    const stats = this.stats();
    if (this.expected === "text" && this.validRows > 100 && stats && stats.avgTokensPerRow < 25) {
      this.warnings.push({
        message: "Average text length is very short. Consider longer training examples.",
        severity: "warning",
      });
    }
    return {
      isValid: this.errorCount === 0 && this.validRows > 0,
      format: fileType,
      fileType,
      schemaFormat: schema.detectedFormat,
      rowCount: this.validRows,
      sizeBytes,
      errors: this.errors,
      errorCount: this.errorCount,
      warnings: this.warnings,
      sampleRows: this.sampleRows,
      schema,
      stats,
      rowLimitExceeded: this.rowLimitExceeded,
      peakBufferedBytes,
      // Set by the caller that saw every byte.
      contentSha256: null,
    };
  }
}

function rowChars(row: Record<string, any>, format: DatasetRowFormat): number {
  if (format === "alpaca") {
    return (row.instruction?.length || 0) + (row.input?.length || 0) + (row.output?.length || 0);
  }
  if (format === "sharegpt") {
    return (
      row.conversations?.reduce((sum: number, c: any) => sum + (c?.value?.length || 0), 0) || 0
    );
  }
  if (format === "completion") {
    return (row.prompt?.length || 0) + (row.completion?.length || 0);
  }
  return row.text?.length || 0;
}

/** JSON Lines: one physical line is one row. */
class JsonlReader {
  readonly checker: RowChecker;
  private sawContent = false;
  /** Set when reading should stop early (row limit, or not JSON Lines at all). */
  done = false;

  constructor(options: RowCheckerOptions) {
    this.checker = new RowChecker(options);
  }

  pushLine(line: string, lineNumber: number): void {
    if (this.done || !line.trim()) return;
    if (!this.sawContent) {
      this.sawContent = true;
      if (line.trimStart().startsWith("[")) {
        this.checker.addError({
          row: lineNumber,
          message:
            "File looks like a JSON array. Upload JSON Lines instead: one JSON object per line.",
        });
        this.done = true;
        return;
      }
    }
    if (!this.checker.admitRow()) {
      this.done = true;
      return;
    }
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch (e) {
      this.checker.addError({
        row: lineNumber,
        message: `Invalid JSON: ${e instanceof Error ? e.message : "Parse error"}`,
      });
      return;
    }
    this.checker.acceptRow(row, lineNumber);
  }

  pushOversizeLine(lineNumber: number): void {
    if (this.done) return;
    this.sawContent = true;
    if (!this.checker.admitRow()) {
      this.done = true;
      return;
    }
    this.checker.addError({
      row: lineNumber,
      message: `Row is longer than ${MAX_ROW_BYTES} bytes`,
    });
  }

  finish(sizeBytes: number, peakBufferedBytes: number): DatasetValidationResult {
    const format = this.checker.expected;
    const schema: DatasetSchema = format
      ? FORMAT_SCHEMAS[format]
      : { fields: [], detectedFormat: "unknown" };
    return this.checker.result("jsonl", sizeBytes, schema, peakBufferedBytes);
  }
}

/**
 * CSV: a quoted field may contain line breaks, so physical lines are joined
 * until the quotes balance. A doubled quote ("") leaves the balance as it
 * was, which is exactly the RFC 4180 rule.
 */
class CsvReader {
  readonly checker: RowChecker;
  private header: string[] | null = null;
  private detected: "completion" | "text" | "unknown" = "unknown";
  private pending: string | null = null;
  private pendingStart = 0;
  /** Whether `pending` ends inside a quoted field. Kept per line, not recounted. */
  private pendingOpen = false;
  private dataRecords = 0;
  done = false;

  constructor(options: RowCheckerOptions) {
    // A CSV carries completion or text rows only; a declared format outside
    // those two is ignored and the header decides.
    const declared = options.declaredFormat;
    this.checker = new RowChecker({
      ...options,
      declaredFormat: declared === "completion" || declared === "text" ? declared : undefined,
    });
  }

  pushLine(line: string, lineNumber: number): void {
    if (this.done) return;
    if (this.pending === null) {
      if (!line.trim()) return;
      this.pending = line;
      this.pendingStart = lineNumber;
      this.pendingOpen = false;
    } else {
      this.pending += `\n${line}`;
    }
    if (this.pending.length > MAX_ROW_BYTES) {
      this.pushOversizeLine(this.pendingStart);
      return;
    }
    if (countQuotes(line) % 2 === 1) this.pendingOpen = !this.pendingOpen;
    if (this.pendingOpen) return; // inside a quoted field
    const record = this.pending;
    this.pending = null;
    this.acceptRecord(record, this.pendingStart);
  }

  pushOversizeLine(lineNumber: number): void {
    if (this.done) return;
    this.pending = null;
    this.checker.addError({
      row: lineNumber,
      message: `Row is longer than ${MAX_ROW_BYTES} bytes`,
    });
  }

  private acceptRecord(record: string, lineNumber: number): void {
    const values = parseCSVLine(record);
    if (!this.header) {
      this.header = values;
      // Detect format from headers
      if (values.includes("prompt") && values.includes("completion")) this.detected = "completion";
      else if (values.includes("text")) this.detected = "text";
      if (this.detected === "unknown") {
        this.checker.addError({
          row: lineNumber,
          message:
            "CSV header must have 'prompt' and 'completion' columns, or a 'text' column",
        });
      } else if (!this.checker.expected) {
        this.checker.expected = this.detected;
      }
      return;
    }

    this.dataRecords += 1;
    if (!this.checker.admitRow()) {
      this.done = true;
      return;
    }
    if (values.length !== this.header.length) {
      this.checker.addError({
        row: lineNumber,
        message: `Row has ${values.length} columns, expected ${this.header.length}`,
      });
      return;
    }
    // Without a usable header there is nothing to hold a row to; the header
    // error above already made the dataset invalid.
    if (!this.checker.expected) return;

    const row: Record<string, string> = {};
    this.header.forEach((col, idx) => {
      row[col] = values[idx] ?? "";
    });
    this.checker.acceptRow(row, lineNumber);
  }

  finish(sizeBytes: number, peakBufferedBytes: number): DatasetValidationResult {
    if (this.pending !== null && !this.done) {
      this.checker.addError({
        row: this.pendingStart,
        message: "Quoted field is never closed",
      });
    }
    if (!this.header || this.dataRecords === 0) {
      this.checker.addError({
        message: "CSV file must have a header row and at least one data row",
      });
    }
    const fields = (this.header ?? []).map((name) => ({
      name,
      type: "string" as const,
      required: true,
    }));
    return this.checker.result(
      "csv",
      sizeBytes,
      { fields, detectedFormat: this.checker.expected ?? this.detected },
      peakBufferedBytes,
    );
  }
}

function countQuotes(text: string): number {
  let count = 0;
  for (let i = text.indexOf('"'); i !== -1; i = text.indexOf('"', i + 1)) count += 1;
  return count;
}

// ============================================
// In-memory validation (small inputs, tests)
// ============================================

function runInMemory(
  reader: JsonlReader | CsvReader,
  content: string,
  sizeBytes: number,
  errors: ValidationError[],
  warnings: ValidationWarning[],
): DatasetValidationResult {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length && !reader.done; i++) {
    reader.pushLine((lines[i] ?? "").replace(/\r$/, ""), i + 1);
  }
  const result = reader.finish(sizeBytes, 0);
  errors.push(...result.errors);
  warnings.push(...result.warnings);
  return { ...result, errors, warnings };
}

export function validateJsonl(
  content: string,
  sizeBytes: number,
  errors: ValidationError[],
  warnings: ValidationWarning[],
  options: RowCheckerOptions = {},
): DatasetValidationResult {
  return runInMemory(new JsonlReader(options), content, sizeBytes, errors, warnings);
}

export function validateCsv(
  content: string,
  sizeBytes: number,
  errors: ValidationError[],
  warnings: ValidationWarning[],
  options: RowCheckerOptions = {},
): DatasetValidationResult {
  return runInMemory(new CsvReader(options), content, sizeBytes, errors, warnings);
}

// ============================================
// Streaming validation
// ============================================

export interface ValidateStreamOptions extends RowCheckerOptions {
  fileType: "jsonl" | "csv";
  sizeBytes: number;
}

const NEWLINE = 0x0a;

/**
 * Validate a whole JSONL or CSV file from a byte stream. Only the row being
 * assembled is ever held (at most MAX_ROW_BYTES), plus five sample rows and
 * fifty errors, so a 200 MB file costs the same memory as a 2 KB one.
 *
 * The bytes are hashed as they pass: the counts in the result and its
 * contentSha256 describe the same bytes.
 */
export async function validateDatasetStream(
  source: AsyncIterable<Buffer | Uint8Array | string> | Iterable<Buffer | Uint8Array | string>,
  options: ValidateStreamOptions,
): Promise<DatasetValidationResult> {
  const reader = options.fileType === "csv" ? new CsvReader(options) : new JsonlReader(options);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const hash = createHash("sha256");
  let readToEnd = true;

  let parts: Buffer[] = [];
  let buffered = 0;
  let overflow = false;
  let peak = 0;
  let lineNumber = 0;

  const emit = (line: Buffer | null) => {
    lineNumber += 1;
    if (line === null) {
      reader.pushOversizeLine(lineNumber);
      return;
    }
    let text: string;
    try {
      text = decoder.decode(line);
    } catch {
      reader.checker.addError({ row: lineNumber, message: "Row is not valid UTF-8" });
      return;
    }
    // TextDecoder drops a leading byte-order mark on its own.
    reader.pushLine(text.endsWith("\r") ? text.slice(0, -1) : text, lineNumber);
  };

  for await (const piece of source) {
    const chunk = typeof piece === "string" ? Buffer.from(piece, "utf8") : Buffer.from(piece);
    hash.update(chunk);
    let start = 0;
    while (start < chunk.length && !reader.done) {
      const newline = chunk.indexOf(NEWLINE, start);
      const end = newline === -1 ? chunk.length : newline;
      const segment = chunk.subarray(start, end);
      if (!overflow) {
        if (buffered + segment.length > MAX_ROW_BYTES) {
          // Too long to be a row: forget what was held and skip to the next
          // line break without keeping any of it.
          overflow = true;
          parts = [];
          buffered = 0;
        } else if (segment.length > 0) {
          parts.push(segment);
          buffered += segment.length;
          peak = Math.max(peak, buffered);
        }
      }
      if (newline === -1) break;
      emit(overflow ? null : parts.length === 1 ? parts[0]! : Buffer.concat(parts, buffered));
      parts = [];
      buffered = 0;
      overflow = false;
      start = newline + 1;
    }
    // Leaving the loop early ends the iteration, which closes the source.
    if (reader.done) {
      readToEnd = false;
      break;
    }
  }
  if (!reader.done && (overflow || buffered > 0)) {
    emit(overflow ? null : Buffer.concat(parts, buffered));
  }

  return {
    ...reader.finish(options.sizeBytes, peak),
    contentSha256: readToEnd ? hash.digest("hex") : null,
  };
}

// ============================================
// Parquet
// ============================================

const PARQUET_MAGIC = "PAR1";
/** The most of a footer that is read to find the row count. */
export const MAX_PARQUET_FOOTER_BYTES = 8 * 1024 * 1024;
/** Dataset.rowCount is a 32-bit column. */
const MAX_COUNTABLE_ROWS = 2_147_483_647;

/**
 * Just enough of Thrift's compact protocol to walk a Parquet footer: read a
 * field header, read an integer, skip a value of any type. Every read is
 * bounds-checked and throws RangeError past the end, so a footer that lies
 * about its lengths ends the walk instead of running it.
 */
class ThriftCompactReader {
  private pos = 0;
  constructor(private readonly bytes: Buffer) {}

  byte(): number {
    if (this.pos >= this.bytes.length) throw new RangeError("footer ends early");
    return this.bytes[this.pos++]!;
  }

  varint(): bigint {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      const next = this.byte();
      value |= BigInt(next & 0x7f) << shift;
      if ((next & 0x80) === 0) return value;
    }
    throw new RangeError("integer is too long");
  }

  zigzag(): bigint {
    const value = this.varint();
    return (value >> 1n) ^ -(value & 1n);
  }

  private advance(count: bigint | number): void {
    const next = BigInt(this.pos) + BigInt(count);
    if (next > BigInt(this.bytes.length)) throw new RangeError("footer ends early");
    this.pos = Number(next);
  }

  /** How many elements follow; never more than the bytes left to hold them. */
  private count(): number {
    const size = this.varint();
    if (size > BigInt(this.bytes.length - this.pos)) throw new RangeError("footer ends early");
    return Number(size);
  }

  /** `inCollection`: a boolean is one byte there, and no bytes as a struct field. */
  skip(type: number, depth: number, inCollection = false): void {
    if (depth > 64) throw new RangeError("footer is nested too deeply");
    switch (type) {
      case 1: // boolean true
      case 2: // boolean false
        if (inCollection) this.advance(1);
        return;
      case 3: // byte
        this.advance(1);
        return;
      case 4: // i16
      case 5: // i32
      case 6: // i64
        this.varint();
        return;
      case 7: // double
        this.advance(8);
        return;
      case 8: // binary, string
        this.advance(this.varint());
        return;
      case 9: // list
      case 10: {
        // set
        const header = this.byte();
        const size = header >> 4 === 15 ? this.count() : header >> 4;
        for (let i = 0; i < size; i++) this.skip(header & 0x0f, depth + 1, true);
        return;
      }
      case 11: {
        // map
        const size = this.count();
        if (size === 0) return;
        const types = this.byte();
        for (let i = 0; i < size; i++) {
          this.skip(types >> 4, depth + 1, true);
          this.skip(types & 0x0f, depth + 1, true);
        }
        return;
      }
      case 12: // struct
        for (;;) {
          const header = this.byte();
          if (header === 0) return;
          if (header >> 4 === 0) this.zigzag(); // a full field id follows
          this.skip(header & 0x0f, depth + 1);
        }
      default:
        throw new RangeError("unknown type in footer");
    }
  }
}

/**
 * FileMetaData.num_rows (field 3, an i64) from the bytes of a Parquet footer,
 * or null when it cannot be found. `footer` may be only the footer's start:
 * the fields before num_rows are the version and the schema.
 */
export function parseParquetRowCount(footer: Buffer): bigint | null {
  const reader = new ThriftCompactReader(footer);
  try {
    let fieldId = 0;
    for (;;) {
      const header = reader.byte();
      if (header === 0) return null;
      const type = header & 0x0f;
      fieldId = header >> 4 === 0 ? Number(reader.zigzag()) : fieldId + (header >> 4);
      if (fieldId === 3) return type === 6 ? reader.zigzag() : null;
      reader.skip(type, 0);
    }
  } catch (err) {
    if (err instanceof RangeError) return null;
    throw err;
  }
}

/**
 * Parquet is a binary column store. It is recognised by its magic bytes (the
 * four bytes "PAR1" at both ends of the file), and its rows are counted from
 * the footer's own metadata, so the row limit applies and a price is never
 * worked out from a placeholder. The rows themselves are not read here: the
 * trainer is what checks them, and the count is what the file declares.
 *
 * A footer that cannot be read leaves the count unknown (rowCount null),
 * which callers must treat as "not known", never as zero: see
 * knownDatasetRowCount.
 */
export async function validateParquetObject(
  store: Pick<ObjectStore, "getStream">,
  key: string,
  sizeBytes: number,
  options: { maxRows?: number } = {},
): Promise<DatasetValidationResult> {
  const checker = new RowChecker();
  const warnings: ValidationWarning[] = [];
  let recognised = false;
  let rows: bigint | null = null;
  // Smallest possible file: magic, a 4-byte footer length, magic.
  if (sizeBytes >= 12) {
    const head = await readAll(await store.getStream(key, { start: 0, end: 3 }), 4);
    // The last eight bytes: the footer's length, then the magic.
    const tail = await readAll(
      await store.getStream(key, { start: sizeBytes - 8, end: sizeBytes - 1 }),
      8,
    );
    recognised =
      tail.length === 8 &&
      head.toString("latin1") === PARQUET_MAGIC &&
      tail.subarray(4).toString("latin1") === PARQUET_MAGIC;
    if (recognised) {
      const footerBytes = tail.readUInt32LE(0);
      if (footerBytes > 0 && footerBytes <= sizeBytes - 12) {
        const start = sizeBytes - 8 - footerBytes;
        const wanted = Math.min(footerBytes, MAX_PARQUET_FOOTER_BYTES);
        rows = parseParquetRowCount(
          await readAll(await store.getStream(key, { start, end: start + wanted - 1 }), wanted),
        );
      }
    }
  }

  const maxRows = Math.min(options.maxRows ?? MAX_COUNTABLE_ROWS, MAX_COUNTABLE_ROWS);
  let rowLimitExceeded = false;
  if (!recognised) {
    checker.addError({
      message: "File is not a Parquet file (the PAR1 marker is missing at its start or end)",
    });
  } else if (rows === null || rows < 0n) {
    rows = null;
    warnings.push({
      message:
        "The rows of this Parquet file could not be counted from its footer. They are checked when training starts.",
      severity: "warning",
    });
  } else if (rows === 0n) {
    checker.addError({ message: "Parquet file has no rows" });
  } else if (rows > BigInt(maxRows)) {
    rowLimitExceeded = true;
    checker.addError({ message: `Dataset has more than ${maxRows} rows` });
  } else {
    warnings.push({
      message:
        "Rows in a Parquet file are counted from its footer but not checked here; they are checked when training starts.",
      severity: "warning",
    });
  }

  const isValid = checker.errorCount === 0;
  return {
    isValid,
    format: "parquet",
    fileType: "parquet",
    schemaFormat: "unknown",
    rowCount: recognised && rows !== null && !rowLimitExceeded ? Number(rows) : null,
    sizeBytes,
    errors: checker.errors,
    errorCount: checker.errorCount,
    warnings,
    sampleRows: [],
    schema: { fields: [], detectedFormat: "unknown" },
    stats: null,
    rowLimitExceeded,
    peakBufferedBytes: 0,
    // One pass over the whole object, kept only when the file will be used.
    contentSha256: isValid ? await sha256OfStream(await store.getStream(key)) : null,
  };
}

async function sha256OfStream(stream: AsyncIterable<Buffer | Uint8Array | string>) {
  const hash = createHash("sha256");
  for await (const piece of stream) hash.update(piece);
  return hash.digest("hex");
}

async function readAll(stream: AsyncIterable<Buffer | Uint8Array | string>, limit: number) {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const piece of stream) {
    const chunk = typeof piece === "string" ? Buffer.from(piece, "latin1") : Buffer.from(piece);
    parts.push(chunk);
    size += chunk.length;
    if (size >= limit) break;
  }
  return Buffer.concat(parts).subarray(0, limit);
}

// ============================================
// Helper Functions
// ============================================

export function detectFormat(row: Record<string, any>): DatasetSchemaFormat {
  if ("instruction" in row && "output" in row) {
    return "alpaca";
  }
  if ("conversations" in row && Array.isArray(row.conversations)) {
    return "sharegpt";
  }
  if ("prompt" in row && "completion" in row) {
    return "completion";
  }
  if ("text" in row) {
    return "text";
  }
  return "unknown";
}

function validateRow(
  row: Record<string, any>,
  format: DatasetRowFormat,
  rowNumber: number
): Array<Omit<ValidationError, "severity">> {
  const errors: Array<Omit<ValidationError, "severity">> = [];
  const schema = FORMAT_SCHEMAS[format];

  for (const field of schema.fields) {
    if (field.required && !(field.name in row)) {
      errors.push({
        row: rowNumber,
        field: field.name,
        message: `Missing required field: ${field.name}`,
      });
    } else if (field.name in row) {
      const value = row[field.name];
      if (field.type === "string" && typeof value !== "string") {
        errors.push({
          row: rowNumber,
          field: field.name,
          message: `Field ${field.name} should be a string`,
        });
      } else if (field.type === "string" && field.required && value.trim() === "") {
        // Nothing to learn from an empty prompt or answer; the trainer would
        // drop the row, so it is not counted as one here either.
        errors.push({
          row: rowNumber,
          field: field.name,
          message: `Field ${field.name} is empty`,
        });
      } else if (field.type === "array" && !Array.isArray(value)) {
        errors.push({
          row: rowNumber,
          field: field.name,
          message: `Field ${field.name} should be an array`,
        });
      }
    }
  }

  // Format-specific validation
  if (format === "sharegpt" && Array.isArray(row.conversations)) {
    let answers = 0;
    for (let i = 0; i < row.conversations.length; i++) {
      const conv = row.conversations[i];
      if (
        typeof conv !== "object" ||
        conv === null ||
        typeof conv.from !== "string" ||
        typeof conv.value !== "string" ||
        !conv.from ||
        !conv.value
      ) {
        errors.push({
          row: rowNumber,
          field: `conversations[${i}]`,
          message: "Conversation entries must have 'from' and 'value' fields",
        });
        continue;
      }
      if (!["human", "gpt", "system"].includes(conv.from)) {
        errors.push({
          row: rowNumber,
          field: `conversations[${i}].from`,
          message: `Invalid role: ${conv.from}. Expected: human, gpt, or system`,
        });
      }
      if (conv.from === "gpt") answers += 1;
    }
    // Training learns the gpt turns only; a conversation without one teaches
    // nothing. Reported only when the entries themselves were sound.
    if (errors.length === 0 && answers === 0) {
      errors.push({
        row: rowNumber,
        field: "conversations",
        message: "Conversation has no 'gpt' turn to learn from",
      });
    }
  }

  return errors;
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  result.push(current.trim());
  return result;
}

// ============================================
// Dataset records
// ============================================

/** A row of the datasets table, as this service needs it. */
export interface DatasetRecord {
  id: string;
  orgId: string;
  name: string;
  description: string | null;
  storageType: string;
  storageUrl: string;
  /** What the uploader declared. Never overwritten. */
  format: string;
  fileType: string;
  schemaFormat: string | null;
  sizeBytes: bigint;
  rowCount: number;
  /** false when the rows could not be counted (Parquet): rowCount is then 0. */
  rowCountKnown: boolean;
  avgTokensPerRow: number | null;
  totalTokens: bigint | null;
  /**
   * sha256 (hex) of the bytes the last validation read, and the store's ETag
   * of the object at that moment. null until a validation read the whole
   * object. See datasetObjectState.
   */
  contentSha256: string | null;
  contentEtag: string | null;
  isValidated: boolean;
  validationErrors: unknown;
  sampleRows: unknown;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/**
 * A dataset without its two JSON columns (the sample rows and the errors of
 * the last validation). A list reads this: those columns are only for the
 * page of one dataset.
 */
export type DatasetSummaryRecord = Omit<DatasetRecord, "validationErrors" | "sampleRows">;

export interface NewDatasetRecord {
  id: string;
  orgId: string;
  name: string;
  description: string | undefined;
  storageType: string;
  storageUrl: string;
  format: string;
  fileType: DatasetFileType;
}

export interface DatasetValidationUpdate {
  isValidated: boolean;
  rowCount: number;
  rowCountKnown: boolean;
  sizeBytes: bigint;
  /** undefined leaves the stored value alone. */
  schemaFormat?: string | null;
  avgTokensPerRow: number | null;
  totalTokens: bigint | null;
  /** What was read, so later readers can tell the object is still the same. */
  contentSha256: string | null;
  contentEtag: string | null;
  /** null clears the errors of an earlier validation. */
  validationErrors: ValidationError[] | null;
  sampleRows: Record<string, any>[];
}

/** The name is held by another live dataset of the organization. */
export class DatasetNameTakenError extends Error {
  constructor() {
    super("Dataset name is taken");
    this.name = "DatasetNameTakenError";
  }
}

/**
 * A training job in one of these states is finished and no longer needs its
 * dataset. Every other state (today's and any the job service adds) holds
 * the dataset against deletion.
 */
export const FINISHED_TRAINING_JOB_STATUSES = ["completed", "failed", "cancelled"] as const;

/**
 * Persistence the dataset service needs. Every method sees LIVE datasets
 * only: a soft-deleted row does not exist as far as callers can tell.
 */
export interface DatasetDb {
  /** Without the JSON columns: see DatasetSummaryRecord. */
  list(orgId: string): Promise<DatasetSummaryRecord[]>;
  find(orgId: string, datasetId: string): Promise<DatasetRecord | null>;
  nameTaken(orgId: string, name: string): Promise<boolean>;
  /** Throws DatasetNameTakenError when a live dataset already has the name. */
  create(data: NewDatasetRecord): Promise<DatasetRecord>;
  /** false when the dataset was deleted meanwhile. */
  saveValidation(orgId: string, datasetId: string, update: DatasetValidationUpdate): Promise<boolean>;
  /** Training jobs on this dataset that have not finished. */
  countUnfinishedJobs(datasetId: string): Promise<number>;
  /**
   * Mark the dataset deleted and free its name, in ONE conditional write
   * that matches only a live dataset with no unfinished job. false means
   * nothing was written: the dataset is gone already, or a job holds it.
   */
  softDeleteIfUnused(orgId: string, datasetId: string, now: Date): Promise<boolean>;
}

export interface DatasetLimits {
  maxBytes: number;
  maxRows: number;
}

export interface DatasetDeps {
  db: DatasetDb;
  getStore: () => ObjectStore | null;
  getLimits: () => DatasetLimits;
  /** services/objectStore.ts issueTransferUrl, bound to the same store. */
  issueUploadUrl: (args: {
    key: string;
    ttlSeconds: number;
    maxBytes: number;
    contentType: string;
    contentLength: number;
  }) => Promise<TransferUrl>;
  now: () => Date;
  newId: () => string;
}

/** How long an upload link lives. The caller of the store decides; this is ours. */
export const DATASET_UPLOAD_TTL_SECONDS = 60 * 60;

/** A refusal: the HTTP status and the body the route sends. */
export interface DatasetRefusal {
  ok: false;
  status: number;
  body: { error: string; message: string } & Record<string, unknown>;
}

function refuse(
  status: number,
  error: string,
  message: string,
  extra: Record<string, unknown> = {},
): DatasetRefusal {
  return { ok: false, status, body: { error, message, ...extra } };
}

const STORAGE_NOT_CONFIGURED = () =>
  refuse(
    503,
    "dataset_storage_not_configured",
    "Dataset uploads are temporarily unavailable. Nothing was saved. Try again later.",
  );

const NOT_FOUND = () => refuse(404, "dataset_not_found", "Dataset not found");

// ============================================
// Serialisation
// ============================================

/** What the list endpoint returns for one dataset. */
export function serializeDataset(d: DatasetSummaryRecord) {
  return {
    id: d.id,
    name: d.name,
    description: d.description,
    format: d.format,
    fileType: d.fileType,
    schemaFormat: d.schemaFormat,
    // null, not 0: an unknown count must not read as an empty dataset.
    rowCount: d.rowCountKnown ? d.rowCount : null,
    sizeBytes: Number(d.sizeBytes),
    avgTokensPerRow: d.avgTokensPerRow,
    totalTokens: d.totalTokens === null ? null : Number(d.totalTokens),
    contentSha256: d.contentSha256,
    isValidated: d.isValidated,
    createdAt: d.createdAt,
  };
}

/**
 * The row count a price or an estimate may be worked out from, or null when
 * there is none: the dataset is not validated, or its rows could not be
 * counted. The stored 0 of an uncounted dataset is a placeholder and must
 * never reach a cost formula; every caller that prices goes through here and
 * refuses on null.
 */
export function knownDatasetRowCount(
  d: Pick<DatasetRecord, "rowCount" | "rowCountKnown" | "isValidated">,
): number | null {
  return d.isValidated && d.rowCountKnown && d.rowCount > 0 ? d.rowCount : null;
}

/** The refusal a pricing route sends when knownDatasetRowCount is null. */
export function rowCountUnknownRefusal(): DatasetRefusal {
  return refuse(
    422,
    "dataset_row_count_unknown",
    "The rows of this dataset could not be counted, so its training cost cannot be worked out. Upload it as JSON Lines or CSV, or as a Parquet file with a readable footer.",
  );
}

export function serializeDatasetDetail(d: DatasetRecord) {
  return {
    ...serializeDataset(d),
    storageType: d.storageType,
    validationErrors: d.validationErrors,
    sampleRows: d.sampleRows,
    updatedAt: d.updatedAt,
  };
}

/** What a page needs to decide whether to offer an upload at all. */
export function describeDatasetStorage(deps: Pick<DatasetDeps, "getStore" | "getLimits">) {
  const store = deps.getStore();
  const limits = deps.getLimits();
  return {
    configured: store !== null,
    maxDatasetBytes: limits.maxBytes,
    maxDatasetRows: limits.maxRows,
  };
}

// ============================================
// Create (issue an upload URL)
// ============================================

export interface CreateDatasetInput {
  name: string;
  description?: string;
  fileName: string;
  /** Exact size of the file about to be uploaded. */
  sizeBytes: number;
  /** Rows the client counted, when it did. Checked against the limit. */
  rowCount?: number;
  fileType?: string;
  /** Declared format: a file type or a row format. Stored as given. */
  format?: string;
  contentType?: string;
}

export type CreateDatasetResult =
  | { ok: true; dataset: DatasetRecord; upload: TransferUrl }
  | DatasetRefusal;

const CONTENT_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;

/**
 * Refusals, in order, all before a URL is issued or a row written:
 * 503 storage, 400 file type, 413 size, 413 rows, 409 name.
 */
export async function createDataset(
  deps: DatasetDeps,
  orgId: string,
  input: CreateDatasetInput,
): Promise<CreateDatasetResult> {
  const store = deps.getStore();
  if (!store) return STORAGE_NOT_CONFIGURED();

  const fileType = resolveDatasetFileType(input);
  if (!fileType) {
    return refuse(
      400,
      "unsupported_file_type",
      "Unsupported file type. Upload a .jsonl, .csv or .parquet file.",
    );
  }

  const limits = deps.getLimits();
  if (input.sizeBytes > limits.maxBytes) {
    return refuse(
      413,
      "dataset_too_large",
      `Dataset is larger than the ${limits.maxBytes} byte limit.`,
      { maxBytes: limits.maxBytes },
    );
  }
  if (input.rowCount !== undefined && input.rowCount > limits.maxRows) {
    return refuse(
      413,
      "dataset_too_many_rows",
      `Dataset has more than the ${limits.maxRows} rows allowed.`,
      { maxRows: limits.maxRows },
    );
  }

  const nameTaken = () =>
    refuse(409, "dataset_name_taken", `Dataset '${input.name}' already exists`);
  if (await deps.db.nameTaken(orgId, input.name)) return nameTaken();

  const datasetId = deps.newId();
  const key = `datasets/${orgId}/${datasetId}/data.${fileType}`;
  const contentType =
    input.contentType && CONTENT_TYPE.test(input.contentType)
      ? input.contentType
      : "application/octet-stream";

  // The URL comes first: if signing fails there is no row left behind.
  const upload = await deps.issueUploadUrl({
    key,
    ttlSeconds: DATASET_UPLOAD_TTL_SECONDS,
    maxBytes: limits.maxBytes,
    contentType,
    contentLength: input.sizeBytes,
  });

  let dataset: DatasetRecord;
  try {
    dataset = await deps.db.create({
      id: datasetId,
      orgId,
      name: input.name,
      description: input.description,
      storageType: store.kind,
      storageUrl: `store://${key}`,
      format: input.format ?? fileType,
      fileType,
    });
  } catch (err) {
    // Two uploads racing for one name: the database's unique index decides.
    if (err instanceof DatasetNameTakenError) return nameTaken();
    throw err;
  }

  logger.info({ datasetId: dataset.id, name: input.name, fileType }, "Dataset created");
  return { ok: true, dataset, upload };
}

// ============================================
// Validate
// ============================================

export type ValidateDatasetResult =
  | { ok: true; validation: DatasetValidationResult }
  | DatasetRefusal;

/**
 * Read the stored object end to end and record what it holds. Safe to run
 * any number of times: the parser is chosen by fileType and the declared
 * format is never touched, so a second run sees what the first one saw.
 */
export async function validateStoredDataset(
  deps: DatasetDeps,
  orgId: string,
  datasetId: string,
): Promise<ValidateDatasetResult> {
  const dataset = await deps.db.find(orgId, datasetId);
  if (!dataset) return NOT_FOUND();

  const store = deps.getStore();
  if (!store) return STORAGE_NOT_CONFIGURED();

  const notUploaded = () =>
    refuse(
      409,
      "dataset_not_uploaded",
      "The dataset file has not been uploaded yet. Upload it, then validate.",
    );
  const key = datasetObjectKey(dataset.storageUrl, store);
  if (!key) return notUploaded();

  const limits = deps.getLimits();
  const fileType = resolveDatasetFileType({
    fileType: dataset.fileType,
    fileName: dataset.storageUrl,
    format: dataset.format,
  }) ?? "jsonl";

  const rejectOverLimit = async (
    error: string,
    message: string,
    sizeBytes: number,
    extra: Record<string, unknown>,
  ) => {
    // Over the limit means the object does not stay: nothing may train on it
    // and nothing should pay to keep it.
    await deleteDatasetObject(dataset.storageUrl, store);
    await deps.db.saveValidation(orgId, datasetId, {
      isValidated: false,
      rowCount: 0,
      rowCountKnown: true,
      sizeBytes: BigInt(sizeBytes),
      avgTokensPerRow: null,
      totalTokens: null,
      contentSha256: null,
      contentEtag: null,
      validationErrors: [{ message, severity: "error" }],
      sampleRows: [],
    });
    return refuse(413, error, message, extra);
  };

  let validation: DatasetValidationResult;
  let etag: string | null;
  try {
    const head = await store.head(key);
    if (!head) return notUploaded();

    if (head.size > limits.maxBytes) {
      return rejectOverLimit(
        "dataset_too_large",
        `Dataset is larger than the ${limits.maxBytes} byte limit. The file was removed.`,
        head.size,
        { maxBytes: limits.maxBytes },
      );
    }

    etag = head.etag ?? null;
    validation =
      fileType === "parquet"
        ? await validateParquetObject(store, key, head.size, { maxRows: limits.maxRows })
        : await validateDatasetStream(await store.getStream(key), {
            fileType,
            sizeBytes: head.size,
            maxRows: limits.maxRows,
            declaredFormat: dataset.format,
          });

    if (validation.rowLimitExceeded) {
      return rejectOverLimit(
        "dataset_too_many_rows",
        `Dataset has more than the ${limits.maxRows} rows allowed. The file was removed.`,
        head.size,
        { maxRows: limits.maxRows },
      );
    }
  } catch (err) {
    if (err instanceof ObjectNotFoundError) return notUploaded();
    // The store failing is not the uploader's fault and says nothing about
    // the data: the row keeps whatever it held.
    logger.error({ err, datasetId }, "Dataset validation could not read the object");
    return refuse(
      503,
      "dataset_storage_unavailable",
      "The dataset could not be read from storage. Try again in a moment.",
    );
  }

  const saved = await deps.db.saveValidation(orgId, datasetId, {
    isValidated: validation.isValid,
    rowCount: validation.rowCount ?? 0,
    rowCountKnown: validation.rowCount !== null,
    sizeBytes: BigInt(validation.sizeBytes),
    schemaFormat: validation.schemaFormat === "unknown" ? null : validation.schemaFormat,
    avgTokensPerRow: validation.stats?.avgTokensPerRow ?? null,
    totalTokens: validation.stats ? BigInt(validation.stats.totalTokens) : null,
    // Bound to what was read. A validation that did not read to the end
    // (and is invalid) leaves nothing to pin a run to.
    contentSha256: validation.contentSha256,
    contentEtag: validation.contentSha256 ? etag : null,
    validationErrors: validation.errors.length > 0 ? validation.errors : null,
    sampleRows: validation.sampleRows,
  });
  if (!saved) return NOT_FOUND();

  logger.info(
    { datasetId, isValid: validation.isValid, rowCount: validation.rowCount },
    "Dataset validated",
  );
  return { ok: true, validation };
}

// ============================================
// Is the object still what was validated?
// ============================================

export type DatasetObjectState =
  /** Same size and (where the store reports one) same ETag as when validated. */
  | "unchanged"
  /** Replaced since validation: the stored counts describe other bytes. */
  | "changed"
  | "missing"
  /** Never validated to the end, so there is nothing to compare with. */
  | "not_validated";

/**
 * Compare the stored object with what the last validation read, by one HEAD.
 *
 * An upload link can be used again until it expires, so a validated dataset
 * can have its object replaced. This is the cheap check for a caller about
 * to price or launch a run: anything but "unchanged" means validate again
 * first. It is a courtesy, not the guarantee - the guarantee is passing
 * Dataset.contentSha256 to the trainer as DATASET_SHA256, which refuses any
 * other bytes however late they were swapped in.
 */
export async function datasetObjectState(
  store: Pick<ObjectStore, "head">,
  dataset: Pick<
    DatasetRecord,
    "storageUrl" | "sizeBytes" | "contentSha256" | "contentEtag" | "isValidated"
  >,
): Promise<DatasetObjectState> {
  if (!dataset.isValidated || !dataset.contentSha256) return "not_validated";
  const key = datasetObjectKey(dataset.storageUrl, store as ObjectStore);
  const head = key ? await store.head(key) : null;
  if (!head) return "missing";
  if (BigInt(head.size) !== dataset.sizeBytes) return "changed";
  if (dataset.contentEtag && head.etag && head.etag !== dataset.contentEtag) return "changed";
  return "unchanged";
}

// ============================================
// Delete
// ============================================

export type DeleteDatasetResult =
  | { ok: true; objectDeleted: boolean }
  | DatasetRefusal;

/**
 * Soft delete: the row stays (finished jobs still point at it) but is hidden
 * and its name is free again; the stored object is removed. Refused only
 * while a job that has not finished uses the dataset.
 */
export async function deleteDataset(
  deps: DatasetDeps,
  orgId: string,
  datasetId: string,
): Promise<DeleteDatasetResult> {
  const dataset = await deps.db.find(orgId, datasetId);
  if (!dataset) return NOT_FOUND();

  const deleted = await deps.db.softDeleteIfUnused(orgId, datasetId, deps.now());
  if (!deleted) {
    // The conditional write matched nothing. Say why.
    const activeJobs = await deps.db.countUnfinishedJobs(datasetId);
    if (activeJobs > 0) {
      return refuse(
        409,
        "dataset_in_use",
        `Dataset is used by ${activeJobs} training job(s) that have not finished and cannot be deleted yet.`,
        { activeJobs },
      );
    }
    return NOT_FOUND();
  }

  // After the row, never before: a failed object delete leaves an orphan to
  // sweep (logged with its URL), not a dataset that lists but cannot train.
  const objectDeleted = await deleteDatasetObject(dataset.storageUrl, deps.getStore());
  logger.info({ datasetId, objectDeleted }, "Dataset deleted");
  return { ok: true, objectDeleted };
}
