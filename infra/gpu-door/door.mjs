#!/usr/bin/env node
/**
 * The GPU door.
 *
 * Stands between a public tunnel and the API on a development machine and
 * passes two requests only, so that nothing else on the machine (the
 * sign-in, the dashboard's API, the admin routes) is reachable from the
 * internet while a GPU proof runs:
 *
 *   POST /api/training/jobs/<job id>/events?n=<nonce>
 *        a training run's signed progress report
 *   GET  /api/training/fine-tuned-models/<model id>/adapter?d=<deployment id>&g=<digits>&sig=<64 hex>
 *        the adapter download of a deployed fine-tuned model
 *
 * and answers one itself:
 *
 *   GET  /__door/health  ->  200 {"door":"ok"}
 *
 * Everything else is 404 {"error":"not_found"} and the API never sees it.
 * The door checks shapes, not secrets: the API still verifies the callback
 * signature and the adapter signature.
 *
 * The request target is matched raw, before anything is decoded, and is
 * forwarded byte for byte. The upstream is fixed at start and must be http on
 * a loopback address, so no request and no setting can make this an open
 * proxy. Node 20 or newer, no dependency, no build step. See README.md.
 */

import { realpathSync } from "node:fs";
import http from "node:http";
import net, { isIP } from "node:net";
import { pipeline } from "node:stream";
import { fileURLToPath } from "node:url";

// ============================================
// What passes
// ============================================

/** A row id as Prisma and randomUUID write it: lower case only. */
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * The progress address, as submitTrainingJob builds it
 * (apps/api/src/services/trainingJobs.ts). The job id is newId (randomUUID)
 * and the nonce is newNonce, 16 hex characters
 * (apps/api/src/services/buildTrainingDeps.ts).
 */
export const EVENTS_TARGET = new RegExp(`^/api/training/jobs/${UUID}/events\\?n=[0-9a-f]{16}$`);

/**
 * The adapter address, as adapterDownloadUrl builds it
 * (apps/api/src/services/fineTunedModels.ts): the same three parameters in
 * the same order, each in the shape the route's own query schema accepts
 * (apps/api/src/routes/fineTunedModels.ts, adapterQuery).
 */
export const ADAPTER_TARGET = new RegExp(
  `^/api/training/fine-tuned-models/${UUID}/adapter\\?d=${UUID}&g=(?:0|[1-9][0-9]{0,8})&sig=[0-9a-f]{64}$`,
);

/** Answered by the door itself, never forwarded. */
export const HEALTH_TARGET = "/__door/health";

/**
 * The largest callback body, in bytes: TRAINING_CALLBACK_MAX_BYTES in
 * apps/api/src/services/trainingWebhookAuth.ts. Keep the two equal.
 */
export const MAX_EVENT_BYTES = 65_536;

/** The only request headers the API is shown, besides the Host Node writes. */
const REQUEST_HEADERS = ["content-type", "content-length", "x-wheelsai-signature", "user-agent"];
/** The only headers of the API's answer the caller is shown. */
const RESPONSE_HEADERS = ["content-type", "content-length", "location", "cache-control"];

// ============================================
// Settings
// ============================================

export const DEFAULT_UPSTREAM = "http://127.0.0.1:4000";
export const DEFAULT_PORT = 4180;
export const DEFAULT_MAX_IN_FLIGHT = 32;
/**
 * A training run reports every ten seconds at most, with a handful more at
 * its start and its end, and a deployment fetches its adapter once a start.
 * One request a second with a burst of 30 is many times that, and in its
 * busiest minute (30 + 60) still under what the API allows one address when
 * RATE_LIMIT_MAX_PER_MINUTE is not set (100): the door can never use up its
 * own allowance at the API.
 */
