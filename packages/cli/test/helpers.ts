import { WheelsAI } from "@wheelsai/sdk";
import type { Agent, AgentDeployment, GpuTier } from "@wheelsai/sdk";

import { Reporter } from "../src/ui.js";

/** A Reporter that prints nothing and keeps every line it was given, so tests can assert on them. */
export class RecordingReporter extends Reporter {
  readonly lines: Array<{ kind: "start" | "update" | "succeed" | "warn" | "fail" | "info"; text: string }> = [];

  constructor() {
    super(true);
  }

  /** The recorded text of one kind, colours removed. */
  texts(kind: RecordingReporter["lines"][number]["kind"]): string[] {
    // eslint-disable-next-line no-control-regex
    return this.lines.filter((line) => line.kind === kind).map((line) => line.text.replace(/\u001b\[[0-9;]*m/g, ""));
  }

  override start(text: string): void {
    this.lines.push({ kind: "start", text });
  }
  override update(text: string): void {
    this.lines.push({ kind: "update", text });
  }
  override succeed(text: string): void {
    this.lines.push({ kind: "succeed", text });
  }
  override warn(text: string): void {
    this.lines.push({ kind: "warn", text });
  }
  override fail(text: string): void {
    this.lines.push({ kind: "fail", text });
  }
  override info(text: string): void {
    this.lines.push({ kind: "info", text });
  }
}

export interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  authorization: string | null;
}

/** A reply: a bare value is a 200 JSON body; `status(code, body)` picks the status. */
export interface Reply {
  status: number;
  body: unknown;
}
export const status = (code: number, body: unknown): Reply => ({ status: code, body });
const isReply = (value: unknown): value is Reply =>
  typeof value === "object" && value !== null && "status" in value && "body" in value && Object.keys(value).length === 2;

export type Route = unknown | ((call: Call) => unknown);

/**
 * An in-memory API. Routes are keyed `"METHOD /path/:param"`; the value is a body,
 * a `status(...)`, or a function of the call returning either. Unrouted requests
 * answer 404 and are recorded, so a test also notices requests it did not expect.
 */
export function fakeApi(routes: Record<string, Route>, options: { apiKey?: string; token?: string } = {}) {
  const calls: Call[] = [];
  const compiled = Object.entries(routes).map(([key, route]) => {
    const [method, pattern] = key.split(" ") as [string, string];
    const regex = new RegExp(`^${pattern.replace(/:[A-Za-z]+/g, "[^/]+")}$`);
    return { method, regex, route };
  });

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const rawBody = typeof init?.body === "string" ? init.body : undefined;
    const call: Call = {
      method: init?.method ?? "GET",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body: rawBody === undefined ? undefined : JSON.parse(rawBody),
      authorization: new Headers(init?.headers).get("authorization"),
    };
    calls.push(call);

    const match = compiled.find((candidate) => candidate.method === call.method && candidate.regex.test(call.path));
    if (!match) {
      return new Response(JSON.stringify({ error: "NotFound", message: `no route for ${call.method} ${call.path}` }), { status: 404 });
    }
    const produced = typeof match.route === "function" ? (match.route as (call: Call) => unknown)(call) : match.route;
    const reply = isReply(produced) ? produced : { status: 200, body: produced };
    return new Response(reply.status === 204 ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  };

  const wheels = new WheelsAI({
    baseUrl: "https://api.example.test",
    apiKey: options.apiKey ?? "wheels_live_test",
    token: options.token,
    fetch,
  });
  return { wheels, calls, requested: (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path) };
}

/** Replies in order, repeating the last one: a scripted sequence of statuses. */
export function sequence<T>(...replies: T[]): () => T {
  let index = 0;
  return () => replies[Math.min(index++, replies.length - 1)] as T;
}

export const AGENT_ID = "11111111-1111-4111-8111-111111111111";
export const DEPLOYMENT_ID = "22222222-2222-4222-8222-222222222222";

export function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: AGENT_ID,
    name: "My Support Bot",
    slug: "my-support-bot",
    description: "Answers customer support questions about orders and refunds.",
    framework: "custom",
    version: "1.0.0",
    tags: [],
    isPublic: false,
    latestDeployment: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

export function deployment(overrides: Partial<AgentDeployment> = {}): AgentDeployment {
  return {
    id: DEPLOYMENT_ID,
    agentId: AGENT_ID,
    gpuTier: "3060",
    replicas: 1,
    status: "pending",
    endpoint: null,
    modelDeploymentId: null,
    externalModelUrl: null,
    nosanaJobIds: [],
    walletId: null,
    buildLogs: null,
    lastError: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    stoppedAt: null,
    ...overrides,
  };
}

export const TIERS: GpuTier[] = [
  { id: "4090", name: "NVIDIA 4090", vram: 24, pricePerHour: 0.55 },
  { id: "3060", name: "NVIDIA 3060", vram: 12, pricePerHour: 0.2 },
];

/** A clock that only moves when the code sleeps, so polling tests take no real time. */
export function fakeClock() {
  let now = 0;
  const sleeps: number[] = [];
  return {
    /** Every sleep asked for, in order. */
    sleeps,
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}
