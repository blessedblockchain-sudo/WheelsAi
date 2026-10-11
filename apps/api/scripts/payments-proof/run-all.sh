#!/usr/bin/env bash
# The whole local proof of the money paths, in the order a person follows:
#
#   a. a fresh local chain              (local-chain.sh stop, then start)
#   b. node walk-sweeps.cjs --prepare   (resets what the deposit scan remembers)
#   c. the API, started in the background with start-api.sh (for walk-sweeps
#      with one payout allowed up to $40, which that walk needs)
#   d. walk-sweeps.cjs first, because it needs the quiet chain; then the API is
#      restarted with SWEEPS_ENABLED=false, so later balances stay where the
#      walks expect them; then walk-pay-in.cjs --slow, walk-pay-out.cjs,
#      walk-deposits.cjs and walk-billing.cjs
#   e. the API is stopped, the chain is left up, and one line is printed for
#      each walk: its name and its last line ("N of N checks passed")
#
#   bash apps/api/scripts/payments-proof/run-all.sh
#
# It stops at the first step that fails and says which one.
#
# With --runbook it runs the rehearsal of the mainnet run in place of the
# walks, once for each price of SOL given ($110 when none is): a fresh chain,
# walk-runbook.cjs --prepare (an empty database of its own), the API started
# with start-api.sh --runbook, then walk-runbook.cjs; then the API again with
# both floats at 0, and walk-runbook.cjs --after.
#
#   bash apps/api/scripts/payments-proof/run-all.sh --runbook
#   bash apps/api/scripts/payments-proof/run-all.sh --runbook 60 110 240 500
#
# What must be there first: the Solana command line tools (with
# solana-test-validator), Node, and Docker with the repository's Postgres and
# Redis running. Ports 4000 and 18899 must be free: this script refuses to
# start when something it did not start listens on either. It never stops an
# API it did not start. A local chain from this folder that is no longer
# answering is stopped and replaced, whoever started it. (It knows a listening
# chain is its own from the process number it wrote down in
# <chain folder>/run-all.chain.pid.)
#
# Everything it writes is in the chain's folder, $WHEELSAI_LOCAL_CHAIN_DIR,
# default $HOME/.wheelsai/local-chain: the API's output in api.log and each
# walk's output in results/<name>.log.
#
# The browser tests are not run here, because they need the web app built and
# started: the last lines printed say how to run them. No real money and no
# real network.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DIR="${WHEELSAI_LOCAL_CHAIN_DIR:-$HOME/.wheelsai/local-chain}"
export WHEELSAI_LOCAL_CHAIN_DIR="$DIR"
RESULTS="$DIR/results"
API_LOG="$DIR/api.log"
CHAIN_PID_FILE="$DIR/run-all.chain.pid"
HEALTH=http://127.0.0.1:4000/health
API_PID=""
RAN=()

RUNBOOK=0
if [ "${1:-}" = "--runbook" ]; then
  RUNBOOK=1
  shift
  [ "$#" -gt 0 ] || set -- 110
  for price in "$@"; do
    case "$price" in
      ''|*[!0-9]*) echo "a price of SOL is a whole number of dollars, and '$price' is not one" >&2; exit 2 ;;
    esac
  done
elif [ "$#" -gt 0 ]; then
  echo "usage: $0 [--runbook [price ...]]" >&2
  exit 2
fi

listening() { ss -ltn 2>/dev/null | grep -q ":$1 "; }
listener_pid() { ss -ltnp 2>/dev/null | grep ":$1 " | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1; }
# A process and everything it started, children first.
tree() {
  local child
  for child in $(pgrep -P "$1" 2>/dev/null); do tree "$child"; done
  echo "$1"
}

# Stops the API this script started, and nothing else.
stop_api() {
  [ -n "$API_PID" ] || return 0
  local pids pid left
  pids="$(tree "$API_PID")"
  API_PID=""
  kill $pids 2>/dev/null
  for _ in $(seq 1 20); do
    left=""
    for pid in $pids; do kill -0 "$pid" 2>/dev/null && left="$left $pid"; done
    [ -z "$left" ] && return 0
    sleep 1
  done
  kill -9 $left 2>/dev/null
  return 0
}

summary() {
  [ "${#RAN[@]}" -gt 0 ] || return 0
  echo
  echo "Results (each walk's output is in $RESULTS):"
  local name
  for name in "${RAN[@]}"; do
    printf '  %-26s %s\n' "$name" "$(tail -n 1 "$RESULTS/$name.log" 2>/dev/null)"
  done
}

fail() {
  echo >&2
  echo "FAILED at this step: $1" >&2
  summary
  exit 1
}

trap stop_api EXIT
trap 'exit 130' INT TERM

# Starts the API in the background (settings given as NAME=value; API_ARGS is
# passed to start-api.sh) and waits until it answers GET /health.
start_api() {
  ( exec env "$@" bash "$HERE/start-api.sh" ${API_ARGS:-} ) >> "$API_LOG" 2>&1 &
  API_PID=$!
  local p
  for _ in $(seq 1 120); do
    kill -0 "$API_PID" 2>/dev/null || { echo "the API stopped while starting; see $API_LOG" >&2; return 1; }
    if curl -sf -m 2 -o /dev/null "$HEALTH"; then
      p="$(listener_pid 4000)"
      if [ -n "$p" ] && tree "$API_PID" | grep -qx "$p"; then return 0; fi
      echo "something this script did not start answers on port 4000" >&2
      return 1
    fi
    sleep 1
  done
  echo "the API did not answer $HEALTH within two minutes; see $API_LOG" >&2
  return 1
}

run_walk() {
  local name="$1" code
  shift
  echo
  echo "== $name $*"
  RAN+=("$name")
  node "$HERE/$name.cjs" "$@" 2>&1 | tee "$RESULTS/$name.log"
  code="${PIPESTATUS[0]}"
  return "$code"
}

