# Payments: proof run on a local chain

**Date:** 2026-10-11
**Code:** `496c7b7`, branch `feat/bags-launchpad`
**Verdict:** every money path of the payments module was run on a local Solana chain, through the real
API, and checked against the database and the chain: **130 checks in five walks, 45 checks in four
browser tests, and the 10 steps of the x402 proof. All passed.** No real money and no real network were
involved.

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
  can reach them: payouts at most $20 each and $45 a day, floats of $20 in USDC and $22 in SOL, a sweep
  threshold of $5, two opened accounts a day, and every money worker running every 3 seconds.
- **The price of SOL** was stated ($110, `SOL_PRICE_SOURCE=static`), which the API refuses in
  production and on mainnet. The live read of Pyth's price account is the same code with another
  source; it was checked on its own, reading only, against devnet and mainnet on 2026-10-10.
- **The keys** are throwaway keys kept outside the repository. They are only ever used on this chain.

| Script | What it proves | Checks |
| --- | --- | --- |
| `walk-sweeps.cjs` | sweeps to the paying wallet and to a proven treasury, the treasury proof, the money report, set-plan | 23 of 23 |
| `walk-pay-in.cjs --slow` | paying in from a wallet, in USDC and in SOL | 25 of 25 |
| `walk-pay-out.cjs` | creator payouts in USDC, SOL and credits | 30 of 30 |
| `walk-deposits.cjs` | a deposit address: transfers from outside, credited once | 33 of 33 |
| `walk-billing.cjs` | the Billing figures: held, spending by kind, the list, the export | 19 of 19 |
| `browser-pay-in.cjs` | paying in through the Billing page with a test wallet | 14 of 14 |
| `browser-pay-out.cjs` | taking earnings out through the Earnings page | 9 of 9 |
| `browser-deposits.cjs` | the deposit address panel | 11 of 11 |
| `browser-billing.cjs` | the Billing page's tiles, spending, history and Export | 11 of 11 |
| `x402-devnet-proof.ts` | one request paid by an on-chain transfer, in USDC and in SOL | 10 of 10 steps |

The walks were run by `run-all.sh` in one go, on a chain started for the run. The browser tests and the
x402 proof were run after it, on the same chain. The browser tests sign with a wallet the test itself
registers through the Wallet Standard: no browser extension is involved.

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
credited and left at its address.

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

**In every walk:** no answer carried the chain's or the database's own words, and every refusal carried a
code and a sentence.

## What this run does not prove

- **Real wallets.** Phantom and Solflare add their own instructions to a transfer. The top-up accepts a
  fee setting and the wallet's guard instruction, and that was proven with a script that imitates them,
  not with the wallets. This is the gate before mainnet.
- **The live SOL price inside a payment.** The price was stated. The live read was checked separately.
- **A real RPC provider.** The deposit scan reads transaction history. A provider that does not serve
  history, or serves it late, is not something a local chain can show.
- **Mainnet.**

## Running it again

```bash
bash apps/api/scripts/payments-proof/run-all.sh
```

It needs the Solana command line tools, Node, and Docker with the repository's Postgres and Redis
running, and ports 4000 and 18899 free. It takes about half an hour, most of it waiting for blocks to
become final. The chain's folder must be on disk (the script refuses `/tmp`); the ledger stays at a few
gigabytes. The browser tests and the x402 proof are run after it: `README.md` in that folder and the
header of `x402-devnet-proof.ts` say how.

## Devnet, with real wallets: what it needs

This is done by a person at a browser. It costs nothing.

1. Set Phantom and Solflare to devnet. Get devnet SOL from Solana's faucet and devnet USDC from Circle's
   faucet (Solana, devnet) into each.
2. Run the API against devnet (`SOLANA_NETWORK=devnet`, a devnet `SOLANA_RPC_URL`) with
   `WALLET_TOPUPS_ENABLED=true`, a `WALLET_MASTER_KEY` used for devnet only, `DEPOSITS_ENABLED=true` and
   `PAYOUTS_ENABLED=true`, and the web app built against the same RPC.
3. On the Billing page, pay $5 in USDC with Phantom, then $5 in USDC with Solflare. Each must end as
   "Added $5.00 in credits." **This is the step that matters:** it shows the transfer each real wallet
   signs is one the server accepts.
4. Press "Show my deposit address", send 1 USDC to it from either wallet, and see it credited within a
   few minutes.
5. Optional: a payout. Fund the paying wallet (its address is in the money report) with 5 USDC and a
   little SOL, and take $5 out to the other wallet.

SOL on devnet: Pyth's price account there is updated irregularly. When it is more than two minutes old
the API refuses SOL, by design, and USDC still works.

## Mainnet: what it needs

**It needs the founder's go-ahead.** It moves real money, all of it between the founder's own wallets;
what is spent is network fees, a few cents.

What must be in place:

- a mainnet `SOLANA_RPC_URL` from a provider that serves transaction history;
- a new `WALLET_MASTER_KEY` for mainnet, kept offline. It must never change once an address derived from
  it has been given out;
- two wallets of the founder's own (one to pay from, one to receive the payouts) and an exchange account;
- a cold wallet, as `TREASURY_WALLET_ADDRESS`. Not an exchange address: it has to sign one transfer;
- `PLATFORM_ADMIN_KEY`, to read the money report.

The run, with the amounts that make every path move (about $16 in USDC and SOL, plus 0.11 SOL):

| Step | What happens | What to see |
| --- | --- | --- |
| 1 | Pay $10 in USDC, then $5 in SOL, from the first wallet on the Billing page | $15.00 in credits; the SOL payment says its price and how long it holds |
| 2 | Withdraw 1 USDC and 0.01 SOL from the exchange to the deposit address | both credited within a few minutes, with no browser wallet |
| 3 | Send 0.1 SOL from the cold wallet to the paying wallet, then `npx tsx scripts/treasury-verify.ts` | "proven"; the money report says `treasury.proven: true` |
| 4 | Wait for a sweep run (`SWEEPS_ENABLED=true`; for this run `SWEEP_MIN_USD=1`, `HOT_WALLET_FLOAT_USDC=6`, `HOT_WALLET_FLOAT_SOL_USD=6`) | deposits leave the address: to the paying wallet up to its floats, the rest to the cold wallet |
| 5 | From a second account, publish a listing at $12 a month; subscribe to it from the first | the creator is owed $10.80 |
| 6 | Take $5 out in USDC and $5 in SOL to the second wallet | both arrive; the Earnings page shows them completed |
| 7 | Read `GET /api/platform/money` | every reconciliation difference is 0 |

The default sweep threshold ($25) and floats ($200 and $100) are for real use; the smaller ones above are
only so that a run of a few dollars moves through every path. Set them back afterwards.

At the end the money is in the founder's second wallet (the payouts), the cold wallet (the sweeps) and
the paying wallet (its float and the proof transfer), all of which the founder holds.
