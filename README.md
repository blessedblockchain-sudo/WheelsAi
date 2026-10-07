<h1 align="center">WheelsAI</h1>

<p align="center">
  <strong>Build, deploy and monetize AI agents, workflows and small language models.</strong><br/>
  One platform, running on Nosana's decentralized GPU network and settling on Solana.
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

Shipping an AI product means building three more products around it: hosting, billing and
distribution. WheelsAI is those three, so you can spend your time on the agent, the workflow or
the model itself, and earn from it the day it ships.

## Build

- **Your framework, or none.** Bring agents built with Mastra, ElizaOS, LangChain, AutoGen,
  CrewAI or your own code, or design one in the visual drag-and-drop builder. No lock-in.
- **Import from GitHub.** Connect a repository, public or private, and every push redeploys.
- **Tools, knowledge and memory.** Web search, HTTP requests, a code interpreter, file storage
  and knowledge search out of the box; knowledge bases with semantic search; memory that carries
  across conversations.
- **Workflows.** Chain agents, models and retrieval steps into pipelines on a canvas, with
  branches, loops and parallel steps. Run them on demand, on a schedule in any time zone, or
  through the API.
- **Models.** A catalog of 21 open models, including Llama, Mistral, Qwen, DeepSeek, Phi and
  Gemma, and free models with no API key needed (Groq, Gemini) for prototyping.
- **Fine-tuning.** Train a small language model on your own data with LoRA or QLoRA, watch the
  loss as it trains, and deploy the result behind the same API.
- **Testing.** Test suites for agents, with exact, semantic and custom assertions.

## Deploy

- **GPUs in one click.** Deploy to Nosana GPU markets, from an RTX 3060 to an H100, billed per
  second at live market prices.
- **No DevOps.** Instant deployments, auto-scaling with warm replicas so there are no cold
  starts, and health-based failover.
- **An OpenAI-compatible API for everything you build.** Agents, workflows and models answer
  `/v1/chat/completions` with streaming, function calling and tool use, so existing OpenAI
  clients work unchanged.
- **Where your users are.** One deploy reaches 4 chat channels: Discord, Telegram, Slack and your
  own website through the embeddable chat widget.
- **Production details included.** Custom domains with automatic TLS, logs, monitoring and
  alerts, analytics, and a public status page with live response times.
- **From your terminal.** `wheelsai deploy` builds, deploys and lists an agent in one command.

## Monetize

- **A marketplace for every product.** List agents, workflows and models, with four pricing
  models: free, per request, monthly and tokenized. A per-request call is charged before it runs
  and refunded automatically if it fails.
- **Hire, not just install.** Publish offerings that buyers hire for a fixed price: payment is
  held in escrow and released when the delivered work passes its checks. API keys can be scoped
  to spending and capped per job and per day.
- **Try before you buy.** Every listing has a free trial chat.
- **Creators keep 90%.** Payouts settle on Solana, and every sale is backed by receipts that
  buyers can check on the listing's public page.
- **Pay the way you like.** Top up credits by card through Stripe or from a Solana wallet, or
  pay per request with x402 micropayments.
- **Self-funding agents.** Trading fees from an agent's token and a share of its earnings flow
  into its own on-chain treasury, which pays for its compute on Nosana.
- **Agent tokens.** Once an agent has verified usage, launch a token for it on a bonding curve
  with pump.fun-style graduation to full liquidity on Solana.
- **A leaderboard of proven products.** Agents, workflows and models ranked by verified revenue.

## Plans

| | Starter | Pro | Enterprise |
|---|---|---|---|
| Price | Free | $49/month | Custom |
| Agents | Up to 3 | Unlimited | Unlimited |
| API calls | 1,000/month | 100,000/month | Volume pricing |
| Included | Free models (Groq, Gemini), marketplace listing, community support | Priority model access, custom domains, advanced analytics, priority marketplace placement | Everything in Pro, custom model hosting, white-label marketplace, dedicated support and SLA, SSO and audit logging |

Start with $5 in free credits, no card required.

## Quickstart

Sign up, create an API key under **Dashboard → API keys**, and point any OpenAI client at the
WheelsAI API. Pick what answers with `model`: `agent/<slug>` for an agent, `workflow/<slug>`
for a workflow, or a deployment's slug for a model.

```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: `${process.env.WHEELSAI_API_URL}/v1`,
  apiKey: process.env.WHEELSAI_API_KEY, // wheels_live_...
});

const reply = await client.chat.completions.create({
  model: "agent/support-concierge",
  messages: [{ role: "user", content: "How do I rotate an API key?" }],
});

console.log(reply.choices[0].message.content);
```

The same call with curl:

```bash
curl "$WHEELSAI_API_URL/v1/chat/completions" \
  -H "Authorization: Bearer $WHEELSAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "agent/support-concierge", "messages": [{"role": "user", "content": "Hi"}]}'
```

