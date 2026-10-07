/**
 * The offering editor's form state and its translation to and from the
 * API's shape. Pure, so what the editor sends is tested without a browser.
 */

import type {
  CreateOfferingInput,
  DeliverableCheck,
  OfferingContentInput,
  OfferingOutputFormat,
  OfferingProductKind,
  PublisherOffering,
} from "./api";
import {
  JOB_MAX_PRICE_CENTS,
  JOB_MAX_SLA_SECONDS,
  JOB_MIN_PRICE_CENTS,
  JOB_MIN_SLA_SECONDS,
  dollarsToCents,
  formatCents,
  formatDuration,
} from "./jobs";

export type SlaUnit = "minutes" | "hours" | "days";
const UNIT_SECONDS: Record<SlaUnit, number> = { minutes: 60, hours: 3_600, days: 86_400 };

export type CheckType = DeliverableCheck["type"];

/** One row of the checks builder. `value` is text for every type; json_schema keeps its schema there as JSON. */
export interface CheckDraft {
  type: CheckType;
  value: string;
  label: string;
}

export interface OfferingDraft {
  productKind: OfferingProductKind;
  productId: string;
  title: string;
  description: string;
  price: string;
  slaAmount: string;
  slaUnit: SlaUnit;
  inputSchema: string;
  sampleInputs: string;
  instructions: string;
  checks: CheckDraft[];
  outputFormat: OfferingOutputFormat;
  allowedTools: string;
  maxAttempts: string;
  maxConcurrentJobs: string;
}

export const CHECK_TYPES: Array<{ type: CheckType; label: string; placeholder: string }> = [
  { type: "contains", label: "Contains", placeholder: "Text the result must contain" },
  { type: "not_contains", label: "Does not contain", placeholder: "Text the result must not contain" },
  { type: "min_length", label: "At least this long", placeholder: "Characters, e.g. 200" },
  { type: "max_length", label: "At most this long", placeholder: "Characters, e.g. 4000" },
  { type: "regex", label: "Matches a pattern", placeholder: "A regular expression, e.g. ^Summary:" },
  { type: "json_schema", label: "Is JSON in this shape", placeholder: '{"type":"object","required":["score"]}' },
  { type: "exact", label: "Is exactly", placeholder: "The exact expected text" },
];

export const STARTER_SCHEMA = JSON.stringify(
  {
    type: "object",
    required: ["topic"],
    properties: {
      topic: { type: "string", title: "Topic", description: "What the job is about", maxLength: 200 },
    },
  },
  null,
  2,
);

export function emptyDraft(): OfferingDraft {
  return {
    productKind: "agent",
    productId: "",
    title: "",
    description: "",
    price: "5.00",
    slaAmount: "1",
    slaUnit: "hours",
    inputSchema: STARTER_SCHEMA,
    sampleInputs: "",
    instructions: "",
    checks: [],
    outputFormat: "text",
    allowedTools: "",
    maxAttempts: "2",
    maxConcurrentJobs: "5",
  };
}

/** The largest unit that divides the delivery time evenly, so 3600 reads "1 hours", not "60 minutes". */
function splitSla(seconds: number): { slaAmount: string; slaUnit: SlaUnit } {
  for (const unit of ["days", "hours", "minutes"] as const) {
    if (seconds % UNIT_SECONDS[unit] === 0) return { slaAmount: String(seconds / UNIT_SECONDS[unit]), slaUnit: unit };
  }
  return { slaAmount: String(Math.ceil(seconds / 60)), slaUnit: "minutes" };
}

function checkToDraft(check: DeliverableCheck): CheckDraft {
  return {
    type: check.type,
    value:
      check.type === "json_schema"
        ? JSON.stringify(check.schema, null, 2)
        : check.type === "regex"
          ? check.pattern
          : String(check.value),
    label: check.label ?? "",
  };
}

