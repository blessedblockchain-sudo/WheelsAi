/**
 * Certificate probe: one TLS handshake with the edge for one hostname, and
 * what it showed.
 *
 * This is the only source of a custom domain's certificate status. It connects
 * to an address the caller chose (the composition root passes configured edge
 * addresses and nothing else), presents the customer's hostname as SNI, and
 * verifies the certificate exactly as a client would: against the trust roots,
 * for that name, for today's date. The issuer, validity window and fingerprint
 * it reports are read from the certificate the handshake presented.
 *
 * With `proof` set it then sends one request over the same connection and
 * checks the answer, which shows that the edge forwards this hostname to this
 * API rather than merely holding a certificate for it.
 *
 * It never throws, and it classifies conservatively: only a failure the TLS
 * layer itself reported is a statement about the certificate. A refused
 * connection or a timeout is "unreachable", which changes nothing.
 */

import tls from "node:tls";

import {
  classifyProbeError,
  type ObservedCertificate,
  type ProofResult,
  type TlsProbeOutcome,
} from "./customDomainRules.js";

/** The slice of tls.TLSSocket the probe uses. */
export interface TlsSocketLike {
  on: (event: string, listener: (...args: never[]) => void) => unknown;
  write: (data: string) => unknown;
  destroy: () => unknown;
  getPeerCertificate: () => {
    issuer?: Record<string, string | string[] | undefined>;
    valid_from?: string;
    valid_to?: string;
    fingerprint256?: string;
    subjectaltname?: string;
  };
}

export interface TlsProbeProof {
  /** Request path, e.g. /.well-known/wheelsai-domain. */
  path: string;
  /** The value the JSON answer's `proof` must carry. */
  expected: string;
}

export interface TlsProbeInput {
  /** IP address to connect to. */
  address: string;
  /** The customer hostname: sent as SNI and checked against the certificate. */
  servername: string;
  port?: number;
  timeoutMs: number;
  proof?: TlsProbeProof;
  /** Trust roots replacing the defaults. Tests and staging only. */
  ca?: string | string[];
  /** Injected by tests. */
  connect?: (options: tls.ConnectionOptions) => TlsSocketLike;
}

/** The proof answer is a few dozen bytes of JSON; anything larger is not it. */
const MAX_RESPONSE_BYTES = 16 * 1024;

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function issuerName(issuer: Record<string, string | string[] | undefined> | undefined): string {
  const pick = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  const organization = pick(issuer?.O);
  const commonName = pick(issuer?.CN);
  if (organization && commonName) return `${organization} ${commonName}`;
  return organization ?? commonName ?? "unknown";
}

function readCertificate(socket: TlsSocketLike): ObservedCertificate | null {
  const cert = socket.getPeerCertificate();
  const validFrom = new Date(cert.valid_from ?? "");
  const validTo = new Date(cert.valid_to ?? "");
  if (!cert.fingerprint256 || Number.isNaN(validFrom.getTime()) || Number.isNaN(validTo.getTime())) {
    return null;
  }
  return {
    issuer: issuerName(cert.issuer),
    validFrom,
    validTo,
    fingerprint256: cert.fingerprint256,
    altNames: (cert.subjectaltname ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.startsWith("DNS:"))
      .map((entry) => entry.slice(4).toLowerCase()),
  };
}

function dechunk(body: string): string {
  let rest = body;
  let out = "";
  for (;;) {
    const lineEnd = rest.indexOf("\r\n");
    if (lineEnd === -1) return out;
    const size = Number.parseInt(rest.slice(0, lineEnd), 16);
    if (!Number.isFinite(size) || size <= 0) return out;
    out += rest.slice(lineEnd + 2, lineEnd + 2 + size);
    rest = rest.slice(lineEnd + 2 + size + 2);
  }
}

