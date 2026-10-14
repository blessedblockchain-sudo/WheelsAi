# A deployment paid per request from a wallet: how it works and how to prove it

This page covers a deployment's own wallet payment: one `/v1` request to a deployment billed
per request, paid with one on-chain transfer, following HTTP 402 in WheelsAI's own headers
`X-Payment-Required` and `X-Payment`. Its settings and code keep the name x402, but it is not
the published x402 format, and the public docs call it paying a deployment per request from a
wallet. The x402 door of an agent's listing (one use paid from a wallet in the published
format, version 2) is a different path: it is proven by
`apps/api/scripts/payments-proof/walk-devnet-x402.cjs`, run as `docs/PAYMENTS-RUN.md` says.
This page is for whoever runs the API: what happens to a payment, the settings, the proof
script, and the record of the first devnet run. The customer's side (the 402 body, the
`X-Payment` header, the reasons a payment is refused) is in the API reference at
`/docs/api/inference#deployment-wallet`.

## What happens to a payment

1. A request with no payment is answered `402` with the price: USDC base units to the
   treasury's USDC token account (`payToTokenAccount`, with the `mint`), or lamports to the
   treasury wallet with a `quote` that holds the SOL price the amount was worked out at.
   The asset is `X402_DEFAULT_ASSET`. When that is SOL and no fresh SOL price can be read,
   the request is asked for USDC instead.
2. The paid retry is checked before anything is touched: the deployment has a healthy node
   and the node at `SOLANA_RPC_URL` answers for the chain in `SOLANA_NETWORK`. If not, the
   request is refused with `503` and the payment is not looked at.
3. The signed transaction is read: legacy or version 0, no address lookup tables, every
   signature valid, one transfer that pays the right destination at least the price (a
   plain or a checked USDC transfer, or a System Program transfer for SOL). For SOL the
   price is turned into lamports at the rate in the `quote`; a quote that is missing,
   expired or for another organization or deployment is `quote_expired`. A payment that
   is refused here is never sent.
4. The payment's row is written as `submitted`, with the signature and the signed bytes,
   and only then is the transaction sent. A signature that already has a row is `409`.
5. The request waits up to `X402_CONFIRM_WAIT_MS` for the chain's verdict. Landed: the row
   is `verified` and the request is served. Landed and failed: `failed`, and the answer is a
   `402` with `payment_failed_on_chain`. Not known in time: the row stays `submitted`, the
   answer is a `402` with `payment_not_confirmed`, and the settlement worker finishes it.
6. A served request sets `servedAt`. A request that produced no answer has its payment
   **returned**: the row goes to `refunded`, and what was actually sent is credited to the
   organization (below).
7. The settlement worker reads the chain and nothing else. A `submitted` payment that
   landed is returned (its request already answered "not confirmed"); one that failed, or
   never landed and is older than 3 minutes, is `failed`. A served `verified` payment
   becomes `settled` once it is final. A `verified` payment with no `servedAt` after 10
   minutes is returned. A payment whose fate cannot be read is left for the next run,
   however many runs that takes.

### Returned

