#!/usr/bin/env bash
# Starts the API on 127.0.0.1:4000 against the local test chain, with every
# money rail on (paying in from a wallet, deposit addresses, payouts, sweeps)
# and small limits, the way the scripts in this folder need it. It runs in the
# foreground: start it in a terminal of its own, or in the background with its
# output in a file.
#
#   bash apps/api/scripts/payments-proof/start-api.sh
#   bash apps/api/scripts/payments-proof/start-api.sh > api.log 2>&1 &
#
# What must be running first:
#   - the local chain:  bash apps/api/scripts/payments-proof/local-chain.sh start
#   - the repository's Postgres and Redis (Docker), which the API reaches
#     through its usual settings
# For walk-sweeps.cjs, `node apps/api/scripts/payments-proof/walk-sweeps.cjs --prepare`
# must have run after the chain was started.
#
# The wallet master key and the treasury's address are read from the chain's
# throwaway keys in $WHEELSAI_LOCAL_CHAIN_DIR/keys (default
# $HOME/.wheelsai/local-chain/keys). Nothing secret is printed.
#
# A setting given on the command line wins over the value here, for those
# written below as ${NAME:-value}. For example, to leave balances where they
# are after walk-sweeps.cjs:
#
#   SWEEPS_ENABLED=false bash apps/api/scripts/payments-proof/start-api.sh
#
# Every background worker is off (its interval set to 0) unless it is one the
# proof needs or the person starting the server named its interval. The
# scheduler is left on its default tick. No real money and no real network.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"
KEYS="${WHEELSAI_LOCAL_CHAIN_DIR:-$HOME/.wheelsai/local-chain}/keys"
for f in master.key treasury.json; do
  [ -f "$KEYS/$f" ] || { echo "no $f in $KEYS: start the chain first (bash $HERE/local-chain.sh start)" >&2; exit 1; }
done
TREASURY="$(solana-keygen pubkey "$KEYS/treasury.json")"
export WALLET_MASTER_KEY="$(cat "$KEYS/master.key")"
export SOLANA_RPC_URL=http://127.0.0.1:18899 SOLANA_NETWORK=devnet NODE_ENV=development
export WALLET_TOPUPS_ENABLED=true SOL_PRICE_SOURCE="${SOL_PRICE_SOURCE:-static}" SOL_PRICE_STATIC_USD="${SOL_PRICE_STATIC_USD:-110}"
export TOPUP_RECONCILE_INTERVAL_MS="${TOPUP_RECONCILE_INTERVAL_MS:-3000}"
export PAYOUTS_ENABLED=true PAYOUT_EXECUTOR_INTERVAL_MS="${PAYOUT_EXECUTOR_INTERVAL_MS:-3000}"
export PAYOUT_MAX_PER_PAYOUT_USD="${PAYOUT_MAX_PER_PAYOUT_USD:-20}" PAYOUT_MAX_PER_DAY_USD="${PAYOUT_MAX_PER_DAY_USD:-45}"
export DEPOSITS_ENABLED=true DEPOSIT_SCAN_INTERVAL_MS="${DEPOSIT_SCAN_INTERVAL_MS:-3000}" DEPOSIT_ACCOUNT_OPENS_PER_DAY="${DEPOSIT_ACCOUNT_OPENS_PER_DAY:-2}"
export SWEEPS_ENABLED="${SWEEPS_ENABLED:-true}" SWEEP_INTERVAL_MS="${SWEEP_INTERVAL_MS:-3000}" SWEEP_MIN_USD="${SWEEP_MIN_USD:-5}"
export HOT_WALLET_FLOAT_USDC="${HOT_WALLET_FLOAT_USDC:-20}" HOT_WALLET_FLOAT_SOL_USD="${HOT_WALLET_FLOAT_SOL_USD:-22}"
export TREASURY_WALLET_ADDRESS="${TREASURY_WALLET_ADDRESS:-$TREASURY}" PLATFORM_ADMIN_KEY="${PLATFORM_ADMIN_KEY:-walk-pay6-admin-key-0123456789}"
export WITH_SCHEDULER=1 NOSANA_MIN_CREDITS_USD="${NOSANA_MIN_CREDITS_USD:-1}"

cd "$REPO/apps/api"
off=""
for v in $(grep -oE "^\s+[A-Z_]+_INTERVAL_MS\b" src/config/env.ts | tr -d ' ' | sort -u); do
  [ "$v" = "DEPLOYMENT_STATUS_INTERVAL_MS" ] && continue
  # WITH_SCHEDULER=1 leaves the scheduler on its default tick, so timed
  # agent runs fire.
  [ "$v" = "SCHEDULER_INTERVAL_MS" ] && [ "${WITH_SCHEDULER:-0}" = "1" ] && continue
  # A worker the person starting the server asked for by name stays on:
  # an interval given on the command line is passed through as given. The
  # intervals exported above are kept the same way.
  [ -n "${!v+x}" ] && continue
  off="$off $v=0"
done
exec env $off \
  DEPLOYMENT_STATUS_INTERVAL_MS=10000 \
  GPU_BILLING_INTERVAL_MS=60000 \
  X402_SETTLEMENT_WORKER_ENABLED="${X402_SETTLEMENT_WORKER_ENABLED:-false}" PAYOUTS_ENABLED="${PAYOUTS_ENABLED:-false}" \
  API_HOST=127.0.0.1 API_PORT=4000 \
  CORS_ORIGIN=http://localhost:3100 \
  PUBLIC_API_URL=http://localhost:4000 \
  PUBLIC_WEB_URL=http://localhost:3100 \
  RATE_LIMIT_MAX_PER_MINUTE=1000 \
  NOSANA_MIN_CREDITS_USD="${NOSANA_MIN_CREDITS_USD:-5}" \
  npx tsx src/index.ts
