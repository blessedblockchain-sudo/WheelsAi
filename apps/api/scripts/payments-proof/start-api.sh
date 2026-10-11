#!/usr/bin/env bash
# Starts the API on 127.0.0.1:4000 with every money rail on (paying in from a
# wallet, deposit addresses, sweeps, payouts). It runs in the foreground:
# start it in a terminal of its own, or in the background with its output in a
# file. Three ways:
#
#   bash apps/api/scripts/payments-proof/start-api.sh
#       For the walks, on the local test chain, with small limits so the walks
#       can reach them.
#
#   bash apps/api/scripts/payments-proof/start-api.sh --runbook
#       For walk-runbook.cjs, the rehearsal of the mainnet run: on the local
#       test chain, on that walk's own empty database, with the run's settings.
#
#   bash apps/api/scripts/payments-proof/start-api.sh --run devnet
#   bash apps/api/scripts/payments-proof/start-api.sh --run mainnet-beta
#       For the runs of docs/PAYMENTS-RUN.md on a real network, with the same
#       settings as the rehearsal but for the chain, the price of SOL and how
#       often the workers run. On mainnet-beta this moves real money: it is
#       started by the person doing the run, and only then.
#
# THE LOCAL CHAIN (the first two ways). What must be running first:
#   - the local chain:  bash apps/api/scripts/payments-proof/local-chain.sh start
#   - the repository's Postgres and Redis (Docker), which the API reaches
#     through its usual settings
# For walk-sweeps.cjs, `node apps/api/scripts/payments-proof/walk-sweeps.cjs --prepare`
# must have run after the chain was started; for walk-runbook.cjs, its own
# --prepare. The wallet master key and the treasury's address are read from
# the chain's throwaway keys in $WHEELSAI_LOCAL_CHAIN_DIR/keys (default
# $HOME/.wheelsai/local-chain/keys). The price of SOL is stated ($110 unless
# SOL_PRICE_STATIC_USD says otherwise) and the workers run every 3 seconds.
# No real money and no real network.
#
# A REAL NETWORK (--run). It needs, in the environment it is started in:
#   DATABASE_URL             a database of its own, empty, with the migrations
#                            applied (never the local one: it holds test
#                            credits and test earnings). RUN_DATABASE=<name>
#                            in its place names a database made by
#                            make-run-database.cjs in the repository's Postgres.
#   WALLET_MASTER_KEY_FILE   a file holding the run's master key
#                            (openssl rand -hex 32), outside the repository
#   and on mainnet-beta:
#   SOLANA_RPC_URL           from a provider that serves transaction history
#   TREASURY_WALLET_ADDRESS  the cold wallet's address
#   PLATFORM_ADMIN_KEY       16 characters or more, to read the money report
# On devnet SOLANA_RPC_URL defaults to https://api.devnet.solana.com and the
# other two may be left out. The price of SOL is read from Pyth, deposits are
# scanned and swept every 30 seconds, payouts and top-ups looked at every 15.
# Redis is the usual one: no other WheelsAI API may be running against it.
#
# THE RUN'S SETTINGS (--runbook and --run): a sweep from $1, floats of $5 in
# USDC and $10 in SOL, a paying wallet that works down to 0.01 SOL, the
# product's own payout limits, and credits that can only be paid for.
#
# AN OPERATOR'S COMMAND WITH THE SAME SETTINGS. After --runbook or
# --run <network>, `-- <command>` runs that command from apps/api in place of
# the API, with the settings the API was started with: the same database, the
# same chain, the same keys. It is how the run proves its cold wallet:
#
#   bash apps/api/scripts/payments-proof/start-api.sh --run mainnet-beta -- npx tsx scripts/treasury-verify.ts
#
# In every way: a setting given on the command line wins over the value here,
# for those written below as ${NAME:-value}. For example, to leave balances
# where they are after walk-sweeps.cjs:
#
#   SWEEPS_ENABLED=false bash apps/api/scripts/payments-proof/start-api.sh
#
# Every background worker is off (its interval set to 0) unless it is one the
# money rails need or the person starting the server named its interval.
# Nothing secret is printed.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"
MODE="${1:-}"
USAGE="usage: $0 [--runbook | --run devnet | --run mainnet-beta] [-- command ...]"
case "$MODE" in
  ""|--runbook|--run) ;;
  *) echo "$USAGE" >&2; exit 2 ;;
