# WheelsAI threat model (internal)

> **Internal document.** This is the team's threat model: custody, keys, privileged on-chain
> actions, key-loss playbooks and known gaps. It is not the public security policy; that is
> [`SECURITY.md`](../SECURITY.md) at the repository root, which says how to report a
> vulnerability. Moved here from `SECURITY.md` on 2026-10-07, unchanged in substance.

This document is the system-level answer to "who can move what, signed by
which key, and what happens when a key is lost or leaked." It exists so
auditors and operators don't have to reconstruct the threat model from
code. Keep it current: any PR that changes key handling, program
authorities, or fund flows must update this file.

## 1. Custody model (explicit)

WheelsAI is **custodial by design** for platform-operated flows:

- Each tokenized agent has an on-chain treasury PDA
  (`agent-treasury` program). The recorded `platform_authority` — a
  per-treasury key derived by the platform — can send the treasury's
  entire spendable balance to **any** address via `pay_nosana`. There is
  no on-chain recipient allowlist or amount cap in v1; those policy
  checks live in the platform's signing path. Token holders are trusting
  the platform's key handling, and marketing/docs must not claim
  otherwise.
- The **user's wallet** is the on-chain creator of launched tokens (the
  browser partial-sign flow). The platform never holds user wallet keys.
- **What customers pay in USDC and SOL** arrives at their organization's
  deposit address, a key derived from `WALLET_MASTER_KEY`. With sweeps on
  (`SWEEPS_ENABLED`) it is moved from there to one of two places only:
  the hot wallet (the wallet creator payouts leave from, also derived
  from `WALLET_MASTER_KEY`) while that holds less than its float, and
  otherwise the treasury, `TREASURY_WALLET_ADDRESS`. The treasury's key
  is not in the product: the API holds its address and nothing else. No
  input can make a sweep send anywhere else, and nothing is sent to the
  treasury until its address is proven (section 5).

## 2. Key inventory

| Key | Where it lives | What it can do | Derivation |
|---|---|---|---|
| `WALLET_MASTER_KEY` | env (Fly secret) | Root secret: every per-treasury authority and per-org creator key derives from it | operator-generated |
| Per-treasury `platform_authority` | derived in-memory at signing time | Drain that treasury (pay_nosana to any address) | HKDF-SHA512(master, info=treasuryId) — `services/treasuryKeypairs.ts` |
| Per-org creator keys | derived in-memory | Legacy custodial creator (retired path) | HKDF(master, info=orgId) — `services/creatorKeypairs.ts` |
| Per-org deposit keys | derived in-memory | Move what sits at that organization's deposit address (what customers paid and no sweep has moved yet) | HKDF-SHA512(master, salt `wheelsai-topup-v1`, info=orgId), in `services/topupKeypairs.ts` |
| Hot wallet key | derived in-memory | Move what the hot wallet holds: the floats creator payouts are paid from | HKDF-SHA512(master, salt `wheelsai-payout-v1`), in `services/payoutKeypair.ts` |
| Treasury wallet key | **not in the product**: with the founder, off the API's host | Move what sweeps sent to `TREASURY_WALLET_ADDRESS` | operator-generated; the API knows the address only |
| `NOSANA_WALLET_PRIVATE_KEY` | env | Pays for ALL Nosana GPU jobs (platform funds) | raw key in env |
| `FEE_ROUTER_WALLET_PRIVATE_KEY` | env | Source of fee_receive deposits (platform funds) | raw key in env |
| `REPUTATION_ATTESTOR_PRIVATE_KEY` | env | Writes attestations (drives token-launch eligibility) | raw key in env |
| `BOOTSTRAP_ADMIN_KEYPAIR` | operator env (scripts only) | TreasuryConfig admin: the only key that can create treasury PDAs | operator-generated |
| Oracle admin | operator keypair | Manage attestor whitelist, rotate oracle admin | operator-generated |
| BPF upgrade authorities | operator keypair (Anchor provider wallet) | Replace program code entirely (supersedes everything above) | operator-generated |
| `JWT_SECRET` | env | Sessions, signed cookies, training-webhook HMAC | operator-generated |
| `ENCRYPTION_KEY` | env | AES-256-GCM at rest (channel configs etc.); MUST differ from JWT_SECRET (boot-enforced) | operator-generated |

**Blast radius:** `WALLET_MASTER_KEY` compromise = every treasury and
custodial creator key. It is the crown jewel; see rotation below.

**What `WALLET_MASTER_KEY` alone can move of customers' payments, once
sweeps run.** The key derives the hot wallet and every deposit address,
so whoever has it can move what those hold, and no more:

