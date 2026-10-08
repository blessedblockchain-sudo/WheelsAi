/**
 * An in-memory world for the agent schedule tests (the service and its
 * routes): agents, scheduled tasks, executions and alert channels of two
 * organizations, behind the same dependencies production binds to Prisma.
 *
 * The stand-in applies the `where` the service sends, so "only that agent's
 * tasks in that organization" and the compare-and-set are tested as the
 * queries. Every write and every send is recorded. A transaction that throws
 * is undone. An agent's row lock (SELECT ... FOR UPDATE) is held until the
 * transaction that took it ends, and a second transaction asking for it waits.
 */
import { isDeepStrictEqual } from "node:util";

import type { OwnScheduleDb, OwnScheduleRow } from "../services/agentOwnSchedule.js";
import type { AgentScheduleDeps, RunRow } from "../services/agentSchedule.js";
import type { ReportChannel } from "../services/scheduledTasks/report.js";
import type { ChannelMessage } from "../services/scheduledTasks/reportDelivery.js";
import type { DeliveryRecord } from "../services/scheduledTasks/resultDelivery.js";

export const ORG = "org-owner";
export const OTHER_ORG = "org-other";
export const AGENT = "11111111-1111-4111-8111-111111111111";
export const SECOND_AGENT = "22222222-2222-4222-8222-222222222222";
export const FOREIGN_AGENT = "33333333-3333-4333-8333-333333333333";
export const SLACK = "66666666-6666-4666-8666-666666666666";
export const EMAIL = "77777777-7777-4777-8777-777777777777";
export const FOREIGN_SLACK = "99999999-9999-4999-8999-999999999999";
export const SLACK_LINK = "https://hooks.slack.com/services/T000/B000/secret-token";
export const ADDRESS = "owner@example.com";
// A Tuesday, 12:00 UTC.
export const NOW = new Date("2026-10-06T12:00:00Z");

export interface StoredTask extends OwnScheduleRow {
  orgId: string;
  agentId: string | null;
  taskType: string;
  createdAt: Date;
}
export interface StoredRun extends RunRow {
  taskId: string;
  input: unknown;
}
export interface StoredChannel extends ReportChannel {
  orgId: string;
}

const unique = () =>
  Object.assign(new Error("Unique constraint failed"), { code: "P2002", meta: { target: ["org_id", "name"] } });

let serial = 0;
export function task(over: Partial<StoredTask> = {}): StoredTask {
  serial += 1;
  return {
    id: `00000000-0000-4000-8000-${String(serial).padStart(12, "0")}`,
    orgId: ORG,
    agentId: AGENT,
    name: `Task ${serial}`,
    taskType: "agent_run",
    isEnabled: true,
    status: "active",
    scheduleType: "cron",
    cronExpression: "0 9 * * *",
    intervalSeconds: null,
    scheduledAt: null,
    timezone: "UTC",
    payload: { prompt: "Brief me." },
    timeout: 300_000,
    maxRetries: 1,
    nextRunAt: new Date("2026-10-07T09:00:00Z"),
    lastRunAt: null,
    lastRunStatus: null,
    createdAt: new Date("2026-10-01T00:00:00Z"),
    ...over,
  };
}

export function run(taskId: string, over: Partial<StoredRun> = {}): StoredRun {
  serial += 1;
  return {
    id: `aaaaaaaa-0000-4000-8000-${String(serial).padStart(12, "0")}`,
    taskId,
    status: "success",
    startedAt: new Date("2026-10-05T09:00:00Z"),
    completedAt: new Date("2026-10-05T09:00:05Z"),
    durationMs: 5000,
    triggeredBy: "schedule",
    input: { prompt: "the stored input" },
    output: { content: "Today's briefing." },
    error: null,
    delivery: null,
    createdAt: new Date("2026-10-05T09:00:00Z"),
    ...over,
  };
}

export interface WorldSeed {
  tasks?: StoredTask[];
  runs?: StoredRun[];
  channels?: StoredChannel[];
  agents?: Array<{ id: string; orgId: string; name: string; kindConfig: unknown }>;
  emailConfigured?: boolean;
  schedulerRunning?: boolean;
}

