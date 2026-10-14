import assert from "node:assert/strict";
import test from "node:test";

import "./unitEnv.js";

import {
  loadWorkflowAsItWouldBe,
  loadWorkflowForListing,
  loadWorkflowRunReadiness,
  readWorkflowCanRunNow,
  workflowSellableNow,
  type WorkflowListingDb,
  type WorkflowListingDeps,
} from "../services/buildWorkflowListingDeps.js";
import { checkSellable, type WorkflowForSale } from "../services/offerings.js";
import {
  PAID_WORKFLOW_DELIVER_GRACE_MS,
  PAID_WORKFLOW_MAX_ACTIVE_RUNS,
  PAID_WORKFLOW_MAX_RUN_MS,
  PAID_WORKFLOW_TRIGGER,
  WORKFLOW_LISTING_MESSAGES,
  WORKFLOW_LISTING_SLUG,
  workflowCanRunNow,
  workflowNotFound,
  workflowSellableProblem,
  type WorkflowForListing,
} from "../services/workflowListing.js";

// What makes a workflow sellable, and whether it can run now: the pure rules
// and the one read behind them, against an in-memory database. What these
// pin: each of the six problems and their order, that a workflow is never
// found under another organization than its own, that a read that throws
// counts as "no", and the numbers.

type Row = Record<string, any>;

const ORG = "org_creator";
const OTHER_ORG = "org_other";
const WORKFLOW_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DEPLOYMENT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const sellable = (over: Partial<WorkflowForListing> = {}): WorkflowForListing => ({
  id: WORKFLOW_ID,
  orgId: ORG,
  isEnabled: true,
  stepCount: 2,
  usesMarketplaceCopy: false,
  everyAgentExists: true,
  timeoutMs: PAID_WORKFLOW_MAX_RUN_MS,
  inputSchema: {},
  ...over,
});

// ============================================
// The pure rules
// ============================================

test("a workflow that is enabled, has steps, is all the creator's own and ends in time is sellable", () => {
  assert.equal(workflowSellableProblem(sellable(), ORG), null);
});

test("each of the six problems alone is told in its own sentence", () => {
  assert.equal(workflowSellableProblem(null, ORG), "Workflow not found.");
  assert.equal(
    workflowSellableProblem(sellable({ isEnabled: false }), ORG),
    "This workflow is disabled. Enable it before selling it.",
  );
  assert.equal(workflowSellableProblem(sellable({ stepCount: 0 }), ORG), "This workflow has no steps yet.");
  assert.equal(
    workflowSellableProblem(sellable({ usesMarketplaceCopy: true }), ORG),
    "This workflow uses an agent installed from the marketplace. A workflow can be sold only when every agent in it is one you built.",
  );
  assert.equal(
    workflowSellableProblem(sellable({ timeoutMs: PAID_WORKFLOW_MAX_RUN_MS + 1 }), ORG),
    "A workflow on sale must finish within 10 minutes. Set its time limit to 10 minutes or less.",
  );
  assert.equal(
    workflowSellableProblem(sellable({ everyAgentExists: false }), ORG),
    "This workflow has a step whose agent no longer exists. Choose another agent for that step.",
  );
});

test("when several problems hold, the first in the order of the rules is the one told", () => {
  const all = { isEnabled: false, stepCount: 0, usesMarketplaceCopy: true, timeoutMs: 3_600_000, everyAgentExists: false };
  const order: Array<[keyof typeof all, string]> = [
    ["isEnabled", WORKFLOW_LISTING_MESSAGES.disabled],
    ["stepCount", WORKFLOW_LISTING_MESSAGES.noSteps],
    ["usesMarketplaceCopy", WORKFLOW_LISTING_MESSAGES.marketplaceCopy],
    ["timeoutMs", WORKFLOW_LISTING_MESSAGES.tooLong],
    ["everyAgentExists", WORKFLOW_LISTING_MESSAGES.agentGone],
  ];
  // Each problem is put right in turn; what is told is the next one left.
  const wrong: Partial<WorkflowForListing> = { ...all };
  for (const [field, sentence] of order) {
    assert.equal(workflowSellableProblem(sellable(wrong), ORG), sentence);
    delete wrong[field];
  }
  assert.equal(workflowSellableProblem(sellable(wrong), ORG), null);
  // Not found comes before all of them.
  assert.equal(workflowSellableProblem(sellable(all), OTHER_ORG), "Workflow not found.");
});