/** Judges the raw HTTP/1.1 answer to the proof request. */
export function judgeProofResponse(raw: string, servername: string, expected: string): ProofResult {
  const headerEnd = raw.indexOf("\r\n\r\n");
  const head = headerEnd === -1 ? raw : raw.slice(0, headerEnd);
  const status = /^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1];
  if (!status) return "upstream_unavailable";
  // The edge's own answer when it cannot reach the API.
  if (status === "502" || status === "503" || status === "504") return "upstream_unavailable";
  if (status !== "200" || headerEnd === -1) return "mismatch";

  let body = raw.slice(headerEnd + 4);
  if (/^transfer-encoding:\s*chunked\s*$/im.test(head)) body = dechunk(body);
  try {
    const parsed = JSON.parse(body) as { domain?: unknown; proof?: unknown };
    return parsed.domain === servername && parsed.proof === expected ? "ok" : "mismatch";
  } catch {
    return "mismatch";
  }
}

export function probeTlsCertificate(input: TlsProbeInput): Promise<TlsProbeOutcome> {
  return new Promise<TlsProbeOutcome>((resolve) => {
    let settled = false;
    let socket: TlsSocketLike | null = null;
    let timer: NodeJS.Timeout | null = null;
    let connected = false;
    let certificate: ObservedCertificate | null = null;
    let response = "";

    const finish = (outcome: TlsProbeOutcome) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        socket?.destroy();
      } catch {
        // Already gone.
      }
      resolve(outcome);
    };

    const finishProof = (fallback: ProofResult) => {
      if (!certificate) return;
      const proof =
        input.proof && response
          ? judgeProofResponse(response, input.servername, input.proof.expected)
          : fallback;
      finish({ kind: "valid", certificate, proof });
    };

    timer = setTimeout(() => {
      // The certificate was already seen and verified; only the proof is missing.
      if (certificate) return finishProof("upstream_unavailable");
      finish({
        kind: "unreachable",
        code: connected ? "HANDSHAKE_TIMEOUT" : "ETIMEDOUT",
        message: connected
          ? `the TLS handshake did not finish within ${input.timeoutMs} ms`
          : `no connection within ${input.timeoutMs} ms`,
      });
    }, input.timeoutMs);

    try {
      const connect =
        input.connect ??
        ((options: tls.ConnectionOptions) => tls.connect(options) as unknown as TlsSocketLike);
      socket = connect({
        host: input.address,
        port: input.port ?? 443,
        servername: input.servername,
        // The whole point: a certificate a client would reject is not valid.
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
        ALPNProtocols: ["http/1.1"],
        ...(input.ca !== undefined ? { ca: input.ca } : {}),
      });

      socket.on("connect", () => {
        connected = true;
      });

      socket.on("secureConnect", () => {
        connected = true;
        certificate = readCertificate(socket!);
        if (!certificate) {
          return finish({
            kind: "certificate_invalid",
            code: "CERT_UNREADABLE",
            message: "the peer certificate could not be read",
          });
        }
        if (!input.proof) return finish({ kind: "valid", certificate, proof: "not_requested" });
        socket!.write(
          `GET ${input.proof.path} HTTP/1.1\r\n` +
            `Host: ${input.servername}\r\n` +
            "Accept: application/json\r\n" +
            "User-Agent: wheelsai-domain-check\r\n" +
            "Connection: close\r\n\r\n",
        );
      });

      socket.on("data", ((chunk: Buffer | string) => {
        response += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        if (response.length >= MAX_RESPONSE_BYTES) {
          response = response.slice(0, MAX_RESPONSE_BYTES);
          finishProof("mismatch");
        }
      }) as (...args: never[]) => void);

      socket.on("end", () => finishProof("upstream_unavailable"));
      socket.on("close", () => {
        if (certificate) return finishProof("upstream_unavailable");
        finish({
          kind: "unreachable",
          code: "ECONNRESET",
          message: "the connection closed before the handshake finished",
        });
      });

      socket.on("error", ((error: unknown) => {
        // After a verified handshake the certificate stands; the connection
        // dying only costs the proof.
        if (certificate) return finishProof("upstream_unavailable");
        const code = errorCode(error);
        finish({
          kind: classifyProbeError(code),
          code: code ?? "EUNKNOWN",
          message: errorMessage(error),
        });
      }) as (...args: never[]) => void);
    } catch (error) {
      // tls.connect throws synchronously on unusable options (a malformed CA).
      finish({ kind: "unreachable", code: errorCode(error) ?? "EUNKNOWN", message: errorMessage(error) });
    }
  });
}
