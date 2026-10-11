import assert from "node:assert/strict";
import test from "node:test";

import "./unitEnv.js";

import type { HostedModelResolution } from "../services/hostedModel.js";
import { listHostedModelChoices } from "../services/hostedModelChoices.js";

// An agent set to `wheelsai/<model id>` is answered from its organization's
// own deployment, and no screen offered that choice. listHostedModelChoices
// is the list a picker draws it from. Each test below pins one rule of which
// deployments are listed and what an entry says.

const ORG = "org-1";
const OTHER_ORG = "org-2";
const NODE = "https://abc.node.k8s.prd.nos.ci";

let seq = 0;

/** A deployment row as the database holds it; later rows are newer unless told otherwise. */
function row(over: Record<string, unknown> = {}) {
  seq += 1;
  return {
    id: `dep-${seq}`,
    orgId: ORG,
    slug: `llama-${seq}`,
    name: `Llama ${seq}`,
    status: "running",
    modelId: "llama-3.1-8b",
    engine: "vllm",
    gpuTier: "4090",
    replicas: 1,
    billedThroughAt: new Date(),
    nosanaJobIds: [`DeploymentManagerId${seq}`],
    fineTunedModelId: null as string | null,
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, seq)),
    model: { displayName: "Llama 3.1 8B", hfId: "meta-llama/Meta-Llama-3.1-8B-Instruct" },
    fineTunedModel: null as null | Record<string, unknown>,
    nodes: [{ id: "n1", nodeUrl: NODE, healthStatus: "healthy", latencyMs: 10 }],
    ...over,
  };
}

type Row = ReturnType<typeof row>;

const fineTuned = (over: Record<string, unknown> = {}, model: Record<string, unknown> = {}) =>
  row({
    fineTunedModelId: "ftm-1",
    fineTunedModel: {
      orgId: ORG,
      name: "Support tone",
      slug: "support-tone",
      liveSlug: "support-tone",
      status: "ready",
      ...model,
    },
    ...over,
  });

/** One condition of a `where`, as far as these queries use them. */
function holds(actual: unknown, expected: unknown): boolean {
  if (expected !== null && typeof expected === "object" && "in" in expected) {
    return (expected as { in: unknown[] }).in.includes(actual);
  }
  if (expected !== null && typeof expected === "object") {
    return (
      actual !== null &&
      typeof actual === "object" &&
      Object.entries(expected).every(([k, v]) => holds((actual as Record<string, unknown>)[k], v))
    );
  }
  return actual === expected;
}

const matching = (rows: Row[], where: Record<string, unknown>) =>
  rows.filter((r) => Object.entries(where).every(([k, v]) => holds((r as Record<string, unknown>)[k], v)));

/**
 * A database holding `rows` that answers the two reads on this path and
 * nothing else: any other table, and any other call on these, throws.
 */
function db(rows: Row[], balanceCents = 10_000n) {
  const calls: string[] = [];
  const only = (name: string, methods: Record<string, unknown>) =>
    new Proxy(methods, {
      get(target, prop) {
        if (typeof prop === "string" && !(prop in target)) {
          throw new Error(`${name}.${prop} is not a read this list may make`);
        }
        return (target as Record<string | symbol, unknown>)[prop];
      },
    });
  const tables: Record<string, unknown> = {
    deployment: only("deployment", {
      findMany: async ({ where }: any) => {
        calls.push("deployment.findMany");
        // Oldest first: the list must not lean on the order rows arrive in.
        return matching(rows, where).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      },
      findFirst: async ({ where }: any) => {
        calls.push("deployment.findFirst");
        return matching(rows, where).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
      },
    }),
    creditBalance: only("creditBalance", {
      findUnique: async () => {
        calls.push("creditBalance.findUnique");
        return { balanceCents };
      },
    }),
  };
  const handle = new Proxy(tables, {
    get(target, prop) {
      if (typeof prop === "string" && !(prop in target)) throw new Error(`${prop} is not read by this list`);
      return (target as Record<string | symbol, unknown>)[prop];
    },
  });
  return { handle: handle as any, calls };
}

