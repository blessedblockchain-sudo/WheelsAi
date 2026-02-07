<p align="center">
  <img src="https://via.placeholder.com/120x120/0a0a0f/00ff00?text=W" alt="WheelsAI Logo" width="120" height="120" />
</p>

<h1 align="center">WheelsAI</h1>

<p align="center">
  <strong>Build, Deploy, and Monetize AI Agents</strong><br/>
  One unified platform. Any framework. No scattered tools.
</p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#documentation">Documentation</a> •
  <a href="#contributing">Contributing</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/ElizaOS-supported-00ff00?style=flat-square" alt="ElizaOS" />
  <img src="https://img.shields.io/badge/Mastra-supported-00ff00?style=flat-square" alt="Mastra" />
  <img src="https://img.shields.io/badge/JuliaOS-supported-00ff00?style=flat-square" alt="JuliaOS" />
  <img src="https://img.shields.io/badge/LangChain-supported-00ff00?style=flat-square" alt="LangChain" />
  <img src="https://img.shields.io/badge/AutoGen-supported-00ff00?style=flat-square" alt="AutoGen" />
</p>

---

## Overview

**WheelsAI** is an all-in-one platform for building, deploying, testing, and monetizing AI agents. Unlike scattered tools and fragmented workflows, WheelsAI brings everything together in a unified experience.

Whether you're a seasoned developer or just getting started with AI, WheelsAI provides the tools you need to create powerful AI agents and share them with the world.

### Why WheelsAI?

| Problem | Solution |
|---------|----------|
| Building AI agents is fragmented | Unified platform for the entire lifecycle |
| Deploy here, test there, monetize somewhere else | Everything in one place |
| Framework lock-in | Support for ElizaOS, Mastra, JuliaOS, LangChain, AutoGen, and more |
| Technical barriers | Templates and no-code options for everyone |
| No monetization path | Built-in marketplace to sell your agents |

---

## Features

### Core Platform

- **Multi-Framework Support** - Build with ElizaOS, Mastra Framework, JuliaOS, LangChain, AutoGen, or your custom framework
- **One-Click Deploy** - Deploy agents to production in seconds
- **Agent Marketplace** - Publish, discover, and monetize AI agents
- **Model Catalog** - Access Llama, Mistral, Qwen, and more with fine-tuning support

### Developer Experience

- **OpenAI-Compatible API** - Works with your existing code
- **SDKs** - Python, JavaScript, and Go libraries
- **Webhooks & Integrations** - Connect to Slack, Discord, GitHub, and more
- **Testing Framework** - Test agents before deployment

### Enterprise Features

- **Custom Domains** - Bring your own domain with automatic SSL
- **SSO Integration** - SAML/OIDC authentication
- **Audit Logging** - Complete activity tracking
- **Team Management** - Role-based access control
- **Conversation Memory** - Persistent context across sessions

### Infrastructure

- **Powered by Nosana** - Decentralized GPU network with 2,000+ nodes
- **Cost Effective** - Up to 85% cheaper than traditional cloud
- **Pay Per Use** - No minimums, no commitments
- **SOL/USDC Payments** - Web3-native billing

---

## Quick Start

### Prerequisites

- Node.js 20+
- Docker & Docker Compose
- PostgreSQL 15+ (or use Docker)
- Redis 7+ (or use Docker)

### Installation

```bash
# Clone the repository
git clone https://github.com/wheelsai/wheelsai.git
cd wheelsai

# Install dependencies
npm install

# Set up environment variables
cp .env.example .env

# Start infrastructure (PostgreSQL + Redis)
docker-compose up -d

# Run database migrations
npm run db:migrate

# Seed the database (optional)
npm run db:seed

# Start development servers
npm run dev
```

### Access the Application

- **Web App**: http://localhost:3000
- **API Server**: http://localhost:4000
- **API Health**: http://localhost:4000/health

---

## Architecture

WheelsAI is built as a monorepo using Turborepo with the following structure:

