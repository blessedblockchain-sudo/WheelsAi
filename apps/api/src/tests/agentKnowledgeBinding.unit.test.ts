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
// These pin the guard at the route layer by source inspection: the check
// must exist on BOTH write paths (create and patch), because a guard on
// only one is the same leak.

const routeSource = readFileSync(
  fileURLToPath(new URL("../routes/agents.ts", import.meta.url)),
  "utf8",
);

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
  const guards = routeSource.match(/assertKnowledgeBaseOwned\(/g) ?? [];
  // One definition + two call sites.
  assert.ok(
    guards.length >= 3,
    `expected the guard called on both create and patch, found ${guards.length - 1} call site(s)`,
  );

  const createIdx = routeSource.indexOf("const agent = await prisma.agent.create(");
  const createGuardIdx = routeSource.lastIndexOf(
    "assertKnowledgeBaseOwned(",
    createIdx,
  );
  assert.ok(
    createGuardIdx > 0 && createIdx - createGuardIdx < 400,
    "create must check ownership immediately before inserting the agent",
  );

  const patchIdx = routeSource.indexOf("const updatedAgent = await prisma.agent.update(");
  const patchGuardIdx = routeSource.lastIndexOf(
    "assertKnowledgeBaseOwned(",
    patchIdx,
  );
  assert.ok(
    patchGuardIdx > 0 && patchGuardIdx > createGuardIdx,
    "patch must have its own ownership check before updating",
  );
});

test("every rejected binding answers 400 rather than silently ignoring the field", () => {
  // Call sites only — skip the declaration itself.
  const declIdx = routeSource.indexOf("async function assertKnowledgeBaseOwned");
  const callSites: number[] = [];
  let from = 0;
  for (;;) {
    const idx = routeSource.indexOf("!(await assertKnowledgeBaseOwned(", from);
    if (idx === -1) break;
    callSites.push(idx);
    from = idx + 1;
  }
  assert.ok(callSites.length >= 2, "expected a guard on create and on patch");
  assert.ok(
    callSites.every((i) => i !== declIdx),
    "call sites must be distinct from the declaration",
  );
  for (const idx of callSites) {
    const window = routeSource.slice(idx, idx + 300);
    assert.match(
      window,
      /badRequest\("Knowledge base not found"\)/,
      "the caller is told the binding failed; silently dropping it would look like success",
    );
  }
});

test("the binding accepts null so an agent can be UNBOUND", () => {
  assert.match(
    routeSource,
    /knowledgeBaseId: z\.string\(\)\.uuid\(\)\.nullable\(\)\.optional\(\)/,
    "nullable is required — otherwise grounding can be turned on but never off",
  );
});