/** The list over `rows`, with the real resolveHostedModel reading the same rows. */
async function choicesOf(rows: Row[], orgId = ORG, balanceCents = 10_000n) {
  const { resolveHostedModel } = await import("../services/hostedModel.js");
  const fake = db(rows, balanceCents);
  const choices = await listHostedModelChoices(
    { orgId },
    { db: fake.handle, resolveHostedModel: (args) => resolveHostedModel(args, fake.handle) },
  );
  return { choices, calls: fake.calls };
}

test("a running deployment of a catalog model is one choice, named as the catalog names it", async () => {
  const mine = row({ slug: "my-llama", name: "My Llama" });
  const { choices } = await choicesOf([mine]);
  assert.deepEqual(choices, [
    {
      id: "wheelsai/llama-3.1-8b",
      displayName: "Llama 3.1 8B",
      available: true,
      state: "running",
      fineTuned: false,
      deployment: { id: mine.id, slug: "my-llama", name: "My Llama" },
    },
  ]);
});

test("another organization's deployment never appears", async () => {
  const theirs = row({ orgId: OTHER_ORG, modelId: "qwen-2.5-7b", model: { displayName: "Qwen 2.5 7B", hfId: "Qwen/Qwen2.5-7B" } });
  const mine = row();
  const { choices } = await choicesOf([theirs, mine]);
  assert.deepEqual(choices.map((c) => c.deployment.id), [mine.id]);

  // An organization with nothing of its own is offered nothing.
  assert.deepEqual((await choicesOf([theirs, mine], "org-3")).choices, []);
});

test("a development stand-in deployment is never listed, alone or beside a real one", async () => {
  const standIn = row({ nosanaJobIds: ["mock_deploy_abc"] });
  assert.deepEqual((await choicesOf([standIn])).choices, []);
  assert.deepEqual((await choicesOf([row({ nosanaJobIds: [] })])).choices, []);

  // Older than the stand-in: the entry describes the real one, and it is not
  // offered as answering while the chat path would pick the stand-in.
  seq = 0;
  const real = row();
  const newerStandIn = row({ nosanaJobIds: ["mock_job_abc"] });
  const { choices } = await choicesOf([real, newerStandIn]);
  assert.equal(choices.length, 1);
  assert.equal(choices[0]!.deployment.id, real.id);
  assert.equal(choices[0]!.available, false);
  assert.equal(choices[0]!.state, "not_answering");
});

test("only live deployments are listed: stopped and failed ones are not", async () => {
  const live = ["running", "degraded", "pending", "provisioning"].map((status, i) =>
    row({ status, modelId: `model-${i}`, model: { displayName: `Model ${i}`, hfId: `org/model-${i}` } }),
  );
  const dead = ["stopped", "failed"].map((status, i) =>
    row({ status, modelId: `dead-${i}`, model: { displayName: `Dead ${i}`, hfId: `org/dead-${i}` } }),
  );
  const { choices } = await choicesOf([...live, ...dead]);
  assert.deepEqual(
    choices.map((c) => c.deployment.id).sort(),
    live.map((r) => r.id).sort(),
  );
});

test("a fine-tuned deployment is listed by its fine-tuned model's name, never under its base model's id", async () => {
  const tuned = fineTuned({ slug: "tone-gpu" });
  const { choices } = await choicesOf([tuned]);
  assert.deepEqual(choices, [
    {
      id: "wheelsai/ft-support-tone",
      displayName: "Support tone",
      available: true,
      state: "running",
      fineTuned: true,
      deployment: { id: tuned.id, slug: "tone-gpu", name: tuned.name },
    },
  ]);
  assert.ok(!choices.some((c) => c.id === "wheelsai/llama-3.1-8b"));

  // Beside a deployment of the base model, each goes by its own id.
  const base = row();
  const both = (await choicesOf([tuned, base])).choices;
  assert.deepEqual(
    both.map((c) => [c.id, c.deployment.id]).sort(),
    [
      ["wheelsai/ft-support-tone", tuned.id],
      ["wheelsai/llama-3.1-8b", base.id],
    ],
  );
});

test("a fine-tuned deployment is listed only while its model is ready, live and the organization's own", async () => {
  const notListed = [
    fineTuned({}, { status: "deleted" }),
    fineTuned({}, { liveSlug: null }),
    fineTuned({}, { orgId: OTHER_ORG }),
    // The model row is gone but the deployment still names one.
    row({ fineTunedModelId: "ftm-9", fineTunedModel: null }),
  ];
  for (const tuned of notListed) {
    assert.deepEqual((await choicesOf([tuned])).choices, [], JSON.stringify(tuned.fineTunedModel));
  }
});