test("a workflow of another organization is not found, whatever else is true of it", () => {
  assert.equal(workflowSellableProblem(sellable(), OTHER_ORG), "Workflow not found.");
  assert.equal(workflowNotFound(sellable(), OTHER_ORG), true);
  assert.equal(workflowNotFound(null, ORG), true);
  assert.equal(workflowNotFound(sellable({ isEnabled: false }), ORG), false);
});

test("a time limit of exactly 10 minutes passes and one millisecond more does not", () => {
  assert.equal(PAID_WORKFLOW_MAX_RUN_MS, 600_000);
  assert.equal(workflowSellableProblem(sellable({ timeoutMs: 600_000 }), ORG), null);
  assert.equal(workflowSellableProblem(sellable({ timeoutMs: 600_001 }), ORG), WORKFLOW_LISTING_MESSAGES.tooLong);
  // A time limit that is not a number is not one a paid run can be held to.
  assert.equal(
    workflowSellableProblem(sellable({ timeoutMs: Number.NaN }), ORG),
    WORKFLOW_LISTING_MESSAGES.tooLong,
  );
});

test("the first three sentences are the ones an offering says of a workflow, word for word", async () => {
  const forSale = (over: Partial<WorkflowForSale>): WorkflowForSale => ({
    id: WORKFLOW_ID,
    name: "Digest",
    isEnabled: true,
    stepCount: 1,
    usesMarketplaceCopy: false,
    inputSchema: null,
    ...over,
  });
  const said = async (over: Partial<WorkflowForSale>) => {
    const answer = await checkSellable(
      {
        findAgent: async () => null,
        findWorkflow: async () => forSale(over),
        findDeployment: async () => null,
      },
      ORG,
      { productKind: "workflow", agentId: null, orchestrationId: WORKFLOW_ID, deploymentId: null },
    );
    assert.equal(answer.ok, false);
    return answer.ok ? "" : answer.message;
  };
  assert.equal(await said({ isEnabled: false }), workflowSellableProblem(sellable({ isEnabled: false }), ORG));
  assert.equal(await said({ stepCount: 0 }), workflowSellableProblem(sellable({ stepCount: 0 }), ORG));
  assert.equal(
    await said({ usesMarketplaceCopy: true }),
    workflowSellableProblem(sellable({ usesMarketplaceCopy: true }), ORG),
  );
});

test("the slug of a workflow's listing: lower-case letters, digits and hyphens, never empty", () => {
  assert.equal(WORKFLOW_LISTING_SLUG.test("a".repeat(100)), true);
  assert.equal(WORKFLOW_LISTING_SLUG.test("weekly-digest-2"), true);
  assert.equal(WORKFLOW_LISTING_SLUG.test("7"), true);
  assert.equal(WORKFLOW_LISTING_SLUG.test(""), false);
  assert.equal(WORKFLOW_LISTING_SLUG.test("Weekly"), false);
  assert.equal(WORKFLOW_LISTING_SLUG.test("-weekly"), false);
  assert.equal(WORKFLOW_LISTING_SLUG.test("weekly/digest"), false);
  assert.equal(WORKFLOW_LISTING_SLUG.test("a".repeat(121)), false);
});

test("the numbers of a paid run", () => {
  assert.equal(PAID_WORKFLOW_DELIVER_GRACE_MS, 120_000);
  assert.equal(PAID_WORKFLOW_MAX_ACTIVE_RUNS, 3);
  assert.equal(PAID_WORKFLOW_TRIGGER, "paid");
  // The answer's grace must stay under the five minutes the sweeper leaves past the longest run.
  assert.ok(PAID_WORKFLOW_DELIVER_GRACE_MS < 5 * 60_000);
});

test("it can run now only when it is sellable and what its steps run on is serving", () => {
  const serving = { workflow: sellable(), modelStepsServe: true, agentModelsServe: true };
  assert.equal(workflowCanRunNow(serving, ORG), true);
  assert.equal(workflowCanRunNow({ ...serving, modelStepsServe: false }, ORG), false);
  assert.equal(workflowCanRunNow({ ...serving, agentModelsServe: false }, ORG), false);
  assert.equal(workflowCanRunNow({ ...serving, workflow: sellable({ isEnabled: false }) }, ORG), false);
  assert.equal(workflowCanRunNow({ ...serving, workflow: null }, ORG), false);
  assert.equal(workflowCanRunNow(serving, OTHER_ORG), false);
});

// ============================================
// The read
// ============================================