- **The hot wallet: about twice the floats, and what open payouts
  need.** It is filled up to its float of each asset
  (`HOT_WALLET_FLOAT_USDC`, 200 dollars of USDC, and
  `HOT_WALLET_FLOAT_SOL_USD`, 100 dollars of SOL) plus what the payouts
  to a wallet that are pending or being sent need of that asset. A
  transfer goes to it whole while it is under that, so it can pass it;
  once it holds more than twice a float on top of that need, a run sends
  what is above the float and the need to the treasury. With the
  defaults and no payout open it therefore rests at no more than about
  400 dollars of USDC and 200 of SOL. While payouts are open it also
  holds what they need, which is never counted above
  `PAYOUT_PLATFORM_MAX_PER_DAY_USD` (5,000 dollars) an asset: the most
  that can be paid out in a day is the most it is ever filled for.
  Lowering that setting lowers this. Two things can put more there for a
  time: one large transfer swept to it while it was under its level,
  until the next run sends the excess on, and whatever the operator
  sends it by hand for payouts and fees. Its SOL is valued at the
  current price, so the dollar figure moves with it.
- **What sits at deposit addresses not yet swept.** That is: what
  arrived since the last run (`SWEEP_INTERVAL_MS`) or beyond
  `SWEEP_MAX_PER_RUN` in one run; at each address, a balance worth less
  than `SWEEP_MIN_USD`, which stays until it grows past it; the 890,880
  lamports a SOL sweep leaves at each address; and SOL in any run with
  no price.
- **Out of its reach: what was swept to the treasury.** The treasury's
  key is not derived from `WALLET_MASTER_KEY` and is not in the product.

Three conditions make the bound above hold; without any one of them
`WALLET_MASTER_KEY` can move more:

- Sweeps are on and their worker runs. With `SWEEPS_ENABLED` off, or
  `SWEEP_INTERVAL_MS` at 0, everything customers ever sent to a deposit
  address is still there.
- The treasury is proven. With no proven treasury only sweeps to the hot
  wallet happen; once the hot wallet has its floats, the rest stays at
  the deposit addresses.
- The treasury's key stays off the product. If it is ever put in a
  setting or on the API's host, the treasury is one more hot wallet.

The money report (`GET /api/platform/money`) shows these amounts as they
stand: `onChain.hotWallet`, `onChain.depositAddresses`,
`onChain.treasury`.

## 3. Privileged actions matrix (on-chain)

### agent-treasury (`9TF7xZpYYwbiiVmcJJs6RDmjDTpqoscYtWKhNBcMzM1n`)

| Instruction | Who may call | Notes |
|---|---|---|
| `initialize_config` | first caller (one-shot) | Run immediately after deploy by ops; caller becomes config admin |
| `initialize_treasury` | **config admin (signer)** | Front-run-proof since C1; records the per-treasury platform_authority |
| `fee_receive` | anyone | Deposits only |
| `pay_nosana` | recorded `platform_authority` (signer) | Full spendable balance, any recipient; rent reserve enforced on-chain |
| `propose_platform_authority` | current platform_authority | Two-step rotation, step 1 |
| `accept_platform_authority` | proposed authority (signer) | Step 2 — proves new key is usable before old loses power |
| `propose_config_admin` / `accept_config_admin` | current admin / proposed admin | Two-step config-admin rotation |

### reputation-oracle (`DMa1sNwXF6mZ2vyGiuA4QZhXPb5Sk4tp9gdnXsscrEB5`)

| Instruction | Who may call | Notes |
|---|---|---|
| `initialize_oracle` | first caller (one-shot) | Run at deploy by ops; caller becomes admin |
| `add_attestor` / `remove_attestor` | admin | Attestor whitelist gates who can write reputation |
| `propose_admin` / `accept_admin` | admin / proposed admin | Two-step (replaced one-step transfer_admin) |
| `initialize_agent_reputation` | anyone (rent payer) | Squatting only pre-creates a zeroed record keyed by mint |
| `submit_attestation` | whitelisted attestor (signer) | Drives token-launch eligibility = real money; per-agent monotonic timestamp |

## 4. Key-loss / key-leak playbook