test("one entry for each id, describing the newest running deployment when one runs", async () => {
  seq = 0;
  const oldRunning = row({ slug: "old-running" });
  const newRunning = row({ slug: "new-running" });
  const newestStarting = row({ slug: "newest-starting", status: "provisioning" });
  const { choices } = await choicesOf([oldRunning, newRunning, newestStarting]);
  assert.equal(choices.length, 1);
  assert.equal(choices[0]!.id, "wheelsai/llama-3.1-8b");
  assert.equal(choices[0]!.deployment.slug, "new-running");
  assert.equal(choices[0]!.available, true);
});

test("with no running deployment of an id, its entry describes the newest live one", async () => {
  seq = 0;
  const degraded = row({ slug: "older-degraded", status: "degraded" });
  const pending = row({ slug: "newer-pending", status: "pending" });
  const { choices } = await choicesOf([degraded, pending]);
  assert.equal(choices.length, 1);
  assert.equal(choices[0]!.deployment.slug, "newer-pending");
  assert.equal(choices[0]!.available, false);
  assert.equal(choices[0]!.state, "starting");
});

test("available is what resolveHostedModel answers for the id, asked once for each id", async () => {
  const a = row({ modelId: "model-a", model: { displayName: "Model A", hfId: "org/a" } });
  const b = row({ modelId: "model-b", model: { displayName: "Model B", hfId: "org/b" } });
  const asked: Array<{ orgId: string; modelId: string }> = [];
  const answers: Record<string, HostedModelResolution> = {
    "wheelsai/model-a": { ok: false, message: "no healthy node" },
    "wheelsai/model-b": { ok: true, deploymentId: b.id, resolved: {} as never },
  };
  const choices = await listHostedModelChoices(
    { orgId: ORG },
    {
      db: db([a, b]).handle,
      resolveHostedModel: async (args) => {
        asked.push(args);
        return answers[args.modelId]!;
      },
    },
  );
  assert.deepEqual(
    asked.sort((x, y) => x.modelId.localeCompare(y.modelId)),
    [
      { orgId: ORG, modelId: "wheelsai/model-a" },
      { orgId: ORG, modelId: "wheelsai/model-b" },
    ],
  );
  assert.deepEqual(
    choices.map((c) => [c.id, c.available]),
    [
      ["wheelsai/model-b", true],
      ["wheelsai/model-a", false],
    ],
  );
});

test("a running deployment the chat path refuses is not available: no healthy node, unpaid GPU time", async () => {
  const noNode = await choicesOf([row({ nodes: [] })]);
  assert.deepEqual([noNode.choices[0]!.available, noNode.choices[0]!.state], [false, "not_answering"]);

  const unpaid = await choicesOf([row({ billedThroughAt: new Date(Date.now() - 600_000) })], ORG, 0n);
  assert.deepEqual([unpaid.choices[0]!.available, unpaid.choices[0]!.state], [false, "not_answering"]);
});

test("two running deployments of one model: the entry follows the newest, as the chat path does", async () => {
  // The newest has no healthy node and an older one has. The chat path picks
  // the newest and refuses, so the older one's health does not make the id
  // available, and the entry does not name the older one as answering.
  seq = 0;
  const olderHealthy = row({ slug: "older-healthy" });
  const newerSick = row({ slug: "newer-sick", nodes: [] });
  const { choices } = await choicesOf([olderHealthy, newerSick]);
  assert.equal(choices.length, 1);
  assert.deepEqual(
    [choices[0]!.deployment.slug, choices[0]!.available, choices[0]!.state],
    ["newer-sick", false, "not_answering"],
  );

  // The other way round, the newest answers and is the one named.
  seq = 0;
  const olderSick = row({ slug: "older-sick", nodes: [] });
  const newerHealthy = row({ slug: "newer-healthy" });
  const other = (await choicesOf([olderSick, newerHealthy])).choices;
  assert.deepEqual([other[0]!.deployment.slug, other[0]!.available], ["newer-healthy", true]);
});

