/**
 * Workflow definitions: the shape a client may save, and the checks a
 * definition must pass before it is saved or run.
 *
 * Two layers. The zod schema is strict, so an unknown key (orgId,
 * totalRuns, a nested write) is a validation error instead of a column
 * write. validateWorkflowDefinition then checks what a schema cannot:
 * the dependency graph plans, every reference points at a step whose
 * output will exist, loops and fallbacks are complete, the declared
 * schemas are enforceable, and every agent, deployment and knowledge base
 * belongs to the caller's organization.
 *
 * The same validation backs POST /plan (a dry run), create, replace, and
 * the re-check a worker makes before it runs a workflow, so a definition
 * cannot be saved in a state the engine would refuse.
 *
 * Pure apart from the injected ownership loader.
 */

import { z } from "zod";

import {
  collectReferences,
  collectTemplateReferences,
  PromptTemplateError,
  type Reference,
} from "./orchestrationMapping.js";
import {
  findReferenceViolations,
  OrchestrationPlanError,
  planOrchestration,
  planOrder,
  type StepReferences,
} from "./orchestrationPlan.js";
import { findUnsupportedSchemaKeyword, isEmptySchema } from "./workflowSchemaCheck.js";

// ============================================
// Bounds
// ============================================

export const WORKFLOW_LIMITS = {
  maxSteps: 25,
  maxConcurrency: 10,
  minTimeoutMs: 10_000,
  maxTimeoutMs: 3_600_000,
  maxRetries: 5,
  maxBackoffMs: 60_000,
  maxPromptChars: 20_000,
  maxMappingKeys: 50,
  maxMappingBytes: 32_768,
  maxSchemaBytes: 32_768,
  maxLayoutBytes: 65_536,
  minStepTimeoutMs: 1_000,
  maxStepTimeoutMs: 900_000,
  maxForEachItems: 50,
  maxUntilIterations: 10,
} as const;

export const EXECUTION_MODES = ["sequential", "parallel", "conditional", "pipeline"] as const;
export const STEP_TYPES = ["agent", "model", "retrieval"] as const;
export const CONDITION_OPERATORS = [
  "equals",
  "not_equals",
  "contains",
  "not_contains",
  "exists",
  "not_exists",
  "gt",
  "gte",
  "lt",
  "lte",
] as const;

export type StepType = (typeof STEP_TYPES)[number];

// ============================================
// Schema
// ============================================

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

const conditionSchema = z
  .object({
    left: z.unknown(),
    op: z.enum(CONDITION_OPERATORS),
    right: z.unknown().optional(),
  })
  .strict()
  .refine((c) => c.left !== undefined, { message: "condition needs a left operand", path: ["left"] });

const mappingSchema = z
  .record(z.unknown())
  .refine((m) => Object.keys(m).length <= WORKFLOW_LIMITS.maxMappingKeys, {
    message: `at most ${WORKFLOW_LIMITS.maxMappingKeys} keys`,
  })
  .refine((m) => jsonBytes(m) <= WORKFLOW_LIMITS.maxMappingBytes, {
    message: `at most ${WORKFLOW_LIMITS.maxMappingBytes} bytes`,
  });

const forEachLoopSchema = z
  .object({
    forEach: z.string().min(3).max(200),
    maxItems: z.number().int().min(1).max(WORKFLOW_LIMITS.maxForEachItems).optional(),
  })
  .strict();

const untilLoopSchema = z
  .object({
    until: conditionSchema,
    maxIterations: z.number().int().min(1).max(WORKFLOW_LIMITS.maxUntilIterations),
    onExhausted: z.enum(["fail", "continue"]).optional(),
  })
  .strict();

const loopSchema = z.union([forEachLoopSchema, untilLoopSchema]);

// `.`, `{`, `}` and `|` are the reference and template delimiters; a step
// name containing one could not be referenced unambiguously.
const stepNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[^.{}|]+$/, "step names cannot contain . { } or |")
  .refine((name) => name === name.trim(), "step names cannot start or end with a space");

