/**
 * One rule for "the network failed": a request that got no answer, as
 * opposed to an answer that says no. Whoever sends a request again after a
 * failure (the Nosana lifecycle, the chat runtime) asks here, so the two never
 * disagree about what is worth another try.
 */

/** Error codes of a request that got no answer: a name that did not resolve, a connection that was never made or was dropped. */
export const NETWORK_FAILURE_CODES: ReadonlySet<string> = new Set([
  "EAI_AGAIN",
  "ENOTFOUND",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ETIMEDOUT",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/** How far down causes and members the search goes; real errors nest two or three deep. */
const MAX_DEPTH = 6;

function findCode(err: unknown, depth: number, seen: Set<object>): string | undefined {
  if (depth >= MAX_DEPTH || typeof err !== "object" || err === null || seen.has(err)) return undefined;
  seen.add(err);
  // An abort is a decision (the person left, a deadline passed), whatever it
  // carries as its cause. It is never a reason to send again.
  if ((err as { name?: unknown }).name === "AbortError") return undefined;

  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && NETWORK_FAILURE_CODES.has(code)) return code;

  const viaCause = findCode((err as { cause?: unknown }).cause, depth + 1, seen);
  if (viaCause) return viaCause;

  // Node tries every address of a host and reports the lot as one
  // AggregateError; its own code is usually set, but not always.
  const members = (err as { errors?: unknown }).errors;
  if (Array.isArray(members)) {
    for (const member of members) {
      const viaMember = findCode(member, depth + 1, seen);
      if (viaMember) return viaMember;
    }
  }
  return undefined;
}

/**
 * The network failure code `err` carries, or undefined when it is not one.
 * fetch wraps the socket error ("fetch failed" caused by
 * `getaddrinfo EAI_AGAIN ...`, or by an AggregateError [ETIMEDOUT] with an
 * empty message when no address connected in time), so the error, its chain
 * of causes and the members of an AggregateError are all looked at.
 */
export function networkFailureCode(err: unknown): string | undefined {
  return findCode(err, 0, new Set());
}

/** Whether `err` is a network failure and not an answer from the other side. */
export function isNetworkFailure(err: unknown): boolean {
  return networkFailureCode(err) !== undefined;
}
