# Creator Payout — Devnet Proof Run (W2 money keystone)

**Date:** 2026-08-08
**Verdict:** one creator payout driven end-to-end through the production
request + executor code on devnet — reserved, claimed, sent on-chain,
confirmed, completed, with the reservation consumed cleanly. First tick,
no retries. **This is the re-entry evidence for the "90% revenue"
claim** (the claim returns when the first real `CreatorPayout`
completes — it now has).

## What ran

`apps/api/scripts/run-payout-devnet.ts` calls the production
`requestPayout` and then `runPayoutExecutorTick` over
`buildPayoutExecutorTickDeps` — the exact objects the BullMQ payout
worker runs. The only substitution is the money-IN seam: the publisher's
`pendingPayoutCents` is seeded directly (the real caller, per-request
marketplace metering, is a separate keystone — the audit pairs metering
+ executor, and this proves the executor leg, exactly as D10 seeded
usage/trades). Everything from the reservation through the on-chain
transfer is unmodified production code against real devnet.

## The cycle

| Step | What happened |
| --- | --- |
| 1. Seed | `pendingPayoutCents = 5000` ($50) on the publisher profile (documented money-in seam) |
| 2. Request | `requestPayout(publisher, "crypto_sol", recipient)` — **reserved** the balance into a `pending` CreatorPayout row and zeroed `pendingPayoutCents` in one transaction (the fund-loss fix) |
| 3. Fund | HKDF payout wallet topped up from the devnet payer |
| 4. Execute | one `runPayoutExecutorTick`: claimed (pending → processing), built + signed + recorded-sig-before-broadcast + confirmed + completed. Result `{claimable:1, completed:1, pending:0, failed:0, skipped:0}` |
| 5. Verify | row `completed` with signature; `pendingPayoutCents` stayed 0; recipient received exactly the quoted lamports |

## Cast

| Role | Value |
| --- | --- |
| Publisher org | `73622248-2eaf-4450-a9f9-5215bfcbd5a0` (the proof tenant) |
| Payout wallet (HKDF, salt `wheelsai-payout-v1`) | `CkGsHQzifb4enJoi9JM2Ff3MbEATEDJN57K4KTyEMgLp` |
| Recipient (fresh creator wallet) | `3Z8cbQ79VbxuysDAcwmwykhBgKCokcD1Cz7ixjX8DLCf` |
| Payout row | `b64511e7-f29d-44e4-9eea-4826b4ca7b8a`, method `crypto_sol` |
| Amount | $50 @ $200/SOL quote → **250,000,000 lamports (0.25 SOL)** |

## The transaction

| Fact | Value |
| --- | --- |
| Signature | `38d2Noy2HbBM52tLSnYGYLPY42WXVcChcJfjbhQWAa8616gSH3wiK4yuCzU1WSQwVpYi66xc25FXBpP52GwcpmL5` |
| Status | **Finalized** (independently confirmed with `solana confirm`) |
| Explorer | https://explorer.solana.com/tx/38d2Noy2HbBM52tLSnYGYLPY42WXVcChcJfjbhQWAa8616gSH3wiK4yuCzU1WSQwVpYi66xc25FXBpP52GwcpmL5?cluster=devnet |

Recipient balance after the run: **0.25 SOL** — exactly the quoted
amount. The DB row is `completed`, `crypto_sol`, 5000 cents, `processedAt`
set. The reservation was consumed, not stranded and not wrongly restored.

## What this proves — and the precise gap

Proven: the entire money-OUT path — the atomic reservation (a payout
request can no longer strand or double-pay a creator's balance), the
claim-before-send CAS, the record-signature-before-broadcast recovery
discipline, real broadcast + confirmation, and the exactly-once
completion. The credits payout method is unit-tested (grant + complete
in one transaction, exactly-once) and needs no external funding.

**The gap, named precisely:** the money-IN caller. `recordMarketplaceUsage`
is a complete writer that accrues per-request marketplace revenue into
`pendingPayoutCents`, but it still has **zero callers** — there is no
installed-agent per-request execution path to invoke it from yet (a
marketplace install clones an agent, but nothing bills the buyer
per-request against the clone). Wiring that is a distinct Wave-2-sized
piece (second-party billing on the inference hot path); this run seeded
the balance rather than fabricating that caller. The executor that pays
the balance out — the harder, on-chain half — is done and proven.