export const DEFAULT_RATE_PER_SECOND = 1;
export const DEFAULT_BURST = 30;
/**
 * The address the door calls the API from. The API counts requests by the
 * address they come from, and on a development machine the dashboard comes
 * from 127.0.0.1 too. From an address of its own, what strangers send through
 * the tunnel can use up the door's allowance and never the dashboard's.
 * Every address in 127.0.0.0/8 is this machine on Linux; elsewhere only
 * 127.0.0.1 is, so there the door has no address of its own unless one is set.
 */
export const DEFAULT_SOURCE_ADDRESS = process.platform === "linux" ? "127.0.0.2" : null;

const DEFAULT_TIMEOUTS = {
  /** The API's first answer byte, and a caller's request headers. */
  headersMs: 10_000,
  /** A whole POST: the body in, the answer out. */
  postMs: 30_000,
  /** A whole adapter download. */
  adapterMs: 15 * 60_000,
  /** A socket with nothing moving on it. */
  idleMs: 60_000,
};

/** What is read and thrown away from a refused request before its socket is closed. */
const DISCARD_LIMIT_BYTES = 1_048_576;
const LOG_PATH_MAX = 80;

const UPSTREAM_RULE = `DOOR_UPSTREAM must be http on a loopback address with nothing after the port, such as ${DEFAULT_UPSTREAM}.`;

/**
 * Where requests go. Only an http address on 127.0.0.0/8 or ::1 is accepted,
 * written as an address: a name such as localhost is refused, because a name
 * is resolved by the machine and the door never asks.
 */
export function parseUpstream(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error(UPSTREAM_RULE);
  }
  if (url.protocol !== "http:" || url.username || url.password) throw new Error(UPSTREAM_RULE);
  if (url.pathname !== "/" || url.search || url.hash) throw new Error(UPSTREAM_RULE);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const family = isIP(host);
  const loopback = (family === 4 && host.startsWith("127.")) || (family === 6 && host === "::1");
  if (!loopback) throw new Error(UPSTREAM_RULE);
  const port = url.port ? Number(url.port) : 80;
  return { host, port, origin: `http://${family === 6 ? `[${host}]` : host}:${port}` };
}

const SOURCE_RULE =
  "DOOR_SOURCE_ADDRESS must be an address in 127.0.0.0/8 such as 127.0.0.2, or off to call the API from 127.0.0.1.";

/**
 * The address the door calls the API from, or null for the machine's own
 * choice (127.0.0.1). "off" and "" mean null. Only 127.0.0.0/8 is accepted,
 * and only for an API on an IPv4 loopback address.
 */
export function parseSourceAddress(value, upstreamHost) {
  if (value === null || value === "off") return null;
  if (isIP(String(value)) !== 4 || !String(value).startsWith("127.")) throw new Error(SOURCE_RULE);
  if (isIP(upstreamHost) !== 4) {
    throw new Error("DOOR_SOURCE_ADDRESS needs DOOR_UPSTREAM on an IPv4 loopback address (set it to off for [::1]).");
  }
  return String(value);
}

function wholeNumber(name, value, fallback, max) {
  if (value === undefined || value === "") return fallback;
  if (!/^[1-9][0-9]{0,6}$/.test(value) || Number(value) > max) {
    throw new Error(`${name} must be a whole number from 1 to ${max}.`);
  }
  return Number(value);
}

/** The door's settings from the environment. Throws a sentence for a bad one. */
export function settingsFromEnv(env) {
  const upstream = env.DOOR_UPSTREAM === undefined || env.DOOR_UPSTREAM === "" ? DEFAULT_UPSTREAM : env.DOOR_UPSTREAM;
  const { host } = parseUpstream(upstream);
  const settings = {
    upstream,
    port: wholeNumber("DOOR_PORT", env.DOOR_PORT, DEFAULT_PORT, 65_535),
    maxInFlight: wholeNumber("DOOR_MAX_IN_FLIGHT", env.DOOR_MAX_IN_FLIGHT, DEFAULT_MAX_IN_FLIGHT, 1024),
    ratePerSecond: wholeNumber("DOOR_RATE_PER_SECOND", env.DOOR_RATE_PER_SECOND, DEFAULT_RATE_PER_SECOND, 1000),
    burst: wholeNumber("DOOR_BURST", env.DOOR_BURST, DEFAULT_BURST, 10_000),
  };
  // Unset keeps the default (which createDoor drops by itself for an IPv6 API).
  if (env.DOOR_SOURCE_ADDRESS !== undefined && env.DOOR_SOURCE_ADDRESS !== "") {
    settings.sourceAddress = parseSourceAddress(env.DOOR_SOURCE_ADDRESS, host);
  }
  return settings;
}

