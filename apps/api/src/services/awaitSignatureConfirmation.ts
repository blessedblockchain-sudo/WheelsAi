/**
 * Best-effort same-tick confirmation poll (remediation D6).
 *
 * Shared by the fee-router and reputation-attestation dep-builders: after
 * a claim-first broadcast, the worker polls getSignatureStatuses for a
 * SHORT injected window so the happy path settles within the same tick.
 * Hitting the timeout is NOT a failure — the row/batch stays SUBMITTED
 * and the next tick's recovery scan settles it from on-chain evidence
 * (landed → confirmed, expired+unseen → failed, else re-broadcast).
 *
 * Outcome mapping (same policy as pollComputePaymentConfirmation):
 *   - err present (any confirmationStatus)        → "failed" (landed,
 *     but the transaction errored on-chain — nothing transferred)
 *   - 'confirmed' | 'finalized' with err == null  → "confirmed"
 *   - null result / 'processed' / RPC throw       → keep polling; after
 *     timeoutMs → "timeout" (indeterminate — never invent a verdict)
 *
 * timeoutMs <= 0 degenerates to a single status check (used by tests and
 * by callers that want pure fire-and-forget with recovery-only settling).
 */

export type ConfirmationStatusLite =
  | "processed"
  | "confirmed"
  | "finalized"
  | null;

export interface SignatureStatusLite {
  confirmationStatus: ConfirmationStatusLite;
  err: unknown | null;
}

export type SignatureConfirmOutcome =
  | { status: "confirmed" }
  | { status: "failed"; error: string }
  | { status: "timeout" };

export interface AwaitSignatureConfirmationDeps {
  getSignatureStatus: (
    txSignature: string,
  ) => Promise<SignatureStatusLite | null>;
  /** Total polling budget. <= 0 → exactly one status check. */
  timeoutMs: number;
  pollIntervalMs: number;
  /** Injectable for deterministic tests; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock for deterministic tests; defaults to Date.now. */
  nowMs?: () => number;
}

function formatErr(err: unknown): string {
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export async function awaitSignatureConfirmation(
  txSignature: string,
  deps: AwaitSignatureConfirmationDeps,
): Promise<SignatureConfirmOutcome> {
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const nowMs = deps.nowMs ?? (() => Date.now());
  const startedAt = nowMs();

  for (;;) {
    let status: SignatureStatusLite | null = null;
    let rpcSilent = false;
    try {
      status = await deps.getSignatureStatus(txSignature);
    } catch {
      rpcSilent = true; // RPC blip — indeterminate, keep polling
    }

    if (!rpcSilent && status) {
      if (status.err !== null && status.err !== undefined) {
        return { status: "failed", error: formatErr(status.err) };
      }
      if (
        status.confirmationStatus === "confirmed" ||
        status.confirmationStatus === "finalized"
      ) {
        return { status: "confirmed" };
      }
      // 'processed' or null status — indeterminate, keep polling.
    }

    if (nowMs() - startedAt + deps.pollIntervalMs > deps.timeoutMs) {
      return { status: "timeout" };
    }
    await sleep(deps.pollIntervalMs);
  }
}