```
wheelsai/
├── apps/
│   ├── api/                 # Fastify API server
│   │   ├── src/
│   │   │   ├── middleware/  # Auth, logging, error handling
│   │   │   ├── routes/      # API endpoints
│   │   │   ├── services/    # Business logic
│   │   │   └── utils/       # Helpers and utilities
│   │   └── package.json
│   │
│   └── web/                 # Next.js 15 frontend
│       ├── src/
│       │   ├── app/         # App Router pages
│       │   ├── components/  # React components
│       │   └── lib/         # Utilities and API client
│       └── package.json
│
├── packages/
│   ├── db/                  # Prisma schema and client
│   ├── shared/              # Shared utilities
│   └── types/               # TypeScript types
│
├── docker-compose.yml       # Local infrastructure
├── turbo.json              # Turborepo config
└── package.json            # Root package
```

### Tech Stack

| Layer | Technology |
|-------|------------|
| **Frontend** | Next.js 15, React 18, Tailwind CSS, TypeScript |
| **Backend** | Fastify, Node.js 22, TypeScript |
| **Database** | PostgreSQL 15, Prisma ORM |
| **Cache** | Redis 7 |
| **Infrastructure** | Nosana GPU Network |
| **Auth** | JWT, NextAuth.js |
| **Payments** | Solana (SOL/USDC) |

---

## Environment Variables

Create a `.env` file in the root directory:

```env
# Database
DATABASE_URL="postgresql://wheelsai:wheelsai@localhost:5434/wheelsai?schema=public"

# Redis
REDIS_URL="redis://localhost:6380"

# Authentication
JWT_SECRET="your-super-secret-jwt-key-change-in-production"
NEXTAUTH_SECRET="your-nextauth-secret"
NEXTAUTH_URL="http://localhost:3000"

# API
API_URL="http://localhost:4000"
NEXT_PUBLIC_API_URL="http://localhost:4000"

# Solana
SOLANA_RPC_URL="https://api.mainnet-beta.solana.com"
SOLANA_NETWORK="mainnet-beta"

# Nosana (GPU Network)
NOSANA_API_KEY="your-nosana-api-key"

# Optional: External Services
GITHUB_CLIENT_ID=""
GITHUB_CLIENT_SECRET=""
GOOGLE_CLIENT_ID=""
GOOGLE_CLIENT_SECRET=""
```

---

## API Reference

### Authentication

All API endpoints (except `/health` and `/auth/*`) require authentication via JWT token.

```bash
# Include token in Authorization header
curl -H "Authorization: Bearer <token>" http://localhost:4000/api/agents
```

### Core Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Health check |
| `POST` | `/api/auth/register` | Register new user |
| `POST` | `/api/auth/login` | Authenticate user |
| `GET` | `/api/agents` | List agents |
| `POST` | `/api/agents` | Create agent |
| `GET` | `/api/agents/:id` | Get agent details |
| `POST` | `/api/agents/:id/deploy` | Deploy agent |
| `GET` | `/api/deployments` | List deployments |
| `GET` | `/api/models` | List available models |
| `POST` | `/api/models/deploy` | Deploy a model |
| `GET` | `/api/marketplace` | Browse marketplace |
| `GET` | `/api/memory/conversations` | List conversations |
| `GET` | `/api/domains` | List custom domains |
| `GET` | `/api/webhooks` | List webhooks |
| `GET` | `/api/billing/usage` | Get usage stats |

### WebSocket Events

```javascript
// Connect to real-time updates
const ws = new WebSocket('ws://localhost:4000/ws');

ws.on('deployment:status', (data) => {
  console.log('Deployment status:', data);
});

ws.on('agent:message', (data) => {
  console.log('Agent message:', data);
});
```

---

## Development

### Available Scripts

