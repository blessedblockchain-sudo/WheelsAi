# x402 Pay-Per-Request — Devnet Proof Run (B4/T7)

**Date:** 2026-08-08 (run timestamps 2026-08-07 UTC)
**Verdict:** one x402-paid inference round trip driven end-to-end through
the production route code on devnet — 402 challenge, client-signed
payment broadcast + confirmed on-chain, inference served, payment row
settled by the production settlement worker. First attempt, no retries.

## What ran

`apps/api/scripts/x402-devnet-proof.ts` registers the production
`inferenceRoutes` plugin (the exact object `index.ts` mounts at `/v1/*`)
and drives the full HTTP cycle via `fastify.inject`:

1. `POST /v1/x402-proof/chat/completions` **without** `X-Payment` →
   **402** carrying the payment requirement (production
   `resolveBilling` + `generatePaymentRequirement`).
2. The client signs the exact SOL transfer the requirement asks for
   (payer → platform treasury, exact lamports).
3. Same POST **with** `X-Payment` → `verifyPayment` **broadcasts the
   payment on devnet and confirms it** (`X402_SUBMIT_TRANSACTIONS=true`),
   persists the `X402Payment` row, proxies the inference, returns the
   completion. Row = `verified`.
4. `runX402SettlementTick()` — the exact function the BullMQ worker
   runs — checks on-chain finality and flips `verified → settled`
   (tick log: scanned 1, settled 1, failed 0).
5. On-chain verification from `getParsedTransaction`: the treasury
   received **exactly** the required lamports.

Two substitutions, both at documented seams (same class as the D10
sim-host):

- **The GPU node** is a localhost HTTP server returning an OpenAI-shaped
  completion — devnet has no payable Nosana hosts (C1 covers real ones).
  The URL passes the route's own SSRF allowlist (dev-only localhost
  pattern); auth, billing resolution, payment verification, proxying,
  and usage recording are all the production path.
- **The paying client** is the script signing with the devnet payer —
  exactly what an x402-capable client does.

Env for the run: `X402_ENABLED=true`, `X402_INFERENCE_MODE=required`,
`X402_DEFAULT_ASSET=SOL`, `X402_SUBMIT_TRANSACTIONS=true`,
`TREASURY_WALLET_ADDRESS=<devnet treasury below>`.

## Cast

| Role | Value |
| --- | --- |
| Org (tenant) | `73622248-2eaf-4450-a9f9-5215bfcbd5a0` (same proof tenant as D10 / the wallet top-up run) |
| Payer (the x402 client) | `2BFEMhwhA1hakQ4J7P4tNeMQZW4k3J6tziumWncVobkH` (`.devnet/payer.json`) |
| Platform treasury | `4bV1ThwA1EmkParAiZVepNe2EyPoPb5SDphpKY5wW15m` (`.devnet/treasury.json`, funded 0.005 SOL rent so micro-payments can land) |
| Deployment | slug `x402-proof`, model `llama-3.1-8b`, localhost mock node |
| Requirement | SOL, **667 lamports** ($0.0001 — the minimum charge) |
| Payment row | `0e2ddb01-b199-4e0f-a100-ffe4d1717c00`, request `x402_3e1f5b43-4871-4140-b4e8-602c5d9bd720` |

## The transaction

| Fact | Value |
| --- | --- |
| Signature | `3Fvn51geJuHhjgCu2aK5SrmKAaUM8BdpU6mzE2yHRVMLSHFWrnR5M2VLiqLPKTHrYpCC4YyRzwZgbYBRHkXN7zFY` |
| Slot | 481962155 |
| Status | **Finalized** (independently confirmed with `solana confirm`) |
| Explorer | https://explorer.solana.com/tx/3Fvn51geJuHhjgCu2aK5SrmKAaUM8BdpU6mzE2yHRVMLSHFWrnR5M2VLiqLPKTHrYpCC4YyRzwZgbYBRHkXN7zFY?cluster=devnet |

Timeline: `verifiedAt 2026-08-07T23:02:07.438Z` →
`settledAt 2026-08-07T23:02:08.444Z` — the settlement worker's first
tick found finality one second after verification.

Treasury balance after the run: **0.005000667 SOL** — the 0.005 rent
funding plus exactly the 667-lamport payment. The chain arithmetic
closes to the lamport.

## The T7 siblings shipped with this proof

- **Boot assertion:** `TREASURY_WALLET_ADDRESS` defaults to the all-ones
  System Program address — an address nobody controls. `X402_ENABLED`
  with that default (or any malformed address) is now **boot-fatal in
  every environment**; before this, an enabled rail would have directed
  every client payment into a black hole.
- **Sybil discount:** settled x402 payments attributed to an agent now
  discount its token-launch reputation requirement (1 point per settled
  payment, capped at 25 = half the default bar) in BOTH eligibility
  paths — the enforcement gate and the public transparency badge. A
  settled payment is money that verifiably left a wallet into the
  platform treasury, so the signal is costly by construction; this run
  produced the first such settled payment.

## What this does and does not prove

Proven: the complete x402 rail — 402 challenge from the real inference
route, instruction-level payment verification against the requirement,
real broadcast + confirmation, replay-guarded persistence, and the
production settlement worker closing `verified → settled` against chain
finality.

Not proven here: a real GPU node serving the paid inference (the C1
mainnet spike's territory), USDC/NOS asset paths on-chain (same
machinery, SPL transfer verification; devnet USDC needs the Circle
faucet), and a real external client wallet driving the flow. The SOL
pricing uses the placeholder oracle's fallback quote — fine for devnet;
the production default asset is USDC, which needs no oracle.
