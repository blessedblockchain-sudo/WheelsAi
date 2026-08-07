#!/bin/bash
# WheelsAI - Fly.io Deployment Setup Script
# Run this script to create and configure Fly.io apps

set -e

echo "==================================="
echo "WheelsAI Fly.io Setup"
echo "==================================="

# Check if flyctl is installed
if ! command -v flyctl &> /dev/null; then
    echo "Error: flyctl is not installed"
    echo "Install with: curl -L https://fly.io/install.sh | sh"
    exit 1
fi

# Check if logged in
if ! flyctl auth whoami &> /dev/null; then
    echo "Please log in to Fly.io first:"
    flyctl auth login
fi

# Get environment
read -p "Environment (staging/production): " ENV
if [[ "$ENV" != "staging" && "$ENV" != "production" ]]; then
    echo "Error: Environment must be 'staging' or 'production'"
    exit 1
fi

# Set app names
if [ "$ENV" = "staging" ]; then
    API_APP="wheelsai-api-staging"
    WEB_APP="wheelsai-web-staging"
    REGION="lax"
else
    API_APP="wheelsai-api"
    WEB_APP="wheelsai-web"
    REGION="lax"
fi

echo ""
echo "Creating Fly.io apps for $ENV environment..."
echo ""

# Create API app
echo "Creating API app: $API_APP"
cd apps/api
flyctl apps create "$API_APP" --org personal 2>/dev/null || echo "App $API_APP already exists"

# Create Web app
echo "Creating Web app: $WEB_APP"
cd ../web
flyctl apps create "$WEB_APP" --org personal 2>/dev/null || echo "App $WEB_APP already exists"

cd ../..

echo ""
echo "==================================="
echo "Apps created successfully!"
echo "==================================="
echo ""
# Per-environment Solana RPC. The env-schema default is DEVNET, and the API
# refuses to boot with SOLANA_NETWORK=mainnet-beta unless a non-devnet RPC
# URL is explicitly set (B7) — production MUST override it.
if [ "$ENV" = "production" ]; then
    SOLANA_RPC_HINT="https://api.mainnet-beta.solana.com   # or your Helius/Triton URL"
else
    SOLANA_RPC_HINT="https://api.devnet.solana.com"
fi

echo "Next steps:"
echo ""
echo "1. Create a Fly.io API token and add it to GitLab:"
echo "   flyctl tokens create deploy -x 999999h"
echo "   Add as FLY_API_TOKEN in GitLab: Settings > CI/CD > Variables"
echo "   (masked, protected). The deploy jobs in .gitlab-ci.yml only appear"
echo "   when this variable exists."
echo ""
echo "2. Create PostgreSQL database:"
echo "   flyctl postgres create --name wheelsai-db-$ENV --region $REGION"
echo "   flyctl postgres attach wheelsai-db-$ENV --app $API_APP"
echo ""
echo "3. Create Upstash Redis (via Fly.io):"
echo "   flyctl redis create --name wheelsai-redis-$ENV --region $REGION"
echo "   flyctl redis attach wheelsai-redis-$ENV --app $API_APP"
echo ""
echo "4. Set required secrets for API (config/env.ts is the source of truth;"
echo "   the app refuses to boot in production without ENCRYPTION_KEY and"
echo "   CORS_ORIGIN, and ENCRYPTION_KEY must differ from JWT_SECRET):"
echo "   flyctl secrets set -a $API_APP \\"
echo "     JWT_SECRET=\"\$(openssl rand -base64 32)\" \\"
echo "     ENCRYPTION_KEY=\"\$(openssl rand -base64 32)\" \\"
echo "     CORS_ORIGIN=\"https://app.wheelsai.io\" \\"
echo "     WALLET_MASTER_KEY=\"\$(openssl rand -base64 48)\" \\"
echo "     SOLANA_RPC_URL=\"$SOLANA_RPC_HINT\" \\"
echo "     NOSANA_WALLET_PRIVATE_KEY=\"your-wallet-key\" \\"
echo "     SENTRY_DSN=\"https://xxx@xxx.ingest.sentry.io/xxx\""
echo ""
echo "   WALLET_MASTER_KEY note: treasury/creator/deposit keys are HKDF-derived"
echo "   from it — set it ONCE and never rotate casually (rotation changes every"
echo "   derived address). Store a copy in the password manager."
echo ""
echo "   Optional rails (each is gated; the API 501s honestly until set):"
echo "     STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET   (Stripe checkout)"
echo "     WALLET_TOPUPS_ENABLED=true                  (wallet top-ups; needs WALLET_MASTER_KEY)"
echo "     X402_ENABLED=true X402_SUBMIT_TRANSACTIONS=true \\"
echo "     X402_SETTLEMENT_WORKER_ENABLED=true \\"
echo "     TREASURY_WALLET_ADDRESS=<real treasury pubkey>  (x402; boot-fatal if left at the default)"
echo ""
echo "5. Web client config is BUILD-time (NEXT_PUBLIC_* is baked into the"
echo "   browser bundle by 'next build'): it must be passed as --build-arg at"
echo "   deploy — putting it in flyctl secrets does NOTHING for the bundle,"
echo "   and without it the web app calls http://localhost:4000."
echo ""
echo "6. Deploy FROM THE REPO ROOT (the Dockerfiles COPY the monorepo root;"
echo "   running from apps/* fails at the first COPY). Migrations run"
echo "   automatically via the release_command in the fly tomls — no manual"
echo "   'prisma migrate deploy' step."
echo "   flyctl deploy --config apps/api/fly.$ENV.toml --dockerfile apps/api/Dockerfile --remote-only"
echo "   flyctl deploy --config apps/web/fly.$ENV.toml --dockerfile apps/web/Dockerfile --remote-only \\"
echo "     --build-arg NEXT_PUBLIC_API_URL=\"https://$API_APP.fly.dev\" \\"
echo "     --build-arg NEXT_PUBLIC_APP_URL=\"https://$WEB_APP.fly.dev\""
echo ""
echo "7. Smoke check:"
echo "   curl -fsS https://$API_APP.fly.dev/health/ready"
echo ""