function makeDb(opts: {
  workflow?: Row | null;
  steps?: Row[];
  agents?: Row[];
  deployments?: Row[];
  /** The read of the workflow throws. */
  broken?: boolean;
} = {}) {
  const workflow =
    opts.workflow === null
      ? null
      : {
          id: WORKFLOW_ID,
          orgId: ORG,
          isEnabled: true,
          timeout: 600_000,
          inputSchema: { type: "object", properties: { topic: { type: "string" } } },
          ...(opts.workflow ?? {}),
        };
  const steps = opts.steps ?? [{ stepType: "agent", agentId: AGENT_A, fallbackAgentId: null, deploymentId: null }];
  const agents = opts.agents ?? [
    { id: AGENT_A, orgId: ORG, modelConfig: {} },
    { id: AGENT_B, orgId: ORG, modelConfig: {} },
  ];
  const deployments = opts.deployments ?? [];
  const calls = { workflowWheres: [] as Row[], agentWheres: [] as Row[], deploymentWheres: [] as Row[] };
  const db: WorkflowListingDb = {
    orchestration: {
      findFirst: async ({ where }) => {
        calls.workflowWheres.push(where);
        if (opts.broken) throw new Error("the database is away");
        return workflow && workflow.id === where.id && workflow.orgId === where.orgId
          ? { ...workflow, steps: steps.map((step) => ({ ...step })) as never }
          : null;
      },
    },
    agent: {
      findMany: async ({ where }) => {
        calls.agentWheres.push(where);
        return agents
          .filter((agent) => where.id.in.includes(agent.id) && agent.orgId === where.orgId)
          .map((agent) => ({ id: agent.id, modelConfig: agent.modelConfig }));
      },
    },
    deployment: {
      findMany: async ({ where }) => {
        calls.deploymentWheres.push(where);
        return deployments
          .filter((d) => where.id.in.includes(d.id) && d.orgId === where.orgId && d.status === where.status)
          .map((d) => ({ id: d.id }));
      },
    },
  };
  return { db, calls };
}

const quiet = { warn: () => {} };

function depsOf(
  db: WorkflowListingDb,
  over: Partial<WorkflowListingDeps> = {},
): WorkflowListingDeps & { copyAsked: string[][]; hostedAsked: Array<{ orgId: string; modelId: string }> } {
  const copyAsked: string[][] = [];
  const hostedAsked: Array<{ orgId: string; modelId: string }> = [];
  return {
    db,
    anyMarketplaceCopy: async (ids) => {
      copyAsked.push(ids);
      return false;
    },
    resolveHostedModel: async (args) => {
      hostedAsked.push(args);
      return { ok: true };
    },
    logger: quiet,
    ...over,
    copyAsked,
    hostedAsked,
  };
}

const REF = { workflowId: WORKFLOW_ID, orgId: ORG };

test("the read answers what the sellable question needs, by id and organization", async () => {
  const { db, calls } = makeDb({
    steps: [
      { stepType: "agent", agentId: AGENT_A, fallbackAgentId: AGENT_B, deploymentId: null },
      { stepType: "agent", agentId: AGENT_A, fallbackAgentId: null, deploymentId: null },
    ],
  });
  const deps = depsOf(db);
  const workflow = await loadWorkflowForListing(REF, deps);
  assert.deepEqual(workflow, {
    id: WORKFLOW_ID,
    orgId: ORG,
    isEnabled: true,
    stepCount: 2,
    usesMarketplaceCopy: false,
    everyAgentExists: true,
    timeoutMs: 600_000,
    inputSchema: { type: "object", properties: { topic: { type: "string" } } },
  });
  assert.deepEqual(calls.workflowWheres, [{ id: WORKFLOW_ID, orgId: ORG }]);
  // Steps and fallbacks alike are asked about, each agent once.
  assert.deepEqual(deps.copyAsked, [[AGENT_A, AGENT_B]]);
  assert.deepEqual(calls.agentWheres, [{ id: { in: [AGENT_A, AGENT_B] }, orgId: ORG }]);
  assert.equal(workflowSellableProblem(workflow, ORG), null);
});

