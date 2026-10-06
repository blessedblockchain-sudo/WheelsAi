import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";

import { abortOnClientClose } from "../services/chatStreamSettlement.js";
import type { ChatStream, StreamOutcome } from "../services/mastra-runtime.js";
import { sseHeaders, streamToReply, type StreamToReplyOptions } from "../services/sseReply.js";

// services/sseReply.ts against a real Fastify instance with the real
// @fastify/cors. The bug it fixes was live: the playground always streams,
// and its streamed responses carried no Access-Control-Allow-Origin, so the
// dashboard could not read them whenever web and API were on different
// origins.

const ORIGIN = "http://localhost:3000";
const enc = new TextEncoder();

function chatOf(frames: string[], outcome: StreamOutcome): ChatStream {
  return {
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(enc.encode(frame));
        controller.close();
      },
    }),
    outcome: Promise.resolve(outcome),
  };
}

const OK: StreamOutcome = { ok: true, usage: null, toolCalls: [] };

function meterSpy() {
  const calls: string[] = [];
  return {
    calls,
    meter: {
      settle: async () => void calls.push("settle"),
      refund: async (reason: string) => void calls.push(`refund:${reason}`),
    },
  };
}

async function appWith(
  handler: (app: FastifyInstance) => void,
): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(cors, { origin: ORIGIN, credentials: true });
  handler(app);
  await app.ready();
  return app;
}

test("streamed responses keep CORS, X-Request-Id and rate-limit headers (Fastify inject with @fastify/cors)", async () => {
  const spy = meterSpy();
  const app = await appWith((instance) => {
    instance.post("/chat", async (request, reply) => {
      const abort = abortOnClientClose(reply.raw);
      reply.header("X-Request-Id", "req-123");
      reply.header("X-RateLimit-Remaining-RPM", 19);
      reply.header("x-ratelimit-remaining-requests", "19");
      const sent = await streamToReply(
        reply,
        chatOf(['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', "data: [DONE]\n\n"], OK),
        { meter: spy.meter, abort },
      );
      assert.ok(sent.started && sent.outcome.ok);
    });
  });

  const res = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { origin: ORIGIN },
    payload: {},
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["access-control-allow-origin"], ORIGIN, "the browser may read the stream");
  assert.equal(res.headers["access-control-allow-credentials"], "true");
  assert.equal(res.headers["x-request-id"], "req-123");
  assert.equal(res.headers["x-ratelimit-remaining-rpm"], "19");
  assert.equal(res.headers["x-ratelimit-remaining-requests"], "19");
  assert.match(String(res.headers["content-type"]), /^text\/event-stream/);
  assert.equal(res.headers["cache-control"], "no-cache");
  assert.equal(res.headers["x-accel-buffering"], "no");
  assert.equal(res.body, 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n');
  assert.deepEqual(spy.calls, ["settle"], "a delivered answer settles");
  await app.close();
});

test("headers computed for another body are not forwarded onto the stream", async () => {
  const app = await appWith((instance) => {
    instance.get("/h", async (_request, reply) => {
      reply.header("content-length", 2);
      reply.header("content-type", "application/json");
      reply.header("x-kept", "yes");
      return sseHeaders(reply);
    });
  });
  const headers = (await app.inject({ method: "GET", url: "/h" })).json() as Record<string, string>;
  assert.equal(headers["content-length"], undefined);
  assert.equal(headers["content-type"], undefined);
  assert.equal(headers["Content-Type"], "text/event-stream");
  assert.equal(headers["x-kept"], "yes");
  await app.close();
});

test("a transform is applied before bytes reach the socket", async () => {
  const spy = meterSpy();
  const app = await appWith((instance) => {
    instance.post("/chat", async (_request, reply) => {
      const abort = abortOnClientClose(reply.raw);
      const transform: StreamToReplyOptions["transform"] = (chat) => ({
        outcome: chat.outcome,
        stream: chat.stream.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              controller.enqueue(enc.encode(new TextDecoder().decode(chunk).replace("PROVIDER", "agent/bot")));
            },
          }),
        ),
      });
      await streamToReply(reply, chatOf(['data: {"model":"PROVIDER"}\n\n'], OK), {
        meter: spy.meter,
        abort,
        transform,
      });
    });
  });
  const res = await app.inject({ method: "POST", url: "/chat", payload: {} });
  assert.equal(res.body, 'data: {"model":"agent/bot"}\n\n');
  assert.ok(!res.body.includes("PROVIDER"));
  await app.close();
});

