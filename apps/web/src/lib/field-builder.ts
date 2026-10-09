/**
 * The pure core of the question builder: the form a task agent asks people
 * to fill in, while its owner is arranging it.
 *
 * The builder holds a list of drafts. A draft is a question as it is typed:
 * its options are text with one option per line, and its name in code (`key`)
 * is empty until it is settled. normalizeTaskFields (shared with the API)
 * makes a key from the label for a question that has none; settleKeys writes
 * those keys back into the drafts, which the builder does when a label is
 * finished. From then on the key stays, so editing a label never changes the
 * name a caller already uses.
 *
 * Every move (add, remove, move up, move down, edit) answers a new list and
 * leaves the one it was given alone.
 */
import {
  DEFAULT_TASK_FIELDS,
  MAX_TASK_FIELDS,
  TASK_FORM_MESSAGES,
  normalizeTaskFields,
  type TaskField,
  type TaskFieldType,
} from "@wheelsai/shared/agent-kind";

export interface FieldDraft {
  /** Tells one draft from another on screen. Never sent. */
  id: string;
  /** The name in code; "" until it is settled, and then it is made from the label. */
  key: string;
  label: string;
  type: TaskFieldType;
  required: boolean;
  help: string;
  /** `choice` only: one option per line, as typed. */
  options: string;
}

/** The parts of a question a problem can be in. */
export type FieldPart = "label" | "type" | "key" | "help" | "options";

export type FieldIssues = Partial<Record<FieldPart, string>>;

/** A new, empty question. */
export function newField(id: string): FieldDraft {
  return { id, key: "", label: "", type: "short_text", required: false, help: "", options: "" };
}

/** Stored fields as drafts. `makeId` gives each one its id, from its place in the list. */
export function draftsFromFields(fields: readonly TaskField[], makeId: (index: number) => string): FieldDraft[] {
  return fields.map((field, index) => ({
    id: makeId(index),
    key: field.key,
    label: field.label,
    type: field.type,
    required: field.required,
    help: field.help ?? "",
    options: (field.options ?? []).join("\n"),
  }));
}

/** The form a task agent starts with: one long-text question. */
export function defaultDrafts(makeId: (index: number) => string): FieldDraft[] {
  return draftsFromFields(DEFAULT_TASK_FIELDS, makeId);
}

// ============================================
// Moves
// ============================================

/** Whether another question fits. */
export function canAddField(list: readonly FieldDraft[]): boolean {
  return list.length < MAX_TASK_FIELDS;
}

/** The list with a new, empty question at the end. Unchanged when the form is full. */
export function addField(list: readonly FieldDraft[], id: string): FieldDraft[] {
  if (!canAddField(list)) return [...list];
  return [...list, newField(id)];
}

/** The list without that question. */
export function removeField(list: readonly FieldDraft[], id: string): FieldDraft[] {
  return list.filter((field) => field.id !== id);
}

/** The list with that question one place earlier (-1) or later (1). Unchanged at either end. */
export function moveField(list: readonly FieldDraft[], id: string, direction: -1 | 1): FieldDraft[] {
  const from = list.findIndex((field) => field.id === id);
  const to = from + direction;
  const next = [...list];
  if (from < 0 || to < 0 || to >= list.length) return next;
  [next[from], next[to]] = [next[to]!, next[from]!];
  return next;
}

/** The list with that question changed. Its id cannot be changed. */
export function editField(
  list: readonly FieldDraft[],
  id: string,
  changes: Partial<Omit<FieldDraft, "id">>,
): FieldDraft[] {
  return list.map((field) => (field.id === id ? { ...field, ...changes, id: field.id } : field));
}

// ============================================
// What is sent, and what is wrong with it
// ============================================

/** The options of a draft as a list: one per line, without blank lines. */
export function optionsOf(draft: Pick<FieldDraft, "options">): string[] {
  return draft.options
    .split("\n")
    .map((option) => option.trim())
    .filter((option) => option.length > 0);
}

type FieldInput = {
  key?: string;
  label: string;
  type: TaskFieldType;
  required: boolean;
  help?: string;
  options?: string[];
};

/** The drafts as normalizeTaskFields and the API read them. A draft with no key is sent without one. */
export function toFieldInputs(list: readonly FieldDraft[]): FieldInput[] {
  return list.map((draft) => ({
    ...(draft.key.trim() && { key: draft.key.trim() }),
    label: draft.label,
    type: draft.type,
    required: draft.required,
    ...(draft.help.trim() && { help: draft.help }),
    ...(draft.type === "choice" && { options: optionsOf(draft) }),
  }));
}

