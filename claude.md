# WheelsAI — Technical Architecture & Execution Plan

> **HISTORICAL (2026-09-02):** the original day-one architecture and
> execution plan, preserved as-is. Much of it has since been built,
> revised, or superseded — the current state of the project is
> [README.md](README.md); the audit that reshaped the last two months is
> [docs/UI-MATCHUP-AUDIT.md](docs/UI-MATCHUP-AUDIT.md).
> Last updated: 2026-01-06

---

## 1. Project Overview

WheelsAI is an AI development platform that abstracts Nosana's decentralized GPU infrastructure into intuitive workflows for model deployment, agent building, and fine-tuning. The platform provides stable API endpoints, usage-based payments, and eventually autonomous agent wallets for machine-to-machine transactions.

**Core value proposition:** Reduce the barrier from "I know Docker, Solana, and Nosana internals" to "I click deploy and get an OpenAI-compatible endpoint." Secondary value: enable pay-per-use monetization for AI services via X-402 protocol.

**Reality check:** The design document describes a 2-3 year platform vision. This execution plan focuses on what can be built in ~12 weeks to validate core assumptions, with clear expansion phases.

---

## 2. Core Principles & Non-Goals

### Principles

1. **Nosana is infrastructure, not a feature** — Users should never write job JSON or understand market selection. Abstract completely.
2. **Fail fast, recover faster** — Nosana nodes are ephemeral. Design for failure as the norm, not the exception.
3. **Credits before crypto** — Prepaid USD credits are the MVP payment method. X-402 is Phase 2.
4. **Boring technology wins** — PostgreSQL, Redis, Node.js. No exotic choices without clear justification.
5. **One happy path first** — vLLM + Llama models only in MVP. Breadth comes later.
6. **Observability is not optional** — Every service must emit structured logs, metrics, and traces from day one.

### Non-Goals (MVP)

- **Visual agent builder** — Too complex for MVP. Code-first agents only.
- **Training Studio** — Different GPU usage patterns, deferred to Phase 2.
- **Agent-to-agent payments** — Requires trust infrastructure we don't have yet.
- **Multi-chain settlement** — Solana only for MVP.
- **Custom domains** — Nice-to-have, not MVP.
- **Marketplace/discovery** — Build supply before demand aggregation.
- **Mobile apps** — Web-first.

### Explicit Assumptions

1. Nosana SDK (`@nosana/sdk`) is stable and documented accurately.
2. Nosana deployment manager handles container restarts reliably.
3. IPFS pinning via Nosana is sufficient; we don't need our own pinning service initially.
4. Users will fund wallets with SOL/NOS before using the platform.
5. X-402 facilitator services (Coinbase or self-hosted) will be available when needed.
6. vLLM Docker images work reliably on Nosana's GPU node environment.

---

## 3. System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              USERS / AGENTS                                 │
│                    (Browser, CLI, SDK, External Services)                   │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      │ HTTPS
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            EDGE / GATEWAY LAYER                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                         Cloudflare / Nginx                          │   │
│  │              (TLS termination, DDoS protection, caching)            │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      API Gateway (Kong / Custom)                    │   │
│  │         (Rate limiting, auth validation, request routing)          │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      │
          ┌───────────────────────────┼───────────────────────────┐
          ▼                           ▼                           ▼
┌─────────────────┐       ┌─────────────────┐       ┌─────────────────┐
│   WEB SERVICE   │       │   API SERVICE   │       │ INFERENCE PROXY │
│                 │       │                 │       │                 │
│ • Next.js SSR   │       │ • REST/tRPC     │       │ • OpenAI compat │
│ • Dashboard UI  │       │ • CRUD ops      │       │ • Load balance  │
│ • Auth flows    │       │ • Job mgmt      │       │ • Health routing│
│                 │       │ • Billing       │       │ • Usage metering│
└────────┬────────┘       └────────┬────────┘       └────────┬────────┘
         │                         │                         │
         └─────────────────────────┼─────────────────────────┘
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           CORE SERVICES LAYER                               │
│                                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│  │   AUTH SVC   │  │   JOB SVC    │  │ PAYMENT SVC  │  │  ROUTING SVC │    │
│  │              │  │              │  │              │  │              │    │
│  │ • JWT issue  │  │ • Job CRUD   │  │ • Credits    │  │ • Node health│    │
│  │ • Wallet auth│  │ • Nosana SDK │  │ • Metering   │  │ • Selection  │    │
│  │ • Sessions   │  │ • Lifecycle  │  │ • Invoices   │  │ • Failover   │    │
│  │ • API keys   │  │ • Templates  │  │ • (X-402)    │  │ • Latency    │    │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘    │
│                                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                      │
│  │  WALLET SVC  │  │ STORAGE SVC  │  │  WORKER SVC  │                      │
│  │              │  │              │  │              │                      │
│  │ • Agent keys │  │ • IPFS pin   │  │ • Async jobs │                      │
│  │ • Budgets    │  │ • S3 proxy   │  │ • Retries    │                      │
│  │ • Allowlists │  │ • Artifacts  │  │ • Monitoring │                      │
│  └──────────────┘  └──────────────┘  └──────────────┘                      │
│                                                                             │
└─────────────────────────────────┬───────────────────────────────────────────┘
                                  │
         ┌────────────────────────┼────────────────────────┐
         ▼                        ▼                        ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   PostgreSQL    │    │     Redis       │    │    Message Q    │
