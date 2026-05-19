# Treasury payment lifecycle — smoke test

Verifies the four BullMQ workers (`treasury-settlement`, `payment-submit`,
`payment-poll`, `payment-reap`) move a single `ComputePayment` row through
its lifecycle against real Postgres + Redis + Solana devnet.

Everything below is unit-tested (746/746); this is the first run against
real infra.

## Prerequisites

- Postgres reachable via `DATABASE_URL`
- Redis reachable via `REDIS_URL`
- `SOLANA_NETWORK=devnet` (do **not** run on mainnet without a hardened
  master key + reviewed Anchor program — the current treasury signer
  derives from `WALLET_MASTER_KEY`, server-side)
- An existing `AgentTreasury` row whose `treasuryPdaAddress` matches the
  pubkey derived from `WALLET_MASTER_KEY` + that row's `id`. The treasury
  must be funded with devnet SOL (faucet: `solana airdrop 1 <pda> --url
  devnet`).

## 1. Apply the migration

```bash
cd packages/db
npx prisma migrate dev
# Applies 20260430011212_treasury_payment_lifecycle and any earlier
# pending migrations.
```

## 2. Set the master key (one-time)

The platform derives every treasury signer from a single
`WALLET_MASTER_KEY` via HKDF-SHA512 keyed on the treasury's `id`.
Generate one and put it in `.env`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# 64 hex chars = 32 bytes; well above the 32-char minimum.
```

```bash
export WALLET_MASTER_KEY=<the-hex-string>
```

> **Operational note.** Rotating `WALLET_MASTER_KEY` regenerates every
> treasury PDA, which would orphan existing balances. Treat this as a
> permanent secret until plan A2 (the agent-treasury Anchor program)
> moves the keypair off the server.

## 3. Provision a treasury row whose pubkey matches the derivation

```ts
// scripts/derive-and-seed-treasury.ts (one-shot helper you can drop in)
import { deriveTreasuryKeypair } from "../src/services/treasuryKeypairs.js";
import { prisma } from "../src/lib/prisma.js";

const tokenId = process.argv[2]; // existing AgentToken.id
const treasuryId = crypto.randomUUID();
const kp = deriveTreasuryKeypair({
  masterKey: process.env.WALLET_MASTER_KEY!,
  treasuryId,
});

await prisma.agentTreasury.create({
  data: {
    id: treasuryId,
    tokenId,
    treasuryPdaAddress: kp.publicKey.toBase58(),
    authorityBump: 255,
    solBalanceLamports: 0n,
  },
});

console.log({ treasuryId, treasuryPdaAddress: kp.publicKey.toBase58() });
```

Fund the printed pubkey: `solana airdrop 1 <pubkey> --url devnet`.

## 4. Set queue intervals

```bash
export TREASURY_SETTLEMENT_INTERVAL_MS=60000
export TREASURY_SETTLEMENT_BATCH_INTERVAL_MS=300000
export PAYMENT_SUBMIT_INTERVAL_MS=30000
export PAYMENT_POLL_INTERVAL_MS=15000
export PAYMENT_REAP_INTERVAL_MS=120000
export PAYMENT_BATCH_LIMIT=50
export PAYMENT_REAP_MAX_AGE_SECONDS=150
```

`getSolPriceUsd` hits CoinGecko's free tier; no env needed. The first
runway-card load on a fresh process triggers the fetch, then a 60s cache
absorbs subsequent ticks. `getComputeCost` queries the Nosana SDK; needs
`NOSANA_WALLET_PRIVATE_KEY` to initialize but read paths work without
funded NOS.

## 5. Boot the API

```bash
cd apps/api
pnpm dev
# Watch logs for:
#   "Treasury settlement BullMQ queue started"
#   "Payment submit BullMQ queue started"
#   "Payment poll BullMQ queue started"
#   "Payment reap BullMQ queue started"
```

If `WALLET_MASTER_KEY` is unset, `payment-submit` logs a warning and
disables itself — the other three workers still boot.

## 6. Seed a PENDING payment

```bash
cd apps/api
tsx scripts/seed-test-payment.ts <treasury-id> 1000000
# Inserts a 0.001 SOL PENDING payment with a placeholder nosanaJobId.
# Prints the new payment id.
```

> If you want the real Nosana host lookup to work, replace the
> placeholder `nosanaJobId` with an actual job address that's been
> picked up by a host (state=running, node != system program zero).

## 7. Watch the lifecycle

```bash
tsx scripts/watch-payment.ts <payment-id>
# Polls every 2s; prints whenever (status, txSignature, errorMessage,
# submittedAt, paidAt) changes. Exits on terminal state.
#
# Expected progression (with the default intervals above):
#   t+0s    PENDING
#   t+30s   SUBMITTED + txSignature  (payment-submit fired)
#   t+45s   CONFIRMED + paidAt       (payment-poll fired)
```

## 8. Verify on-chain

```bash
solana confirm <txSignature> --url devnet
# Should report "Confirmed" and show the lamport transfer
# from treasury PDA → recipient.
```

## Failure modes to test

- **Stuck submission**: pause the poll worker
  (`PAYMENT_POLL_INTERVAL_MS=0`), wait 150s, watch the reaper transition
  the row to FAILED with `errorMessage="blockhash_expired"`.
- **Insufficient balance**: seed a payment with `amountLamports` >
  treasury balance; submit should land FAILED with the RPC error from
  Solana.
- **Job not yet on a host**: use a `nosanaJobId` for a queued (not
  running) job — `resolveNosanaRecipient` throws "no host yet" and the
  row is recorded as FAILED. Re-seed once the job is picked up.
- **Race between poll and reap**: confirm the conditional update
  (`WHERE status='SUBMITTED'`) prevents a double-write — only one of
  the two workers wins, the other gets `count=0` and throws
  (BullMQ retries; the next loader pass sees the new state and
  no-ops).
