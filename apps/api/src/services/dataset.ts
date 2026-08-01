// Dataset Service for WheelsAI
// Handles dataset upload, validation, and management

import { createLogger } from "../utils/logger.js";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const logger = createLogger("dataset-service");

// ============================================
// Types
// ============================================

export interface DatasetValidationResult {
  isValid: boolean;
  format: string;
  rowCount: number;
  sizeBytes: number;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  sampleRows: Record<string, any>[];
  schema: DatasetSchema;
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
  detectedFormat: "alpaca" | "sharegpt" | "completion" | "text" | "unknown";
}

export interface UploadUrlResult {
  uploadUrl: string;
  datasetId: string;
  storageUrl: string;
  expiresAt: Date;
}

// ============================================
// S3 Client
// ============================================

const s3Client = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: process.env.AWS_ACCESS_KEY_ID
    ? {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      }
    : undefined,
});

const BUCKET_NAME = process.env.DATASETS_BUCKET || "wheelsai-datasets";

/**
 * Whether dataset storage is actually usable. Without credentials the
 * presign call crashes mid-request with a credential-provider error; the
 * routes use this to refuse up front with an honest 503 instead.
 */
export function isDatasetStorageConfigured(): boolean {
  return Boolean(
    process.env.AWS_ACCESS_KEY_ID &&
      process.env.AWS_SECRET_ACCESS_KEY &&
      process.env.DATASETS_BUCKET,
  );
}

/**
 * Best-effort S3 object deletion for a dataset's storageUrl. Failures are
 * logged, not thrown — an orphaned object must not block the DB delete.
 */
export async function deleteDatasetObject(storageUrl: string): Promise<void> {
  try {
    const { bucket, key } = parseS3Url(storageUrl);
    await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    logger.info({ storageUrl }, "Deleted dataset object from S3");
  } catch (error) {
    logger.warn({ error, storageUrl }, "Failed to delete dataset object from S3");
  }
}

// ============================================
// Expected Schemas by Format
// ============================================

const FORMAT_SCHEMAS: Record<string, DatasetSchema> = {
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

// ============================================
// Upload URL Generation
// ============================================

export async function generateUploadUrl(
  orgId: string,
  fileName: string,
  contentType: string
): Promise<UploadUrlResult> {
  const datasetId = crypto.randomUUID();
  const extension = fileName.split(".").pop() || "jsonl";
  const key = `datasets/${orgId}/${datasetId}/data.${extension}`;

  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    ContentType: contentType,
  });

  const uploadUrl = await getSignedUrl(s3Client, command, {
    expiresIn: 3600, // 1 hour
  });

  const storageUrl = `s3://${BUCKET_NAME}/${key}`;
  const expiresAt = new Date(Date.now() + 3600 * 1000);

  logger.info({ datasetId, key }, "Generated upload URL");

  return {
    uploadUrl,
    datasetId,
    storageUrl,
    expiresAt,
  };
}

// ============================================
// Dataset Validation
// ============================================

export async function validateDataset(
  storageUrl: string,
  declaredFormat?: string
): Promise<DatasetValidationResult> {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  try {
    // Parse S3 URL
    const { bucket, key } = parseS3Url(storageUrl);

    // Get file size
    const headCommand = new HeadObjectCommand({ Bucket: bucket, Key: key });
    const headResult = await s3Client.send(headCommand);
    const sizeBytes = headResult.ContentLength || 0;

    // Download file content (limit to first 10MB for validation)
    const getCommand = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      Range: "bytes=0-10485760", // First 10MB
    });
    const getResult = await s3Client.send(getCommand);
    const content = await getResult.Body?.transformToString();

    if (!content) {
      errors.push({
        message: "Could not read dataset content",
        severity: "error",
      });
      return {
        isValid: false,
        format: "unknown",
        rowCount: 0,
        sizeBytes,
        errors,
        warnings,
        sampleRows: [],
        schema: { fields: [], detectedFormat: "unknown" },
      };
    }

    // Determine format from file extension or content
    const extension = key.split(".").pop()?.toLowerCase();
    const format = declaredFormat || extension || "jsonl";

    if (format === "json" || format === "jsonl") {
      return validateJsonl(content, sizeBytes, errors, warnings);
    } else if (format === "csv") {
      return validateCsv(content, sizeBytes, errors, warnings);
    } else if (format === "parquet") {
      // Parquet validation would require streaming the whole file
      warnings.push({
        message: "Parquet files are not validated in detail; will be checked at training time",
        severity: "warning",
      });
      return {
        isValid: true,
        format: "parquet",
        rowCount: 0,
        sizeBytes,
        errors,
        warnings,
        sampleRows: [],
        schema: { fields: [], detectedFormat: "unknown" },
      };
    }

    errors.push({
      message: `Unsupported format: ${format}`,
      severity: "error",
    });

    return {
      isValid: false,
      format,
      rowCount: 0,
      sizeBytes,
      errors,
      warnings,
      sampleRows: [],
      schema: { fields: [], detectedFormat: "unknown" },
    };
  } catch (error) {
    logger.error({ error, storageUrl }, "Dataset validation failed");
    errors.push({
      message: `Validation error: ${error instanceof Error ? error.message : "Unknown error"}`,
      severity: "error",
    });

    return {
      isValid: false,
      format: "unknown",
      rowCount: 0,
      sizeBytes: 0,
      errors,
      warnings,
      sampleRows: [],
      schema: { fields: [], detectedFormat: "unknown" },
    };
  }
}