│                 │    │                 │    │                 │
│ • Users/orgs    │    │ • Sessions      │    │ • Job events    │
│ • Deployments   │    │ • Rate limits   │    │ • Webhooks      │
│ • Usage/billing │    │ • Node health   │    │ • Async tasks   │
│ • Agent wallets │    │ • Caching       │    │                 │
└─────────────────┘    └─────────────────┘    └─────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        NOSANA INTEGRATION LAYER                             │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      Nosana SDK Wrapper                              │   │
│  │                                                                      │   │
│  │  • Market discovery & pricing                                        │   │
│  │  • Job definition generation                                         │   │
│  │  • Deployment lifecycle management                                   │   │
│  │  • Health check polling                                              │   │
│  │  • Node URL resolution                                               │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────┬───────────────────────────────────────────┘
                                  │ Solana RPC + IPFS
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          NOSANA GPU NETWORK                                 │
│                                                                             │
│    [RTX 3060]    [RTX 4070]    [RTX 4090]    [A100]    [H100]              │
│        │             │             │           │          │                 │
│        └─────────────┴─────────────┴───────────┴──────────┘                 │
│                              Ephemeral Nodes                                │
│                        (Container execution, GPUs)                          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Service Breakdown

### 4.1 Web Service (Next.js Frontend)

**Responsibilities:**
- Server-side rendered dashboard
- Authentication flows (email/password, wallet connect)
- Model deployment wizard UI
- Deployment monitoring dashboard
- Usage and billing views
- API key management
- Playground/chat interface

**Technology:** Next.js 14 (App Router), TypeScript, TailwindCSS, shadcn/ui

**Key pages:**
- `/` — Landing page
- `/login`, `/register` — Auth flows
- `/dashboard` — Overview, active deployments, usage
- `/models` — Model catalog, deploy wizard
- `/deployments/[id]` — Deployment detail, logs, playground
- `/settings` — Account, API keys, billing
- `/billing` — Credits, usage history, invoices

### 4.2 API Service (REST + tRPC)

**Responsibilities:**
- CRUD for users, organizations, deployments
- Model catalog queries
- Deployment creation/management
- Usage aggregation
- Billing operations
- Webhook management

**Technology:** Node.js, Fastify, tRPC, Prisma ORM

**Key endpoints:**
```
POST   /api/auth/login
POST   /api/auth/register
GET    /api/models                    # Catalog
POST   /api/deployments               # Create deployment
GET    /api/deployments               # List deployments
GET    /api/deployments/:id           # Deployment detail
DELETE /api/deployments/:id           # Terminate
GET    /api/deployments/:id/logs      # Logs stream
POST   /api/deployments/:id/restart   # Restart
GET    /api/usage                     # Usage summary
GET    /api/billing/credits           # Credit balance
POST   /api/billing/credits/purchase  # Buy credits
GET    /api/keys                      # API keys
POST   /api/keys                      # Create API key
```

### 4.3 Inference Proxy Service

**Responsibilities:**
- OpenAI-compatible API endpoint (`/v1/chat/completions`, etc.)
- API key validation
- Request routing to healthy Nosana nodes
- Load balancing across replicas
- Usage metering (tokens in/out, latency)
- Automatic retry on node failures
- (Future) X-402 payment validation

**Technology:** Node.js, Fastify, custom routing logic

**Key design:**
```
Request Flow:
1. Validate API key → lookup deployment
2. Check credit balance (reject if insufficient)
3. Select healthy node from pool
4. Proxy request to node
5. On failure: retry with different node (max 2 retries)
6. Meter usage (tokens, latency)
7. Deduct credits
8. Return response
```

### 4.4 Job Service (Nosana Integration)

**Responsibilities:**
- Convert deployment configs to Nosana job definitions
- Submit jobs via Nosana SDK
- Monitor job/deployment status
- Handle deployment lifecycle (create, scale, terminate)
- Resolve ephemeral node URLs
- Poll health endpoints

**Technology:** Node.js, `@nosana/sdk`, Solana web3.js

**Job definition generation:**
```typescript
interface DeploymentConfig {
  modelId: string;          // e.g., "meta-llama/Meta-Llama-3.1-8B-Instruct"
  engine: "vllm" | "ollama";
  gpuTier: "3060" | "4090" | "a100";
  replicas: number;
  maxTokens: number;
  quantization?: "awq" | "gptq" | "fp16";
}

// Output: Nosana job JSON
```

### 4.5 Payment Service

**Responsibilities:**
- Credit balance management
- Usage tracking and aggregation
- Credit purchases (Stripe, crypto)
- Invoice generation
- (Future) X-402 payment validation
- (Future) Revenue splits

**Technology:** Node.js, Stripe SDK, Solana web3.js

**MVP scope:** Prepaid credits only
- Buy credits with card (Stripe)
- Buy credits with USDC/SOL (direct transfer)
- Per-request deduction based on token usage
- Low balance alerts

### 4.6 Routing Service

**Responsibilities:**
- Maintain registry of active nodes per deployment
- Health check polling (every 30s)
- Latency measurements
- Node selection algorithm
- Failover logic

