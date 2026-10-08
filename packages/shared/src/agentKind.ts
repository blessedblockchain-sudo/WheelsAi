/**
 * How an agent is used, and the settings each way of using it carries.
 *
 * An agent is one of three kinds: people talk to it ("conversation"), people
 * give it a task by filling in a short form and get one result back
 * ("task"), or it runs on its own on a schedule ("scheduled"). The kind picks
 * the front door and removes nothing: every agent still answers a chat.
 *
 * The settings live in one JSON value (Agent.kindConfig) with one key per
 * kind, so changing the kind and changing back loses nothing:
 *
 *   { task?: { fields: TaskField[] },
 *     scheduled?: { schedule?: { cronExpression, timezone? }, prompt? } }
 *
 * What is here is the part both sides need to agree on: the form builder in
 * the web app and the API that stores and serves the form. A task's form is
 * a list of fields, in the order its owner arranged them. From that list
 * come the JSON Schema the API checks an input against (taskInputSchema) and
 * the text the model is given (inputAsText).
 *
 * A field's `key` is its name in code: what API callers send and what the
 * model sees. It is made from the field's first label and then stays, so
 * renaming a question on screen never breaks a caller.
 *
 * Self-contained on purpose (no imports), like latency.ts: the API and the
 * web app both import it, and it must run in a browser. The API adds what
 * needs a server (apps/api/src/services/agentKind.ts): proof that the schema
 * compiles, and the check of a suggested schedule.
 */

// ============================================
// Kinds
// ============================================