test("a stream whose outcome is a failure refunds, even though bytes were delivered", async () => {
  const spy = meterSpy();
  const app = await appWith((instance) => {
    instance.post("/chat", async (_request, reply) => {
      const abort = abortOnClientClose(reply.raw);
      const sent = await streamToReply(
        reply,
        chatOf(['data: {"error":{"message":"upstream overloaded"}}\n\n'], {
          ok: false,
          error: "upstream overloaded",
          toolCalls: [],
          code: "provider_error",
        }),
        { meter: spy.meter, abort },
      );
      assert.ok(sent.started && !sent.outcome.ok);
    });
  });
  await app.inject({ method: "POST", url: "/chat", payload: {} });
  assert.deepEqual(spy.calls, ["refund:upstream overloaded"]);
  await app.close();
});

test("a client that is already gone gets nothing written, the stream cancelled and the charge refunded", async () => {
  const spy = meterSpy();
  let cancelled = false;
  let started: boolean | null = null;
  const app = await appWith((instance) => {
    instance.post("/chat", async (_request, reply) => {
      const abort = new AbortController();
      abort.abort();
      const chat: ChatStream = {
        stream: new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true;
          },
        }),
        outcome: Promise.resolve(OK),
      };
      const sent = await streamToReply(reply, chat, { meter: spy.meter, abort });
      started = sent.started;
      return reply.status(499).send({ error: "ClientClosedRequest" });
    });
  });
  const res = await app.inject({ method: "POST", url: "/chat", payload: {} });
  assert.equal(res.statusCode, 499);
  assert.equal(started, false);
  assert.equal(cancelled, true);
  assert.equal(spy.calls.length, 1);
  assert.match(spy.calls[0]!, /^refund:client disconnected/);
  await app.close();
});

test("a client that closes before delivery is refunded", async () => {
  // A real socket: only a real one can be closed by its client mid-stream.
  const spy = meterSpy();
  let finished!: (outcome: StreamOutcome) => void;
  const done = new Promise<StreamOutcome>((resolve) => {
    finished = resolve;
  });
  let firstChunkSent!: () => void;
  const firstChunk = new Promise<void>((resolve) => {
    firstChunkSent = resolve;
  });

  const app = await appWith((instance) => {
    instance.post("/chat", async (_request, reply) => {
      const abort = abortOnClientClose(reply.raw);
      let resolveOutcome!: (o: StreamOutcome) => void;
      const outcome = new Promise<StreamOutcome>((resolve) => {
        resolveOutcome = resolve;
      });
      // A provider that would have finished fine - but only after the
      // client has already hung up.
      const chat: ChatStream = {
        stream: new ReadableStream<Uint8Array>({
          async pull(controller) {
            controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"par"}}]}\n\n'));
            firstChunkSent();
            await new Promise<void>((resolve) => abort.signal.addEventListener("abort", () => resolve(), { once: true }));
            controller.enqueue(enc.encode("data: [DONE]\n\n"));
            resolveOutcome(OK);
            controller.close();
          },
        }),
        outcome,
      };
      const sent = await streamToReply(reply, chat, { meter: spy.meter, abort, deliveryTimeoutMs: 200 });
      assert.ok(sent.started);
      finished(sent.outcome);
    });
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;

  const request = http.request({ host: "127.0.0.1", port, path: "/chat", method: "POST" }, (response) => {
    response.once("data", () => request.destroy());
    response.on("error", () => {});
  });
  request.on("error", () => {});
  request.end();

  await firstChunk;
  const outcome = await done;
  assert.equal(outcome.ok, false, "the provider finished, but nobody received it");
  assert.equal(spy.calls.length, 1);
  assert.match(spy.calls[0]!, /^refund:client disconnected/);
  await app.close();
});

test("a heartbeat keeps a quiet stream alive with SSE comments", async () => {
  const app = await appWith((instance) => {
    instance.post("/chat", async (_request, reply) => {
      const abort = abortOnClientClose(reply.raw);
      const chat: ChatStream = {
        stream: new ReadableStream<Uint8Array>({
          async start(controller) {
            await new Promise((resolve) => setTimeout(resolve, 60));
            controller.enqueue(enc.encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
        outcome: Promise.resolve(OK),
      };
      await streamToReply(reply, chat, { meter: null, abort, heartbeatMs: 10 });
    });
  });
  const res = await app.inject({ method: "POST", url: "/chat", payload: {} });
  assert.match(res.body, /^(: keep-alive\n\n)+data: \[DONE\]\n\n$/);
  await app.close();
});