**Node health states:**
- `healthy` — Responding, latency acceptable
- `degraded` — Responding but slow
- `unhealthy` — Not responding, excluded from routing
- `unknown` — New node, needs verification

**Selection algorithm (MVP):**
```
1. Filter to healthy nodes only
2. Weight by inverse latency (faster = higher weight)
3. Random selection with weights
```

### 4.7 Wallet Service (Phase 2)

**Responsibilities:**
- Generate agent wallet keypairs
- Secure key storage (encrypted at rest)
- Budget enforcement
- Allowlist management
- Transaction signing
- Balance monitoring
- Auto top-up triggers

**Security model:** Keys encrypted with user-specific KEK derived from master key + user ID. Keys never leave server unencrypted.

### 4.8 Storage Service

**Responsibilities:**
- IPFS pinning for job definitions
- Model artifact caching (S3-compatible)
- Log aggregation
- Training dataset storage (Phase 2)

### 4.9 Worker Service

**Responsibilities:**
- Async job processing (job submission, monitoring)
- Scheduled health checks
- Usage aggregation jobs
- Webhook delivery
- Cleanup tasks

**Technology:** BullMQ (Redis-based job queue)

---

## 5. Technology Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| **Frontend** | Next.js 14, TypeScript | SSR for dashboard, React ecosystem, type safety |
| **UI Components** | shadcn/ui + TailwindCSS | Accessible, customizable, fast to build |
| **API Framework** | Fastify + tRPC | Fast, typed end-to-end, good DX |
| **ORM** | Prisma | Type-safe queries, good migration story |
| **Primary DB** | PostgreSQL 15 | Reliable, JSONB for flexibility, proven at scale |
| **Cache/Queue** | Redis 7 | Sessions, rate limits, BullMQ job queue |
| **Message Queue** | BullMQ | Robust, Redis-based, good monitoring |
| **Auth** | NextAuth.js + custom JWT | Wallet connect support, flexible providers |
| **Payments** | Stripe + Solana web3.js | Cards via Stripe, crypto direct |
| **Blockchain** | Solana mainnet-beta | Nosana's chain, fast finality |
| **Nosana** | @nosana/sdk | Official SDK for job management |
| **IPFS** | Pinata or Nosana's pinning | Job definition storage |
| **Object Storage** | S3-compatible (Cloudflare R2) | Model artifacts, logs, cheap |
| **Hosting** | Fly.io or Railway | Simple deployment, good for early stage |
| **CDN/Edge** | Cloudflare | DDoS protection, caching, Workers for edge logic |
| **Monitoring** | Prometheus + Grafana | Industry standard, self-hostable |
| **Logging** | Loki or Axiom | Structured logs, cost-effective |
| **Error Tracking** | Sentry | Good Next.js integration |

### Why NOT:

- **Kubernetes**: Over-engineered for early stage. Fly.io/Railway abstract enough.
- **GraphQL**: tRPC gives us type safety without schema overhead.
- **MongoDB**: PostgreSQL handles our use cases better, JSONB when needed.
- **AWS Lambda**: Cold starts problematic for inference proxy latency.
- **Custom auth**: NextAuth handles wallet connect and OAuth well.

---

## 6. Data Models

### 6.1 Core Schema (PostgreSQL)

