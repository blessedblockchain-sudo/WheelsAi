/**
 * The pure core of the create screen: one draft of a new agent, the
 * sentences shown before anything is sent, and the request it becomes.
 *
 * The screen asks how people will use the agent, what it should do and what
 * it is called. What the owner types under "What should it do?" becomes the
 * agent's instructions and nothing else: it is never copied into the public
 * description. Everything under Advanced starts from a baseline (the
 * platform's defaults, or the chosen template's values), and only what the
 * owner changed from that baseline is sent, so a template's settings are not
 * overwritten by defaults and a plain agent gets the server's.
 */
import {
  isAgentKind,
  taskFieldsOf,
  type AgentKind,
  type KindConfig,
} from "@wheelsai/shared/agent-kind";
import { looksLikeCron } from "@wheelsai/shared/schedule-choice";

import type { CreateAgentInput } from "./api";
import { checkFields, draftsFromFields, firstFieldProblem, toFieldInputs, type FieldDraft } from "./field-builder";

// ============================================
// The draft
// ============================================

type AgentTool = NonNullable<CreateAgentInput["tools"]>[number];

/** What Advanced holds. */
export interface AdvancedDraft {
  /** A model id from GET /api/capabilities; "" leaves the model as it is. */
  model: string;
  /** Creativity, 0 to 2. */
  temperature: number;
  /** The keys of the tools that are on. */
  tools: string[];
  /** "" is none. */
  knowledgeBaseId: string;
  secrets: Array<{ key: string; value: string }>;
}

/** What Advanced starts from. Only a value that differs from it is sent. */
export interface AdvancedBaseline {
  model: string;
  temperature: number;
  /** The tools the agent has before the owner changes any, as they are stored. */
  tools: AgentTool[];
}

/** The template a draft starts from, as far as the request needs it. */
export interface DraftTemplate {
  id: string;
  /** What a self-running agent is told at each run, when the template suggests a line. */
  runLine?: string;
}

export interface AgentDraft {
  kind: AgentKind;
  /** "What should it do?": the agent's instructions. */
  instructions: string;
  name: string;
  /** False while the name still follows the instructions. */
  nameEdited: boolean;
  /** Task: the form people fill in. */
  fields: FieldDraft[];
  /** Runs on its own: when. */
  schedule: { cronExpression: string; timezone: string };
  /** Runs on its own: where results go. null is only on the agent's page. */
  deliverChannelId: string | null;
  template: DraftTemplate | null;
  advanced: AdvancedDraft;
  baseline: AdvancedBaseline;
}

export const DEFAULT_TEMPERATURE = 0.7;
export const NAME_MIN_LENGTH = 3;
export const NAME_MAX_LENGTH = 100;
export const INSTRUCTIONS_MAX_LENGTH = 10_000;

/** The sentences this screen shows before a request is sent. */
export const DRAFT_MESSAGES = {
  name: "Give your agent a name of at least 3 characters.",
  nameTooLong: "Keep the name to 100 characters or fewer.",
  instructions: "Say what your agent should do, in a sentence or two.",
  instructionsTooLong: "Keep this to 10,000 characters or fewer.",
  cron: "These times could not be read. Check them and try again.",
  timezone: "Choose a time zone from the list, for example Europe/Berlin.",
  secretName: "Give each secret a name, or remove the empty row.",
  linkNotSaved: "Press Use this channel to save the link, or choose another place for results.",
} as const;

/** The kind a `?kind=` in the address asks for, or null. */
export function kindFromParam(value: string | null | undefined): AgentKind | null {
  return isAgentKind(value) ? value : null;
}

// ============================================
// A name from the first line
// ============================================

const NAME_WORDS = 4;
const NAME_LENGTH = 40;