esac
# `-- <command>`: an operator's command in place of the API, with its settings.
COMMAND=()
case "$MODE" in
  --run) REST=("${@:3}") ;;
  --runbook) REST=("${@:2}") ;;
  *) REST=("${@:1}") ;;
esac
if [ "${#REST[@]}" -gt 0 ]; then
  if [ "$MODE" = "" ] || [ "${REST[0]}" != "--" ] || [ "${#REST[@]}" -lt 2 ]; then echo "$USAGE" >&2; exit 2; fi
  COMMAND=("${REST[@]:1}")
fi

database_url() { node -e 'process.stdout.write(require(process.argv[1]).databaseUrl(process.argv[2]))' "$HERE/lib.cjs" "$1"; }

# What the mainnet run sets, here for the run and for its rehearsal alike.
run_settings() {
  export SWEEP_MIN_USD="${SWEEP_MIN_USD:-1}"
  export HOT_WALLET_FLOAT_USDC="${HOT_WALLET_FLOAT_USDC:-5}" HOT_WALLET_FLOAT_SOL_USD="${HOT_WALLET_FLOAT_SOL_USD:-10}"
  # A paying wallet that holds a tenth of a SOL in all keeps sweeping below
  # the product's usual 0.05 SOL.
  export HOT_WALLET_MIN_SOL="${HOT_WALLET_MIN_SOL:-0.01}"
  export PAYOUT_MAX_PER_PAYOUT_USD="${PAYOUT_MAX_PER_PAYOUT_USD:-500}" PAYOUT_MAX_PER_DAY_USD="${PAYOUT_MAX_PER_DAY_USD:-1000}"
  export DEPOSIT_ACCOUNT_OPENS_PER_DAY="${DEPOSIT_ACCOUNT_OPENS_PER_DAY:-25}"
  # Credits come from a payment and from nothing else.
  export ALLOW_MOCK_CHECKOUT=false X402_ENABLED=false
}

if [ "$MODE" = "--run" ]; then
  NETWORK="${2:-}"
  case "$NETWORK" in
    devnet|mainnet-beta) ;;
    *) echo "usage: $0 --run devnet | --run mainnet-beta" >&2; exit 2 ;;
  esac
  need() { [ -n "${!1:-}" ] || { echo "$1 is not set: $2" >&2; exit 1; }; }
  if [ -z "${DATABASE_URL:-}" ] && [ -n "${RUN_DATABASE:-}" ]; then
    case "$RUN_DATABASE" in
      wheelsai|wheelsai_scratch|wheelsai_runbook) echo "RUN_DATABASE=$RUN_DATABASE is a local test database: a run keeps its records in one of its own" >&2; exit 1 ;;
    esac
    export DATABASE_URL="$(database_url "$RUN_DATABASE")"
  fi
  need DATABASE_URL "the run keeps its records in a database of its own, empty, with the migrations applied (or RUN_DATABASE=<name>)"
  if [ -z "${WALLET_MASTER_KEY:-}" ]; then
    need WALLET_MASTER_KEY_FILE "the file that holds the run's master key (openssl rand -hex 32), kept outside the repository"
    [ -s "$WALLET_MASTER_KEY_FILE" ] || { echo "there is no key in the file WALLET_MASTER_KEY_FILE names" >&2; exit 1; }
    export WALLET_MASTER_KEY="$(tr -d '[:space:]' < "$WALLET_MASTER_KEY_FILE")"
  fi
  if [ "$NETWORK" = "mainnet-beta" ]; then
    need SOLANA_RPC_URL "a mainnet RPC address, from a provider that serves transaction history"
    need TREASURY_WALLET_ADDRESS "the cold wallet's address"
    need PLATFORM_ADMIN_KEY "the operator's key for the money report, 16 characters or more"
  else
    export SOLANA_RPC_URL="${SOLANA_RPC_URL:-https://api.devnet.solana.com}"
    export PLATFORM_ADMIN_KEY="${PLATFORM_ADMIN_KEY:-devnet-run-admin-key-0123456789}"
  fi
  export SOLANA_NETWORK="$NETWORK" NODE_ENV=development
  export SOL_PRICE_SOURCE="${SOL_PRICE_SOURCE:-pyth}"
  export TOPUP_RECONCILE_INTERVAL_MS="${TOPUP_RECONCILE_INTERVAL_MS:-15000}" PAYOUT_EXECUTOR_INTERVAL_MS="${PAYOUT_EXECUTOR_INTERVAL_MS:-15000}"
  export DEPOSIT_SCAN_INTERVAL_MS="${DEPOSIT_SCAN_INTERVAL_MS:-30000}" SWEEP_INTERVAL_MS="${SWEEP_INTERVAL_MS:-30000}"
  export WALLET_TOPUPS_ENABLED=true DEPOSITS_ENABLED=true PAYOUTS_ENABLED=true SWEEPS_ENABLED="${SWEEPS_ENABLED:-true}"
  run_settings
  [ "${#COMMAND[@]}" -gt 0 ] || echo "Starting the API for the payments run on $NETWORK (127.0.0.1:4000). Every money rail is on." >&2
