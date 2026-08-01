# D10 — First end-to-end treasury payment on devnet

**Date:** 2026-08-01 · **Network:** Solana devnet · **Program:**
agent-treasury `9TF7xZpYYwbiiVmcJJs6RDmjDTpqoscYtWKhNBcMzM1n`

The money path ran end-to-end for the first time against real infrastructure:
a real SPL mint, the real Anchor program (admin-gated config + treasury init),
a real funded treasury PDA, and one `ComputePayment` row driven through the
**production submit/poll worker code** — claim-first CAS, HKDF-derived
platform authority, client-side on-chain authority verification, program-mode
`pay_nosana`, broadcast, confirmation — to `CONFIRMED`, finalized on-chain.
The public transparency feed (`/api/a/wheels-helper`) serves the receipt.

Every claim below is a devnet transaction you can open in the explorer
(`https://explorer.solana.com/tx/<sig>?cluster=devnet`).

## Cast

| Role | Address |
|---|---|
| Funded payer (user-funded, 4 SOL) | `2BFEMhwhA1hakQ4J7P4tNeMQZW4k3J6tziumWncVobkH` |
| Config admin (`.devnet/admin.json`) | `8AVwQGpsjLMrh6aghWnVXHSyoy9Xd1U8mME7xDxujoYH` |
| WheelsHelper mint (real SPL token) | `DZYP8RqLxtVSYVMW1QCf4eQVyGaoWsbWe8CesbR76uq5` |
| Treasury PDA (program-derived from mint, bump 252) | `BNiXNqnPwaBVihDihgxqh7SgyN9X4DFktUpULbGLXUVY` |
| Platform authority (HKDF: WALLET_MASTER_KEY + treasuryId) | `GGhBuVnggXfFPwc38Hy9HCzQNyMA4Etf1A2GLK57C6qM` |
| Simulated host (payment recipient — see Caveats) | `DEewfM4CiCv4JBz49aVyr8RWuPS2SctkfiX6ZMXummX2` |

DB rows (wheelsai-postgres): agent `6d6f6f9c-15bf-4e96-9b44-fc55a4d78f6d`
(slug `wheels-helper`, public) → listing `1d35d8c5-4053-4708-bb1c-622cb192286d`
→ token `7cc3a218-699c-49cd-a50d-825b4d1f0d61` → treasury
`3f782d00-c346-45ba-85a9-f01b7d5f7ed5` → payment
`7af521a5-72b9-4858-8ac9-a0a06e347209`.

## Transactions, in order

| Step | Signature | Result |
|---|---|---|
| 1. Create SPL mint (`spl-token create-token`) | `2FnUDHihuDtQYMJ2XsXyU7jpJcLcc8942ekSrhCgng83R6rkPdQVrxQVcFyCzc6y8CpRG1MdbMaAWEUpG8epZYQh` | Mint `DZYP8…6uq5` |
| 2. Upgrade agent-treasury program (deployed binary predated `initialize_config`; extended +50KB, redeployed at slot 480467747) | `59TrB1LfiN66MHRHdiixMitxbVidyUV6KRGmJEHjT1qAmVqvurwKVUcpzTdK2fXMa576EBSNFu9oQEkoAFVErrmr` | New binary live |
| 3. Fund config admin (0.05 SOL — admin pays config rent) | `2aS8Au33c2PsMe4nqimyr8dSWAu5mBmoW4z4Hq5cbMdpqDTYhtBEeyWBNVKtwUrYZ7tzqFhL47K4Rkr1fZ5vvkSu` | — |
| 4. `initialize_config` (bootstrap-treasury.ts --init-config) | `5jExP6GUZRAyxeBFKRiCVRHkQVQsYgxFmrPwFbC7iCJaK6anujQLAScNykAzuutC6EnSKetvrGgkgNhAeMpFabBG` | TreasuryConfig PDA, admin = `8AVwQ…` |
| 5. `initialize_treasury` for WheelsHelper (admin co-signed; authority = HKDF derivation, verified) | `3UdMAe6Pnrk5nhHV2cCaL4s4QixKQedwDmqwaTM9jV3nvssyeErpGd9Zxfq9PEDLsNiYvvbipSq9Uv2sFRbykKcW` | `programInitialized=true` |
| 6. Fund treasury PDA (0.5 SOL from payer) | `51ERxEYHdeZoVBchctgH2SJLNg2DLpt4XpidJyCfzyg3igCb6Y9sBuMq9vDE4hYn2UP7myxvX3dXb4verYQNgMUP` | PDA at 0.50195576 SOL |
| 7. Fund platform authority (0.05 SOL — it pays `pay_nosana` tx fees) | `o7J8mYE6V6V2idwdBANB4U3RKqXJ1i9p1cr845zq96CCXyacPeKZJddeuzzDijj1hbKYx6RPTMEFPPVjetM5UUT` | — |
| 8. First `pay_nosana` attempt — signed + claimed, broadcast failed (authority unfunded at the time); blockhash expired unseen | `2YNLg9Peh22u3PBE8M7eoxrrJniXs99FZ4kXXBWKo9WRQxznc9x1DArSUbrmGnhzEDirmeG7jVVfLrZfQNqiJf4C` (never landed) | **Claim-first recovery proven**: next tick detected provable expiry, safely re-signed |
| 9. `pay_nosana` 0.01 SOL → simulated host, via the production submit tick | `3j9KWQdRKCfxcrGqJFMSybGVBTsH67WeAVoV3tCMzfQAxDAU1MbAZXmY76WRyc7fi57QdVBShCSiZbWdF8yPD62Z` | **FINALIZED**; poll tick → `CONFIRMED`, `paidAt=2026-08-01T15:01:00.916Z` |

