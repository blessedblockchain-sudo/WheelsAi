#!/usr/bin/env bash
# Starts the built web app on port 3100, for the browser tests in this folder
# (browser-pay-in.cjs, browser-pay-out.cjs, browser-deposits.cjs,
# browser-billing.cjs). It runs in the foreground: start it in a terminal of
# its own, or in the background with its output in a file.
#
#   bash apps/api/scripts/payments-proof/start-web.sh
#
# The app must have been built first, from apps/web, with these three settings,
# so that the pages talk to the local API and the local chain:
#
#   NEXT_PUBLIC_API_URL=http://localhost:4000 \
#   NEXT_PUBLIC_APP_URL=http://localhost:3100 \
#   NEXT_PUBLIC_SOLANA_RPC_URL=http://127.0.0.1:18899 \
#   npx next build
#
# The API must be running too (start-api.sh). No real money and no real network.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"
cd "$REPO/apps/web"
exec npx next start -p 3100
