import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import tls from "node:tls";

import {
  judgeProofResponse,
  probeTlsCertificate,
  type TlsSocketLike,
} from "../services/tlsCertificateProbe.js";
import {
  EXPIRED_LEAF,
  FIXTURE_CA_PEM,
  FIXTURE_HOSTNAME,
  FIXTURE_ISSUER,
  SELF_SIGNED_LEAF,
  VALID_LEAF,
} from "./customDomainTlsFixtures.js";

// services/tlsCertificateProbe.ts - the only source of a domain's certificate
// status. Two halves:
//   - a fake socket, for every way a handshake can end;
//   - a REAL TLS server on loopback with fixture certificates, so the claim
//     "valid means a client would accept it" is tested against Node's own
//     verification rather than against a mock of it.

const PROOF = { path: "/.well-known/wheelsai-domain", expected: "f".repeat(64) };

// ---------------------------------------------------------------------------
// Fake socket
// ---------------------------------------------------------------------------

class FakeSocket extends EventEmitter {
  written: string[] = [];
  destroyed = false;
  certificate: ReturnType<TlsSocketLike["getPeerCertificate"]> = {
    issuer: { O: "Let's Encrypt", CN: "R11" },
    valid_from: "Oct  1 00:00:00 2026 GMT",
    valid_to: "Dec 30 00:00:00 2026 GMT",
    fingerprint256: "AA:BB:CC",
    subjectaltname: "DNS:api.customer.com, DNS:WWW.customer.com, IP Address:137.66.10.1",
  };
  write(data: string) {
    this.written.push(data);
    return true;
  }
  destroy() {
    this.destroyed = true;
  }
  getPeerCertificate() {
    return this.certificate;
  }
}

function withFake(script: (socket: FakeSocket) => void, input: { proof?: typeof PROOF; timeoutMs?: number } = {}) {
  const socket = new FakeSocket();
  const options: tls.ConnectionOptions[] = [];
  const outcome = probeTlsCertificate({
    address: "137.66.10.1",
    servername: "api.customer.com",
    timeoutMs: input.timeoutMs ?? 1_000,
    ...(input.proof ? { proof: input.proof } : {}),
    connect: (connectOptions) => {
      options.push(connectOptions);
      queueMicrotask(() => script(socket));
      return socket as unknown as TlsSocketLike;
    },
  });
  return { outcome, socket, options };
}

const tlsError = (code: string, message = code) => Object.assign(new Error(message), { code });

test("the handshake verifies the certificate, for the customer's name, at the given address", async () => {
  const { outcome, options } = withFake((s) => s.emit("secureConnect"));
  await outcome;
  assert.equal(options.length, 1);
  const o = options[0]!;
  assert.equal(o.host, "137.66.10.1");
  assert.equal(o.port, 443);
  assert.equal(o.servername, "api.customer.com");
  assert.equal(o.rejectUnauthorized, true);
  assert.equal(o.minVersion, "TLSv1.2");
  // No trust roots of its own unless the caller passes some.
  assert.equal("ca" in o, false);
  assert.equal("checkServerIdentity" in o, false);
  assert.equal("session" in o, false);
});

test("secureConnect -> valid, with what the certificate says", async () => {
  const { outcome, socket } = withFake((s) => s.emit("secureConnect"));
  assert.deepEqual(await outcome, {
    kind: "valid",
    proof: "not_requested",
    certificate: {
      issuer: "Let's Encrypt R11",
      validFrom: new Date("2026-10-01T00:00:00Z"),
      validTo: new Date("2026-12-30T00:00:00Z"),
      fingerprint256: "AA:BB:CC",
      altNames: ["api.customer.com", "www.customer.com"],
    },
  });
  assert.equal(socket.destroyed, true);
  assert.deepEqual(socket.written, []);
});

test("a certificate that cannot be read is not valid", async () => {
  const { outcome } = withFake((s) => {
    s.certificate = {};
    s.emit("secureConnect");
  });
  const result = await outcome;
  assert.equal(result.kind, "certificate_invalid");
});