test("a fine-tuned deployment whose model is gone is not listed under its base model, beside a base deployment", async () => {
  seq = 0;
  const base = row({ slug: "base" });
  const orphan = fineTuned({ slug: "orphan-tuned" }, { status: "deleted", liveSlug: null });
  const { choices } = await choicesOf([base, orphan]);
  assert.deepEqual(
    choices.map((c) => [c.id, c.deployment.slug, c.available]),
    [["wheelsai/llama-3.1-8b", "base", true]],
  );
});

test("state: running when available, starting while pending or provisioning, not_answering otherwise", async () => {
  const of = async (status: string, over: Record<string, unknown> = {}) =>
    (await choicesOf([row({ status, ...over })])).choices[0]!;
  assert.deepEqual([(await of("running")).state, (await of("running")).available], ["running", true]);
  assert.equal((await of("pending")).state, "starting");
  assert.equal((await of("provisioning")).state, "starting");
  assert.equal((await of("degraded")).state, "not_answering");
  assert.equal((await of("running", { nodes: [] })).state, "not_answering");
  for (const status of ["pending", "provisioning", "degraded"]) {
    assert.equal((await of(status)).available, false, status);
  }
});

test("an entry is available only for the deployment it names", async () => {
  // The answer comes from a deployment that came up after the list was read:
  // the entry does not offer the one it names as answering.
  const listed = row();
  const choices = await listHostedModelChoices(
    { orgId: ORG },
    {
      db: db([listed]).handle,
      resolveHostedModel: async () => ({ ok: true, deploymentId: "dep-not-listed", resolved: {} as never }),
    },
  );
  assert.equal(choices[0]!.deployment.id, listed.id);
  assert.equal(choices[0]!.available, false);

  // One of the id's listed deployments: the entry describes that one.
  seq = 0;
  const older = row({ slug: "older" });
  const newer = row({ slug: "newer" });
  const named = await listHostedModelChoices(
    { orgId: ORG },
    {
      db: db([older, newer]).handle,
      resolveHostedModel: async () => ({ ok: true, deploymentId: older.id, resolved: {} as never }),
    },
  );
  assert.deepEqual([named[0]!.deployment.slug, named[0]!.available], ["older", true]);
});

test("order: available ones first, then by display name", async () => {
  const named = (displayName: string, over: Record<string, unknown> = {}) =>
    row({ modelId: displayName.toLowerCase(), model: { displayName, hfId: `org/${displayName}` }, ...over });
  const { choices } = await choicesOf([
    named("Zephyr"),
    named("Alpha", { status: "pending" }),
    named("Mistral"),
    named("Beta", { status: "degraded" }),
    named("Gemma"),
  ]);
  assert.deepEqual(
    choices.map((c) => [c.displayName, c.available]),
    [
      ["Gemma", true],
      ["Mistral", true],
      ["Zephyr", true],
      ["Alpha", false],
      ["Beta", false],
    ],
  );
});

test("building the list only reads: one deployment query, then what resolveHostedModel reads", async () => {
  // The fake database throws on any call but findMany, findFirst and the
  // balance read, so a write, a charge or a reservation would fail here.
  const { choices, calls } = await choicesOf([row(), fineTuned(), row({ status: "pending", modelId: "m2" })]);
  assert.equal(choices.length, 3);
  assert.equal(calls.filter((c) => c === "deployment.findMany").length, 1);
  assert.deepEqual(
    [...new Set(calls)].sort(),
    ["deployment.findFirst", "deployment.findMany"],
    "a paid-up deployment needs no balance read, and nothing else is touched",
  );

  // With GPU time owed, the balance is read too. Still nothing is written.
  const owed = await choicesOf([row({ billedThroughAt: new Date(Date.now() - 600_000) })]);
  assert.deepEqual([...new Set(owed.calls)].sort(), [
    "creditBalance.findUnique",
    "deployment.findFirst",
    "deployment.findMany",
  ]);
});

test("an organization with no deployment gets an empty list and resolveHostedModel is not asked", async () => {
  let asked = 0;
  const choices = await listHostedModelChoices(
    { orgId: ORG },
    {
      db: db([]).handle,
      resolveHostedModel: async () => {
        asked += 1;
        return { ok: false, message: "" };
      },
    },
  );
  assert.deepEqual(choices, []);
  assert.equal(asked, 0);
});
