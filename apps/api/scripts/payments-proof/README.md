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
| `walk-devnet-x402.cjs` | on devnet, with the founder's own wallet: one use of an agent paid from a wallet at its x402 door, by a caller with no account, then everything handed back to that wallet |
| `browser-run-start.cjs` | what a new person meets at the start of a run on a real network, before any wallet: signing up on an empty database and the Billing page, in a browser. It signs up an account, so it is run on a database other than the run's |
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

Before the person with the wallets arrives, the start of a run can be checked in a browser. The check signs up an account, so it has a database and a key of its own, and the run's database stays empty:

```
node apps/api/scripts/payments-proof/make-run-database.cjs wheelsai_check
RUN_DATABASE=wheelsai_check WALLET_MASTER_KEY="$(openssl rand -hex 32)" bash apps/api/scripts/payments-proof/start-api.sh --run devnet    # in a terminal of its own
node apps/api/scripts/payments-proof/browser-run-start.cjs <a folder> devnet
```

A run's API has no Nosana access: the workers that watch and bill a GPU are off on it, so the Nosana account of `apps/api/.env` is left out and a model cannot be deployed. `WITH_NOSANA=1` in front of the command keeps the account and both workers, for a run that also deploys a model; that run can spend Nosana credits.

After `--runbook` or `--run <network>`, `-- <command>` runs an operator's command from `apps/api` with the same settings in place of the API:

```
bash apps/api/scripts/payments-proof/start-api.sh --run mainnet-beta -- npx tsx scripts/treasury-verify.ts
```

## The x402 door on devnet, with your own wallet

`walk-devnet-x402.cjs` pays for one use of an agent from a Solana wallet on devnet, the way a caller with no account and an x402 client pays: a 402 with PAYMENT-REQUIRED, the payment signed by the payer only, the answer released once devnet confirms it. The payer is a wallet of yours; everything else is made by the walk.

What it needs:

- A keypair file of a devnet wallet (a JSON list of 64 numbers, as `solana-keygen new` writes it). It is read once, never written or copied, and only its address is printed.
- In that wallet, on devnet: about 0.03 SOL (https://faucet.solana.com, or `solana airdrop 1 <address> --url devnet`) and at least 0.20 USDC of the devnet mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (https://faucet.circle.com, Solana, Devnet). When either is short the walk says what to get and stops before it makes anything.
- Docker with the repository's Postgres and Redis, `openssl`, and ports 4010 and 4330 to 4332 free. Database 1 of Redis must be empty.

```
node apps/api/scripts/payments-proof/walk-devnet-x402.cjs <a folder> --payer <keypair.json>
```

`X402_PAYER_KEYPAIR=<keypair.json>` names the file in place of `--payer`. It refuses to run on anything but devnet. It makes its own empty database (`wheelsai_walk_x402_<time>`, left for reading afterwards), a master key and a treasury wallet in memory, a stand-in for Nosana on loopback so the agent answers with no GPU, and its own API on port 4010 with the door open (`start-api.sh --run devnet` with `X402_ENABLED=true`). Your wallet opens the treasury's USDC account and lends the door's fee payer 0.02 SOL. Then one paid use, and the same payment presented again, each checked against the chain and the database, `PASS` or `FAIL` and `N of N checks passed` at the end, with the transaction's link on the explorer.

At the end it stops its API, sends the fee payer's SOL and the treasury's USDC back to your wallet and closes the treasury's token account, so its rent comes back too. What your wallet spends is the network's fees of those few transactions, under 0.0001 SOL. Exit 0 when every check passed, 1 when one failed, 2 when the walk stopped, 3 when the wallet is not funded.

It takes about a minute once the containers are up: on the local test chain it ran in 55 seconds, the paid answer 1.2 seconds after the request. Keep the machine awake and the terminal open until it prints `N of N checks passed`. Ctrl+C still hands everything back. A restart of the machine, a closed lid that restarts it, or `kill -9` does not: the walk's treasury and fee payer exist only in that run, so up to about 0.022 devnet SOL (the 0.02 lent and the token account's rent) and 0.05 devnet USDC would stay where nobody can reach them.

The same walk runs on the local test chain with no wallet of yours, to see it work before devnet: start the chain with `local-chain.sh start`, then `node apps/api/scripts/payments-proof/walk-devnet-x402.cjs <a folder> --local-chain`. The payer is then made in memory and funded from the chain's own faucet and USDC mint, and the walk refuses any RPC that is not on this machine.

`start-api.sh --run devnet` opens the door only with `X402_ENABLED=true` and a `TREASURY_WALLET_ADDRESS`; it then also sends what it takes and runs the settlement worker. On `--run mainnet-beta` and `--runbook` the door stays off whatever is set.

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