```sql
-- Users and authentication
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           TEXT UNIQUE,
    password_hash   TEXT,
    wallet_address  TEXT UNIQUE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE organizations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    owner_id        UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE org_members (
    org_id          UUID REFERENCES organizations(id),
    user_id         UUID REFERENCES users(id),
    role            TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
    PRIMARY KEY (org_id, user_id)
);

-- API keys
CREATE TABLE api_keys (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID REFERENCES organizations(id),
    key_hash        TEXT NOT NULL UNIQUE,  -- SHA256 of actual key
    key_prefix      TEXT NOT NULL,         -- First 8 chars for display
    name            TEXT,
    scopes          TEXT[] DEFAULT '{}',
    last_used_at    TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Model catalog (seeded, rarely changes)
CREATE TABLE models (
    id              TEXT PRIMARY KEY,      -- e.g., "llama-3.1-8b"
    hf_id           TEXT NOT NULL,         -- HuggingFace model ID
    display_name    TEXT NOT NULL,
    description     TEXT,
    parameters      BIGINT,                -- 8B, 70B, etc.
    min_gpu_tier    TEXT NOT NULL,         -- Minimum GPU required
    supported_engines TEXT[] NOT NULL,
    default_engine  TEXT NOT NULL,
    context_length  INTEGER NOT NULL,
    license         TEXT,
    tags            TEXT[],
    pricing_tier    TEXT NOT NULL,         -- 'small', 'medium', 'large'
    is_active       BOOLEAN DEFAULT true,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Deployments
CREATE TABLE deployments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID REFERENCES organizations(id),
    name            TEXT NOT NULL,
    slug            TEXT NOT NULL,         -- URL-safe identifier
    model_id        TEXT REFERENCES models(id),
    engine          TEXT NOT NULL,
    gpu_tier        TEXT NOT NULL,
    replicas        INTEGER DEFAULT 1,
    config          JSONB NOT NULL,        -- Full deployment config
    status          TEXT NOT NULL CHECK (status IN (
                        'pending', 'provisioning', 'running',
                        'degraded', 'stopped', 'failed'
                    )),
    nosana_job_ids  TEXT[],                -- Nosana job/deployment IDs
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    stopped_at      TIMESTAMPTZ,
    UNIQUE(org_id, slug)
);

-- Deployment nodes (ephemeral)
CREATE TABLE deployment_nodes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deployment_id   UUID REFERENCES deployments(id) ON DELETE CASCADE,
    nosana_node_id  TEXT NOT NULL,
    node_url        TEXT NOT NULL,         -- Current endpoint URL
    health_status   TEXT DEFAULT 'unknown',
    last_health_check TIMESTAMPTZ,
    latency_ms      INTEGER,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Billing and credits
CREATE TABLE credit_balances (
    org_id          UUID PRIMARY KEY REFERENCES organizations(id),
    balance_cents   BIGINT NOT NULL DEFAULT 0,  -- In cents (USD)
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE credit_transactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID REFERENCES organizations(id),
    amount_cents    BIGINT NOT NULL,       -- Positive = credit, negative = debit
    type            TEXT NOT NULL CHECK (type IN (
                        'purchase', 'usage', 'refund', 'adjustment', 'bonus'
                    )),
    description     TEXT,
    reference_id    TEXT,                  -- Stripe charge ID, usage period, etc.
    balance_after   BIGINT NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Usage tracking (aggregated hourly)
CREATE TABLE usage_records (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID REFERENCES organizations(id),
    deployment_id   UUID REFERENCES deployments(id),
    period_start    TIMESTAMPTZ NOT NULL,  -- Hour boundary
    period_end      TIMESTAMPTZ NOT NULL,
    request_count   INTEGER DEFAULT 0,
    input_tokens    BIGINT DEFAULT 0,
    output_tokens   BIGINT DEFAULT 0,
    total_latency_ms BIGINT DEFAULT 0,
    error_count     INTEGER DEFAULT 0,
    cost_cents      BIGINT DEFAULT 0,
    UNIQUE(org_id, deployment_id, period_start)
);

-- Agent wallets (Phase 2)
CREATE TABLE agent_wallets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID REFERENCES organizations(id),
    deployment_id   UUID REFERENCES deployments(id),
    wallet_address  TEXT NOT NULL UNIQUE,
    encrypted_key   BYTEA NOT NULL,        -- Encrypted private key
    key_version     INTEGER DEFAULT 1,
    daily_limit_cents BIGINT,
    per_tx_limit_cents BIGINT,
    allowed_domains TEXT[],
    is_active       BOOLEAN DEFAULT true,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE agent_transactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id       UUID REFERENCES agent_wallets(id),
    direction       TEXT NOT NULL CHECK (direction IN ('in', 'out')),
    amount_lamports BIGINT NOT NULL,
    token           TEXT NOT NULL,         -- 'SOL', 'USDC', 'NOS'
    counterparty    TEXT NOT NULL,         -- Address
    tx_signature    TEXT UNIQUE,
    status          TEXT DEFAULT 'pending',
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_deployments_org ON deployments(org_id);
CREATE INDEX idx_deployments_status ON deployments(status);
CREATE INDEX idx_deployment_nodes_deployment ON deployment_nodes(deployment_id);
CREATE INDEX idx_usage_records_org_period ON usage_records(org_id, period_start);
CREATE INDEX idx_credit_transactions_org ON credit_transactions(org_id, created_at);
```

### 6.2 Redis Data Structures

```
# Session storage
session:{session_id} -> JSON user session (TTL 24h)

# API key validation cache
apikey:{key_hash} -> JSON { org_id, scopes, deployment_ids } (TTL 5m)

# Rate limiting
ratelimit:{org_id}:{endpoint} -> counter (TTL 1m)

# Node health cache
node:{deployment_id}:{node_id} -> JSON health state (TTL 2m)

# Deployment routing cache
routing:{deployment_id} -> JSON [{ node_id, url, weight }] (TTL 30s)

# Real-time usage (before aggregation)
usage:{org_id}:{deployment_id}:{hour} -> HASH {
    requests: int,
    input_tokens: int,
    output_tokens: int,
    errors: int
}
```

---

## 7. Payment Architecture

### 7.1 MVP: Prepaid Credits

