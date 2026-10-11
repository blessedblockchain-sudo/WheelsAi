import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import { listDeploymentDependents, type DeploymentDependentsDb } from "../services/deploymentDependents.js";
import { listHostedModelChoices } from "../services/hostedModelChoices.js";

// Which agents stop answering when a model deployment is stopped, against an
// in-memory database. What these pin: an agent is listed by the model the
// chat itself would pick for it; nothing is listed while another deployment
// would still answer, or for a deployment nothing answers from; the listing
// and its subscribers are those for USE; and another organization's agents,
// deployments and listings never appear.

const ORG = "org_1";
const OTHER_ORG = "org_2";
const LLAMA = "wheelsai/llama-3.1-8b";

type Row = Record<string, any>;

const deployment = (over: Row = {}): Row => ({
  id: "dep_1",
  orgId: ORG,
  slug: "my-llama",
  name: "My Llama",
  status: "running",
  modelId: "llama-3.1-8b",
  nosanaJobIds: ["dm_1"],
  fineTunedModelId: null,
  fineTunedModel: null,
  createdAt: new Date("2026-10-01T00:00:00Z"),
  model: { displayName: "Llama 3.1 8B" },
  ...over,
});

const agent = (id: string, name: string, modelConfig: unknown, orgId = ORG): Row => ({ id, orgId, name, modelConfig });

const listing = (id: string, agentId: string, over: Row = {}): Row => ({
  id,
  agentId,
  title: `Listing ${id}`,
  status: "published",
  sells: "use",
  pricingModel: "monthly",
  ...over,
});

function makeDb(seed: { deployments?: Row[]; agents?: Row[]; listings?: Row[]; subs?: Row[]; installs?: Row[] }) {
  const reads: string[] = [];
  // The database's own match: the stored text contains the id. Anything
  // else in the filter matches nothing, as an unknown filter should.
  const pathEquals = (row: Row, cond: Row) => {
    const { path, string_contains: contains } = cond.modelConfig;
    const stored = row.modelConfig?.[path[0]];
    return typeof contains === "string" && typeof stored === "string" && stored.includes(contains);
  };
  const db: DeploymentDependentsDb = {
    deployment: {
      findFirst: async ({ where }) => {
        reads.push("deployment.findFirst");
        return ((seed.deployments ?? []).find((d) => d.id === where.id && d.orgId === where.orgId) as never) ?? null;
      },
      findMany: async ({ where }) => {
        reads.push("deployment.findMany");
        return (seed.deployments ?? []).filter(
          (d) => d.orgId === where.orgId && d.id !== where.id.not && d.status === where.status,
        ) as never;
      },
    },
    agent: {
      findMany: async ({ where }) => {
        reads.push("agent.findMany");
        return (seed.agents ?? [])
          .filter((a) => a.orgId === where.orgId && (where.OR as Row[]).some((cond) => pathEquals(a, cond)))
          .sort((a, b) => a.name.localeCompare(b.name)) as never;
      },
    },
    agentListing: {
      findMany: async ({ where }) => {
        reads.push("agentListing.findMany");
        return (seed.listings ?? []).filter(
          (l) => where.agentId.in.includes(l.agentId) && l.status === where.status && l.sells === where.sells,
        ) as never;
      },
    },
    agentSubscription: {
      findMany: async ({ where }) =>
        (seed.subs ?? []).filter(
          (s) => where.listingId.in.includes(s.listingId) && where.status.in.includes(s.status),
        ) as never,
    },
    agentInstall: {
      findMany: async ({ where }) =>
        (seed.installs ?? []).filter((i) => where.listingId.in.includes(i.listingId) && i.kind === where.kind) as never,
    },
  };
  return { db, reads };
}

const dependentsOf = (seed: Parameters<typeof makeDb>[0], deploymentId = "dep_1", orgId = ORG) =>
  listDeploymentDependents({ orgId, deploymentId }, { db: makeDb(seed).db });

