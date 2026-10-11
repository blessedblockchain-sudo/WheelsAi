#!/usr/bin/env bash
# A local Solana test chain on loopback that stands in for devnet: the same
# USDC mint address the API uses on devnet, with a mint authority made here.
# No real money and no real network.
#
#   bash apps/api/scripts/payments-proof/local-chain.sh start [sol price]
#        start it (ledger wiped). With a price, a Pyth price account
#        published "now" is loaded too.
#   bash apps/api/scripts/payments-proof/local-chain.sh stop
#   bash apps/api/scripts/payments-proof/local-chain.sh status
#
# Needs the Solana command line tools (solana-test-validator, solana-keygen),
# openssl, python3, curl and ss.
#
# RPC http://127.0.0.1:18899 (websocket 18900), faucet 19900.
#
# Everything the chain keeps lives in one folder outside the repository:
# $WHEELSAI_LOCAL_CHAIN_DIR, default $HOME/.wheelsai/local-chain.
#   <folder>/ledger   the chain itself, wiped at every start. It is kept to
#                     about two million shreds: roughly twenty minutes of
#                     history and a little over a gigabyte on disk. The test
#                     validator's own default keeps about a minute, too little
#                     for a scan that reads history; no limit at all grows by
#                     gigabytes an hour.
#   <folder>/keys     three throwaway keys, made on the first start and kept:
#                     master.key (stands in for WALLET_MASTER_KEY),
#                     mint-authority.json (mints the stand-in USDC) and
#                     treasury.json (the treasury the sweeps pay into)
# The keys are kept from one start to the next so that a restart does not
# change every derived address: the local database remembers addresses, and a
# new master key would strand them. These keys never hold real money: they are
# only ever used on this chain.
#
# The folder must be ON DISK. Under /tmp it would be memory on many machines,
# and a ledger there can fill it: a start under /tmp is refused, and so is one
# with less than 10 GB free.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"
DIR="${WHEELSAI_LOCAL_CHAIN_DIR:-$HOME/.wheelsai/local-chain}"
KEYS="$DIR/keys"
RPC=http://127.0.0.1:18899
PIDFILE="$DIR/validator.pid"
pid_of() { ss -ltnp 2>/dev/null | grep ':18899 ' | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1; }
# The validator this script started, whether or not it still answers: one that
# has stopped answering still holds its files open.
own_pid() {
  local p; p=$(cat "$PIDFILE" 2>/dev/null) || return 0
  [ -n "$p" ] && kill -0 "$p" 2>/dev/null && grep -q solana-test-validator "/proc/$p/cmdline" 2>/dev/null && echo "$p"
}
healthy() { curl -s -m 2 "$RPC" -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null | grep -q '"ok"'; }
case "${1:-}" in
  start)
    [ -n "$(pid_of)" ] && { echo "already running (pid $(pid_of))"; exit 0; }
    [ -n "$(own_pid)" ] && { echo "a validator from an earlier start (pid $(own_pid)) is alive and not answering: run '$0 stop' first" >&2; exit 1; }
    case "$DIR/" in /tmp/*) echo "the chain's folder must not be under /tmp (it is memory on many machines): $DIR" >&2; exit 1 ;; esac
    mkdir -p "$DIR" "$KEYS" || exit 1
    chmod 700 "$KEYS"
    DIR="$(cd "$DIR" && pwd -P)"; KEYS="$DIR/keys"
    case "$DIR/" in
      "$(cd "$REPO" && pwd -P)"/*)
        # Leave nothing behind in the repository (only folders still empty go).
        rmdir "$KEYS" "$DIR" 2>/dev/null
        echo "the chain's folder must not be inside the repository: $DIR" >&2; exit 1 ;;
    esac
    free_kb=$(df -Pk "$DIR" | awk 'NR==2 {print $4}')
    [ "${free_kb:-0}" -ge 10485760 ] || { echo "under 10 GB free where the chain's folder lives ($DIR): not starting" >&2; exit 1; }
    [ -f "$KEYS/master.key" ] || (umask 077; openssl rand -hex 32 > "$KEYS/master.key")
    [ -f "$KEYS/mint-authority.json" ] || solana-keygen new --no-bip39-passphrase --silent --force -o "$KEYS/mint-authority.json" >/dev/null 2>&1
    [ -f "$KEYS/treasury.json" ] || solana-keygen new --no-bip39-passphrase --silent --force -o "$KEYS/treasury.json" >/dev/null 2>&1
    cd "$DIR"
    AUTH=$(solana-keygen pubkey "$KEYS/mint-authority.json")
    rm -f sol-price.json
    python3 -I "$HERE/make-accounts.py" "$DIR" "$AUTH" ${2:+"$2"} || exit 1
    extra=()
    [ -f sol-price.json ] && extra=(--account 7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE "$DIR/sol-price.json")
    nohup solana-test-validator --ledger "$DIR/ledger" --reset --quiet --bind-address 127.0.0.1 \
      --limit-ledger-size 2000000 \
      --rpc-port 18899 --faucet-port 19900 --gossip-port 18001 --dynamic-port-range 18010-18040 \
      --account 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU "$DIR/usdc-mint.json" "${extra[@]}" \
      > "$DIR/validator.log" 2>&1 &
    echo $! > "$PIDFILE"
    for _ in $(seq 1 30); do healthy && break; sleep 1; done
    healthy && echo "chain up: $RPC  (keys in $KEYS)" || { echo "chain did not come up; see $DIR/validator.log"; exit 1; }
    ;;
  stop)
    # The one this script started, even when it no longer answers.
    p=$(own_pid); [ -z "$p" ] && p=$(pid_of)
    if [ -n "$p" ]; then
      kill "$p" 2>/dev/null
      for _ in $(seq 1 15); do kill -0 "$p" 2>/dev/null || break; sleep 1; done
      kill -0 "$p" 2>/dev/null && kill -9 "$p" 2>/dev/null
      rm -f "$PIDFILE"; echo "stopped pid $p"
    else
      echo "not running"
    fi
    ;;
  status)
    p=$(pid_of)
    if [ -n "$p" ]; then
      echo "running pid $p, healthy: $(healthy && echo yes || echo no), ledger $(du -sh "$DIR/ledger" 2>/dev/null | cut -f1)"
    elif [ -n "$(own_pid)" ]; then
      echo "pid $(own_pid) is alive and NOT answering: run '$0 stop'"
    else
      echo "not running"
    fi
    ;;
  *) echo "usage: $0 start [sol price]|stop|status" >&2; exit 2 ;;
esac
