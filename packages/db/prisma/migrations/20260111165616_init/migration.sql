-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT,
    "password_hash" TEXT,
    "wallet_address" TEXT,
    "display_name" TEXT,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "owner_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_members" (
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" TEXT NOT NULL,

    CONSTRAINT "org_members_pkey" PRIMARY KEY ("org_id","user_id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "key_hash" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "name" TEXT,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "last_used_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "models" (
    "id" TEXT NOT NULL,
    "hf_id" TEXT NOT NULL,
    "ollama_model_id" TEXT,
    "display_name" TEXT NOT NULL,
    "description" TEXT,
    "parameters" BIGINT,
    "min_gpu_tier" TEXT NOT NULL,
    "supported_engines" TEXT[],
    "default_engine" TEXT NOT NULL,
    "context_length" INTEGER NOT NULL,
    "license" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pricing_tier" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deployments" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "engine" TEXT NOT NULL,
    "gpu_tier" TEXT NOT NULL,
    "replicas" INTEGER NOT NULL DEFAULT 1,
    "config" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "nosana_job_ids" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "stopped_at" TIMESTAMP(3),

    CONSTRAINT "deployments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deployment_nodes" (
    "id" UUID NOT NULL,
    "deployment_id" UUID NOT NULL,
    "nosana_node_id" TEXT NOT NULL,
    "node_url" TEXT NOT NULL,
    "health_status" TEXT NOT NULL DEFAULT 'unknown',
    "last_health_check" TIMESTAMP(3),
    "latency_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deployment_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_balances" (
    "org_id" UUID NOT NULL,
    "balance_cents" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credit_balances_pkey" PRIMARY KEY ("org_id")
);

-- CreateTable
CREATE TABLE "credit_transactions" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "type" TEXT NOT NULL,
    "description" TEXT,
    "reference_id" TEXT,
    "balance_after" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_records" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "deployment_id" UUID NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "request_count" INTEGER NOT NULL DEFAULT 0,
    "input_tokens" BIGINT NOT NULL DEFAULT 0,
    "output_tokens" BIGINT NOT NULL DEFAULT 0,
    "total_latency_ms" BIGINT NOT NULL DEFAULT 0,
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "cost_cents" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "usage_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_wallets" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "deployment_id" UUID NOT NULL,
    "wallet_address" TEXT NOT NULL,
    "encrypted_key" BYTEA NOT NULL,
    "key_version" INTEGER NOT NULL DEFAULT 1,
    "daily_limit_cents" BIGINT,
    "per_tx_limit_cents" BIGINT,
    "allowed_domains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_transactions" (
    "id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "direction" TEXT NOT NULL,
    "amount_lamports" BIGINT NOT NULL,
    "token" TEXT NOT NULL,
    "counterparty" TEXT NOT NULL,
    "tx_signature" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agents" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "framework" TEXT NOT NULL,
    "system_prompt" TEXT,
    "tools" JSONB NOT NULL DEFAULT '[]',
    "model_config" JSONB NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_url" TEXT,
    "source_code" TEXT,
    "env" JSONB NOT NULL DEFAULT '{}',
    "secrets" BYTEA,
    "version" TEXT NOT NULL DEFAULT '1.0.0',
    "is_public" BOOLEAN NOT NULL DEFAULT false,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_deployments" (
    "id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "gpu_tier" TEXT NOT NULL,
    "replicas" INTEGER NOT NULL DEFAULT 1,
    "model_deployment_id" UUID,
    "external_model_url" TEXT,
    "external_model_key" BYTEA,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "endpoint" TEXT,
    "nosana_job_ids" TEXT[],
    "wallet_id" UUID,
    "build_logs" TEXT,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "stopped_at" TIMESTAMP(3),

    CONSTRAINT "agent_deployments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "datasets" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "storage_type" TEXT NOT NULL,
    "storage_url" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "row_count" INTEGER NOT NULL,
    "is_validated" BOOLEAN NOT NULL DEFAULT false,
    "validation_errors" JSONB,
    "sample_rows" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "datasets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_jobs" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "base_model_id" TEXT NOT NULL,
    "base_model_hf_id" TEXT NOT NULL,
    "dataset_id" UUID NOT NULL,
    "method" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "gpu_tier" TEXT NOT NULL,
    "gpu_count" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "current_epoch" INTEGER,
    "total_epochs" INTEGER,
    "nosana_job_id" TEXT,
    "output_model_id" TEXT,
    "output_path" TEXT,
    "training_loss" DOUBLE PRECISION,
    "eval_loss" DOUBLE PRECISION,
    "metrics" JSONB,
    "logs" TEXT,
    "last_error" TEXT,
    "estimated_cost_cents" BIGINT,
    "actual_cost_cents" BIGINT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "training_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "x402_payments" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "deployment_id" UUID,
    "agent_deployment_id" UUID,
    "request_id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "amount_raw" TEXT NOT NULL,
    "amount_usd" DOUBLE PRECISION NOT NULL,
    "payer_address" TEXT NOT NULL,
    "payee_address" TEXT NOT NULL,
    "tx_signature" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "verified_at" TIMESTAMP(3),
    "settled_at" TIMESTAMP(3),
    "failure_reason" TEXT,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "x402_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_listings" (
    "id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "short_description" VARCHAR(280) NOT NULL,
    "long_description" TEXT,
    "category" TEXT NOT NULL,
    "icon_url" TEXT,
    "screenshots" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "readme" TEXT,
    "pricing_model" TEXT NOT NULL,
    "price_per_request_cents" BIGINT,
    "monthly_price_cents" BIGINT,
    "publisher_id" UUID NOT NULL,
    "publisher_name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "is_featured" BOOLEAN NOT NULL DEFAULT false,
    "total_installs" INTEGER NOT NULL DEFAULT 0,
    "active_installs" INTEGER NOT NULL DEFAULT 0,
    "avg_rating" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "review_count" INTEGER NOT NULL DEFAULT 0,
    "total_requests" BIGINT NOT NULL DEFAULT 0,
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_listings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_reviews" (
    "id" UUID NOT NULL,
    "listing_id" UUID NOT NULL,
    "reviewer_id" UUID NOT NULL,
    "rating" INTEGER NOT NULL,
    "title" VARCHAR(200),
    "content" TEXT,
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "helpful_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_installs" (
    "id" UUID NOT NULL,
    "listing_id" UUID NOT NULL,
    "buyer_id" UUID NOT NULL,
    "cloned_agent_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'active',
    "total_requests" BIGINT NOT NULL DEFAULT 0,
    "total_spent_cents" BIGINT NOT NULL DEFAULT 0,
    "installed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalled_at" TIMESTAMP(3),

    CONSTRAINT "agent_installs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_subscriptions" (
    "id" UUID NOT NULL,
    "listing_id" UUID NOT NULL,
    "subscriber_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "current_period_start" TIMESTAMP(3) NOT NULL,
    "current_period_end" TIMESTAMP(3) NOT NULL,
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "cancelled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publisher_profiles" (
    "org_id" UUID NOT NULL,
    "display_name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "bio" TEXT,
    "avatar_url" TEXT,
    "website" TEXT,
    "twitter" TEXT,
    "github" TEXT,
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "total_revenue_cents" BIGINT NOT NULL DEFAULT 0,
    "pending_payout_cents" BIGINT NOT NULL DEFAULT 0,
    "total_listings" INTEGER NOT NULL DEFAULT 0,
    "total_installs" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "reputation_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reputation_tier" TEXT NOT NULL DEFAULT 'new',
    "avg_response_time_ms" BIGINT,
    "support_response_ms" BIGINT,
    "successful_payouts" INTEGER NOT NULL DEFAULT 0,
    "dispute_count" INTEGER NOT NULL DEFAULT 0,
    "dispute_resolved_count" INTEGER NOT NULL DEFAULT 0,
    "joined_days_ago" INTEGER NOT NULL DEFAULT 0,
    "badges" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "last_reputation_calc" TIMESTAMP(3),

    CONSTRAINT "publisher_profiles_pkey" PRIMARY KEY ("org_id")
);

-- CreateTable
CREATE TABLE "creator_payouts" (
    "id" UUID NOT NULL,
    "publisher_id" UUID NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "payout_method" TEXT NOT NULL,
    "payout_address" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "tx_signature" TEXT,
    "gross_revenue_cents" BIGINT NOT NULL,
    "platform_fee_cents" BIGINT NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),
    "failure_reason" TEXT,

    CONSTRAINT "creator_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketplace_revenue" (
    "id" UUID NOT NULL,
    "listing_id" UUID NOT NULL,
    "install_id" UUID,
    "subscription_id" UUID,
    "buyer_id" UUID NOT NULL,
    "publisher_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "gross_amount_cents" BIGINT NOT NULL,
    "platform_fee_cents" BIGINT NOT NULL,
    "creator_amount_cents" BIGINT NOT NULL,
    "request_count" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "settled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketplace_revenue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "user_id" UUID,
    "action" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "resource_id" TEXT,
    "details" JSONB,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "status" TEXT NOT NULL DEFAULT 'success',
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sso_configs" (
    "org_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "saml_entity_id" TEXT,
    "saml_sso_url" TEXT,
    "saml_certificate" TEXT,
    "oidc_client_id" TEXT,
    "oidc_client_secret" BYTEA,
    "oidc_issuer" TEXT,
    "oidc_scopes" TEXT[] DEFAULT ARRAY['openid', 'profile', 'email']::TEXT[],
    "allowed_domains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "auto_provision" BOOLEAN NOT NULL DEFAULT true,
    "default_role" TEXT NOT NULL DEFAULT 'member',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sso_configs_pkey" PRIMARY KEY ("org_id")
);

-- CreateTable
CREATE TABLE "team_invites" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "invited_by" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "accepted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_graphs" (
    "id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "nodes" JSONB NOT NULL DEFAULT '[]',
    "edges" JSONB NOT NULL DEFAULT '[]',
    "viewport" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "is_valid" BOOLEAN NOT NULL DEFAULT false,
    "validation_errors" JSONB,
    "generated_code" TEXT,
    "code_language" TEXT,
    "last_generated" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_graphs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_snapshots" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "snapshot_type" TEXT NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "total_requests" BIGINT NOT NULL DEFAULT 0,
    "total_tokens_in" BIGINT NOT NULL DEFAULT 0,
    "total_tokens_out" BIGINT NOT NULL DEFAULT 0,
    "total_cost_cents" BIGINT NOT NULL DEFAULT 0,
    "avg_latency_ms" DOUBLE PRECISION,
    "p50_latency_ms" DOUBLE PRECISION,
    "p95_latency_ms" DOUBLE PRECISION,
    "p99_latency_ms" DOUBLE PRECISION,
    "error_rate" DOUBLE PRECISION,
    "deployment_stats" JSONB,
    "agent_stats" JSONB,
    "model_stats" JSONB,
    "cost_by_gpu_tier" JSONB,
    "cost_by_model" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_channels" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_tested_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alert_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_rules" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "rule_type" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" UUID,
    "metric" TEXT NOT NULL,
    "operator" TEXT NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "window_minutes" INTEGER NOT NULL DEFAULT 5,
    "severity" TEXT NOT NULL DEFAULT 'warning',
    "cooldown_minutes" INTEGER NOT NULL DEFAULT 60,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_triggered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alert_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_rule_channels" (
    "rule_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,

    CONSTRAINT "alert_rule_channels_pkey" PRIMARY KEY ("rule_id","channel_id")
);

-- CreateTable
CREATE TABLE "alerts" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" UUID,
    "metric_value" DOUBLE PRECISION NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "triggered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledged_at" TIMESTAMP(3),
    "acknowledged_by" UUID,
    "resolved_at" TIMESTAMP(3),
    "resolved_by" UUID,
    "notifications_sent" JSONB,

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "uptime_monitors" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" UUID,
    "target_url" TEXT,
    "check_interval_seconds" INTEGER NOT NULL DEFAULT 60,
    "timeout_seconds" INTEGER NOT NULL DEFAULT 30,
    "http_method" TEXT NOT NULL DEFAULT 'GET',
    "expected_status" INTEGER NOT NULL DEFAULT 200,
    "expected_body" TEXT,
    "headers" JSONB,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "current_status" TEXT NOT NULL DEFAULT 'unknown',
    "last_check_at" TIMESTAMP(3),
    "last_up_at" TIMESTAMP(3),
    "last_down_at" TIMESTAMP(3),
    "uptime_percent_24h" DOUBLE PRECISION,
    "uptime_percent_7d" DOUBLE PRECISION,
    "uptime_percent_30d" DOUBLE PRECISION,
    "avg_latency_ms" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "uptime_monitors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "uptime_events" (
    "id" UUID NOT NULL,
    "monitor_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "status_code" INTEGER,
    "latency_ms" INTEGER,
    "error_message" TEXT,
    "response_body" TEXT,
    "response_headers" JSONB,
    "check_region" TEXT,
    "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uptime_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_versions" (
    "id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "version" TEXT NOT NULL,
    "version_number" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "framework" TEXT NOT NULL,
    "system_prompt" TEXT,
    "tools" JSONB NOT NULL DEFAULT '[]',
    "model_config" JSONB NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_url" TEXT,
    "source_code" TEXT,
    "env" JSONB NOT NULL DEFAULT '{}',
    "graph_nodes" JSONB,
    "graph_edges" JSONB,
    "change_log" TEXT,
    "change_type" TEXT NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_by_id" UUID NOT NULL,
    "created_by_name" TEXT,
    "is_latest" BOOLEAN NOT NULL DEFAULT false,
    "is_published" BOOLEAN NOT NULL DEFAULT false,
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_version_diffs" (
    "id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "from_version" TEXT NOT NULL,
    "to_version" TEXT NOT NULL,
    "changes" JSONB NOT NULL,
    "added_fields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "removed_fields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "modified_fields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lines_added" INTEGER NOT NULL DEFAULT 0,
    "lines_removed" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_version_diffs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhooks" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "events" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "resource_type" TEXT,
    "resource_id" UUID,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "retry_count" INTEGER NOT NULL DEFAULT 3,
    "timeout_seconds" INTEGER NOT NULL DEFAULT 30,
    "headers" JSONB,
    "last_delivered_at" TIMESTAMP(3),
    "last_failed_at" TIMESTAMP(3),
    "last_error" TEXT,
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" UUID NOT NULL,
    "webhook_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "status_code" INTEGER,
    "response_body" TEXT,
    "response_time_ms" INTEGER,
    "error_message" TEXT,
    "scheduled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMP(3),
    "next_retry_at" TIMESTAMP(3),

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integrations" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "access_token" BYTEA,
    "refresh_token" BYTEA,
    "token_expires_at" TIMESTAMP(3),
    "config" JSONB NOT NULL DEFAULT '{}',
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "is_connected" BOOLEAN NOT NULL DEFAULT false,
    "last_sync_at" TIMESTAMP(3),
    "last_error" TEXT,
    "external_id" TEXT,
    "external_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_events" (
    "id" UUID NOT NULL,
    "integration_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "input_payload" JSONB,
    "output_payload" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "integration_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_suites" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "timeout" INTEGER NOT NULL DEFAULT 30000,
    "retries" INTEGER NOT NULL DEFAULT 0,
    "parallel" BOOLEAN NOT NULL DEFAULT false,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "total_tests" INTEGER NOT NULL DEFAULT 0,
    "last_run_at" TIMESTAMP(3),
    "last_status" TEXT,
    "pass_rate" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "test_suites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_cases" (
    "id" UUID NOT NULL,
    "suite_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "input_type" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "assertion_type" TEXT NOT NULL,
    "expected" JSONB NOT NULL,
    "tolerance" DOUBLE PRECISION,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "custom_script" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "test_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_runs" (
    "id" UUID NOT NULL,
    "suite_id" UUID NOT NULL,
    "agent_version" TEXT,
    "deployment_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "total_tests" INTEGER NOT NULL DEFAULT 0,
    "passed_tests" INTEGER NOT NULL DEFAULT 0,
    "failed_tests" INTEGER NOT NULL DEFAULT 0,
    "skipped_tests" INTEGER NOT NULL DEFAULT 0,
    "pass_rate" DOUBLE PRECISION,
    "total_duration_ms" INTEGER,
    "triggered_by" TEXT,
    "triggered_by_id" UUID,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "test_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_results" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "test_case_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "duration_ms" INTEGER,
    "actual_output" JSONB,
    "error" TEXT,
    "assertion_result" JSONB,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "test_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "agent_id" UUID,
    "deployment_id" UUID,
    "session_id" TEXT NOT NULL,
    "user_id" TEXT,
    "title" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "metadata" JSONB,
    "status" TEXT NOT NULL DEFAULT 'active',
    "message_count" INTEGER NOT NULL DEFAULT 0,
    "token_count" INTEGER NOT NULL DEFAULT 0,
    "last_message_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "name" TEXT,
    "function_call" JSONB,
    "tool_calls" JSONB,
    "tool_call_id" TEXT,
    "tokens" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "sequence_num" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_contexts" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "key" TEXT,
    "content" TEXT NOT NULL,
    "embedding" BYTEA,
    "importance" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "access_count" INTEGER NOT NULL DEFAULT 0,
    "last_accessed_at" TIMESTAMP(3),
    "source_message_id" UUID,
    "source_range" JSONB,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memory_contexts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_domains" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "domain" TEXT NOT NULL,
    "subdomain" TEXT,
    "root_domain" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" UUID NOT NULL,
    "verification_status" TEXT NOT NULL DEFAULT 'pending',
    "verification_token" TEXT NOT NULL,
    "verification_method" TEXT NOT NULL DEFAULT 'dns_txt',
    "verified_at" TIMESTAMP(3),
    "last_checked_at" TIMESTAMP(3),
    "verification_error" TEXT,
    "ssl_status" TEXT NOT NULL DEFAULT 'pending',
    "ssl_provider" TEXT,
    "ssl_expires_at" TIMESTAMP(3),
    "ssl_error" TEXT,
    "custom_cert" BYTEA,
    "custom_key" BYTEA,
    "custom_cert_chain" BYTEA,
    "routing_mode" TEXT NOT NULL DEFAULT 'proxy',
    "force_https" BOOLEAN NOT NULL DEFAULT true,
    "headers" JSONB,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "total_requests" BIGINT NOT NULL DEFAULT 0,
    "last_request_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_domains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "domain_events" (
    "id" UUID NOT NULL,
    "domain_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "message" TEXT,
    "details" JSONB,
    "previous_status" TEXT,
    "new_status" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "domain_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_wallet_address_key" ON "users"("wallet_address");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");

-- CreateIndex
CREATE INDEX "deployments_org_id_idx" ON "deployments"("org_id");

-- CreateIndex
CREATE INDEX "deployments_status_idx" ON "deployments"("status");

-- CreateIndex
CREATE UNIQUE INDEX "deployments_org_id_slug_key" ON "deployments"("org_id", "slug");

-- CreateIndex
CREATE INDEX "deployment_nodes_deployment_id_idx" ON "deployment_nodes"("deployment_id");

-- CreateIndex
CREATE INDEX "credit_transactions_org_id_created_at_idx" ON "credit_transactions"("org_id", "created_at");

-- CreateIndex
CREATE INDEX "usage_records_org_id_period_start_idx" ON "usage_records"("org_id", "period_start");

-- CreateIndex
CREATE UNIQUE INDEX "usage_records_org_id_deployment_id_period_start_key" ON "usage_records"("org_id", "deployment_id", "period_start");

-- CreateIndex
CREATE UNIQUE INDEX "agent_wallets_deployment_id_key" ON "agent_wallets"("deployment_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_wallets_wallet_address_key" ON "agent_wallets"("wallet_address");

-- CreateIndex
CREATE UNIQUE INDEX "agent_transactions_tx_signature_key" ON "agent_transactions"("tx_signature");

-- CreateIndex
CREATE INDEX "agents_org_id_idx" ON "agents"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "agents_org_id_slug_key" ON "agents"("org_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "agent_deployments_wallet_id_key" ON "agent_deployments"("wallet_id");

-- CreateIndex
CREATE INDEX "agent_deployments_agent_id_idx" ON "agent_deployments"("agent_id");

-- CreateIndex
CREATE INDEX "datasets_org_id_idx" ON "datasets"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "datasets_org_id_name_key" ON "datasets"("org_id", "name");

-- CreateIndex
CREATE INDEX "training_jobs_org_id_idx" ON "training_jobs"("org_id");

-- CreateIndex
CREATE INDEX "training_jobs_status_idx" ON "training_jobs"("status");

-- CreateIndex
CREATE UNIQUE INDEX "x402_payments_tx_signature_key" ON "x402_payments"("tx_signature");

-- CreateIndex
CREATE INDEX "x402_payments_org_id_created_at_idx" ON "x402_payments"("org_id", "created_at");

-- CreateIndex
CREATE INDEX "x402_payments_tx_signature_idx" ON "x402_payments"("tx_signature");

-- CreateIndex
CREATE INDEX "x402_payments_status_idx" ON "x402_payments"("status");

-- CreateIndex
CREATE UNIQUE INDEX "agent_listings_agent_id_key" ON "agent_listings"("agent_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_listings_slug_key" ON "agent_listings"("slug");

-- CreateIndex
CREATE INDEX "agent_listings_publisher_id_idx" ON "agent_listings"("publisher_id");

-- CreateIndex
CREATE INDEX "agent_listings_status_category_idx" ON "agent_listings"("status", "category");

-- CreateIndex
CREATE INDEX "agent_listings_avg_rating_idx" ON "agent_listings"("avg_rating");

-- CreateIndex
CREATE INDEX "agent_listings_is_featured_status_idx" ON "agent_listings"("is_featured", "status");

-- CreateIndex
CREATE INDEX "agent_reviews_listing_id_created_at_idx" ON "agent_reviews"("listing_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "agent_reviews_listing_id_reviewer_id_key" ON "agent_reviews"("listing_id", "reviewer_id");

-- CreateIndex
CREATE INDEX "agent_installs_buyer_id_idx" ON "agent_installs"("buyer_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_installs_listing_id_buyer_id_key" ON "agent_installs"("listing_id", "buyer_id");

-- CreateIndex
CREATE INDEX "agent_subscriptions_subscriber_id_idx" ON "agent_subscriptions"("subscriber_id");

-- CreateIndex
CREATE INDEX "agent_subscriptions_current_period_end_status_idx" ON "agent_subscriptions"("current_period_end", "status");

-- CreateIndex
CREATE UNIQUE INDEX "agent_subscriptions_listing_id_subscriber_id_key" ON "agent_subscriptions"("listing_id", "subscriber_id");

-- CreateIndex
CREATE UNIQUE INDEX "publisher_profiles_slug_key" ON "publisher_profiles"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "creator_payouts_tx_signature_key" ON "creator_payouts"("tx_signature");

-- CreateIndex
CREATE INDEX "creator_payouts_publisher_id_status_idx" ON "creator_payouts"("publisher_id", "status");

-- CreateIndex
CREATE INDEX "marketplace_revenue_listing_id_created_at_idx" ON "marketplace_revenue"("listing_id", "created_at");

-- CreateIndex
CREATE INDEX "marketplace_revenue_publisher_id_created_at_idx" ON "marketplace_revenue"("publisher_id", "created_at");

-- CreateIndex
CREATE INDEX "marketplace_revenue_buyer_id_created_at_idx" ON "marketplace_revenue"("buyer_id", "created_at");

-- CreateIndex
CREATE INDEX "marketplace_revenue_status_idx" ON "marketplace_revenue"("status");

-- CreateIndex
CREATE INDEX "audit_logs_org_id_created_at_idx" ON "audit_logs"("org_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_org_id_action_idx" ON "audit_logs"("org_id", "action");

-- CreateIndex
CREATE INDEX "audit_logs_org_id_resource_idx" ON "audit_logs"("org_id", "resource");

-- CreateIndex
CREATE INDEX "audit_logs_user_id_idx" ON "audit_logs"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "team_invites_token_key" ON "team_invites"("token");

-- CreateIndex
CREATE INDEX "team_invites_org_id_status_idx" ON "team_invites"("org_id", "status");

-- CreateIndex
CREATE INDEX "team_invites_email_idx" ON "team_invites"("email");

-- CreateIndex
CREATE UNIQUE INDEX "agent_graphs_agent_id_key" ON "agent_graphs"("agent_id");

-- CreateIndex
CREATE INDEX "analytics_snapshots_org_id_snapshot_type_period_start_idx" ON "analytics_snapshots"("org_id", "snapshot_type", "period_start");

-- CreateIndex
CREATE UNIQUE INDEX "analytics_snapshots_org_id_snapshot_type_period_start_key" ON "analytics_snapshots"("org_id", "snapshot_type", "period_start");

-- CreateIndex
CREATE INDEX "alert_channels_org_id_idx" ON "alert_channels"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "alert_channels_org_id_name_key" ON "alert_channels"("org_id", "name");

-- CreateIndex
CREATE INDEX "alert_rules_org_id_is_enabled_idx" ON "alert_rules"("org_id", "is_enabled");

-- CreateIndex
CREATE INDEX "alert_rules_resource_type_resource_id_idx" ON "alert_rules"("resource_type", "resource_id");

-- CreateIndex
CREATE UNIQUE INDEX "alert_rules_org_id_name_key" ON "alert_rules"("org_id", "name");

-- CreateIndex
CREATE INDEX "alerts_org_id_status_idx" ON "alerts"("org_id", "status");

-- CreateIndex
CREATE INDEX "alerts_org_id_triggered_at_idx" ON "alerts"("org_id", "triggered_at");

-- CreateIndex
CREATE INDEX "alerts_rule_id_status_idx" ON "alerts"("rule_id", "status");

-- CreateIndex
CREATE INDEX "uptime_monitors_org_id_is_enabled_idx" ON "uptime_monitors"("org_id", "is_enabled");

-- CreateIndex
CREATE UNIQUE INDEX "uptime_monitors_org_id_name_key" ON "uptime_monitors"("org_id", "name");

-- CreateIndex
CREATE INDEX "uptime_events_monitor_id_checked_at_idx" ON "uptime_events"("monitor_id", "checked_at");

-- CreateIndex
CREATE INDEX "uptime_events_monitor_id_status_idx" ON "uptime_events"("monitor_id", "status");

-- CreateIndex
CREATE INDEX "agent_versions_agent_id_is_latest_idx" ON "agent_versions"("agent_id", "is_latest");

-- CreateIndex
CREATE INDEX "agent_versions_agent_id_created_at_idx" ON "agent_versions"("agent_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "agent_versions_agent_id_version_key" ON "agent_versions"("agent_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "agent_versions_agent_id_version_number_key" ON "agent_versions"("agent_id", "version_number");

-- CreateIndex
CREATE UNIQUE INDEX "agent_version_diffs_agent_id_from_version_to_version_key" ON "agent_version_diffs"("agent_id", "from_version", "to_version");

-- CreateIndex
CREATE INDEX "webhooks_org_id_is_enabled_idx" ON "webhooks"("org_id", "is_enabled");

-- CreateIndex
CREATE INDEX "webhooks_org_id_events_idx" ON "webhooks"("org_id", "events");

-- CreateIndex
CREATE UNIQUE INDEX "webhooks_org_id_name_key" ON "webhooks"("org_id", "name");

-- CreateIndex
CREATE INDEX "webhook_deliveries_webhook_id_status_idx" ON "webhook_deliveries"("webhook_id", "status");

-- CreateIndex
CREATE INDEX "webhook_deliveries_webhook_id_event_id_idx" ON "webhook_deliveries"("webhook_id", "event_id");

-- CreateIndex
CREATE INDEX "webhook_deliveries_status_next_retry_at_idx" ON "webhook_deliveries"("status", "next_retry_at");

-- CreateIndex
CREATE INDEX "integrations_org_id_type_idx" ON "integrations"("org_id", "type");

-- CreateIndex
CREATE INDEX "integrations_org_id_is_enabled_idx" ON "integrations"("org_id", "is_enabled");

-- CreateIndex
CREATE UNIQUE INDEX "integrations_org_id_type_name_key" ON "integrations"("org_id", "type", "name");

-- CreateIndex
CREATE INDEX "integration_events_integration_id_created_at_idx" ON "integration_events"("integration_id", "created_at");

-- CreateIndex
CREATE INDEX "integration_events_integration_id_status_idx" ON "integration_events"("integration_id", "status");

-- CreateIndex
CREATE INDEX "test_suites_org_id_agent_id_idx" ON "test_suites"("org_id", "agent_id");

-- CreateIndex
CREATE INDEX "test_suites_org_id_is_enabled_idx" ON "test_suites"("org_id", "is_enabled");

-- CreateIndex
CREATE UNIQUE INDEX "test_suites_org_id_agent_id_name_key" ON "test_suites"("org_id", "agent_id", "name");

-- CreateIndex
CREATE INDEX "test_cases_suite_id_is_enabled_idx" ON "test_cases"("suite_id", "is_enabled");

-- CreateIndex
CREATE UNIQUE INDEX "test_cases_suite_id_name_key" ON "test_cases"("suite_id", "name");

-- CreateIndex
CREATE INDEX "test_runs_suite_id_status_idx" ON "test_runs"("suite_id", "status");

-- CreateIndex
CREATE INDEX "test_runs_suite_id_created_at_idx" ON "test_runs"("suite_id", "created_at");

-- CreateIndex
CREATE INDEX "test_results_run_id_status_idx" ON "test_results"("run_id", "status");

-- CreateIndex
CREATE INDEX "test_results_test_case_id_idx" ON "test_results"("test_case_id");

-- CreateIndex
CREATE INDEX "conversations_org_id_agent_id_idx" ON "conversations"("org_id", "agent_id");

-- CreateIndex
CREATE INDEX "conversations_org_id_status_idx" ON "conversations"("org_id", "status");

-- CreateIndex
CREATE INDEX "conversations_org_id_last_message_at_idx" ON "conversations"("org_id", "last_message_at");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_org_id_session_id_key" ON "conversations"("org_id", "session_id");

-- CreateIndex
CREATE INDEX "messages_conversation_id_sequence_num_idx" ON "messages"("conversation_id", "sequence_num");

-- CreateIndex
CREATE INDEX "messages_conversation_id_role_idx" ON "messages"("conversation_id", "role");

-- CreateIndex
CREATE INDEX "memory_contexts_conversation_id_type_idx" ON "memory_contexts"("conversation_id", "type");

-- CreateIndex
CREATE INDEX "memory_contexts_conversation_id_is_active_idx" ON "memory_contexts"("conversation_id", "is_active");

-- CreateIndex
CREATE INDEX "memory_contexts_conversation_id_importance_idx" ON "memory_contexts"("conversation_id", "importance");

-- CreateIndex
CREATE UNIQUE INDEX "custom_domains_domain_key" ON "custom_domains"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "custom_domains_verification_token_key" ON "custom_domains"("verification_token");

-- CreateIndex
CREATE INDEX "custom_domains_org_id_target_type_target_id_idx" ON "custom_domains"("org_id", "target_type", "target_id");

-- CreateIndex
CREATE INDEX "custom_domains_verification_status_idx" ON "custom_domains"("verification_status");

-- CreateIndex
CREATE INDEX "custom_domains_ssl_status_idx" ON "custom_domains"("ssl_status");

-- CreateIndex
CREATE INDEX "custom_domains_is_active_idx" ON "custom_domains"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "custom_domains_org_id_domain_key" ON "custom_domains"("org_id", "domain");

-- CreateIndex
CREATE INDEX "domain_events_domain_id_created_at_idx" ON "domain_events"("domain_id", "created_at");

-- CreateIndex
CREATE INDEX "domain_events_domain_id_event_type_idx" ON "domain_events"("domain_id", "event_type");

-- AddForeignKey
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "models"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployment_nodes" ADD CONSTRAINT "deployment_nodes_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_balances" ADD CONSTRAINT "credit_balances_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_wallets" ADD CONSTRAINT "agent_wallets_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_wallets" ADD CONSTRAINT "agent_wallets_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_transactions" ADD CONSTRAINT "agent_transactions_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "agent_wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_deployments" ADD CONSTRAINT "agent_deployments_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "datasets" ADD CONSTRAINT "datasets_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_jobs" ADD CONSTRAINT "training_jobs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_jobs" ADD CONSTRAINT "training_jobs_dataset_id_fkey" FOREIGN KEY ("dataset_id") REFERENCES "datasets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "x402_payments" ADD CONSTRAINT "x402_payments_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_listings" ADD CONSTRAINT "agent_listings_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_listings" ADD CONSTRAINT "agent_listings_publisher_id_fkey" FOREIGN KEY ("publisher_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_reviews" ADD CONSTRAINT "agent_reviews_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "agent_listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_reviews" ADD CONSTRAINT "agent_reviews_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_installs" ADD CONSTRAINT "agent_installs_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "agent_listings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_installs" ADD CONSTRAINT "agent_installs_buyer_id_fkey" FOREIGN KEY ("buyer_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_subscriptions" ADD CONSTRAINT "agent_subscriptions_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "agent_listings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_subscriptions" ADD CONSTRAINT "agent_subscriptions_subscriber_id_fkey" FOREIGN KEY ("subscriber_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publisher_profiles" ADD CONSTRAINT "publisher_profiles_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_payouts" ADD CONSTRAINT "creator_payouts_publisher_id_fkey" FOREIGN KEY ("publisher_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_graphs" ADD CONSTRAINT "agent_graphs_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_rule_channels" ADD CONSTRAINT "alert_rule_channels_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "alert_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_rule_channels" ADD CONSTRAINT "alert_rule_channels_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "alert_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "alert_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "uptime_events" ADD CONSTRAINT "uptime_events_monitor_id_fkey" FOREIGN KEY ("monitor_id") REFERENCES "uptime_monitors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_fkey" FOREIGN KEY ("webhook_id") REFERENCES "webhooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_suite_id_fkey" FOREIGN KEY ("suite_id") REFERENCES "test_suites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_suite_id_fkey" FOREIGN KEY ("suite_id") REFERENCES "test_suites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_results" ADD CONSTRAINT "test_results_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "test_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_results" ADD CONSTRAINT "test_results_test_case_id_fkey" FOREIGN KEY ("test_case_id") REFERENCES "test_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_contexts" ADD CONSTRAINT "memory_contexts_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
