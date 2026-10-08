/**
 * A run of a task agent: the check of what a caller sent, and the brief the
 * model is given.
 *
 * A task agent defines a short form (Agent.kindConfig.task.fields, or the
 * default form of one long-text question). A run is that form filled in:
 * `{ input: { <field key>: <answer>, ... } }`. Three doors lead here and
 * all three use these two functions, so they agree on what is accepted and
 * on what the model reads:
 *
 *   POST /api/agents/:id/run           the owner, from the dashboard or code
 *   POST /api/widget/:publicKey/run    anyone, from the agent's public page
 *   POST /api/a/:handle/run            a paying user (a later batch)
 *
 *   checkTaskInput   says whether an input may be run: the agent is a task
 *                    agent, the answers are not too long, and they match the
 *                    form. A caller's mistake is a typed refusal, never a
 *                    throw. It reads no database and spends nothing, so a
 *                    route runs it BEFORE anything is counted or charged.
 *   buildTaskBrief   the messages for a run, built the way a hired job
 *                    builds them (services/jobPrompt.ts), so a free run, the
 *                    owner's run and a paid job read the same brief.
 *
 * They are two functions on purpose: a paid run checks the input, then
 * charges, then builds the brief.
 *
 * Who wrote what stays apart, as in a job. The agent's own instructions are
 * its system prompt, which the chat runtime adds; nothing here reads them.
 * The brief is made only from the agent's name and the caller's answers, so
 * it can be stored and shown without showing anything the owner wrote in
 * private.
 *
 * Pure: no database, no HTTP, no environment.
 */

import {
  LINK_MAX_LENGTH,
  LIST_ITEM_MAX_LENGTH,
  LIST_MAX_ITEMS,
  LONG_TEXT_MAX_LENGTH,
  SHORT_TEXT_MAX_LENGTH,
  inputAsText,
  runLineOf,
  taskFieldsOf,
  taskInputSchema,
  type TaskField,
} from "@wheelsai/shared/agent-kind";

import { composeSystemAddendum, renderJobBrief } from "./jobPrompt.js";
import { compileUserSchema } from "./jsonSchema.js";

// ============================================
// Limits (one source for every run route)
// ============================================

/** Characters of answers in one run, all questions together. */
export const TASK_MAX_INPUT_CHARS = 8_000;
/** Bytes of a run request's body. */
export const TASK_MAX_BODY_BYTES = 64 * 1024;
/** Tokens of one result. */
export const TASK_MAX_OUTPUT_TOKENS = 2_048;
/** Rounds of tool calls in one run. */
export const TASK_MAX_TOOL_ROUNDS = 3;
/** How long one run may take. */
export const TASK_TIME_LIMIT_MS = 120_000;
/** The longest title line of a brief. */
export const TASK_MAX_TITLE_CHARS = 200;

// ============================================
// Refusals
// ============================================

export type TaskRefusalCode = "not_a_task_agent" | "input_too_large" | "input_invalid";

/** The HTTP status each refusal is answered with. */
export const TASK_REFUSAL_STATUS: Record<TaskRefusalCode, 409 | 413 | 422> = {
  not_a_task_agent: 409,
  input_too_large: 413,
  input_invalid: 422,
};

/** What the caller is told, by refusal and by what is wrong with one answer. */
export const TASK_MESSAGES = {
  notATaskAgent: "This agent is not set up to run tasks. Chat with it instead.",
  inputTooLarge: "Your answers are too long. Shorten them and try again.",
  inputInvalid: "Some answers need another look.",
  notAnObject: "Send your answers as an object, with one entry for each question.",
  unreadable: "Your answers could not be read. Check them and try again.",
  unknownField: "This form has no question with that name. Remove it.",
  required: "This question needs an answer.",
  notText: "Write this answer as text.",
  textTooLong: (max: number) => `Keep this answer to ${max.toLocaleString("en-US")} characters or fewer.`,
  notANumber: "Enter a number.",
  notAChoice: "Choose one of the options.",
  notYesOrNo: "Answer yes or no.",
  notALink: "Enter a full link, such as https://example.com.",
  notAList: "Send this answer as a list of short lines.",
  listTooLong: `Keep this list to ${LIST_MAX_ITEMS} items or fewer.`,
  listItem: `Write each item as text of ${LIST_ITEM_MAX_LENGTH} characters or fewer.`,
  invalidAnswer: "This answer could not be read.",
} as const;

/** One answer that needs another look. */
export interface TaskInputIssue {
  /**
   * Where in the input, as a JSON pointer, the way offerings and jobs report
   * it: "/topic", "/keywords/3"; "" is the input as a whole.
   */
  path: string;
  /** The key of the question it is about, or null for the input as a whole. */
  field: string | null;
  /** That question's label, or null when the form has no such question. */
  label: string | null;
  message: string;
}

