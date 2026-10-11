# The local proof of the money paths

These scripts run every money path of WheelsAI against a Solana chain that lives on this machine only. Nothing here touches real money or a real network: the chain is a local test validator on loopback, the "USDC" is a stand-in mint made for it, and the keys are throwaways that are only ever used on that chain.

## What it covers

| Script | What it proves |
|---|---|
| `local-chain.sh` | starts, stops and reports on the local chain, with a stand-in USDC mint and throwaway keys (`make-accounts.py` writes the account files it loads) |
| `start-api.sh` | starts the API against that chain, with every money rail on and small limits |
| `start-web.sh` | starts the built web app on port 3100, for the browser tests |
| `walk-sweeps.cjs` | sweeps from deposit addresses, proving the treasury, the operator's money report, `set-plan.ts` |
| `walk-pay-in.cjs` | paying in from a wallet with USDC or SOL, a send that errors and still lands, one that never lands |
| `walk-pay-out.cjs` | payouts: the limits, a payout to a wallet that waits and is cancelled, payouts that are sent |
| `walk-deposits.cjs` | a deposit address: transfers from outside credited once, Prepare address |
| `walk-billing.cjs` | the Billing figures: what is held, spending by kind, the list, the export |
| `browser-pay-in.cjs`, `browser-pay-out.cjs`, `browser-deposits.cjs`, `browser-billing.cjs` | the same in a browser, with a test wallet and no extension |
| `run-all.sh` | the chain, the API and the five walks, in order |
| `lib.cjs` | what the scripts share: where the repository and the keys are, the database, the browser |

Each walk prints `PASS` or `FAIL` for every check and ends with `N of N checks passed`. It exits with 0 only when every check passed.

## What must be installed

- The Solana command line tools, with `solana-test-validator` and `solana-keygen` on the PATH.
- Docker, with the repository's Postgres and Redis running. The scripts reach the database with `docker exec` in the container named `wheelsai-postgres` (set `WHEELSAI_PG_CONTAINER` for another name).
- Node, with the repository's packages installed.
- `openssl`, `python3`, `curl`, `ss` and `pgrep`.

The API reads its other settings (the database, Redis) the way it always does.

## Where the chain keeps its files

In one folder outside the repository: `$WHEELSAI_LOCAL_CHAIN_DIR`, default `$HOME/.wheelsai/local-chain`.

- `keys/` holds `master.key`, `mint-authority.json` and `treasury.json`. They are made on the first start and kept, so that addresses stay the same from one start to the next.
- `ledger/` is the chain itself, wiped at every start. It is kept to a little over a gigabyte. The folder must be on disk: `local-chain.sh` refuses to start under `/tmp`, which is memory on many machines, or with less than 10 GB free.
- `api.log` and `results/` are written by `run-all.sh`.

## Run everything

```
bash apps/api/scripts/payments-proof/run-all.sh
```

It starts a fresh chain, starts the API, runs the five walks in order, stops the API and prints one line for each walk. It stops at the first step that fails and says which one. It refuses to start when something it did not start already listens on port 4000 or 18899, and it never stops a process it did not start. The chain is left up at the end.

## Run one walk

```
bash apps/api/scripts/payments-proof/local-chain.sh start
bash apps/api/scripts/payments-proof/start-api.sh          # in a terminal of its own
node apps/api/scripts/payments-proof/walk-pay-in.cjs
```

`walk-pay-in.cjs --slow` adds two checks that wait for a blockhash to expire.

`walk-sweeps.cjs` needs a quiet chain, so it is run first, on a fresh one:

```
bash apps/api/scripts/payments-proof/local-chain.sh stop
bash apps/api/scripts/payments-proof/local-chain.sh start
node apps/api/scripts/payments-proof/walk-sweeps.cjs --prepare
bash apps/api/scripts/payments-proof/start-api.sh          # in a terminal of its own
node apps/api/scripts/payments-proof/walk-sweeps.cjs
```

For the other walks after it, restart the API with sweeps off, so balances stay where the walks expect them:

```
SWEEPS_ENABLED=false bash apps/api/scripts/payments-proof/start-api.sh
```

`WALK_API` names another address for the API (default `http://localhost:4000`).

## Run the browser tests

Build the web app once, from `apps/web`, so that its pages talk to the local API and the local chain:

```
NEXT_PUBLIC_API_URL=http://localhost:4000 NEXT_PUBLIC_APP_URL=http://localhost:3100 NEXT_PUBLIC_SOLANA_RPC_URL=http://127.0.0.1:18899 npx next build
```

Then, with the chain up, each in a terminal of its own:

```
bash apps/api/scripts/payments-proof/start-api.sh
bash apps/api/scripts/payments-proof/start-web.sh
```

And the tests, each with a folder for its screenshots:

```
node apps/api/scripts/payments-proof/browser-pay-in.cjs /tmp/shots-pay-in
node apps/api/scripts/payments-proof/browser-pay-out.cjs /tmp/shots-pay-out
node apps/api/scripts/payments-proof/browser-deposits.cjs /tmp/shots-deposits
node apps/api/scripts/payments-proof/walk-billing.cjs
node apps/api/scripts/payments-proof/browser-billing.cjs /tmp/shots-billing
```

`browser-billing.cjs` signs in as the organization `walk-billing.cjs` leaves behind, so that walk is run first.

The browser is the one `playwright-core` finds among the browsers it has downloaded before. These scripts do not download one: when it finds none the test stops with playwright's own message. Set `WHEELSAI_CHROME` to the path of a Chrome or Chromium to use that one instead. `WALK_WEB` and `WALK_API` name other addresses for the web app and the API.
