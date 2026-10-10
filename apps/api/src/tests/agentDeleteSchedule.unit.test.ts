/**
 * DELETE /api/agents/:id and the agent's scheduled tasks.
 *
 * Since scheduled_tasks.agent_id is a foreign key with ON DELETE CASCADE, an
 * agent's tasks go with the agent and each task's saved runs go with the
 * task. The route relies on exactly that: it deletes the agent in one
 * statement and never switches off or deletes a task by hand, so there is no
 * moment at which a task is left firing for an agent that is half gone, and
 * nothing is deleted twice.
 *
 * Pinned here: what the route does (over a database stand-in that applies
 * the cascade the way Postgres does), and the cascade itself, in the schema
 * and in the migration that added it.
 *
 * Hermetic: the global prisma's delegates are replaced for each test.
 */
import "./unitEnv.js";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { prisma } from "@wheelsai/db";

import { globalErrorHandler } from "../lib/errorHandler.js";
import { createAgentRoutes } from "../routes/agents.js";

const ORG = "0f1e2d3c-4b5a-4968-8776-655443322110";
const AGENT_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_AGENT_ID = "99999999-2222-4333-8444-555555555555";

type Row = Record<string, any>;

const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

interface World {
  agents: Row[];
  tasks: Row[];
  executions: Row[];
  /** Every call the route made on the database, in order. */
  calls: string[];
  deleteFails?: boolean;
}

async function appWith(world: World) {
  const names = ["agent", "agentListing", "scheduledTask", "taskExecution", "openClawChannel", "webhook", "$transaction"] as const;
  const saved = Object.fromEntries(names.map((name) => [name, (prisma as any)[name]]));

  /** A delegate the route must never reach for. */
  const untouched = (name: string) =>
    new Proxy(
      {},
      {
        get: (_target, method) => () => {
          world.calls.push(`${name}.${String(method)}`);
          throw new Error(`the delete must not touch ${name}`);
        },
      },
    );

  (prisma as any).agent = {
    findFirst: async ({ where }: Row) => {
      world.calls.push("agent.findFirst");
      const agent = world.agents.find((a) => a.id === where.id && a.orgId === where.orgId);
      return agent ? { ...agent, deployments: [] } : null;
    },
    // One statement. What Postgres does with it: the agent's tasks go with
    // it (scheduled_tasks_agent_id_fkey) and their runs with the tasks
    // (task_executions_task_id_fkey), all or nothing.
    delete: async ({ where }: Row) => {
      world.calls.push("agent.delete");
      if (world.deleteFails) throw new Error("the database went away");
      const gone = new Set(world.tasks.filter((t) => t.agentId === where.id).map((t) => t.id));
      world.agents = world.agents.filter((a) => a.id !== where.id);
      world.tasks = world.tasks.filter((t) => !gone.has(t.id));
      world.executions = world.executions.filter((e) => !gone.has(e.taskId));
      return {};
    },
  };
  // Read first: whether people have paid for the agent (none here).
  (prisma as any).agentListing = { findFirst: async () => null };
  (prisma as any).scheduledTask = untouched("scheduledTask");
  (prisma as any).taskExecution = untouched("taskExecution");
  (prisma as any).$transaction = () => {
    world.calls.push("$transaction");
    throw new Error("the delete opens no transaction: it is one statement");
  };
  // The agent's Telegram bots are read before the delete (none here).
  (prisma as any).openClawChannel = {
    findMany: async () => {
      world.calls.push("openClawChannel.findMany");
      return [];
    },
  };
  // "agent.deleted" is announced without waiting; no webhook is set up here.
  (prisma as any).webhook = { findMany: async () => [] };

  const app = Fastify();
  app.setErrorHandler(globalErrorHandler);
  await app.register(sensible);
  await app.register(
    createAgentRoutes({
      requireAuth: async (request) => {
        (request as { auth?: unknown }).auth = { orgId: ORG, userId: "user-1", type: "jwt", role: "owner" };
      },
    }),
  );
  await app.ready();
  return {
    remove: (id: string) => app.inject({ method: "DELETE", url: `/${id}` }),
    close: async () => {
      await app.close();
      // Let the announcement settle on the stand-ins before they are put back.
      await new Promise((resolve) => setImmediate(resolve));
      for (const name of names) (prisma as any)[name] = saved[name];
    },
  };
}

const newWorld = (over: Partial<World> = {}): World => ({
  agents: [
    { id: AGENT_ID, orgId: ORG, name: "Morning Briefing" },
    { id: OTHER_AGENT_ID, orgId: ORG, name: "Reviewer" },
  ],
  tasks: [
    { id: "task_own", agentId: AGENT_ID, taskType: "agent_run", isEnabled: true },
    { id: "task_report", agentId: AGENT_ID, taskType: "report", isEnabled: true },
    { id: "task_other", agentId: OTHER_AGENT_ID, taskType: "agent_run", isEnabled: true },
    { id: "task_no_agent", agentId: null, taskType: "webhook", isEnabled: true },
  ],
  executions: [
    { id: "exec_1", taskId: "task_own" },
    { id: "exec_2", taskId: "task_own" },
    { id: "exec_3", taskId: "task_report" },
    { id: "exec_4", taskId: "task_other" },
    { id: "exec_5", taskId: "task_no_agent" },
  ],
  calls: [],
  ...over,
});

