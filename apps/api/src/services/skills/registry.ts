/**
 * Skills registry.
 *
 * One typed, versioned catalogue of everything an agent's model (or a graph
 * node) can invoke. It replaces three disagreeing lists - the wizard's
 * checkboxes, agent-runtime's tool schemas and runChat's two hard-coded
 * executors - with a single source of truth: a skill listed here is
 * selectable, advertised to the model, and (when its provider is configured)
 * actually executes.
 *
 * Two guarantees live here rather than in each skill, so a new skill cannot
 * forget them:
 *
 *   1. MONEY-MOVING skills never run in `trial`, `test`, `hired` or `public`
 *      mode, and skills that WRITE the agent's saved data never run in
 *      `test`, `hired` or `public` mode. Skills that SEND data to an address
 *      the model chooses never run in `hired` mode unless the offering's
 *      publisher allowed them by name, and never in `public` mode. Skills
 *      that READ the agent's saved data never run in `public` mode. All four
 *      are filtered out of the tool list the model sees AND refused at
 *      execute time, so a model that hallucinates the call still cannot
 *      spend, overwrite, read back or post the publisher's instructions
 *      somewhere.
 *   2. An unavailable skill (provider not configured, misconfigured, missing
 *      agent prerequisite) answers with an explicit `unavailable` result. It is
 *      never run "anyway" and never fabricates output.
 */

import { createLogger } from "../../utils/logger.js";
import type { BuiltinSkillDeps } from "./builtinDeps.js";
import { createCalculatorSkill } from "./calculatorSkill.js";
import { createCodeInterpreterSkill } from "./codeInterpreterSkill.js";
import { createFileReadSkill, createFileWriteSkill } from "./fileSkills.js";
import { createHttpRequestSkill } from "./httpRequestSkill.js";
import { createKnowledgeSearchSkill } from "./knowledgeSearchSkill.js";
import { createWebSearchSkill } from "./webSearchSkill.js";
import type {
  AgentAvailabilityContext,
  SkillAvailability,
  SkillDefinition,
  SkillDescriptor,
  SkillResult,
  ToolContext,
  ToolMode,
  ToolSpec,
} from "./types.js";

const logger = createLogger("skills-registry");

/** Modes in which value-moving skills are refused outright. */
const MONEY_BLOCKED_MODES: ReadonlySet<ToolMode> = new Set<ToolMode>([
  "trial",
  "test",
  "hired",
  "public",
]);

/** Modes in which skills that change the agent's saved data are refused. */
const WRITE_BLOCKED_MODES: ReadonlySet<ToolMode> = new Set<ToolMode>(["test", "hired", "public"]);

/** Why a state-writing skill is refused, per mode that refuses it. */
const WRITE_BLOCK_REASON: Partial<Record<ToolMode, string>> = {
  test: "tests must not modify the agent's files",
  hired: "a buyer's job must not modify the publisher's files",
  public: "a visitor's chat must not modify the agent's files",
};

export class SkillRegistry {
  private readonly skills = new Map<string, SkillDefinition>();

  constructor(skills: SkillDefinition[] = []) {
    for (const skill of skills) this.register(skill);
  }