export function draftFromOffering(offering: PublisherOffering): OfferingDraft {
  return {
    productKind: offering.productKind,
    productId: offering.agentId ?? offering.orchestrationId ?? offering.deploymentId ?? "",
    title: offering.title,
    description: offering.description,
    price: (offering.priceCents / 100).toFixed(2),
    ...splitSla(offering.slaSeconds),
    inputSchema: offering.inputSchema ? JSON.stringify(offering.inputSchema, null, 2) : "",
    sampleInputs: offering.sampleInputs.length > 0 ? JSON.stringify(offering.sampleInputs, null, 2) : "",
    instructions: offering.instructions ?? "",
    checks: offering.deliverableChecks.map(checkToDraft),
    outputFormat: offering.outputFormat,
    allowedTools: offering.allowedTools.join(", "),
    maxAttempts: String(offering.maxAttempts),
    maxConcurrentJobs: String(offering.maxConcurrentJobs),
  };
}

/**
 * Tools that send data to an address the model chooses. They never run in a
 * paid job unless the offering names them (the API's `sendsOutbound` skills).
 */
export const OUTBOUND_TOOLS: readonly string[] = ["http_request"];

function toolNames(text: string): string[] {
  return text
    .split(",")
    .map((tool) => tool.trim())
    .filter((tool) => tool.length > 0);
}

/** The outbound tools a draft's "tools the agent may use" allows, for the editor's warning. */
export function outboundToolsAllowed(draft: Pick<OfferingDraft, "productKind" | "allowedTools">): string[] {
  if (draft.productKind !== "agent") return [];
  return toolNames(draft.allowedTools).filter((tool) => OUTBOUND_TOOLS.includes(tool));
}

export type DraftField = keyof OfferingDraft | `checks.${number}`;

