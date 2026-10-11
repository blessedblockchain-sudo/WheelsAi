# The local proof of the money paths

These scripts run every money path of WheelsAI against a Solana chain that lives on this machine only. Nothing here touches real money or a real network: the chain is a local test validator on loopback, the "USDC" is a stand-in mint made for it, and the keys are throwaways that are only ever used on that chain.

## What it covers

| Script | What it proves |
|---|---|
| `local-chain.sh` | starts, stops and reports on the local chain, with a stand-in USDC mint and throwaway keys (`make-accounts.py` writes the account files it loads) |
| `start-api.sh` | starts the API with every money rail on: against that chain with small limits for the walks, with the mainnet run's settings for its rehearsal (`--runbook`), or on devnet or mainnet for the runs themselves (`--run`) |
| `start-web.sh` | starts the built web app on port 3100, for the browser tests |
| `walk-sweeps.cjs` | sweeps from deposit addresses, proving the treasury, the operator's money report, a payout larger than the paying wallet holds, `set-plan.ts` |
| `walk-pay-in.cjs` | paying in from a wallet with USDC or SOL, a send that errors and still lands, one that never lands |
| `walk-pay-out.cjs` | payouts: the limits, a payout to a wallet that waits and is cancelled, payouts that are sent |
| `walk-deposits.cjs` | a deposit address: transfers from outside credited once, Prepare address |
| `walk-billing.cjs` | the Billing figures: what is held, spending by kind, the list, the export |
| `browser-pay-in.cjs`, `browser-pay-out.cjs`, `browser-deposits.cjs`, `browser-billing.cjs` | the same in a browser, with a test wallet and no extension |
| `walk-runbook.cjs` | the mainnet run of `docs/PAYMENTS-RUN.md`, rehearsed step for step from an empty database, with test wallets: the same order, amounts and settings, on the local chain with a stated price of SOL |
| `make-run-database.cjs` | makes the empty database a devnet or mainnet run keeps its records in; it never drops one |
| `run-all.sh` | the chain, the API and the five walks, in order; with `--runbook`, the rehearsal instead |
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

It starts a fresh chain, starts the API, runs the five walks in order, stops the API and prints one line for each walk. It stops at the first step that fails and says which one. It refuses to start when something it did not start already listens on port 4000 or 18899, and it never stops an API it did not start. A local chain from this folder that has stopped answering is stopped and replaced. The chain is left up at the end.

## Run one walk

```
bash apps/api/scripts/payments-proof/local-chain.sh start
bash apps/api/scripts/payments-proof/start-api.sh          # in a terminal of its own
node apps/api/scripts/payments-proof/walk-pay-in.cjs
```

`walk-pay-in.cjs --slow` adds two checks that wait for a blockhash to expire.

`walk-sweeps.cjs` needs a quiet chain, so it is run first, on a fresh one. It asks for a payout of $30, so its API allows $40 a payout where the other walks keep one to $20:

```
bash apps/api/scripts/payments-proof/local-chain.sh stop
bash apps/api/scripts/payments-proof/local-chain.sh start
node apps/api/scripts/payments-proof/walk-sweeps.cjs --prepare
PAYOUT_MAX_PER_PAYOUT_USD=40 bash apps/api/scripts/payments-proof/start-api.sh          # in a terminal of its own
node apps/api/scripts/payments-proof/walk-sweeps.cjs
```

For the other walks after it, restart the API with sweeps off, so balances stay where the walks expect them:

```
SWEEPS_ENABLED=false bash apps/api/scripts/payments-proof/start-api.sh
```

`WALK_API` names another address for the API (default `http://localhost:4000`).

## Rehearse the mainnet run

```
bash apps/api/scripts/payments-proof/run-all.sh --runbook
bash apps/api/scripts/payments-proof/run-all.sh --runbook 40 110 240 500 800
```

Each price of SOL given (in whole dollars; $110 when none is) gets a fresh chain and an empty database. Where swept SOL goes depends on its price, so the run is worth rehearsing at more than one.

For each price it runs `walk-runbook.cjs --prepare`, which makes the empty database `wheelsai_runbook` in the repository's Postgres container (an older one of that name is dropped) and applies the migrations; starts the API with `start-api.sh --runbook`; and runs `walk-runbook.cjs`. Then it starts the API again with both floats at 0 and runs `walk-runbook.cjs --after`: the paying wallet hands back what it holds.

What is the same as the run: the order of the steps and their numbers, the amounts, the workers the server runs, and the run's settings (a sweep from $1, floats of $5 in USDC and $10 in SOL, a paying wallet that works down to 0.01 SOL, the product's own payout limits, credits that can only be paid for). `start-api.sh` sets those in one place for `--runbook` and for `--run`. What is not: the chain is the local one, the price of SOL is stated, and the workers run every 3 seconds where the run's run every 15 and 30. The header of `walk-runbook.cjs` gives the steps for running it by hand.

## The runs on a real network

`docs/PAYMENTS-RUN.md` has the steps. Two things here serve them:

```
node apps/api/scripts/payments-proof/make-run-database.cjs wheelsai_devnet
RUN_DATABASE=wheelsai_devnet WALLET_MASTER_KEY_FILE=<a key file> bash apps/api/scripts/payments-proof/start-api.sh --run devnet
```

`make-run-database.cjs` makes a database of the run's own, applies the migrations and says whether it is empty. It never drops one. `start-api.sh --run devnet` or `--run mainnet-beta` starts the API on that network with the run's settings; it says what it still needs when something is missing, and starts nothing until then. On mainnet-beta it moves real money: it is started by the person doing the run.

A run's API has no Nosana access: the workers that watch and bill a GPU are off on it, so the Nosana account of `apps/api/.env` is left out and a model cannot be deployed. `WITH_NOSANA=1` in front of the command keeps the account and both workers, for a run that also deploys a model; that run can spend Nosana credits.

After `--runbook` or `--run <network>`, `-- <command>` runs an operator's command from `apps/api` with the same settings in place of the API:

```
bash apps/api/scripts/payments-proof/start-api.sh --run mainnet-beta -- npx tsx scripts/treasury-verify.ts
```

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