test("the agents set to the deployment's model are listed by name, with the listing that sells use and who pays monthly", async () => {
  const result = await dependentsOf({
    deployments: [deployment()],
    agents: [
      agent("a_2", "Zed", { externalModel: LLAMA }),
      agent("a_1", "Analyst", { externalModel: LLAMA }),
      // The legacy field, used when no externalModel is set.
      agent("a_3", "Legacy", { model: LLAMA }),
      agent("a_4", "On a free model", { externalModel: "free/groq/llama-3.3-70b" }),
      agent("a_5", "On another hosted model", { externalModel: "wheelsai/qwen-2.5-7b" }),
    ],
    listings: [listing("l_1", "a_1"), listing("l_4", "a_4")],
    subs: [
      { listingId: "l_1", subscriberId: "buyer_1", status: "active" },
      { listingId: "l_1", subscriberId: "buyer_2", status: "past_due" },
      // Ended: not a subscriber.
      { listingId: "l_1", subscriberId: "buyer_3", status: "cancelled" },
      { listingId: "l_1", subscriberId: "buyer_4", status: "expired" },
      // Pays monthly for a COPY, which runs in the buyer's own organization.
      { listingId: "l_1", subscriberId: "buyer_5", status: "active" },
      // No licence row at all: what it is for is not known, so it is not counted.
      { listingId: "l_1", subscriberId: "buyer_6", status: "active" },
    ],
    installs: [
      { listingId: "l_1", buyerId: "buyer_1", kind: "use" },
      { listingId: "l_1", buyerId: "buyer_2", kind: "use" },
      { listingId: "l_1", buyerId: "buyer_3", kind: "use" },
      { listingId: "l_1", buyerId: "buyer_4", kind: "use" },
      { listingId: "l_1", buyerId: "buyer_5", kind: "copy" },
    ],
  });
  assert.deepEqual(result, {
    agents: [
      {
        id: "a_1",
        name: "Analyst",
        onSale: true,
        listing: { id: "l_1", title: "Listing l_1", pricingModel: "monthly", subscribers: 2 },
      },
      { id: "a_3", name: "Legacy", onSale: false, listing: null },
      { id: "a_2", name: "Zed", onSale: false, listing: null },
    ],
  });
});

test("an agent is listed by the model the chat would pick: externalModel comes before the legacy field", async () => {
  const result = await dependentsOf({
    deployments: [deployment()],
    agents: [
      // Stored model is the hosted one, but the chat runs on externalModel.
      agent("a_1", "Moved away", { externalModel: "openai/gpt-4o-mini", model: LLAMA }),
      agent("a_2", "Stays", { externalModel: LLAMA, model: "openai/gpt-4o-mini" }),
    ],
  });
  assert.deepEqual(result!.agents.map((a) => a.name), ["Stays"]);
});

test("an agent whose model was saved with spaces around it is listed: the chat trims it and answers from this deployment", async () => {
  const result = await dependentsOf({
    deployments: [deployment()],
    agents: [
      agent("a_1", "Padded", { externalModel: ` ${LLAMA} ` }),
      agent("a_2", "Padded legacy", { externalModel: "  ", model: `${LLAMA}\n` }),
      // Contains the id and is another model: read, and not listed.
      agent("a_3", "Longer id", { externalModel: `${LLAMA}-instruct` }),
    ],
  });
  assert.deepEqual(
    result?.agents.map((a) => a.name),
    ["Padded", "Padded legacy"],
  );
});

test("only a published listing that sells use puts an agent on sale", async () => {
  for (const over of [{ status: "draft" }, { status: "archived" }, { sells: "copies" }]) {
    const result = await dependentsOf({
      deployments: [deployment()],
      agents: [agent("a_1", "Analyst", { externalModel: LLAMA })],
      listings: [listing("l_1", "a_1", over)],
      subs: [{ listingId: "l_1", subscriberId: "buyer_1", status: "active" }],
      installs: [{ listingId: "l_1", buyerId: "buyer_1", kind: "use" }],
    });
    assert.deepEqual(result, { agents: [{ id: "a_1", name: "Analyst", onSale: false, listing: null }] }, JSON.stringify(over));
  }
});

test("nothing depends on a deployment while another running one would answer the same model", async () => {
  const agents = [agent("a_1", "Analyst", { externalModel: LLAMA })];
  const twin = (over: Row = {}) => deployment({ id: "dep_2", slug: "twin", nosanaJobIds: ["dm_2"], ...over });

  assert.deepEqual(await dependentsOf({ deployments: [deployment(), twin()], agents }), { agents: [] });

  // None of these would answer the agents after the stop.
  for (const other of [
    twin({ status: "provisioning" }),
    twin({ status: "degraded" }),
    twin({ status: "stopped" }),
    // The development stand-in: billed per request, agent chat is not answered from it.
    twin({ nosanaJobIds: ["mock_deploy_1"] }),
    twin({ nosanaJobIds: [] }),
    twin({ modelId: "qwen-2.5-7b" }),
    // Serves a fine-tuned model on the same base: reached by its own name only.
    twin({ fineTunedModelId: "ft_1", fineTunedModel: { orgId: ORG, name: "Tuned", liveSlug: "tuned", status: "ready" } }),
    twin({ orgId: OTHER_ORG }),
  ]) {
    const result = await dependentsOf({ deployments: [deployment(), other], agents });
    assert.deepEqual(result!.agents.map((a) => a.id), ["a_1"], JSON.stringify(other));
  }
});