Balances after: treasury PDA 0.49195576 SOL (−0.01), simulated host exactly
0.01 SOL, payer 3.39653764 SOL.

## The receipt, publicly served

`GET /api/a/wheels-helper` (no auth) returned, live:

```json
{
  "agent": { "name": "WheelsHelper", "slug": "wheels-helper", "framework": "elizaos" },
  "treasury": {
    "address": "BNiXNqnPwaBVihDihgxqh7SgyN9X4DFktUpULbGLXUVY",
    "cumulativeComputePaidLamports": "10000000"
  },
  "eligibility": { "eligible": false },
  "recentPayments": [{
    "amountLamports": "10000000",
    "status": "CONFIRMED",
    "txSignature": "3j9KWQdRKCfxcrGqJFMSybGVBTsH67WeAVoV3tCMzfQAxDAU1MbAZXmY76WRyc7fi57QdVBShCSiZbWdF8yPD62Z",
    "paidAt": "2026-08-01T15:01:00.916Z"
  }]
}
```

Note `eligibility: false` — the gate reports honestly (WheelsHelper has no
running deployment and its reputation is still 0). The transparency page
renders this at `/a/wheels-helper`.

## What was real vs. substituted

**Real, production code paths:** mint · program upgrade · admin-gated
`initialize_config` / `initialize_treasury` (bootstrap-treasury.ts) · HKDF
platform-authority derivation (same provider the worker uses) · client-side
on-chain authority verification before signing · claim-first protocol
(PENDING→SUBMITTING CAS with persisted signed bytes) · **expiry recovery**
(step 8→9: unseen signature past `lastValidBlockHeight` → safe re-sign) ·
program-mode `pay_nosana` build/sign/broadcast · confirmation polling →
`CONFIRMED` · the public transparency feed.

**Substituted (one seam):** recipient resolution. Devnet has no payable
Nosana hosts, so `resolveRecipient` (the DI seam the worker architecture
defines) returned a labeled simulated-host wallet instead of resolving the
job's host from the Nosana SDK (`scripts/run-d10-payment.ts`). A real host
lookup+payment is exercised in the C1 mainnet spike.

**Seeded directly:** the `ComputePayment` row (`seed-test-payment.ts`), i.e.
the settlement worker (usage → payment amounts) did not produce it.

## Not yet run (the money-in legs)

1. **Fee router** — sweeping trading fees into the treasury PDA
   (`FEE_ROUTER_WALLET_PRIVATE_KEY` + interval). The PDA was funded by a
   direct transfer instead.
2. **Reputation attestation** — on-chain `AgentReputation` writes
   (attestor key + `add_attestor` + interval). Requires checking whether the
   deployed reputation-oracle binary also predates current source (the
   agent-treasury one did).

Both are the natural next step of this runbook; the scripts and the funded
payer remain in place (`.devnet/` — gitignored).

## Reproduce

```bash
# rows:      tsx scripts/seed-d10-agent.ts <mint> <creator> [orgId]
# on-chain:  BOOTSTRAP_PAYER_PRIVATE_KEY=… BOOTSTRAP_ADMIN_KEYPAIR=… \
#            tsx scripts/bootstrap-treasury.ts --init-config
# payment:   tsx scripts/seed-test-payment.ts <treasuryId> <lamports>
#            tsx scripts/run-d10-payment.ts <paymentId> <recipient>
```
