/**
 * What this server can do right now, for the web to draw only what works.
 *
 *   GET /api/capabilities   (mounted with prefix "/api/capabilities")
 *
 * Signed-in session or API key. The answer is five facts:
 *
 *   chat           the models an agent can answer on now, in the order the
 *                  platform tries them, and the one an agent with no model
 *                  of its own gets (the first)
 *   payouts        earnings can be paid out
 *   emailDelivery  results can be sent by email
 *   agentGpu       an agent can be put on a dedicated GPU
 *   paidTasks      a paid task can be run
 *
 * It says WHAT is available and never why: no key names, setting names,
 * addresses or reasons. The body is built field by field from the answers
 * below, so nothing a dependency happens to carry can ride along.
 *
 * Fails closed: a fact that cannot be read is answered as not available.
 *
 * Pure core (readCapabilities) with injected reads; production wiring is in
 * capabilitiesBindings.ts.
 */

import type { FastifyPluginAsync, preHandlerAsyncHookHandler } from "fastify";

// ============================================
// Types
// ============================================

/** A model an agent can answer on now. */
export interface CapabilityChatModel {
  id: string;
  label: string;
}

export interface Availability {
  available: boolean;
}

export interface Capabilities {
  chat: {
    models: CapabilityChatModel[];
    /** The model an agent with none of its own answers on; null when there is none. */
    defaultModel: string | null;
  };
  payouts: Availability;
  emailDelivery: Availability;
  agentGpu: Availability;
  paidTasks: Availability;
}

/** The reads behind the answer. Each is asked on every request. */
export interface CapabilitiesReads {
  /** Models whose provider the platform can reach now, in the order they are tried. */
  chatModels(): ReadonlyArray<{ id: string; label: string }>;
  payouts(): boolean;
  emailDelivery(): boolean;
  agentGpu(): boolean;
  paidTasks(): boolean;
}

export interface CapabilitiesRouteDeps extends CapabilitiesReads {
  guards: { auth: preHandlerAsyncHookHandler };
}

// ============================================
// Core
// ============================================

function available(read: () => boolean): Availability {
  try {
    return { available: read() === true };
  } catch {
    return { available: false };
  }
}

function chatModels(read: CapabilitiesReads["chatModels"]): CapabilityChatModel[] {
  let listed: ReadonlyArray<{ id: string; label: string }>;
  try {
    listed = read();
  } catch {
    return [];
  }
  const models: CapabilityChatModel[] = [];
  const seen = new Set<string>();
  for (const model of Array.isArray(listed) ? listed : []) {
    if (typeof model?.id !== "string" || model.id === "" || seen.has(model.id)) continue;
    seen.add(model.id);
    // Only the id and the label: whatever else the catalog holds stays there.
    models.push({
      id: model.id,
      label: typeof model.label === "string" && model.label !== "" ? model.label : model.id,
    });
  }
  return models;
}

export function readCapabilities(reads: CapabilitiesReads): Capabilities {
  const models = chatModels(reads.chatModels);
  return {
    chat: {
      models,
      // The rule agent chat follows for an agent with no model of its own
      // (services/agentModelResolution.ts): the first one available.
      defaultModel: models[0]?.id ?? null,
    },
    payouts: available(reads.payouts),
    emailDelivery: available(reads.emailDelivery),
    agentGpu: available(reads.agentGpu),
    paidTasks: available(reads.paidTasks),
  };
}

// ============================================
// Routes
// ============================================

export function createCapabilitiesRoutes(deps: CapabilitiesRouteDeps): FastifyPluginAsync {
  return async (app) => {
    app.get("/", { preHandler: [deps.guards.auth] }, async (_request, reply) => {
      // It changes when an operator changes the configuration, and it is the
      // same for everyone, but it is still an answer to a signed-in caller.
      reply.header("Cache-Control", "private, no-store");
      return readCapabilities(deps);
    });
  };
}