test("a workflow asked for under another organization than its own is not found", async () => {
  const { db, calls } = makeDb();
  const deps = depsOf(db);
  assert.equal(await loadWorkflowForListing({ workflowId: WORKFLOW_ID, orgId: OTHER_ORG }, deps), null);
  assert.deepEqual(calls.workflowWheres, [{ id: WORKFLOW_ID, orgId: OTHER_ORG }]);
  assert.equal(await workflowSellableNow({ workflowId: WORKFLOW_ID, orgId: OTHER_ORG }, deps), false);
  assert.equal(await readWorkflowCanRunNow({ workflowId: WORKFLOW_ID, orgId: OTHER_ORG }, deps), false);
  // In its own it is found.
  assert.equal(await workflowSellableNow(REF, deps), true);
});

test("the read finds each problem: disabled, no steps, a marketplace copy in a fallback, too long", async () => {
  const problem = async (opts: Parameters<typeof makeDb>[0], over: Partial<WorkflowListingDeps> = {}) => {
    const { db } = makeDb(opts);
    return workflowSellableProblem(await loadWorkflowForListing(REF, depsOf(db, over)), ORG);
  };
  assert.equal(await problem({ workflow: { isEnabled: false } }), WORKFLOW_LISTING_MESSAGES.disabled);
  assert.equal(await problem({ steps: [] }), WORKFLOW_LISTING_MESSAGES.noSteps);
  assert.equal(
    await problem(
      { steps: [{ stepType: "agent", agentId: AGENT_A, fallbackAgentId: AGENT_B, deploymentId: null }] },
      { anyMarketplaceCopy: async (ids) => ids.includes(AGENT_B) },
    ),
    WORKFLOW_LISTING_MESSAGES.marketplaceCopy,
  );
  assert.equal(await problem({ workflow: { timeout: 600_001 } }), WORKFLOW_LISTING_MESSAGES.tooLong);
  assert.equal(await problem({}), null);
});

test("a step whose agent is no longer in the organization is the sixth problem, for a step and for a fallback", async () => {
  const gone = makeDb({ agents: [] });
  assert.equal(
    workflowSellableProblem(await loadWorkflowForListing(REF, depsOf(gone.db)), ORG),
    "This workflow has a step whose agent no longer exists. Choose another agent for that step.",
  );
  // An agent of the same id in another organization is not this workflow's agent.
  const elsewhere = makeDb({ agents: [{ id: AGENT_A, orgId: OTHER_ORG, modelConfig: {} }] });
  assert.equal(
    workflowSellableProblem(await loadWorkflowForListing(REF, depsOf(elsewhere.db)), ORG),
    WORKFLOW_LISTING_MESSAGES.agentGone,
  );
  const fallbackGone = makeDb({
    steps: [{ stepType: "agent", agentId: AGENT_A, fallbackAgentId: AGENT_B, deploymentId: null }],
    agents: [{ id: AGENT_A, orgId: ORG, modelConfig: {} }],
  });
  assert.equal(
    workflowSellableProblem(await loadWorkflowForListing(REF, depsOf(fallbackGone.db)), ORG),
    WORKFLOW_LISTING_MESSAGES.agentGone,
  );
});

test("a read that throws counts as not sellable and as cannot run", async () => {
  const { db } = makeDb({ broken: true });
  const warned: string[] = [];
  const deps = depsOf(db, { logger: { warn: (_fields, message) => warned.push(message) } });
  assert.equal(await workflowSellableNow(REF, deps), false);
  assert.equal(await readWorkflowCanRunNow(REF, deps), false);
  assert.equal(warned.length, 2);
  // The plain read does not hide the failure from a caller that wants it.
  await assert.rejects(() => loadWorkflowForListing(REF, deps), /the database is away/);
});

