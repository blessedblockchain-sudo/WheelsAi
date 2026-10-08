import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// W2 RAG: binding an agent to a knowledge base is a TENANCY decision.
// The retrieval path trusts `agent.knowledgeBaseId` completely — it
// retrieves whatever that base contains and feeds it to the model — so a
// caller able to bind an arbitrary UUID could read another org's
// documents back out through chat grounding.
//
// These pin the guard by source inspection: the check must exist on BOTH
// write paths (create and patch), because a guard on only one is the same
// leak. PATCH checks in the route. A create (POST /api/agents and "use this
// template" alike) checks in the one create path, services/createAgent.ts,
// bound to the database in services/buildCreateAgentDeps.ts;
// createAgent.unit.test.ts drives that refusal end to end.

const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

const routeSource = source("../routes/agents.ts");
const createSource = source("../services/createAgent.ts");
const createDepsSource = source("../services/buildCreateAgentDeps.ts");
const createInputSource = source("../services/agentCreateInput.ts");

test("the ownership check scopes the knowledge base lookup by orgId", () => {
  const helper = routeSource.slice(
    routeSource.indexOf("async function assertKnowledgeBaseOwned"),
  );
  assert.ok(
    helper.length > 0,
    "assertKnowledgeBaseOwned must exist — the binding is otherwise unvalidated",
  );
  const body = helper.slice(0, helper.indexOf("\n}"));
  assert.match(body, /knowledgeBase\.findFirst/);
  assert.match(body, /id: knowledgeBaseId, orgId/);
});

test("BOTH write paths guard the binding — create and patch", () => {
  // Create: the one create path checks ownership before the plan is read
  // and before the transaction that inserts the agent.
  const createGuardIdx = createSource.indexOf("!(await deps.knowledgeBaseOwned(data.knowledgeBaseId, orgId))");
  const insertIdx = createSource.indexOf("deps.insertAgent(");
  const transactionIdx = createSource.indexOf("deps.transaction(");
  assert.ok(createGuardIdx > 0, "create must check who owns the knowledge base");
  assert.ok(
    createGuardIdx < transactionIdx && transactionIdx < insertIdx,
    "create must check ownership before inserting the agent",
  );
  assert.equal(
    createSource.match(/deps\.insertAgent\(/g)?.length,
    1,
    "one insert, so one guard covers every create",
  );

  // The check behind it is scoped by the caller's organization.
  const bound = createDepsSource.slice(createDepsSource.indexOf("knowledgeBaseOwned:"));
  const boundBody = bound.slice(0, bound.indexOf("!== null"));
  assert.match(boundBody, /knowledgeBase\.findFirst/);
  assert.match(boundBody, /id: knowledgeBaseId, orgId/);

  // The route creates through that path and through nothing else.
  assert.match(routeSource, /createAgent\(buildCreateAgentDeps\(\), args\)/);
  assert.doesNotMatch(routeSource, /prisma\.agent\.create\(/, "no insert in the route that could skip the guard");

  // Patch: its own check, before the update.
  const patchIdx = routeSource.indexOf("const updatedAgent = await prisma.agent.update(");
  const patchGuardIdx = routeSource.lastIndexOf("!(await assertKnowledgeBaseOwned(", patchIdx);
  assert.ok(patchIdx > 0);
  assert.ok(patchGuardIdx > 0 && patchGuardIdx < patchIdx, "patch must have its own ownership check before updating");
  assert.equal(
    routeSource.match(/prisma\.agent\.update\(/g)?.length,
    1,
    "one update of an agent in the route, so one guard covers it",
  );
});

test("every rejected binding answers 400 rather than silently ignoring the field", () => {
  // Patch: the route's call site answers at once.
  const patchGuardIdx = routeSource.indexOf("!(await assertKnowledgeBaseOwned(");
  assert.ok(patchGuardIdx > 0 && patchGuardIdx !== routeSource.indexOf("async function assertKnowledgeBaseOwned"));
  assert.match(
    routeSource.slice(patchGuardIdx, patchGuardIdx + 300),
    /badRequest\("Knowledge base not found"\)/,
    "the caller is told the binding failed; silently dropping it would look like success",
  );

  // Create: the refusal is returned, not skipped, and is answered with the
  // same 400 body reply.badRequest() gave it.
  const createGuardIdx = createSource.indexOf("!(await deps.knowledgeBaseOwned(");
  assert.match(
    createSource.slice(createGuardIdx, createGuardIdx + 200),
    /return \{ ok: false, reason: "knowledge_base_not_found" \}/,
  );
  const answer = createSource.slice(createSource.indexOf('case "knowledge_base_not_found":'));
  assert.match(
    answer.slice(0, 300),
    /status: 400, body: \{ statusCode: 400, error: "Bad Request", message: "Knowledge base not found" \}/,
  );
});

test("the binding accepts null so an agent can be UNBOUND", () => {
  // The fields a create and a PATCH both accept (PATCH takes any part of them).
  assert.match(
    createInputSource,
    /knowledgeBaseId: z\.string\(\)\.uuid\(\)\.nullable\(\)\.optional\(\)/,
    "nullable is required — otherwise grounding can be turned on but never off",
  );
  assert.match(routeSource, /const updateAgentSchema = agentFieldsSchema\.partial\(\)/);
});