const stepSchema = z
  .object({
    name: stepNameSchema,
    stepType: z.enum(STEP_TYPES).optional(),
    agentId: z.string().uuid().nullable().optional(),
    deploymentId: z.string().uuid().nullable().optional(),
    modelId: z.string().min(1).max(200).nullable().optional(),
    knowledgeBaseId: z.string().uuid().nullable().optional(),
    promptTemplate: z.string().max(WORKFLOW_LIMITS.maxPromptChars).nullable().optional(),
    inputMapping: mappingSchema.optional(),
    outputMapping: mappingSchema.optional(),
    outputFormat: z.enum(["text", "json"]).optional(),
    condition: conditionSchema.nullable().optional(),
    loop: loopSchema.nullable().optional(),
    onError: z.enum(["fail", "continue", "fallback"]).optional(),
    fallbackAgentId: z.string().uuid().nullable().optional(),
    maxRetries: z.number().int().min(0).max(WORKFLOW_LIMITS.maxRetries).optional(),
    timeoutMs: z
      .number()
      .int()
      .min(WORKFLOW_LIMITS.minStepTimeoutMs)
      .max(WORKFLOW_LIMITS.maxStepTimeoutMs)
      .nullable()
      .optional(),
    dependsOn: z.array(z.string().min(1).max(64)).max(WORKFLOW_LIMITS.maxSteps - 1).optional(),
  })
  .strict();

const jsonSchemaField = z
  .record(z.unknown())
  .refine((s) => jsonBytes(s) <= WORKFLOW_LIMITS.maxSchemaBytes, {
    message: `at most ${WORKFLOW_LIMITS.maxSchemaBytes} bytes`,
  });

const finite = z.number().finite();

// Canvas state for the editor: where each step sits, keyed by step name,
// and the viewport. Stored verbatim; the engine never reads it.
export const workflowLayoutSchema = z
  .object({
    positions: z.record(z.object({ x: finite, y: finite }).strict()).optional(),
    viewport: z.object({ x: finite, y: finite, zoom: finite.positive() }).strict().optional(),
  })
  .strict()
  .refine((l) => jsonBytes(l) <= WORKFLOW_LIMITS.maxLayoutBytes, {
    message: `at most ${WORKFLOW_LIMITS.maxLayoutBytes} bytes`,
  });

export const workflowDefinitionSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().max(500).nullable().optional(),
    executionMode: z.enum(EXECUTION_MODES),
    maxConcurrency: z.number().int().min(1).max(WORKFLOW_LIMITS.maxConcurrency).optional(),
    timeout: z
      .number()
      .int()
      .min(WORKFLOW_LIMITS.minTimeoutMs)
      .max(WORKFLOW_LIMITS.maxTimeoutMs)
      .optional(),
    retryPolicy: z
      .object({
        maxRetries: z.number().int().min(0).max(WORKFLOW_LIMITS.maxRetries).optional(),
        backoffMs: z.number().int().min(0).max(WORKFLOW_LIMITS.maxBackoffMs).optional(),
      })
      .strict()
      .optional(),
    inputSchema: jsonSchemaField.optional(),
    outputSchema: jsonSchemaField.optional(),
    layout: workflowLayoutSchema.nullable().optional(),
    steps: z.array(stepSchema).min(1).max(WORKFLOW_LIMITS.maxSteps),
  })
  .strict();

export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;
export type WorkflowStepDefinition = z.infer<typeof stepSchema>;

/** PUT body: a full definition plus an optional optimistic-lock token. */
export const workflowReplaceSchema = workflowDefinitionSchema.extend({
  expectedUpdatedAt: z.string().datetime().optional(),
});

/** PATCH body: metadata only. Steps and settings change through PUT. */
export const workflowPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().max(500).nullable().optional(),
    isEnabled: z.boolean().optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0, { message: "nothing to update" });

export type WorkflowPatch = z.infer<typeof workflowPatchSchema>;

// ============================================
// Validation
// ============================================

export interface OwnedResourceIds {
  agentIds: string[];
  deploymentIds: string[];
  knowledgeBaseIds: string[];
}

/** Returns the subset of the given ids that belong to the organization. */
export type LoadOwnership = (ids: OwnedResourceIds) => Promise<OwnedResourceIds>;

export interface WorkflowCapabilities {
  /** Whether this server can run `model` steps, and why not when it cannot. */
  modelSteps: { available: boolean; reason?: string };
}

