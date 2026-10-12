/**
 * The door's tests. A fake API on an ephemeral loopback port records what
 * reaches it; the door listens on another. Nothing leaves the machine.
 *
 *   unshare -r -n sh -c 'ip link set lo up; node --test infra/gpu-door/door.test.mjs'
 *
 * Name the file: Node 22 takes a bare folder for a module and fails before any test.
 */

import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { after, describe, it } from "node:test";

import {
  ADAPTER_TARGET,
  DEFAULT_BURST,
  DEFAULT_MAX_IN_FLIGHT,
  DEFAULT_PORT,
  DEFAULT_RATE_PER_SECOND,
  DEFAULT_SOURCE_ADDRESS,
  DEFAULT_UPSTREAM,
  EVENTS_TARGET,
  MAX_EVENT_BYTES,
  createDoor,
  logPath,
  parseSourceAddress,
  parseUpstream,
  settingsFromEnv,
} from "./door.mjs";

const JOB = "3f0e7a52-9c41-4d7b-8a16-0b5d2c9e4f71";
const MODEL = "a1b2c3d4-0000-4111-8222-333344445555";
const DEPLOYMENT = "0f9e8d7c-6b5a-4c3d-9e2f-1a0b9c8d7e6f";
const NONCE = "0123456789abcdef";
const SIG = "ab".repeat(32);
const EVENTS = `/api/training/jobs/${JOB}/events?n=${NONCE}`;
const ADAPTER = `/api/training/fine-tuned-models/${MODEL}/adapter?d=${DEPLOYMENT}&g=3&sig=${SIG}`;
const SIGNATURE = `t=1760000000,v1=${"cd".repeat(32)}`;
const EVENT_BODY = JSON.stringify({ type: "step", seq: 4, step: 20, loss: 1.25, jobId: JOB });
const EVENT_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "wheelsai-trainer/1.0.0",
  "X-WheelsAI-Signature": SIGNATURE,
};

const closers = [];
after(async () => {
  for (const close of closers.reverse()) await close();
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

/** A fake API. `seen` holds every request that reached it. */
async function fakeApi(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const record = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks),
        from: req.socket.remoteAddress,
      };
      seen.push(record);
      (handler ?? defaultAnswer)(req, res, record);
    });
  });
  const port = await listen(server);
  closers.push(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return { seen, port, origin: `http://127.0.0.1:${port}` };
}

function defaultAnswer(_req, res) {
  const text = JSON.stringify({ received: true, applied: true });
  res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

async function startDoor(options) {
  const lines = [];
  const door = createDoor({ port: 0, log: (line) => lines.push(line), ...options });
  const { port } = await door.listen();
  closers.push(() => door.close(0));
  return { door, port, lines };
}

/** One request through node:http. `body` may be a Buffer, a string or a list of chunks (sent chunked). */
function send(port, { method = "GET", path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    if (Array.isArray(body)) {
      for (const chunk of body) req.write(chunk);
      req.end();
    } else {
      req.end(body);
    }
  });
}

/** Raw bytes on a socket, for what node:http will not send. Resolves with everything that came back. */
function sendRaw(port, text) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    const chunks = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => resolve(Buffer.concat(chunks).toString("latin1")));
    socket.on("connect", () => socket.write(text));
    socket.setTimeout(3000, () => socket.destroy());
  });
}