test("verification errors -> certificate_invalid with the code", async () => {
  for (const code of ["CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT"]) {
    const { outcome, socket } = withFake((s) => s.emit("error", tlsError(code, "boom")));
    assert.deepEqual(await outcome, { kind: "certificate_invalid", code, message: "boom" });
    assert.equal(socket.destroyed, true);
  }
});

test("a TLS alert -> handshake_refused", async () => {
  const { outcome } = withFake((s) => {
    s.emit("connect");
    s.emit("error", tlsError("ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR"));
  });
  assert.equal((await outcome).kind, "handshake_refused");
});

test("connection failures -> unreachable", async () => {
  for (const code of ["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ECONNRESET", "ETIMEDOUT"]) {
    const { outcome } = withFake((s) => s.emit("error", tlsError(code)));
    assert.deepEqual(await outcome, { kind: "unreachable", code, message: code });
  }
  const noCode = withFake((s) => s.emit("error", new Error("mystery")));
  assert.deepEqual(await noCode.outcome, { kind: "unreachable", code: "EUNKNOWN", message: "mystery" });
  const closed = withFake((s) => s.emit("close"));
  assert.equal((await closed.outcome).kind, "unreachable");
});

test("a timeout is unreachable, and says whether TCP had connected", async () => {
  const never = withFake(() => undefined, { timeoutMs: 20 });
  const a = await never.outcome;
  assert.equal(a.kind, "unreachable");
  assert.equal(a.kind === "unreachable" && a.code, "ETIMEDOUT");
  assert.equal(never.socket.destroyed, true);

  // Connected, then held: what a first handshake looks like while the edge
  // is still obtaining the certificate.
  const held = withFake((s) => s.emit("connect"), { timeoutMs: 20 });
  const b = await held.outcome;
  assert.equal(b.kind === "unreachable" && b.code, "HANDSHAKE_TIMEOUT");
});

test("a connect that throws synchronously is an outcome, not an exception", async () => {
  const outcome = await probeTlsCertificate({
    address: "137.66.10.1",
    servername: "api.customer.com",
    timeoutMs: 1_000,
    connect: () => {
      throw tlsError("ERR_OSSL_PEM_NO_START_LINE", "bad ca");
    },
  });
  assert.deepEqual(outcome, { kind: "unreachable", code: "ERR_OSSL_PEM_NO_START_LINE", message: "bad ca" });
});

test("only the first event counts; later ones are ignored", async () => {
  const { outcome } = withFake((s) => {
    s.emit("error", tlsError("CERT_HAS_EXPIRED"));
    s.emit("secureConnect");
    s.emit("close");
  });
  assert.equal((await outcome).kind, "certificate_invalid");
});

