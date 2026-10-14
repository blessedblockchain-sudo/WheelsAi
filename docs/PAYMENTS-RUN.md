# Payments: proof run on a local chain

**Date:** 2026-10-11
**Code:** `481acc7`, branch `feat/bags-launchpad`. The five walks, the four browser tests and the
rehearsal were run on it, after the changes three readings of the mainnet run asked for (listed under
"What the review changed"). The x402 proof was run on `496c7b7`; nothing it runs has changed since.
**Verdict:** every money path of the payments module was run on a local Solana chain, through the real
API, and checked against the database and the chain: **133 checks in five walks, 45 checks in four
browser tests, and the 10 steps of the x402 proof. All passed.** The mainnet run at the end of this
document was then rehearsed on the same chain, step for step from an empty database, at five prices of
SOL: **34 checks, and 3 more for handing the float back, at each price. All passed.** No real money and
no real network were involved.

**What this run is not:** it is not devnet with real wallets, and it is not mainnet. Neither has been run.
What each needs from the founder is at the end of this document.

## What ran

Everything is in `apps/api/scripts/payments-proof/` (its `README.md` says how to run it) and
`apps/api/scripts/x402-devnet-proof.ts`.

- **The chain.** `solana-test-validator` 3.1.8 on loopback (`local-chain.sh`). It is started empty, with
  one account loaded: a USDC mint at the address the API uses for devnet, whose mint authority is a
  throwaway key made on the machine. The API therefore runs its ordinary devnet code path, with stand-in
  USDC that costs nothing.
- **The API.** The real server (`start-api.sh`), with every money rail on and small limits so the walks
  can reach them: payouts at most $20 each and $45 a day ($40 each for the sweeps walk), floats of $20 in
  USDC and $22 in SOL, a sweep threshold of $5, two opened accounts a day, and every money worker
  running every 3 seconds.
- **The price of SOL** was stated ($110, `SOL_PRICE_SOURCE=static`), which the API refuses in
  production and on mainnet. The live read of Pyth's price account is the same code with another
  source; it was checked on its own, reading only, against devnet and mainnet on 2026-10-10.
- **The keys** are throwaway keys kept outside the repository. They are only ever used on this chain.

| Script | What it proves | Checks |
| --- | --- | --- |
| `walk-sweeps.cjs` | sweeps to the paying wallet and to a proven treasury, the treasury proof, the money report, a payout larger than the paying wallet holds, set-plan | 26 of 26 |
| `walk-pay-in.cjs --slow` | paying in from a wallet, in USDC and in SOL | 25 of 25 |
| `walk-pay-out.cjs` | creator payouts in USDC, SOL and credits | 30 of 30 |
| `walk-deposits.cjs` | a deposit address: transfers from outside, credited once | 33 of 33 |
| `walk-billing.cjs` | the Billing figures: held, spending by kind, the list, the export | 19 of 19 |
| `browser-pay-in.cjs` | paying in through the Billing page with a test wallet | 14 of 14 |
| `browser-pay-out.cjs` | taking earnings out through the Earnings page | 9 of 9 |
| `browser-deposits.cjs` | the deposit address panel | 11 of 11 |
| `browser-billing.cjs` | the Billing page's tiles, spending, history and Export | 11 of 11 |
| `x402-devnet-proof.ts` | one request paid by an on-chain transfer, in USDC and in SOL | 10 of 10 steps |
| `walk-runbook.cjs` | the mainnet run below, in its order and with its amounts and settings, from an empty database | 34 of 34, and 3 of 3 afterwards, at each of $40, $110, $240, $500 and $800 |

The walks were run by `run-all.sh` in one go, on a chain started for the run. The browser tests were run
after the rehearsal, on a chain started for them; the x402 proof was run with the first proof of the day.
The browser tests sign with a wallet the test itself registers through the Wallet Standard: no browser
extension is involved. The rehearsal was run by
`run-all.sh --runbook 40 110 240 500 800`: for each price of SOL a new chain, an empty database with
every migration applied, and the API started with the settings the mainnet run uses.

## What it showed

