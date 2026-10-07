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

## 2. Key inventory

| Key | Where it lives | What it can do | Derivation |
|---|---|---|---|
| `WALLET_MASTER_KEY` | env (Fly secret) | Root secret: every per-treasury authority and per-org creator key derives from it | operator-generated |
| Per-treasury `platform_authority` | derived in-memory at signing time | Drain that treasury (pay_nosana to any address) | HKDF-SHA512(master, info=treasuryId) — `services/treasuryKeypairs.ts` |
| Per-org creator keys | derived in-memory | Legacy custodial creator (retired path) | HKDF(master, info=orgId) — `services/creatorKeypairs.ts` |
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

## 7. Reporting

Vulnerability reports arrive as described in the public policy,
[`SECURITY.md`](../SECURITY.md): a confidential issue on this project.
(The previous text named `security@wheelsai.io`; that domain is not
registered, see `docs/FOUNDER-ACTIONS.md` section 1. Add a mailbox to
`SECURITY.md` only once one exists.)