# ---- Before anything is started
for tool in solana-test-validator solana-keygen node npx docker curl ss pgrep openssl python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "this needs '$tool' on the PATH, and it was not found" >&2; exit 1; }
done
if listening 4000; then
  echo "something already listens on port 4000, and this script did not start it. Stop it yourself, then run this again." >&2
  exit 1
fi
if listening 18899; then
  p="$(listener_pid 18899)"
  if [ -n "$p" ] && [ -f "$CHAIN_PID_FILE" ] && [ "$p" = "$(cat "$CHAIN_PID_FILE")" ]; then
    echo "the chain an earlier run of this script left up (pid $p) will be replaced by a fresh one"
  else
    echo "something already listens on port 18899, and this script did not start it. Stop it yourself (for a local chain: bash $HERE/local-chain.sh stop), then run this again." >&2
    exit 1
  fi
fi
mkdir -p "$RESULTS" || exit 1
: > "$API_LOG"

fresh_chain() {
  bash "$HERE/local-chain.sh" stop
  for _ in $(seq 1 15); do listening 18899 || break; sleep 1; done
  listening 18899 && fail "stopping the earlier chain (local-chain.sh stop)"
  rm -f "$CHAIN_PID_FILE"
  bash "$HERE/local-chain.sh" start || fail "starting the chain (local-chain.sh start)"
  listener_pid 18899 > "$CHAIN_PID_FILE"
}

# ---- The rehearsal of the mainnet run, in place of the walks
if [ "$RUNBOOK" = "1" ]; then
  for price in "$@"; do
    echo
    echo "== the mainnet run, rehearsed with SOL at \$$price: a fresh chain and an empty database"
    fresh_chain
    node "$HERE/walk-runbook.cjs" --prepare || fail "walk-runbook.cjs --prepare (is the repository's Postgres running in Docker?)"
    API_ARGS="--runbook" start_api SOL_PRICE_STATIC_USD="$price" || fail "starting the API (start-api.sh --runbook)"
    RAN+=("walk-runbook-$price")
    SOL_PRICE_STATIC_USD="$price" node "$HERE/walk-runbook.cjs" 2>&1 | tee "$RESULTS/walk-runbook-$price.log"
    [ "${PIPESTATUS[0]}" = "0" ] || fail "walk-runbook.cjs with SOL at \$$price"
    stop_api
    for _ in $(seq 1 15); do listening 4000 || break; sleep 1; done

    echo
    echo "== afterwards: the API again with both floats at 0, so the paying wallet hands back what it holds"
    API_ARGS="--runbook" start_api SOL_PRICE_STATIC_USD="$price" HOT_WALLET_FLOAT_USDC=0 HOT_WALLET_FLOAT_SOL_USD=0 || fail "starting the API again with both floats at 0 (start-api.sh --runbook)"
    RAN+=("walk-runbook-$price-after")
    node "$HERE/walk-runbook.cjs" --after 2>&1 | tee "$RESULTS/walk-runbook-$price-after.log"
    [ "${PIPESTATUS[0]}" = "0" ] || fail "walk-runbook.cjs --after with SOL at \$$price"
    stop_api
    for _ in $(seq 1 15); do listening 4000 || break; sleep 1; done
  done
  summary
  echo
  echo "The rehearsal passed at every price given. The local chain is still up (bash $HERE/local-chain.sh stop ends it)."
  exit 0
fi

# ---- a. A fresh chain
echo "== a fresh local chain"
fresh_chain

# ---- b. What the deposit scan remembers, reset for the new chain
echo
echo "== walk-sweeps --prepare"
node "$HERE/walk-sweeps.cjs" --prepare || fail "walk-sweeps.cjs --prepare (is the repository's Postgres running in Docker?)"

# ---- c. The API
echo
echo "== the API (its output is in $API_LOG)"
# walk-sweeps asks for a payout of $30, more than the $20 float.
start_api PAYOUT_MAX_PER_PAYOUT_USD=40 || fail "starting the API (start-api.sh)"

# ---- d. The walks
run_walk walk-sweeps || fail "walk-sweeps.cjs"

echo
echo "== the API again, with sweeps off"
stop_api
for _ in $(seq 1 15); do listening 4000 || break; sleep 1; done
start_api SWEEPS_ENABLED=false || fail "starting the API again with SWEEPS_ENABLED=false (start-api.sh)"

run_walk walk-pay-in --slow || fail "walk-pay-in.cjs --slow"
run_walk walk-pay-out || fail "walk-pay-out.cjs"
run_walk walk-deposits || fail "walk-deposits.cjs"
run_walk walk-billing || fail "walk-billing.cjs"

# ---- e. The API is stopped; the chain stays up
stop_api
summary
echo
echo "Every walk passed. The local chain is still up (bash $HERE/local-chain.sh stop ends it)."
echo
echo "The browser tests are run by hand, with the chain up:"
echo "  1. build the web app, from apps/web:"
echo "       NEXT_PUBLIC_API_URL=http://localhost:4000 NEXT_PUBLIC_APP_URL=http://localhost:3100 NEXT_PUBLIC_SOLANA_RPC_URL=http://127.0.0.1:18899 npx next build"
echo "  2. bash $HERE/start-api.sh     (in a terminal of its own)"
echo "  3. bash $HERE/start-web.sh     (in a terminal of its own)"
echo "  4. node $HERE/browser-pay-in.cjs <a folder for screenshots>"
echo "     node $HERE/browser-pay-out.cjs <a folder for screenshots>"
echo "     node $HERE/browser-deposits.cjs <a folder for screenshots>"
echo "     node $HERE/browser-billing.cjs <a folder for screenshots>"