test("deleting an agent is one statement: its tasks and their saved runs go with it, and nothing else does", async () => {
  const world = newWorld();
  const { remove, close } = await appWith(world);
  try {
    const res = await remove(AGENT_ID);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { message: "Agent deleted" });
  } finally {
    await close();
  }

  // Read, the Telegram bots, then the one delete: no task is switched off or
  // deleted by hand before or after it, so none can outlive its agent and
  // none is deleted twice.
  assert.deepEqual(world.calls, ["agent.findFirst", "openClawChannel.findMany", "agent.delete"]);
  assert.deepEqual(world.agents.map((a) => a.id), [OTHER_AGENT_ID]);
  assert.deepEqual(world.tasks.map((t) => t.id), ["task_other", "task_no_agent"]);
  assert.deepEqual(world.executions.map((e) => e.id), ["exec_4", "exec_5"]);
  assert.ok(world.tasks.every((t) => t.isEnabled), "another agent's schedule is left on");
});

test("an agent with no scheduled task is deleted as before", async () => {
  const world = newWorld({ tasks: [], executions: [] });
  const { remove, close } = await appWith(world);
  try {
    assert.equal((await remove(AGENT_ID)).statusCode, 200);
  } finally {
    await close();
  }
  assert.deepEqual(world.calls, ["agent.findFirst", "openClawChannel.findMany", "agent.delete"]);
  assert.deepEqual(world.agents.map((a) => a.id), [OTHER_AGENT_ID]);
});

test("a delete that does not happen leaves the agent and its schedule exactly as they were", async () => {
  // Not this organization's agent, or no such agent: 404 before anything is touched.
  const missing = newWorld({ agents: [{ id: AGENT_ID, orgId: "someone-else", name: "Theirs" }] });
  const first = await appWith(missing);
  try {
    assert.equal((await first.remove(AGENT_ID)).statusCode, 404);
  } finally {
    await first.close();
  }
  assert.deepEqual(missing.calls, ["agent.findFirst"]);
  assert.equal(missing.tasks.length, 4);
  assert.equal(missing.executions.length, 5);

  // The delete itself fails: the schedule was not switched off first, so it is still on.
  const failing = newWorld({ deleteFails: true });
  const second = await appWith(failing);
  try {
    assert.equal((await second.remove(AGENT_ID)).statusCode, 500);
  } finally {
    await second.close();
  }
  assert.equal(failing.agents.length, 2);
  assert.deepEqual(
    failing.tasks.map((t) => [t.id, t.isEnabled]),
    [
      ["task_own", true],
      ["task_report", true],
      ["task_other", true],
      ["task_no_agent", true],
    ],
  );
  assert.equal(failing.executions.length, 5);
});

test("the route deletes the agent once, after every refusal, and never reaches for its tasks", () => {
  const route = source("../routes/agents.ts");
  const start = route.indexOf('app.delete("/:agentId"');
  const handler = route.slice(start, route.indexOf("* Deploy agent", start));
  assert.ok(start > 0 && handler.length > 0);

  assert.equal(handler.match(/prisma\.agent\.delete\(/g)?.length, 1, "one delete of the agent");
  assert.equal(route.match(/\.agent\.delete\(/g)?.length, 1, "and no other in the file");
  assert.doesNotMatch(handler, /scheduledTask|taskExecution/, "the cascade removes the tasks, not the route");

  // A delete that is refused (the agent's GPU could not be confirmed stopped)
  // returns before the delete, so the agent and its schedule stay whole.
  const deleteAt = handler.indexOf("prisma.agent.delete(");
  const refusedAt = handler.indexOf('error: "nosana_stop_failed"');
  const notFoundAt = handler.indexOf('reply.notFound("Agent not found")');
  assert.ok(notFoundAt > 0 && notFoundAt < deleteAt);
  assert.ok(refusedAt > 0 && refusedAt < deleteAt);
  // What depends on the rows being gone comes after it.
  assert.ok(handler.indexOf("releaseTelegramWebhooks(") > deleteAt);
  assert.ok(handler.indexOf('"agent.deleted"') > deleteAt);
});

test("the cascade the route relies on is in the schema and in its migration", () => {
  const schema = source("../../../../packages/db/prisma/schema.prisma");
  const block = (model: string) => {
    const start = schema.indexOf(`model ${model} {`);
    assert.ok(start > 0, model);
    return schema.slice(start, schema.indexOf("\n}", start));
  };
  // A task goes with its agent...
  assert.match(
    block("ScheduledTask"),
    /agent\s+Agent\?\s+@relation\(fields: \[agentId\], references: \[id\], onDelete: Cascade\)/,
  );
  // ...and a task's runs go with the task.
  assert.match(
    block("TaskExecution"),
    /task\s+ScheduledTask\s+@relation\(fields: \[taskId\], references: \[id\], onDelete: Cascade\)/,
  );

  const migration = source(
    "../../../../packages/db/prisma/migrations/20261014100000_scheduled_results/migration.sql",
  );
  assert.match(
    migration,
    /ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_agent_id_fkey" FOREIGN KEY \("agent_id"\) REFERENCES "agents"\("id"\) ON DELETE CASCADE/,
  );
});