export interface PlanPreview {
  levels: string[][];
  order: string[];
  concurrency: number;
  warnings: string[];
}

export interface WorkflowIssue {
  message: string;
  step?: string;
  field?: string;
}

export type WorkflowValidation =
  | { ok: true; plan: PlanPreview }
  | { ok: false; issue: WorkflowIssue };

/** The structural shape validation reads; stored rows satisfy it too. */
export interface ValidatableWorkflow {
  executionMode: string;
  maxConcurrency?: number;
  inputSchema?: unknown;
  outputSchema?: unknown;
  steps: Array<{
    name: string;
    stepType?: string | null;
    agentId?: string | null;
    deploymentId?: string | null;
    modelId?: string | null;
    knowledgeBaseId?: string | null;
    promptTemplate?: string | null;
    inputMapping?: unknown;
    outputMapping?: unknown;
    outputFormat?: string | null;
    condition?: unknown;
    loop?: unknown;
    onError?: string | null;
    fallbackAgentId?: string | null;
    dependsOn?: string[] | null;
  }>;
}

type ValidatableStep = ValidatableWorkflow["steps"][number];

function fail(message: string, step?: string, field?: string): WorkflowValidation {
  return { ok: false, issue: { message, step, field } };
}

function isForEachLoop(loop: unknown): loop is { forEach: unknown; maxItems?: unknown } {
  return typeof loop === "object" && loop !== null && "forEach" in loop;
}

function isUntilLoop(loop: unknown): loop is { until: unknown; maxIterations?: unknown } {
  return typeof loop === "object" && loop !== null && "until" in loop;
}

function checkStepShape(step: ValidatableStep): WorkflowIssue | null {
  const type = step.stepType ?? "agent";
  const at = (message: string, field: string): WorkflowIssue => ({ message, step: step.name, field });

  if (type === "agent") {
    if (!step.agentId) return at(`step "${step.name}" is an agent step and needs an agentId`, "agentId");
    if (step.deploymentId || step.modelId) {
      return at(`step "${step.name}" is an agent step; deploymentId and modelId belong to model steps`, "deploymentId");
    }
    if (step.knowledgeBaseId) {
      return at(`step "${step.name}" is an agent step; knowledgeBaseId belongs to retrieval steps`, "knowledgeBaseId");
    }
  } else if (type === "model") {
    if (!step.deploymentId) {
      return at(`step "${step.name}" is a model step and needs a deploymentId`, "deploymentId");
    }
    if (step.agentId) return at(`step "${step.name}" is a model step; agentId belongs to agent steps`, "agentId");
    if (step.knowledgeBaseId) {
      return at(`step "${step.name}" is a model step; knowledgeBaseId belongs to retrieval steps`, "knowledgeBaseId");
    }
  } else if (type === "retrieval") {
    if (!step.knowledgeBaseId) {
      return at(`step "${step.name}" is a retrieval step and needs a knowledgeBaseId`, "knowledgeBaseId");
    }
    if (step.agentId) return at(`step "${step.name}" is a retrieval step; agentId belongs to agent steps`, "agentId");
    if (step.deploymentId || step.modelId) {
      return at(`step "${step.name}" is a retrieval step; deploymentId and modelId belong to model steps`, "deploymentId");
    }
    // A search returns passages, already structured.
    if (step.outputFormat === "json") {
      return at(`step "${step.name}" is a retrieval step; outputFormat applies to agent and model steps`, "outputFormat");
    }
    if (step.onError === "fallback") {
      return at(`step "${step.name}" is a retrieval step and cannot fall back to an agent`, "onError");
    }
  } else {
    return at(`step "${step.name}" has unknown stepType "${type}"`, "stepType");
  }

  if (step.onError === "fallback" && !step.fallbackAgentId) {
    return at(`step "${step.name}" uses onError "fallback" but has no fallbackAgentId`, "fallbackAgentId");
  }

  if (step.loop !== null && step.loop !== undefined) {
    const forEach = isForEachLoop(step.loop);
    const until = isUntilLoop(step.loop);
    if (forEach === until) {
      return at(`step "${step.name}" loop must be either forEach or until`, "loop");
    }
    if (
      isForEachLoop(step.loop) &&
      (typeof step.loop.forEach !== "string" || !step.loop.forEach.startsWith("$."))
    ) {
      return at(`step "${step.name}" loop.forEach must be a reference such as $.steps.<name>.output`, "loop");
    }
  }
  return null;
}