```
┌─────────────────────────────────────────────────────────────────┐
│                    Credit System (MVP)                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  PURCHASE FLOW:                                                 │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐                  │
│  │  User    │───►│  Stripe  │───►│ Webhook  │                  │
│  │ Checkout │    │ Payment  │    │ Handler  │                  │
│  └──────────┘    └──────────┘    └────┬─────┘                  │
│                                       │                         │
│                                       ▼                         │
│                               ┌──────────────┐                  │
│                               │ Credit       │                  │
│                               │ Transaction  │                  │
│                               │ + Balance    │                  │
│                               └──────────────┘                  │
│                                                                 │
│  USAGE FLOW:                                                    │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐                  │
│  │  API     │───►│  Check   │───►│  Proxy   │                  │
│  │ Request  │    │ Balance  │    │ Request  │                  │
│  └──────────┘    └────┬─────┘    └────┬─────┘                  │
│                       │               │                         │
│                       │ If balance    │ On success              │
│                       │ < min_cost    │                         │
│                       ▼               ▼                         │
│                  ┌─────────┐    ┌──────────┐                   │
│                  │  402    │    │  Deduct  │                   │
│                  │ Payment │    │ Credits  │                   │
│                  │ Required│    └──────────┘                   │
│                  └─────────┘                                    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Pricing model (MVP):**

| Model Tier | Input (per 1K tokens) | Output (per 1K tokens) |
|------------|----------------------|------------------------|
| Small (7-8B) | $0.00015 | $0.00060 |
| Medium (13-34B) | $0.00030 | $0.00120 |
| Large (70B+) | $0.00090 | $0.00360 |

**Credit denominations:**
- $5, $20, $50, $100, $500
- Minimum balance for API access: $0.10

**Low balance handling:**
1. At 20% of purchase amount: Email warning
2. At $1.00 remaining: Dashboard alert
3. At $0.00: Reject requests with 402

### 7.2 Phase 2: X-402 Integration

```
┌─────────────────────────────────────────────────────────────────┐
│                    X-402 Flow                                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. Request without payment                                     │
│     GET /v1/llama-8b/chat/completions                          │
│                                                                 │
│  2. Server responds 402                                         │
│     HTTP/1.1 402 Payment Required                               │
│     X-Payment-Required: {                                       │
│       "scheme": "exact",                                        │
│       "network": "solana:mainnet",                              │
│       "maxAmount": "100000",  // 0.1 USDC                       │
│       "asset": "USDC",                                          │
│       "payTo": "WheelsAiTreasury..."                            │
│     }                                                           │
│                                                                 │
│  3. Client signs payment                                        │
│     - Construct Solana transaction                              │
│     - Sign with wallet                                          │
│     - Encode as X-Payment header                                │
│                                                                 │
│  4. Retry with payment                                          │
│     GET /v1/llama-8b/chat/completions                          │
│     X-Payment: <signed_tx_base64>                               │
│                                                                 │
│  5. Server validates                                            │
│     - Verify signature                                          │
│     - Check amount >= required                                  │
│     - Submit to facilitator (or direct to chain)                │
│                                                                 │
│  6. Execute request & respond                                   │
│     HTTP/1.1 200 OK                                             │
│     X-Payment-Response: { "txHash": "..." }                     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**X-402 considerations:**
- Use Coinbase's facilitator initially (handles settlement)
- Self-hosted facilitator later for lower fees
- Support USDC on Solana only in Phase 2
- Add NOS token support after USDC validation

---

## 8. Agent Wallet Design (Phase 2)

### 8.1 Wallet Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Agent Wallet System                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  KEY MANAGEMENT:                                                │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Master Key (HSM or env var in MVP)                     │   │
│  │         │                                               │   │
│  │         ▼                                               │   │
│  │  ┌─────────────────────────────────────────────────┐   │   │
│  │  │  KEK = HKDF(master_key, org_id, "wallet-kek")   │   │   │
│  │  └─────────────────────────────────────────────────┘   │   │
│  │         │                                               │   │
│  │         ▼                                               │   │
│  │  ┌─────────────────────────────────────────────────┐   │   │
│  │  │  encrypted_key = AES-GCM(KEK, private_key)      │   │   │
│  │  │  Stored in PostgreSQL                           │   │   │
│  │  └─────────────────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  BUDGET ENFORCEMENT:                                            │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Before signing any transaction:                        │   │
│  │  1. Check daily spent < daily_limit                     │   │
│  │  2. Check tx amount < per_tx_limit                      │   │
│  │  3. Check recipient in allowed_domains                  │   │
│  │  4. Log transaction intent                              │   │
│  │  5. Sign and submit                                     │   │
│  │  6. Update daily spent counter                          │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  AUTO TOP-UP:                                                   │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  When balance < threshold:                              │   │
│  │  1. Notify owner via webhook                            │   │
│  │  2. If auto_topup enabled:                              │   │
│  │     - Request signature from owner wallet               │   │
│  │     - Transfer configured amount                        │   │
│  │  3. If manual: send email/dashboard alert               │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 8.2 Security Constraints

1. **Keys never leave server memory unencrypted**
2. **All signing operations logged with full context**
3. **Budget checks are synchronous, atomic**
4. **Allowlist is default-deny**
5. **Owner can freeze wallet instantly**
6. **Daily limits reset at UTC midnight**
7. **No transaction batching (simplifies accounting)**

### 8.3 Threat Model

| Threat | Mitigation |
|--------|------------|
| Key theft from DB | Encryption at rest with per-org KEK |
| Malicious agent draining funds | Per-tx and daily limits, allowlists |
| Replay attacks | Nonce management, Solana's built-in |
| Owner wallet compromise | Agent wallet is separate, limited |
| Service compromise | HSM for master key (production) |

---

## 9. Failure & Recovery Scenarios

### 9.1 Nosana Node Failures

**Scenario:** Node becomes unresponsive mid-request

```
Detection:
- Request timeout (30s default)
- Health check fails (3 consecutive)

Response:
1. Mark node as unhealthy in routing cache
2. Retry request to different node (max 2 retries)
3. If all nodes unhealthy: return 503 to client
4. Background: check if Nosana deployment needs restart

Recovery:
- Health checker will re-enable node when responding
- Nosana deployment manager handles container restart
```

