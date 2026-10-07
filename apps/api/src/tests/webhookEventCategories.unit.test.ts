import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  webhookEventCategories,
  webhookEventCategory,
} from "../services/webhookEventCategories.js";
import {
  createEmitDeploymentTransition,
  deploymentTransitionEvents,
  isAgentDeployed,
} from "../services/deploymentTransitionEvents.js";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

/** The list in services/webhooks.ts, read from source (the module opens Prisma). */
function declaredEvents(): string[] {
  const source = read("../services/webhooks.ts");
  const start = source.indexOf("export const WEBHOOK_EVENTS");
  const list = source.slice(start, source.indexOf("];", start));
  return [...list.matchAll(/^\s*"([a-z_.]+)",/gm)].map((m) => m[1]!);
}

test("the category is the part of the name before its first dot", () => {
  assert.equal(webhookEventCategory("agent.version.created"), "agent");
  assert.equal(webhookEventCategory("scheduled_task.failed"), "scheduled_task");
  assert.equal(webhookEventCategory("ping"), "ping");
});

test("every declared event is in exactly one category", () => {
  const events = declaredEvents();
  assert.ok(events.length >= 20, `read ${events.length} events`);
  const categories = webhookEventCategories(events);
  const grouped = Object.values(categories).flat();
  assert.deepEqual([...grouped].sort(), [...events].sort());
  assert.equal(new Set(grouped).size, grouped.length);
});

test("workflow, scheduled-task and report events have categories", () => {
  const categories = webhookEventCategories(declaredEvents());
  assert.deepEqual(categories.workflow, ["workflow.completed", "workflow.failed"]);
  assert.deepEqual(categories.scheduled_task, ["scheduled_task.failed"]);
  assert.deepEqual(categories.report, ["report.generated"]);
  // The five that existed keep their contents and come first, in order.
  assert.deepEqual(Object.keys(categories), [
    "agent",
    "deployment",
    "training",
    "alert",
    "billing",
    "workflow",
    "scheduled_task",
    "report",
    "job",
  ]);
  assert.deepEqual(categories.job, [
    "job.funded",
    "job.submitted",
    "job.completed",
    "job.rejected",
    "job.failed",
    "job.expired",
    "job.cancelled",
  ]);
  assert.deepEqual(categories.billing, ["billing.low_balance", "billing.payment_received"]);
});

test("an event with a prefix nobody listed still gets a category, after the known ones", () => {
  const categories = webhookEventCategories(["zebra.seen", "agent.created", "apple.picked"]);
  assert.deepEqual(Object.keys(categories), ["agent", "apple", "zebra"]);
});

test("the events route derives its categories from the list", () => {
  const route = read("../routes/webhooks.ts");
  assert.match(route, /categories: webhookEventCategories\(WEBHOOK_EVENTS\)/);
  assert.doesNotMatch(route, /startsWith\("(agent|deployment|training|alert|billing)\."\)/);
});

// ---------------------------------------------------------------------------
// agent.deployed
// ---------------------------------------------------------------------------

const observedAt = new Date("2026-10-08T10:00:00.000Z");
const transition = (over: Record<string, unknown> = {}) => ({
  kind: "agent" as const,
  id: "dep_1",
  orgId: "org_1",
  fromStatus: "deploying",
  toStatus: "running",
  observedAt,
  ...over,
});
const agent = { agentId: "agent_1", name: "Support concierge", slug: "support-concierge" };

test("an agent deployment that starts running announces deployment.running and agent.deployed", () => {
  const events = deploymentTransitionEvents(transition(), agent);
  assert.deepEqual(
    events.map((e) => [e.type, e.resourceType, e.resourceId]),
    [
      ["deployment.running", "deployment", "dep_1"],
      ["agent.deployed", "agent", "agent_1"],
    ],
  );
  assert.deepEqual(events[1]!.data, {
    agentId: "agent_1",
    name: "Support concierge",
    slug: "support-concierge",
    deploymentId: "dep_1",
    observedAt: "2026-10-08T10:00:00.000Z",
  });
  assert.deepEqual(events[0]!.data, {
    deploymentId: "dep_1",
    deploymentKind: "agent",
    fromStatus: "deploying",
    toStatus: "running",
    observedAt: "2026-10-08T10:00:00.000Z",
  });
});