```bash
# Development
npm run dev           # Start all services in dev mode
npm run dev:api       # Start API server only
npm run dev:web       # Start web app only

# Database
npm run db:generate   # Generate Prisma client
npm run db:migrate    # Run migrations
npm run db:studio     # Open Prisma Studio
npm run db:seed       # Seed database

# Build
npm run build         # Build all packages
npm run build:api     # Build API only
npm run build:web     # Build web only

# Quality
npm run lint          # Run ESLint
npm run typecheck     # Run TypeScript checks
npm run test          # Run tests
npm run format        # Format code with Prettier
```

### Project Commands

```bash
# Turborepo commands
npx turbo dev         # Run dev in all packages
npx turbo build       # Build all packages
npx turbo lint        # Lint all packages

# Workspace commands
npm run -w @wheelsai/api dev    # Run specific workspace
npm run -w @wheelsai/web build  # Build specific workspace
```

---

## Deployment

### Docker

```bash
# Build production images
docker build -t wheelsai-api -f apps/api/Dockerfile .
docker build -t wheelsai-web -f apps/web/Dockerfile .

# Run with docker-compose
docker-compose -f docker-compose.prod.yml up -d
```

### Kubernetes

```bash
# Apply manifests
kubectl apply -f k8s/

# Check status
kubectl get pods -n wheelsai
```

### Vercel (Web App)

The web app can be deployed to Vercel with zero configuration:

```bash
cd apps/web
vercel deploy
```

---

## Supported Frameworks

WheelsAI supports multiple AI agent frameworks out of the box:

### ElizaOS
```typescript
import { ElizaAgent } from '@wheelsai/eliza';

const agent = new ElizaAgent({
  name: 'my-agent',
  personality: 'helpful assistant',
});
```

### Mastra Framework
```typescript
import { MastraAgent } from '@wheelsai/mastra';

const agent = new MastraAgent({
  name: 'my-agent',
  tools: ['web-search', 'calculator'],
});
```

### LangChain
```typescript
import { LangChainAgent } from '@wheelsai/langchain';

const agent = new LangChainAgent({
  name: 'my-agent',
  model: 'llama-3.1-70b',
  memory: true,
});
```

### Custom Framework
```typescript
import { CustomAgent } from '@wheelsai/core';

const agent = new CustomAgent({
  name: 'my-agent',
  sourceCode: `// Your custom agent code`,
  runtime: 'node',
});
```

---

## Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

### Development Workflow

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Make your changes
4. Run tests: `npm test`
5. Commit your changes: `git commit -m 'Add amazing feature'`
6. Push to the branch: `git push origin feature/amazing-feature`
7. Open a Pull Request

### Code Style

- TypeScript for all code
- ESLint + Prettier for formatting
- Conventional commits for commit messages

---

## Roadmap

### Current (Phase 4)
- [x] Monitoring & Alerting
- [x] Agent Versioning
- [x] Webhooks & Integrations
- [x] Testing Framework
- [x] Conversation Memory
- [x] Custom Domains

### Upcoming (Phase 5)
- [ ] Multi-tenancy / White-labeling
- [ ] RAG with Vector Stores
- [ ] Multi-Agent Orchestration
- [ ] Two-Factor Authentication
- [ ] SDK Generator
- [ ] CLI Tool

See [PHASE5_IDEAS.md](PHASE5_IDEAS.md) for the full roadmap.

---

## Support

- **Documentation**: [docs.wheelsai.io](https://docs.wheelsai.io)
- **Discord**: [discord.gg/wheelsai](https://discord.gg/wheelsai)
- **Twitter**: [@wheelsai](https://twitter.com/wheelsai)
- **Email**: support@wheelsai.io

---

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

## Acknowledgments

- [Nosana](https://nosana.io) - Decentralized GPU infrastructure
- [Solana](https://solana.com) - Blockchain payments
- [ElizaOS](https://elizaos.ai) - AI agent framework
- [Mastra](https://mastra.ai) - Agent development framework

---

<p align="center">
  <strong>Built with wheels within wheels</strong><br/>
  <sub>Powered by Nosana Decentralized GPU Network</sub>
</p>
