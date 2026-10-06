import assert from "node:assert/strict";
import test from "node:test";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}
setupEnv();

import type { ChatStream, StreamOutcome } from "../services/mastra-runtime.js";

// Drives services/chatStreamSettlement.ts - the playground's streaming
// billing decision. The bug it fixes: the route settled the marketplace
// charge as soon as the byte loop finished, so a stream that carried a
// provider error (an HTTP 200 stream can embed one) or no answer at all was
// still billed to the buyer and paid out to the publisher.

const enc = new TextEncoder();

function makeMeter() {
  const calls: string[] = [];
  return {
    calls,
    meter: {
      settle: async () => {
        calls.push("settle");
      },
      refund: async (reason: string) => {
        calls.push(`refund:${reason}`);
      },
    },
  };
}

function fakeChat(chunks: string[], outcome: StreamOutcome): ChatStream {
  let resolve!: (o: StreamOutcome) => void;
  const promise = new Promise<StreamOutcome>((r) => (resolve = r));
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(enc.encode(chunks[i++]!));
      } else {
        resolve(outcome);
        controller.close();
      }
    },
    cancel() {
      resolve({ ok: false, error: "client disconnected before the answer finished", toolCalls: [] });
    },
  });
  return { stream, outcome: promise };
}

test("a real answer settles the charge and never refunds", async () => {
  const { forwardAndSettle } = await import("../services/chatStreamSettlement.js");
  const { meter, calls } = makeMeter();
  const written: string[] = [];
  let ended = false;
  const outcome = await forwardAndSettle({
    chat: fakeChat(["a", "b"], { ok: true, usage: null, toolCalls: [] }),
    write: (c) => written.push(new TextDecoder().decode(c)),
    end: () => {
      ended = true;
      assert.deepEqual(calls, [], "the client response ends BEFORE billing runs");
    },
    meter,
  });
  assert.equal(outcome.ok, true);
  assert.deepEqual(written, ["a", "b"]);
  assert.equal(ended, true);
  assert.deepEqual(calls, ["settle"]);
});

test("a stream that failed refunds with the reason and never settles", async () => {
  const { forwardAndSettle } = await import("../services/chatStreamSettlement.js");
  const { meter, calls } = makeMeter();
  await forwardAndSettle({
    chat: fakeChat(["partial"], { ok: false, error: "upstream overloaded", toolCalls: [] }),
    write: () => {},
    end: () => {},
    meter,
  });
  assert.deepEqual(calls, ["refund:upstream overloaded"]);
});

test("a client that stops reading mid-stream is refunded", async () => {
  const { forwardAndSettle } = await import("../services/chatStreamSettlement.js");
  const { meter, calls } = makeMeter();
  await forwardAndSettle({
    chat: fakeChat(["a", "b", "c"], { ok: true, usage: null, toolCalls: [] }),
    write: () => {
      throw new Error("write after end");
    },
    end: () => {},
    meter,
  });
  assert.deepEqual(calls, ["refund:client disconnected before the answer finished"]);
});

test("a stream that errors out is refunded, not thrown into the route", async () => {
  const { forwardAndSettle } = await import("../services/chatStreamSettlement.js");
  const { meter, calls } = makeMeter();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new Error("boom"));
    },
  });
  await forwardAndSettle({
    chat: { stream, outcome: Promise.resolve({ ok: false, error: "boom", toolCalls: [] }) },
    write: () => {},
    end: () => {},
    meter,
  });
  assert.deepEqual(calls, ["refund:boom"]);
});

test("unmetered chats (no marketplace install) pass through untouched", async () => {
  const { forwardAndSettle } = await import("../services/chatStreamSettlement.js");
  const outcome = await forwardAndSettle({
    chat: fakeChat(["x"], { ok: true, usage: null, toolCalls: [] }),
    write: () => {},
    end: () => {},
    meter: null,
  });
  assert.equal(outcome.ok, true);
});

