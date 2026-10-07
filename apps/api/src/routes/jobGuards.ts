/**
 * The guards the offering and job routes run, as one injectable set.
 *
 *   auth          who are you (and count the call for an API key)
 *   scope(s)      an API key must hold the scope; a session is not scoped
 *   spend(s)      anything that moves money: a signed-in member must be an
 *                 owner or admin, an API key must have been granted the
 *                 scope by name (never through "*" or an empty list)
 *
 * Production binds them to middleware/auth.ts; a route test passes the same
 * functions over a fake membership lookup.
 */

import type { preHandlerAsyncHookHandler } from "fastify";

import { createRequireSpend, requireAuth, requireScope, requireSpend, type MemberRoleLookup } from "../middleware/auth.js";

export interface JobRouteGuards {
  auth: preHandlerAsyncHookHandler;
  scope(scope: string): preHandlerAsyncHookHandler;
  spend(scope: string): preHandlerAsyncHookHandler;
}

export function buildJobRouteGuards(overrides: { getMemberRole?: MemberRoleLookup } = {}): JobRouteGuards {
  const spend = overrides.getMemberRole
    ? createRequireSpend({ getMemberRole: overrides.getMemberRole })
    : requireSpend;
  return {
    auth: requireAuth as preHandlerAsyncHookHandler,
    scope: (scope) => requireScope(scope) as preHandlerAsyncHookHandler,
    spend: (scope) => spend(scope) as preHandlerAsyncHookHandler,
  };
}
