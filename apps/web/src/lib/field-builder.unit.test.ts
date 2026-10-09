/**
 * The question builder's moves and checks. Run with:
 *   cd apps/web && npx tsx --test src/lib/field-builder.unit.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_TASK_FIELDS, taskInputSchema } from "@wheelsai/shared/agent-kind";

import {
  FORM_FULL_MESSAGE,
  addField,
  canAddField,
  checkFields,
  defaultDrafts,
  draftsFromFields,
  editField,
  firstFieldProblem,
  moveField,
  newField,
  optionsOf,
  previewKey,
  removeField,
  serverFieldIssues,
  settleKeys,
  toFieldInputs,
  type FieldDraft,
} from "./field-builder";

const id = (index: number) => `q${index}`;

function drafts(...labels: string[]): FieldDraft[] {
  return labels.map((label, index) => ({ ...newField(id(index)), label }));
}

const ids = (list: FieldDraft[]) => list.map((field) => field.id);

test("the default form is one required long-text question", () => {
  const list = defaultDrafts(id);
  assert.deepEqual(list, [
    { id: "q0", key: "your_request", label: "Your request", type: "long_text", required: true, help: "", options: "" },
  ]);
  assert.equal(checkFields(list).ok, true);
});

test("add puts an empty short-text question at the end and leaves the list it was given alone", () => {
  const list = drafts("Topic");
  const next = addField(list, "new");
  assert.deepEqual(ids(next), ["q0", "new"]);
  assert.deepEqual(next[1], { id: "new", key: "", label: "", type: "short_text", required: false, help: "", options: "" });
  assert.equal(list.length, 1);
});

test("a form holds up to 12 questions, and add does nothing after that", () => {
  let list: FieldDraft[] = [];
  for (let i = 0; i < MAX_TASK_FIELDS; i += 1) list = addField(list, `n${i}`);
  assert.equal(list.length, MAX_TASK_FIELDS);
  assert.equal(canAddField(list), false);
  assert.equal(addField(list, "one-more").length, MAX_TASK_FIELDS);
  assert.equal(canAddField(list.slice(1)), true);
  assert.equal(FORM_FULL_MESSAGE, "A form can have up to 12 questions.");
});

test("remove takes out that question only", () => {
  const list = drafts("A", "B", "C");
  assert.deepEqual(ids(removeField(list, "q1")), ["q0", "q2"]);
  assert.deepEqual(ids(removeField(list, "missing")), ["q0", "q1", "q2"]);
  assert.equal(list.length, 3);
});

test("move up and move down swap neighbours and stop at the ends", () => {
  const list = drafts("A", "B", "C");
  assert.deepEqual(ids(moveField(list, "q1", -1)), ["q1", "q0", "q2"]);
  assert.deepEqual(ids(moveField(list, "q1", 1)), ["q0", "q2", "q1"]);
  assert.deepEqual(ids(moveField(list, "q0", -1)), ["q0", "q1", "q2"]);
  assert.deepEqual(ids(moveField(list, "q2", 1)), ["q0", "q1", "q2"]);
  assert.deepEqual(ids(moveField(list, "missing", 1)), ["q0", "q1", "q2"]);
  assert.deepEqual(ids(list), ["q0", "q1", "q2"]);
});

test("edit changes one question and never its id", () => {
  const list = drafts("A", "B");
  const next = editField(list, "q1", { label: "Bee", required: true, ...({ id: "other" } as object) });
  assert.equal(next[1]!.label, "Bee");
  assert.equal(next[1]!.required, true);
  assert.equal(next[1]!.id, "q1");
  assert.equal(next[0], list[0]);
  assert.equal(list[1]!.label, "B");
});

test("options are one per line, without blank lines", () => {
  assert.deepEqual(optionsOf({ options: " Red \n\nGreen\n  \nBlue" }), ["Red", "Green", "Blue"]);
  assert.deepEqual(optionsOf({ options: "" }), []);
});

test("what is sent carries a key only once it is settled, and options only for a choice", () => {
  const list: FieldDraft[] = [
    { id: "a", key: "", label: "Topic", type: "short_text", required: true, help: " ", options: "ignored" },
    { id: "b", key: "tone", label: "Tone", type: "choice", required: false, help: "Pick one", options: "Warm\nDry" },
  ];
  assert.deepEqual(toFieldInputs(list), [
    { label: "Topic", type: "short_text", required: true },
    { key: "tone", label: "Tone", type: "choice", required: false, help: "Pick one", options: ["Warm", "Dry"] },
  ]);
});

test("a key is made from the first label and stays when the label is edited", () => {
  let list = drafts("Code to review");
  assert.equal(previewKey(list, "q0"), "code_to_review");
  assert.equal(list[0]!.key, "");

  list = settleKeys(list, "q0");
  assert.equal(list[0]!.key, "code_to_review");

  list = editField(list, "q0", { label: "Paste your code" });
  list = settleKeys(list);
  assert.equal(list[0]!.key, "code_to_review");
  assert.deepEqual(checkFields(list).fields, [
    { key: "code_to_review", label: "Paste your code", type: "short_text", required: false },
  ]);
});

test("a key survives moves, and a new question never takes a settled name", () => {
  let list = settleKeys(drafts("Topic", "Tone"));
  assert.deepEqual(list.map((field) => field.key), ["topic", "tone"]);
  list = moveField(list, "q1", -1);
  assert.deepEqual(list.map((field) => field.key), ["tone", "topic"]);

  list = editField(addField(list, "q2"), "q2", { label: "Topic" });
  assert.equal(previewKey(list, "q2"), "topic_2");
  list = settleKeys(list, "q2");
  assert.deepEqual(list.map((field) => field.key), ["tone", "topic", "topic_2"]);
});

test("settling one question leaves the others, and a question with no label keeps no key", () => {
  const list = settleKeys(drafts("Topic", "Tone", ""), "q1");
  assert.deepEqual(list.map((field) => field.key), ["", "tone", ""]);
  assert.equal(previewKey(list, "q2"), "");
  assert.deepEqual(settleKeys(drafts("", "")).map((field) => field.key), ["", ""]);
});

test("a question that is not ready elsewhere does not stop a key from being made", () => {
  const list: FieldDraft[] = [
    { ...newField("a"), label: "Tone", type: "choice", options: "" },
    { ...newField("b"), label: "Topic" },
  ];
  assert.deepEqual(settleKeys(list).map((field) => field.key), ["tone", "topic"]);
});

test("the four sentences: no label, too few options, too many questions, the same name twice", () => {
  const noLabel = checkFields(drafts(""));
  assert.equal(noLabel.ok, false);
  assert.deepEqual(noLabel.issues, { q0: { label: "Give this question a label." } });

  const choice: FieldDraft[] = [{ ...newField("c"), label: "Tone", type: "choice", options: "Warm" }];
  assert.deepEqual(checkFields(choice).issues, { c: { options: "Add at least two options." } });
  assert.equal(firstFieldProblem(choice), "Add at least two options.");

  const tooMany = drafts(...Array.from({ length: MAX_TASK_FIELDS + 1 }, (_, i) => `Question ${i + 1}`));
  const tooManyCheck = checkFields(tooMany);
  assert.equal(tooManyCheck.formIssue, "A form can have up to 12 questions.");
  assert.equal(firstFieldProblem(tooMany), "A form can have up to 12 questions.");

  const twins: FieldDraft[] = [
    { ...newField("a"), label: "Topic", key: "topic" },
    { ...newField("b"), label: "Subject", key: "topic" },
  ];
  const twinsCheck = checkFields(twins);
  assert.equal(twinsCheck.issues.a?.key, "Two questions have the same name in code. Change one.");
  assert.equal(twinsCheck.issues.b?.key, "Two questions have the same name in code. Change one.");
  // A clash cannot be settled by guessing, so nothing is.
  assert.deepEqual(settleKeys(twins), twins);
});

test("the first problem is read from the top of the form", () => {
  const list: FieldDraft[] = [
    { ...newField("a"), label: "Topic" },
    { ...newField("b"), label: "Tone", type: "choice", options: "" },
    { ...newField("c"), label: "" },
  ];
  assert.equal(firstFieldProblem(list), "Add at least two options.");
  assert.equal(firstFieldProblem(drafts("Topic")), null);
});

test("the questions that are ready make the preview's schema, in order", () => {
  const list: FieldDraft[] = [
    { ...newField("a"), label: "Topic", required: true, help: "What it is about" },
    { ...newField("b"), label: "" },
    { ...newField("c"), label: "Tone", type: "choice", options: "Warm\nDry" },
    { ...newField("d"), label: "Keywords", type: "list" },
  ];
  const schema = taskInputSchema(checkFields(list).fields);
  assert.deepEqual(Object.keys(schema.properties), ["topic", "tone", "keywords"]);
  assert.deepEqual(schema.required, ["topic"]);
  assert.equal(schema.properties.topic!.description, "What it is about");
  assert.deepEqual(schema.properties.tone!.enum, ["Warm", "Dry"]);
});

test("stored fields become drafts and come back the same", () => {
  const stored = [
    { key: "topic", label: "Topic", type: "short_text" as const, required: true, help: "What it is about" },
    { key: "tone", label: "Tone", type: "choice" as const, required: false, options: ["Warm", "Dry"] },
  ];
  const list = draftsFromFields(stored, id);
  assert.deepEqual(ids(list), ["q0", "q1"]);
  assert.equal(list[1]!.options, "Warm\nDry");
  assert.deepEqual(checkFields(list).fields, stored);
});

test("the server's sentences are filed under the question they name", () => {
  const list = drafts("Topic", "Tone");
  const placed = serverFieldIssues(list, {
    name: "Give your agent a name of at least 3 characters.",
    "kindConfig.task.fields[1].options": "Add at least two options.",
    "kindConfig.task.fields[0]": "This question could not be read.",
    "kindConfig.task.fields[7].label": "Give this question a label.",
    "kindConfig.task.fields": "A form can have up to 12 questions.",
  });
  assert.deepEqual(placed.issues, {
    q1: { options: "Add at least two options." },
    q0: { label: "This question could not be read." },
  });
  // A question the list does not have, and the list as a whole, are the form's: the first is kept.
  assert.equal(placed.formIssue, "Give this question a label.");
  assert.deepEqual(serverFieldIssues(list, {}), { issues: {}, formIssue: null });
});
