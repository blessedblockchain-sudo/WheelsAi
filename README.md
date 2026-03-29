<p align="center">
  <img src="https://via.placeholder.com/120x120/040a18/3b82f6?text=W" alt="WheelsAI Logo" width="120" height="120" />
</p>

<h1 align="center">WheelsAI</h1>

<p align="center">
  <strong>Build, Deploy & Monetize AI Agents — One Platform</strong><br/>
  Eliminate fragmentation across frameworks, hosting, and monetization. Import from GitHub, deploy to 10+ channels, earn 90% revenue.
</p>

<p align="center">
  <a href="#features">Features</a> &bull;
  <a href="#architecture">Architecture</a> &bull;
  <a href="#tech-stack">Tech Stack</a> &bull;
  <a href="#getting-started">Getting Started</a> &bull;
  <a href="#api-reference">API Reference</a> &bull;
  <a href="#deployment">Deployment</a> &bull;
  <a href="#roadmap">Roadmap</a>
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

## Overview

**WheelsAI** solves the fragmentation problem in AI agent development. Today, building an agent means stitching together frameworks, hosting, inference, and monetization from separate tools and platforms. WheelsAI brings it all together — build with any framework (or import from GitHub), deploy to 10+ channels with one click, and monetize through a marketplace with bonding curve token economics.

Platform-agnostic. Framework-agnostic. Built on Solana.

### Why WheelsAI?