export const AGENT_KINDS = ["conversation", "task", "scheduled"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/** What an agent is when nothing was said: every agent before kinds existed. */
export const DEFAULT_AGENT_KIND: AgentKind = "conversation";

/** The short badge shown beside an agent's name. */
export const AGENT_KIND_BADGES: Record<AgentKind, string> = {
  conversation: "Chat",
  task: "Task",
  scheduled: "Runs on its own",
};

export function isAgentKind(value: unknown): value is AgentKind {
  return typeof value === "string" && (AGENT_KINDS as readonly string[]).includes(value);
}

// ============================================
// Fields and limits
// ============================================

export const TASK_FIELD_TYPES = ["short_text", "long_text", "number", "choice", "yes_no", "link", "list"] as const;
export type TaskFieldType = (typeof TASK_FIELD_TYPES)[number];

export const TASK_FIELD_TYPE_LABELS: Record<TaskFieldType, string> = {
  short_text: "Short text",
  long_text: "Long text",
  number: "Number",
  choice: "Choice",
  yes_no: "Yes or no",
  link: "Link",
  list: "List",
};

export function isTaskFieldType(value: unknown): value is TaskFieldType {
  return typeof value === "string" && (TASK_FIELD_TYPES as readonly string[]).includes(value);
}

/** Questions in one form. */
export const MAX_TASK_FIELDS = 12;
/** A field's name in code: a lowercase letter, then letters, digits and underscores. */
export const TASK_FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
export const MAX_FIELD_KEY_LENGTH = 40;
/** The whole kindConfig, as UTF-8 JSON. */
export const MAX_KIND_CONFIG_BYTES = 16 * 1024;

export const MAX_FIELD_LABEL_LENGTH = 120;
export const MAX_FIELD_HELP_LENGTH = 300;
export const MIN_CHOICE_OPTIONS = 2;
export const MAX_CHOICE_OPTIONS = 50;
export const MAX_CHOICE_OPTION_LENGTH = 100;
/** What a scheduled agent is told at each run. */
export const MAX_RUN_LINE_LENGTH = 2000;

/** The most an answer may hold, per field type. They become the schema's limits. */
export const SHORT_TEXT_MAX_LENGTH = 200;
export const LONG_TEXT_MAX_LENGTH = 20_000;
export const LINK_MAX_LENGTH = 2048;
export const LIST_MAX_ITEMS = 50;
export const LIST_ITEM_MAX_LENGTH = 500;

// Type aliases, not interfaces: an alias is assignable to a JSON column's
// input type, an interface (which has no index signature) is not.

export type TaskField = {
  /** The name in code. Made from the first label, then kept. */
  key: string;
  label: string;
  type: TaskFieldType;
  required: boolean;
  /** One line under the question. */
  help?: string;
  /** `choice` only: what can be picked, in order. */
  options?: string[];
};

export type TaskKindConfig = {
  fields: TaskField[];
};

/** A suggested schedule. The live one is the agent's scheduled task. */
export type SuggestedSchedule = {
  cronExpression: string;
  timezone?: string;
};

export type ScheduledKindConfig = {
  schedule?: SuggestedSchedule;
  /** What the agent is told at each run. */
  prompt?: string;
};

export type KindConfig = {
  task?: TaskKindConfig;
  scheduled?: ScheduledKindConfig;
};

/** The form an agent has until its owner builds one. */
export const DEFAULT_TASK_FIELDS: readonly TaskField[] = Object.freeze([
  Object.freeze({ key: "your_request", label: "Your request", type: "long_text", required: true } as TaskField),
]);

/** What a scheduled agent is told at each run until its owner writes a line. */
export const DEFAULT_RUN_LINE = "Do your scheduled work now and report what you produced.";

// ============================================
// Words
// ============================================

export type TaskFormProblem =
  | "not_a_list"
  | "no_fields"
  | "too_many_fields"
  | "invalid_field"
  | "label_required"
  | "label_too_long"
  | "invalid_type"
  | "invalid_key"
  | "duplicate_key"
  | "help_too_long"
  | "options_required"
  | "too_many_options"
  | "option_too_long"
  | "not_plain_text";

/** What a person is told about a form that cannot be saved. */
export const TASK_FORM_MESSAGES: Record<TaskFormProblem, string> = {
  not_a_list: "Send the questions as a list.",
  no_fields: "A form needs at least one question.",
  too_many_fields: `A form can have up to ${MAX_TASK_FIELDS} questions.`,
  invalid_field: "This question could not be read.",
  label_required: "Give this question a label.",
  label_too_long: `Keep the label to ${MAX_FIELD_LABEL_LENGTH} characters or fewer.`,
  invalid_type: "Choose a type for this question: short text, long text, number, choice, yes or no, link or list.",
  invalid_key:
    "A name in code starts with a letter and uses only lowercase letters, numbers and underscores, up to 40 characters.",
  duplicate_key: "Two questions have the same name in code. Change one.",
  help_too_long: `Keep the help text to ${MAX_FIELD_HELP_LENGTH} characters or fewer.`,
  options_required: "Add at least two options.",
  too_many_options: `A choice can have up to ${MAX_CHOICE_OPTIONS} options.`,
  option_too_long: `Keep each option to ${MAX_CHOICE_OPTION_LENGTH} characters or fewer.`,
  not_plain_text: "Use plain text on one line here, without line breaks or hidden characters.",
};

export type TaskFieldIssue = {
  /** The question's place in the list sent, or -1 for the form as a whole. */
  index: number;
  /** The part of the question the problem is in. */
  field: "fields" | "label" | "type" | "key" | "help" | "options";
  code: TaskFormProblem;
  message: string;
};

export type NormalizedTaskFields = {
  /** The fields that could be read, normalized. Complete only when `issues` is empty. */
  fields: TaskField[];
  /** Empty when the form can be saved. */
  issues: TaskFieldIssue[];
};

// ============================================
// Keys
// ============================================

/**
 * A name in code from a label: "Code to review" is "code_to_review". Accents
 * are dropped, anything that is not a letter or digit becomes one underscore,
 * and a label with no letters to start from ("2024 budget", "???") gets a
 * leading "q". Always matches TASK_FIELD_KEY_PATTERN.
 */
export function fieldKeyFromLabel(label: string): string {
  const words = String(label ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const lettered = /^[a-z]/.test(words) ? words : words ? `q_${words}` : "question";
  return lettered.slice(0, MAX_FIELD_KEY_LENGTH).replace(/_+$/g, "");
}

/** `base`, or `base_2`, `base_3`… when taken, kept inside the length limit. */
function freeKey(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `_${n}`;
    const candidate = `${base.slice(0, MAX_FIELD_KEY_LENGTH - suffix.length).replace(/_+$/g, "")}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// ============================================
// Normalizing a form
// ============================================

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * True when text holds something that cannot be stored or shown as written:
 * a control character (the database refuses U+0000 in JSON, and the others
 * are invisible on screen and move a terminal's cursor) or half of a
 * surrogate pair. Line breaks and tabs pass only when `multiline` is set.
 */
export function hasUnsafeText(text: string, options: { multiline?: boolean } = {}): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      if (options.multiline && (code === 0x09 || code === 0x0a || code === 0x0d)) continue;
      return true;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return true;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/**
 * The form as it is stored, from what a form builder or an API caller sent.
 *
 * Per question: `label` is needed; `type` is short text when left out;
 * `required` is false unless true; `help` is kept when it says something;
 * `options` are kept for a choice only, trimmed, without blanks or repeats.
 *
 * Keys: a question that arrives with a `key` keeps it, which is what makes a
 * key survive a label edit (the builder sends back the key it was given). A
 * question without one gets a key from its label, moved aside (`topic_2`)
 * when another question already has that name. Two questions that both
 * arrive with the same key are a problem their owner has to settle, since
 * either could be the one callers mean.
 *
 * Nothing is cut to fit: text over a limit is a problem, not a silent trim.
 * The same goes for a label, help text or option that is not plain text on
 * one line (hasUnsafeText): the label is what the model reads before each
 * answer, so a line break in it would change what the model is told.
 */
export function normalizeTaskFields(input: unknown): NormalizedTaskFields {
  const issues: TaskFieldIssue[] = [];
  const problem = (index: number, field: TaskFieldIssue["field"], code: TaskFormProblem) => {
    issues.push({ index, field, code, message: TASK_FORM_MESSAGES[code] });
  };

  if (!Array.isArray(input)) {
    problem(-1, "fields", "not_a_list");
    return { fields: [], issues };
  }
  if (input.length === 0) {
    problem(-1, "fields", "no_fields");
    return { fields: [], issues };
  }
  if (input.length > MAX_TASK_FIELDS) {
    problem(-1, "fields", "too_many_fields");
    return { fields: [], issues };
  }

  // Keys that were sent are settled first, so a key made from a label never
  // takes a name a later question already holds.
  const sentKeys = new Map<string, number>();
  for (const raw of input) {
    if (isObject(raw) && typeof raw.key === "string" && TASK_FIELD_KEY_PATTERN.test(raw.key)) {
      sentKeys.set(raw.key, (sentKeys.get(raw.key) ?? 0) + 1);
    }
  }
  const taken = new Set(sentKeys.keys());

  const fields: TaskField[] = [];
  input.forEach((raw, index) => {
    if (!isObject(raw)) {
      problem(index, "fields", "invalid_field");
      return;
    }
    const before = issues.length;

    const label = trimmed(raw.label);
    if (!label) problem(index, "label", "label_required");
    else if (label.length > MAX_FIELD_LABEL_LENGTH) problem(index, "label", "label_too_long");
    else if (hasUnsafeText(label)) problem(index, "label", "not_plain_text");

    const type: TaskFieldType | null =
      raw.type === undefined || raw.type === null ? "short_text" : isTaskFieldType(raw.type) ? raw.type : null;
    if (type === null) problem(index, "type", "invalid_type");

    let key = "";
    const sentKey = raw.key === undefined || raw.key === null || raw.key === "" ? null : raw.key;
    if (sentKey !== null) {
      if (typeof sentKey !== "string" || !TASK_FIELD_KEY_PATTERN.test(sentKey)) problem(index, "key", "invalid_key");
      else if ((sentKeys.get(sentKey) ?? 0) > 1) problem(index, "key", "duplicate_key");
      else key = sentKey;
    } else if (label) {
      key = freeKey(fieldKeyFromLabel(label), taken);
      taken.add(key);
    }

    const help = trimmed(raw.help);
    if (help.length > MAX_FIELD_HELP_LENGTH) problem(index, "help", "help_too_long");
    else if (hasUnsafeText(help)) problem(index, "help", "not_plain_text");

    let options: string[] | undefined;
    if (type === "choice") {
      const seen = new Set<string>();
      options = [];
      for (const option of Array.isArray(raw.options) ? raw.options : []) {
        const text = typeof option === "number" && Number.isFinite(option) ? String(option) : trimmed(option);
        if (!text || seen.has(text)) continue;
        seen.add(text);
        options.push(text);
      }
      if (options.length < MIN_CHOICE_OPTIONS) problem(index, "options", "options_required");
      else if (options.length > MAX_CHOICE_OPTIONS) problem(index, "options", "too_many_options");
      else if (options.some((option) => option.length > MAX_CHOICE_OPTION_LENGTH)) {
        problem(index, "options", "option_too_long");
      } else if (options.some((option) => hasUnsafeText(option))) {
        problem(index, "options", "not_plain_text");
      }
    }

    if (issues.length > before || type === null) return;
    fields.push({
      key,
      label,
      type,
      required: raw.required === true,
      ...(help && { help }),
      ...(options && { options }),
    });
  });

  return { fields, issues };
}

// ============================================
// Reading stored settings
// ============================================

/**
 * The form of a task agent: the one in its settings, or the default form
 * when it has none (or one that cannot be read). Always a fresh copy.
 */
export function taskFieldsOf(kindConfig: unknown): TaskField[] {
  const stored = isObject(kindConfig) && isObject(kindConfig.task) ? kindConfig.task.fields : undefined;
  if (Array.isArray(stored) && stored.length > 0) {
    const { fields, issues } = normalizeTaskFields(stored);
    if (issues.length === 0) return fields;
  }
  return DEFAULT_TASK_FIELDS.map((field) => ({ ...field }));
}

/** What a scheduled agent is told at each run: its own line, or the default. */
export function runLineOf(kindConfig: unknown): string {
  const stored = isObject(kindConfig) && isObject(kindConfig.scheduled) ? trimmed(kindConfig.scheduled.prompt) : "";
  return stored || DEFAULT_RUN_LINE;
}

/** The size of a value as UTF-8 JSON, which is what MAX_KIND_CONFIG_BYTES limits. */
export function kindConfigBytes(value: unknown): number {
  const text = JSON.stringify(value) ?? "";
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      // A surrogate pair is one character of four bytes.
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

// ============================================
// The schema and the text
// ============================================

/** A JSON Schema, as plain data. */
export type TaskInputSchema = {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties: false;
};

function propertySchema(field: TaskField): Record<string, unknown> {
  const said = { title: field.label, ...(field.help && { description: field.help }) };
  switch (field.type) {
    case "short_text":
      return { type: "string", ...said, maxLength: SHORT_TEXT_MAX_LENGTH };
    case "long_text":
      return { type: "string", ...said, maxLength: LONG_TEXT_MAX_LENGTH };
    case "number":
      return { type: "number", ...said };
    case "choice":
      return { type: "string", ...said, enum: [...(field.options ?? [])] };
    case "yes_no":
      return { type: "boolean", ...said };
    case "link":
      return { type: "string", ...said, format: "uri", maxLength: LINK_MAX_LENGTH };
    case "list":
      return {
        type: "array",
        ...said,
        items: { type: "string", maxLength: LIST_ITEM_MAX_LENGTH },
        maxItems: LIST_MAX_ITEMS,
      };
  }
}

/**
 * The JSON Schema an input to this form is checked against. Properties are
 * in field order, and nothing is accepted that the form does not ask for.
 *
 * Only these keywords are used: type, title, description, enum, maxLength,
 * format (uri), items, maxItems, required, additionalProperties. They are
 * the ones the API's schema checker and the web form
 * (apps/web/src/lib/schema-form.ts) both understand. `required` is left out
 * when no question is required.
 */
export function taskInputSchema(fields: readonly TaskField[]): TaskInputSchema {
  const properties: Record<string, Record<string, unknown>> = {};
  for (const field of fields) properties[field.key] = propertySchema(field);
  const required = fields.filter((field) => field.required).map((field) => field.key);
  return {
    type: "object",
    properties,
    ...(required.length > 0 && { required }),
    additionalProperties: false,
  };
}

function answerText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) {
    return value
      .map((item) => answerText(item))
      .filter((item) => item.length > 0)
      .map((item) => `- ${item}`)
      .join("\n");
  }
  return "";
}

/**
 * What the model is given for a filled-in form: each answer under its
 * question's label, in field order. Questions left unanswered are left out,
 * and so is anything the form does not ask for.
 *
 *   Topic: Solar panels
 *
 *   Keywords:
 *   - rooftop
 *   - payback
 *
 * A form with one question is just its answer, so the default form reads to
 * the model exactly like a message typed into a chat.
 */
export function inputAsText(fields: readonly TaskField[], input: Record<string, unknown> | null | undefined): string {
  const answers = isObject(input) ? input : {};
  const parts: Array<{ label: string; text: string }> = [];
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(answers, field.key)) continue;
    const text = answerText(answers[field.key]);
    if (text) parts.push({ label: field.label, text });
  }
  if (fields.length === 1) return parts[0]?.text ?? "";
  return parts
    .map(({ label, text }) => (text.includes("\n") ? `${label}:\n${text}` : `${label}: ${text}`))
    .join("\n\n");
}