/** Openings that say nothing about what the agent does. */
const OPENINGS = [
  /^you are (?:an? |the )?/i,
  /^(?:i|we) (?:want|need|would like|'d like) (?:an? |the )?(?:agent|assistant|bot) (?:that|which|who|to) /i,
  /^(?:i|we) (?:want|need|would like|'d like) (?:it |this |you )?to /i,
  /^(?:an? |the )?(?:agent|assistant|bot) (?:that|which|who|to) /i,
  /^(?:it|this agent|the agent) (?:should|will|must|needs to|has to) /i,
  /^(?:please|kindly) /i,
  /^(?:an?|the) /i,
];

/** Words a name does not end on. */
const TRAILING = new Set([
  "a", "an", "the", "and", "or", "of", "for", "to", "about", "our", "my", "your", "their", "with", "in", "on", "at",
  "from", "by", "that", "which", "who", "is", "are", "it", "its", "this", "these", "those", "every", "each", "into",
]);

/**
 * A short name from what the owner wrote: the first sentence, without an
 * opening like "You are a", cut to four words, not ending on "the" or "for".
 * "Answer customer questions about our returns" is "Answer customer
 * questions". "" when there is not enough to name it from.
 */
export function suggestAgentName(text: string): string {
  const firstLine = String(text ?? "").trim().split(/\n/)[0] ?? "";
  let line = (firstLine.split(/[.!?;:](?:\s|$)/)[0] ?? "").trim();
  for (let pass = 0; pass < 3; pass += 1) {
    const before = line;
    for (const opening of OPENINGS) line = line.replace(opening, "");
    if (line === before) break;
  }
  const words = line
    .replace(/[^\p{L}\p{N}'&\- ]+/gu, " ")
    .split(/\s+/)
    .map((word) => word.replace(/^['\-]+|['\-]+$/g, ""))
    .filter((word) => word.length > 0);

  const kept: string[] = [];
  for (const word of words) {
    if (kept.length === NAME_WORDS) break;
    if ([...kept, word].join(" ").length > NAME_LENGTH) break;
    kept.push(word);
  }
  while (kept.length > 0 && TRAILING.has(kept[kept.length - 1]!.toLowerCase())) kept.pop();

  const name = kept.join(" ");
  if (name.length < NAME_MIN_LENGTH) return "";
  return name[0]!.toUpperCase() + name.slice(1);
}

/** The draft after its instructions changed: the name follows until the owner has edited it by hand. */
export function withInstructions(draft: AgentDraft, instructions: string): AgentDraft {
  return {
    ...draft,
    instructions,
    ...(!draft.nameEdited && { name: suggestAgentName(instructions) }),
  };
}

/** The draft after its name was typed by hand. Clearing the name lets it follow the instructions again. */
export function withName(draft: AgentDraft, name: string): AgentDraft {
  return { ...draft, name, nameEdited: name.trim() !== "" };
}

// ============================================
// Starting points
// ============================================

export interface NewDraftOptions {
  kind?: AgentKind;
  /** The browser's time zone. */
  timezone: string;
  /** The form a task agent starts with. */
  fields: FieldDraft[];
  /** The model an agent answers on when none is chosen; "" when none is known. */
  defaultModel?: string;
  cronExpression?: string;
}

/** An empty draft: a chat agent with the default form and schedule waiting behind the other two choices. */
export function newDraft(options: NewDraftOptions): AgentDraft {
  const model = options.defaultModel ?? "";
  return {
    kind: options.kind ?? "conversation",
    instructions: "",
    name: "",
    nameEdited: false,
    fields: options.fields,
    schedule: { cronExpression: options.cronExpression ?? "0 9 * * *", timezone: options.timezone },
    deliverChannelId: null,
    template: null,
    advanced: { model, temperature: DEFAULT_TEMPERATURE, tools: [], knowledgeBaseId: "", secrets: [] },
    baseline: { model, temperature: DEFAULT_TEMPERATURE, tools: [] },
  };
}

/** A template as the create screen reads it. The list and the single read both carry these. */
export interface TemplateForDraft {
  id: string;
  title: string;
  agentKind: AgentKind;
  kindConfig: KindConfig | null;
  systemPrompt?: string | null;
  tools?: unknown;
  modelConfig?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The tools of a template that can be read, as they are stored. */
export function templateTools(tools: unknown): AgentTool[] {
  if (!Array.isArray(tools)) return [];
  return tools.filter(
    (tool): tool is AgentTool => isObject(tool) && typeof tool.name === "string" && tool.name !== "",
  );
}

/**
 * The draft after a template was chosen: its name, instructions, kind and
 * that kind's settings fill the form, and Advanced starts from the
 * template's model, creativity and tools. The time zone, the place results
 * go to, knowledge and secrets are the owner's and are kept.
 *
 * `availableModels` are the ids GET /api/capabilities lists. A template's
 * model that is not among them is left as it is ("" in the picker).
 */
export function applyTemplate(
  draft: AgentDraft,
  template: TemplateForDraft,
  context: { makeFieldId: (index: number) => string; availableModels?: readonly string[] },
): AgentDraft {
  const scheduled =
    isObject(template.kindConfig) && isObject(template.kindConfig.scheduled) ? template.kindConfig.scheduled : null;
  const suggestedCron =
    scheduled && isObject(scheduled.schedule) && typeof scheduled.schedule.cronExpression === "string"
      ? scheduled.schedule.cronExpression
      : null;
  const runLine = scheduled && typeof scheduled.prompt === "string" && scheduled.prompt.trim() ? scheduled.prompt : undefined;

  const modelConfig = isObject(template.modelConfig) ? template.modelConfig : {};
  const templateModel = typeof modelConfig.externalModel === "string" ? modelConfig.externalModel : "";
  const model = templateModel && (context.availableModels ?? []).includes(templateModel) ? templateModel : "";
  const temperature =
    typeof modelConfig.temperature === "number" && modelConfig.temperature >= 0 && modelConfig.temperature <= 2
      ? modelConfig.temperature
      : DEFAULT_TEMPERATURE;
  const tools = templateTools(template.tools);

  return {
    ...draft,
    kind: template.agentKind,
    name: template.title,
    nameEdited: true,
    instructions: template.systemPrompt ?? "",
    fields:
      template.agentKind === "task"
        ? draftsFromFields(taskFieldsOf(template.kindConfig), context.makeFieldId)
        : draft.fields,
    schedule: { ...draft.schedule, ...(suggestedCron && { cronExpression: suggestedCron }) },
    template: { id: template.id, ...(runLine && { runLine }) },
    advanced: { ...draft.advanced, model, temperature, tools: tools.map((tool) => tool.name) },
    baseline: { model, temperature, tools },
  };
}

/**
 * The draft after its template was let go: what is in the form stays, and
 * Advanced is measured against the platform's defaults again, so what the
 * template had brought is now sent as the owner's own choice.
 */
export function withoutTemplate(draft: AgentDraft, defaultModel = ""): AgentDraft {
  return {
    ...draft,
    template: null,
    baseline: { model: defaultModel, temperature: DEFAULT_TEMPERATURE, tools: [] },
  };
}

/** What is the owner's whatever template is chosen: carried from the draft on screen into a kept one. */
function carryOwn(kept: AgentDraft, current: AgentDraft, defaultModel = ""): AgentDraft {
  // The kept draft may be older than the list of models: it then starts on the default, as a plain draft does.
  const unset = kept.baseline.model === "" && kept.advanced.model === "" && defaultModel !== "";
  return {
    ...kept,
    schedule: { ...kept.schedule, timezone: current.schedule.timezone },
    deliverChannelId: current.deliverChannelId,
    advanced: {
      ...kept.advanced,
      ...(unset && { model: defaultModel }),
      knowledgeBaseId: current.advanced.knowledgeBaseId,
      secrets: current.advanced.secrets,
    },
    baseline: { ...kept.baseline, ...(unset && { model: defaultModel }) },
  };
}

/**
 * A template chip was pressed. `kept` is the draft as it was before any chip
 * (null while none is pressed). The first chip keeps the draft on screen;
 * another chip fills the form from that kept draft, never from the previous
 * template's values, so what the owner typed is not lost under two layers.
 */
export function chooseTemplateOver(
  current: AgentDraft,
  kept: AgentDraft | null,
  template: TemplateForDraft,
  context: { makeFieldId: (index: number) => string; availableModels?: readonly string[] },
): { draft: AgentDraft; kept: AgentDraft } {
  const before = current.template && kept ? carryOwn(kept, current) : current.template ? withoutTemplate(current) : current;
  return { draft: applyTemplate(before, template, context), kept: before };
}

/**
 * The pressed chip was pressed again: the draft is as it was before the
 * chip, with the time zone, the place for results, knowledge and secrets as
 * they are now. With nothing kept, the form stays and only the template goes.
 */
export function releaseTemplate(current: AgentDraft, kept: AgentDraft | null, defaultModel = ""): AgentDraft {
  if (!kept) return withoutTemplate(current, defaultModel);
  return { ...carryOwn(kept, current, defaultModel), template: null };
}

// ============================================
// Before a request is sent
// ============================================

/** Where a problem is shown: the input it belongs to. */
export type DraftProblemField =
  | "instructions"
  | "name"
  | "fields"
  | "schedule.cronExpression"
  | "schedule.timezone"
  | "secrets";

export type DraftProblems = Partial<Record<DraftProblemField, string>>;

/** The order problems are read in: top of the screen to the bottom. */
const PROBLEM_ORDER: DraftProblemField[] = [
  "instructions",
  "name",
  "fields",
  "schedule.cronExpression",
  "schedule.timezone",
  "secrets",
];

/**
 * What stops this draft from being sent, one sentence per input. Empty when
 * it can be sent. The server is the authority; this only says early what it
 * would refuse, or what would make an agent with nothing to do.
 */
export function validateDraft(draft: AgentDraft): DraftProblems {
  const problems: DraftProblems = {};

  const instructions = draft.instructions.trim();
  if (!instructions) problems.instructions = DRAFT_MESSAGES.instructions;
  else if (instructions.length > INSTRUCTIONS_MAX_LENGTH) problems.instructions = DRAFT_MESSAGES.instructionsTooLong;

  const name = draft.name.trim();
  if (name.length < NAME_MIN_LENGTH) problems.name = DRAFT_MESSAGES.name;
  else if (name.length > NAME_MAX_LENGTH) problems.name = DRAFT_MESSAGES.nameTooLong;

  if (draft.kind === "task") {
    const problem = firstFieldProblem(draft.fields, checkFields(draft.fields));
    if (problem) problems.fields = problem;
  }

  if (draft.kind === "scheduled") {
    if (!looksLikeCron(draft.schedule.cronExpression)) problems["schedule.cronExpression"] = DRAFT_MESSAGES.cron;
    if (!draft.schedule.timezone.trim()) problems["schedule.timezone"] = DRAFT_MESSAGES.timezone;
  }

  if (draft.advanced.secrets.some((secret) => !secret.key.trim() && secret.value !== "")) {
    problems.secrets = DRAFT_MESSAGES.secretName;
  }

  return problems;
}

/** The first problem from the top of the screen, as one sentence, or null. It is what the Create button says while it is off. */
export function firstProblem(problems: DraftProblems): string | null {
  for (const field of PROBLEM_ORDER) {
    const sentence = problems[field];
    if (sentence) return sentence;
  }
  return null;
}

/**
 * What holds the Create button, as the one sentence shown beside it, or
 * null when the draft can be sent. `linkPending`: Slack or Discord is chosen
 * for a self-running agent and its link has not been saved yet, so creating
 * now would drop the link.
 */
export function createHold(draft: AgentDraft, problems: DraftProblems, linkPending: boolean): string | null {
  return firstProblem(problems) ?? (draft.kind === "scheduled" && linkPending ? DRAFT_MESSAGES.linkNotSaved : null);
}

// ============================================
// The request
// ============================================

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const inB = new Set(b);
  return a.every((item) => inB.has(item));
}

/**
 * The body of POST /api/agents for this draft:
 *
 *   name, agentKind, systemPrompt (the instructions)
 *   kindConfig     task: { task: { fields } }; otherwise left out
 *   templateId     when a template was chosen
 *   schedule       scheduled: { cronExpression, timezone }, with
 *                  deliver: { channelId } when a place was chosen and
 *                  prompt when the template suggested a line
 *   modelConfig, tools, knowledgeBaseId, env
 *                  only what the owner changed under Advanced
 *
 * framework, sourceType, code and description are never sent from here.
 * `toolDescriptions` gives a newly switched-on tool its description, by key.
 */
export function draftToCreateInput(
  draft: AgentDraft,
  toolDescriptions: Record<string, string> = {},
): CreateAgentInput {
  const input: CreateAgentInput = {
    name: draft.name.trim(),
    agentKind: draft.kind,
  };

  const instructions = draft.instructions.trim();
  if (instructions) input.systemPrompt = instructions;

  if (draft.kind === "task") {
    input.kindConfig = { task: { fields: toFieldInputs(draft.fields) } };
  }

  if (draft.template) input.templateId = draft.template.id;

  if (draft.kind === "scheduled") {
    input.schedule = {
      cronExpression: draft.schedule.cronExpression.trim(),
      timezone: draft.schedule.timezone.trim(),
      ...(draft.deliverChannelId && { deliver: { channelId: draft.deliverChannelId } }),
      ...(draft.template?.runLine && { prompt: draft.template.runLine }),
    };
  }

  // Advanced: only what differs from where it started.
  const { advanced, baseline } = draft;
  const modelConfig: NonNullable<CreateAgentInput["modelConfig"]> = {};
  if (advanced.model && advanced.model !== baseline.model) modelConfig.externalModel = advanced.model;
  if (advanced.temperature !== baseline.temperature) modelConfig.temperature = advanced.temperature;
  if (Object.keys(modelConfig).length > 0) input.modelConfig = modelConfig;

  const baselineKeys = baseline.tools.map((tool) => tool.name);
  if (!sameSet(advanced.tools, baselineKeys)) {
    input.tools = advanced.tools.map((key) => {
      const kept = baseline.tools.find((tool) => tool.name === key);
      if (kept) return kept;
      const description = toolDescriptions[key];
      return { name: key, type: "function" as const, ...(description && { description }) };
    });
  }

  if (advanced.knowledgeBaseId) input.knowledgeBaseId = advanced.knowledgeBaseId;

  const env: Record<string, string> = {};
  for (const { key, value } of advanced.secrets) {
    if (key.trim()) env[key.trim()] = value;
  }
  if (Object.keys(env).length > 0) input.env = env;

  return input;
}

// ============================================
// Problems the server found
// ============================================

/**
 * Where each sentence of a 400 belongs on this screen. `byInput` is keyed
 * like validateDraft's problems plus "schedule.deliver.channelId" and
 * "templateId"; `formFields` are the ones for the question builder, as the
 * server named them; `advanced` and `other` are shown as lines of their own.
 */
export function placeServerProblems(fields: Record<string, string>): {
  byInput: Partial<Record<DraftProblemField | "schedule.deliver.channelId" | "templateId", string>>;
  formFields: Record<string, string>;
  advanced: string[];
  other: string[];
} {
  const byInput: ReturnType<typeof placeServerProblems>["byInput"] = {};
  const formFields: Record<string, string> = {};
  const advanced: string[] = [];
  const other: string[] = [];
  for (const [path, sentence] of Object.entries(fields)) {
    if (path === "name") byInput.name ??= sentence;
    else if (path === "systemPrompt") byInput.instructions ??= sentence;
    else if (path === "templateId") byInput.templateId ??= sentence;
    else if (path === "schedule.cronExpression") byInput["schedule.cronExpression"] ??= sentence;
    else if (path === "schedule.timezone") byInput["schedule.timezone"] ??= sentence;
    else if (path === "schedule.deliver.channelId" || path === "schedule.deliver") {
      byInput["schedule.deliver.channelId"] ??= sentence;
    } else if (path === "kindConfig" || path.startsWith("kindConfig.task")) formFields[path] = sentence;
    else if (
      path === "env" ||
      path.startsWith("env.") ||
      path === "tools" ||
      path.startsWith("tools[") ||
      path === "modelConfig" ||
      path.startsWith("modelConfig.") ||
      path === "knowledgeBaseId"
    ) {
      advanced.push(sentence);
    } else other.push(sentence);
  }
  return { byInput, formFields, advanced, other };
}