**Scenario:** Entire deployment loses all nodes

```
Detection:
- All nodes unhealthy for 5+ minutes
- Nosana deployment status != running

Response:
1. Mark deployment as degraded
2. Attempt deployment restart via Nosana SDK
3. Notify org via webhook + email
4. Return 503 with retry-after header

Recovery:
- Monitor Nosana deployment status
- When nodes come back, health checker re-enables
- Clear degraded status when >= 1 healthy node
```

### 9.2 Payment Failures

**Scenario:** Credit deduction fails after request completes

```
Response:
1. Log the failure with full context
2. Return response to user (don't fail the request)
3. Queue retry for credit deduction
4. If retry fails 3x: flag for manual review

Why: User experience > perfect accounting. Fix in reconciliation.
```

**Scenario:** X-402 payment verification fails

```
Response:
1. Return 402 with error details
2. Do not execute the request
3. Log attempt for fraud detection

Why: No payment, no service. Simple.
```

### 9.3 Deployment Creation Failures

**Scenario:** Nosana job submission fails

```
Response:
1. Return error to user with details
2. Mark deployment as failed
3. Do not charge for compute
4. Provide retry button in UI

Causes:
- Insufficient NOS balance (user-fixable)
- Market unavailable (retry later)
- Invalid job definition (bug, escalate)
```

### 9.4 Database Failures

**Scenario:** PostgreSQL unavailable

```
Response:
- Auth: Fail closed (no new sessions)
- API reads: Serve from Redis cache where possible
- API writes: Return 503
- Inference proxy: Continue with cached API keys (5m TTL)
- Usage metering: Buffer in Redis, flush when DB returns

Recovery:
- Automatic failover to replica (if configured)
- Flush Redis buffers on reconnection
```

---

## 10. Security Considerations

### 10.1 Authentication & Authorization

```
┌─────────────────────────────────────────────────────────────────┐
│                    Auth Architecture                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  USER AUTH:                                                     │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │  Email/Password:                                          │ │
│  │  - Argon2id password hashing                              │ │
│  │  - Email verification required                            │ │
│  │  - Rate limit: 5 attempts / 15 min                        │ │
│  │                                                           │ │
│  │  Wallet Connect:                                          │ │
│  │  - Sign nonce with Solana wallet                          │ │
│  │  - Verify signature server-side                           │ │
│  │  - Create session on success                              │ │
│  │                                                           │ │
│  │  Sessions:                                                │ │
│  │  - JWT stored in httpOnly cookie                          │ │
│  │  - 24h expiry, refresh on activity                        │ │
│  │  - Stored in Redis for revocation                         │ │
│  └───────────────────────────────────────────────────────────┘ │
│                                                                 │
│  API KEY AUTH:                                                  │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │  Format: wheels_live_<random_32_bytes_base64>             │ │
│  │  Storage: SHA256 hash in DB (original never stored)       │ │
│  │  Scopes: deployments:read, deployments:write, etc.        │ │
│  │  Rate limits: Per-org, per-key configurable               │ │
│  └───────────────────────────────────────────────────────────┘ │
│                                                                 │
│  AUTHORIZATION:                                                 │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │  - Org-based: Users belong to orgs                        │ │
│  │  - Roles: owner, admin, member                            │ │
│  │  - Resources scoped to org_id                             │ │
│  │  - Every query includes org_id in WHERE clause            │ │
│  └───────────────────────────────────────────────────────────┘ │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 10.2 Key Security

| Key Type | Storage | Access |
|----------|---------|--------|
| API keys | SHA256 hash in PostgreSQL | Validated per-request |
| Session tokens | Redis with expiry | httpOnly cookie |
| Agent wallet keys | AES-GCM encrypted in PostgreSQL | Decrypted only for signing |
| Master encryption key | Environment variable (dev), HSM (prod) | Loaded at startup only |
| Nosana wallet key | Environment variable | Job submission only |

### 10.3 Input Validation

- All API inputs validated with Zod schemas
- SQL injection: Prevented by Prisma parameterized queries
- XSS: React auto-escapes, CSP headers
- CSRF: SameSite cookies + CSRF tokens
- Request size limits: 10MB default, 100MB for file uploads

### 10.4 Rate Limiting

| Endpoint | Limit | Window |
|----------|-------|--------|
| Auth endpoints | 10 req | 1 min |
| API (per org) | 1000 req | 1 min |
| Inference (per org) | 100 req | 1 sec |
| Deployment create | 10 req | 1 hour |

### 10.5 Abuse Prevention

1. **Credit fraud**: Require email verification, card verification via Stripe
2. **API abuse**: Rate limits, anomaly detection on usage patterns
3. **Compute abuse**: Audit deployed container images, restrict to known-good
4. **Wallet draining**: Per-tx limits, daily limits, allowlists
5. **DDoS**: Cloudflare protection, per-IP rate limits

---

## 11. Environments

### 11.1 Development (Local)

```
Components:
- Next.js dev server (hot reload)
- PostgreSQL (Docker)
- Redis (Docker)
- Nosana SDK pointed to devnet

Setup:
docker-compose up -d postgres redis
npm run dev

