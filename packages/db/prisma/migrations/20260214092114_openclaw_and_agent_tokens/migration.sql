-- CreateEnum
CREATE TYPE "OpenClawStatus" AS ENUM ('PENDING', 'BUILDING', 'DEPLOYING', 'RUNNING', 'STOPPED', 'FAILED');

-- CreateEnum
CREATE TYPE "TokenStatus" AS ENUM ('BONDING', 'GRADUATED', 'FAILED');

-- CreateTable
CREATE TABLE "openclaw_deployments" (
    "id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "openclaw_version" TEXT NOT NULL DEFAULT 'latest',
    "docker_image" TEXT NOT NULL DEFAULT 'wheelsai/openclaw-hardened:latest',
    "env_encrypted" TEXT NOT NULL,
    "status" "OpenClawStatus" NOT NULL DEFAULT 'PENDING',
    "nosana_job_id" TEXT,
    "public_url" TEXT,
    "health_last_check" TIMESTAMP(3),
    "health_status" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "openclaw_deployments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "openclaw_channels" (
    "id" UUID NOT NULL,
    "deployment_id" UUID NOT NULL,
    "platform" TEXT NOT NULL,
    "config_encrypted" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "openclaw_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_tokens" (
    "id" UUID NOT NULL,
    "agent_listing_id" UUID NOT NULL,
    "mint_address" TEXT NOT NULL,
    "pumpfun_url" TEXT,
    "bonding_curve_address" TEXT,
    "creator_address" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "image_uri" TEXT,
    "total_supply" BIGINT NOT NULL DEFAULT 1000000000,
    "curve_supply" BIGINT NOT NULL DEFAULT 800000000,
    "reserved_supply" BIGINT NOT NULL DEFAULT 200000000,
    "status" "TokenStatus" NOT NULL DEFAULT 'BONDING',
    "graduated_at" TIMESTAMP(3),
    "raydium_pool_id" TEXT,
    "market_cap_usd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "price_usd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "volume_24h" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "holders" INTEGER NOT NULL DEFAULT 0,
    "creator_lockup_end" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_token_trades" (
    "id" UUID NOT NULL,
    "token_id" UUID NOT NULL,
    "tx_signature" TEXT NOT NULL,
    "trader_address" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "sol_amount" DOUBLE PRECISION NOT NULL,
    "token_amount" DOUBLE PRECISION NOT NULL,
    "price_usd" DOUBLE PRECISION NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_token_trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_token_holders" (
    "id" UUID NOT NULL,
    "token_id" UUID NOT NULL,
    "wallet_address" TEXT NOT NULL,
    "balance" DOUBLE PRECISION NOT NULL,
    "percentage" DOUBLE PRECISION NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_token_holders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_token_snapshots" (
    "id" UUID NOT NULL,
    "token_id" UUID NOT NULL,
    "price_usd" DOUBLE PRECISION NOT NULL,
    "market_cap_usd" DOUBLE PRECISION NOT NULL,
    "volume_24h" DOUBLE PRECISION NOT NULL,
    "holders" INTEGER NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_token_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "openclaw_deployments_agent_id_key" ON "openclaw_deployments"("agent_id");

-- CreateIndex
CREATE INDEX "openclaw_deployments_status_idx" ON "openclaw_deployments"("status");

-- CreateIndex
CREATE INDEX "openclaw_channels_deployment_id_idx" ON "openclaw_channels"("deployment_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_tokens_agent_listing_id_key" ON "agent_tokens"("agent_listing_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_tokens_mint_address_key" ON "agent_tokens"("mint_address");

-- CreateIndex
CREATE INDEX "agent_tokens_status_idx" ON "agent_tokens"("status");

-- CreateIndex
CREATE INDEX "agent_tokens_market_cap_usd_idx" ON "agent_tokens"("market_cap_usd");

-- CreateIndex
CREATE INDEX "agent_tokens_volume_24h_idx" ON "agent_tokens"("volume_24h");

-- CreateIndex
CREATE UNIQUE INDEX "agent_token_trades_tx_signature_key" ON "agent_token_trades"("tx_signature");

-- CreateIndex
CREATE INDEX "agent_token_trades_token_id_timestamp_idx" ON "agent_token_trades"("token_id", "timestamp");

-- CreateIndex
CREATE INDEX "agent_token_trades_trader_address_idx" ON "agent_token_trades"("trader_address");

-- CreateIndex
CREATE INDEX "agent_token_holders_token_id_idx" ON "agent_token_holders"("token_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_token_holders_token_id_wallet_address_key" ON "agent_token_holders"("token_id", "wallet_address");

-- CreateIndex
CREATE INDEX "agent_token_snapshots_token_id_timestamp_idx" ON "agent_token_snapshots"("token_id", "timestamp");

-- AddForeignKey
ALTER TABLE "openclaw_deployments" ADD CONSTRAINT "openclaw_deployments_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "openclaw_channels" ADD CONSTRAINT "openclaw_channels_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "openclaw_deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_tokens" ADD CONSTRAINT "agent_tokens_agent_listing_id_fkey" FOREIGN KEY ("agent_listing_id") REFERENCES "agent_listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_token_trades" ADD CONSTRAINT "agent_token_trades_token_id_fkey" FOREIGN KEY ("token_id") REFERENCES "agent_tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_token_holders" ADD CONSTRAINT "agent_token_holders_token_id_fkey" FOREIGN KEY ("token_id") REFERENCES "agent_tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_token_snapshots" ADD CONSTRAINT "agent_token_snapshots_token_id_fkey" FOREIGN KEY ("token_id") REFERENCES "agent_tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;