export interface FieldCheck {
  /** The questions that can be saved, with their keys. All of them when `ok`. */
  fields: TaskField[];
  /** Problems per draft id, one sentence per part. */
  issues: Record<string, FieldIssues>;
  /** A problem with the form as a whole (none, or too many questions). */
  formIssue: string | null;
  ok: boolean;
}

/** Checks the drafts the way the API will, and files each problem under its question. */
export function checkFields(list: readonly FieldDraft[]): FieldCheck {
  const { fields, issues: found } = normalizeTaskFields(toFieldInputs(list));
  const issues: Record<string, FieldIssues> = {};
  let formIssue: string | null = null;
  for (const issue of found) {
    const draft = issue.index >= 0 ? list[issue.index] : undefined;
    if (!draft || issue.field === "fields") {
      formIssue ??= issue.message;
      continue;
    }
    const forDraft = (issues[draft.id] ??= {});
    forDraft[issue.field] ??= issue.message;
  }
  return { fields, issues, formIssue, ok: found.length === 0 };
}

/** The first problem of a check as one sentence, or null. Questions are read top to bottom. */
export function firstFieldProblem(list: readonly FieldDraft[], check: FieldCheck = checkFields(list)): string | null {
  if (check.formIssue) return check.formIssue;
  for (const draft of list) {
    const problems = check.issues[draft.id];
    const first = problems && Object.values(problems)[0];
    if (first) return first;
  }
  return null;
}

/**
 * The list with every key that can be settled written into its draft: a
 * question that has a label and no key gets the key normalizeTaskFields
 * makes for it. Pass `id` to settle one question only. A question that is
 * not ready (no label yet) is left without a key.
 */
export function settleKeys(list: readonly FieldDraft[], id?: string): FieldDraft[] {
  // Problems elsewhere in the form (a missing option, a question with no
  // label yet) must not stop a key from being made, so each key is read from
  // a form of bare labels: the same labels and sent keys, and so the same keys.
  const labelled = list.filter((draft) => draft.label.trim());
  if (labelled.length === 0) return [...list];
  const bare = labelled.map((draft) => ({ ...(draft.key.trim() && { key: draft.key.trim() }), label: draft.label }));
  const { fields, issues } = normalizeTaskFields(bare);
  if (fields.length !== labelled.length || issues.length > 0) {
    // Something cannot be read at all (a duplicate or invalid key): settle nothing.
    return [...list];
  }
  const keys = new Map(labelled.map((draft, index) => [draft.id, fields[index]!.key]));
  return list.map((draft) => {
    if (draft.key.trim() || !draft.label.trim()) return draft;
    if (id !== undefined && draft.id !== id) return draft;
    return { ...draft, key: keys.get(draft.id) ?? "" };
  });
}

/** The key a question will get when it is settled, for showing before it is. "" when it has no label yet. */
export function previewKey(list: readonly FieldDraft[], id: string): string {
  const draft = list.find((field) => field.id === id);
  if (!draft) return "";
  if (draft.key.trim()) return draft.key.trim();
  return settleKeys(list, id).find((field) => field.id === id)?.key ?? "";
}

// ============================================
// Problems the server found
// ============================================

const SERVER_FIELD = /^kindConfig\.task\.fields(?:\[(\d+)\](?:\.(label|type|key|help|options))?)?$/;

/**
 * The sentences of a 400 that belong to the form ("kindConfig.task.fields[0].label"),
 * filed under the draft at that place in the list. A problem with the list
 * as a whole, or with a question the list does not have, is the form's.
 */
export function serverFieldIssues(
  list: readonly FieldDraft[],
  fields: Record<string, string>,
): { issues: Record<string, FieldIssues>; formIssue: string | null } {
  const issues: Record<string, FieldIssues> = {};
  let formIssue: string | null = null;
  for (const [path, sentence] of Object.entries(fields)) {
    const match = SERVER_FIELD.exec(path);
    if (!match) {
      if (path === "kindConfig" || path === "kindConfig.task") formIssue ??= sentence;
      continue;
    }
    const draft = match[1] !== undefined ? list[Number(match[1])] : undefined;
    if (!draft) {
      formIssue ??= sentence;
      continue;
    }
    const part = (match[2] as FieldPart | undefined) ?? "label";
    (issues[draft.id] ??= {})[part] ??= sentence;
  }
  return { issues, formIssue };
}

/** The sentence shown when the form is full. */
export const FORM_FULL_MESSAGE = TASK_FORM_MESSAGES.too_many_fields;