else
  KEYS="${WHEELSAI_LOCAL_CHAIN_DIR:-$HOME/.wheelsai/local-chain}/keys"
  for f in master.key treasury.json; do
    [ -f "$KEYS/$f" ] || { echo "no $f in $KEYS: start the chain first (bash $HERE/local-chain.sh start)" >&2; exit 1; }
  done
  TREASURY="$(solana-keygen pubkey "$KEYS/treasury.json")"
  if [ "$MODE" = "--runbook" ]; then
    # The rehearsal of the mainnet run (walk-runbook.cjs): the empty database
    # its --prepare makes, and the run's settings in place of the walks' small
    # limits. Nothing about the database is printed.
    export DATABASE_URL="$(database_url wheelsai_runbook)"
    run_settings
  fi
  export WALLET_MASTER_KEY="$(cat "$KEYS/master.key")"
  export SOLANA_RPC_URL=http://127.0.0.1:18899 SOLANA_NETWORK=devnet NODE_ENV=development
  export SOL_PRICE_SOURCE="${SOL_PRICE_SOURCE:-static}" SOL_PRICE_STATIC_USD="${SOL_PRICE_STATIC_USD:-110}"
  export TOPUP_RECONCILE_INTERVAL_MS="${TOPUP_RECONCILE_INTERVAL_MS:-3000}" PAYOUT_EXECUTOR_INTERVAL_MS="${PAYOUT_EXECUTOR_INTERVAL_MS:-3000}"
  export DEPOSIT_SCAN_INTERVAL_MS="${DEPOSIT_SCAN_INTERVAL_MS:-3000}" SWEEP_INTERVAL_MS="${SWEEP_INTERVAL_MS:-3000}"
  export WALLET_TOPUPS_ENABLED=true DEPOSITS_ENABLED=true PAYOUTS_ENABLED=true SWEEPS_ENABLED="${SWEEPS_ENABLED:-true}"
  # The walks' own small limits, where the rehearsal has not set the run's.
  export PAYOUT_MAX_PER_PAYOUT_USD="${PAYOUT_MAX_PER_PAYOUT_USD:-20}" PAYOUT_MAX_PER_DAY_USD="${PAYOUT_MAX_PER_DAY_USD:-45}"
  export DEPOSIT_ACCOUNT_OPENS_PER_DAY="${DEPOSIT_ACCOUNT_OPENS_PER_DAY:-2}" SWEEP_MIN_USD="${SWEEP_MIN_USD:-5}"
  export HOT_WALLET_FLOAT_USDC="${HOT_WALLET_FLOAT_USDC:-20}" HOT_WALLET_FLOAT_SOL_USD="${HOT_WALLET_FLOAT_SOL_USD:-22}"
  export TREASURY_WALLET_ADDRESS="${TREASURY_WALLET_ADDRESS:-$TREASURY}" PLATFORM_ADMIN_KEY="${PLATFORM_ADMIN_KEY:-walk-pay6-admin-key-0123456789}"
fi

cd "$REPO/apps/api"
if [ "${#COMMAND[@]}" -gt 0 ]; then
  exec "${COMMAND[@]}"
fi
off=""
for v in $(grep -oE "^\s+[A-Z_]+_INTERVAL_MS\b" src/config/env.ts | tr -d ' ' | sort -u); do
  # A worker whose interval is set, above or by the person starting the
  # server, is passed through as given. Every other one is off.
  [ -n "${!v+x}" ] && continue
  off="$off $v=0"
done
exec env $off \
  X402_SETTLEMENT_WORKER_ENABLED="${X402_SETTLEMENT_WORKER_ENABLED:-false}" \
  API_HOST=127.0.0.1 API_PORT=4000 \
  CORS_ORIGIN=http://localhost:3100 \
  PUBLIC_API_URL=http://localhost:4000 \
  PUBLIC_WEB_URL=http://localhost:3100 \
  RATE_LIMIT_MAX_PER_MINUTE=1000 \
  npx tsx src/index.ts
