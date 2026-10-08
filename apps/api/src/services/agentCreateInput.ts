/**
 * What a caller sent to create an agent, as the full agent to store. Pure.
 *
 * Only a name is needed. Everything else has a default: the framework is
 * `custom`, the source is `inline` (with or without code), the kind is
 * `conversation`. An agent made from a template starts from the template's
 * values instead, and what the caller sends replaces them field by field.
 *
 * A free model the platform cannot serve right now is left unset, so the
 * first available one answers (services/agentModelResolution.ts) and the
 * agent is not created pointing at a model that would refuse every chat.
 *
 * Problems come back as plain sentences by field, in the shape of every
 * other 400 `validation_failed` (lib/validationFailure.ts).
 */

import { z } from "zod";
import type { AgentKind, KindConfig } from "@wheelsai/shared/agent-kind";

import { AGENT_FRAMEWORKS } from "../config/frameworks.js";
import {
  WHOLE_REQUEST_FIELD,
  fieldPath,
  plainIssue,
  topLevelField,
  validationFailureFromFields,
  type ValidationFailureBody,
} from "../lib/validationFailure.js";
import { resolveKindConfig } from "./agentKind.js";
import { slugify } from "./agentSlug.js";

export const AGENT_CREATE_MESSAGES = {
  name: "Give your agent a name of at least 3 characters.",
  nameTooLong: "Keep the name to 100 characters or fewer.",
  sourceUrl: "Add the address of the code. An agent imported from GitHub or IPFS needs one.",
  template: "Choose a template from the list.",
} as const;

export const DEFAULT_AGENT_FRAMEWORK = "custom";
export const DEFAULT_AGENT_SOURCE_TYPE = "inline";
export const DEFAULT_AGENT_TEMPERATURE = 0.7;
export const DEFAULT_AGENT_MAX_TOKENS = 4096;

/** Ids of the platform's free models start with this (config/free-models.ts). */
const FREE_MODEL_PREFIX = "free/";

const toolSchema = z.object({
  name: z.string(),
  type: z.enum(["function", "api", "mcp"]),
  description: z.string().optional(),
  config: z.record(z.any()).optional(),
});

/**
 * The fields of an agent a caller may send. PATCH /api/agents/:id accepts
 * any part of this; a create accepts it with only the name required.
 */
export const agentFieldsSchema = z.object({
  name: z.string().min(3).max(100),
  description: z.string().max(500).optional(),
  framework: z.enum(AGENT_FRAMEWORKS),
  systemPrompt: z.string().max(10000).optional(),
  tools: z.array(toolSchema).default([]),
  modelConfig: z.object({
    modelId: z.string().optional(), // WheelsAI model ID
    externalModel: z.string().optional(), // e.g., "openai/gpt-4"
    temperature: z.number().min(0).max(2).default(DEFAULT_AGENT_TEMPERATURE),
    maxTokens: z.number().int().min(1).max(32768).default(DEFAULT_AGENT_MAX_TOKENS),
  }),
  sourceType: z.enum(["inline", "github", "ipfs"]),
  sourceUrl: z.string().url().optional(),
  sourceCode: z.string().max(100000).optional(),
  env: z.record(z.string()).default({}),
  tags: z.array(z.string()).default([]),
  isPublic: z.boolean().default(false),
  // Optional RAG grounding (W2): bind a knowledge base and the agent's
  // chat answers get grounded in retrieved passages. null unbinds.
  knowledgeBaseId: z.string().uuid().nullable().optional(),
});

const createSchema = agentFieldsSchema.partial().extend({
  name: z
    .string({ required_error: AGENT_CREATE_MESSAGES.name, invalid_type_error: AGENT_CREATE_MESSAGES.name })
    .trim()
    .min(3, AGENT_CREATE_MESSAGES.name)
    .max(100, AGENT_CREATE_MESSAGES.nameTooLong),
  // Left out, the slug is made from the name. Either way it is made unique.
  slug: z.string().max(100).optional(),
  // null is "no template", as readTemplateId reads it.
  templateId: z.string().uuid(AGENT_CREATE_MESSAGES.template).nullable().optional(),
  // Read by resolveKindConfig, which answers in plain words by field.
  agentKind: z.unknown().optional(),
  kindConfig: z.unknown().optional(),
});

/** What a template gives an agent made from it. `env` is opened by the caller. */
export interface AgentCreateDefaults {
  description?: string | null;
  framework: string;
  systemPrompt?: string | null;
  tools?: unknown;
  modelConfig?: unknown;
  sourceType?: string | null;
  sourceCode?: string | null;
  sourceUrl?: string | null;
  env?: Record<string, string>;
  tags?: readonly string[];
  agentKind?: string | null;
  kindConfig?: unknown;
}

export interface AgentCreateContext {
  /** Ids of free models whose provider key is configured, in catalog order. */
  availableFreeModelIds: readonly string[];
  /** The template the agent is made from, when there is one. */
  template?: AgentCreateDefaults | null;
  /** For the check of a suggested schedule. Defaults to the present. */
  now?: Date;
}

/** Everything about the new agent but its organization, its slug and its sealed secrets. */
export interface AgentCreateData {
  name: string;
  /** What the slug is made from: a slug the caller asked for, or the name. */
  slugFrom: string;
  description: string | undefined;
  framework: string;
  systemPrompt: string | undefined;
  tools: unknown[];
  modelConfig: Record<string, unknown>;
  sourceType: string;
  sourceUrl: string | undefined;
  sourceCode: string | undefined;
  /** In the clear. The create path seals it before it is stored. */
  env: Record<string, string>;
  tags: string[];
  isPublic: boolean;
  knowledgeBaseId: string | null;
  agentKind: AgentKind;
  kindConfig: KindConfig | null;
}