// ============================================
// Logs
// ============================================

/**
 * The path as a log line may hold it: never the query (it holds the nonce and
 * the adapter signature), nothing but printable ASCII, 80 characters at most.
 */
export function logPath(target) {
  const text = typeof target === "string" ? target : "";
  const query = text.indexOf("?");
  const path = query === -1 ? text : text.slice(0, query);
  return path.replace(/[^\x20-\x7e]/g, "").slice(0, LOG_PATH_MAX);
}

function logMethod(method) {
  return typeof method === "string" ? method.replace(/[^A-Za-z-]/g, "").slice(0, 16) : "";
}

function writeStdout(line) {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

// ============================================
// The door
// ============================================

const NOT_FOUND = { error: "not_found" };

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

/**
 * Builds the door without starting it.
 *
 *   upstream       http on a loopback address (default http://127.0.0.1:4000)
 *   port           the port on 127.0.0.1 (default 4180; 0 lets the system pick)
 *   maxInFlight    requests in the door's hands at once (default 32)
 *   ratePerSecond  passing requests a second, once the burst is spent (default 1)
 *   burst          passing requests that may come at once (default 30)
 *   sourceAddress  the address the API is called from, null for 127.0.0.1
 *                  (default 127.0.0.2 on Linux for an IPv4 API, else null)
 *   timeouts       headersMs, postMs, adapterMs, idleMs
 *   log            receives one object per request (default: a JSON line on stdout)
 *   now            a clock in milliseconds (default: Date.now)
 */
export function createDoor(options = {}) {
  const upstream = parseUpstream(options.upstream ?? DEFAULT_UPSTREAM);
  const port = options.port ?? DEFAULT_PORT;
  const maxInFlight = options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
  const ratePerSecond = options.ratePerSecond ?? DEFAULT_RATE_PER_SECOND;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("The door's port must be from 0 to 65535.");
  if (!isPositiveInteger(maxInFlight)) throw new Error("The door's limit of requests in flight must be a whole number above 0.");
  if (!isPositiveInteger(ratePerSecond)) throw new Error("The door's rate must be a whole number above 0.");
  const burst = options.burst ?? DEFAULT_BURST;
  if (!isPositiveInteger(burst)) throw new Error("The door's burst must be a whole number above 0.");
  const sourceAddress =
    options.sourceAddress === undefined
      ? isIP(upstream.host) === 4
        ? DEFAULT_SOURCE_ADDRESS
        : null
      : parseSourceAddress(options.sourceAddress, upstream.host);
  const timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
  const log = options.log ?? writeStdout;
  const now = options.now ?? Date.now;

  let inFlight = 0;
  /** Sockets with a request whose answer is not over yet, and how to break that request off. */
  const answering = new WeakMap();
  let tokens = burst;
  let refilledAt = now();

  function takeToken() {
    const at = now();
    // A clock set back must not take tokens away: the door would answer 429 until it caught up.
    tokens = Math.min(burst, tokens + (Math.max(0, at - refilledAt) / 1000) * ratePerSecond);
    refilledAt = at;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  }

  function logLine(entry, status) {
    log({
      time: new Date().toISOString(),
      method: logMethod(entry.method),
      path: logPath(entry.target),
      passed: entry.passed,
      status,
      bytesIn: entry.bytesIn,
      bytes: entry.bytes,
      ms: Math.max(0, Math.round(now() - entry.startedAt)),
    });
  }

  /** The size of an answer of the door's own, for its log line. */
  const ownAnswerBytes = new WeakMap();

  /** An answer of the door's own. Never cached. */
  function answer(res, status, body) {
    if (res.headersSent || res.destroyed) return;
    const text = JSON.stringify(body);
    ownAnswerBytes.set(res, Buffer.byteLength(text));
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(text),
      "Cache-Control": "no-store",
    });
    res.end(text);
  }

  /**
   * Reads and throws away what is left of a request, so its answer arrives
   * whole, and closes the socket of a caller that keeps sending.
   */
  function discard(req) {
    let seen = 0;
    req.on("data", (chunk) => {
      seen += chunk.length;
      if (seen > DISCARD_LIMIT_BYTES) req.socket.destroy();
    });
    req.resume();
  }

  function refuse(req, res) {
    answer(res, 404, NOT_FOUND);
    discard(req);
  }

  /** True when the request's headers say a body follows. */
  function announcesBody(req) {
    if (req.headers["transfer-encoding"] !== undefined) return true;
    const length = req.headers["content-length"];
    return length !== undefined && length !== "0";
  }

  function onRequest(req, res, refused = false) {
    const entry = { method: req.method, target: req.url, passed: false, bytesIn: 0, bytes: 0, startedAt: now() };
    /** Runs once, when the answer is over or the caller has gone. */
    let finish = () => {};
    /**
     * What follows this request on its socket is not readable HTTP. A raw 404
     * written to the socket now could land inside this request's answer, so
     * the answer is the 404 when nothing was sent yet, and is cut when it was.
     */
    const breakOff = () => {
      finish();
      if (res.writableEnded) return void req.socket.end();
      if (res.headersSent) return void req.socket.destroy();
      res.setHeader("Connection", "close");
      answer(res, 404, NOT_FOUND);
    };
    answering.set(req.socket, breakOff);
    res.on("close", () => {
      if (answering.get(req.socket) === breakOff) answering.delete(req.socket);
      finish();
      if (ownAnswerBytes.has(res)) entry.bytes = ownAnswerBytes.get(res);
      logLine(entry, res.headersSent ? res.statusCode : 0);
    });
    res.on("error", () => {});
    req.on("error", () => {});
    if (refused) return refuse(req, res);

    const target = typeof req.url === "string" ? req.url : "";

    if (req.method === "GET" && target === HEALTH_TARGET && !announcesBody(req)) {
      entry.passed = true;
      answer(res, 200, { door: "ok" });
      return;
    }

    const isEvent = req.method === "POST" && EVENTS_TARGET.test(target);
    const isAdapter = req.method === "GET" && ADAPTER_TARGET.test(target);
    if (!isEvent && !isAdapter) return refuse(req, res);
    if (isAdapter && announcesBody(req)) return refuse(req, res);
    // Exactly what the trainer sends (infra/training/wheelsai_trainer/callbacks.py).
    if (isEvent && String(req.headers["content-type"] ?? "").trim().toLowerCase() !== "application/json") {
      return refuse(req, res);
    }

    if (inFlight >= maxInFlight) {
      answer(res, 503, { error: "busy" });
      discard(req);
      return;
    }
    if (!takeToken()) {
      answer(res, 429, { error: "rate_limited" });
      discard(req);
      return;
    }

    inFlight += 1;
    let upstreamRequest = null;
    let headersTimer = null;
    let reading = isEvent;
    let done = false;

    /** The API did not answer in time, or broke off. */
    const fail = (status, error) => {
      if (done) return;
      done = true;
      clearTimeout(headersTimer);
      if (upstreamRequest) upstreamRequest.destroy();
      if (res.headersSent) res.destroy();
      else answer(res, status, { error });
    };

    const deadline = setTimeout(
      () => {
        if (reading) {
          // The caller is the slow one: the API was never asked.
          reading = false;
          res.once("finish", () => req.socket.destroy());
          answer(res, 408, { error: "request_timeout" });
          return;
        }
        fail(504, "gateway_timeout");
      },
      isEvent ? timeouts.postMs : timeouts.adapterMs,
    );

    finish = () => {
      finish = () => {};
      inFlight -= 1;
      done = true;
      clearTimeout(deadline);
      clearTimeout(headersTimer);
      if (upstreamRequest) upstreamRequest.destroy();
    };

    const forward = (body) => {
      const headers = {};
      for (const name of REQUEST_HEADERS) {
        if (name !== "content-length" && req.headers[name] !== undefined) headers[name] = req.headers[name];
      }
      // The door holds the whole body, so the length is the one it counted.
      if (body) headers["content-length"] = String(body.length);
      entry.passed = true;
      try {
        upstreamRequest = http.request({
          host: upstream.host,
          port: upstream.port,
          method: req.method,
          path: target,
          headers,
          agent: false,
          ...(sourceAddress ? { localAddress: sourceAddress } : {}),
        });
      } catch {
        return fail(502, "bad_gateway");
      }
      headersTimer = setTimeout(() => fail(504, "gateway_timeout"), timeouts.headersMs);
      upstreamRequest.on("error", () => fail(502, "bad_gateway"));
      upstreamRequest.on("response", (upstreamResponse) => {
        clearTimeout(headersTimer);
        if (done) return upstreamResponse.destroy();
        const status = upstreamResponse.statusCode;
        // Not an answer the API gives. writeHead throws on some of these, and nothing here may throw.
        if (!Number.isInteger(status) || status < 200 || status > 599) return fail(502, "bad_gateway");
        const out = {};
        for (const name of RESPONSE_HEADERS) {
          if (upstreamResponse.headers[name] !== undefined) out[name] = upstreamResponse.headers[name];
        }
        // A redirect is handed back as it is. The door never follows one.
        try {
          res.writeHead(status, out);
        } catch {
          return fail(502, "bad_gateway");
        }
        upstreamResponse.on("data", (chunk) => {
          entry.bytes += chunk.length;
        });
        pipeline(upstreamResponse, res, (err) => {
          if (err) res.destroy();
        });
      });
      upstreamRequest.end(body ?? undefined);
    };

    if (isAdapter) {
      discard(req);
      forward(null);
      return;
    }

    // The limit is counted on the bytes that arrive, whatever the header said.
    const tooLarge = () => {
      reading = false;
      clearTimeout(deadline);
      answer(res, 413, { error: "payload_too_large" });
    };
    const chunks = [];
    let over = false;
    if (Number(req.headers["content-length"] ?? 0) > MAX_EVENT_BYTES) {
      over = true;
      tooLarge();
    }
    req.on("data", (chunk) => {
      entry.bytesIn += chunk.length;
      if (over) {
        if (entry.bytesIn > DISCARD_LIMIT_BYTES) req.socket.destroy();
        return;
      }
      if (entry.bytesIn > MAX_EVENT_BYTES) {
        over = true;
        chunks.length = 0;
        tooLarge();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (over || !reading || done) return;
      reading = false;
      forward(Buffer.concat(chunks));
    });
  }

  /** CONNECT, Upgrade and requests Node could not read: one answer, then the socket is closed. */
  function refuseSocket(socket, method, target) {
    const startedAt = now();
    const text = JSON.stringify(NOT_FOUND);
    socket.on("error", () => {});
    socket.resume();
    socket.setTimeout(2000, () => socket.destroy());
    socket.end(
      "HTTP/1.1 404 Not Found\r\n" +
        "Content-Type: application/json\r\n" +
        `Content-Length: ${text.length}\r\n` +
        "Cache-Control: no-store\r\n" +
        "Connection: close\r\n\r\n" +
        text,
    );
    logLine({ method, target, passed: false, bytesIn: 0, bytes: 0, startedAt }, 404);
  }

  const server = http.createServer(onRequest);
  server.headersTimeout = timeouts.headersMs;
  server.requestTimeout = timeouts.postMs;
  server.keepAliveTimeout = 5000;
  server.setTimeout(timeouts.idleMs);
  server.on("upgrade", (req, socket) => refuseSocket(socket, req.method, req.url));
  server.on("connect", (req, socket) => refuseSocket(socket, req.method, req.url));
  server.on("checkExpectation", (req, res) => onRequest(req, res, true));
  server.on("clientError", (err, socket) => {
    if (err.code === "ECONNRESET" || !socket.writable) return socket.destroy();
    const breakOff = answering.get(socket);
    if (breakOff) return breakOff();
    refuseSocket(socket, "", "");
  });

  return {
    server,
    upstream: upstream.origin,
    maxInFlight,
    ratePerSecond,
    burst,
    sourceAddress,
    inFlight: () => inFlight,
    /** Listens on 127.0.0.1 only. Resolves with the port in use. */
    listen() {
      return new Promise((resolve, reject) => {
        const start = () => {
          server.once("error", reject);
          server.listen(port, "127.0.0.1", () => {
            server.removeListener("error", reject);
            resolve({ host: "127.0.0.1", port: server.address().port });
          });
        };
        if (!sourceAddress) return start();
        // The door's own address must exist on this machine, or every request
        // would end 502 with nothing to say why.
        const probe = net.createServer();
        probe.once("error", (cause) => {
          const err = new Error(`This machine has no address ${sourceAddress} to call the API from.`);
          err.code = "ESOURCEADDRESS";
          err.cause = cause;
          reject(err);
        });
        probe.listen(0, sourceAddress, () => probe.close(start));
      });
    },
    /** Stops taking requests, lets the ones in flight end, and cuts them after `graceMs`. */
    close(graceMs = 10_000) {
      return new Promise((resolve) => {
        const cut = setTimeout(() => server.closeAllConnections(), graceMs);
        server.close(() => {
          clearTimeout(cut);
          resolve();
        });
        server.closeIdleConnections();
      });
    },
  };
}