Notes:
- Use Nosana devnet (free, test tokens)
- Mock Stripe webhooks with stripe-cli
- Self-signed certs for local HTTPS
```

### 11.2 Staging

```
Components:
- Full deployment on Fly.io (separate app)
- PostgreSQL (Fly.io managed)
- Redis (Upstash)
- Nosana SDK pointed to devnet or testnet

Purpose:
- Integration testing
- Pre-production validation
- Demo environment

Data:
- Synthetic test data
- Separate Stripe test mode
- Can be reset weekly
```

### 11.3 Production

```
Components:
- Fly.io multi-region (LAX, EWR initially)
- PostgreSQL (Fly.io managed, with replica)
- Redis (Upstash, multi-region)
- Nosana SDK pointed to mainnet-beta

Deployment:
- GitHub Actions CI/CD
- Blue-green deployments
- Automatic rollback on health check failure

Monitoring:
- Sentry for errors
- Grafana Cloud for metrics
- PagerDuty for alerts
```

---

## 12. Observability

### 12.1 Logging

```typescript
// Structured log format
{
  "timestamp": "2025-01-05T10:30:00Z",
  "level": "info",
  "service": "inference-proxy",
  "trace_id": "abc123",
  "span_id": "def456",
  "message": "Request completed",
  "org_id": "org_xxx",
  "deployment_id": "dep_xxx",
  "duration_ms": 1234,
  "tokens_in": 150,
  "tokens_out": 500,
  "status": 200
}
```

### 12.2 Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `http_requests_total` | Counter | method, path, status |
| `http_request_duration_ms` | Histogram | method, path |
| `inference_requests_total` | Counter | model, org_id, status |
| `inference_tokens_total` | Counter | model, direction (in/out) |
| `inference_latency_ms` | Histogram | model |
| `node_health_status` | Gauge | deployment_id, node_id |
| `credit_balance_cents` | Gauge | org_id |
| `nosana_job_status` | Gauge | deployment_id, status |

### 12.3 Alerts

| Alert | Condition | Severity |
|-------|-----------|----------|
| High error rate | 5xx > 5% for 5m | Critical |
| Deployment unhealthy | All nodes unhealthy 10m | High |
| Low Nosana balance | < 100 NOS | High |
| Credit deduction failures | > 10/hour | Medium |
| High latency | P95 > 5s for 10m | Medium |

---

## 13. Phased Milestones

### PHASE 0: Foundations (Weeks 1-2) - COMPLETE

**Scope:**
- [x] Project scaffolding (Next.js, Fastify, Prisma)
- [x] Database schema and migrations
- [x] Basic auth (email/password, wallet connect)
- [x] Nosana SDK integration (job submission, status polling)
- [x] Local development environment
- [x] CI pipeline (lint, test, build)

**Out of scope:**
- Production deployment
- Payments
- Inference proxy

**Deliverables:**
- Repo with running dev environment
- Can authenticate and view empty dashboard
- Can submit test job to Nosana devnet

---

### PHASE 1: MVP (Weeks 3-10) - IN PROGRESS

**Scope:**
- [x] Model catalog (seeded with 10-15 models)
- [x] Deployment wizard UI
- [x] Job generation engine (vLLM only)
- [x] Deployment lifecycle management
- [x] Node health checking
- [x] Inference proxy with load balancing
- [x] OpenAI-compatible API endpoint
- [x] Prepaid credits (Stripe integration placeholder)
- [x] Usage metering and billing dashboard
- [x] API key management
- [x] Basic dashboard (deployments, usage)
- [x] Playground/chat interface
- [x] Settings page
- [ ] Staging environment
- [ ] Production deployment

**Out of scope:**
- Agent Studio / visual builder (moved to Phase 2)
- Training Studio (moved to Phase 2)
- X-402 payments (moved to Phase 2)
- Agent wallets (moved to Phase 2)
- Multi-chain support

**Deliverables:**
- User can sign up, add credits
- User can deploy Llama 8B/70B with one click
- User gets stable OpenAI-compatible endpoint
- User is billed per token
- 99% uptime target

---

### PHASE 2: Expansion (Weeks 11-20) - IN PROGRESS

**Scope:**
- [x] Agent Studio (code-first, not visual)
- [x] Mastra + LangChain + AutoGen framework support
- [x] Agent deployment workflow
- [x] X-402 payment integration (service layer)
- [x] Agent wallets (basic) with AES-256-GCM encryption
- [x] Budget controls (daily limits, per-tx limits, allowlists)
- [x] Training Studio (LoRA/QLoRA)
- [x] Dataset upload and validation
- [x] Training job monitoring
- [x] Ollama engine support (vLLM alternative with 22 models)
- [ ] More GPU tiers
- [ ] Staging environment
- [ ] Production deployment

**Completed Components:**

*Agent Studio:*
- Agent CRUD API routes (`/api/agents`)
- Multi-framework support (Mastra, LangChain, AutoGen, Custom)
- Agent deployment with Nosana GPU jobs
- Agent runtime service for job definition generation
- Agent detail, list, and create wizard UI

*Agent Wallets:*
- Encrypted key storage with per-org KEKs
- Wallet creation for agent deployments
- Budget enforcement (daily/per-tx limits)
- Allowlist support for transaction recipients
- Balance checking and transaction execution

*X-402 Payments:*
- Price calculation per model tier
- Payment requirement generation
- Transaction verification on Solana
- Support for USDC, SOL, and NOS tokens

*Training Studio:*
- Dataset API routes (`/api/training/datasets`)
- Training job API routes (`/api/training/jobs`)
- Dataset upload with S3 presigned URLs
- Dataset validation (JSONL, CSV, Alpaca, ShareGPT formats)
- Training job service with LoRA/QLoRA support
- Cost estimation based on dataset size and GPU tier
- Training job list, detail, and create wizard UI

*Ollama Engine:*
- Ollama job definitions in Nosana service with model pulling
- OpenAI-compatible proxy option for Ollama deployments
- Expanded model catalog from 8 to 22 models with Ollama mappings
- `ollamaModelId` field in database schema
- Engine selection UI in deployment wizard (vLLM vs Ollama)
- Feature comparison and recommended engine badges

**Out of scope:**
- Visual agent builder
- Agent-to-agent payments
- Full fine-tuning (7B+ models)
- Multi-chain settlement
- Marketplace

**Deliverables:**
- User can deploy agents with wallet
- User can pay per-request with X-402
- User can fine-tune models with LoRA
- User can deploy trained model

---

### PHASE 3: Platform (Weeks 21-40)

**Scope:**
- [ ] Visual agent builder
- [ ] Agent-to-agent payments
- [ ] Agent marketplace / discovery
- [ ] Reputation system
- [ ] Multi-chain settlement (Base, Arbitrum)
- [ ] Full fine-tuning support
- [ ] Enterprise features (SSO, audit logs)
- [ ] Custom domains
- [ ] Advanced analytics

**Out of scope:**
- Mobile apps
- Self-hosted version

---

## 14. Open Questions & Risks

### Technical Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Nosana SDK instability | Medium | High | Wrap SDK, extensive error handling, fallbacks |
| Node URL changes break routing | Medium | High | Aggressive health checking, retry logic |
| vLLM Docker images fail on Nosana | Low | High | Test extensively on devnet first |
| IPFS pinning unreliable | Low | Medium | Use Pinata as backup, cache job definitions |
| X-402 facilitator unavailable | Medium | Medium | Self-host facilitator option |

### Product Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Users don't want prepaid credits | Medium | High | Add X-402 quickly if credits unpopular |
| Model catalog too limited | Medium | Medium | Prioritize adding models users request |
| Agent framework lock-in concerns | Low | Medium | Support multiple frameworks |
| Nosana costs higher than expected | Medium | High | Clear cost calculator, alerts |

### Open Questions

1. **Nosana devnet vs testnet vs mainnet?**
   - Decision: Start devnet, move to mainnet-beta for production (no real testnet)

2. **Should we run our own Nosana nodes?**
   - Decision: No. Use public market. Revisit if reliability issues.

3. **How do we handle model licensing?**
   - Decision: Display license in UI, user acknowledges. We don't police usage.

4. **What's the minimum credit purchase?**
   - Decision: $5 to start. Lower if conversion is an issue.

5. **How do we price compute vs competitors?**
   - Decision: 20-30% below OpenAI equivalent for same model size.

6. **HSM for master key in production?**
   - Decision: Defer. Use env var with Fly.io secrets initially. Add HSM at scale.

7. **Multi-region from day one?**
   - Decision: No. Single region (us-west) for MVP. Add regions based on user distribution.

---

## 15. Appendix: Nosana Job Templates

### vLLM Inference Job

```json
{
  "version": "0.1",
  "type": "container",
  "meta": {
    "trigger": "cli"
  },
  "ops": [
    {
      "type": "container/run",
      "id": "vllm-inference",
      "args": {
        "image": "vllm/vllm-openai:v0.6.0",
        "cmd": [
          "--model", "meta-llama/Meta-Llama-3.1-8B-Instruct",
          "--host", "0.0.0.0",
          "--port", "8000",
          "--max-model-len", "4096",
          "--gpu-memory-utilization", "0.9"
        ],
        "gpu": true,
        "expose": [8000]
      }
    }
  ]
}
```

### Agent Container Job

```json
{
  "version": "0.1",
  "type": "container",
  "meta": {
    "trigger": "cli"
  },
  "ops": [
    {
      "type": "container/run",
      "id": "agent-runtime",
      "args": {
        "image": "wheelsai/agent-runtime:latest",
        "env": {
          "AGENT_CONFIG_URL": "ipfs://Qm...",
          "MODEL_ENDPOINT": "http://localhost:8000/v1",
          "WALLET_PRIVATE_KEY_ENCRYPTED": "..."
        },
        "gpu": true,
        "expose": [3000]
      }
    }
  ]
}
```

---

## 16. Development Commands

```bash
# Initial setup
git clone <repo>
cd wheelsai
cp .env.example .env
npm install
docker-compose up -d
npx prisma migrate dev
npm run dev

# Run tests
npm test
npm run test:e2e

# Deploy staging
git push origin main  # Auto-deploys to staging

# Deploy production
npm run deploy:prod  # Requires approval

# Database operations
npx prisma studio    # Visual DB browser
npx prisma migrate deploy  # Run migrations

# Nosana operations
npm run nosana:check-balance
npm run nosana:list-markets
npm run nosana:submit-test-job
```

---

*This document is the source of truth for WheelsAI technical decisions. Update it as decisions change.*