interface StepReferenceSet {
  /** Steps read before the step runs (prompt, mapping, condition, loop source). */
  reads: string[];
  /** Steps read after it ran (output mapping, until condition); may name itself. */
  readsAfter: string[];
  issue: WorkflowIssue | null;
}

function gatherReferences(step: ValidatableStep): StepReferenceSet {
  const reads: string[] = [];
  const readsAfter: string[] = [];
  const inForEach = isForEachLoop(step.loop);
  const inUntil = isUntilLoop(step.loop);

  const scan = (
    references: Array<Reference | { kind: null; raw: string }>,
    field: string,
    into: string[],
  ): WorkflowIssue | null => {
    for (const reference of references) {
      if (reference.kind === null) {
        return {
          message: `step "${step.name}" ${field} has an unreadable reference "$.${reference.raw}"`,
          step: step.name,
          field,
        };
      }
      if ((reference.kind === "item" || reference.kind === "index") && !inForEach) {
        return {
          message: `step "${step.name}" ${field} uses ${reference.kind}, which only exists inside a forEach loop`,
          step: step.name,
          field,
        };
      }
      if (reference.kind === "iteration" && !inUntil) {
        return {
          message: `step "${step.name}" ${field} uses iteration, which only exists inside an until loop`,
          step: step.name,
          field,
        };
      }
      if (reference.kind === "steps" && reference.step) into.push(reference.step);
    }
    return null;
  };

  let templateReferences: Reference[] = [];
  if (typeof step.promptTemplate === "string") {
    try {
      templateReferences = collectTemplateReferences(step.promptTemplate);
    } catch (err) {
      const message = err instanceof PromptTemplateError ? err.message : String(err);
      return {
        reads,
        readsAfter,
        issue: { message: `step "${step.name}": ${message}`, step: step.name, field: "promptTemplate" },
      };
    }
  }

  const issue =
    scan(templateReferences, "promptTemplate", reads) ??
    scan(collectReferences(step.inputMapping), "inputMapping", reads) ??
    scan(collectReferences(step.condition), "condition", reads) ??
    scan(isForEachLoop(step.loop) ? collectReferences(step.loop.forEach) : [], "loop", reads) ??
    scan(collectReferences(step.outputMapping), "outputMapping", readsAfter) ??
    scan(isUntilLoop(step.loop) ? collectReferences(step.loop.until) : [], "loop", readsAfter);

  return { reads, readsAfter, issue };
}

function hasOwnPrompt(step: ValidatableStep): boolean {
  if (typeof step.promptTemplate === "string" && step.promptTemplate.trim() !== "") return true;
  const mapping = step.inputMapping;
  return typeof mapping === "object" && mapping !== null && "prompt" in mapping;
}