// ============================================
// Run as a program
// ============================================

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

function main() {
  const stop = (message) => {
    process.stderr.write(`gpu-door: ${message}\n`);
    process.exit(1);
  };
  let door;
  try {
    door = createDoor(settingsFromEnv(process.env));
  } catch (err) {
    return stop(err.message);
  }
  door.listen().then(
    ({ host, port }) => {
      writeStdout({
        time: new Date().toISOString(),
        door: "listening",
        listen: `http://${host}:${port}`,
        upstream: door.upstream,
        passes: [
          "POST /api/training/jobs/<job id>/events?n=<nonce>",
          "GET /api/training/fine-tuned-models/<model id>/adapter?d=<deployment id>&g=<digits>&sig=<64 hex>",
          `GET ${HEALTH_TARGET} (answered here)`,
        ],
        maxInFlight: door.maxInFlight,
        ratePerSecond: door.ratePerSecond,
        burst: door.burst,
        source: door.sourceAddress ?? "127.0.0.1",
      });
    },
    (err) => {
      if (err.code === "EADDRINUSE") return stop("the port is already in use. Set DOOR_PORT to a free one.");
      if (err.code === "ESOURCEADDRESS") {
        return stop(
          `this machine has no address ${door.sourceAddress} to call the API from. Set DOOR_SOURCE_ADDRESS=off to call it from 127.0.0.1; the door then shares the request allowance of everything else on this machine.`,
        );
      }
      return stop(`could not listen on 127.0.0.1 (${err.code ?? "error"}).`);
    },
  );
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    door.close().then(() => process.exit(0));
  };
  process.on("SIGTERM", close);
  process.on("SIGINT", close);
}

if (isMain()) main();
