<h1 align="center">WheelsAI</h1>

<p align="center">
  <strong>Build, Deploy & Monetize AI products — one platform.</strong><br/>
  Agents · small language models · workflows — running on Nosana's decentralized GPU network, settling on Solana.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Mastra-supported-3b82f6?style=flat-square" alt="Mastra" />
  <img src="https://img.shields.io/badge/LangChain-supported-3b82f6?style=flat-square" alt="LangChain" />
  <img src="https://img.shields.io/badge/AutoGen-supported-3b82f6?style=flat-square" alt="AutoGen" />
  <img src="https://img.shields.io/badge/ElizaOS-supported-3b82f6?style=flat-square" alt="ElizaOS" />
  <img src="https://img.shields.io/badge/CrewAI-supported-3b82f6?style=flat-square" alt="CrewAI" />
  <img src="https://img.shields.io/badge/Custom-supported-3b82f6?style=flat-square" alt="Custom" />
</p>

---

## What it is

Every AI creator hits the same wall: hosting, billing, and distribution are a
second product they never planned to build. WheelsAI removes it.

- **Build** — import an agent from GitHub in any of six frameworks (Mastra,
  ElizaOS, LangChain, AutoGen, CrewAI, custom), fine-tune small language
  models, or chain both into scheduled workflows with a visual graph builder.
- **Deploy** — one click to Nosana GPU markets (3060 → H100), billed per
  second at live market pricing, behind an OpenAI-compatible `/v1` endpoint.
- **Monetize** — a marketplace with four pricing models (per-request,
  subscription, x402 micropayments, substance-gated tokens). Creators keep
  90%; payouts settle on-chain; every revenue figure traces to a ledger row
  or a transaction signature.

The connective tissue is Solana: an Anchor treasury program lets a product's
own earnings pay for its Nosana compute (`pay_nosana`), and a reputation
oracle attests usage on-chain — so a token launch has to be *earned* with
verified usage, and buyers can check a public receipts page before
installing anything.

Honest platform stats, as shipped today: **6 frameworks · 21 models ·
4 chat channels · 4 pricing models**. The channels are Discord, Telegram,
Slack and Web: a chat widget an owner pastes into their own site
(`apps/web/public/widget.js`, proof run in `docs/WEB-WIDGET-RUN.md`).

## Proven, with receipts

This repo's standard: money-moving systems ship with a written proof run —
real transactions, documented signatures — not a claim. All on Solana
devnet:

| Proof | What it demonstrates |
|---|---|
| [`docs/D10-RUN.md`](docs/D10-RUN.md) | The closed loop, end to end: trading fees → fee router (exactly 1%) → treasury PDA → `pay_nosana` → on-chain usage attestation |
| [`docs/WALLET-TOPUP-RUN.md`](docs/WALLET-TOPUP-RUN.md) | Wallet top-up rail: on-chain deposit credited exactly-once ($50 → 5,500 credits, byte-equality signed tx) |
| [`docs/X402-RUN.md`](docs/X402-RUN.md) | x402 pay-per-request: full HTTP 402 → client-signed payment → broadcast → settlement cycle |
| [`docs/PAYOUT-RUN.md`](docs/PAYOUT-RUN.md) | Creator payout executor: 0.25 SOL settled on-chain, exactly-once under the status CAS |
| [`docs/MARKETPLACE-METERING-RUN.md`](docs/MARKETPLACE-METERING-RUN.md) | Per-request metering: charge before inference, refund on failure; 4 concurrent requests on a 3-request balance → 3 served, 1 refused, balance exactly zero |
| [`docs/AGENT-JOBS-RUN.md`](docs/AGENT-JOBS-RUN.md) | Offerings and jobs: an agent job and a workflow job hired into escrow, run in the publisher's organization, accepted and paid 90% less model cost; failed checks, rejection, expiry and cancellation each refunded once; API keys without the spend scope or past their caps refused |

On-chain programs (devnet, verifiable on any explorer):