// ============================================
// JSONL Validation
// ============================================

export function validateJsonl(
  content: string,
  sizeBytes: number,
  errors: ValidationError[],
  warnings: ValidationWarning[]
): DatasetValidationResult {
  const lines = content.split("\n").filter((l) => l.trim());
  const sampleRows: Record<string, any>[] = [];
  let detectedFormat: "alpaca" | "sharegpt" | "completion" | "text" | "unknown" = "unknown";

  let validRows = 0;
  const maxSamples = 5;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    try {
      const row = JSON.parse(line);

      // Detect format from first valid row
      if (validRows === 0) {
        detectedFormat = detectFormat(row);
      }

      // Validate row against detected format
      const rowErrors = validateRow(row, detectedFormat, i + 1);
      errors.push(...rowErrors);

      if (rowErrors.length === 0) {
        validRows++;
        if (sampleRows.length < maxSamples) {
          sampleRows.push(row);
        }
      }
    } catch (e) {
      errors.push({
        row: i + 1,
        message: `Invalid JSON: ${e instanceof Error ? e.message : "Parse error"}`,
        severity: "error",
      });
    }
  }

  // Check for minimum rows
  if (validRows < 10) {
    warnings.push({
      message: `Dataset has only ${validRows} valid rows. Recommend at least 100 examples for fine-tuning.`,
      severity: "warning",
    });
  }

  // Check for imbalanced data (if applicable)
  if (detectedFormat === "text" && validRows > 100) {
    const avgLength = sampleRows.reduce((sum, r) => sum + (r.text?.length || 0), 0) / sampleRows.length;
    if (avgLength < 100) {
      warnings.push({
        message: "Average text length is very short. Consider longer training examples.",
        severity: "warning",
      });
    }
  }

  return {
    isValid: errors.filter((e) => e.severity === "error").length === 0 && validRows > 0,
    format: "jsonl",
    rowCount: validRows,
    sizeBytes,
    errors,
    warnings,
    sampleRows,
    schema: FORMAT_SCHEMAS[detectedFormat] || { fields: [], detectedFormat },
  };
}

// ============================================
// CSV Validation
// ============================================

export function validateCsv(
  content: string,
  sizeBytes: number,
  errors: ValidationError[],
  warnings: ValidationWarning[]
): DatasetValidationResult {
  const lines = content.split("\n").filter((l) => l.trim());
  const sampleRows: Record<string, any>[] = [];

  if (lines.length < 2) {
    errors.push({
      message: "CSV file must have a header row and at least one data row",
      severity: "error",
    });
    return {
      isValid: false,
      format: "csv",
      rowCount: 0,
      sizeBytes,
      errors,
      warnings,
      sampleRows: [],
      schema: { fields: [], detectedFormat: "unknown" },
    };
  }

  // Parse header
  const header = parseCSVLine(lines[0] ?? "");
  const fields = header.map((name) => ({
    name,
    type: "string" as const,
    required: true,
  }));

  // Detect format from headers
  let detectedFormat: "completion" | "text" | "unknown" = "unknown";
  if (header.includes("prompt") && header.includes("completion")) {
    detectedFormat = "completion";
  } else if (header.includes("text")) {
    detectedFormat = "text";
  }

  let validRows = 0;
  const maxSamples = 5;

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i] ?? "");

    if (values.length !== header.length) {
      errors.push({
        row: i + 1,
        message: `Row has ${values.length} columns, expected ${header.length}`,
        severity: "error",
      });
      continue;
    }

    const row: Record<string, string> = {};
    header.forEach((col, idx) => {
      row[col] = values[idx] ?? "";
    });

    validRows++;
    if (sampleRows.length < maxSamples) {
      sampleRows.push(row);
    }
  }

  return {
    isValid: errors.filter((e) => e.severity === "error").length === 0 && validRows > 0,
    format: "csv",
    rowCount: validRows,
    sizeBytes,
    errors,
    warnings,
    sampleRows,
    schema: { fields, detectedFormat },
  };
}