| Scenario | Response |
|---|---|
| `WALLET_MASTER_KEY` suspected leak | Run `apps/api/scripts/rotate-treasury-authority.ts` (dry-run first): for every initialized treasury it proposes (old-derived key signs) and accepts (new-derived key signs) rotation to keys derived from the NEW master key. Then rotate the Fly secret. Do NOT rotate the env secret before rotating on-chain authorities — the old derivations are needed to sign the proposals. |
| A transfer out of a deposit address that is not a sweep | The deposit scan logs a warning for it (a sweep's own transfer is expected and is not warned about), and the money report's reconciliation difference for that asset goes below 0. Only a key derived from `WALLET_MASTER_KEY` can sign for a deposit address: treat it as a leak of that key. What has been swept to the treasury is out of that key's reach. Deposit addresses cannot be rotated to a new master key the way treasury authorities can: each is derived from the key and customers have saved theirs (`docs/DEPLOY-RUNBOOK.md`, section 12). |
| Treasury wallet key lost | What was swept to the treasury cannot be moved by anyone: the product does not hold that key and cannot recover it. Sweeps keep sending to that address while `TREASURY_WALLET_ADDRESS` still names it, so change the setting first: set it to a new wallet, or set `SWEEPS_ENABLED=false`. From the change until the new address is proven (`scripts/treasury-verify.ts`) nothing is sent to the treasury. x402 payments follow the same setting. |
| Treasury wallet key suspected leak | Move what the treasury holds to a new wallet with the treasury's own key, set `TREASURY_WALLET_ADDRESS` to the new address and prove it. Changing the setting alone stops new sweeps to the old address from the next run: the recorded proof no longer matches, so the treasury counts as not proven. x402 payments follow the same setting. |
| Treasury authority mismatch detected | `bootstrap-treasury.ts` exits with code 3 and refuses to flip `programInitialized`; the payment worker fails the row with `authority_mismatch` and never signs. Investigate before any further fee routing to that treasury. |
| Oracle admin key lost | Lost BEFORE rotation completes = attestor list frozen (attestations keep flowing with existing attestors). Use two-step rotation early; move admin to a multisig. |
| TreasuryConfig admin lost | New treasuries cannot be created (existing ones unaffected). Recover via program upgrade (upgrade authority) — last resort. |
| BPF upgrade authority leak | Total compromise of both programs. Highest-value key; multisig it first (see roadmap). |

## 5. Application-layer trust boundaries

- **Auth:** argon2id passwords; JWT (24h) with jti blocklist on logout;
  httpOnly signed sameSite cookies; nacl-verified wallet nonces (5-min
  TTL). API keys are hashed at rest and scoped.
- **Two-step launch:** `/api/tokens/launch/prepare` returns an
  HMAC-signed prepare token binding mint/org/creator/metadata;
  `/submit` re-verifies the binding (timingSafeEqual) so fields cannot
  be swapped between the steps.
- **Webhooks:** inbound channel webhooks verify per-protocol signatures
  (`services/channelAuth.ts`); the Nosana training webhook requires a
  per-job HMAC token.
- **x402:** payments are only `settled` after on-chain confirmation by
  the settlement worker; replay is blocked by unique txSignature. In
  production, x402 cannot boot in verification-only mode.
- **Sweeps:** a sweep sends only to an address this server derives (the
  hot wallet) or to the proven treasury; no request, row or setting other
  than `TREASURY_WALLET_ADDRESS` names a destination. The treasury counts
  as proven only when a recorded proof for this chain carries exactly the
  address in `TREASURY_WALLET_ADDRESS`, and that address is an ordinary
  wallet address that is not the all-ones default, not the hot wallet and
  not a deposit address. The proof (`scripts/treasury-verify.ts`) is a
  finalized transaction that did not fail, that the treasury address
  signed, and that left the hot wallet with at least 0.1 SOL more: only
  the holder of the treasury's key can make one. A sweep moves from a
  deposit address only what the deposit scan has already accounted for.
  A transfer's row, with its signature and signed bytes, is written
  before it is broadcast, and only the chain's answer for that signature
  ends the row; the database refuses a second transfer in flight for the
  same address and asset.
- **The money report** (`GET /api/platform/money`) only reads, and is
  behind `PLATFORM_ADMIN_KEY` in the header `x-admin-key`, as the compute
  view is. It names the hot wallet's and the treasury's addresses and
  what each holds.
- **Dev escapes are boot-fatal in production:** `ALLOW_NOSANA_MOCK`,
  `ALLOW_MOCK_CHECKOUT`, x402 verification-only mode, default
  CORS_ORIGIN, missing/duplicate ENCRYPTION_KEY (see
  `apps/api/src/config/env.ts:validateEnv`).

## 6. Known gaps / roadmap (do not delete items without shipping them)

1. **No multisig anywhere yet.** TreasuryConfig admin, oracle admin, and
   both BPF upgrade authorities are single keys. Move all three to a
   Squads multisig before mainnet funds.
2. **No on-chain spending policy.** `pay_nosana` trusts the platform
   signer's recipient/amount entirely. Planned: recipient allowlist +
   per-window amount caps, either on-chain or in a policy-enforcing
   signing service (KMS/HSM-backed).
3. **Hot keys as env strings.** `NOSANA_WALLET_PRIVATE_KEY`,
   `FEE_ROUTER_WALLET_PRIVATE_KEY`, `REPUTATION_ATTESTOR_PRIVATE_KEY`
   should move behind a signing service with anomaly alerts.
4. **Single attestor.** Reputation currently rests on one platform key;
   Phase 2 adds Nosana host co-signatures so eligibility data is not
   self-attested.
5. **Third-party audit** of both programs before mainnet treasury
   volume. This file plus the LiteSVM adversarial tests are the prep
   artifacts.
6. **The treasury that sweeps send to is one key, and cannot be a
   multisig vault as built.** `TREASURY_WALLET_ADDRESS` must be an
   ordinary wallet address, one whose own key signs the proof transfer;
   a vault address has no key of its own and is refused. Item 1's
   multisig does not cover this wallet until the proof accepts one.

## 7. Reporting

Vulnerability reports arrive as described in the public policy,
[`SECURITY.md`](../SECURITY.md): a confidential issue on this project.
(The previous text named `security@wheelsai.io`; that domain is not
registered, see `docs/FOUNDER-ACTIONS.md` section 1. Add a mailbox to
`SECURITY.md` only once one exists.)