export type AgentCreateResolution =
  | { ok: true; data: AgentCreateData }
  | { ok: false; failure: ValidationFailureBody };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/**
 * The model settings without a free model the platform cannot serve now.
 * Both places a chat reads a model from are checked: `externalModel` and the
 * legacy `model`. A model the caller runs themselves is never touched.
 */
export function withoutUnavailableFreeModel(
  modelConfig: Record<string, unknown>,
  availableFreeModelIds: readonly string[],
): Record<string, unknown> {
  const unavailable = (value: unknown) =>
    typeof value === "string" &&
    value.trim().startsWith(FREE_MODEL_PREFIX) &&
    !availableFreeModelIds.includes(value.trim());
  const { externalModel, model, ...rest } = modelConfig;
  return {
    ...rest,
    ...(externalModel !== undefined && !unavailable(externalModel) && { externalModel }),
    ...(model !== undefined && !unavailable(model) && { model }),
  };
}

export type TemplateIdReading =
  | { ok: true; templateId: string | null }
  | { ok: false; failure: ValidationFailureBody };

/**
 * The template a create names in its body, before anything else is read: the
 * template has to be loaded for the rest to be resolved against it.
 */
export function readTemplateId(body: unknown): TemplateIdReading {
  const sent = isObject(body) ? body.templateId : undefined;
  if (sent === undefined || sent === null) return { ok: true, templateId: null };
  const parsed = z.string().uuid().safeParse(sent);
  if (parsed.success) return { ok: true, templateId: parsed.data };
  return { ok: false, failure: validationFailureFromFields({ templateId: AGENT_CREATE_MESSAGES.template }) };
}

export function resolveAgentCreate(body: unknown, context: AgentCreateContext): AgentCreateResolution {
  const template = context.template ?? null;
  const parsed = createSchema.safeParse(body);

  const fields: Record<string, string> = {};
  const details: ValidationFailureBody["details"] = parsed.success
    ? { formErrors: [], fieldErrors: {} }
    : parsed.error.flatten();
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = fieldPath(issue.path) || WHOLE_REQUEST_FIELD;
      if (!(field in fields)) fields[field] = plainIssue(issue);
    }
  }
  // A problem found here, beside the ones zod found.
  const problem = (field: string, message: string) => {
    if (field in fields) return;
    fields[field] = message;
    (details.fieldErrors[topLevelField(field)] ??= []).push(message);
  };

  // The kind and its settings. With a template they start from the
  // template's, and a key the caller sends replaces that key.
  const sent = isObject(body) ? body : {};
  const kind = resolveKindConfig(
    { agentKind: sent.agentKind, kindConfig: sent.kindConfig },
    {
      ...(template && { current: { agentKind: template.agentKind, kindConfig: template.kindConfig } }),
      now: context.now,
    },
  );
  if (!kind.ok) {
    for (const [field, message] of Object.entries(kind.fields)) problem(field, message);
  }

  if (parsed.success) {
    const input = parsed.data;
    const sourceType = input.sourceType ?? template?.sourceType ?? DEFAULT_AGENT_SOURCE_TYPE;
    const sourceUrl = input.sourceUrl ?? template?.sourceUrl ?? undefined;
    if ((sourceType === "github" || sourceType === "ipfs") && !sourceUrl) {
      problem("sourceUrl", AGENT_CREATE_MESSAGES.sourceUrl);
    }

    if (kind.ok && Object.keys(fields).length === 0) {
      // Model settings: the caller's over the template's. Only what the
      // caller actually sent replaces a template value, so a template's
      // temperature is not reset by the schema's default.
      let modelConfig: Record<string, unknown>;
      if (template) {
        const sentKeys = isObject(sent.modelConfig) ? Object.keys(sent.modelConfig) : [];
        const chosen = (input.modelConfig ?? {}) as Record<string, unknown>;
        modelConfig = { ...(isObject(template.modelConfig) ? template.modelConfig : {}) };
        for (const key of sentKeys) {
          if (chosen[key] !== undefined) modelConfig[key] = chosen[key];
        }
      } else {
        modelConfig = input.modelConfig ?? {
          temperature: DEFAULT_AGENT_TEMPERATURE,
          maxTokens: DEFAULT_AGENT_MAX_TOKENS,
        };
      }

      return {
        ok: true,
        data: {
          name: input.name,
          slugFrom: input.slug !== undefined && slugify(input.slug).length > 0 ? input.slug : input.name,
          description: nonEmpty(input.description) ? input.description : (template?.description ?? input.description),
          framework: input.framework ?? template?.framework ?? DEFAULT_AGENT_FRAMEWORK,
          systemPrompt: input.systemPrompt ?? template?.systemPrompt ?? undefined,
          tools: input.tools ?? (Array.isArray(template?.tools) ? [...template.tools] : []),
          modelConfig: withoutUnavailableFreeModel(modelConfig, context.availableFreeModelIds),
          sourceType,
          sourceUrl,
          sourceCode: input.sourceCode ?? template?.sourceCode ?? undefined,
          env: { ...(template?.env ?? {}), ...(input.env ?? {}) },
          tags: input.tags ?? [...(template?.tags ?? [])],
          isPublic: input.isPublic ?? false,
          knowledgeBaseId: input.knowledgeBaseId ?? null,
          agentKind: kind.agentKind,
          kindConfig: kind.kindConfig,
        },
      };
    }
  }

  const message = Object.values(fields)[0];
  return { ok: false, failure: { ...validationFailureFromFields(fields, message), details } };
}