test("the workflow as it would be: a change is judged before it is saved, on what is sent and not on what is stored", async () => {
  const { db } = makeDb({
    steps: [{ stepType: "agent", agentId: AGENT_A, fallbackAgentId: null, deploymentId: null }],
    agents: [{ id: AGENT_A, orgId: ORG, modelConfig: {} }],
  });
  const would = async (change: Parameters<typeof loadWorkflowAsItWouldBe>[1], over: Partial<WorkflowListingDeps> = {}) =>
    workflowSellableProblem(await loadWorkflowAsItWouldBe(REF, change, depsOf(db, over)), ORG);

  assert.equal(await would({}), null);
  assert.equal(await would({ isEnabled: false }), WORKFLOW_LISTING_MESSAGES.disabled);
  const steps = [{ agentId: AGENT_A }];
  assert.equal(await would({ definition: { timeoutMs: 600_000, steps } }), null);
  assert.equal(await would({ definition: { timeoutMs: 600_000, steps: [] } }), WORKFLOW_LISTING_MESSAGES.noSteps);
  assert.equal(await would({ definition: { timeoutMs: 600_001, steps } }), WORKFLOW_LISTING_MESSAGES.tooLong);
  // The agents of the steps that were sent are the ones asked about.
  assert.equal(
    await would({ definition: { timeoutMs: 600_000, steps: [{ agentId: AGENT_A, fallbackAgentId: AGENT_B }] } }),
    WORKFLOW_LISTING_MESSAGES.agentGone,
  );
  assert.equal(
    await would(
      { definition: { timeoutMs: 600_000, steps: [{ agentId: AGENT_A }] } },
      { anyMarketplaceCopy: async (ids) => ids.includes(AGENT_A) },
    ),
    WORKFLOW_LISTING_MESSAGES.marketplaceCopy,
  );
  // A step with no agent (a model or a retrieval step) names none.
  assert.equal(await would({ definition: { timeoutMs: 10_000, steps: [{}] } }), null);
  // Never under another organization.
  assert.equal(await loadWorkflowAsItWouldBe({ workflowId: WORKFLOW_ID, orgId: OTHER_ORG }, {}, depsOf(db)), null);
});

const MODEL_STEP = { stepType: "model", agentId: null, fallbackAgentId: null, deploymentId: DEPLOYMENT };
const HOSTED_AGENT = { id: AGENT_A, orgId: ORG, modelConfig: { model: "wheelsai/llama-3" } };

test("it can run when every model step's deployment is running and every hosted step agent resolves", async () => {
  const { db, calls } = makeDb({
    steps: [MODEL_STEP, { stepType: "agent", agentId: AGENT_A, fallbackAgentId: null, deploymentId: null }],
    agents: [HOSTED_AGENT],
    deployments: [{ id: DEPLOYMENT, orgId: ORG, status: "running" }],
  });
  const deps = depsOf(db);
  assert.equal(await readWorkflowCanRunNow(REF, deps), true);
  assert.deepEqual(calls.deploymentWheres, [{ id: { in: [DEPLOYMENT] }, orgId: ORG, status: "running" }]);
  assert.deepEqual(deps.hostedAsked, [{ orgId: ORG, modelId: "wheelsai/llama-3" }]);
});

test("it cannot run while a model step's deployment is stopped, or is another organization's", async () => {
  for (const deployment of [
    { id: DEPLOYMENT, orgId: ORG, status: "stopped" },
    { id: DEPLOYMENT, orgId: OTHER_ORG, status: "running" },
  ]) {
    const { db } = makeDb({ steps: [MODEL_STEP], deployments: [deployment] });
    const found = await loadWorkflowRunReadiness(REF, depsOf(db));
    assert.equal(found.modelStepsServe, false);
    // The workflow itself is still sellable: only the wider question says no.
    assert.equal(workflowSellableProblem(found.workflow, ORG), null);
    assert.equal(await readWorkflowCanRunNow(REF, depsOf(db)), false);
  }
});

test("it cannot run while a step agent's hosted model does not resolve", async () => {
  const { db } = makeDb({ agents: [HOSTED_AGENT] });
  const deps = depsOf(db, { resolveHostedModel: async () => ({ ok: false }) });
  assert.equal(await readWorkflowCanRunNow(REF, deps), false);
  assert.equal(await workflowSellableNow(REF, deps), true);
});

test("a hosted model that cannot be asked about counts as cannot run", async () => {
  const { db } = makeDb({ agents: [HOSTED_AGENT] });
  const deps = depsOf(db, {
    resolveHostedModel: async () => {
      throw new Error("deployments unreadable");
    },
  });
  assert.equal(await readWorkflowCanRunNow(REF, deps), false);
});

test("an agent on a model that is not its organization's own is never asked about, and neither is a fallback", async () => {
  const { db } = makeDb({
    steps: [{ stepType: "agent", agentId: AGENT_A, fallbackAgentId: AGENT_B, deploymentId: null }],
    agents: [
      { id: AGENT_A, orgId: ORG, modelConfig: { model: "gpt-4o-mini" } },
      { id: AGENT_B, orgId: ORG, modelConfig: { model: "wheelsai/llama-3" } },
    ],
  });
  const deps = depsOf(db, { resolveHostedModel: async () => ({ ok: false }) });
  assert.equal(await readWorkflowCanRunNow(REF, deps), true);
  assert.deepEqual(deps.hostedAsked, []);
});