export async function validateWorkflowDefinition(
  def: ValidatableWorkflow,
  deps: { loadOwnership: LoadOwnership; capabilities?: WorkflowCapabilities },
): Promise<WorkflowValidation> {
  const names = new Set<string>();
  for (const step of def.steps) {
    if (names.has(step.name)) {
      return fail(`duplicate step name: ${step.name}`, step.name, "name");
    }
    names.add(step.name);
  }

  for (const step of def.steps) {
    for (const dep of step.dependsOn ?? []) {
      if (dep === step.name) {
        return fail(`step "${step.name}" depends on itself`, step.name, "dependsOn");
      }
      if (!names.has(dep)) {
        return fail(`step "${step.name}" depends on unknown step "${dep}"`, step.name, "dependsOn");
      }
    }
  }

  const plannable = def.steps.map((s, i) => ({
    id: s.name,
    name: s.name,
    stepOrder: i,
    dependsOn: s.dependsOn ?? [],
  }));
  let plan: ReturnType<typeof planOrchestration>;
  try {
    plan = planOrchestration(plannable, def.executionMode, def.maxConcurrency ?? 5);
  } catch (err) {
    if (err instanceof OrchestrationPlanError) return fail(err.message, undefined, "dependsOn");
    throw err;
  }

  const references: StepReferences[] = [];
  for (const step of def.steps) {
    const shapeIssue = checkStepShape(step);
    if (shapeIssue) return { ok: false, issue: shapeIssue };

    const gathered = gatherReferences(step);
    if (gathered.issue) return { ok: false, issue: gathered.issue };
    references.push({
      step: step.name,
      references: [
        ...gathered.reads,
        // A step may read its OWN output once it has run.
        ...gathered.readsAfter.filter((name) => name !== step.name),
      ],
    });
    if (gathered.reads.includes(step.name)) {
      return fail(
        `step "${step.name}" reads its own output before it has run`,
        step.name,
        "promptTemplate",
      );
    }
  }

  const violation = findReferenceViolations(plannable, def.executionMode, plan, references)[0];
  if (violation) return fail(violation.message, violation.step, "references");

  for (const field of ["inputSchema", "outputSchema"] as const) {
    const schema = def[field];
    if (isEmptySchema(schema)) continue;
    const problem = findUnsupportedSchemaKeyword(schema, field);
    if (problem) return fail(problem, undefined, field);
  }

  const wanted: OwnedResourceIds = {
    agentIds: [
      ...new Set(
        def.steps.flatMap((s) => [s.agentId, s.fallbackAgentId]).filter((id): id is string => Boolean(id)),
      ),
    ],
    deploymentIds: [
      ...new Set(def.steps.map((s) => s.deploymentId).filter((id): id is string => Boolean(id))),
    ],
    knowledgeBaseIds: [
      ...new Set(def.steps.map((s) => s.knowledgeBaseId).filter((id): id is string => Boolean(id))),
    ],
  };
  const owned = await deps.loadOwnership(wanted);
  const ownedAgents = new Set(owned.agentIds);
  const ownedDeployments = new Set(owned.deploymentIds);
  const ownedKnowledgeBases = new Set(owned.knowledgeBaseIds);
  for (const step of def.steps) {
    if (step.agentId && !ownedAgents.has(step.agentId)) {
      return fail(`step "${step.name}": agent ${step.agentId} not found in this organization`, step.name, "agentId");
    }
    if (step.fallbackAgentId && !ownedAgents.has(step.fallbackAgentId)) {
      return fail(
        `step "${step.name}": fallback agent ${step.fallbackAgentId} not found in this organization`,
        step.name,
        "fallbackAgentId",
      );
    }
    if (step.deploymentId && !ownedDeployments.has(step.deploymentId)) {
      return fail(
        `step "${step.name}": deployment ${step.deploymentId} not found in this organization`,
        step.name,
        "deploymentId",
      );
    }
    if (step.knowledgeBaseId && !ownedKnowledgeBases.has(step.knowledgeBaseId)) {
      return fail(
        `step "${step.name}": knowledge base ${step.knowledgeBaseId} not found in this organization`,
        step.name,
        "knowledgeBaseId",
      );
    }
  }

  const warnings: string[] = [];
  const order = planOrder(plan);
  order.forEach((planned, index) => {
    const step = def.steps.find((s) => s.name === planned.name)!;
    if (hasOwnPrompt(step)) return;
    if (def.executionMode === "pipeline" && index > 0) return;
    if (index === 0) return;
    warnings.push(
      `step "${step.name}" has no prompt template or mapped prompt, so it receives the run's own prompt, not an earlier step's output`,
    );
  });
  for (const step of def.steps) {
    if (step.fallbackAgentId && step.onError !== "fallback") {
      warnings.push(
        `step "${step.name}" has a fallback agent that is never used, because its onError is not "fallback"`,
      );
    }
  }
  const modelSteps = deps.capabilities?.modelSteps;
  if (modelSteps && !modelSteps.available && def.steps.some((s) => s.stepType === "model")) {
    warnings.push(
      `model steps cannot run right now${modelSteps.reason ? `: ${modelSteps.reason}` : ""}`,
    );
  }

  return {
    ok: true,
    plan: {
      levels: plan.levels.map((level) => level.map((s) => s.name)),
      order: order.map((s) => s.name),
      concurrency: plan.concurrency,
      warnings,
    },
  };
}