A return is a credit, never a transfer back on the chain: the payment stays in the
treasury. In one database transaction the row goes to `refunded` with `refundedAt` and
`refundMicroUsd` (what was sent, in millionths of a dollar: USDC base units as they are,
lamports at the row's rate rounded down), and the organization's
`x402RefundCarryMicroUsd` grows by that. Whole cents in the carry (10,000 millionths a
cent) move to the balance with one ledger row of type `x402_refund`, "Paid request
returned as credits", whose reference is the payment's id; the rest stays in the carry.
A request usually costs less than a cent, so several returns pass before a ledger row
appears. A payment is returned at most once, and never after it was served.

In the log: a request that returns its own payment writes "x402 payment returned as
credits" with the payment's id and `refundMicroUsd`; the settlement worker's line
"Completed X402 settlement tick" counts the payments that run returned in its `returned`
field, beside `settled`, `failed` and `waiting`.

## Settings

| Setting | What it does |
| --- | --- |
| `X402_ENABLED`, `X402_INFERENCE_MODE` | On or off, and `fallback` (credits first) or `required` (every request is paid). |
| `X402_DEFAULT_ASSET` | `USDC` (default) or `SOL`. The API refuses to start with x402 on and `NOS`, and with `SOL` while `SOL_PRICE_SOURCE=off`. |
| `X402_QUOTE_TTL_SECONDS` | 120 (30 to 600). How long the SOL price in a 402 holds for the paid retry. |
| `X402_CONFIRM_WAIT_MS` | 30000 (1000 to 120000). How long a paid request waits for its payment to land. |
| `X402_SUBMIT_TRANSACTIONS` | Must be `true` outside development. Off (development only), nothing is sent and nothing is read from the chain: a payment that reads correctly is taken as landed. |
| `X402_SETTLEMENT_WORKER_ENABLED` | Must be `true` outside development: the worker settles served payments and finishes or returns the rest. |
| `TREASURY_WALLET_ADDRESS` | Who is paid. A real address; its USDC token account must exist before the first USDC payment. |

## The proof script

`apps/api/scripts/x402-devnet-proof.ts` registers the production route
(`createInferenceRoutes`, what `index.ts` mounts at `/v1`) and drives it with
`fastify.inject`. It reads its chain from the settings: `SOLANA_NETWORK` and
`SOLANA_RPC_URL` choose the chain, `TREASURY_WALLET_ADDRESS` is who is paid, and the USDC
mint is the one the API uses for that network. It runs on devnet, on a local chain (which
must hold the devnet USDC mint for the USDC steps), and on mainnet with
`X402_PROOF_ALLOW_MAINNET=1` (it spends a fraction of a cent a step, plus fees). It needs a
development process: see the stand-in GPU node below.

    cd apps/api
    npx tsx scripts/x402-devnet-proof.ts <orgId> [USDC|SOL]

It prints `PASS` or `FAIL` for each step and exits non-zero if any step failed.

| Step | What must hold |
| --- | --- |
| USDC: the challenge | `402`, with the same requirement in the `X-Payment-Required` header, asking for USDC at the treasury's USDC token account, naming the chain's mint, with no quote. |
| USDC: a checked transfer | Accepted and served. The row is `verified` with the signature, the signed bytes, what was sent and `servedAt`; base units equal the price in millionths of a dollar. |
| USDC: the same signature again | `409` `payment_already_used`, and no new row. |
| USDC: the node fails | The answer is the node's error with `payment.status` "returned". The row is `refunded` for what was actually sent (the script sends 7 base units over the price), the carry and the balance together grow by exactly that, and there is one `x402_refund` ledger row only if a whole cent was crossed. |
| SOL: the challenge | `402`, asking for lamports at the treasury wallet, with a quote. |
| SOL: a transfer at the quoted rate | Accepted and served. The lamports asked for are the price at the rate on the row, rounded up. |
| SOL: the same signature again | `409`. |
| SOL: the node fails | Returned, valued at the row's rate, rounded down. |
| Settlement | The worker's own function (`runX402SettlementTick`) settles the served payments; the returned ones stay `refunded`; none of the run's payments is left `verified`. |
| The chain | Each transaction succeeded and moved exactly what was sent to the treasury (its USDC account, or the wallet). |

What stands in for the real thing, each at a seam the route already has:

- **The GPU node** is an HTTP server on `127.0.0.1` that answers with an OpenAI-shaped
  completion, or with a `500` for the steps that need a failing node. The route lets a
  node on this machine through only with `NODE_ENV=development` and
  `ALLOW_LOOPBACK_NODE_URLS=true`; without both the script stops before anything is paid.
- **The session** is given through the route's `auth` dependency: the organization named on
  the command line. Everything after authentication is the production path.
- **The paying client** is the script, signing with a local keypair
  (`X402_PAYER_KEYPAIR`, default `../../.devnet/payer.json`).
- **The asset.** The route asks for `X402_DEFAULT_ASSET`; to prove USDC and SOL in one run
  the script sets that setting inside its own process. With `USDC` or `SOL` as the second
  argument it proves that asset only and leaves the setting alone.

Settings for a run: `X402_ENABLED=true`, `X402_INFERENCE_MODE=required`,
`X402_SUBMIT_TRANSACTIONS=true`, `TREASURY_WALLET_ADDRESS`, `NODE_ENV=development`,
`ALLOW_LOOPBACK_NODE_URLS=true`, and for the SOL steps
`SOL_PRICE_SOURCE=pyth` (or `static` with `SOL_PRICE_STATIC_USD` on a local chain). The
payer needs a little SOL for fees and, for the USDC steps, at least 10,000 base units (one
cent) of the chain's USDC. If the treasury wallet or its USDC account does not exist yet,
the payer opens it first and pays the rent.

## Record: the devnet run of 2026-08-08

This is the record of the first run, kept as it was written except for its last
paragraph, which now says what that run left unproven. It was made with the script
and the route of that day: one SOL payment, priced from a fixed figure, settled by the
worker. The steps above (USDC, the SOL quote, returns, the second use) are not part of
this record.

**Date:** 2026-08-08 (run timestamps 2026-08-07 UTC)
**Verdict:** one x402-paid inference round trip driven end-to-end through
the production route code on devnet — 402 challenge, client-signed
payment broadcast + confirmed on-chain, inference served, payment row
settled by the production settlement worker. First attempt, no retries.

### What ran

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

### Cast

| Role | Value |
| --- | --- |
| Org (tenant) | `73622248-2eaf-4450-a9f9-5215bfcbd5a0` (same proof tenant as D10 / the wallet top-up run) |
| Payer (the x402 client) | `2BFEMhwhA1hakQ4J7P4tNeMQZW4k3J6tziumWncVobkH` (`.devnet/payer.json`) |
| Platform treasury | `4bV1ThwA1EmkParAiZVepNe2EyPoPb5SDphpKY5wW15m` (`.devnet/treasury.json`, funded 0.005 SOL rent so micro-payments can land) |
| Deployment | slug `x402-proof`, model `llama-3.1-8b`, localhost mock node |
| Requirement | SOL, **667 lamports** ($0.0001 — the minimum charge) |
| Payment row | `0e2ddb01-b199-4e0f-a100-ffe4d1717c00`, request `x402_3e1f5b43-4871-4140-b4e8-602c5d9bd720` |

### The transaction

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

### The T7 siblings shipped with this proof

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

### What this does and does not prove

Proven: the complete x402 rail — 402 challenge from the real inference
route, instruction-level payment verification against the requirement,
real broadcast + confirmation, replay-guarded persistence, and the
production settlement worker closing `verified → settled` against chain
finality.

Not proven by that run: a real GPU node serving the paid inference, a
USDC payment on-chain, and a real external client wallet driving the
flow. SOL was priced from a fixed figure in the code of that day; it is
priced from the live SOL price now (see the top of this page).
