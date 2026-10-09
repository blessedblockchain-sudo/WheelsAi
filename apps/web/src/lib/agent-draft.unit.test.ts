/**
 * The create screen's draft: the suggested name, the sentences shown before
 * a request is sent, and the request itself. Run with:
 *   cd apps/web && npx tsx --test src/lib/agent-draft.unit.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DRAFT_MESSAGES,
  applyTemplate,
  chooseTemplateOver,
  createHold,
  draftToCreateInput,
  firstProblem,
  kindFromParam,
  newDraft,
  placeServerProblems,
  releaseTemplate,
  suggestAgentName,
  validateDraft,
  withInstructions,
  withName,
  withoutTemplate,
  type AgentDraft,
  type TemplateForDraft,
} from "./agent-draft";
import { defaultDrafts, editField, newField } from "./field-builder";

const makeFieldId = (index: number) => `q${index}`;

function draft(changes: Partial<AgentDraft> = {}): AgentDraft {
  const base = newDraft({
    timezone: "Europe/Berlin",
    fields: defaultDrafts(makeFieldId),
    defaultModel: "free/groq/llama-3.3-70b",
  });
  return {
    ...base,
    instructions: "Answer customer questions about our returns policy.",
    name: "Returns helper",
    nameEdited: true,
    ...changes,
  };
}

const TEMPLATE_ID = "3f0c9a52-6f0e-4a55-9d53-0e0f4b1f7a11";

const TASK_TEMPLATE: TemplateForDraft = {
  id: TEMPLATE_ID,
  title: "Research Summarizer",
  agentKind: "task",
  kindConfig: {
    task: {
      fields: [
        { key: "topic", label: "Topic", type: "short_text", required: true },
        { key: "depth", label: "Depth", type: "choice", required: false, options: ["Brief", "Detailed"] },
      ],
    },
  },
  systemPrompt: "You summarize research on a topic.",
  tools: [{ name: "web_search", type: "api", description: "Search the web", config: { region: "eu" } }],
  modelConfig: { externalModel: "free/gemini/gemini-2.5-flash", temperature: 0.3, maxTokens: 2048 },
};

const SCHEDULED_TEMPLATE: TemplateForDraft = {
  id: TEMPLATE_ID,
  title: "Daily Briefing",
  agentKind: "scheduled",
  kindConfig: { scheduled: { schedule: { cronExpression: "0 7 * * 1-5", timezone: "UTC" }, prompt: "Write today's briefing." } },
  systemPrompt: "You write a short morning briefing.",
  tools: [],
  modelConfig: { externalModel: "openai/gpt-4", temperature: 0.7 },
};

const MODELS = ["free/groq/llama-3.3-70b", "free/gemini/gemini-2.5-flash"];

// ============================================
// suggestAgentName
// ============================================

test("a name is the start of what the owner wrote, without filler", () => {
  assert.equal(suggestAgentName("Answer customer questions about our returns policy."), "Answer customer questions");
  assert.equal(suggestAgentName("You are a helpful support assistant for Acme. Be brief."), "Helpful support assistant");
  assert.equal(suggestAgentName("I want an agent that summarizes the news every morning"), "Summarizes the news");
  assert.equal(suggestAgentName("it should review pull requests and point out bugs"), "Review pull requests");
  assert.equal(suggestAgentName("Please write a weekly report of our sales"), "Write a weekly report");
  assert.equal(suggestAgentName("Translate: English to French"), "Translate");
  assert.equal(suggestAgentName("First line here\nSecond line"), "First line here");
});

test("a name is at most four words and 40 characters, and does not end on a small word", () => {
  assert.equal(suggestAgentName("Summarize the state of the market"), "Summarize the state");
  const long = suggestAgentName("Internationalization troubleshooting documentation assistant extraordinaire");
  assert.ok(long.length <= 40, long);
  assert.equal(long, "Internationalization troubleshooting");
  assert.equal(suggestAgentName("help with the"), "Help");
});

test("there is no name when there is too little to make one from", () => {
  assert.equal(suggestAgentName(""), "");
  assert.equal(suggestAgentName("   "), "");
  assert.equal(suggestAgentName("ok"), "");
  assert.equal(suggestAgentName("?!"), "");
  assert.equal(suggestAgentName("the"), "");
});

test("the name follows the instructions until it is edited by hand", () => {
  let current = newDraft({ timezone: "UTC", fields: defaultDrafts(makeFieldId) });
  current = withInstructions(current, "Summarize support tickets");
  assert.equal(current.name, "Summarize support tickets");
  current = withInstructions(current, "Summarize sales calls every week");
  assert.equal(current.name, "Summarize sales calls");

  current = withName(current, "Call notes");
  current = withInstructions(current, "Something else entirely");
  assert.equal(current.name, "Call notes");
  assert.equal(current.instructions, "Something else entirely");

  // Clearing the name hands it back to the instructions.
  current = withName(current, "");
  current = withInstructions(current, "Draft replies to reviews");
  assert.equal(current.name, "Draft replies to reviews");
});

test("?kind= is read only when it is one of the three kinds", () => {
  assert.equal(kindFromParam("task"), "task");
  assert.equal(kindFromParam("scheduled"), "scheduled");
  assert.equal(kindFromParam("conversation"), "conversation");
  assert.equal(kindFromParam("chat"), null);
  assert.equal(kindFromParam(null), null);
});

// ============================================
// validateDraft
// ============================================

test("a complete draft of each kind has nothing to say", () => {
  assert.deepEqual(validateDraft(draft()), {});
  assert.deepEqual(validateDraft(draft({ kind: "task" })), {});
  assert.deepEqual(validateDraft(draft({ kind: "scheduled" })), {});
  assert.equal(firstProblem(validateDraft(draft())), null);
});

test("an empty draft asks first for what the agent should do, then for a name", () => {
  const empty = newDraft({ timezone: "UTC", fields: defaultDrafts(makeFieldId) });
  const problems = validateDraft(empty);
  assert.equal(problems.instructions, "Say what your agent should do, in a sentence or two.");
  assert.equal(problems.name, "Give your agent a name of at least 3 characters.");
  assert.equal(firstProblem(problems), "Say what your agent should do, in a sentence or two.");
});

test("the name needs 3 to 100 characters, not counting spaces around it", () => {
  assert.equal(validateDraft(draft({ name: " ab " })).name, "Give your agent a name of at least 3 characters.");
  assert.equal(validateDraft(draft({ name: "abc" })).name, undefined);
  assert.equal(validateDraft(draft({ name: "x".repeat(101) })).name, "Keep the name to 100 characters or fewer.");
  assert.equal(firstProblem(validateDraft(draft({ name: "" }))), DRAFT_MESSAGES.name);
});

test("instructions over the server's limit are said before sending", () => {
  assert.equal(validateDraft(draft({ instructions: "x".repeat(10_001) })).instructions, DRAFT_MESSAGES.instructionsTooLong);
  assert.equal(validateDraft(draft({ instructions: "x".repeat(10_000) })).instructions, undefined);
});

test("a task's form is checked only for a task agent", () => {
  const fields = [{ ...newField("a"), label: "" }];
  assert.equal(validateDraft(draft({ kind: "task", fields })).fields, "Give this question a label.");
  assert.equal(validateDraft(draft({ kind: "conversation", fields })).fields, undefined);
  assert.equal(validateDraft(draft({ kind: "scheduled", fields })).fields, undefined);

  const choice = [{ ...newField("a"), label: "Tone", type: "choice" as const, options: "Warm" }];
  assert.equal(validateDraft(draft({ kind: "task", fields: choice })).fields, "Add at least two options.");
});

test("a schedule's times and time zone are checked only for a self-running agent", () => {
  const schedule = { cronExpression: "0 9 * *", timezone: "" };
  const problems = validateDraft(draft({ kind: "scheduled", schedule }));
  assert.equal(problems["schedule.cronExpression"], "These times could not be read. Check them and try again.");
  assert.equal(problems["schedule.timezone"], "Choose a time zone from the list, for example Europe/Berlin.");
  assert.deepEqual(validateDraft(draft({ kind: "task", schedule })), {});
});

test("a secret with a value needs a name; an empty row is ignored", () => {
  const withSecrets = (secrets: AgentDraft["advanced"]["secrets"]) => {
    const base = draft();
    return { ...base, advanced: { ...base.advanced, secrets } };
  };
  assert.equal(validateDraft(withSecrets([{ key: "", value: "sk-1" }])).secrets, DRAFT_MESSAGES.secretName);
  assert.equal(validateDraft(withSecrets([{ key: "", value: "" }])).secrets, undefined);
  assert.equal(validateDraft(withSecrets([{ key: "API_KEY", value: "sk-1" }])).secrets, undefined);
});

// ============================================
// draftToCreateInput
// ============================================

test("talk to it: the name, the kind and the instructions, and nothing else", () => {
  assert.deepEqual(draftToCreateInput(draft({ name: "  Returns helper " })), {
    name: "Returns helper",
    agentKind: "conversation",
    systemPrompt: "Answer customer questions about our returns policy.",
  });
});

test("what the owner typed is the instructions and never the description; no framework, source or code is sent", () => {
  for (const kind of ["conversation", "task", "scheduled"] as const) {
    const input = draftToCreateInput(draft({ kind })) as unknown as Record<string, unknown>;
    assert.equal(input.systemPrompt, "Answer customer questions about our returns policy.");
    for (const never of ["description", "framework", "sourceType", "sourceUrl", "sourceCode", "slug", "isPublic", "tags"]) {
      assert.equal(never in input, false, `${kind}: ${never}`);
    }
  }
});

test("give it a task: the form goes in kindConfig.task.fields, keys only where settled", () => {
  const fields = [
    ...defaultDrafts(makeFieldId),
    { ...newField("b"), label: "Tone", type: "choice" as const, options: "Warm\nDry", help: "How it should sound" },
  ];
  assert.deepEqual(draftToCreateInput(draft({ kind: "task", fields })), {
    name: "Returns helper",
    agentKind: "task",
    systemPrompt: "Answer customer questions about our returns policy.",
    kindConfig: {
      task: {
        fields: [
          { key: "your_request", label: "Your request", type: "long_text", required: true },
          { label: "Tone", type: "choice", required: false, help: "How it should sound", options: ["Warm", "Dry"] },
        ],
      },
    },
  });
});

test("it runs on its own: the schedule, with no place when results stay here", () => {
  assert.deepEqual(draftToCreateInput(draft({ kind: "scheduled" })), {
    name: "Returns helper",
    agentKind: "scheduled",
    systemPrompt: "Answer customer questions about our returns policy.",
    schedule: { cronExpression: "0 9 * * *", timezone: "Europe/Berlin" },
  });
});

test("it runs on its own: a chosen place is sent as deliver.channelId", () => {
  const input = draftToCreateInput(
    draft({
      kind: "scheduled",
      schedule: { cronExpression: " 30 17 * * 1-5 ", timezone: "America/New_York" },
      deliverChannelId: "chan_1",
    }),
  );
  assert.deepEqual(input.schedule, {
    cronExpression: "30 17 * * 1-5",
    timezone: "America/New_York",
    deliver: { channelId: "chan_1" },
  });
  assert.equal("kindConfig" in input, false);
});

test("a schedule and a place are not sent for the other two kinds", () => {
  for (const kind of ["conversation", "task"] as const) {
    const input = draftToCreateInput(draft({ kind, deliverChannelId: "chan_1" }));
    assert.equal("schedule" in input, false, kind);
  }
  assert.equal("kindConfig" in draftToCreateInput(draft({ kind: "conversation" })), false);
});

test("a task template fills the form and is sent as templateId, with nothing under Advanced resent", () => {
  const start = newDraft({ timezone: "Europe/Berlin", fields: defaultDrafts(makeFieldId), defaultModel: MODELS[0] });
  const filled = applyTemplate(start, TASK_TEMPLATE, { makeFieldId, availableModels: MODELS });

  assert.equal(filled.kind, "task");
  assert.equal(filled.name, "Research Summarizer");
  assert.equal(filled.nameEdited, true);
  assert.equal(filled.instructions, "You summarize research on a topic.");
  assert.deepEqual(filled.fields.map((field) => field.key), ["topic", "depth"]);
  assert.equal(filled.advanced.model, "free/gemini/gemini-2.5-flash");
  assert.equal(filled.advanced.temperature, 0.3);
  assert.deepEqual(filled.advanced.tools, ["web_search"]);
  assert.deepEqual(validateDraft(filled), {});

  assert.deepEqual(draftToCreateInput(filled), {
    name: "Research Summarizer",
    agentKind: "task",
    systemPrompt: "You summarize research on a topic.",
    kindConfig: {
      task: {
        fields: [
          { key: "topic", label: "Topic", type: "short_text", required: true },
          { key: "depth", label: "Depth", type: "choice", required: false, options: ["Brief", "Detailed"] },
        ],
      },
    },
    templateId: TEMPLATE_ID,
  });
});

test("a template's question keeps its name in code when its label is edited", () => {
  const start = newDraft({ timezone: "UTC", fields: defaultDrafts(makeFieldId) });
  const filled = applyTemplate(start, TASK_TEMPLATE, { makeFieldId, availableModels: MODELS });
  const edited = { ...filled, fields: editField(filled.fields, "q0", { label: "What should I research?" }) };
  const fields = draftToCreateInput(edited).kindConfig?.task?.fields;
  assert.deepEqual(fields?.[0], { key: "topic", label: "What should I research?", type: "short_text", required: true });
});

test("a self-running template brings its times and its line; the time zone stays the owner's", () => {
  const start = newDraft({ timezone: "Europe/Berlin", fields: defaultDrafts(makeFieldId), defaultModel: MODELS[0] });
  const filled = applyTemplate(start, SCHEDULED_TEMPLATE, { makeFieldId, availableModels: MODELS });

  assert.equal(filled.kind, "scheduled");
  assert.deepEqual(filled.schedule, { cronExpression: "0 7 * * 1-5", timezone: "Europe/Berlin" });
  // Its model is not one the platform lists, so the picker leaves it as the template has it.
  assert.equal(filled.advanced.model, "");
  assert.equal(filled.baseline.model, "");

  assert.deepEqual(draftToCreateInput({ ...filled, deliverChannelId: "chan_9" }), {
    name: "Daily Briefing",
    agentKind: "scheduled",
    systemPrompt: "You write a short morning briefing.",
    templateId: TEMPLATE_ID,
    schedule: {
      cronExpression: "0 7 * * 1-5",
      timezone: "Europe/Berlin",
      deliver: { channelId: "chan_9" },
      prompt: "Write today's briefing.",
    },
  });
});

test("a template's line is sent only while the agent still runs on its own", () => {
  const start = newDraft({ timezone: "UTC", fields: defaultDrafts(makeFieldId) });
  const filled = applyTemplate(start, SCHEDULED_TEMPLATE, { makeFieldId, availableModels: MODELS });
  const asChat = draftToCreateInput({ ...filled, kind: "conversation" });
  assert.equal(asChat.agentKind, "conversation");
  assert.equal(asChat.templateId, TEMPLATE_ID);
  assert.equal("schedule" in asChat, false);
});

test("Advanced without a template: only what was changed from the defaults is sent", () => {
  const base = draft();
  const advanced = (changes: Partial<AgentDraft["advanced"]>) => ({ ...base, advanced: { ...base.advanced, ...changes } });

  const untouched = draftToCreateInput(base);
  for (const key of ["modelConfig", "tools", "knowledgeBaseId", "env"]) assert.equal(key in untouched, false, key);

  assert.deepEqual(draftToCreateInput(advanced({ model: "free/gemini/gemini-2.5-flash" })).modelConfig, {
    externalModel: "free/gemini/gemini-2.5-flash",
  });
  assert.deepEqual(draftToCreateInput(advanced({ temperature: 1.2 })).modelConfig, { temperature: 1.2 });
  assert.deepEqual(
    draftToCreateInput(advanced({ model: "free/gemini/gemini-2.5-flash", temperature: 0 })).modelConfig,
    { externalModel: "free/gemini/gemini-2.5-flash", temperature: 0 },
  );
  assert.deepEqual(
    draftToCreateInput(advanced({ tools: ["web_search", "calculator"] }), { web_search: "Search the web" }).tools,
    [
      { name: "web_search", type: "function", description: "Search the web" },
      { name: "calculator", type: "function" },
    ],
  );
  assert.equal(
    draftToCreateInput(advanced({ knowledgeBaseId: "7d1f0c9e-0a2b-4a53-8a0e-2a9d1e3b5c77" })).knowledgeBaseId,
    "7d1f0c9e-0a2b-4a53-8a0e-2a9d1e3b5c77",
  );
  assert.deepEqual(
    draftToCreateInput(
      advanced({
        secrets: [
          { key: " API_KEY ", value: "sk-1" },
          { key: "", value: "" },
        ],
      }),
    ).env,
    { API_KEY: "sk-1" },
  );
});

test("Advanced with a template: its values are the baseline, and a change is sent over them", () => {
  const start = newDraft({ timezone: "UTC", fields: defaultDrafts(makeFieldId), defaultModel: MODELS[0] });
  const filled = applyTemplate(start, TASK_TEMPLATE, { makeFieldId, availableModels: MODELS });
  const advanced = (changes: Partial<AgentDraft["advanced"]>) => ({
    ...filled,
    advanced: { ...filled.advanced, ...changes },
  });

  // Back to the platform default: a change from the template, so it is sent.
  assert.deepEqual(draftToCreateInput(advanced({ model: MODELS[0], temperature: 0.7 })).modelConfig, {
    externalModel: MODELS[0],
    temperature: 0.7,
  });

  // A tool added: the template's tool is sent as it was stored, the new one as a function.
  assert.deepEqual(draftToCreateInput(advanced({ tools: ["web_search", "calculator"] })).tools, [
    { name: "web_search", type: "api", description: "Search the web", config: { region: "eu" } },
    { name: "calculator", type: "function" },
  ]);
  // Every tool switched off is a change too.
  assert.deepEqual(draftToCreateInput(advanced({ tools: [] })).tools, []);
  // The same tools in another order are not a change.
  assert.equal("tools" in draftToCreateInput(advanced({ tools: ["web_search"] })), false);
});

test("letting a template go keeps the form and sends what it had brought as the owner's choice", () => {
  const start = newDraft({ timezone: "UTC", fields: defaultDrafts(makeFieldId), defaultModel: MODELS[0] });
  const filled = applyTemplate(start, TASK_TEMPLATE, { makeFieldId, availableModels: MODELS });
  const input = draftToCreateInput(withoutTemplate(filled, MODELS[0]));

  assert.equal("templateId" in input, false);
  assert.equal(input.name, "Research Summarizer");
  assert.deepEqual(input.modelConfig, { externalModel: "free/gemini/gemini-2.5-flash", temperature: 0.3 });
  assert.deepEqual(input.tools, [{ name: "web_search", type: "function" }]);
});

test("choosing another template replaces the first one's settings", () => {
  const start = newDraft({ timezone: "Europe/Berlin", fields: defaultDrafts(makeFieldId), defaultModel: MODELS[0] });
  const first = applyTemplate(start, TASK_TEMPLATE, { makeFieldId, availableModels: MODELS });
  const second = applyTemplate(first, SCHEDULED_TEMPLATE, { makeFieldId, availableModels: MODELS });
  assert.equal(second.kind, "scheduled");
  assert.deepEqual(second.advanced.tools, []);
  assert.deepEqual(second.baseline.tools, []);
  assert.equal(second.template?.runLine, "Write today's briefing.");
  assert.equal("tools" in draftToCreateInput(second), false);
});

// ============================================
// A template chip never destroys typed work
// ============================================

test("un-pressing a chip brings back exactly what was typed before it", () => {
  const typed = draft({ kind: "task", fields: editField(defaultDrafts(makeFieldId), "q0", { label: "Order number" }) });
  const chosen = chooseTemplateOver(typed, null, SCHEDULED_TEMPLATE, { makeFieldId, availableModels: MODELS });
  assert.equal(chosen.draft.name, "Daily Briefing");
  assert.equal(chosen.draft.instructions, "You write a short morning briefing.");
  assert.equal(chosen.kept, typed);

  const back = releaseTemplate(chosen.draft, chosen.kept, MODELS[0]);
  assert.deepEqual(back, typed);
  assert.deepEqual(draftToCreateInput(back), draftToCreateInput(typed));
});

test("a second chip fills the form from what was typed, not from the first template", () => {
  const typed = draft();
  const context = { makeFieldId, availableModels: MODELS };
  const first = chooseTemplateOver(typed, null, TASK_TEMPLATE, context);
  const second = chooseTemplateOver(first.draft, first.kept, SCHEDULED_TEMPLATE, context);

  assert.deepEqual(second.kept, typed);
  assert.equal(second.draft.template?.id, SCHEDULED_TEMPLATE.id);
  // Nothing of the first template is left: its questions, its tools, its creativity.
  assert.deepEqual(second.draft.fields, typed.fields);
  assert.deepEqual(second.draft.baseline.tools, []);
  assert.deepEqual(second.draft, applyTemplate(typed, SCHEDULED_TEMPLATE, context));

  assert.deepEqual(releaseTemplate(second.draft, second.kept, MODELS[0]), typed);
});

test("what is the owner's own is kept across chips: the time zone, the place, knowledge and secrets", () => {
  const typed = draft();
  const context = { makeFieldId, availableModels: MODELS };
  const chosen = chooseTemplateOver(typed, null, SCHEDULED_TEMPLATE, context);
  const edited: AgentDraft = {
    ...chosen.draft,
    schedule: { ...chosen.draft.schedule, timezone: "Asia/Tokyo" },
    deliverChannelId: "6c2f3a0e-1b7d-4a53-8a55-0b0d5b7f1c22",
    advanced: { ...chosen.draft.advanced, knowledgeBaseId: "kb-1", secrets: [{ key: "TOKEN", value: "x" }] },
  };

  const back = releaseTemplate(edited, chosen.kept, MODELS[0]);
  assert.equal(back.template, null);
  assert.equal(back.name, typed.name);
  assert.equal(back.instructions, typed.instructions);
  assert.equal(back.schedule.timezone, "Asia/Tokyo");
  assert.equal(back.schedule.cronExpression, typed.schedule.cronExpression);
  assert.equal(back.deliverChannelId, "6c2f3a0e-1b7d-4a53-8a55-0b0d5b7f1c22");
  assert.equal(back.advanced.knowledgeBaseId, "kb-1");
  assert.deepEqual(back.advanced.secrets, [{ key: "TOKEN", value: "x" }]);

  const other = chooseTemplateOver(edited, chosen.kept, TASK_TEMPLATE, context);
  assert.equal(other.draft.schedule.timezone, "Asia/Tokyo");
  assert.equal(other.draft.advanced.knowledgeBaseId, "kb-1");
});

test("a draft kept before the models were known starts on the default model when it comes back", () => {
  const early = newDraft({ timezone: "UTC", fields: defaultDrafts(makeFieldId) });
  const chosen = chooseTemplateOver(early, null, TASK_TEMPLATE, { makeFieldId, availableModels: MODELS });
  const back = releaseTemplate(chosen.draft, chosen.kept, MODELS[0]);
  assert.equal(back.advanced.model, MODELS[0]);
  assert.equal(back.baseline.model, MODELS[0]);
  assert.equal("modelConfig" in draftToCreateInput({ ...back, name: "Helper", instructions: "Help." }), false);
});

test("with nothing kept, letting a template go keeps the form", () => {
  const filled = applyTemplate(draft(), TASK_TEMPLATE, { makeFieldId, availableModels: MODELS });
  assert.deepEqual(releaseTemplate(filled, null, MODELS[0]), withoutTemplate(filled, MODELS[0]));
});

// ============================================
// What holds Create
// ============================================

test("a pasted link that is not saved yet holds Create for a self-running agent, with its reason", () => {
  const scheduled = draft({ kind: "scheduled" });
  assert.equal(createHold(scheduled, validateDraft(scheduled), false), null);
  assert.equal(createHold(scheduled, validateDraft(scheduled), true), DRAFT_MESSAGES.linkNotSaved);
  assert.match(DRAFT_MESSAGES.linkNotSaved, /Use this channel/);
  // The other kinds send no place, so nothing of theirs is held.
  assert.equal(createHold(draft(), validateDraft(draft()), true), null);
  // A problem higher on the screen is said first.
  const unnamed = draft({ kind: "scheduled", name: "" });
  assert.equal(createHold(unnamed, validateDraft(unnamed), true), firstProblem(validateDraft(unnamed)));
});

// ============================================
// placeServerProblems
// ============================================

test("each sentence of a 400 goes to its input", () => {
  const placed = placeServerProblems({
    name: "Give your agent a name of at least 3 characters.",
    systemPrompt: "Keep this shorter.",
    "schedule.cronExpression": "These times could not be read. Check them and try again.",
    "schedule.timezone": "Choose a time zone from the list, for example Europe/Berlin.",
    "schedule.deliver.channelId": "That place was not found. Choose another place for the results.",
    "schedule.prompt": "Write what it is told at each run, in up to 20,000 characters.",
    "kindConfig.task.fields[0].label": "Give this question a label.",
    "modelConfig.temperature": "Creativity is between 0 and 2.",
    "tools[1].type": "Choose a tool type.",
    knowledgeBaseId: "That knowledge base was not found.",
    templateId: "Choose a template from the list.",
    body: "Send a JSON object.",
  });
  assert.deepEqual(placed.byInput, {
    name: "Give your agent a name of at least 3 characters.",
    instructions: "Keep this shorter.",
    "schedule.cronExpression": "These times could not be read. Check them and try again.",
    "schedule.timezone": "Choose a time zone from the list, for example Europe/Berlin.",
    "schedule.deliver.channelId": "That place was not found. Choose another place for the results.",
    templateId: "Choose a template from the list.",
  });
  assert.deepEqual(placed.formFields, { "kindConfig.task.fields[0].label": "Give this question a label." });
  assert.deepEqual(placed.advanced, [
    "Creativity is between 0 and 2.",
    "Choose a tool type.",
    "That knowledge base was not found.",
  ]);
  assert.deepEqual(placed.other, [
    "Write what it is told at each run, in up to 20,000 characters.",
    "Send a JSON object.",
  ]);
});