test("a deployment nothing answers from has no dependents, and no agent is read for it", async () => {
  const agents = [agent("a_1", "Analyst", { externalModel: LLAMA })];
  for (const over of [
    { status: "stopped" },
    { status: "failed" },
    { nosanaJobIds: ["mock_deploy_1"] },
    { nosanaJobIds: ["mock_job_1"] },
    { nosanaJobIds: [] },
  ]) {
    const { db, reads } = makeDb({ deployments: [deployment(over)], agents });
    assert.deepEqual(await listDeploymentDependents({ orgId: ORG, deploymentId: "dep_1" }, { db }), { agents: [] });
    assert.deepEqual(reads, ["deployment.findFirst"], JSON.stringify(over));
  }
});

test("a deployment that is still coming up counts: its agents are waiting for it", async () => {
  for (const status of ["pending", "provisioning", "degraded"]) {
    const result = await dependentsOf({
      deployments: [deployment({ status })],
      agents: [agent("a_1", "Analyst", { externalModel: LLAMA })],
    });
    assert.equal(result!.agents.length, 1, status);
  }
});

test("a deployment that serves a fine-tuned model is depended on by its own name, never by its base model's id", async () => {
  const tuned = (model: Row | null) =>
    deployment({ fineTunedModelId: "ft_1", fineTunedModel: model });
  const agents = [
    agent("a_1", "On the base model", { externalModel: LLAMA }),
    agent("a_2", "On the tuned model", { externalModel: "wheelsai/ft-support-tone" }),
  ];
  const ready = { orgId: ORG, name: "Support tone", liveSlug: "support-tone", status: "ready" };

  const result = await dependentsOf({ deployments: [tuned(ready)], agents });
  assert.deepEqual(result!.agents.map((a) => a.name), ["On the tuned model"]);

  // Not the organization's, not ready, deleted (no live slug), or gone: no agent is answered from it.
  for (const model of [
    { ...ready, orgId: OTHER_ORG },
    { ...ready, status: "training" },
    { ...ready, liveSlug: null },
    { ...ready, liveSlug: "Not A Slug" },
    null,
  ]) {
    assert.deepEqual(await dependentsOf({ deployments: [tuned(model)], agents }), { agents: [] }, JSON.stringify(model));
  }
});

test("another organization's deployment is not found, and its agents and listings never appear", async () => {
  const seed = {
    deployments: [deployment(), deployment({ id: "dep_theirs", orgId: OTHER_ORG, nosanaJobIds: ["dm_9"] })],
    agents: [
      agent("a_mine", "Mine", { externalModel: LLAMA }),
      // The same model id, in another organization: answered from THEIR deployment.
      agent("a_theirs", "Theirs", { externalModel: LLAMA }, OTHER_ORG),
    ],
    listings: [listing("l_theirs", "a_theirs")],
    subs: [{ listingId: "l_theirs", subscriberId: "buyer_1", status: "active" }],
    installs: [{ listingId: "l_theirs", buyerId: "buyer_1", kind: "use" }],
  };
  assert.equal(await dependentsOf(seed, "dep_theirs", ORG), null);
  assert.equal(await dependentsOf(seed, "no_such_deployment", ORG), null);

  const mine = await dependentsOf(seed, "dep_1", ORG);
  assert.deepEqual(mine, { agents: [{ id: "a_mine", name: "Mine", onSale: false, listing: null }] });
  assert.doesNotMatch(JSON.stringify(mine), /theirs/i);

  const theirs = await dependentsOf(seed, "dep_theirs", OTHER_ORG);
  assert.deepEqual(theirs!.agents.map((a) => a.id), ["a_theirs"]);
});

test("the model id a deployment answers is the one the model picker gives it", async () => {
  // deploymentDependents.ts re-states hostedModelChoices.ts's identity rule,
  // which is not exported. For each kind of deployment the picker's id must
  // be the id whose agents are listed here.
  const rows = [
    deployment(),
    deployment({
      id: "dep_ft",
      slug: "tuned",
      nosanaJobIds: ["dm_ft"],
      fineTunedModelId: "ft_1",
      fineTunedModel: { orgId: ORG, name: "Support tone", liveSlug: "support-tone", status: "ready" },
    }),
  ];
  const choices = await listHostedModelChoices(
    { orgId: ORG },
    {
      db: { deployment: { findMany: async () => rows } } as never,
      resolveHostedModel: async () => ({ ok: false, message: "not asked here" }),
    },
  );
  assert.equal(choices.length, 2);
  for (const choice of choices) {
    const result = await dependentsOf(
      { deployments: rows, agents: [agent("a_1", "Analyst", { externalModel: choice.id })] },
      choice.deployment.id,
    );
    assert.deepEqual(result!.agents.map((a) => a.id), ["a_1"], choice.id);
    // And the other deployment, which answers a different id, lists nobody.
    const other = rows.find((row) => row.id !== choice.deployment.id)!;
    assert.deepEqual(
      await dependentsOf({ deployments: rows, agents: [agent("a_1", "Analyst", { externalModel: choice.id })] }, other.id),
      { agents: [] },
    );
  }
});