  register(skill: SkillDefinition): void {
    if (this.skills.has(skill.key)) {
      throw new Error(`skill "${skill.key}" is already registered`);
    }
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(skill.key)) {
      // Keys double as the model-facing function name.
      throw new Error(`skill key "${skill.key}" is not a valid function name`);
    }
    this.skills.set(skill.key, skill);
  }

  has(key: string): boolean {
    return this.skills.has(key);
  }

  get(key: string): SkillDefinition | undefined {
    return this.skills.get(key);
  }

  list(): SkillDefinition[] {
    return [...this.skills.values()];
  }

  /** Why a skill may not run in this context, or null when it may. */
  modeBlock(skill: SkillDefinition, ctx: Pick<ToolContext, "mode" | "outboundAllowed">): string | null {
    const { mode } = ctx;
    // An anonymous visitor: no allowlist applies, whatever the context carries.
    if (mode === "public") {
      if (skill.sendsOutbound) {
        return `"${skill.key}" sends data to an address the model chooses and is disabled for public visitors`;
      }
      if (skill.readsPrivateState) {
        return `"${skill.key}" reads the agent's saved data and is disabled for public visitors: it would show one visitor what the agent's owner, or another visitor, saved`;
      }
    }
    // Fails closed: no list, or a list without this skill, is "not allowed".
    if (skill.sendsOutbound && mode === "hired" && !ctx.outboundAllowed?.includes(skill.key)) {
      return `"${skill.key}" sends data to an address the model chooses and is disabled in a paid job: a buyer's input must not be able to send the publisher's instructions elsewhere. The offering's publisher can allow it by naming it in the offering's allowed tools`;
    }
    if (skill.moneyMoving && MONEY_BLOCKED_MODES.has(mode)) {
      return `"${skill.key}" moves money and is disabled in ${mode} mode`;
    }
    if (skill.writesState && WRITE_BLOCKED_MODES.has(mode)) {
      return `"${skill.key}" changes the agent's saved data and is disabled in ${mode} mode: ${WRITE_BLOCK_REASON[mode] ?? "this run must not modify the agent's files"}`;
    }
    return null;
  }

  availability(key: string, agent?: AgentAvailabilityContext): SkillAvailability {
    const skill = this.skills.get(key);
    if (!skill) return { available: false, reason: `unknown skill "${key}"` };
    return skill.availability ? skill.availability(agent) : { available: true };
  }

  /** Catalogue view for the wizard, the playground sidebar and GET /skills. */
  describe(agent?: AgentAvailabilityContext): SkillDescriptor[] {
    return this.list().map((skill) => {
      const availability = skill.availability
        ? skill.availability(agent)
        : ({ available: true } as const);
      return {
        key: skill.key,
        version: skill.version,
        name: skill.name,
        description: skill.description,
        inputSchema: skill.inputSchema,
        moneyMoving: skill.moneyMoving,
        requires: skill.requires ?? [],
        available: availability.available,
        unavailableReason: availability.available ? null : availability.reason,
      };
    });
  }

  /**
   * Model-facing tool specs for the skills named in `keys`. Unknown keys
   * (legacy or unsupported names stored on the agent) are dropped, and
   * skills the context forbids (modeBlock) are withheld.
   *
   * Skills that are currently UNAVAILABLE are still offered: the agent was
   * configured with them, and the honest behaviour is for the model to try
   * and be told "unavailable: <reason>" so it can say so to the user.
   */
  toolSpecs(keys: string[], ctx: Pick<ToolContext, "mode" | "outboundAllowed">): ToolSpec[] {
    const specs: ToolSpec[] = [];
    const seen = new Set<string>();
    for (const key of keys) {
      if (seen.has(key)) continue;
      seen.add(key);
      const skill = this.skills.get(key);
      if (!skill) continue;
      if (this.modeBlock(skill, ctx)) continue;
      specs.push({
        type: "function",
        function: {
          name: skill.key,
          description: skill.description,
          parameters: skill.inputSchema,
        },
      });
    }
    return specs;
  }

  /**
   * Executes a skill. Never throws for skill-level failures - they come back
   * as `error` / `unavailable` results the model can read. The one exception
   * is cancellation: if `ctx.signal` aborted, the abort propagates.
   */
  async execute(key: string, input: unknown, ctx: ToolContext): Promise<SkillResult> {
    const skill = this.skills.get(key);
    if (!skill) return { status: "error", message: `unknown tool "${key}"` };

    const blocked = this.modeBlock(skill, ctx);
    if (blocked) return { status: "unavailable", reason: blocked };

    const availability = skill.availability ? skill.availability() : { available: true as const };
    if (!availability.available) {
      return { status: "unavailable", reason: availability.reason };
    }

    if (ctx.signal?.aborted) {
      throw new DOMException("The operation was aborted", "AbortError");
    }

    try {
      return await skill.execute(input, ctx);
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
      // A skill that THROWS has hit something it did not anticipate (a
      // storage or database error, say). The detail can name infrastructure,
      // and it is about to reach the model and the UI, so it is logged in
      // full and reported generically. Skills that expect a failure return an
      // `error` result with a message written for users.
      logger.warn({ err, skill: key }, "skill threw");
      return { status: "error", message: "the tool failed unexpectedly" };
    }
  }
}

/** The built-in catalogue, wired to the given dependencies. */
export function createBuiltinSkills(deps: BuiltinSkillDeps): SkillDefinition[] {
  return [
    createCalculatorSkill(),
    createHttpRequestSkill(deps),
    createWebSearchSkill(deps),
    createKnowledgeSearchSkill(deps),
    createFileReadSkill(deps),
    createFileWriteSkill(deps),
    createCodeInterpreterSkill(deps),
  ];
}

export function createSkillRegistry(deps: BuiltinSkillDeps): SkillRegistry {
  return new SkillRegistry(createBuiltinSkills(deps));
}
