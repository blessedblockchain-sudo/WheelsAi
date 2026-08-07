# Wallet Top-Up — Devnet Proof Run (B2/T5)

**Date:** 2026-08-07
**Verdict:** one wallet top-up driven end-to-end through the production
route + bindings code against real devnet — prepared, wallet-signed,
byte-equality-verified, broadcast, confirmed on-chain, credited exactly
once. First attempt, no retries.

## What ran

`apps/api/scripts/run-topup-devnet.ts` registers the exact objects
`index.ts` mounts — `createWalletTopupRoutes(buildProductionWalletTopupDeps())`
— and drives them via `fastify.inject`. The **only** substitution is the
browser wallet: the script signs the prepared transaction with the
devnet payer keypair, performing precisely what wallet-adapter performs
(deserialize → sign → reserialize). Deposit derivation, byte-equality
verification, the claim CAS, broadcast, confirmation, and the
exactly-once credit grant are all unmodified production code against
real devnet RPC and the real database.

Env for the run: `WALLET_TOPUPS_ENABLED=true`,
`ALLOW_DEVNET_WALLET_TOPUPS=true` (dev only — boot-fatal in
production), `WALLET_TOPUP_SOL_PRICE_USD=1000` (operator-stated devnet
quote, recorded on the row).

## Cast

| Role | Value |
| --- | --- |
| Org (tenant) | `73622248-2eaf-4450-a9f9-5215bfcbd5a0` (WheelsHelper's org) |
| Payer (simulated browser wallet) | `2BFEMhwhA1hakQ4J7P4tNeMQZW4k3J6tziumWncVobkH` (`.devnet/payer.json`) |
| Deposit address (HKDF `wheelsai-topup-v1`, info=orgId) | `DaF23nvAcfbphDgpf26tvfZ4frqR6V8D7z1v62izKcB3` |
| Topup row | `5b379e5d-267b-4d73-a4d8-150607b276d8` |
| Purchase | $50 SOL rail @ $1000/SOL quote → **50,000,000 lamports (0.05 SOL)**, bonus $5 (ladder tier) |

## The transaction

| Fact | Value |
| --- | --- |
| Signature | `4Sns3dNFfy9FZSZ7GcTzVSnLyK1ictxA3wmtC5Wjpq8dK6Wso6TiafXP2P5GPbUzDkuAvWG3HRwKd4zxGVG3yzrd` |
| Slot | 481913236 |
| Explorer | https://explorer.solana.com/tx/4Sns3dNFfy9FZSZ7GcTzVSnLyK1ictxA3wmtC5Wjpq8dK6Wso6TiafXP2P5GPbUzDkuAvWG3HRwKd4zxGVG3yzrd?cluster=devnet |

On-chain verification (from `getParsedTransaction`, not from our own
bookkeeping): the deposit address received **exactly** the row's
`amountRaw` (50,000,000 lamports), and the transaction logs carry the
memo `wheelsai-topup:5b379e5d-…` — the row id is pinned inside the
signed message itself.

## The money trail (database)

| Step | Record |
| --- | --- |
| Balance before | 500 cents |
| Ledger row 1 | `purchase` +5,000c, `balanceAfter` 5,500, `referenceId` = row id, `[devnet]`-labeled |
| Ledger row 2 | `bonus` +500c, `balanceAfter` 6,000, `referenceId` = row id, `[devnet]`-labeled |
| Balance after | 6,000 cents (moved by exactly amount+bonus) |
| Row terminal state | `status=credited`, `network=solana:devnet`, tx signature recorded |

The SQL trace shows the designed state machine verbatim: stale-prepared
sweep → row insert (`prepared`) → claim CAS (`prepared→submitting`,
**tx signature recorded in the same UPDATE**) → `submitting→submitted`
before the confirm wait → then ONE transaction containing the
`submitted→credited` CAS, the balance upsert, and both ledger inserts.
A crash at any point after the claim is recoverable from the chain by
signature (that's what `/topups/:id/reconcile` does); the credited CAS
makes the grant exactly-once under any submit/reconcile race.

## What this does and does not prove

Proven: the full production top-up path — per-org HKDF deposit
addressing, byte-equality acceptance (the wallet signed exactly what
the server prepared), broadcast + confirmation against real devnet, and
the atomic exactly-once credit grant with an auditable ledger.

Not proven here: the USDC asset path on-chain (same machinery, SPL
transferChecked instead of a system transfer; unit-tested but the
devnet run needs USDC from faucet.circle.com — a user action), and a
real browser wallet UI driving it (T6, next). The SOL rail itself is a
devnet testing rail by design — production is USDC-only, where 1 USDC =
$1 and no price quote exists in the path at all.