test("END TO END: a provider error event inside a 200 stream refunds instead of settling", async () => {
  const { forwardAndSettle } = await import("../services/chatStreamSettlement.js");
  const { runChatStream } = await import("../services/mastra-runtime.js");
  const { meter, calls } = makeMeter();

  const events = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: "Par" } }] })}\n\n`,
    `data: ${JSON.stringify({ error: { message: "rate limit exceeded" } })}\n\n`,
  ];
  const fetchImpl = (async () =>
    new Response(
      new ReadableStream({
        start(c) {
          for (const e of events) c.enqueue(enc.encode(e));
          c.close();
        },
      }),
      { status: 200 },
    )) as unknown as typeof fetch;

  const chat = await runChatStream(
    { apiKey: "k", baseUrl: "https://p.example/v1", modelName: "m" },
    { name: "a", tools: [], modelConfig: { temperature: 0.1, maxTokens: 10 } },
    [{ role: "user", content: "hi" }],
    { fetchImpl },
  );
  const written: string[] = [];
  await forwardAndSettle({
    chat,
    write: (c) => written.push(new TextDecoder().decode(c)),
    end: () => {},
    meter,
  });
  assert.match(written.join(""), /rate limit exceeded/, "the client still sees the error");
  assert.deepEqual(calls, ["refund:rate limit exceeded"]);
});

test("END TO END: a completed stream settles", async () => {
  const { forwardAndSettle } = await import("../services/chatStreamSettlement.js");
  const { runChatStream } = await import("../services/mastra-runtime.js");
  const { meter, calls } = makeMeter();

  const events = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: "All good" }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  ];
  const fetchImpl = (async () =>
    new Response(
      new ReadableStream({
        start(c) {
          for (const e of events) c.enqueue(enc.encode(e));
          c.close();
        },
      }),
      { status: 200 },
    )) as unknown as typeof fetch;

  const chat = await runChatStream(
    { apiKey: "k", baseUrl: "https://p.example/v1", modelName: "m" },
    { name: "a", tools: [], modelConfig: { temperature: 0.1, maxTokens: 10 } },
    [{ role: "user", content: "hi" }],
    { fetchImpl },
  );
  await forwardAndSettle({ chat, write: () => {}, end: () => {}, meter });
  assert.deepEqual(calls, ["settle"]);
});

// ============================================
// Delivery: a finished answer that never reached the client is not billable
// ============================================

test("a finished answer that was NOT delivered (client left) is refunded, not settled", async () => {
  const { forwardAndSettle } = await import("../services/chatStreamSettlement.js");
  const { meter, calls } = makeMeter();
  const outcome = await forwardAndSettle({
    // The provider/tool loop completed fine, and write() on the closed socket
    // returned false without throwing - so the byte loop saw nothing wrong.
    chat: fakeChat(["whole answer"], { ok: true, usage: null, toolCalls: [] }),
    write: () => {},
    end: () => {},
    delivered: () => false,
    meter,
  });
  assert.equal(outcome.ok, false);
  assert.deepEqual(calls, ["refund:client disconnected before the answer was delivered"]);
});

test("delivered may be async, is asked AFTER the stream ended, and true settles", async () => {
  const { forwardAndSettle } = await import("../services/chatStreamSettlement.js");
  const { meter, calls } = makeMeter();
  let askedAfterEnd = false;
  let ended = false;
  await forwardAndSettle({
    chat: fakeChat(["x"], { ok: true, usage: null, toolCalls: [] }),
    write: () => {},
    end: () => {
      ended = true;
    },
    delivered: async () => {
      askedAfterEnd = ended;
      await new Promise((r) => setTimeout(r, 1));
      return true;
    },
    meter,
  });
  assert.equal(askedAfterEnd, true);
  assert.deepEqual(calls, ["settle"]);
});

test("a failed outcome is refunded with ITS reason, and delivery is not consulted", async () => {
  const { forwardAndSettle } = await import("../services/chatStreamSettlement.js");
  const { meter, calls } = makeMeter();
  let asked = false;
  await forwardAndSettle({
    chat: fakeChat(["x"], { ok: false, error: "upstream overloaded", toolCalls: [] }),
    write: () => {},
    end: () => {},
    delivered: () => {
      asked = true;
      return true;
    },
    meter,
  });
  assert.equal(asked, false);
  assert.deepEqual(calls, ["refund:upstream overloaded"]);
});

// ============================================
// Wiring pins: the route must actually pass delivery, mode and signal
// ============================================

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relative: string) => readFileSync(path.join(SRC, relative), "utf8");

test("the playground streams with a delivery check, a resolved tool mode and an abort signal", () => {
  const playground = source("routes/playground.ts");
  const agentChat = source("services/agentChat.ts");
  const sseReply = source("services/sseReply.ts");

  // The delivery watch and the disconnect signal live in
  // chatStreamSettlement.ts (driven against a real socket below). The stream
  // is written by sseReply.ts, which must wire the watch before its first
  // write and hand it to the settlement.
  assert.match(sseReply, /const delivered = watchDelivery\(reply\.raw, abort\.signal, options\.deliveryTimeoutMs\)/);
  assert.match(sseReply, /\n\s+delivered,\n/, "billing must consult delivery");
  assert.ok(
    sseReply.indexOf("const delivered = watchDelivery(") < sseReply.indexOf("reply.raw.writeHead("),
    "delivery is watched before the first byte",
  );
  assert.match(sseReply, /\.\.\.headers,\n\s+"Content-Type": "text\/event-stream"/, "headers already set go out with the stream");

  // The route wires the disconnect signal before its first await and passes
  // it into the service...
  assert.ok(
    playground.indexOf("abortOnClientClose(reply.raw)") < playground.indexOf("await prepareAgentChat("),
    "the disconnect signal is wired before the handler's first await",
  );
  assert.match(playground, /signal: abort\.signal/);
  assert.match(playground, /streamToReply\(reply, started\.chat, \{ meter: session\.meter, abort \}\)/);

  // The /v1 agent route makes the same three promises.
  const v1 = source("routes/agentCompletions.ts");
  assert.ok(
    v1.indexOf("abortOnClientClose(reply.raw)") < v1.indexOf("await prepareAgentChat("),
    "the /v1 abort is wired before the first await too",
  );
  assert.match(v1, /signal: abort\.signal/);
  assert.match(v1, /source: "api"/);
  assert.match(v1, /streamToReply\(reply, started\.chat, \{\n\s+meter: session\.meter,\n\s+abort,/);

  // ...and the service turns a client that already left away before it is
  // charged, runs every chat under that signal, and resolves the tool mode.
  // (`clientSignal` is the caller's own signal; the run's `signal` also fires
  // on shutdown, which is not the client leaving.)
  const preCharge = 'if (clientSignal.aborted) return refuse({ kind: "client_gone" });';
  assert.ok(agentChat.indexOf(preCharge) > 0, "the pre-charge disconnect check exists");
  assert.ok(
    agentChat.indexOf(preCharge) < agentChat.indexOf("await deps.beginMetering("),
    "a client that already left is turned away before it is charged",
  );
  // A chat is registered for shutdown before it is charged, as a graph run is.
  assert.ok(
    agentChat.indexOf("deps.beginRun ? deps.beginRun() : undefined") < agentChat.indexOf("await deps.beginMetering("),
    "a chat is registered for shutdown before it is charged",
  );
  assert.match(agentChat, /if \(slot === null\) return refuse\(\{ kind: "shutting_down" \}\)/);
  assert.match(agentChat, /deps\.resolveToolMode\(\{ agentId, orgId, base: TOOL_MODE_BASE\[input\.source\] \}\)/);
  assert.match(agentChat, /playground: "playground",/);
  assert.match(agentChat, /mode: toolMode,\n\s+signal,/);
  assert.match(source("services/buildAgentChatDeps.ts"), /resolveToolMode: \(args\) => resolveToolMode\(args\)/);

  const settlement = source("services/chatStreamSettlement.ts");
  assert.match(settlement, /res\.once\("finish"/);
  assert.match(settlement, /if \(res\.destroyed\) abort\.abort\(\)/);
  // The pre-existing pins the marketplace wiring test relies on still hold.
  assert.match(agentChat, /meter\?\.settle\(\)/);
  assert.match(agentChat, /meter\?\.refund\(/);
});

test("graph runs are cancelled when the client closes the request, and resolve their tool mode", () => {
  const route = source("routes/agentGraph.ts");
  assert.match(route, /const abort = abortOnClientClose\(reply\.raw\)/);
  assert.ok(
    route.indexOf("if (abort.signal.aborted)") < route.indexOf("await runAgentGraph("),
    "a client that already left never starts (or pays for) a run",
  );
  // ...and when the process shuts down (services/inFlightRuns.ts).
  assert.match(route, /ServerShuttingDownError/);
  assert.match(route, /runAgentGraph\(agentId, orgId, input, \{ signal: abort\.signal \}\)/);

  const run = source("services/runAgentGraph.ts");
  assert.match(run, /resolveToolMode\(\{ agentId, orgId, base: "graph" \}\)/);
  assert.match(run, /signal: options\.signal/);
  assert.ok(
    run.indexOf("inFlightGraphRuns.begin()") < run.indexOf("beginMarketplaceMetering("),
    "a run is registered for shutdown before it is charged",
  );
  // Shutdown cancels graph runs and agent chats together, and waits for both
  // before the queue drain eats the kill window.
  const index = source("index.ts");
  assert.match(
    index,
    /await Promise\.all\(\[\n\s+cancelInFlightGraphRuns\(GRAPH_RUN_DRAIN_MS\),\n\s+cancelInFlightAgentChats\(GRAPH_RUN_DRAIN_MS\),\n\s+\]\)/,
  );
  assert.ok(
    index.indexOf("cancelInFlightAgentChats(GRAPH_RUN_DRAIN_MS)") < index.indexOf("await stopX402Queue()"),
    "in-flight chats are cancelled first, not after the queues have drained",
  );
});

test("scheduled and orchestration runs resolve their tool mode; the test runner runs in 'test' mode", () => {
  // The call itself moved into sharedAgentChat.ts (a pure core); the
  // production executor binds the real install lookup into it.
  const executor = source("services/scheduledTaskExecutorProduction.ts");
  assert.match(executor, /import \{ resolveToolMode \} from "\.\/skills\/runMode\.js"/);
  assert.match(executor, /\n\s+resolveToolMode,\n/);
  const shared = source("services/sharedAgentChat.ts");
  assert.match(shared, /await seams\.resolveToolMode\(/);
  assert.match(shared, /mode: toolMode/);
  assert.match(source("services/testing.ts"), /runAgentChat\(\{ agent, prompt, mode: "test" \}\)/);
});

// ============================================
// Clients that are already gone
// ============================================
//
// `close` fires once. A client that hangs up while an earlier hook is still
// awaiting (auth, rate limit) has had its `close` before the route handler
// attaches a listener: the run carried on, the 5s delivery fallback answered
// "delivered", and the buyer was billed for an answer of which 0 bytes
// arrived. These drive a REAL http.ServerResponse through that ordering.

import { createServer, request as httpRequest, type ServerResponse } from "node:http";

/**
 * Serves one request and hands the test its ServerResponse. `leaveEarly`
 * destroys the client socket and waits for the server to notice BEFORE the
 * handler body runs, like a hang-up during an earlier async hook.
 */
async function withResponse<T>(
  leaveEarly: boolean,
  handler: (res: ServerResponse) => Promise<T>,
): Promise<T> {
  let done!: (value: T) => void;
  let fail!: (err: unknown) => void;
  const result = new Promise<T>((resolve, reject) => {
    done = resolve;
    fail = reject;
  });
  const server = createServer((_req, res) => {
    void (async () => {
      if (leaveEarly) {
        const closed = new Promise<void>((resolve) => res.once("close", () => resolve()));
        client.destroy();
        await closed;
      }
      return handler(res);
    })().then(done, fail);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const client = httpRequest({ host: "127.0.0.1", port, method: "POST", agent: false });
  client.on("error", () => {});
  client.on("response", (res) => res.resume());
  client.end("{}");
  try {
    return await result;
  } finally {
    client.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("a late `close` listener alone never fires: the bug this guards against", async () => {
  const fired = await withResponse(true, async (res) => {
    let saw = false;
    res.on("close", () => {
      saw = true;
    });
    await new Promise((r) => setTimeout(r, 30));
    return saw;
  });
  assert.equal(fired, false);
});

test("abortOnClientClose is already aborted for a client that left before the handler ran", async () => {
  const { abortOnClientClose } = await import("../services/chatStreamSettlement.js");
  const aborted = await withResponse(true, async (res) => abortOnClientClose(res).signal.aborted);
  assert.equal(aborted, true);
});

test("abortOnClientClose stays quiet for a connected client, then aborts when it leaves mid-run", async () => {
  const { abortOnClientClose } = await import("../services/chatStreamSettlement.js");
  const seen = await withResponse(false, async (res) => {
    const abort = abortOnClientClose(res);
    const before = abort.signal.aborted;
    const gone = new Promise<void>((resolve) =>
      abort.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    res.socket!.destroy();
    await gone;
    return { before, after: abort.signal.aborted };
  });
  assert.deepEqual(seen, { before: false, after: true });
});

test("abortOnClientClose does not abort after a response that completed normally", async () => {
  const { abortOnClientClose } = await import("../services/chatStreamSettlement.js");
  const aborted = await withResponse(false, async (res) => {
    const abort = abortOnClientClose(res);
    const closed = new Promise<void>((resolve) => res.once("close", () => resolve()));
    res.end("ok");
    await closed;
    return abort.signal.aborted;
  });
  assert.equal(aborted, false);
});

test("a client gone BEFORE the handler is refunded, not billed as delivered (0 bytes reached it)", async () => {
  const { abortOnClientClose, forwardAndSettle, watchDelivery } = await import(
    "../services/chatStreamSettlement.js"
  );
  // Both halves are exercised separately: the delivery watch must say "not
  // delivered" by itself, even handed a signal that never aborts (the old
  // route's late listener), and not by way of its timeout.
  for (const lateListener of [true, false]) {
    const { calls, meter } = makeMeter();
    const started = Date.now();
    const outcome = await withResponse(true, async (res) => {
      const signal = lateListener ? new AbortController().signal : abortOnClientClose(res).signal;
      const delivered = watchDelivery(res, signal, 2_000);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      return forwardAndSettle({
        chat: fakeChat(["data: hello\n\n"], { ok: true, usage: null, toolCalls: [] }),
        write: (chunk) => void res.write(chunk),
        end: () => void res.end(),
        delivered,
        meter,
      });
    });
    assert.equal(outcome.ok, false);
    assert.deepEqual(calls, ["refund:client disconnected before the answer was delivered"]);
    assert.ok(Date.now() - started < 1_500, "decided up front, not by the timeout");
  }
});

test("a connected client that reads the whole stream is billed", async () => {
  const { abortOnClientClose, forwardAndSettle, watchDelivery } = await import(
    "../services/chatStreamSettlement.js"
  );
  const { calls, meter } = makeMeter();
  const outcome = await withResponse(false, async (res) => {
    const abort = abortOnClientClose(res);
    const delivered = watchDelivery(res, abort.signal, 2_000);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    return forwardAndSettle({
      chat: fakeChat(["data: hello\n\n"], { ok: true, usage: null, toolCalls: [] }),
      write: (chunk) => void res.write(chunk),
      end: () => void res.end(),
      delivered,
      meter,
    });
  });
  assert.equal(outcome.ok, true);
  assert.deepEqual(calls, ["settle"]);
});

test("a client that leaves mid-stream is refunded", async () => {
  const { abortOnClientClose, forwardAndSettle, watchDelivery } = await import(
    "../services/chatStreamSettlement.js"
  );
  const { calls, meter } = makeMeter();
  await withResponse(false, async (res) => {
    const abort = abortOnClientClose(res);
    const delivered = watchDelivery(res, abort.signal, 2_000);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    let wrote = 0;
    return forwardAndSettle({
      chat: fakeChat(["data: a\n\n", "data: b\n\n"], { ok: true, usage: null, toolCalls: [] }),
      write: (chunk) => {
        res.write(chunk);
        if (++wrote === 1) res.socket?.destroy();
      },
      end: () => void res.end(),
      delivered,
      meter,
    });
  });
  assert.deepEqual(calls, ["refund:client disconnected before the answer was delivered"]);
});
