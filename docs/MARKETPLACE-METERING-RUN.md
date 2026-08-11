# Marketplace per-request metering — proof run

**Date:** 2026-08-11 · **Commit:** the W2 metering keystone
**Script:** `apps/api/scripts/run-marketplace-metering-proof.ts`
**Run it:** `LOG_LEVEL=error npx tsx apps/api/scripts/run-marketplace-metering-proof.ts` (from `apps/api`, dev Postgres up)

This is the **money-IN** half of the marketplace loop. The money-OUT half —
the payout executor — was proven on devnet in [`PAYOUT-RUN.md`](./PAYOUT-RUN.md),
which closed with a precise gap:

> `recordMarketplaceUsage` (money-in) still has ZERO callers — no
> installed-agent per-request execution path exists to invoke it… that
> metering caller is a distinct Wave-2 keystone.

That gap is what this closes.

---

## What was actually wrong

`recordMarketplaceUsage` was not merely uncalled. Had anything called it, it
would have **fabricated money**: it created a `settled` revenue row and
incremented the publisher's `pendingPayoutCents` **without ever debiting the
buyer**. The payout executor would then have paid creators, in real SOL or
real credits, out of revenue the platform never collected. The function is
deleted; `services/marketplaceMetering.ts` replaces it.

A second hole surfaced while wiring it: `uninstallAgent` flipped the install
row to `uninstalled` but left the cloned agent — the publisher's system
prompt, tools and source — fully runnable in the buyer's org. Since metering
keys on an **active** install, the cheapest way to use a paid agent forever
would have been to stop paying for it. An uninstalled clone now refuses to
run (`MarketplaceLicenceRevokedError`, HTTP 403).

---

## The design

Three phases, the same reservation shape as the deployment credit gate and
the payout executor:

| Phase | When | What commits, in ONE transaction |
|---|---|---|
| **charge** | before the agent runs | conditional debit (`WHERE balanceCents >= gross`) + `pending` MarketplaceRevenue row + ledger row referencing it |
| **settle** | after delivery | CAS `pending → settled` + creator accrual + delivered-request counters |
| **refund** | execution threw | CAS `pending → refunded` + credit the buyer back + ledger row |

Exactly-once comes from the status CAS. Counters move at settle, not charge,
so `totalRequests` counts delivered requests only. The publisher's pending
payout only ever grows by money actually taken from a buyer — the invariant
the old writer violated by design.

**Where it is called** (all four share two bindings, pinned by
`marketplaceMeteringWiring.unit.test.ts`):

- `routes/playground.ts` — interactive chat, streaming and non-streaming
- `services/scheduledTaskExecutorProduction.ts` — covers the scheduler
  worker, "trigger now", the orchestration engine and the test runner
- `services/runAgentGraph.ts` — one billable request per graph **run**, not
  per llm node, and refunded when the run fails

---

## The run

```
=== marketplace metering proof (metering-proof-1786409608368) ===

buyer org      3378ffec-9b80-4eb0-8ee4-51e737c9a0e3
publisher org  ecef8c0c-9f32-47c7-893e-96cf3e50365e
listing        f0c47df6-5442-4880-b539-f937a64f2cf7 @ $2.5000/request
cloned agent   ed4df930-aa17-4bd5-b456-524337391e7c
opening balance $10.0000

1. delivered   balance $10.0000 -> $7.5000 · publisher pending $2.2500 (10% platform fee retained)
2. failed      balance stays $7.5000 · publisher pending stays $2.2500
3. concurrency 4 parallel requests on $7.5000: 3 served, 1 refused, balance $0.0000 (never negative)
4. exhausted   refused before the agent ran (402 shape)
5. revoked     uninstalled clone refuses to run even with $100.0000 available

revenue rows   5 (4 settled, 1 refunded)
ledger rows    6
collected      $10.0000 from the buyer
accrued        $9.0000 to the publisher ($1.0000 platform fee)

INVARIANT OK   publisher pendingPayoutCents ($9.0000) is exactly the creator share of money actually taken from a buyer.
  ledger  marketplace_usage      -250c  balanceAfter    750c  ref 961867a7-ef8d-42af-99d0-81c793ff0190
  ledger  marketplace_usage      -250c  balanceAfter    500c  ref b7a40832-3936-46b5-a1fe-c9d26bfea6af
  ledger  marketplace_refund      250c  balanceAfter    750c  ref b7a40832-3936-46b5-a1fe-c9d26bfea6af
  ledger  marketplace_usage      -250c  balanceAfter    500c  ref c086c7c3-2e41-4012-861a-9dac6fad0079
  ledger  marketplace_usage      -250c  balanceAfter    250c  ref 68379b0f-692a-4130-98f9-a0529fdeb8fc
  ledger  marketplace_usage      -250c  balanceAfter      0c  ref bc894258-7c55-4471-bfaa-998041aa0c04

fixtures torn down.
```

Line 3 is the part no in-memory fake can prove: four concurrent requests
against a balance covering exactly three, hitting the real
`UPDATE … WHERE balance_cents >= 250` in Postgres. Three are served, one is
refused, and the balance lands on exactly zero — never negative. The refund
on line 2 is visible in the ledger as the `marketplace_refund` row carrying
the **same** `referenceId` as the debit above it, so a charge and its reversal
are correlatable from either side.

---

## Substitutions — what is NOT proven here

- **The model call.** The one substitution is the callback passed to
  `withMarketplaceMetering`, standing in for inference so the proof needs no
  provider key. Everything on the money side — the conditional decrement, the
  transactions, the CAS, the accrual — is production code against real
  Postgres. What the callback returns or throws is exactly what a real
  inference returns or throws at the same seam.
- **The HTTP contract.** The 402/403 responses are pinned by
  `marketplaceMeteringWiring.unit.test.ts` (source pins plus the error types),
  not exercised over the wire here; the playground route needs an
  authenticated session.
- **Credits are dollars, not chain.** Money-in lands in the credit ledger.
  The rails that put dollars INTO that ledger are proven separately
  ([`WALLET-TOPUP-RUN.md`](./WALLET-TOPUP-RUN.md) for the wallet rail,
  [`X402-RUN.md`](./X402-RUN.md) for x402); Stripe (T3/T4) is still blocked on
  test keys.

---

## The loop, end to end

With this commit, every leg of the marketplace revenue loop has a proof:

1. Buyer funds credits — wallet top-up, devnet-proven (`WALLET-TOPUP-RUN.md`)
2. Buyer installs a per-request listing — `installAgent`
3. **Buyer runs it; the buyer is debited and the creator accrues — this doc**
4. Creator requests a payout — reservation, `requestPayout`
5. Payout settles on-chain — devnet-proven (`PAYOUT-RUN.md`)

The one thing still seeded rather than earned is demand: real buyers.