// ============================================
// Helper Functions
// ============================================

function parseS3Url(url: string): { bucket: string; key: string } {
  if (url.startsWith("s3://")) {
    const parts = url.slice(5).split("/");
    const bucket = parts[0];
    if (!bucket) {
      throw new Error("Invalid S3 URL format");
    }
    return {
      bucket,
      key: parts.slice(1).join("/"),
    };
  }

  // Handle https://bucket.s3.region.amazonaws.com/key format
  const match = url.match(/https?:\/\/([^.]+)\.s3\..*\.amazonaws\.com\/(.+)/);
  if (match?.[1] && match?.[2]) {
    return { bucket: match[1], key: match[2] };
  }

  throw new Error("Invalid S3 URL format");
}

export function detectFormat(row: Record<string, any>): "alpaca" | "sharegpt" | "completion" | "text" | "unknown" {
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
  format: string,
  rowNumber: number
): ValidationError[] {
  const errors: ValidationError[] = [];
  const schema = FORMAT_SCHEMAS[format];

  if (!schema) {
    return errors;
  }

  for (const field of schema.fields) {
    if (field.required && !(field.name in row)) {
      errors.push({
        row: rowNumber,
        field: field.name,
        message: `Missing required field: ${field.name}`,
        severity: "error",
      });
    } else if (field.name in row) {
      const value = row[field.name];
      if (field.type === "string" && typeof value !== "string") {
        errors.push({
          row: rowNumber,
          field: field.name,
          message: `Field ${field.name} should be a string`,
          severity: "error",
        });
      } else if (field.type === "array" && !Array.isArray(value)) {
        errors.push({
          row: rowNumber,
          field: field.name,
          message: `Field ${field.name} should be an array`,
          severity: "error",
        });
      }
    }
  }

  // Format-specific validation
  if (format === "sharegpt" && row.conversations) {
    for (let i = 0; i < row.conversations.length; i++) {
      const conv = row.conversations[i];
      if (!conv.from || !conv.value) {
        errors.push({
          row: rowNumber,
          field: `conversations[${i}]`,
          message: "Conversation entries must have 'from' and 'value' fields",
          severity: "error",
        });
      }
      if (conv.from && !["human", "gpt", "system"].includes(conv.from)) {
        errors.push({
          row: rowNumber,
          field: `conversations[${i}].from`,
          message: `Invalid role: ${conv.from}. Expected: human, gpt, or system`,
          severity: "error",
        });
      }
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
// Dataset Stats
// ============================================

export interface DatasetStats {
  totalTokens: number;
  avgTokensPerRow: number;
  minTokens: number;
  maxTokens: number;
  estimatedTrainingTime: string;
}

export function estimateDatasetStats(
  rowCount: number,
  sampleRows: Record<string, any>[],
  format: string
): DatasetStats {
  // Simple token estimation (chars / 4)
  let totalChars = 0;
  let minChars = Infinity;
  let maxChars = 0;

  for (const row of sampleRows) {
    let rowChars = 0;

    if (format === "alpaca") {
      rowChars = (row.instruction?.length || 0) + (row.input?.length || 0) + (row.output?.length || 0);
    } else if (format === "sharegpt") {
      rowChars = row.conversations?.reduce((sum: number, c: any) => sum + (c.value?.length || 0), 0) || 0;
    } else if (format === "completion") {
      rowChars = (row.prompt?.length || 0) + (row.completion?.length || 0);
    } else {
      rowChars = row.text?.length || 0;
    }

    totalChars += rowChars;
    minChars = Math.min(minChars, rowChars);
    maxChars = Math.max(maxChars, rowChars);
  }

  const avgCharsPerRow = sampleRows.length > 0 ? totalChars / sampleRows.length : 0;
  const avgTokensPerRow = Math.ceil(avgCharsPerRow / 4);
  const totalTokens = rowCount * avgTokensPerRow;

  // Estimate training time (rough: 50k tokens/hour for LoRA)
  const hours = totalTokens * 3 / 50000; // 3 epochs
  const estimatedTrainingTime = hours < 1
    ? `${Math.ceil(hours * 60)} minutes`
    : `${Math.ceil(hours * 10) / 10} hours`;

  return {
    totalTokens,
    avgTokensPerRow,
    minTokens: Math.ceil(minChars / 4),
    maxTokens: Math.ceil(maxChars / 4),
    estimatedTrainingTime,
  };
}