export interface BuiltOffering {
  content: OfferingContentInput;
  /** Field -> problem. Empty when the draft can be sent. */
  errors: Partial<Record<DraftField, string>>;
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function wholeNumber(text: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const value = Number(text.trim());
  return value >= min && value <= max ? value : null;
}

/**
 * The draft as the API takes it. Only what can be known without the server
 * is checked here (amounts in range, JSON that parses); whether a schema or
 * a pattern compiles is the server's answer.
 */
export function buildOffering(draft: OfferingDraft): BuiltOffering {
  const errors: BuiltOffering["errors"] = {};

  const title = draft.title.trim();
  if (title.length < 3 || title.length > 100) errors.title = "A title is 3 to 100 characters";
  const description = draft.description.trim();
  if (description.length < 10 || description.length > 5000) errors.description = "A description is 10 to 5,000 characters";

  const priceCents = dollarsToCents(draft.price);
  if (priceCents === null || priceCents < JOB_MIN_PRICE_CENTS || priceCents > JOB_MAX_PRICE_CENTS) {
    errors.price = `A job costs between ${formatCents(JOB_MIN_PRICE_CENTS)} and ${formatCents(JOB_MAX_PRICE_CENTS)}`;
  }

  const amount = Number(draft.slaAmount.trim());
  const slaSeconds = Math.round(amount * UNIT_SECONDS[draft.slaUnit]);
  if (
    !/^\d+(\.\d+)?$/.test(draft.slaAmount.trim()) ||
    slaSeconds < JOB_MIN_SLA_SECONDS ||
    slaSeconds > JOB_MAX_SLA_SECONDS
  ) {
    errors.slaAmount = `Delivery time is between ${formatDuration(JOB_MIN_SLA_SECONDS)} and ${formatDuration(JOB_MAX_SLA_SECONDS)}`;
  }

  let inputSchema: Record<string, unknown> | null = null;
  if (draft.inputSchema.trim()) {
    const parsed = parseJson(draft.inputSchema);
    if (!parsed.ok || !isObject(parsed.value)) errors.inputSchema = "The input schema must be a JSON object";
    else inputSchema = parsed.value;
  }

  let sampleInputs: Array<Record<string, unknown>> = [];
  if (draft.sampleInputs.trim()) {
    const parsed = parseJson(draft.sampleInputs);
    const list = parsed.ok ? (Array.isArray(parsed.value) ? parsed.value : [parsed.value]) : null;
    if (!list || !list.every(isObject)) errors.sampleInputs = "Samples are a JSON array of objects, like [{\"topic\": \"…\"}]";
    else if (list.length > 5) errors.sampleInputs = "At most 5 samples";
    else sampleInputs = list;
  }

  const deliverableChecks: DeliverableCheck[] = [];
  draft.checks.forEach((check, index) => {
    const label = check.label.trim() ? { label: check.label.trim() } : {};
    const value = check.value.trim();
    if (!value) {
      errors[`checks.${index}`] = "This check needs a value";
      return;
    }
    if (check.type === "min_length" || check.type === "max_length") {
      const length = wholeNumber(value, 1, 512 * 1024);
      if (length === null) errors[`checks.${index}`] = "Enter a number of characters";
      else deliverableChecks.push({ type: check.type, value: length, ...label });
    } else if (check.type === "json_schema") {
      const parsed = parseJson(value);
      if (!parsed.ok || !isObject(parsed.value)) errors[`checks.${index}`] = "The schema must be a JSON object";
      else deliverableChecks.push({ type: "json_schema", schema: parsed.value, ...label });
    } else if (check.type === "regex") {
      deliverableChecks.push({ type: "regex", pattern: value, ...label });
    } else {
      // Not trimmed: leading or trailing space can be what an exact match is about.
      deliverableChecks.push({ type: check.type, value: check.type === "exact" ? check.value : value, ...label });
    }
  });

  const maxAttempts = wholeNumber(draft.maxAttempts, 1, 3);
  if (maxAttempts === null) errors.maxAttempts = "1 to 3";
  const maxConcurrentJobs = wholeNumber(draft.maxConcurrentJobs, 1, 50);
  if (maxConcurrentJobs === null) errors.maxConcurrentJobs = "1 to 50";

  const allowedTools = toolNames(draft.allowedTools);

  return {
    errors,
    content: {
      title,
      description,
      priceCents: priceCents ?? 0,
      slaSeconds,
      inputSchema,
      sampleInputs,
      instructions: draft.instructions.trim() ? draft.instructions : null,
      deliverableChecks,
      outputFormat: draft.outputFormat,
      // Only an agent has tools an offering can narrow.
      allowedTools: draft.productKind === "agent" ? allowedTools : [],
      maxAttempts: maxAttempts ?? 1,
      maxConcurrentJobs: maxConcurrentJobs ?? 1,
    },
  };
}

/** The create body: the content plus the one product id its kind names. */
export function toCreateInput(draft: OfferingDraft, content: OfferingContentInput): CreateOfferingInput {
  const product =
    draft.productKind === "agent"
      ? { agentId: draft.productId }
      : draft.productKind === "workflow"
        ? { orchestrationId: draft.productId }
        : { deploymentId: draft.productId };
  return { productKind: draft.productKind, ...product, ...content };
}

/**
 * Which check rows the server refused. A check problem is reported as
 * "/<index>/..." (the row, then the key inside it).
 */
export function checkIssues(issues: Array<{ path: string; message: string }>): Partial<Record<DraftField, string>> {
  const byRow: Partial<Record<DraftField, string>> = {};
  for (const issue of issues) {
    const index = /^\/(\d+)(?:\/|$)/.exec(issue.path)?.[1];
    if (index === undefined) continue;
    const key = `checks.${Number(index)}` as const;
    byRow[key] = byRow[key] ? `${byRow[key]}; ${issue.message}` : issue.message;
  }
  return byRow;
}

/** Which part of the editor a refusal's code is about. */
export function serverIssueField(code: string | null): DraftField | null {
  switch (code) {
    case "invalid_input_schema":
      return "inputSchema";
    case "invalid_sample_input":
      return "sampleInputs";
    case "product_not_found":
    case "product_not_sellable":
      return "productId";
    default:
      return null;
  }
}