async function until(check, label) {
  for (let i = 0; i < 400; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${label}`);
}

async function closedPort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function assertNotFound(answer, label) {
  assert.equal(answer.status, 404, label);
  assert.equal(answer.headers["cache-control"], "no-store", label);
  assert.equal(answer.headers["content-type"], "application/json", label);
  assert.deepEqual(JSON.parse(answer.body.toString()), { error: "not_found" }, label);
}

describe("the two shapes", () => {
  it("match what the API builds", () => {
    assert.ok(EVENTS_TARGET.test(EVENTS));
    assert.ok(ADAPTER_TARGET.test(ADAPTER));
    assert.ok(ADAPTER_TARGET.test(ADAPTER.replace("&g=3&", "&g=0&")));
    assert.ok(ADAPTER_TARGET.test(ADAPTER.replace("&g=3&", "&g=999999999&")));
    assert.equal(MAX_EVENT_BYTES, 65_536);
  });

  it("passes a training event with its target, body and four headers intact", async () => {
    const api = await fakeApi();
    const { port } = await startDoor({ upstream: api.origin });
    const answer = await send(port, { method: "POST", path: EVENTS, headers: EVENT_HEADERS, body: EVENT_BODY });

    assert.equal(answer.status, 200);
    assert.deepEqual(JSON.parse(answer.body.toString()), { received: true, applied: true });
    assert.equal(api.seen.length, 1);
    const [seen] = api.seen;
    assert.equal(seen.method, "POST");
    assert.equal(seen.url, EVENTS);
    assert.equal(seen.body.toString(), EVENT_BODY);
    assert.equal(seen.headers["content-type"], "application/json");
    assert.equal(seen.headers["content-length"], String(Buffer.byteLength(EVENT_BODY)));
    assert.equal(seen.headers["x-wheelsai-signature"], SIGNATURE);
    assert.equal(seen.headers["user-agent"], "wheelsai-trainer/1.0.0");
  });

  it("passes a body of exactly the limit, and one sent in chunks with no Content-Length", async () => {
    const api = await fakeApi();
    const { port } = await startDoor({ upstream: api.origin });
    const full = Buffer.alloc(MAX_EVENT_BYTES, 0x61);
    const first = await send(port, { method: "POST", path: EVENTS, headers: EVENT_HEADERS, body: full });
    const second = await send(port, {
      method: "POST",
      path: EVENTS,
      headers: EVENT_HEADERS,
      body: [EVENT_BODY.slice(0, 10), EVENT_BODY.slice(10)],
    });

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(api.seen[0].body.length, MAX_EVENT_BYTES);
    assert.equal(api.seen[1].body.toString(), EVENT_BODY);
    assert.equal(api.seen[1].headers["content-length"], String(Buffer.byteLength(EVENT_BODY)));
    assert.equal(api.seen[1].headers["transfer-encoding"], undefined);
  });

  it("hands back a 302 with its Location and does not follow it", async () => {
    const location = "https://bucket.example.com/adapters/a.tar.gz?X-Amz-Signature=abc";
    const api = await fakeApi((_req, res) => {
      res.writeHead(302, { Location: location, "Cache-Control": "no-store", "Content-Length": 0 });
      res.end();
    });
    const { port } = await startDoor({ upstream: api.origin });
    const answer = await send(port, { path: ADAPTER, headers: { "User-Agent": "Python-urllib/3.12" } });

    assert.equal(answer.status, 302);
    assert.equal(answer.headers.location, location);
    assert.equal(answer.headers["cache-control"], "no-store");
    assert.equal(api.seen.length, 1);
    assert.equal(api.seen[0].method, "GET");
    assert.equal(api.seen[0].url, ADAPTER);
    assert.equal(api.seen[0].headers["user-agent"], "Python-urllib/3.12");
    assert.equal(api.seen[0].headers["content-length"], undefined);
    assert.equal(api.seen[0].body.length, 0);
  });

  it("streams a 200 adapter back as it is", async () => {
    const archive = Buffer.alloc(700_000, 0x7a);
    const api = await fakeApi((_req, res) => {
      res.writeHead(200, {
        "Content-Type": "application/gzip",
        "Content-Length": archive.length,
        "Cache-Control": "no-store",
      });
      res.end(archive);
    });
    const { port, lines } = await startDoor({ upstream: api.origin });
    const answer = await send(port, { path: ADAPTER });

    assert.equal(answer.status, 200);
    assert.equal(answer.headers["content-type"], "application/gzip");
    assert.equal(answer.headers["content-length"], String(archive.length));
    assert.ok(answer.body.equals(archive));
    await until(() => lines.length === 1, "the log line");
    assert.equal(lines[0].bytes, archive.length);
  });

  it("hands back the API's 404 and 401 as they are", async () => {
    const api = await fakeApi((req, res) => {
      const status = req.method === "GET" ? 404 : 401;
      const text = JSON.stringify({ error: status === 404 ? "not_found" : "invalid_callback_signature" });
      res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
      res.end(text);
    });
    const { port, lines } = await startDoor({ upstream: api.origin });
    const adapter = await send(port, { path: ADAPTER });
    const event = await send(port, { method: "POST", path: EVENTS, headers: EVENT_HEADERS, body: EVENT_BODY });

    assert.equal(adapter.status, 404);
    assert.equal(event.status, 401);
    assert.deepEqual(JSON.parse(event.body.toString()), { error: "invalid_callback_signature" });
    assert.equal(api.seen.length, 2);
    await until(() => lines.length === 2, "the log lines");
    assert.deepEqual(
      lines.map((line) => [line.passed, line.status]),
      [
        [true, 404],
        [true, 401],
      ],
    );
  });

  it("answers the health check itself", async () => {
    const api = await fakeApi();
    const { port } = await startDoor({ upstream: api.origin });
    const answer = await send(port, { path: "/__door/health" });

    assert.equal(answer.status, 200);
    assert.deepEqual(JSON.parse(answer.body.toString()), { door: "ok" });
    assert.equal(answer.headers["cache-control"], "no-store");
    assert.equal(api.seen.length, 0);
  });
});

describe("what is dropped on the way", () => {
  it("never shows the API a cookie, an authorization or a forwarding header", async () => {
    const api = await fakeApi();
    const { port } = await startDoor({ upstream: api.origin });
    const extra = {
      Cookie: "session=secret",
      Authorization: "Bearer secret",
      "X-Forwarded-For": "203.0.113.9",
      "X-Forwarded-Host": "evil.example.com",
      "X-Forwarded-Proto": "https",
      Forwarded: "for=203.0.113.9",
      "X-Real-IP": "203.0.113.9",
      "CF-Connecting-IP": "203.0.113.9",
      Origin: "https://evil.example.com",
      Referer: "https://evil.example.com/",
      "X-Api-Key": "secret",
    };
    await send(port, { method: "POST", path: EVENTS, headers: { ...EVENT_HEADERS, ...extra }, body: EVENT_BODY });
    await send(port, { path: ADAPTER, headers: { "User-Agent": "Python-urllib/3.12", ...extra } });

    assert.equal(api.seen.length, 2);
    // Host and Connection are Node's own, written for the upstream.
    assert.deepEqual(Object.keys(api.seen[0].headers).sort(), [
      "connection",
      "content-length",
      "content-type",
      "host",
      "user-agent",
      "x-wheelsai-signature",
    ]);
    assert.deepEqual(Object.keys(api.seen[1].headers).sort(), ["connection", "host", "user-agent"]);
    assert.equal(api.seen[0].headers.host, `127.0.0.1:${api.port}`);
  });

  it("shows the caller only four headers of the API's answer", async () => {
    const api = await fakeApi((_req, res) => {
      const text = "{}";
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": text.length,
        "Cache-Control": "no-store",
        "Set-Cookie": "session=secret",
        "X-Powered-By": "the api",
        "Access-Control-Allow-Origin": "*",
        Server: "the api",
      });
      res.end(text);
    });
    const { port } = await startDoor({ upstream: api.origin });
    const answer = await send(port, { method: "POST", path: EVENTS, headers: EVENT_HEADERS, body: EVENT_BODY });

    assert.equal(answer.status, 200);
    // Date, Connection and Keep-Alive are the door's own.
    const fromApi = Object.keys(answer.headers).filter((name) => !["date", "connection", "keep-alive"].includes(name));
    assert.deepEqual(fromApi.sort(), ["cache-control", "content-length", "content-type"]);
  });
});

describe("what does not pass", () => {
  const upper = (text) => text.toUpperCase();
  const json = { "Content-Type": "application/json" };
  const refused = [
    ["the root", { path: "/" }],
    ["the sign-in", { method: "POST", path: "/api/auth/login", headers: json, body: "{}" }],
    ["the job itself", { path: `/api/training/jobs/${JOB}` }],
    ["the job list", { path: "/api/training/jobs" }],
    ["the model itself", { path: `/api/training/fine-tuned-models/${MODEL}` }],
    ["the capabilities", { path: "/api/training/capabilities" }],
    ["GET on the events path", { path: EVENTS }],
    ["PUT on the events path", { method: "PUT", path: EVENTS, headers: json, body: "{}" }],
    ["PATCH on the events path", { method: "PATCH", path: EVENTS, headers: json, body: "{}" }],
    ["DELETE on the events path", { method: "DELETE", path: EVENTS }],
    ["OPTIONS on the events path", { method: "OPTIONS", path: EVENTS }],
    ["POST on the adapter path", { method: "POST", path: ADAPTER, headers: json, body: "{}" }],
    ["DELETE on the adapter path", { method: "DELETE", path: ADAPTER }],
    ["events with no query", { method: "POST", path: EVENTS.split("?")[0], headers: json, body: "{}" }],
    ["events with an empty query", { method: "POST", path: `${EVENTS.split("?")[0]}?`, headers: json, body: "{}" }],
    ["events with an extra parameter", { method: "POST", path: `${EVENTS}&x=1`, headers: json, body: "{}" }],
    ["events with a trailing &", { method: "POST", path: `${EVENTS}&`, headers: json, body: "{}" }],
    ["events with a repeated nonce", { method: "POST", path: `${EVENTS}&n=${NONCE}`, headers: json, body: "{}" }],
    ["events with another parameter name", { method: "POST", path: EVENTS.replace("?n=", "?m="), headers: json, body: "{}" }],
    ["events with a fragment", { method: "POST", path: `${EVENTS}#x`, headers: json, body: "{}" }],
    ["a short nonce", { method: "POST", path: EVENTS.slice(0, -1), headers: json, body: "{}" }],
    ["a long nonce", { method: "POST", path: `${EVENTS}0`, headers: json, body: "{}" }],
    ["capitals in the nonce", { method: "POST", path: EVENTS.replace(NONCE, upper(NONCE)), headers: json, body: "{}" }],
    ["capitals in the job id", { method: "POST", path: EVENTS.replace(JOB, upper(JOB)), headers: json, body: "{}" }],
    ["a job id that is not a UUID", { method: "POST", path: EVENTS.replace(JOB, "job-1"), headers: json, body: "{}" }],
    ["a capital in the path", { method: "POST", path: EVENTS.replace("/api/", "/API/"), headers: json, body: "{}" }],
    ["a trailing slash on events", { method: "POST", path: EVENTS.replace("/events?", "/events/?"), headers: json, body: "{}" }],
    ["a double slash at the start", { method: "POST", path: `/${EVENTS}`, headers: json, body: "{}" }],
    ["a double slash inside", { method: "POST", path: EVENTS.replace("/jobs/", "/jobs//"), headers: json, body: "{}" }],
    ["an escaped slash", { method: "POST", path: EVENTS.replace("/events", "%2Fevents"), headers: json, body: "{}" }],
    ["an escaped letter", { method: "POST", path: EVENTS.replace("/events", "/%65vents"), headers: json, body: "{}" }],
    ["an escape in the nonce", { method: "POST", path: EVENTS.replace(NONCE, `%30${NONCE.slice(1)}`), headers: json, body: "{}" }],
    ["dot segments", { method: "POST", path: `/api/auth/../training/jobs/${JOB}/events?n=${NONCE}`, headers: json, body: "{}" }],
    ["a matrix parameter", { method: "POST", path: EVENTS.replace("/events", "/events;x=1"), headers: json, body: "{}" }],
    ["a wrong content type", { method: "POST", path: EVENTS, headers: { "Content-Type": "text/plain" }, body: "{}" }],
    ["a form content type", { method: "POST", path: EVENTS, headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "a=1" }],
    ["a content type with a parameter", { method: "POST", path: EVENTS, headers: { "Content-Type": "application/json; charset=utf-8" }, body: "{}" }],
    ["no content type", { method: "POST", path: EVENTS, body: "{}" }],
    ["adapter with no query", { path: ADAPTER.split("?")[0] }],
    ["adapter with an extra parameter", { path: `${ADAPTER}&x=1` }],
    ["adapter with its parameters in another order", { path: `${ADAPTER.split("?")[0]}?g=3&d=${DEPLOYMENT}&sig=${SIG}` }],
    ["adapter without g", { path: `${ADAPTER.split("?")[0]}?d=${DEPLOYMENT}&sig=${SIG}` }],
    ["adapter with a leading zero in g", { path: ADAPTER.replace("&g=3&", "&g=03&") }],
    ["adapter with a g that is not digits", { path: ADAPTER.replace("&g=3&", "&g=1e3&") }],
    ["adapter with ten digits in g", { path: ADAPTER.replace("&g=3&", "&g=1234567890&") }],
    ["capitals in the signature", { path: ADAPTER.replace(SIG, upper(SIG)) }],
    ["a short signature", { path: ADAPTER.slice(0, -1) }],
    ["a long signature", { path: `${ADAPTER}a` }],
    ["capitals in the model id", { path: ADAPTER.replace(MODEL, upper(MODEL)) }],
    ["capitals in the deployment id", { path: ADAPTER.replace(DEPLOYMENT, upper(DEPLOYMENT)) }],
    ["a trailing slash on adapter", { path: ADAPTER.replace("/adapter?", "/adapter/?") }],
    ["an escape in the adapter query", { path: ADAPTER.replace("&g=3", "%26g=3") }],
    ["a GET with a body", { path: ADAPTER, headers: { "Content-Length": 3 }, body: "abc" }],
    ["a GET with a chunked body", { path: ADAPTER, headers: { "Transfer-Encoding": "chunked" }, body: ["abc"] }],
    ["health with a body", { path: "/__door/health", headers: { "Content-Length": 3 }, body: "abc" }],
    ["health with a query", { path: "/__door/health?x=1" }],
    ["health with a trailing slash", { path: "/__door/health/" }],
    ["POST on health", { method: "POST", path: "/__door/health", headers: json, body: "{}" }],
    ["another door path", { path: "/__door/metrics" }],
  ];

  it("answers 404 to each, and the API sees nothing", async () => {
    const api = await fakeApi();
    const { port, lines } = await startDoor({ upstream: api.origin, ratePerSecond: 1000 });
    for (const [label, request] of refused) {
      assertNotFound(await send(port, request), label);
    }
    const head = await send(port, { method: "HEAD", path: ADAPTER });
    assert.equal(head.status, 404);
    assert.equal(head.headers["cache-control"], "no-store");

    assert.equal(api.seen.length, 0);
    await until(() => lines.length === refused.length + 1, "the log lines");
    assert.ok(lines.every((line) => line.passed === false && line.status === 404));
  });

  it("refuses a request target that does not start with a slash", async () => {
    const api = await fakeApi();
    const { port } = await startDoor({ upstream: api.origin });
    const absolute = await sendRaw(
      port,
      `POST http://127.0.0.1:${api.port}${EVENTS} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n` +
        "Content-Length: 2\r\nConnection: close\r\n\r\n{}",
    );
    const star = await sendRaw(port, "OPTIONS * HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    const bare = await sendRaw(port, `GET ${ADAPTER.slice(1)} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);

    for (const text of [absolute, star, bare]) {
      assert.match(text, /^HTTP\/1\.1 404 /);
      assert.match(text, /\{"error":"not_found"\}$/);
    }
    assert.equal(api.seen.length, 0);
  });

  it("refuses CONNECT and any Upgrade, and closes the socket", async () => {
    const api = await fakeApi();
    const { port, lines } = await startDoor({ upstream: api.origin });
    const connect = await sendRaw(port, `CONNECT 127.0.0.1:${api.port} HTTP/1.1\r\nHost: 127.0.0.1:${api.port}\r\n\r\n`);
    const upgrade = await sendRaw(
      port,
      `GET ${ADAPTER} HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
    );
    const garbage = await sendRaw(port, "not http at all\r\n\r\n");

    // sendRaw resolves when the door closes the socket: none was left open.
    for (const text of [connect, upgrade, garbage]) {
      assert.match(text, /^HTTP\/1\.1 404 /);
      assert.match(text, /Cache-Control: no-store/);
      assert.match(text, /\{"error":"not_found"\}$/);
    }
    assert.equal(api.seen.length, 0);
    assert.equal(lines.length, 3);
    assert.ok(lines.every((line) => line.passed === false && line.status === 404));
  });
});

describe("what an attacker sends", () => {
  it("refuses request framing tricks, and the API sees nothing", async () => {
    const api = await fakeApi();
    const { port } = await startDoor({ upstream: api.origin });
    const post = `POST ${EVENTS} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n`;
    const smuggled = "GET /api/auth/me HTTP/1.1\r\nHost: x\r\n\r\n";
    const tricks = {
      "both Content-Length and Transfer-Encoding": `${post}Content-Length: 4\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n0\r\n\r\n${smuggled}`,
      "two Content-Length headers": `${post}Content-Length: 2\r\nContent-Length: 40\r\nConnection: close\r\n\r\n{}${smuggled}`,
      "a Transfer-Encoding that is not chunked": `${post}Transfer-Encoding: gzip\r\nConnection: close\r\n\r\n{}`,
      "a lower-case method": `get ${ADAPTER} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`,
      "a tab in the target": `GET ${ADAPTER}\t HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`,
      "a space in the target": `GET ${ADAPTER} x HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`,
      "a null byte in the target": `GET ${ADAPTER}\x00 HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`,
      "a control character in a header": `GET ${ADAPTER} HTTP/1.1\r\nHost: x\r\nUser-Agent: a\x01b\r\nConnection: close\r\n\r\n`,
      "a target longer than Node reads": `GET /${"a".repeat(40_000)} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`,
      "a header longer than Node reads": `GET ${ADAPTER} HTTP/1.1\r\nHost: x\r\nUser-Agent: ${"a".repeat(40_000)}\r\nConnection: close\r\n\r\n`,
    };
    for (const [label, text] of Object.entries(tricks)) {
      const back = await sendRaw(port, text);
      assert.match(back, /^HTTP\/1\.1 404 /, label);
      assert.match(back, /\{"error":"not_found"\}$/, label);
      assert.equal(back.split("HTTP/1.1 ").length, 2, `${label}: one answer only`);
    }
    assert.equal(api.seen.length, 0);

    // The patterns end at the end of the target, not before a line break.
    assert.ok(!EVENTS_TARGET.test(`${EVENTS}\n`));
    assert.ok(!ADAPTER_TARGET.test(`${ADAPTER}\n`));
    assert.ok(!EVENTS_TARGET.test(`\n${EVENTS}`));
    assert.ok(!ADAPTER_TARGET.test(`/x\n${ADAPTER}`));
  });

  it("never forwards a header that renames the method", async () => {
    const api = await fakeApi();
    const { port } = await startDoor({ upstream: api.origin });
    const override = { "X-HTTP-Method-Override": "DELETE", "X-Method-Override": "DELETE", "X-Original-URL": "/api/admin" };
    await send(port, { path: ADAPTER, headers: override });

    assert.equal(api.seen.length, 1);
    assert.equal(api.seen[0].method, "GET");
    assert.deepEqual(Object.keys(api.seen[0].headers).sort(), ["connection", "host"]);
  });

  it("logs a request refused for its Expect header", async () => {
    const api = await fakeApi();
    const { port, lines } = await startDoor({ upstream: api.origin });
    const back = await sendRaw(
      port,
      `POST ${EVENTS} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 2\r\n` +
        "Expect: 200-ok\r\nConnection: close\r\n\r\n{}",
    );

    assert.match(back, /^HTTP\/1\.1 404 /);
    assert.equal(api.seen.length, 0);
    await until(() => lines.length === 1, "the log line");
    assert.deepEqual(
      [lines[0].method, lines[0].path, lines[0].passed, lines[0].status],
      ["POST", `/api/training/jobs/${JOB}/events`, false, 404],
    );
  });

  it("cuts the socket, and writes no second answer, when garbage follows a request still being answered", async () => {
    const api = await fakeApi((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/gzip", "Content-Length": 1000 });
      res.write("partial");
    });
    const { door, port } = await startDoor({ upstream: api.origin });
    const back = await new Promise((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1");
      const chunks = [];
      let sent = false;
      socket.on("data", (chunk) => {
        chunks.push(chunk);
        if (!sent && Buffer.concat(chunks).includes("partial")) {
          sent = true;
          socket.write("not http at all\r\n\r\n");
        }
      });
      socket.on("error", () => {});
      socket.on("close", () => resolve(Buffer.concat(chunks).toString("latin1")));
      socket.on("connect", () => socket.write(`GET ${ADAPTER} HTTP/1.1\r\nHost: x\r\n\r\n`));
      socket.setTimeout(3000, () => reject(new Error("the door left the socket open")));
    });

    assert.match(back, /^HTTP\/1\.1 200 /);
    assert.ok(back.endsWith("partial"), "nothing was written after the part of the stream");
    assert.ok(!back.includes("not_found"));
    await until(() => door.inFlight() === 0, "the slot to be free");
  });
});

describe("when a side breaks off", () => {
  /** An upstream that answers with raw bytes, for what node:http will not write. */
  async function rawUpstream(onRequest) {
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket));
      socket.once("data", () => onRequest(socket));
    });
    const port = await listen(server);
    closers.push(
      () =>
        new Promise((resolve) => {
          for (const socket of sockets) socket.destroy();
          server.close(resolve);
        }),
    );
    return `http://127.0.0.1:${port}`;
  }

  it("answers 502, and keeps running, when the API's answer has a status the door cannot hand back", async () => {
    for (const status of ["099", "000", "101", "600", "999", "1000"]) {
      const upstream = await rawUpstream((socket) => socket.end(`HTTP/1.1 ${status} X\r\nContent-Length: 0\r\n\r\n`));
      const { door, port, lines } = await startDoor({ upstream });
      const answer = await send(port, { path: ADAPTER });

      assert.equal(answer.status, 502, status);
      assert.deepEqual(JSON.parse(answer.body.toString()), { error: "bad_gateway" }, status);
      await until(() => lines.length === 1 && door.inFlight() === 0, `the slot to be free after ${status}`);
    }
  });

  it("cuts the caller, and frees the slot, when the API resets in the middle of a stream", async () => {
    const upstream = await rawUpstream((socket) => {
      socket.write("HTTP/1.1 200 OK\r\nContent-Type: application/gzip\r\nContent-Length: 1000\r\n\r\npartial");
      setTimeout(() => socket.resetAndDestroy(), 30);
    });
    const { door, port, lines } = await startDoor({ upstream });
    // Less than Content-Length arrived, so the caller sees a broken download, not a short file.
    await assert.rejects(send(port, { path: ADAPTER }));
    await until(() => lines.length === 1 && door.inFlight() === 0, "the slot to be free");
    assert.deepEqual([lines[0].passed, lines[0].status, lines[0].bytes], [true, 200, 7]);
  });

  it("frees the slot, and never asks the API, when the caller resets in the middle of a body", async () => {
    const api = await fakeApi();
    const { door, port, lines } = await startDoor({ upstream: api.origin });
    const socket = net.connect(port, "127.0.0.1");
    socket.on("error", () => {});
    socket.on("connect", () =>
      socket.write(`POST ${EVENTS} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\nabc`),
    );
    await until(() => door.inFlight() === 1, "the request to hold a slot");
    socket.resetAndDestroy();
    await until(() => lines.length === 1 && door.inFlight() === 0, "the slot to be free");

    assert.deepEqual([lines[0].passed, lines[0].status, lines[0].bytesIn], [false, 0, 3]);
    assert.equal(api.seen.length, 0);
    // The door still answers.
    assert.equal((await send(port, { path: "/__door/health" })).status, 200);
  });

  it("answers 408 to a caller that does not finish its body in time, and closes the socket", async () => {
    const api = await fakeApi();
    const { door, port, lines } = await startDoor({ upstream: api.origin, timeouts: { postMs: 80 } });
    const back = await sendRaw(
      port,
      `POST ${EVENTS} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\nabc`,
    );

    assert.match(back, /^HTTP\/1\.1 408 /);
    assert.match(back, /Cache-Control: no-store/);
    assert.match(back, /\{"error":"request_timeout"\}$/);
    assert.equal(api.seen.length, 0);
    await until(() => lines.length === 1 && door.inFlight() === 0, "the slot to be free");
    assert.deepEqual([lines[0].passed, lines[0].status], [false, 408]);
  });
});

describe("the body limit", () => {
  it("answers 413 to a body over the limit sent with no Content-Length", async () => {
    const api = await fakeApi();
    const { port, lines } = await startDoor({ upstream: api.origin });
    const chunk = Buffer.alloc(10_000, 0x61);
    const answer = await send(port, {
      method: "POST",
      path: EVENTS,
      headers: EVENT_HEADERS,
      body: [chunk, chunk, chunk, chunk, chunk, chunk, chunk],
    });

    assert.equal(answer.status, 413);
    assert.equal(answer.headers["cache-control"], "no-store");
    assert.deepEqual(JSON.parse(answer.body.toString()), { error: "payload_too_large" });
    assert.equal(api.seen.length, 0);
    await until(() => lines.length === 1, "the log line");
    assert.equal(lines[0].passed, false);
    assert.equal(lines[0].status, 413);
  });

  it("answers 413 to one byte over the limit", async () => {
    const api = await fakeApi();
    const { port } = await startDoor({ upstream: api.origin });
    const body = Buffer.alloc(MAX_EVENT_BYTES + 1, 0x61);
    const declared = await send(port, { method: "POST", path: EVENTS, headers: EVENT_HEADERS, body });
    const chunked = await send(port, { method: "POST", path: EVENTS, headers: EVENT_HEADERS, body: [body] });

    assert.equal(declared.status, 413);
    assert.equal(chunked.status, 413);
    assert.equal(api.seen.length, 0);
  });

  it("never passes more than a small Content-Length declares", async () => {
    // HTTP ends a body where Content-Length says, so the bytes after it are
    // not a body: they are a second, unreadable request, and that is refused.
    const api = await fakeApi();
    const { port } = await startDoor({ upstream: api.origin });
    const text = await sendRaw(
      port,
      `POST ${EVENTS} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 5\r\n\r\n` +
        "a".repeat(70_000),
    );

    // The socket is closed on the unreadable part; the five declared bytes
    // may or may not have gone through first, and nothing else ever does.
    assert.match(text, /HTTP\/1\.1 404 [^]*\{"error":"not_found"\}$/);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.ok(api.seen.length <= 1);
    for (const seen of api.seen) {
      assert.equal(seen.body.toString(), "aaaaa");
      assert.equal(seen.headers["content-length"], "5");
    }
  });
});

describe("the limits", () => {
  it("answers 429 beyond the burst, and lets requests pass again as time goes by", async () => {
    const api = await fakeApi();
    let clock = 1000;
    const { door, port } = await startDoor({ upstream: api.origin, ratePerSecond: 2, burst: 4, now: () => clock });
    assert.equal(door.burst, 4);
    const statuses = [];
    for (let i = 0; i < 6; i += 1) {
      statuses.push((await send(port, { method: "POST", path: EVENTS, headers: EVENT_HEADERS, body: EVENT_BODY })).status);
    }
    assert.deepEqual(statuses, [200, 200, 200, 200, 429, 429]);
    assert.equal(api.seen.length, 4);

    // Health and refusals are not forwarded, so they are not counted.
    assert.equal((await send(port, { path: "/__door/health" })).status, 200);
    assert.equal((await send(port, { path: "/" })).status, 404);

    clock += 500;
    assert.equal((await send(port, { path: ADAPTER })).status, 200);
    const limited = await send(port, { path: ADAPTER });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers["cache-control"], "no-store");
    assert.deepEqual(JSON.parse(limited.body.toString()), { error: "rate_limited" });
    assert.equal(api.seen.length, 5);
  });

  it("does not lose its tokens when the clock is set back", async () => {
    const api = await fakeApi();
    let clock = 10_000_000;
    const { port } = await startDoor({ upstream: api.origin, ratePerSecond: 2, burst: 4, now: () => clock });
    assert.equal((await send(port, { path: ADAPTER })).status, 200);
    clock -= 3_600_000;
    assert.equal((await send(port, { path: ADAPTER })).status, 200);
    assert.equal((await send(port, { path: ADAPTER })).status, 200);
    assert.equal((await send(port, { path: ADAPTER })).status, 200);
    assert.equal((await send(port, { path: ADAPTER })).status, 429);
    clock += 1000;
    assert.equal((await send(port, { path: ADAPTER })).status, 200);
  });

  it("does not cut an adapter stream at the limits meant for a progress report", async () => {
    const parts = 12;
    const part = Buffer.alloc(50_000, 0x7a);
    const api = await fakeApi((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/gzip", "Content-Length": parts * part.length });
      let sent = 0;
      const timer = setInterval(() => {
        res.write(part);
        sent += 1;
        if (sent === parts) {
          clearInterval(timer);
          res.end();
        }
      }, 25);
    });
    // The stream lasts about 300 ms: several times the POST limit and the wait for the first byte.
    const { door, port } = await startDoor({ upstream: api.origin, timeouts: { postMs: 60, headersMs: 60 } });
    const answer = await send(port, { path: ADAPTER });

    assert.equal(answer.status, 200);
    assert.equal(answer.body.length, parts * part.length);
    await until(() => door.inFlight() === 0, "the slot to be free");
  });

  it("answers 503 beyond the requests in flight", async () => {
    const held = [];
    const api = await fakeApi((_req, res) => held.push(res));
    const { door, port } = await startDoor({ upstream: api.origin, maxInFlight: 2 });
    const first = send(port, { method: "POST", path: EVENTS, headers: EVENT_HEADERS, body: EVENT_BODY });
    const second = send(port, { path: ADAPTER });
    await until(() => held.length === 2, "two requests at the API");
    assert.equal(door.inFlight(), 2);

    const third = await send(port, { method: "POST", path: EVENTS, headers: EVENT_HEADERS, body: EVENT_BODY });
    assert.equal(third.status, 503);
    assert.equal(third.headers["cache-control"], "no-store");
    assert.deepEqual(JSON.parse(third.body.toString()), { error: "busy" });
    assert.equal(api.seen.length, 2);

    for (const res of held) defaultAnswer(null, res);
    assert.equal((await first).status, 200);
    assert.equal((await second).status, 200);
    await until(() => door.inFlight() === 0, "the slots to be free");
    held.length = 0;
    const fourth = send(port, { path: ADAPTER });
    await until(() => held.length === 1, "the next request at the API");
    defaultAnswer(null, held[0]);
    assert.equal((await fourth).status, 200);
  });

  it("answers 502 when the API is down", async () => {
    const { door, port, lines } = await startDoor({ upstream: `http://127.0.0.1:${await closedPort()}` });
    const event = await send(port, { method: "POST", path: EVENTS, headers: EVENT_HEADERS, body: EVENT_BODY });
    const adapter = await send(port, { path: ADAPTER });

    assert.equal(event.status, 502);
    assert.equal(adapter.status, 502);
    assert.equal(event.headers["cache-control"], "no-store");
    assert.deepEqual(JSON.parse(event.body.toString()), { error: "bad_gateway" });
    await until(() => lines.length === 2 && door.inFlight() === 0, "the log lines");
  });

  it("answers 504 when the API does not answer in time", async () => {
    const api = await fakeApi(() => {});
    const { door, port } = await startDoor({ upstream: api.origin, timeouts: { headersMs: 60 } });
    const answer = await send(port, { method: "POST", path: EVENTS, headers: EVENT_HEADERS, body: EVENT_BODY });

    assert.equal(answer.status, 504);
    assert.deepEqual(JSON.parse(answer.body.toString()), { error: "gateway_timeout" });
    await until(() => door.inFlight() === 0, "the slot to be free");
  });

  it("cuts an adapter stream that runs past its time", async () => {
    const api = await fakeApi((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/gzip", "Content-Length": 1000 });
      res.write("partial");
    });
    const { door, port } = await startDoor({ upstream: api.origin, timeouts: { adapterMs: 80 } });
    await assert.rejects(send(port, { path: ADAPTER }));
    await until(() => door.inFlight() === 0, "the slot to be free");
  });
});

describe("the log's sizes", () => {
  it("counts the body of an answer of the door's own, not only of what the API sent back", async () => {
    const api = await fakeApi();
    const { port, lines } = await startDoor({ upstream: api.origin });
    await send(port, { path: "/__door/health" });
    await send(port, { path: "/api/auth/login" });
    await send(port, { path: ADAPTER });
    await until(() => lines.length === 3, "three log lines");
    assert.deepEqual(
      lines.map((line) => [line.path, line.status, line.bytes]),
      [
        ["/__door/health", 200, Buffer.byteLength('{"door":"ok"}')],
        ["/api/auth/login", 404, Buffer.byteLength('{"error":"not_found"}')],
        [ADAPTER.split("?")[0], 200, Buffer.byteLength(JSON.stringify({ received: true, applied: true }))],
      ],
    );
  });
});

describe("the settings", () => {
  it("refuses at start an upstream that is not http on a loopback address", () => {
    const bad = [
      "http://10.0.0.5:4000",
      "http://192.168.1.10:4000",
      "http://169.254.169.254",
      "http://0.0.0.0:4000",
      "http://example.com",
      "http://localhost:4000",
      "http://api.localhost:4000",
      "https://127.0.0.1:4000",
      "ftp://127.0.0.1",
      "http://user:pw@127.0.0.1:4000",
      "http://127.0.0.1:4000/api",
      "http://127.0.0.1:4000/?x=1",
      "http://127.0.0.1.example.com:4000",
      "http://[::ffff:127.0.0.1]:4000",
      "http://[2001:db8::1]:4000",
      "127.0.0.1:4000",
      "",
    ];
    for (const upstream of bad) {
      assert.throws(() => createDoor({ upstream }), /DOOR_UPSTREAM must be http on a loopback address/, upstream);
      assert.throws(() => settingsFromEnv({ DOOR_UPSTREAM: upstream || " " }), /DOOR_UPSTREAM/, upstream);
    }
    assert.deepEqual(parseUpstream("http://127.0.0.1:4000"), { host: "127.0.0.1", port: 4000, origin: "http://127.0.0.1:4000" });
    assert.deepEqual(parseUpstream("http://127.0.0.1:4000/"), { host: "127.0.0.1", port: 4000, origin: "http://127.0.0.1:4000" });
    assert.deepEqual(parseUpstream("http://127.8.9.10"), { host: "127.8.9.10", port: 80, origin: "http://127.8.9.10:80" });
    assert.deepEqual(parseUpstream("http://[::1]:4000"), { host: "::1", port: 4000, origin: "http://[::1]:4000" });
  });

  it("reads its settings from the environment, with defaults", () => {
    assert.deepEqual(settingsFromEnv({}), {
      upstream: DEFAULT_UPSTREAM,
      port: DEFAULT_PORT,
      maxInFlight: DEFAULT_MAX_IN_FLIGHT,
      ratePerSecond: DEFAULT_RATE_PER_SECOND,
      burst: DEFAULT_BURST,
    });
    assert.equal(DEFAULT_UPSTREAM, "http://127.0.0.1:4000");
    assert.equal(DEFAULT_PORT, 4180);
    assert.equal(DEFAULT_MAX_IN_FLIGHT, 32);
    assert.equal(DEFAULT_RATE_PER_SECOND, 1);
    assert.equal(DEFAULT_BURST, 30);
    assert.equal(createDoor({ port: 0 }).burst, 30);
    assert.deepEqual(
      settingsFromEnv({
        DOOR_UPSTREAM: "http://127.0.0.1:4010",
        DOOR_PORT: "4181",
        DOOR_MAX_IN_FLIGHT: "8",
        DOOR_RATE_PER_SECOND: "5",
        DOOR_BURST: "12",
        DOOR_SOURCE_ADDRESS: "127.0.0.7",
      }),
      {
        upstream: "http://127.0.0.1:4010",
        port: 4181,
        maxInFlight: 8,
        ratePerSecond: 5,
        burst: 12,
        sourceAddress: "127.0.0.7",
      },
    );
    assert.equal(settingsFromEnv({ DOOR_SOURCE_ADDRESS: "off" }).sourceAddress, null);
    assert.equal("sourceAddress" in settingsFromEnv({ DOOR_SOURCE_ADDRESS: "" }), false);
    assert.throws(() => settingsFromEnv({ DOOR_BURST: "0" }), /DOOR_BURST must be/);
    for (const value of ["0", "-1", "abc", "70000", "41.5", " 4180", "0x10"]) {
      assert.throws(() => settingsFromEnv({ DOOR_PORT: value }), /DOOR_PORT must be a whole number/, value);
    }
    assert.throws(() => settingsFromEnv({ DOOR_MAX_IN_FLIGHT: "0" }), /DOOR_MAX_IN_FLIGHT must be/);
    assert.throws(() => settingsFromEnv({ DOOR_RATE_PER_SECOND: "none" }), /DOOR_RATE_PER_SECOND must be/);
  });

  it("keeps, with its defaults, under what the API allows one address in a minute", () => {
    // RATE_LIMIT_MAX_PER_MINUTE is 100 when unset (apps/api/src/index.ts). In its busiest
    // minute the door passes its burst and then its rate.
    assert.ok(DEFAULT_BURST + 60 * DEFAULT_RATE_PER_SECOND < 100);
  });

  it("accepts only an address of this machine to call the API from", () => {
    assert.equal(parseSourceAddress("127.0.0.2", "127.0.0.1"), "127.0.0.2");
    assert.equal(parseSourceAddress("127.255.0.9", "127.0.0.1"), "127.255.0.9");
    assert.equal(parseSourceAddress("off", "127.0.0.1"), null);
    assert.equal(parseSourceAddress(null, "::1"), null);
    for (const value of ["10.0.0.5", "192.168.1.4", "0.0.0.0", "8.8.8.8", "::1", "localhost", "127.0.0", "127.0.0.2:80", ""]) {
      assert.throws(() => parseSourceAddress(value, "127.0.0.1"), /DOOR_SOURCE_ADDRESS must be an address in 127\.0\.0\.0\/8/, value);
    }
    // An API on [::1] has one address only.
    assert.throws(() => parseSourceAddress("127.0.0.2", "::1"), /needs DOOR_UPSTREAM on an IPv4 loopback address/);
    assert.throws(() => settingsFromEnv({ DOOR_UPSTREAM: "http://[::1]:4000", DOOR_SOURCE_ADDRESS: "127.0.0.2" }), /IPv4/);
    assert.equal(createDoor({ port: 0, upstream: "http://[::1]:4000" }).sourceAddress, null);
    assert.equal(createDoor({ port: 0 }).sourceAddress, DEFAULT_SOURCE_ADDRESS);
    assert.equal(createDoor({ port: 0, sourceAddress: null }).sourceAddress, null);
    assert.throws(() => createDoor({ port: 0, sourceAddress: "10.1.2.3" }), /DOOR_SOURCE_ADDRESS/);
  });

  // Every address in 127.0.0.0/8 is this machine on Linux only.
  it("calls the API from an address of its own, so its requests are not counted as the dashboard's", { skip: process.platform !== "linux" }, async () => {
    assert.equal(DEFAULT_SOURCE_ADDRESS, "127.0.0.2");
    const api = await fakeApi();
    const own = await startDoor({ upstream: api.origin });
    assert.equal((await send(own.port, { path: ADAPTER })).status, 200);
    assert.equal((await send(own.port, { method: "POST", path: EVENTS, headers: EVENT_HEADERS, body: EVENT_BODY })).status, 200);
    assert.deepEqual(api.seen.map((request) => request.from), ["127.0.0.2", "127.0.0.2"]);

    const chosen = await startDoor({ upstream: api.origin, sourceAddress: "127.0.0.9" });
    assert.equal((await send(chosen.port, { path: ADAPTER })).status, 200);
    assert.equal(api.seen.at(-1).from, "127.0.0.9");

    const shared = await startDoor({ upstream: api.origin, sourceAddress: null });
    assert.equal((await send(shared.port, { path: ADAPTER })).status, 200);
    assert.equal(api.seen.at(-1).from, "127.0.0.1");
  });

  it("listens on 127.0.0.1 only", async () => {
    const { door } = await startDoor({});
    assert.equal(door.server.address().address, "127.0.0.1");
  });
});

describe("the log", () => {
  it("holds one line per request with no query, no header and no body", async () => {
    const api = await fakeApi();
    const { port, lines } = await startDoor({ upstream: api.origin });
    await send(port, { method: "POST", path: EVENTS, headers: EVENT_HEADERS, body: EVENT_BODY });
    await send(port, { path: ADAPTER, headers: { "User-Agent": "Python-urllib/3.12" } });
    await send(port, { path: "/__door/health" });
    await send(port, { path: `/api/auth/login?token=${SIG}&n=${NONCE}`, headers: { Cookie: "session=secret" } });
    await until(() => lines.length === 4, "the log lines");

    assert.deepEqual(Object.keys(lines[0]), ["time", "method", "path", "passed", "status", "bytesIn", "bytes", "ms"]);
    assert.deepEqual(
      lines.map((line) => [line.method, line.path, line.passed, line.status]),
      [
        ["POST", `/api/training/jobs/${JOB}/events`, true, 200],
        ["GET", `/api/training/fine-tuned-models/${MODEL}/adapter`, true, 200],
        ["GET", "/__door/health", true, 200],
        ["GET", "/api/auth/login", false, 404],
      ],
    );
    assert.equal(lines[0].bytesIn, Buffer.byteLength(EVENT_BODY));
    assert.equal(lines[0].bytes, Buffer.byteLength(JSON.stringify({ received: true, applied: true })));
    assert.ok(Number.isInteger(lines[0].ms) && lines[0].ms >= 0);
    assert.match(lines[0].time, /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$/);

    const text = JSON.stringify(lines);
    for (const secret of ["?", NONCE, SIG, DEPLOYMENT, SIGNATURE, "cd".repeat(32), "wheelsai-trainer", "urllib", "session=secret", "loss"]) {
      assert.ok(!text.includes(secret), `the log holds ${secret}`);
    }
  });

  it("cuts a refused path to 80 characters and removes control characters", async () => {
    assert.equal(logPath("/a\x00b\x1f\x7fc\r\nd\x1b[31m?n=secret"), "/abcd[31m");
    assert.equal(logPath(`/caf\xe9/\u2028x`), "/caf/x");
    assert.equal(logPath(`/${"a".repeat(200)}`).length, 80);
    assert.equal(logPath("?n=secret"), "");
    assert.equal(logPath(undefined), "");

    const api = await fakeApi();
    const { port, lines } = await startDoor({ upstream: api.origin });
    await send(port, { path: `/${"x".repeat(300)}?sig=${SIG}` });
    await until(() => lines.length === 1, "the log line");
    assert.equal(lines[0].path, `/${"x".repeat(79)}`);
  });
});