Deploy and publish from your terminal:

```bash
wheelsai login --url "$WHEELSAI_API_URL"
wheelsai deploy --agent support-concierge --publish
```

## Documentation

The web app serves the documentation at `/docs`:

- **Guides:** getting started, deploying a model, workflows, the marketplace, plans and
  billing, templates, custom domains and the web chat widget.
- **API reference:** agents, workflows, deployments, fine-tuning, the marketplace and jobs,
  billing, webhooks, and the OpenAI-compatible `/v1` API. The API also serves an interactive
  reference of every endpoint at `/docs` on the API host.
- **SDK and CLI:** the TypeScript SDK and the `wheelsai` command line.

## How it works

```
 Web app (apps/web) ─────────── dashboard · marketplace · docs · receipts pages
      │
 API (apps/api) ──── PostgreSQL + pgvector ──── Redis + BullMQ workers
      │                                         (billing · scheduler · fine-tuning ·
      │                                          payments · monitoring · ...)
      ├── Nosana ── GPU deployments and fine-tuning jobs, billed per second
      └── Solana ── agent treasuries · usage attestations · payouts · x402 payments
```

- **Compute on Nosana.** Model deployments, agent runtimes and fine-tuning jobs run on Nosana's
  decentralized GPU markets. Your organization is billed per second for the GPU time it uses.
- **Money on Solana.** Two on-chain programs back the marketplace: `agent-treasury` holds an
  agent's funds and pays for its compute, and `reputation-oracle` attests its usage on-chain.
  Verified usage is what a token launch requires.
- **Every amount accounted for.** Credits, holds, charges, refunds and payouts are recorded as
  they happen, so every amount in the dashboard traces back to a ledger entry or a Solana
  transaction.

## Roadmap

- **Fine-tuned models priced per request**, paid with credits or x402, alongside dedicated
  deployments.
- **More chat channels:** X, WhatsApp, Microsoft Teams, email, Matrix, Farcaster and SMS.
- **Concierge and MCP:** find, hire and pay for agents from any MCP client, with
  `wheelsai mcp`.
- **Agent budgets:** spend policies that let agents hire other agents within limits you set.
- **Products that run on their own revenue:** earnings that pay for all of a product's compute,
  with a public report of every product doing it.

## Develop WheelsAI

### Repository

```
apps/
  api/            Fastify API, service layer, BullMQ workers
  web/            Next.js 15 dashboard, marketplace, docs and receipts pages
packages/
  db/             Prisma schema, migrations and seed data (PostgreSQL, pgvector)
  sdk/            TypeScript SDK
  cli/            the wheelsai CLI
  shared/ types/  shared code and types
programs/
  agent-treasury/      Anchor program: per-agent treasuries, pay_nosana
  reputation-oracle/   Anchor program: usage attestations, reputation scores
infra/
  training/       the fine-tuning container (LoRA and QLoRA)
  edge/           the edge proxy that serves custom domains with TLS
```

### Run it locally

Requires Node 22.13+ and Docker.

```bash
# 1. Postgres with pgvector (port 5434) and Redis (port 6380)
docker compose up -d

# 2. Install and configure
npm install
cp .env.example apps/api/.env       # sensible defaults for development
cp .env.example packages/db/.env    # the database scripts read DATABASE_URL from here
echo "NEXT_PUBLIC_API_URL=http://localhost:4000" > apps/web/.env.local

# 3. Database: schema, migrations, and the model catalog and templates
npm run db:generate && npm run db:migrate && npm run db:seed

# 4. Start the API (port 4000) and the web app (port 3000)
npm run dev
```

Set `GROQ_API_KEY` in `apps/api/.env` to chat with free models right away. GPU deployments and
fine-tuning need a Nosana account (an API key with credits, or a funded wallet); fine-tuning
also needs the training image built from `infra/training`. Dataset uploads use an
S3-compatible bucket, or a local folder in development (`STORAGE_DRIVER=local`).
`.env.example` documents every setting.

The SDK and CLI are built from this repository:

```bash
npm run build -w @wheelsai/sdk
npm run build -w @wheelsai/cli
alias wheelsai="node $PWD/packages/cli/bin/wheelsai.js"
```

### Tests

```bash
npm run test:unit -w @wheelsai/api     # API unit tests, no external services
npm run test:unit -w @wheelsai/web     # web unit tests
npm run test -w @wheelsai/api          # adds integration tests (needs Postgres, Redis and an RPC)
```

The on-chain programs need Rust and Anchor; build them before testing:

```bash
anchor build
cargo test --manifest-path programs/agent-treasury/Cargo.toml
cargo test --manifest-path programs/reputation-oracle/Cargo.toml
```

## Security

Please report vulnerabilities privately through a confidential issue on this project, not in a
public issue.

## License

MIT. See [LICENSE](LICENSE).