function httpResponse(status: string, body: string, extraHeaders = ""): string {
  return `HTTP/1.1 ${status}\r\nContent-Type: application/json\r\n${extraHeaders}Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

test("with a proof: the request goes over the same socket and the answer is checked", async () => {
  const good = JSON.stringify({ domain: "api.customer.com", proof: PROOF.expected });
  const { outcome, socket } = withFake(
    (s) => {
      s.emit("secureConnect");
      s.emit("data", Buffer.from(httpResponse("200 OK", good)));
      s.emit("end");
    },
    { proof: PROOF },
  );
  const result = await outcome;
  assert.equal(result.kind === "valid" && result.proof, "ok");
  assert.equal(socket.written.length, 1);
  assert.match(socket.written[0]!, /^GET \/\.well-known\/wheelsai-domain HTTP\/1\.1\r\nHost: api\.customer\.com\r\n/);
  assert.match(socket.written[0]!, /Connection: close\r\n\r\n$/);
});

test("a proof mismatch is not ok", async () => {
  const answers = [
    httpResponse("200 OK", JSON.stringify({ domain: "api.customer.com", proof: "0".repeat(64) })),
    httpResponse("200 OK", JSON.stringify({ domain: "other.customer.com", proof: PROOF.expected })),
    httpResponse("200 OK", "<html>hello</html>"),
    httpResponse("404 Not Found", JSON.stringify({ error: "custom_domain_not_active" })),
    httpResponse("308 Permanent Redirect", ""),
  ];
  for (const answer of answers) {
    const { outcome } = withFake(
      (s) => {
        s.emit("secureConnect");
        s.emit("data", answer);
        s.emit("end");
      },
      { proof: PROOF },
    );
    const result = await outcome;
    assert.equal(result.kind, "valid");
    assert.equal(result.kind === "valid" && result.proof, "mismatch", answer.slice(0, 30));
  }
});

test("an edge that cannot reach the API, or goes quiet, is upstream_unavailable - the certificate still stands", async () => {
  for (const status of ["502 Bad Gateway", "503 Service Unavailable", "504 Gateway Timeout"]) {
    const { outcome } = withFake(
      (s) => {
        s.emit("secureConnect");
        s.emit("data", httpResponse(status, ""));
        s.emit("end");
      },
      { proof: PROOF },
    );
    const result = await outcome;
    assert.equal(result.kind === "valid" && result.proof, "upstream_unavailable", status);
  }
  const quiet = withFake((s) => s.emit("secureConnect"), { proof: PROOF, timeoutMs: 20 });
  const a = await quiet.outcome;
  assert.equal(a.kind === "valid" && a.proof, "upstream_unavailable");

  const reset = withFake(
    (s) => {
      s.emit("secureConnect");
      s.emit("error", tlsError("ECONNRESET"));
    },
    { proof: PROOF },
  );
  const b = await reset.outcome;
  assert.equal(b.kind === "valid" && b.proof, "upstream_unavailable");
});

test("an oversized answer is cut off and is not the proof", async () => {
  const { outcome, socket } = withFake(
    (s) => {
      s.emit("secureConnect");
      for (let i = 0; i < 40 && !s.destroyed; i++) s.emit("data", "x".repeat(1024));
    },
    { proof: PROOF },
  );
  const result = await outcome;
  assert.equal(result.kind, "valid");
  assert.notEqual(result.kind === "valid" && result.proof, "ok");
  assert.equal(socket.destroyed, true);
});

test("judgeProofResponse reads chunked bodies", () => {
  const body = JSON.stringify({ domain: "api.customer.com", proof: PROOF.expected });
  const chunked =
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n" +
    `${body.slice(0, 10).length.toString(16)}\r\n${body.slice(0, 10)}\r\n` +
    `${body.slice(10).length.toString(16)}\r\n${body.slice(10)}\r\n0\r\n\r\n`;
  assert.equal(judgeProofResponse(chunked, "api.customer.com", PROOF.expected), "ok");
  assert.equal(judgeProofResponse("", "api.customer.com", PROOF.expected), "upstream_unavailable");
  assert.equal(judgeProofResponse("garbage", "api.customer.com", PROOF.expected), "upstream_unavailable");
});

// ---------------------------------------------------------------------------
// Real TLS on loopback
// ---------------------------------------------------------------------------

interface Served {
  cert: string;
  key: string;
  /** Raw HTTP answer to anything received; omitted = close after the handshake. */
  respond?: (request: string) => string;
}

async function withServer<T>(served: Served, run: (port: number) => Promise<T>): Promise<T> {
  const sockets = new Set<tls.TLSSocket>();
  const server = tls.createServer({ cert: served.cert, key: served.key }, (socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    if (!served.respond) {
      // Read and discard, so the socket notices when the client goes away.
      socket.resume();
      return;
    }
    socket.once("data", (data) => {
      socket.end(served.respond!(data.toString("utf8")));
    });
  });
  server.on("tlsClientError", () => undefined);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run((server.address() as AddressInfo).port);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const probeLocal = (port: number, over: Partial<Parameters<typeof probeTlsCertificate>[0]> = {}) =>
  probeTlsCertificate({
    address: "127.0.0.1",
    port,
    servername: FIXTURE_HOSTNAME,
    timeoutMs: 5_000,
    ca: FIXTURE_CA_PEM,
    ...over,
  });

test("real handshake: a certificate that chains to a trusted root, for the right name -> valid", async () => {
  const outcome = await withServer(VALID_LEAF, (port) => probeLocal(port));
  assert.equal(outcome.kind, "valid");
  if (outcome.kind !== "valid") return;
  assert.equal(outcome.proof, "not_requested");
  assert.equal(outcome.certificate.issuer, FIXTURE_ISSUER);
  assert.deepEqual(outcome.certificate.altNames, [FIXTURE_HOSTNAME]);
  assert.match(outcome.certificate.fingerprint256, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  assert.ok(outcome.certificate.validFrom.getTime() < Date.now());
  assert.equal(outcome.certificate.validTo.getUTCFullYear(), 2126);
});

test("real handshake: the same certificate asked for under another name -> ERR_TLS_CERT_ALTNAME_INVALID", async () => {
  const outcome = await withServer(VALID_LEAF, (port) => probeLocal(port, { servername: "other.customer-fixture.com" }));
  assert.equal(outcome.kind, "certificate_invalid");
  assert.equal(outcome.kind === "certificate_invalid" && outcome.code, "ERR_TLS_CERT_ALTNAME_INVALID");
});

test("real handshake: an expired certificate -> CERT_HAS_EXPIRED", async () => {
  const outcome = await withServer(EXPIRED_LEAF, (port) => probeLocal(port));
  assert.equal(outcome.kind, "certificate_invalid");
  assert.equal(outcome.kind === "certificate_invalid" && outcome.code, "CERT_HAS_EXPIRED");
});

test("real handshake: a certificate that chains to no trusted root fails verification", async () => {
  const selfSigned = await withServer(SELF_SIGNED_LEAF, (port) => probeLocal(port));
  assert.equal(selfSigned.kind, "certificate_invalid");
  assert.equal(selfSigned.kind === "certificate_invalid" && selfSigned.code, "DEPTH_ZERO_SELF_SIGNED_CERT");

  // The fixture CA is not a public root: without `ca` (how production
  // probes) even the "valid" fixture is rejected.
  const publicRootsOnly = await withServer(VALID_LEAF, (port) => probeLocal(port, { ca: undefined }));
  assert.equal(publicRootsOnly.kind, "certificate_invalid");
});

test("real handshake: nothing listening -> unreachable", async () => {
  const port = await withServer(VALID_LEAF, async (p) => p);
  const outcome = await probeLocal(port, { timeoutMs: 2_000 });
  assert.equal(outcome.kind, "unreachable");
});

test("real handshake + proof: the answer over the same connection is checked", async () => {
  const body = JSON.stringify({ domain: FIXTURE_HOSTNAME, proof: PROOF.expected });
  let seen = "";
  const ok = await withServer(
    {
      ...VALID_LEAF,
      respond: (request) => {
        seen = request;
        return httpResponse("200 OK", body, "Connection: close\r\n");
      },
    },
    (port) => probeLocal(port, { proof: PROOF }),
  );
  assert.equal(ok.kind === "valid" && ok.proof, "ok");
  assert.match(seen, new RegExp(`^GET /\\.well-known/wheelsai-domain HTTP/1\\.1\\r\\nHost: ${FIXTURE_HOSTNAME}\\r\\n`));

  const wrong = await withServer(
    { ...VALID_LEAF, respond: () => httpResponse("200 OK", JSON.stringify({ domain: FIXTURE_HOSTNAME, proof: "nope" })) },
    (port) => probeLocal(port, { proof: PROOF }),
  );
  assert.equal(wrong.kind === "valid" && wrong.proof, "mismatch");

  const bad = await withServer(
    { ...VALID_LEAF, respond: () => httpResponse("502 Bad Gateway", "") },
    (port) => probeLocal(port, { proof: PROOF }),
  );
  assert.equal(bad.kind === "valid" && bad.proof, "upstream_unavailable");

  // A server that completes the handshake and never answers.
  const silent = await withServer(VALID_LEAF, (port) => probeLocal(port, { proof: PROOF, timeoutMs: 300 }));
  assert.equal(silent.kind === "valid" && silent.proof, "upstream_unavailable");
});