- `agent-treasury` — `9TF7xZpYYwbiiVmcJJs6RDmjDTpqoscYtWKhNBcMzM1n`
- `reputation-oracle` — `DMa1sNwXF6mZ2vyGiuA4QZhXPb5Sk4tp9gdnXsscrEB5`

One design rule holds across the codebase: **features never simulate
success** — anything unconfigured or unfinished returns an honest `501`
with a named reason, so what you see working is working.

## Architecture

```
 Next.js 15 (apps/web)
      │
 Fastify API (apps/api) ──── PostgreSQL + pgvector ──── Redis / BullMQ workers
      │                          (packages/db)           (payments · scheduler ·
      │                                                   indexer · attestation ·
      ├── Nosana GPU markets  — per-second deploy + metering        uptime · …)
      └── Solana devnet       — treasury · reputation oracle · x402 · payouts
                                 (programs/agent-treasury, programs/reputation-oracle)
```

```
apps/
  api/          Fastify API — 52 route modules, service layer, BullMQ queue fleet
  web/          Next.js 15 dashboard, marketplace, public receipts pages
packages/
  db/           Prisma schema + migrations (PostgreSQL, pgvector)
  sdk/ cli/ shared/ types/
programs/
  agent-treasury/      Anchor: per-agent treasury PDAs, fee_receive, pay_nosana
  reputation-oracle/   Anchor: on-chain usage attestations, reputation scores
docs/           Proof runs, deploy runbook, audits, grant application
```

## Getting started

Prereqs: Node 22+, Docker.

```bash
# 1. Infra (Postgres w/ pgvector on 5434, Redis on 6380)
docker compose up -d

# 2. Install + env
npm install
cp .env.example apps/api/.env       # fill in secrets; safe defaults for dev
echo "NEXT_PUBLIC_API_URL=http://localhost:4000" > apps/web/.env.local

# 3. Database
npm run db:generate && npm run db:migrate

# 4. Run (API :4000, web :3000)
npm run dev
```

Optional for real playground inference: set `GROQ_API_KEY` (free tier) or
another provider key in `apps/api/.env`.

### Tests

```bash
npm run test:unit -w @wheelsai/api    # 1,666 unit tests, no external deps, ~20s
npm run test -w @wheelsai/api         # + integration (needs DB, Redis, RPC)
cargo test --manifest-path programs/agent-treasury/Cargo.toml       # on-chain program (LiteSVM)
cargo test --manifest-path programs/reputation-oracle/Cargo.toml
```

## How the money moves

```
buyer credits  ◄─ Stripe (planned) · wallet top-up (proven) · x402 (proven)
      │
      ▼  per-request metering: charge → run → settle, refund on failure (proven)
creator revenue (90%) ─► on-chain payout (proven)
platform fee (10%, enforced in code)
      │
agent treasury ─► pay_nosana ─► GPU host operator (proven)
                     └─► usage attested by reputation-oracle (proven)
```

## Roadmap

1. **Public launch + first users** *(current)* — mainnet cutover (publish
   the runtime containers; payments, payouts and receipts to mainnet),
   production URL, first external creators via builders/content bounties.
2. **Fine-tuning + SLM serving** — LoRA/QLoRA batch jobs on Nosana markets;
   fine-tuned models served per-request via x402.
3. **The self-sustaining loop at scale** — products paying 100% of their own
   compute from their own revenue, chat channels 3 → 10, and a public,
   receipted growth report.

## More docs

- [`docs/DEPLOY-RUNBOOK.md`](docs/DEPLOY-RUNBOOK.md) — production deploy sequence (Fly.io)
- [`docs/UI-MATCHUP-AUDIT.md`](docs/UI-MATCHUP-AUDIT.md) — the build-up-don't-cut-down audit that drove the last two months
- [`SECURITY.md`](SECURITY.md) — reporting vulnerabilities

## License

MIT — see [LICENSE](LICENSE).