test("agent.deployed is not sent for a model deployment, a failure, a stop or a degraded state", () => {
  const types = (t: ReturnType<typeof transition>) => deploymentTransitionEvents(t, agent).map((e) => e.type);
  assert.deepEqual(types(transition({ kind: "model" })), ["deployment.running"]);
  assert.deepEqual(types(transition({ toStatus: "failed" })), ["deployment.failed"]);
  assert.deepEqual(types(transition({ fromStatus: "running", toStatus: "stopped" })), ["deployment.stopped"]);
  assert.deepEqual(types(transition({ fromStatus: "running", toStatus: "degraded" })), []);
  assert.equal(isAgentDeployed(transition({ fromStatus: "running" })), false);
});

function emitter(over: { load?: () => Promise<typeof agent | null>; failOn?: string } = {}) {
  const sent: Array<[string, string, Record<string, unknown>, string, string]> = [];
  const errors: string[] = [];
  let lookups = 0;
  const emit = createEmitDeploymentTransition({
    loadDeployedAgent: async (deploymentId, orgId) => {
      assert.deepEqual([deploymentId, orgId], ["dep_1", "org_1"]);
      lookups += 1;
      return over.load ? over.load() : agent;
    },
    triggerWebhook: async (orgId, type, data, resourceType, resourceId) => {
      if (type === over.failOn) throw new Error("delivery store down");
      sent.push([orgId, type, data, resourceType, resourceId]);
    },
    onError: (_err, eventType) => errors.push(eventType),
  });
  return { emit, sent, errors, lookups: () => lookups };
}

test("the emitter looks the agent up and sends both events to the deployment's organization", async () => {
  const { emit, sent, lookups } = emitter();
  await emit(transition());
  assert.deepEqual(
    sent.map(([orgId, type, , resourceType, resourceId]) => [orgId, type, resourceType, resourceId]),
    [
      ["org_1", "deployment.running", "deployment", "dep_1"],
      ["org_1", "agent.deployed", "agent", "agent_1"],
    ],
  );
  assert.equal(lookups(), 1);
});

test("the agent is only looked up when an agent deployment starts running", async () => {
  const { emit, sent, lookups } = emitter();
  await emit(transition({ kind: "model" }));
  await emit(transition({ toStatus: "failed" }));
  assert.equal(lookups(), 0);
  assert.deepEqual(sent.map((s) => s[1]), ["deployment.running", "deployment.failed"]);
});

test("a failed lookup or delivery is reported and never throws; the other event is still sent", async () => {
  const lookupFails = emitter({
    load: async () => {
      throw new Error("db down");
    },
  });
  await lookupFails.emit(transition());
  assert.deepEqual(lookupFails.sent.map((s) => s[1]), ["deployment.running"]);
  assert.deepEqual(lookupFails.errors, ["agent.deployed"]);

  const gone = emitter({ load: async () => null });
  await gone.emit(transition());
  assert.deepEqual(gone.sent.map((s) => s[1]), ["deployment.running"]);

  const deliveryFails = emitter({ failOn: "deployment.running" });
  await deliveryFails.emit(transition());
  assert.deepEqual(deliveryFails.sent.map((s) => s[1]), ["agent.deployed"]);
  assert.deepEqual(deliveryFails.errors, ["deployment.running"]);
});

test("the status worker emits through it", () => {
  const queue = read("../queues/deployment-status.queue.ts");
  assert.match(queue, /emitTransition: createEmitDeploymentTransition\(\{/);
  // The lookup stays inside the transition's organization.
  assert.match(queue, /where: \{ id: deploymentId, agent: \{ orgId \} \}/);
});