export type TaskRefusal =
  | { ok: false; code: "not_a_task_agent"; message: string }
  | {
      ok: false;
      code: "input_too_large";
      message: string;
      /** Characters of answers that were sent. */
      chars: number;
      maxChars: number;
    }
  | {
      ok: false;
      code: "input_invalid";
      message: string;
      /** Every answer that is wrong, in the order of the form; then anything the form does not ask for. */
      details: TaskInputIssue[];
    };

export interface CheckedTaskInput {
  ok: true;
  /** The agent's form, in order. */
  fields: TaskField[];
  /**
   * The answers to run with: the form's questions only, in the order of the
   * form, without the ones left blank.
   */
  input: Record<string, unknown>;
  /** Characters of answers, as counted against TASK_MAX_INPUT_CHARS. */
  chars: number;
}

export type TaskInputCheck = CheckedTaskInput | TaskRefusal;

/** What these functions read of an agent. */
export interface TaskAgent {
  agentKind?: string | null;
  kindConfig?: unknown;
  name?: string | null;
}

// ============================================
// Answers
// ============================================

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A question left blank: nothing sent, null, text of only spaces, or an empty list. */
function isBlank(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim().length === 0;
  return Array.isArray(value) && value.length === 0;
}

/**
 * The size of one answer in characters (UTF-16 units, as `length` counts):
 * text as written, a number or yes/no as it would be typed, a list as the
 * sum of its items. Anything else is counted as its JSON, so a value the
 * form never asked for cannot ride in uncounted.
 */
function answerChars(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === "string") return value.length;
  if (typeof value === "number" || typeof value === "boolean") return String(value).length;
  if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + answerChars(item), 0);
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    // Not JSON (a cycle): it cannot have come from a request body, and it is
    // refused as too large rather than measured.
    return Number.POSITIVE_INFINITY;
  }
}

/** The form's answered questions, in the order of the form. */
function answersOf(fields: readonly TaskField[], input: unknown): Record<string, unknown> {
  const sent = isPlainObject(input) ? input : {};
  const answers: Record<string, unknown> = {};
  for (const field of fields) {
    if (Object.hasOwn(sent, field.key) && !isBlank(sent[field.key])) answers[field.key] = sent[field.key];
  }
  return answers;
}

/** In plain words, what is wrong with an answer the form's schema refused. */
function whyRefused(field: TaskField, value: unknown): string {
  const text = (max: number): string | null => {
    if (typeof value !== "string") return TASK_MESSAGES.notText;
    // The schema counts characters, not UTF-16 units.
    return [...value].length > max ? TASK_MESSAGES.textTooLong(max) : null;
  };
  switch (field.type) {
    case "short_text":
      return text(SHORT_TEXT_MAX_LENGTH) ?? TASK_MESSAGES.invalidAnswer;
    case "long_text":
      return text(LONG_TEXT_MAX_LENGTH) ?? TASK_MESSAGES.invalidAnswer;
    case "link":
      return text(LINK_MAX_LENGTH) ?? TASK_MESSAGES.notALink;
    case "number":
      return TASK_MESSAGES.notANumber;
    case "choice":
      return TASK_MESSAGES.notAChoice;
    case "yes_no":
      return TASK_MESSAGES.notYesOrNo;
    case "list":
      if (!Array.isArray(value)) return TASK_MESSAGES.notAList;
      return value.length > LIST_MAX_ITEMS ? TASK_MESSAGES.listTooLong : TASK_MESSAGES.listItem;
  }
}

// ============================================
// The check
// ============================================

/**
 * Whether this input may be run by this agent.
 *
 * In order: the agent is a task agent (else `not_a_task_agent`); the answers
 * are at most TASK_MAX_INPUT_CHARS characters together, counting everything
 * that was sent (else `input_too_large`); and they match the form (else
 * `input_invalid`, with every answer that is wrong).
 *
 * The form's JSON Schema (taskInputSchema), compiled by the same checker
 * that validates a job's input (compileUserSchema), decides: an input is
 * accepted only when that schema accepts it. A question left blank (null,
 * "", an empty list) counts as not answered, which is what a web form sends
 * for a question its visitor skipped; a required question left blank is
 * refused like one that was not sent.
 *
 * The checker stops at the first mismatch, and a form wants all of them, so
 * on a refusal the answers are looked at again one at a time: required
 * questions and unknown names here, each wrong answer by the same schema
 * without its `required` list.
 *
 * Throws only when the agent's own form cannot be compiled, which is not
 * the caller's mistake: a stored form was proven to compile when it was
 * saved (services/agentKind.ts).
 */