| Problem | WheelsAI Solution |
|---------|-------------------|
| Building AI agents requires stitching together fragmented tools | Unified platform: build, deploy, test, monitor, monetize in one place |
| Framework lock-in limits flexibility | First-class support for Mastra, ElizaOS, LangChain, AutoGen, CrewAI, or custom |
| Infrastructure complexity blocks agent builders | We handle compute — you focus on your agent. Import from GitHub and deploy in seconds |
| No clear path to monetize agents | Two-track marketplace: traditional pricing + pump.fun-style bonding curve tokens |
| Enterprise requirements are an afterthought | SSO, RBAC, audit logging, 2FA, custom domains, and SLAs from day one |

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
  - [System Architecture](#system-architecture)
  - [Monorepo Structure](#monorepo-structure)
  - [Package Dependencies](#package-dependencies)
  - [Frontend Architecture](#frontend-architecture)
  - [Backend Architecture](#backend-architecture)
  - [Database Schema](#database-schema)
  - [Blockchain Integration](#blockchain-integration)
- [Tech Stack](#tech-stack)
- [Features](#features)
  - [Core Platform](#core-platform)
  - [AI & Models](#ai--models)
  - [Agent Ecosystem](#agent-ecosystem)
  - [Knowledge & Memory](#knowledge--memory)
  - [Orchestration & Scheduling](#orchestration--scheduling)
  - [Testing & Monitoring](#testing--monitoring)
  - [Security & Auth](#security--auth)
  - [Billing & Payments](#billing--payments)
  - [OpenClaw Integration](#openclaw-integration)
  - [Token Marketplace](#token-marketplace)
  - [Free Tier & Rate Limiting](#free-tier--rate-limiting)
  - [Integrations](#integrations)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [Scripts](#scripts)
- [API Reference](#api-reference)
- [Design System](#design-system)
- [Deployment](#deployment)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## Architecture

### System Architecture

```
                                     +-------------------+
                                     |   Solana Network   |
                                     | SOL / USDC / NOS   |
                                     +--------+----------+
                                              |
+---------------+     +---------------+     +-+----------+     +-------------------+
|               |     |               |     |            |     |                   |
|  Next.js 15   +---->+  Fastify API  +---->+ PostgreSQL |     |  Nosana Network   |
|  (Frontend)   |     |  (Backend)    |     |  + Redis   |     |  2,000+ GPUs      |
|  Port 3000    |     |  Port 4000    |     |            |     |  3060 --> H100    |
|               |     |               +---->+            |     |                   |
+-------+-------+     +-------+-------+     +------------+     +-------------------+
        |                     |                                         ^
        |  tRPC / REST / WS   |                                         |
        +---------------------+                    Nosana SDK           |
                                               (Job Submission) --------+
```

**Data Flow:**

1. **Users** interact through the Next.js dashboard, landing page, or OpenAI-compatible API
2. **Fastify API** handles authentication, business logic, and job orchestration
3. **PostgreSQL** stores all persistent state across 90+ Prisma models
4. **Redis** powers rate limiting, token-gate caching, and free-tier quotas
5. **Nosana SDK** submits GPU jobs to the decentralized compute network
6. **Solana** handles payments (SOL, USDC, NOS) and wallet-based authentication

### Monorepo Structure

```
wheelsai/
├── apps/
│   ├── api/                           # Fastify backend server (port 4000)
│   │   ├── src/
│   │   │   ├── index.ts               # Server entry point + plugin registration
│   │   │   ├── config/
│   │   │   │   ├── env.ts             # Environment configuration
│   │   │   │   └── free-models.ts     # Free model catalog (Groq, Gemini, Together)
│   │   │   ├── middleware/
│   │   │   │   ├── auth.ts            # JWT + cookie authentication
│   │   │   │   ├── free-tier-limit.ts # Redis rate limiter (RPM/RPD per org)
│   │   │   │   └── tokenGate.ts       # Token-gated agent access
│   │   │   ├── routes/                # 30 route modules
│   │   │   │   ├── agents.ts          # Agent CRUD + deployment
│   │   │   │   ├── auth.ts            # Register, login, wallet auth
│   │   │   │   ├── billing.ts         # Credits, transactions, usage
│   │   │   │   ├── deployments.ts     # Model deployment management
│   │   │   │   ├── domains.ts         # Custom domain provisioning
│   │   │   │   ├── inference.ts       # OpenAI-compatible /v1/* endpoints
│   │   │   │   ├── integrations.ts    # Third-party integrations
│   │   │   │   ├── knowledge.ts       # RAG / knowledge base
│   │   │   │   ├── marketplace.ts     # Listing, search, install
│   │   │   │   ├── memory.ts          # Conversation memory
│   │   │   │   ├── models.ts          # Model catalog
│   │   │   │   ├── monitoring.ts      # Alerts, uptime, health
│   │   │   │   ├── orchestrations.ts  # Multi-agent workflows
│   │   │   │   ├── reputation.ts      # Publisher reputation
│   │   │   │   ├── scheduler.ts       # Cron / interval tasks
│   │   │   │   ├── templates.ts       # Agent starter kits
│   │   │   │   ├── testing.ts         # Test suites + execution
│   │   │   │   ├── training.ts        # Fine-tuning jobs
│   │   │   │   ├── twoFactor.ts       # 2FA setup + verify
│   │   │   │   ├── webhooks.ts        # Webhook management
│   │   │   │   ├── x402.ts            # X-402 payment protocol
│   │   │   │   ├── openclaw.ts        # OpenClaw managed deployments
│   │   │   │   ├── tokens.ts          # Token marketplace (pump.fun)
│   │   │   │   ├── playground.ts      # Agent playground chat + models
│   │   │   │   └── ...
│   │   │   ├── services/              # 32 business logic modules
│   │   │   │   ├── auth.ts            # Argon2 hashing, JWT, wallet verify
│   │   │   │   ├── agent-runtime.ts   # Agent execution engine
│   │   │   │   ├── agentGraph.ts      # Visual builder graph ops
│   │   │   │   ├── analytics.ts       # Usage metrics
│   │   │   │   ├── domains.ts         # SSL provisioning, DNS verify
│   │   │   │   ├── enterprise.ts      # SSO, audit logs, teams
│   │   │   │   ├── knowledge.ts       # Chunking, embeddings, RAG
│   │   │   │   ├── marketplace.ts     # Search, install, revenue
│   │   │   │   ├── memory.ts          # Conversation context storage
│   │   │   │   ├── monitoring.ts      # Alert rules + channels
│   │   │   │   ├── nosana.ts          # GPU market + job submission
│   │   │   │   ├── orchestration.ts   # Multi-agent workflow execution
│   │   │   │   ├── reputation.ts      # Reputation scoring (0-100)
│   │   │   │   ├── scheduler.ts       # Task scheduling engine
│   │   │   │   ├── training.ts        # LoRA/QLoRA config
│   │   │   │   ├── twoFactor.ts       # TOTP + backup codes
│   │   │   │   ├── wallet.ts          # Solana wallet encryption
│   │   │   │   ├── webhooks.ts        # Delivery + retry logic
│   │   │   │   ├── x402.ts            # Per-request Solana payments
│   │   │   │   └── ...
│   │   │   └── tests/                 # API test suites
│   │   └── package.json
│   │
│   └── web/                           # Next.js 15 frontend (port 3000)
│       ├── src/
│       │   ├── app/                   # App Router pages
│       │   │   ├── page.tsx           # Landing page (12 component composition)
│       │   │   ├── layout.tsx         # Root layout (providers, fonts, toaster)
│       │   │   ├── globals.css        # Tailwind base + custom animations
│       │   │   ├── (auth)/            # Auth routes
│       │   │   │   ├── layout.tsx
│       │   │   │   ├── login/page.tsx
│       │   │   │   └── register/page.tsx
│       │   │   ├── (dashboard)/dashboard/  # Dashboard routes
│       │   │   │   ├── layout.tsx     # Dashboard shell (sidebar + header)
│       │   │   │   ├── page.tsx       # Dashboard home
│       │   │   │   ├── agents/        # Agent CRUD + visual builder + playground
│   │   │   │   └── [id]/playground/ # Chat interface for testing agents
│       │   │   │   ├── deployments/   # Deployment management
│       │   │   │   ├── training/      # Fine-tuning UI
│       │   │   │   ├── marketplace/   # Publish, revenue, installs
│       │   │   │   ├── billing/       # Credits + transactions
│       │   │   │   ├── knowledge/     # Knowledge base management
│       │   │   │   ├── memory/        # Conversation history
│       │   │   │   ├── scheduler/     # Scheduled tasks
│       │   │   │   ├── domains/       # Custom domains
│       │   │   │   ├── integrations/  # Third-party integrations
│       │   │   │   ├── templates/     # Agent templates
│       │   │   │   ├── analytics/     # Usage analytics
│       │   │   │   ├── playground/    # Live model testing
│       │   │   │   ├── testing/       # Test suites
│       │   │   │   ├── keys/          # API key management
│       │   │   │   └── settings/      # Org, security, team
│       │   │   └── marketplace/       # Public marketplace
│       │   │       ├── page.tsx       # Browse agents
│       │   │       ├── [slug]/page.tsx # Agent detail
│       │   │       └── leaderboard/   # Reputation board
│       │   ├── components/
│       │   │   ├── landing/           # 11 landing page components
│       │   │   ├── dashboard/         # Dashboard components
│       │   │   ├── marketplace/       # Marketplace UI
│       │   │   ├── reputation/        # Reputation display
│       │   │   ├── ui/               # Shared UI primitives
│       │   │   └── providers.tsx      # Auth, Query, Wallet providers
│       │   └── lib/
│       │       └── api.ts            # API client (REST + tRPC)
│       ├── tailwind.config.ts
│       ├── next.config.js
│       └── package.json
│
├── packages/
│   ├── db/                            # Prisma ORM + database
│   │   └── prisma/
│   │       ├── schema.prisma          # 90+ models (2100+ lines)
│   │       └── migrations/            # Database migrations
│   │
│   ├── shared/                        # Shared utilities
│   │   └── src/index.ts               # Formatting, validation, cost calc,
│   │                                  # slug gen, retry, ID generation
│   │
│   └── types/                         # TypeScript types + Zod schemas
│       └── src/index.ts               # Models, Deployments, Auth, Billing,
│                                      # Chat, GPU tiers, errors
│
├── docker-compose.yml                 # PostgreSQL 15 + Redis 7
├── turbo.json                         # Turborepo build pipeline
├── tsconfig.base.json                 # Base TS config (ES2022, strict)
├── .env.example                       # Environment variable template
└── package.json                       # Root workspace (npm workspaces)
```

### Package Dependencies

```
apps/api  ────> packages/db
              ├──> packages/shared
              └──> packages/types

apps/web  ────> packages/shared
              └──> packages/types

packages/shared ──> packages/types
```

- **`@wheelsai/db`** - Prisma client, migrations, and seeding
- **`@wheelsai/shared`** - Formatting (currency, tokens, bytes, duration), wallet utils (address truncation, validation), slug generation, cost calculation, retry logic, ID generation, API key helpers, health aggregation
- **`@wheelsai/types`** - Zod schemas for Models, GPU Tiers, Deployments, Auth, Billing, Chat (OpenAI format), Agent Wallets, and API errors

### Frontend Architecture

#### App Router Layout

```
src/app/
├── page.tsx                    # Landing page (navy dark theme)
├── layout.tsx                  # Root: Inter font, providers, toaster
├── globals.css                 # Tailwind + matrix/navy CSS utilities
│
├── (auth)/
│   ├── layout.tsx              # Centered card layout
│   ├── login/page.tsx          # Email + Solana wallet login
│   └── register/page.tsx       # Registration form
│
├── (dashboard)/dashboard/
│   ├── layout.tsx              # Sidebar + header shell
│   ├── page.tsx                # Dashboard home (stats overview)
│   ├── agents/                 # CRUD + visual graph builder
│   │   ├── page.tsx            # Agent list
│   │   ├── new/page.tsx        # Create agent
│   │   └── [id]/builder/       # Visual drag-and-drop builder
│   ├── deployments/            # Model deployment management
│   ├── training/               # Fine-tuning job submission
│   │   ├── page.tsx            # Training list
│   │   └── new/page.tsx        # New training job (LoRA/QLoRA)
│   ├── marketplace/            # Publisher tools
│   │   ├── page.tsx            # Marketplace browse
│   │   ├── publish/page.tsx    # List agent for sale
│   │   ├── revenue/page.tsx    # Revenue tracking + payouts
│   │   └── installs/page.tsx   # Installation metrics
│   ├── billing/page.tsx        # Credit balance + transactions
│   ├── knowledge/page.tsx      # Knowledge base + document upload
│   ├── memory/page.tsx         # Conversation history
│   ├── scheduler/page.tsx      # Cron/interval/one-shot tasks
│   ├── domains/page.tsx        # Custom domain management
│   ├── integrations/page.tsx   # Slack, Discord, GitHub, etc.
│   ├── templates/page.tsx      # Agent starter kits
│   ├── analytics/page.tsx      # Requests, tokens, latency, cost
│   ├── playground/page.tsx     # Live model testing
│   ├── testing/page.tsx        # Test suites + execution
│   ├── keys/page.tsx           # API key management
│   └── settings/
│       ├── page.tsx            # Organization settings
│       ├── security/page.tsx   # 2FA, API keys
│       └── team/page.tsx       # Team members + invites
│
└── marketplace/                # Public marketplace (no auth)
    ├── page.tsx                # Browse + search agents
    ├── [slug]/page.tsx         # Agent detail + reviews
    └── leaderboard/page.tsx    # Publisher reputation board
```

#### Component Architecture

```
src/components/
├── landing/              # 12 components (dark navy theme)
│   ├── navbar.tsx        # [client] Sticky, transparent -> solid on scroll
│   ├── hero.tsx          # [client] Matrix rain, animated counters, CTAs
│   ├── social-proof.tsx  # [server] SOC 2, latency, SOL-native, pay-per-token
│   ├── features-grid.tsx # [client] 8 glow cards, scroll-triggered fade-in
│   ├── how-it-works.tsx  # [client] 3-step: Connect -> Configure -> Deploy
│   ├── code-preview.tsx  # [server] Terminal mockup + feature bullets
│   ├── frameworks.tsx    # [server] 6 supported AI frameworks
│   ├── pricing.tsx       # [server] 3-tier: Starter / Pro / Enterprise
│   ├── stats-section.tsx # [client] 4 animated counters
│   ├── final-cta.tsx     # [server] Gradient CTA with blur orbs
│   └── footer.tsx        # [server] 4-column links + branding
│
├── dashboard/            # Dashboard components (model-selector, header, etc.)
├── marketplace/          # Marketplace UI (review forms, cards)
├── reputation/           # Reputation score display (0-100)
├── ui/                   # Reusable primitives (button, input, select, etc.)
└── providers.tsx         # React Query, NextAuth, Solana Wallet providers
```

#### State Management

- **tRPC + React Query** - Type-safe API calls with caching, refetching, and optimistic updates
- **React Hook Form + Zod** - Form state management with runtime validation
- **Solana Wallet Adapter** - Wallet connection state (Phantom, Solflare, Ledger)
- **NextAuth.js** - Session management (JWT + HTTP-only cookies)

### Backend Architecture

#### Middleware Stack

```
Request
  |
  v
CORS (configurable origins)
  |
  v
Helmet (security headers, CSP disabled for API)
  |
  v
Rate Limiting (100 req/min default)
  |
  v
Auth Middleware (JWT from cookie or Authorization header)
  |
  v
Route Handler --> Service Layer --> Prisma/Redis/Nosana
  |
  v
Error Handler (standardized JSON errors)
  |
  v
Response
```

#### Service Layer (32 modules)

| Service | Responsibility |
|---------|---------------|
| `auth` | Argon2 password hashing, JWT signing, wallet nonce/verify, API key generation |
| `agent-runtime` | Agent execution engine |
| `agentGraph` | Visual builder graph operations (nodes, edges, validation) |
| `analytics` | Usage metrics aggregation and snapshots |
| `dataset` | Training dataset management (S3/IPFS/HuggingFace) |
| `domains` | Custom domain provisioning, DNS verification, SSL certs |
| `enterprise` | SSO (SAML/OIDC), audit logging, team management |
| `integrations` | Slack, Discord, GitHub, Zapier, Make, n8n |
| `knowledge` | Document chunking, embedding generation, RAG retrieval |
| `marketplace` | Listing search, install tracking, revenue calculation |
| `memory` | Conversation storage, fact extraction, context retrieval |
| `monitoring` | Alert rules, channels, uptime checks |
| `nosana` | Nosana GPU market interface, YAML job submission |
| `orchestration` | Multi-agent workflow execution (sequential/parallel/conditional) |
| `reputation` | Multi-factor reputation scoring (ratings, installs, response time, disputes) |
| `scheduler` | Cron/interval/one-shot task execution |
| `templates` | Agent template management (20+ starter kits) |
| `testing` | Test execution with 6 assertion types |
| `training` | LoRA/QLoRA fine-tuning configuration and job management |
| `twoFactor` | TOTP generation, verification, backup codes |
| `versioning` | Semantic agent versioning with diffs |
| `wallet` | Solana keypair encryption/decryption (AES-256-GCM) |
| `webhooks` | Event delivery with exponential backoff retry |
| `x402` | X-402 per-request Solana payment verification and settlement |
| `openclaw` | OpenClaw managed deployments (Docker containers on Nosana GPUs) |
| `agentToken` | Token creation, eligibility checks, indexer worker |
| `pumpfun` | Pump.fun bonding curve API client |
| `mastra-runtime` | Ephemeral agent chat execution (OpenAI-compatible API) |
| `tokenIndexer` | Background worker polling pump.fun for trades/graduation |

### Database Schema

**90+ Prisma models** organized across 22 entity groups:

```
Users & Auth (5)              Agents & Builder (7)          Marketplace (7)
├── User                      ├── Agent                     ├── AgentListing
├── Organization              ├── AgentDeployment           ├── AgentReview
├── OrgMember                 ├── AgentWallet               ├── AgentInstall
├── TwoFactorAuth             ├── AgentTransaction          ├── AgentSubscription
└── TwoFactorChallenge        ├── AgentGraph                ├── PublisherProfile
                              ├── AgentVersion              ├── CreatorPayout
API Keys (1)                  └── AgentVersionDiff          └── MarketplaceRevenue
└── ApiKey
                              Training & Knowledge (5)      Monitoring & Alerts (5)
Models & Deploy (3)           ├── Dataset                   ├── AlertChannel
├── Model                     ├── TrainingJob               ├── AlertRule
├── Deployment                ├── KnowledgeBase             ├── AlertRuleChannel
└── DeploymentNode            ├── KnowledgeDocument         ├── Alert
                              └── DocumentChunk             └── UptimeMonitor
Billing & Payments (4)                                         + UptimeEvent
├── CreditBalance             Orchestration (3+)
├── CreditTransaction         ├── Orchestration             Enterprise (3)
├── UsageRecord               ├── OrchestrationStep         ├── AuditLog
└── X402Payment               ├── OrchestrationExecution    ├── SsoConfig
                              └── OrchestrationStepResult   └── TeamInvite
Conversation Memory (3)
├── Conversation              Scheduling (2)                Webhooks (4)
├── Message                   ├── ScheduledTask             ├── Webhook
└── MemoryContext              └── TaskExecution             ├── WebhookDelivery
                                                            ├── Integration
Custom Domains (2)            Testing (4)                   └── IntegrationEvent
├── CustomDomain              ├── TestSuite
└── DomainEvent               ├── TestCase                  Templates (1)
                              ├── TestRun                   └── AgentTemplate
Analytics (1)                 └── TestResult
└── AnalyticsSnapshot
                                                            OpenClaw (2)
Token Marketplace (4)         Free Tier (1)                 ├── OpenClawDeployment
├── AgentToken                └── FreeTierUsage             └── OpenClawChannel
├── AgentTokenTrade
├── AgentTokenHolder
└── AgentTokenSnapshot
```

### Blockchain Integration

#### Solana

| Feature | Detail |
|---------|--------|
| Network | Devnet (development) / Mainnet-beta (production) |
| Wallet Auth | Sign nonce with Phantom, Solflare, or Ledger (TweetNaCl ED25519) |
| Payments | SOL, USDC (SPL), and NOS token support |
| X-402 Protocol | Per-request micropayments via Solana transactions |
| Agent Wallets | Encrypted keypairs (AES-256-GCM) with budget controls |

#### Nosana Network

| Feature | Detail |
|---------|--------|
| GPU Tiers | RTX 3060, RTX 4070, RTX 4090, A100, H100 |
| Job Format | YAML-based definitions via `@nosana/sdk` |
| Node Health | Real-time latency + health monitoring |
| Billing | Per-second GPU billing settled on Solana |
| Market | Separate Solana address per GPU tier |

#### Agent Wallet Security

```
Create Agent Wallet
  -> Generate Ed25519 keypair
  -> Encrypt private key (AES-256-GCM, org-derived key via MASTER_ENCRYPTION_KEY)
  -> Store ciphertext in PostgreSQL
  -> Configure budget: daily limit, per-tx limit, domain allowlist
  -> Agent can autonomously transact within constraints
```

---

## Tech Stack

### Frontend

| Layer | Technology | Version |
|-------|-----------|---------|
| Framework | Next.js (App Router) | 15.5.9 |
| Language | TypeScript (strict) | 5.3.3 |
| UI | React | 18.2.0 |
| Styling | Tailwind CSS + custom design system | 3.4.1 |
| API Client | tRPC + React Query | 11.0.0-rc + 5.17.0 |
| Forms | React Hook Form + Zod | 7.49.3 + 3.22.4 |
| Icons | Lucide React | 0.303.0 |
| Auth | NextAuth.js | 4.24.5 |
| Wallet | Solana Wallet Adapter (Phantom, Solflare) | 0.15.35 |
| Notifications | Sonner | 1.3.1 |
| Class Utils | CVA + clsx + tailwind-merge | 0.7.0 + 2.1.0 + 2.2.0 |

### Backend

| Layer | Technology | Version |
|-------|-----------|---------|
| Framework | Fastify | 4.25.2 |
| Language | TypeScript (strict) | 5.3.3 |
| Runtime | Node.js | 22+ |
| ORM | Prisma | 5.8.0 |
| Database | PostgreSQL | 15 |
| Cache / Queue | Redis 7 + BullMQ | 5.1.0 |
| Auth | Argon2 (hashing) + Fastify JWT | 0.31.2 |
| Payments | Stripe | 14.12.0 |
| Blockchain | @solana/web3.js + TweetNaCl | 1.87.6 |
| GPU Network | @nosana/sdk | 0.4.74 |
| Agent Runtime | @mastra/core | 1.10.0+ |
| Logging | Pino (+ pino-pretty for dev) | 8.17.2 |
| Validation | Zod | 3.22.4 |
| IDs | nanoid | 5.0.4 |

### Infrastructure

| Layer | Technology | Version |
|-------|-----------|---------|
| Build | Turborepo | 2.0.0 |
| Containers | Docker Compose | PostgreSQL 15 + Redis 7 |
| Dev Runner | tsx | latest |
| Linting | ESLint | 9.x |
| TypeScript Base | ES2022, strict, noUncheckedIndexedAccess | -- |

---

## Features

### Core Platform

- **One-Click Deploy** - Deploy AI agents to 2,000+ GPUs in seconds
- **OpenAI-Compatible API** - Drop-in replacement at `/v1/chat/completions`
- **Multi-Framework Support** - Mastra, LangChain, AutoGen, ElizaOS, CrewAI, or custom
- **Visual Agent Builder** - Drag-and-drop node graph editor with validation
- **Agent Templates** - 20+ starter kits for common use cases
- **Unified Dashboard** - Single interface for the entire lifecycle

### AI & Models

- **Free Model Catalog** - Start building with zero cost: Groq (Llama 3.3 70B, Llama 3.1 8B, Qwen3 32B), Google (Gemini 2.5 Flash), Together.xyz (Llama 3.1 8B Turbo)
- **Agent Playground** - Chat interface to test agents instantly with free models, no GPU deployment needed. Supports SSE streaming.
- **Model Catalog** - 100+ models: Llama, Mistral, Qwen, GPT-J, and more
- **Fine-Tuning** - LoRA/QLoRA training on custom datasets (S3/IPFS/HuggingFace)
- **Multi-Engine** - vLLM and Ollama backend support
- **Custom Models** - Host your own fine-tuned models on dedicated GPUs
- **GPU Tiers** - RTX 3060, RTX 4070, RTX 4090, A100, H100
- **Mastra Runtime** - Ephemeral agent execution with built-in tool support (calculator, HTTP requests with SSRF protection)

### Agent Ecosystem

- **Agent Marketplace** - Discover, install, and monetize community agents
- **Pricing Models** - Free, per-request, or monthly subscription
- **Revenue Sharing** - 90% creator / 10% platform
- **Publisher Reputation** - Multi-factor scoring (ratings, installs, response time, disputes, age)
- **Agent Versioning** - Semantic versioning with snapshot diffs
- **Agent Wallets** - Autonomous Solana wallets with daily/per-tx budget controls
- **Creator Payouts** - Credits, crypto, or SOL disbursements

### Knowledge & Memory

- **Knowledge Base (RAG)** - Upload documents (PDF, text, JSONL), auto-chunk, generate embeddings
- **Semantic Search** - Vector-based retrieval across document collections
- **Conversation Memory** - Persistent session context with automatic fact extraction
- **Memory Context** - Embeddings for preferences, facts, and conversation summaries

### Orchestration & Scheduling

- **Multi-Agent Orchestration** - Sequential, parallel, and conditional agent pipelines
- **Step Dependencies** - Control execution order with error handling and fallback agents
- **Scheduled Tasks** - Cron expressions, fixed intervals, or one-shot execution
- **Timezone Support** - Schedule in any timezone
- **Execution History** - Full logs, duration, status, and error tracking

### Testing & Monitoring

- **Test Suites** - Organize and batch-run tests against agents
- **6 Assertion Types** - Exact match, contains, regex, semantic similarity, JSON schema, custom function
- **Alert Rules** - Threshold, anomaly detection, uptime, and budget alerts
- **5 Alert Channels** - Slack, Discord, Email, Webhook, PagerDuty
- **Uptime Monitoring** - Custom HTTP endpoint health checks with event logging
- **Analytics** - Requests, tokens, latency (p50/p95/p99), errors, and cost dashboards

### Security & Auth

- **Email/Password** - Argon2id password hashing
- **Solana Wallet Auth** - Sign-in by signing a nonce (TweetNaCl ED25519)
- **Two-Factor Authentication** - TOTP with 10 backup codes
- **Scoped API Keys** - Named keys with fine-grained permission scopes
- **SSO** - SAML and OIDC for enterprise
- **RBAC** - Organization roles: owner, admin, member
- **Audit Logging** - Every action tracked with actor, resource, IP, and timestamp
- **Team Invites** - Email-based onboarding with expiring tokens

### Billing & Payments

- **Credit System** - Prepaid credits (stored in cents) with usage deduction
- **Token-Based Pricing** - Per-input/output token billing with tier-based rates
- **Stripe Integration** - Credit card purchases for credit top-ups
- **X-402 Protocol** - Per-request Solana micropayments (SOL/USDC/NOS)
- **Usage Records** - Per-deployment metrics: tokens, requests, compute time, cost
- **Custom Domains** - BYOD with DNS verification and auto-provisioned SSL

### OpenClaw Integration

- **Managed Deployments** - Deploy OpenClaw agents on Nosana GPUs in hardened Docker containers
- **Multi-Channel** - Discord, Telegram, Slack, Twitter, WhatsApp, Line, Messenger, Web, API, Email
- **Encrypted Config** - Channel credentials stored with AES-256-GCM encryption
- **GPU Tiers** - Basic (RTX 3060), Standard (RTX 4070), Premium (RTX 4090)
- **Lifecycle Management** - Start, stop, restart, health checks, log streaming

### Token Marketplace

- **Pump.fun-Style Tokens** - Create bonding curve tokens for agents via pump.fun SDK
- **Anti-Scam Protections** - Publisher reputation >= 50, agent deployed >= 7 days, creator lockup 30 days
- **Token Gating** - Gate agent access to token holders (Redis-cached balance checks)
- **Live Indexer** - Background worker polls pump.fun for trades, graduation events, and holder changes
- **Eligibility Checks** - Automated pre-launch validation before token creation
- **Token Lifecycle** - BONDING -> GRADUATED -> FAILED status tracking

### Free Tier & Rate Limiting

- **Free Models** - 5 models across Groq, Google Gemini, and Together.xyz (no user API key needed)
- **Platform-Level Keys** - Free models use platform API keys, not user keys
- **Redis Rate Limiting** - 20 requests/minute and 200 requests/day per organization (configurable)
- **Usage Tracking** - Daily token consumption tracked per org per model in `FreeTierUsage`
- **Graceful Degradation** - Rate limiter fails open when Redis is unavailable

### Integrations

- **Webhooks** - Subscribe to events (agent.created, deployment.started, etc.) with retry logic
- **Slack** - Notifications and agent interaction
- **Discord** - Bot integration and alerts
- **GitHub** - Repository-linked agent source code
- **Zapier / Make / n8n** - Workflow automation connectors

---

## Getting Started

### Prerequisites

- **Node.js** 22+ and **npm** 10+
- **Docker** and **Docker Compose** (for PostgreSQL + Redis)

### Installation

```bash
# Clone the repository
git clone https://github.com/wheelsai/wheelsai.git
cd wheelsai

# Install all dependencies
npm install

# Copy and configure environment
cp .env.example .env
# Edit .env with your secrets (see Environment Variables section)

# Start PostgreSQL 15 and Redis 7
docker compose up -d

# Generate Prisma client
npm run db:generate

# Run database migrations
npm run db:migrate

# (Optional) Seed with sample data
npm run db:seed

# Start all services in development
npm run dev
```

### Access

| Service | URL |
|---------|-----|
| Web App | http://localhost:3000 |
| API Server | http://localhost:4000 |
| Health Check | http://localhost:4000/health |
| Prisma Studio | `npm run db:studio` |
| API Docs (Swagger) | http://localhost:4000/docs |
| Explore Agents | http://localhost:3000/explore |
| Beta Waitlist | http://localhost:3000/waitlist |

> **Note:** Stripe billing is simulated in development. Credits are added directly without real payment processing. Configure `STRIPE_SECRET_KEY` for production.

---

## Environment Variables

Create a `.env` file in the project root. See `.env.example` for the full template.

### Required

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `JWT_SECRET` | Secret for signing JWT tokens (use a secure random value) |
| `SESSION_SECRET` | Session encryption key |
| `NEXT_PUBLIC_APP_URL` | Frontend URL (e.g., `http://localhost:3000`) |
| `NEXT_PUBLIC_API_URL` | API URL for frontend (e.g., `http://localhost:4000`) |
| `SOLANA_RPC_URL` | Solana RPC endpoint |
| `SOLANA_NETWORK` | `devnet` or `mainnet-beta` |
| `NOSANA_MARKET_ADDRESS` | Nosana GPU market public key |
| `NOSANA_WALLET_PRIVATE_KEY` | Platform wallet private key (base58) |
| `MASTER_ENCRYPTION_KEY` | AES-256 key for agent wallet encryption |

### Optional

| Variable | Description |
|----------|-------------|
| `API_PORT` | API server port (default: `4000`) |
| `API_HOST` | API server host (default: `0.0.0.0`) |
| `JWT_EXPIRES_IN` | Token expiry (default: `24h`) |
| `STRIPE_SECRET_KEY` | Stripe secret key for credit purchases |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook verification |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Stripe publishable key (frontend) |
| `PINATA_API_KEY` | IPFS pinning via Pinata |
| `PINATA_SECRET_KEY` | Pinata secret |
| `IPFS_GATEWAY_URL` | IPFS gateway (default: Pinata) |
| `INFERENCE_PROXY_PORT` | Inference proxy port (default: `4001`) |
| `INFERENCE_TIMEOUT_MS` | Request timeout (default: `30000`) |
| `SMTP_HOST` | Email server for notifications |
| `SMTP_PORT` | SMTP port (default: `587`) |
| `SMTP_USER` | SMTP username |
| `SMTP_PASS` | SMTP password |
| `EMAIL_FROM` | Sender address |
| `SENTRY_DSN` | Sentry error tracking URL |
| `LOG_LEVEL` | Pino log level (default: `debug`) |
| `GROQ_API_KEY` | Groq API key (enables free Llama 3.3 70B, Llama 3.1 8B, Qwen3 32B) |
| `GOOGLE_GEMINI_API_KEY` | Google Gemini API key (enables free Gemini 2.5 Flash) |
| `TOGETHER_API_KEY` | Together.xyz API key (enables free Llama 3.1 8B Turbo) |
| `FREE_TIER_RPM` | Free model rate limit per minute per org (default: `20`) |
| `FREE_TIER_RPD` | Free model rate limit per day per org (default: `200`) |
| `PUMPFUN_API_KEY` | Pump.fun API key for token marketplace |
| `TOKEN_INDEXER_INTERVAL_MS` | Token indexer polling interval (default: `30000`) |
| `OPENCLAW_DEFAULT_IMAGE` | OpenClaw Docker image (default: `wheelsai/openclaw-hardened:latest`) |
| `OPENCLAW_SUBDOMAIN_BASE` | OpenClaw subdomain base (default: `openclaw.wheelsai.com`) |
| `ENCRYPTION_KEY` | AES-256-GCM key for sensitive config (required in production) |

---

## Scripts

### Development

```bash
npm run dev              # Start all services (Turborepo)
npm run dev:api          # Start API server only
npm run dev:web          # Start frontend only
```

### Database

```bash
npm run db:generate      # Generate Prisma client from schema
npm run db:migrate       # Create and apply migrations
npm run db:migrate:deploy # Apply migrations (production, no prompts)
npm run db:studio        # Open Prisma Studio GUI
npm run db:seed          # Seed database with sample data
```

### Build

```bash
npm run build            # Build all packages and apps
npm run build:api        # Build API only
npm run build:web        # Build frontend only (standalone output)
```

### Quality

```bash
npm run lint             # ESLint across all packages
npm run typecheck        # TypeScript strict check
npm run test             # Run test suites
npm run format           # Prettier formatting
```

### Turborepo

```bash
npx turbo dev            # Run dev in all packages (with caching)
npx turbo build          # Build all with dependency graph
npx turbo lint           # Lint all packages
```

---

## API Reference

All endpoints (except `/health` and `/api/auth/*`) require authentication via JWT token in the `Authorization` header or HTTP-only cookie.

### Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/auth/register` | Register with email/password |
| `POST` | `/api/auth/login` | Login, receive JWT |
| `POST` | `/api/auth/wallet/nonce` | Generate wallet sign-in nonce (5-min expiry) |
| `POST` | `/api/auth/wallet/verify` | Verify Solana wallet signature |
| `POST` | `/api/auth/2fa/setup` | Enable TOTP two-factor authentication |
| `POST` | `/api/auth/2fa/verify` | Verify TOTP code or backup code |

### Agents & Deployments

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/agents` | List agents |
| `POST` | `/api/agents` | Create agent |
| `GET` | `/api/agents/:id` | Get agent details |
| `POST` | `/api/agents/:id/deploy` | Deploy agent to GPUs |
| `POST` | `/api/agents/:id/graph` | Save visual builder graph |
| `GET` | `/api/deployments` | List deployments |
| `POST` | `/api/deployments` | Create deployment |
| `GET` | `/api/models` | List available models |
| `POST` | `/api/models/deploy` | Deploy model to Nosana |

### Marketplace

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/marketplace` | Search agent listings |
| `POST` | `/api/marketplace` | Publish agent to marketplace |
| `POST` | `/api/marketplace/:id/install` | Install an agent |
| `POST` | `/api/marketplace/:id/review` | Submit a review |
| `GET` | `/api/reputation/:id` | Get publisher reputation score |

### AI Features

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/training` | Submit LoRA/QLoRA fine-tuning job |
| `POST` | `/api/knowledge` | Create knowledge base |
| `POST` | `/api/knowledge/:id/documents` | Upload document for RAG |
| `POST` | `/api/orchestrations` | Create multi-agent workflow |
| `POST` | `/api/orchestrations/:id/execute` | Execute workflow |
| `POST` | `/api/scheduler` | Create scheduled task |
| `POST` | `/api/testing` | Run test suite |
| `POST` | `/api/memory` | Store conversation context |
| `POST` | `/api/templates` | Create agent template |

### Infrastructure

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/domains` | Add custom domain |
| `POST` | `/api/webhooks` | Register webhook |
| `GET` | `/api/monitoring` | Get alert rules |
| `POST` | `/api/monitoring/alerts` | Create alert rule |
| `GET` | `/api/billing` | Get credit balance |
| `GET` | `/api/billing/usage` | Get usage records |
| `GET` | `/api/health` | Health check |

### Agent Playground

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/agents/:id/playground/chat` | Chat with agent using free or paid models (supports SSE streaming) |
| `GET` | `/api/agents/:id/playground/models` | List available models grouped by tier (free / external) |

### OpenClaw

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/openclaw` | Create OpenClaw deployment |
| `GET` | `/api/openclaw` | List OpenClaw deployments |
| `POST` | `/api/openclaw/:id/start` | Start deployment |
| `POST` | `/api/openclaw/:id/stop` | Stop deployment |
| `POST` | `/api/openclaw/channels` | Add channel (Discord, Telegram, etc.) |

### Token Marketplace

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/tokens/create` | Create bonding curve token for agent (rate limited: 3/min) |
| `GET` | `/api/tokens` | List tokens (sortable, filterable) |
| `GET` | `/api/tokens/trending` | Trending tokens |
| `GET` | `/api/tokens/:id` | Get token details |
| `GET` | `/api/tokens/:id/trades` | Get trade history |
| `GET` | `/api/tokens/:id/holders` | Get holder distribution |
| `GET` | `/api/tokens/:id/chart` | Get price chart snapshots |
| `GET` | `/api/tokens/eligibility/:listingId` | Check token creation eligibility |

### GitHub Import

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/agents/import-github` | Auto-detect framework from GitHub repo URL |

### Collaboration

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/agents/:id/contributors` | List agent contributors |
| `POST` | `/api/agents/:id/contributors` | Invite a contributor with revenue share |
| `PATCH` | `/api/agents/:id/contributors/:cid` | Update role or revenue share |
| `DELETE` | `/api/agents/:id/contributors/:cid` | Remove a contributor |

### API Documentation

Interactive Swagger UI is available at `/docs` when the API server is running. Raw OpenAPI JSON at `/docs/json`.

### OpenAI-Compatible Inference

```bash
curl http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer <api_key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama-3.1-70b",
    "messages": [{"role": "user", "content": "Hello"}],
    "temperature": 0.7,
    "max_tokens": 2048,
    "stream": true
  }'
```

Supports streaming (`stream: true`), function calling, and all standard OpenAI chat completion parameters.

---

## Design System

WheelsAI uses a custom dark theme with two distinct palettes:

### Matrix Theme (Dashboard)

| Token | Value | Usage |
|-------|-------|-------|
| `matrix-green` | `#00ff00` | Primary accent, buttons, highlights |
| `matrix-cyan` | `#00d4ff` | Secondary accent, gradients |
| `matrix-purple` | `#a855f7` | Tertiary accent, gradient endpoints |
| `matrix-dark` | `#0a0a0f` | Page background |
| `matrix-surface` | `#12121a` | Card backgrounds |
| `matrix-border` | `#1e1e2e` | Borders and dividers |

### Navy Theme (Landing Page)

| Token | Value | Usage |
|-------|-------|-------|
| `navy-950` | `#040a18` | Page background |
| `navy-900` | `#0a1628` | Footer, solid navbar |
| `navy-800` | `#0f1d35` | Card surfaces |
| `navy-700` | `#1a2744` | Elevated surfaces |
| `navy-600` | `#243352` | Borders, muted elements |
| `navy-500` | `#2e4068` | Dividers |
| `navy-400` | `#3b82f6` | Primary accent blue |
| `navy-300` | `#60a5fa` | Lighter accent |
| `navy-200` | `#93c5fd` | Highlights, body text |

### CSS Utilities

| Class | Description |
|-------|-------------|
| `.gradient-text` | Green -> cyan -> purple gradient text |
| `.gradient-text-navy` | Blue -> cyan -> purple gradient text |
| `.glow-card` | Dark card with green glow on hover |
| `.glow-card-navy` | Navy card with blue glow on hover |
| `.grid-bg` | Subtle green grid pattern overlay |
| `.grid-bg-navy` | Subtle blue grid pattern overlay |
| `.btn-glow` | Green glowing CTA button |
| `.btn-glow-navy` | Blue glowing CTA button |
| `.text-glow` | Green text shadow |
| `.text-glow-blue` | Blue text shadow |
| `.pricing-popular` | Enhanced glow for featured pricing tier |

### Animations

| Animation | Duration | Usage |
|-----------|----------|-------|
| `matrix-fall` | 10s | Matrix digital rain columns |
| `glow-pulse` | 2s | Pulsing glow on buttons |
| `float` | 3s | Floating hover effect |
| `glitch` | 5s | Cyberpunk glitch effect |
| `fade-in-up` | 0.6s | Scroll-triggered entrance |
| `typewriter` | 2s | Terminal typing effect |
| `blink` | 1s | Cursor blink |
| `wheel-spin` | 20s | Rotating elements |
| `orbit` | variable | Orbital motion paths |

---

## Deployment

### Docker (Local Development)

```bash
# Start infrastructure
docker compose up -d

# Services started:
#   PostgreSQL 15 on port 5434
#   Redis 7 on port 6380
```

### Production Build

**Next.js** (configured with `output: 'standalone'`):

```bash
npm run build:web
# Output: apps/web/.next/standalone/
# Run: node apps/web/.next/standalone/server.js
```

**Fastify API**:

```bash
npm run build:api
# Run: node apps/api/dist/index.js
```

### Platform Options

| Platform | Best For |
|----------|----------|
| **Vercel** | Frontend (zero-config Next.js deployment) |
| **Railway / Render** | Full-stack with Docker |
| **AWS ECS / GCP Cloud Run** | Containerized production |
| **Kubernetes** | Enterprise scale (manifests planned) |

### Security Headers (Next.js)

The Next.js config includes security headers:
- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- Standalone output for containerization
- Transpiles `@wheelsai/*` workspace packages

---

## Roadmap

### Completed

- [x] **Phase 1** - Core platform: auth, deployments, models, billing, inference API
- [x] **Phase 2** - Agent ecosystem: visual builder, marketplace, reputation, agent wallets
- [x] **Phase 3** - Custom domains, conversation memory, testing framework
- [x] **Phase 4** - Analytics, monitoring & alerting, webhooks, third-party integrations
- [x] **Phase 5** - Scheduler, knowledge base (RAG), multi-agent orchestration, templates, 2FA
- [x] **Phase 6** - OpenClaw integration, pump.fun-style token marketplace, free model catalog, agent playground, Mastra runtime, free-tier rate limiting

### Upcoming

- [ ] Multi-tenancy with workspace isolation
- [ ] SDK generator (Python, JavaScript, Go)
- [ ] CLI tool (`wheelsai deploy`, `wheelsai logs`, `wheelsai test`)
- [ ] IP allowlisting and advanced network security
- [ ] Data retention policies and GDPR compliance
- [ ] Kubernetes deployment manifests and Helm charts
- [ ] White-labeling support

---

## Contributing

We welcome contributions! Please follow these steps:

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Make your changes
4. Run quality checks: `npm run lint && npm run typecheck`
5. Commit with conventional commits: `git commit -m 'feat: add your feature'`
6. Push and open a Pull Request

### Code Style

- TypeScript strict mode for all code
- ESLint + Prettier for formatting
- Conventional commit messages (`feat:`, `fix:`, `chore:`, etc.)

---

## Support

- **Documentation**: [docs.wheelsai.io](https://docs.wheelsai.io)
- **Discord**: [discord.gg/wheelsai](https://discord.gg/wheelsai)
- **Twitter**: [@wheelsai](https://twitter.com/wheelsai)
- **Email**: support@wheelsai.io

---

## License

Proprietary. All rights reserved.

---

## Acknowledgments

- [Nosana](https://nosana.io) - Decentralized GPU infrastructure
- [Solana](https://solana.com) - Blockchain payments and authentication
- [ElizaOS](https://elizaos.ai) - AI agent framework
- [Mastra](https://mastra.ai) - Agent development framework

---

<p align="center">
  <strong>Built with wheels within wheels</strong><br/>
  <sub>Powered by Nosana Decentralized GPU Network &bull; Settled on Solana</sub>
</p>