**Paying in.** An account made with an email and no wallet pays from whichever wallet it connects.
$10 in USDC arrived as 10 USDC on the chain and $10.00 in credits with one ledger row; $50 was credited
as $55.00 with its bonus. A SOL payment was priced from the quote in whole lamports, rounded up, and
exactly that many lamports arrived. A transfer with the wallet's own fee setting added was accepted; one
with any other instruction added was refused and not sent. The two cases the plan named:

- **The send errored and the transfer had landed:** it was credited, once, and the same signed bytes
  again credited nothing more.
- **It never landed:** a transfer sent after its blockhash expired ended as expired because the chain
  said so, with nothing credited. A top-up that was never signed ran out of time and said so.

**Paying out.** The minimum is $5.00 and the limits come with the earnings. Every refusal (below the
minimum, above a limit, above what is owed, no address, a program's or a token account's address, the
platform's own wallet) reserved nothing. With the paying wallet empty a payout waited, said so, and was
cancelled with its $10.00 put back. With the wallet filled, exactly 10 USDC arrived at a wallet that had
no USDC account, and a SOL payout arrived as the quoted lamports, rounded down. The day's limit refused
what passed it. A payout taken as credits is recorded as a payout, not a purchase. At the end the
creator's ledger added up to what they were owed, no payout was left open, and the paying wallet had paid
out exactly the 25 USDC the payouts said.

**A deposit address.** 50 USDC sent straight to an organization's address, with no prepared top-up and no
browser wallet, was credited by the worker as $50.00 and a $5.00 bonus with one receipt. 0.5 SOL was
credited at the price, with the price written down. An amount that is not whole cents was rounded down.
One transaction carrying both assets made two receipts. A transfer worth under a cent was recorded and
credited nothing. A prepared top-up the customer broadcast themselves, and one the older code had marked
failed, were each credited once through their top-up; a top-up submitted the ordinary way was not credited
again when the scan saw its transfer. "Prepare address" opened the USDC account from the paying wallet for
an account with a verified email, refused one without, refused while the paying wallet was low, and
refused past the day's limit, each time in a sentence and with nothing spent.

**Sweeps and the treasury.** 30 USDC at an address was swept whole to the paying wallet while that was
under its float, and the customer kept their credits. At the float, with no proven treasury, 12 USDC
stayed where it was. `treasury-verify.ts` found nothing before the proof transfer, found it on a dry run
without writing, then recorded the treasury as proven; the 12 USDC then went to the treasury. 0.5 SOL was
swept less what an empty account must keep and its own fee. Holding more than twice a float, the paying
wallet sent the excess on and kept the float, in SOL and in USDC. 3 USDC, under the threshold, was
credited and left at its address. A payout of $30, more than the 20 USDC the paying wallet held, waited;
the next deposit of 15 USDC then went to the paying wallet although it held its float, because an open
payout needed it, and the payout was sent with nobody refilling the wallet.

**The money report.** `GET /api/platform/money` was refused without the operator's key. With it, it showed
the paying wallet, the proven treasury and the transfers that landed, and its reconciliation did not move
by a unit across everything the walk did: what the deposit addresses hold is explained by what was
received less what was swept. It carried no key and no signed bytes.

**The Billing figures.** A new organization holds nothing. After a real deposit and a month of ledger rows
written the way the product leaves them, the balance said what is available, what is held and both
together; the hold was named with why; the month's spending by kind was the sum of the ledger's own rows;
GPU hours were the measured seconds; a job counted as spent only once its work was accepted. The list
paged without repeating or skipping a row, the filters answered what they say, and Export produced the
month as a file in which a cell a spreadsheet would run was made harmless. Another organization saw only
its own.

**x402.** A request with no payment was answered 402 and named the token account to pay. A payment by
checked USDC transfer was accepted and the request served; a SOL payment at the quoted rate was accepted
and served; the same signed transaction a second time was answered 409; a paid request whose node failed
had its payment returned to the organization's credit carry for exactly what was sent. The settlement
worker's own function settled the served payments and left none unsettled, and the chain showed each
payment moved exactly what was sent to the treasury.

**The mainnet run, rehearsed.** From an empty database and a chain with nothing on it, the steps of the
mainnet run were followed in order, with test wallets in place of a person's. The cold wallet proved
itself with 0.1 SOL. An account made with an email paid $10 in USDC and $10 in SOL from a wallet that
held exactly what the document says it needs. A second sender, standing in for an exchange, sent 2 USDC
and $2 of SOL straight to the deposit address. The 10 USDC was swept to the paying wallet, and the 2 USDC
that came after it, with the paying wallet at its float, to the cold wallet. A second account published a
listing at $12 a month through the product and the first subscribed to it: $12.00 left its credits, the
creator was owed $10.80 with one row in their ledger, and the platform kept $1.20. The creator took $5.00
in USDC and $5.00 in SOL to a wallet that had never held anything, and $0.80 stayed, under the smallest
payout. At the end both reconciliation differences were 0, nothing was left open, and every USDC and
every lamport that came in was at the second wallet, in the paying wallet, in the cold wallet, kept by the
address, in a USDC account the paying wallet had opened, or paid to the network as fees. Started again
with both floats at 0, the paying wallet sent its 5 USDC and its SOL to the cold wallet and kept exactly
0.01 SOL.

Where swept SOL goes depends on its price, which is why the rehearsal was run at five. At $40 the paying
wallet's 0.1 SOL is worth less than its $10 float, so the first SOL swept went to it. At $110 it holds
its float and the SOL went to the cold wallet. At $240, $500 and $800 it held more than twice its float,
first sent the excess back, and then took the SOL it was short of. The run completed at every price.

**In every walk:** no answer carried the chain's or the database's own words, and every refusal carried a
code and a sentence.

## What this run does not prove

- **Real wallets.** Phantom and Solflare add their own instructions to a transfer. The top-up accepts a
  fee setting and the wallet's guard instruction, and that was proven with a script that imitates them,
  not with the wallets. This is the gate before mainnet.
- **The live SOL price inside a payment.** The price was stated. The live read was checked separately.
- **A real RPC provider.** The deposit scan reads transaction history. A provider that does not serve
  history, or serves it late, or limits how often it may be asked, is not something a local chain can
  show.
- **How long things take.** On the local chain a block is final in seconds and the workers run every 3
  seconds. The waits the mainnet run names are from the settings, not from a clock.
- **A busy network.** The server's own transfers (sweeps, payouts) carry no priority fee. One that does
  not land is sent again, and signed again only once the chain shows the first can no longer land; how
  often that happens on a busy day is not something a local chain can show.
- **Mainnet.**

## What the review changed

Before real money follows it, the mainnet run was read against the code by five reviewers, each for what
a local chain cannot show. The changes that came of it were read again, twice, by other readers, and what
they found was fixed too. What changed:

- **A payment from a wallet is sent again until the chain says what became of it.** Before, once a node
  had taken a customer's transfer it was never sent again, so one a node dropped ended as "never landed"
  and had to be paid again.
- **The wait for a payment's confirmation asks the node; it does not subscribe.** A subscription needs a
  WebSocket, which not every RPC plan serves. Without one every payment would have held for 30 seconds.
- **The deposit scan ends a read of history when it sees the cursor itself.** Before, a page shorter
  than was asked for ended it, so a provider that hands back fewer signatures than the limit, or a node
  that answers with nothing because it has not caught up, could hide a transfer. When the cursor is not
  seen, what was found is believed only if its oldest transaction starts from the balance the last read
  left: nothing that arrived can then lie unread between them. Otherwise nothing changes for that
  address until a later run can read it all.
- **A long history is worked through a run at a time.** The scan used to change nothing for an address
  with more than 20 pages of unread history and wait for an operator, and the chain lists every
  transaction that names an address: about 0.1 SOL of fees was enough to stop one organization's
  deposits being credited. A run now takes the oldest 2,000 transactions it finds and the next run goes
  on from there.
- **Sweeps read the paying wallet at two levels.** What is on its way to or from it is counted from
  what is final, so nothing is counted twice, and a payout that has just left it is counted as gone.
  What it may send on is worked out from the lower of what is confirmed and what is final, so never
  from money a payout has just taken. The rehearsal found the second half: read at one level only, the
  wallet was asked to hand back money a payout had taken seconds before.
- **The paying wallet keeps its minimum of SOL after every fee it pays in one run,** not only its own.
- **Deposits fill the paying wallet to its float and what payouts waiting to be sent need,** and what
  it sends on leaves what every open payout needs: for USDC and SOL together, never more than a day's
  payout limit. A payout larger than the float is paid from the deposits that come next, with nobody
  refilling the wallet.
- **Credits granted without a payment are refused on mainnet,** in development as well. They could have
  been paid out in real money.
- **The proof command says "run this again" when a transaction could not be loaded,** where it used to
  ask for another 0.1 SOL.
- **The API's log says what a wallet added to a transfer,** and which program an instruction it refused
  belonged to. It is what the devnet step reads.
- **The run pays in pack amounts.** The Billing page offers $10 at the least, so the run's payments are
  $10 where they were first written as $5.

## Running it again

```bash
bash apps/api/scripts/payments-proof/run-all.sh
```

It needs the Solana command line tools, Node, and Docker with the repository's Postgres and Redis
running, and ports 4000 and 18899 free. It takes about half an hour, most of it waiting for blocks to
become final. The chain's folder must be on disk (the script refuses `/tmp`); the ledger stays at a few
gigabytes. The browser tests and the x402 proof are run after it: `README.md` in that folder and the
header of `x402-devnet-proof.ts` say how.

The rehearsal of the mainnet run is its own command, about seven minutes for each price:

```bash
bash apps/api/scripts/payments-proof/run-all.sh --runbook 40 110 240 500 800
```

## Devnet, with real wallets: what it needs

This is done by a person at a browser. It costs nothing. It is the gate before mainnet: it shows that
the transfer each real wallet signs is one the server accepts.

1. Set Phantom and Solflare to devnet. Use the browser extensions: Solflare's web wallet, opened without
   the extension, is a mainnet wallet. Get devnet SOL from Solana's faucet into each, and devnet USDC
   from Circle's faucet (Solana, devnet): 10 into each, and 1 more into either for step 4.
2. Make a database for the run, make a key for devnet only, and start the API and the web app. No other
   WheelsAI API may be running: it would share the port and the queues.

   ```bash
   node apps/api/scripts/payments-proof/make-run-database.cjs wheelsai_devnet
   openssl rand -hex 32 > ~/wheelsai-devnet-master.key
   RUN_DATABASE=wheelsai_devnet WALLET_MASTER_KEY_FILE=~/wheelsai-devnet-master.key \
     bash apps/api/scripts/payments-proof/start-api.sh --run devnet
   bash apps/api/scripts/payments-proof/start-web.sh        # in another terminal; the app is on port 3100
   ```

   The database is its own because the local proof records its rows as devnet: an address the local
   chain's key made is not one this key makes, and the API refuses it. The web app needs no setting for
   this: the page asks the wallet to sign and the API sends the transfer.
3. Sign up with an email. On the Billing page take the $10 pack and press "Pay with Wallet": pay $10 in
   USDC with Phantom, then $10 in USDC with Solflare. Each must end as "Added $10.00 in credits."
   **This is the step that matters.** The API's log says what each wallet handed back: "signed top-up
   accepted", as prepared or with the programs of what the wallet added; or "signed top-up not
   accepted" with the reason and, for an instruction it may not add, its program. Nothing is sent of a
   transfer that is not accepted.
4. Press "Show my deposit address", send 1 USDC to it from either wallet, and see it credited within a
   few minutes ("Check now" asks at once).
5. Optional: go on through steps 6 and 7 of the mainnet run, with a listing at $6 a month. Send 0.05
   devnet SOL to the paying wallet first, so that it can pay fees: its address is
   `onChain.hotWallet.address` in the money report. On a devnet run the report's key is
   `devnet-run-admin-key-0123456789` unless `PLATFORM_ADMIN_KEY` was set:

   ```bash
   curl -s -H "x-admin-key: devnet-run-admin-key-0123456789" http://localhost:4000/api/platform/money
   ```

Checked on 2026-10-11, before any wallet. The run's API was started on devnet on its own empty
database. Its money report read the chain (the paying wallet and no deposit address, every figure zero)
and a Pyth price that was 5 to 22 seconds old on four readings. `browser-run-start.cjs` then signed up a
new person in a browser and opened the Billing page, 13 of 13: the API named devnet, USDC and SOL were
offered, each of the four packs showed "Pay with Wallet", "Show my deposit address" was there, no card
button was drawn and the page fitted a phone. That check ran on a second empty database, removed
afterwards, with a key of its own that was never written down, so the run's database still holds
nothing. Steps 3 to 5 need the wallets and are still to do.

SOL on devnet: Pyth's price account there is updated irregularly. When it is more than two minutes old
the API refuses SOL, by design, and USDC still works. The money report says how old the price is, under
`health.solPrice`. The Billing page offers SOL beside USDC either way; a payment in SOL asked for while
the price is old is answered "We could not get a current SOL price, so nothing was prepared. Pay with
USDC, or try again in a minute."

Nosana on a run: the run's API has every worker off that payments do not need, the two that watch and
bill a GPU among them, so `start-api.sh --run` gives it no Nosana access at all and a model cannot be
deployed on it (`GET /api/platform/compute` with the report's key says `"mode":"none"`). A run that
should also deploy a model is started with `WITH_NOSANA=1`, which keeps the Nosana account of
`apps/api/.env` and both workers. That run can spend Nosana credits.

## Devnet: one use paid from a wallet at the x402 door

A creator can let people with no account pay each use of an agent from a Solana wallet, in USDC, with
an x402 client. `apps/api/scripts/payments-proof/walk-devnet-x402.cjs` proves it on devnet with the
founder's own wallet as the payer. It costs only devnet network fees; every lamport and every unit of
USDC the walk moves is sent back to that wallet at the end.

What the founder needs:

- A keypair file of a devnet wallet (`solana-keygen new -o <file>`, kept outside the repository). The
  walk reads it once and never writes, copies or prints it: only its address is shown.
- In that wallet: about 0.03 devnet SOL, from https://faucet.solana.com (choose devnet) or
  `solana airdrop 1 <address> --url devnet`, and at least 0.20 devnet USDC (mint
  `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`), from https://faucet.circle.com (Solana, Devnet).
  When either is short, the walk says which and how much, and stops before it makes anything.
- The repository's Postgres and Redis running, `openssl`, ports 4010 and 4330 to 4332 free, and an empty
  database 1 in Redis.

```bash
node apps/api/scripts/payments-proof/walk-devnet-x402.cjs ~/x402-devnet-run --payer <keypair file>
```

To see it work first with no wallet, the same walk runs on the local test chain:
`bash apps/api/scripts/payments-proof/local-chain.sh start`, then the command above with `--local-chain`
in place of `--payer <keypair file>`. It passed 30 of 30 checks there in 55 seconds.

What it does: it checks the RPC is devnet; reads the wallet's SOL and USDC; makes a master key and a
treasury wallet in memory, its own empty database, a stand-in for Nosana on loopback (the agent answers
with no GPU and no Nosana account) and its own API on port 4010, started with
`X402_ENABLED=true start-api.sh --run devnet`. The wallet opens the treasury's USDC account. A seller
puts an agent on sale at $0.05 a use and switches paying from a wallet on. A call with no key is
answered 402, and its PAYMENT-REQUIRED header is printed decoded. The wallet lends the fee payer that
header names 0.02 SOL. Then one use is paid as an x402 client pays it, and the walk shows: the
transaction with its link on the devnet explorer, the time from the request to the answer, the wallet's
USDC down by exactly 50,000 units (5 cents) and none of its SOL taken by the use, the treasury up by the
same, the fee the fee payer paid, one payment row, one sale with no buyer and the paying wallet, one line
in the creator's earnings, the same PAYMENT-SIGNATURE refused the second time, and the payment settled
by the worker. Each check prints PASS or FAIL, and the walk ends with `N of N checks passed`.

At the end it stops its API, sends the fee payer's SOL and the treasury's USDC back to the wallet and
closes the treasury's token account, so its rent comes back too, and checks that the wallet holds the
USDC it started with and its SOL less only the network's fees. The database is left for reading; its
name and the API's log are printed.

It takes a few minutes, most of them starting the API, making its database, the deployment on the
stand-in and the wait for the payment to be settled (the first run gives the real figure). Keep the
machine awake and the terminal open until it prints `N of N checks passed`. Ctrl+C still hands
everything back. A restart of the machine, a closed lid that restarts it, or `kill -9` does not: the
walk's treasury and fee payer exist only in that run, so up to about 0.022 devnet SOL (the 0.02 lent
and the token account's rent) and 0.05 devnet USDC would stay where nobody can reach them.

`start-api.sh --run devnet` opens the door only when `X402_ENABLED=true` is set with a
`TREASURY_WALLET_ADDRESS`; it then also sets `X402_SUBMIT_TRANSACTIONS=true`, the settlement worker
(every 5 seconds unless `X402_SETTLEMENT_INTERVAL_MS` says otherwise) and keeps the deployment's own
wallet payment off. On `--run mainnet-beta` and `--runbook`, `X402_ENABLED` stays false whatever is set.

## Mainnet: what it needs

**It needs the founder's go-ahead.** It moves real money, all of it between the founder's own wallets:
12 USDC, about $12 of SOL, and 0.1 SOL. What is spent is network fees, and 0.002 SOL for each token
account that has to be opened, at most four of them: about 0.01 SOL in all.

### What was rehearsed, and what was not

The steps below were rehearsed on the local chain in this order, with these amounts, by
`walk-runbook.cjs`, on a server started by the same script with the same settings. Rehearsed: the order,
the amounts, every figure in "What to see", the settings, and the command of step 2.

Not rehearsed, because a local chain cannot: the pages (the walk calls the API where a person presses a
button; the pages have their own tests), what a real wallet hands back (the devnet step), an exchange's
own transfer, Pyth's live price, a real RPC provider, and how long each wait is.

### What must be in place

- **A database of its own, empty, with the migrations applied.** Not the local one: that holds test
  credits and test earnings, and with payouts on they could be paid out in real money. In the run's own
  database every credit and every cent owed comes from a real payment.
- A mainnet RPC address from a provider that serves transaction history. A free plan is enough for the
  run.
- A new master key (`openssl rand -hex 32`) in a file outside the repository, with a copy offline. Every
  deposit address and the paying wallet are derived from it. It must never change once an address has
  been given out, and without it what those addresses hold cannot be moved.
- A cold wallet. Not an exchange address: it has to sign one transfer. It needs 0.1 SOL and the fee for
  sending it.
- A first wallet to pay from (Phantom or Solflare), holding 10 USDC, and $10 of SOL plus 0.005 SOL: what
  it pays, two fees, 0.002 SOL for the deposit address's USDC account, and what a wallet must keep.
- A second wallet, to receive the payouts. It needs nothing in it.
- An exchange account that can withdraw USDC and SOL on the Solana network.
- An operator's key for the money report, 16 characters or more.
- Phantom and Solflare set back to mainnet after the devnet step.
- No other WheelsAI API running: the local demo and the proof's server share the port and the queues.

### Start it

```bash
node apps/api/scripts/payments-proof/make-run-database.cjs wheelsai_mainnet

export RUN_DATABASE=wheelsai_mainnet
export WALLET_MASTER_KEY_FILE=<the file that holds the new master key>
export SOLANA_RPC_URL=<the mainnet RPC address>
export TREASURY_WALLET_ADDRESS=<the cold wallet's address>
export PLATFORM_ADMIN_KEY=<the operator's key>
bash apps/api/scripts/payments-proof/start-api.sh --run mainnet-beta
bash apps/api/scripts/payments-proof/start-web.sh          # in another terminal; the app is on port 3100
```

`make-run-database.cjs` says whether the database is empty. `start-api.sh --run` refuses to start
without any of the five, listens on this machine only, and sets what the rehearsal set:

```bash
SOLANA_NETWORK=mainnet-beta
WALLET_TOPUPS_ENABLED=true
DEPOSITS_ENABLED=true
DEPOSIT_SCAN_INTERVAL_MS=30000
SWEEPS_ENABLED=true
SWEEP_INTERVAL_MS=30000
PAYOUTS_ENABLED=true
PAYOUT_EXECUTOR_INTERVAL_MS=15000
TOPUP_RECONCILE_INTERVAL_MS=15000
SOL_PRICE_SOURCE=pyth
ALLOW_MOCK_CHECKOUT=false
X402_ENABLED=false          # on mainnet-beta whatever is set
# For this run only, so that a few dollars move through every path:
SWEEP_MIN_USD=1
HOT_WALLET_FLOAT_USDC=5
HOT_WALLET_FLOAT_SOL_USD=10
HOT_WALLET_MIN_SOL=0.01
```

Every worker the money rails do not need is off. Payouts need both of their settings: with
`PAYOUT_EXECUTOR_INTERVAL_MS` at its default of 0 the product says payouts are unavailable. The last
four have defaults for real use ($25, $200, $100 and 0.05 SOL).

The report every step reads:

```bash
curl -s -H "x-admin-key: $PLATFORM_ADMIN_KEY" http://localhost:4000/api/platform/money
```

### The run

| Step | What to do | What to see |
| --- | --- | --- |
| 1 | Read the report | `customers.balanceCents` and `creators.owedCents` are "0": the database is empty. `onChain.hotWallet.address` is the paying wallet. `onChain.treasury.proven` is `false`. Under `health`: `walletTopups`, `deposits`, `depositScan`, `sweeps` and `payouts` are `true`, `cluster` is "ok", `solPrice.ok` is `true` |
| 2 | Send 0.1 SOL from the cold wallet to the paying wallet. A minute later: `bash apps/api/scripts/payments-proof/start-api.sh --run mainnet-beta -- npx tsx scripts/treasury-verify.ts` | "The treasury ... is proven"; the report says `onChain.treasury.proven: true` |
| 3 | Sign up a first account with an email. On the Billing page take the $10 pack and press "Pay with Wallet": once in USDC, once in SOL, from the first wallet. Approve each in the wallet without delay | "Added $10.00 in credits." twice; the SOL payment says its price and "This price holds for 60 seconds."; $20.00 in credits |
| 4 | Wait three to five minutes, and read the report | under `sweeps.landedInRange`, `kind: "sweep_to_hot"`, `asset: "USDC"`, `amountRaw: "10000000"`, and the SOL swept off the address beside it; the account still has its $20.00 |
| 5 | Press "Show my deposit address". From the exchange, on the Solana network, withdraw to it 2 USDC, and $2 of SOL but not less than 0.01 SOL | each credited within a few minutes: $2.00, and the SOL at Pyth's price, a cent or two under the exchange's own figure. Then the USDC arrives at the cold wallet |
| 6 | In another browser profile, sign up a second account. Make an agent, then Listings, "List an agent": Monthly, $12, publish. As the first account, open the agent's page from its listing in the marketplace and press "Subscribe for $12.00 a month" | the first account's credits go down by $12.00; the second account's Earnings page shows $10.80 |
| 7 | As the second account, on the Earnings page, "Request payout": $5.00 in USDC to the second wallet; once it is completed, $5.00 in SOL | 5 USDC and about $5 of SOL arrive in the second wallet; $0.80 stays, under the smallest payout |
| 8 | Read the report | `reconciliation.usdc.differenceRaw` and `reconciliation.sol.differenceLamports` are both "0"; `sweeps.sent` is 0; `income.marketplaceFeesCents` is "120"; `creators.owedCents` is "80" |

Notes on the steps:

- **Step 2.** If the command says some transactions could not be loaded, run it again before sending
  anything.
- **Step 4.** The 10 USDC goes to the paying wallet because it is under its float. The SOL goes to the
  paying wallet while that wallet's own SOL is worth less than $10, and to the cold wallet otherwise. If
  the paying wallet's SOL is worth more than $20 after step 2, it first sends the excess to the cold
  wallet. Every one of these was rehearsed. The wait is the sweep run, every 30 seconds, and two
  finalities; with no priority fee a transfer can take longer on a busy day.
- **Step 5.** The amount that arrives is what is credited: if the exchange takes its fee out of it, less
  than 2 USDC arrives, and anything from 1 USDC is still swept. Less than $1 of an asset is credited and
  stays at the deposit address until more arrives. If the USDC arrives before step 4's sweep has been
  sent, the 12 USDC is swept together to the paying wallet, which then sends 7 on to the cold wallet.
- **Step 6.** The first account must be the organization's owner, which it is when it signed up.
- **Step 7.** One payout at a time: the second is refused while the first is open. With Pyth's price the
  SOL that arrives is $5.00 at the price plus its stated uncertainty: up to a few cents under $5.
- **Steps 4 and 8.** The report covers the current month, in UTC. On a run that crosses a month end, add
  `?from=` and the day the run started (`2026-10-31`) to the address.

### Where the money is at the end

With the steps done in the order above:

| Where | USDC | SOL |
| --- | --- | --- |
| the second wallet | 5 | about $5 of it |
| the cold wallet | 2 | what was swept to it, after the 0.1 SOL it sent |
| the paying wallet | 5 | what is left of the 0.1 SOL and of what was swept to it |
| the deposit address | 0 | 0.00089 SOL, which an address must keep to stay open |

If the 12 USDC was swept together (the note on step 5), the cold wallet ends with 7 and the paying wallet
with none.

All four are the founder's: the second wallet and the cold wallet directly, the paying wallet and the
deposit address through the master key. What is spent: network fees, a fraction of a cent each, and
0.002 SOL in each USDC account that was opened. The first wallet opens the deposit address's. The paying
wallet opens its own, and the cold wallet's and the second wallet's if they have none.

### Afterwards

- **To take the paying wallet's float back,** stop the API and start it again the same way with
  `HOT_WALLET_FLOAT_USDC=0` and `HOT_WALLET_FLOAT_SOL_USD=0` added. The run's other settings stay as they
  are: with the usual $25 threshold nothing this small would move. Within a sweep run its USDC goes to
  the cold wallet whole, and its SOL down to the 0.01 SOL it keeps. This was rehearsed. It holds for SOL
  up to about $800: above that the paying wallet ends the run with too little SOL for the transfer to
  be worth $1, and it stays where it is.
- The run's four small settings are not for real use. A deployment that serves customers uses the
  defaults, and a SOL float worth well above `HOT_WALLET_MIN_SOL`: the paying wallet pays fees from it.
- If the same deployment goes on to serve customers, keep its master key and its database: the addresses
  given out belong to them.

### If a step does not go as written

- **A payment from the wallet is refused before it is sent.** The wallet added something to the transfer
  that the server does not accept. Nothing was taken. The API's log names the program. This is what the
  devnet step is there to find first.
- **A payment says it expired.** It was approved in the wallet after its time: 60 seconds for SOL, 120
  for USDC. Nothing was sent. Press "Pay with Wallet" again.
- **A payment says it is waiting.** The page can be closed. The transfer is sent again every 15 seconds
  until the chain says what became of it. It is credited when it lands; if it never does, the page says
  so and nothing was taken.
- **SOL is refused, or SOL that was sent is not credited, not swept or not paid out.** Read
  `health.solPrice.ok` in the report. When Pyth's price is older than two minutes, or too uncertain, SOL
  waits and USDC is unaffected. SOL sent to the deposit address meanwhile is recorded, and credited at
  the price it gets when there is one. A SOL payout sends itself once there is a price.
- **A withdrawal from the exchange is not credited after ten minutes,** and for SOL the price is there.
  Press "Check now". If it is still not credited, the RPC provider is not serving the address's history:
  the money is at the deposit address, which the master key holds, and it is credited once the API reads
  from a provider that does.
- **A payout stays "Pending".** The API's log says why. With no SOL price, or a read of the chain that
  failed, it sends itself on a later run. Only when the paying wallet is short does it need something:
  send the wallet what is missing, or cancel the payout, and the earnings go back.
- **A payout ends as "Failed".** Three transfers were signed for it and none landed before it expired.
  The earnings are back. Request it again.
- **A section of the report says `"state": "unreadable"`.** The read took too long. Read it again.
- **While `sweeps.sent` is above 0 or a payout is "Processing",** leave the API running and the machine
  awake: a transfer that is out is settled by the worker that sent it.