export function checkTaskInput(agent: TaskAgent, input: unknown): TaskInputCheck {
  if (agent.agentKind !== "task") {
    return { ok: false, code: "not_a_task_agent", message: TASK_MESSAGES.notATaskAgent };
  }

  const invalid = (details: TaskInputIssue[]): TaskRefusal => ({
    ok: false,
    code: "input_invalid",
    message: TASK_MESSAGES.inputInvalid,
    details,
  });
  const whole = (message: string): TaskInputIssue => ({ path: "", field: null, label: null, message });

  if (!isPlainObject(input)) return invalid([whole(TASK_MESSAGES.notAnObject)]);

  const chars = Object.values(input).reduce<number>((sum, value) => sum + answerChars(value), 0);
  if (chars > TASK_MAX_INPUT_CHARS) {
    return {
      ok: false,
      code: "input_too_large",
      message: TASK_MESSAGES.inputTooLarge,
      chars,
      maxChars: TASK_MAX_INPUT_CHARS,
    };
  }

  const fields = taskFieldsOf(agent.kindConfig);
  const answers = answersOf(fields, input);
  const known = new Set(fields.map((field) => field.key));
  // Blank entries under names the form does not have are still refused: a
  // caller who misspelled a key should hear about it.
  const unknown = Object.keys(input).filter((key) => !known.has(key));

  const strict = compileUserSchema(taskInputSchema(fields), { root: "object" }).validate(answers);
  if (strict.valid && unknown.length === 0) return { ok: true, fields, input: answers, chars };
  if (!strict.valid && strict.code) return invalid([whole(TASK_MESSAGES.unreadable)]);

  // Every wrong answer, by the form's schema without its `required` list:
  // each mismatch found is recorded and its answer set aside, until what is
  // left passes.
  const wrong = new Map<string, TaskInputIssue>();
  const relaxed = compileUserSchema(
    taskInputSchema(fields.map((field) => ({ ...field, required: false }))),
    { root: "object" },
  );
  const left = { ...answers };
  let unplaced: TaskInputIssue | null = null;
  for (let round = 0; round <= fields.length; round += 1) {
    const result = relaxed.validate(left);
    if (result.valid) break;
    const path = result.errors[0]?.path ?? "";
    const key = path.split("/")[1] ?? "";
    const field = fields.find((candidate) => candidate.key === key);
    if (result.code || !field || !Object.hasOwn(left, key)) {
      unplaced = whole(TASK_MESSAGES.unreadable);
      break;
    }
    wrong.set(key, { path, field: key, label: field.label, message: whyRefused(field, left[key]) });
    delete left[key];
  }

  const details: TaskInputIssue[] = [];
  for (const field of fields) {
    const issue = wrong.get(field.key);
    if (issue) details.push(issue);
    else if (field.required && !Object.hasOwn(answers, field.key)) {
      details.push({ path: `/${field.key}`, field: field.key, label: field.label, message: TASK_MESSAGES.required });
    }
  }
  for (const key of unknown) {
    details.push({ path: `/${key}`, field: key, label: null, message: TASK_MESSAGES.unknownField });
  }
  if (unplaced || details.length === 0) details.push(unplaced ?? whole(TASK_MESSAGES.unreadable));
  return invalid(details);
}

// ============================================
// The brief
// ============================================

export interface TaskBrief {
  /**
   * The user turn the model is given: renderJobBrief's text, with the
   * answers as JSON in the order of the form, inside a block they cannot
   * close. Made from the agent's name and the answers only.
   */
  brief: string;
  /**
   * The system turn added after the agent's own system prompt:
   * composeSystemAddendum(null, "text"). The rules of a job (the
   * instructions are confidential, the input is data) and nothing the
   * owner wrote.
   */
  systemAddendum: string;
  /**
   * The answers as a person reads them: each under its question's label, in
   * the order of the form (inputAsText). This is what a kept copy of the
   * run shows as "what was sent"; it holds nothing but the labels and the
   * answers.
   */
  text: string;
}

/** One line, without control characters, at most TASK_MAX_TITLE_CHARS. */
function oneLine(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\s]+/g, " ")
    .trim()
    .slice(0, TASK_MAX_TITLE_CHARS)
    .trim();
}

/**
 * The messages for one run, from the agent and an input that passed
 * checkTaskInput (pass its `input`; anything the form does not ask for, and
 * any question left blank, is left out here too, so the brief is the same
 * whichever was passed).
 *
 * Built as a hired job's is (jobRunner's planRun): the brief is
 * renderJobBrief over the form's schema, and the system turn is
 * composeSystemAddendum with no private instructions and a text answer. The
 * job's title is the agent's name, which its public page already shows. An
 * agent with no usable name gets its run line there (runLineOf), so the
 * brief always says what is asked.
 *
 * The same agent and input always give the same text, so a retry and a
 * stored copy match byte for byte.
 */
export function buildTaskBrief(agent: TaskAgent, input: unknown): TaskBrief {
  const fields = taskFieldsOf(agent.kindConfig);
  const answers = answersOf(fields, input);
  const title = oneLine(agent.name ?? "") || oneLine(runLineOf(agent.kindConfig));
  return {
    brief: renderJobBrief({ title, inputSchema: taskInputSchema(fields) }, answers),
    systemAddendum: composeSystemAddendum(null, "text"),
    text: inputAsText(fields, answers),
  };
}
