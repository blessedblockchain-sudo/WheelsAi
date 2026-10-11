import net from "node:net";

/**
 * How long Node gives one attempt to connect before it tries the host's next
 * address (the other address family). Node's own 250 ms is too short on a
 * slow link, and on one where IPv6 is advertised but does not work: every
 * attempt runs out and the request fails with an AggregateError [ETIMEDOUT]
 * although the host is up. It is a process-wide default, so it covers fetch
 * and every client library alike, and it must be set before anything connects
 * out.
 */
export function allowOutboundConnectAttempts(timeoutMs: number): void {
  net.setDefaultAutoSelectFamilyAttemptTimeout(timeoutMs);
}