export function fakeWorld(seed: WorldSeed = {}) {
  const state = {
    agents: seed.agents ?? [
      { id: AGENT, orgId: ORG, name: "Morning Brief", kindConfig: null as unknown },
      { id: SECOND_AGENT, orgId: ORG, name: "Second", kindConfig: null as unknown },
      { id: FOREIGN_AGENT, orgId: OTHER_ORG, name: "Theirs", kindConfig: null as unknown },
    ],
    tasks: seed.tasks ?? [],
    runs: seed.runs ?? [],
    channels: seed.channels ?? [
      { id: SLACK, orgId: ORG, name: "Team Slack", type: "slack", isEnabled: true, config: { webhookUrl: SLACK_LINK } },
      { id: EMAIL, orgId: ORG, name: "Email to me", type: "email", isEnabled: true, config: { emails: [ADDRESS] } },
      { id: FOREIGN_SLACK, orgId: OTHER_ORG, name: "Their Slack", type: "slack", isEnabled: true, config: { webhookUrl: SLACK_LINK } },
    ],
    emailConfigured: seed.emailConfigured ?? true,
    schedulerRunning: seed.schedulerRunning ?? true,
  };
  const writes: Array<{ op: string; args: unknown }> = [];
  const sends: Array<{ via: "channel" | "email"; channelId: string; message: ChannelMessage }> = [];
  const runNowCalls: Array<{ taskId: string; orgId: string }> = [];
  const hooks: {
    /** Runs once, just before the schedule's compare-and-set. */
    beforeUpdate?: () => void;
    /** What the place answers a send with. */
    send?: () => Promise<void>;
    /** What the Scheduler's "run now" does. */
    runNow?: (taskId: string, orgId: string) => Promise<{ execution: RunRow }>;
  } = {};

  const matches = (row: Record<string, unknown>, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, wanted]) => {
      if (wanted === undefined) return true;
      const actual = row[key];
      if (typeof wanted === "object" && wanted !== null && !(wanted instanceof Date)) {
        const filter = wanted as Record<string, unknown>;
        if ("startsWith" in filter) return typeof actual === "string" && actual.startsWith(filter.startsWith as string);
        if ("equals" in filter) return isDeepStrictEqual(actual, filter.equals);
        throw new Error(`the stand-in does not know the filter on ${key}`);
      }
      return actual === wanted;
    });
  const asRecord = (row: unknown) => row as Record<string, unknown>;

  const db: OwnScheduleDb = {
    scheduledTask: {
      findMany: async (args) => {
        let rows = state.tasks.filter((t) => matches(asRecord(t), args.where));
        if (args.orderBy) {
          rows = [...rows].sort(
            (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
          );
        }
        return rows.slice(0, args.take ?? rows.length).map((t) => ({ ...t }));
      },
      count: async (args) => state.tasks.filter((t) => matches(asRecord(t), args.where)).length,
      create: async (args) => {
        writes.push({ op: "create", args });
        if (state.tasks.some((t) => t.orgId === args.data.orgId && t.name === args.data.name)) throw unique();
        const row = task({
          ...args.data,
          intervalSeconds: null,
          scheduledAt: null,
          lastRunAt: null,
          lastRunStatus: null,
          createdAt: new Date(NOW),
        });
        state.tasks.push(row);
        return { ...row };
      },
      updateMany: async (args) => {
        hooks.beforeUpdate?.();
        hooks.beforeUpdate = undefined;
        const hit = state.tasks.filter((t) => matches(asRecord(t), args.where));
        if (hit.length > 0) writes.push({ op: "updateMany", args });
        for (const row of hit) Object.assign(row, args.data);
        return { count: hit.length };
      },
    },
    alertChannel: {
      findFirst: async (args) => {
        const found = state.channels.find((c) => c.id === args.where.id && c.orgId === args.where.orgId);
        return found ? { type: found.type } : null;
      },
    },
    taskExecution: {
      findMany: async () => {
        throw new Error("the public results are not read here");
      },
    },
  };

  const publicRun = (row: StoredRun): RunRow => {
    const { taskId: _taskId, input: _input, ...rest } = row;
    return { ...rest };
  };

  // One row lock per agent, and what each open transaction would be undone to.
  const held = new Map<string, Promise<void>>();
  const open = new WeakMap<object, { before: StoredTask[]; releases: Array<() => void> }>();
  const snapshot = () => state.tasks.map((t) => ({ ...t }));

  const deps: AgentScheduleDeps = {
    db,
    transaction: async (fn) => {
      // Its own object, so a lock knows which transaction holds it.
      const tx = Object.create(db) as OwnScheduleDb;
      const ctx = { before: snapshot(), releases: [] as Array<() => void> };
      open.set(tx, ctx);
      try {
        return await fn(tx);
      } catch (err) {
        state.tasks = ctx.before;
        throw err;
      } finally {
        for (const release of ctx.releases) release();
      }
    },
    lockAgent: async (tx, { orgId, agentId }) => {
      const ctx = open.get(tx as object);
      if (!ctx) throw new Error("an agent's row is locked inside a transaction only");
      while (held.has(agentId)) await held.get(agentId);
      let release!: () => void;
      held.set(
        agentId,
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      ctx.releases.push(() => {
        held.delete(agentId);
        release();
      });
      // What this transaction sees, and would be undone to, starts here.
      ctx.before = snapshot();
      const agent = state.agents.find((a) => a.id === agentId && a.orgId === orgId);
      return agent ? { name: agent.name } : null;
    },
    loadAgent: async ({ orgId, agentId }) => {
      const agent = state.agents.find((a) => a.id === agentId && a.orgId === orgId);
      return agent ? { id: agent.id, name: agent.name, kindConfig: agent.kindConfig } : null;
    },
    loadPlace: async (channelId, orgId) => {
      const place = state.channels.find((c) => c.id === channelId && c.orgId === orgId);
      return place ? { id: place.id, name: place.name, type: place.type } : null;
    },
    runs: {
      list: async ({ taskId, limit, before }) => {
        const rows = state.runs
          .filter((r) => r.taskId === taskId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1));
        const from = before ? rows.findIndex((r) => r.id === before) + 1 : 0;
        return rows.slice(from, from + limit).map(publicRun);
      },
      find: async ({ taskId, runId }) => {
        const found = state.runs.find((r) => r.id === runId && r.taskId === taskId);
        return found ? publicRun(found) : null;
      },
      appendDelivery: async ({ taskId, runId, records }) => {
        const found = state.runs.find((r) => r.id === runId && r.taskId === taskId && r.status === "success");
        if (!found) return false;
        writes.push({ op: "appendDelivery", args: { taskId, runId, records } });
        found.delivery = [...(Array.isArray(found.delivery) ? (found.delivery as DeliveryRecord[]) : []), ...records];
        return true;
      },
    },
    runNow: async (taskId, orgId) => {
      runNowCalls.push({ taskId, orgId });
      if (hooks.runNow) return hooks.runNow(taskId, orgId);
      const made = run(taskId, { triggeredBy: "manual", createdAt: new Date(NOW), startedAt: new Date(NOW) });
      state.runs.push(made);
      return { execution: publicRun(made) };
    },
    schedulerRunning: () => state.schedulerRunning,
    emailConfigured: () => state.emailConfigured,
    delivery: () => ({
      loadAlertChannel: async (channelId, orgId) => {
        const found = state.channels.find((c) => c.id === channelId && c.orgId === orgId);
        return found ? { id: found.id, name: found.name, type: found.type, isEnabled: found.isEnabled, config: found.config } : null;
      },
      emailConfigured: () => state.emailConfigured,
      sendToChannel: async (channel, message) => {
        sends.push({ via: "channel", channelId: channel.id, message });
        await hooks.send?.();
      },
      sendEmail: async (channel, message) => {
        sends.push({ via: "email", channelId: channel.id, message });
        await hooks.send?.();
      },
      now: () => NOW,
    }),
    now: () => NOW,
  };

  return { deps, state, writes, sends, runNowCalls, hooks };
}
