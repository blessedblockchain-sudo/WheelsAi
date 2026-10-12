# Agent tokens on Meteora's bonding curve

**Date:** 2026-10-12 · **Branch:** `feat/bags-launchpad` · **Migration:** none

An agent that passes the launch gate can launch its own token on Meteora's Dynamic Bonding Curve
(DBC). WheelsAI builds a curve config for that one token from a named preset, and the token is
priced in SOL. People buy and sell it inside WheelsAI, and the creator claims a share of the
trading fees. When enough SOL has been raised the curve is full, and the token graduates: its
pool moves into a Meteora DAMM v2 pool where the liquidity is locked for good. No wallet of the
server's signs or pays at any step. It builds each transaction, the person's browser wallet signs
it, and the server checks that what came back is the transaction it built before it sends it.

This document has six parts:

1. [The four curve presets](#1-the-four-curve-presets)
2. [What the server needs](#2-what-the-server-needs)
3. [The routes](#3-the-routes)
4. [What is on chain, and what the database keeps](#4-what-is-on-chain-and-what-the-database-keeps)
5. [The devnet walk](#5-the-devnet-walk), with the place for its proof
6. [What is not built](#6-what-is-not-built)

**Devnet walk: not run yet.** Part 5 has the steps and the table to fill in. Until it is filled
in, nothing in this document has been done by a person in a browser. What has run against devnet
is a probe of the SDK's calls, described at the start of part 5.

---

## 1. The four curve presets

A preset is a set of fixed numbers. The creator picks one in the launch wizard; nobody types a
curve by hand. The numbers live in `apps/api/src/services/launchpad/meteoraPresets.ts`.

| id | Name | Start value | Graduation value | SOL raised at graduation | Trading fee: from, to, over | Creator's share of fees | Creator's locked tokens |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `community` | Community | 20 SOL | 320 SOL | 64.000 | 30% to 1%, 300 s in 30 steps | 70% | none |
| `committed` | Committed creator | 30 SOL | 400 SOL | 77.395 | 30% to 1%, 300 s in 30 steps | 50% | 100,000,000 (10% of supply): nothing for 30 days after graduation, then 12 equal parts over 360 days |
| `long` | Long runway | 50 SOL | 1,000 SOL | 173.607 | 20% to 0.5%, 600 s in 60 steps | 50% | 50,000,000 (5% of supply): nothing for 30 days after graduation, then 24 equal parts over 720 days |
| `rehearsal` | Devnet rehearsal | 1 SOL | 5 SOL | 1.391 | 5% to 1%, 120 s in 12 steps | 50% | 100,000,000 (10% of supply): nothing for 600 s after graduation, then 6 equal parts over 3,600 s |

How to read a row:

- **Start value** and **graduation value** are the value of the whole supply, in SOL, at the
  curve's first price and at the price where it graduates.
- **SOL raised at graduation** is how much SOL buyers must have put into the curve for it to be
  full. It comes out of Meteora's own curve builder for the numbers of that row, and a unit test
  pins all four to three decimals so that a change to a preset is seen.
- **Trading fee** starts high and falls in steps to its lowest value. The high first minutes make
  it costly to buy the moment a token appears and sell straight after. On top of this base fee
  the curve's dynamic fee is on, which adds to the fee while the price moves fast.
- **Creator's share of fees** is the creator's part of the trading fees the curve collects. The
  rest is the platform's.
- **Creator's locked tokens** are set aside for the creator in the curve config. They are
  released by a locker on chain, on the schedule in the row.

`community` is the default. `rehearsal` is offered only when `SOLANA_NETWORK` is `devnet`: it is
small and fast so that a whole launch, a graduation and a release can be walked in one sitting.

What all four share:

- The token is an SPL token with 6 decimals and a supply of 1,000,000,000. Its authority is
  immutable: nobody can mint more or change it.
- The curve is priced in SOL (wrapped SOL, `So11111111111111111111111111111111111111112`).
- Fees are collected in SOL. There is no pool creation fee and no migration fee.
- No tokens are left over after graduation.
- At graduation the pool moves to DAMM v2, and all of its liquidity is locked for good: half in
  the platform's name and half in the creator's.

## 2. What the server needs

**No key of the server's signs a transaction that moves money in this feature.** It needs
addresses, an RPC endpoint and one secret, `WALLET_MASTER_KEY`, which here signs only the
short-lived prepare tokens that tie a submit to its prepare. The only keypairs the server signs
with are made for one transaction and thrown away: the config's and the mint's at launch, and two
position keypairs at graduation. None of them holds money.

| Setting | Value |
| --- | --- |
| `LAUNCHPAD` | `meteora`. The default is `pumpfun`. |
| `WALLET_MASTER_KEY` | Required. The prepare tokens are signed with a secret derived from it. Without it the launch routes (`/launch/prepare`, `/launch/submit`, `/launch/reconcile`) are not mounted, and every trade, fee and graduation route that needs a login answers `503 { "error": "prepare_unavailable" }`. It is the same root secret other features derive their keys from (`docs/DEPLOY-RUNBOOK.md`, section 3.3), so it is kept as they keep it. |
| `METEORA_FEE_CLAIMER_ADDRESS` | Required with `LAUNCHPAD=meteora`: the API refuses to start without it, or with a value that is not a Solana address. It is the address of the platform's fee wallet, written into every curve config as the wallet that may claim the platform's share of trading fees. An address only. |
| `METEORA_LEFTOVER_RECEIVER_ADDRESS` | Optional. Where a curve's unsold tokens would go after graduation. Defaults to the fee wallet. The four presets leave nothing over. |
| `METEORA_CURVE_CACHE_MS` | How long a pool's state read from the chain is kept before it is read again. 5000 by default; 0 reads every time. |
| `SOLANA_RPC_URL`, `SOLANA_NETWORK` | The node the server reads and sends through, and the network, `devnet` or `mainnet-beta`. The network decides whether `rehearsal` is offered and whether explorer links carry `?cluster=devnet`. |
| `TOKEN_LAUNCH_MIN_REPUTATION` | The launch gate: the reputation an agent needs. 50 by default. |
| `TOKEN_LAUNCH_MIN_DEPLOYMENT_AGE_DAYS` | The launch gate: the days its oldest running deployment must have run. 7 by default. |

The Meteora SDK (`@meteora-ag/dynamic-bonding-curve-sdk` 1.5.12) is a dependency of `apps/api`
only. An older copy at the repository root belongs to the Bags SDK and is not used here.

### The launch gate

An agent may launch a token when all of these hold (`apps/api/src/services/tokenEligibility.ts`):
its publisher's reputation is at least the first number, its oldest running deployment is at
least as old as the second, its listing is published, it has no token yet, and the person
launching has a wallet connected. Each settled x402 payment to the agent takes one point off the
reputation it needs, up to 25 points.

The two numbers are read in one place, `launchGateThresholds()`, by everything that shows or
enforces them: the check the launch route runs, the preview behind
`GET /api/tokens/eligibility/:agentListingId` and its `requirements`, the `gate` of
`GET /api/tokens/launchpad`, and through those the wizard. So the numbers a person is shown are
the numbers the launch is held to, and the sentences of the preview name the numbers in force.

The defaults are the production rule. A devnet rehearsal may lower both so that a new agent can
be walked through a launch on the same day. Lowering them on a server that people use for real
removes the reason the gate exists (section "Agent tokens on Meteora" of
`docs/HARDENING-BACKLOG.md`).

## 3. The routes

All are under `/api/tokens`. `:id` is the token's id in our database. An amount travels twice in
JSON: as a string of raw units (lamports, or the token's smallest unit) and as a decimal string
for people. No decision is made on a float.

### Launch

| Route | Login | What it does |
| --- | --- | --- |
| `GET /launchpad` | no | Which launchpad this server uses, the network, the presets with what the wizard shows for each (the numbers of part 1, a one-sentence summary and 24 points for a drawing of the curve), the default preset, and the launch gate's numbers. The presets are empty for the other launchpads. |
| `GET /eligibility/:agentListingId` | yes | Whether this agent may launch, the reasons if not, and the gate's numbers. |
| `POST /launch/prepare` | yes | Takes the token's details and an optional `preset` (`community` when left out). Checks the gate, uploads the picture and the metadata, and builds ONE transaction that creates the curve config and the pool. The server signs it with two fresh keypairs it makes for the config and the mint and then forgets; the creator's signature is left empty. Answers the transaction, a signed prepare token, and the `preset` and `poolAddress`. |
| `POST /launch/submit` | yes | Takes the transaction signed by the creator's wallet. It is sent only if it carries the same message the server built (compared by sha256), names the expected mint and creator, and has every signature. Then the token is saved. |
| `POST /launch/reconcile` | yes | Saves a token whose launch reached the chain but whose row was not written. |

Refused at prepare, before any wallet is asked to sign: an unknown preset or one not offered on
this network (`rehearsal` on mainnet), a first buy above 0 (the first buy is made on the token's
page after launch), a missing picture, and a transaction over 1,232 bytes.

### The curve

Each of these answers `404 { "error": "token_not_found" }` when there is no token with that id
and `404 { "error": "not_a_curve_token" }` for a token that was not launched on Meteora.

| Route | Login | What it does |
| --- | --- | --- |
| `GET /:id/curve` | no | The pool as the chain has it: the state (`trading`, `full` or `graduated`), the price and the value of the supply in SOL, the SOL raised and the SOL it graduates at, the progress, the fee right now, the creator's address, what the creator can claim, the creator's share and locked tokens, and the graduated pool's address once there is one. When the pool cannot be read it answers `503 { "error": "curve_unreadable" }`. It never guesses. |
| `POST /:id/trade/quote` | no | `{ side, amount, slippageBps }`: SOL in for a buy, tokens in for a sell. Answers what comes out, the least that will be accepted, the fee, and the price afterwards. `400 invalid_amount`, also for a buy of more SOL than the curve has left to raise (the answer then carries `remainingLamports` and `remainingSol`); `409 curve_full` when the curve is not trading. |
| `POST /:id/trade/prepare` | yes | The quote's body plus the `wallet`. Answers an unsigned transaction, a prepare token, the quote and when it expires. |
| `POST /:id/trade/submit` | yes | The prepare token and the signed transaction. Answers the signature, the trade's amounts, and `recorded`: false when the trade is confirmed on chain and its row could not be written. |
| `POST /:id/fees/prepare` | yes | `{ wallet }`. The wallet must be the pool's creator as the chain has it, or the answer is `403 not_the_creator`. `409 nothing_to_claim` when there is nothing. Answers the transaction, the prepare token and what is waiting (`claimableLamports`, `claimableSol`). |
| `POST /:id/fees/submit` | yes | Answers the signature and the lamports claimed. |
| `POST /:id/graduate/prepare` | yes | `{ wallet }`. Any wallet may pay. Answers one step, `locker` or `migrate`, its transaction, and how many steps are left after it. `409 curve_not_full`; `409 already_graduated`, with the graduated pool's address. If the chain says the pool has graduated and our row still says `BONDING`, this call also brings the row in line. |
| `POST /:id/graduate/submit` | yes | Sends the step. After `migrate` it marks the token graduated and answers the DAMM v2 pool's address. If the pool moved and the row could not be written it answers `500 persistence_failed` with the signature and the address; asking to graduate again brings the row in line. |

Every prepare answers a signed token that lasts 90 seconds and carries who asked, for which
token and wallet, the sha256 of the transaction's message, and what submit must record. Submit
refuses a bad or expired token, another user's token, a transaction whose message differs, and a
missing signature (`400 prepare_token_invalid`, `403 prepare_token_not_yours`,
`400 transaction_mismatch`). Only then is anything sent. A wallet that is not a Solana address is
`400 invalid_wallet`. A transaction the node refuses is `502 send_failed`, and one that was sent
and not seen confirmed is `502 transaction_not_confirmed`, with its signature.

Graduation takes one or two transactions. The locker comes first, and only when the preset locks
tokens for the creator and the locker does not exist yet. The migrate transaction needs two more
signatures than the payer's: Meteora's SDK returns two position keypairs for the new pool, and
the server signs with both before it answers. They are made for that one transaction and hold no
money.

## 4. What is on chain, and what the database keeps

On chain, per token:

| Account | What it is | When it is made |
| --- | --- | --- |
| The mint | The token itself: 6 decimals, a supply of 1,000,000,000, immutable. | At launch. |
| The curve config | The preset's numbers as Meteora stores them, with the platform's fee wallet and the leftover receiver. One per token. | At launch, in the same transaction. |
| The pool | The bonding curve: the tokens for sale, the SOL raised, the fees collected. Its creator is the wallet that launched. Its address is derived from the SOL mint, the token's mint and the config, so it never has to be searched for. | At launch, in the same transaction. |
| The locker | Holds the creator's locked tokens and releases them on the preset's schedule. Only for presets that lock tokens. | First step of graduation. |
| The DAMM v2 pool | Where the token trades after graduation. Its liquidity is locked for good, half the platform's and half the creator's. | Second step of graduation. |

The chain is the record of prices, balances, fees and who the creator is. The server reads the
pool for every answer of `GET /:id/curve` (kept for `METEORA_CURVE_CACHE_MS`, and dropped after
any submit) and derives nothing from its own rows.

In our database, with no migration and no change to the schema, a Meteora token is a row of
`AgentToken` with:

| Column | Holds |
| --- | --- |
| `launchpad` | `meteora` |
| `mintAddress` | The mint. |
| `meteoraConfigKey` | The curve config's address. |
| `bondingCurveAddress` | The pool's address. |
| `status` | `BONDING`, then `GRADUATED`. |
| `graduatedAt` | When the migrate step was confirmed. |
| `raydiumPoolId` | The DAMM v2 pool's address after graduation. The column's name is older than this use. |

`pumpfunUrl` is not written for a Meteora token. As for every launchpad, the launch also writes
an `AgentTreasury` row with the treasury address derived from the mint; the launch creates
nothing on chain for it.

`GRADUATED`, `graduatedAt` and the DAMM v2 pool's address are written by our own graduation
routes only. A pool that graduates without them is `graduated` in the answer of `GET /:id/curve`,
which reads the chain, while its row says `BONDING` until someone calls `graduate/prepare` for it.

Each trade made through WheelsAI and confirmed writes one row of `AgentTokenTrade`. The
signature is unique, so a repeat is not written twice. For a buy, the SOL is the amount sent and
the tokens are the change of the wallet's token balance in the confirmed transaction. For a
sell, the tokens are the amount sent and the SOL is what left the pool's SOL vault in that
transaction. If the confirmed transaction's details cannot be read, the prepared quote's numbers
are written and the log says so.

A trade of the same token made outside WheelsAI, with any other tool, is on chain and moves the
price the curve route shows. It is not in `AgentTokenTrade`: the pump.fun trade indexer leaves
Meteora tokens alone, and nothing else reads a Meteora pool's history.

## 5. The devnet walk

### What has already run against devnet

`apps/api/scripts/meteora-devnet-probe.ts` builds each of the SDK's calls the way the feature
does. On 2026-10-12 devnet accepted every call in it: a launch (1,077 of 1,232 bytes, three
signatures), a pool read, the fee breakdown, a buy (675 bytes) and a creator claim (715 bytes,
two signatures). A graduation transaction is 1,141 bytes with three signatures. Devnet's public
RPC also answered 429 to the probe, which is why the server keeps what it reads.

That shows the SDK and the chain agree with how the calls are built. It does not show the
feature: no route, no screen and no browser wallet took part.

### Before the walk

- An API with `LAUNCHPAD=meteora`, `SOLANA_NETWORK=devnet`, `METEORA_FEE_CLAIMER_ADDRESS` set to
  an address the founder controls, `WALLET_MASTER_KEY` set, and a devnet `SOLANA_RPC_URL`.
- The web app built for devnet (`NEXT_PUBLIC_SOLANA_CLUSTER`, `NEXT_PUBLIC_SOLANA_RPC_URL`) with
  the token pages on (`NEXT_PUBLIC_ENABLE_TOKEN_UI`, `NEXT_PUBLIC_ENABLE_TRADING`).
- Phantom set to devnet, holding devnet SOL. The `rehearsal` curve is full at 1.391 SOL raised;
  the wallet also pays the fees on its buys, the network's fees, and the rent of the accounts
  the launch and the graduation create.
- An agent with a published listing and a running deployment that passes the launch gate. If the
  agent is new, lower `TOKEN_LAUNCH_MIN_REPUTATION` and `TOKEN_LAUNCH_MIN_DEPLOYMENT_AGE_DAYS`
  on this devnet server only, and write the values used into the table below.
- A picture for the token.

### The steps

Every step is done by a person, in the browser, signing in Phantom.

1. **Connect.** Sign in to WheelsAI with Phantom on devnet.
2. **Launch.** Open the launch wizard for the agent. Choose the "Devnet rehearsal" curve, add the
   picture, review, launch, and sign once. The success screen links to the token's page and to
   the transaction on Solana's explorer.
3. **Read the curve.** On the token's page the "Curve" card shows "Trading on the curve", the
   price, the fee right now, 0 SOL raised of 1.391, and the pool's address.
4. **Buy.** Type a small amount of SOL in the trade panel, read the quote (what you get, the
   least you will accept, the fee), buy, and sign. The card's raised SOL and price move.
5. **Sell.** Sell part of what was bought, and sign.
6. **Claim.** With the creator's wallet connected, the creator's card shows what can be claimed.
   Claim, and sign.
7. **Fill the curve.** Buy until the card says "The curve is full: it can graduate". A buy of
   more SOL than the curve has left to raise is refused, so the last buy is for what is left.
8. **Graduate.** Press Graduate. The `rehearsal` preset locks tokens for the creator, so there
   are two steps, each signed once: the locker, then the move to the Meteora pool. The card then
   says "Graduated to a Meteora pool" and shows the DAMM v2 pool's address.

### What counts as proof

For each step below: the transaction's signature, opened on `https://explorer.solana.com` with
`?cluster=devnet` and showing success, and what the screen said afterwards. Together with:

- the pool's address on the explorer, owned by Meteora's DBC program, and the DAMM v2 pool's
  address after graduation;
- the token's `AgentToken` row: `launchpad`, `meteoraConfigKey`, `bondingCurveAddress`, then
  `status = GRADUATED`, `graduatedAt` and `raydiumPoolId`;
- one `AgentTokenTrade` row for the buy and one for the sell, with the same signatures;
- the SOL the creator's wallet received from the claim, as the explorer shows it, equal to the
  `claimedLamports` the route answered.

A step counts only when a person signed it in the browser wallet. A transaction sent by a script
is not proof of this feature.

### Devnet walk: not run yet

To be filled in by the lead.

| | |
| --- | --- |
| Date | |
| Commit | |
| Network and RPC | |
| Gate numbers on the server (reputation, days) | |
| Wallet (address only) | |
| Agent and listing | |
| Preset | |
| Mint | |
| Curve config | |
| Pool | |

| Step | Signature | What the screen said | Result |
| --- | --- | --- | --- |
| Launch | | | |
| Buy | | | |
| Sell | | | |
| Claim | | | |
| Buys that filled the curve (the last one) | | | |
| Graduate: locker | | | |
| Graduate: migrate | | | |

| After graduation | |
| --- | --- |
| DAMM v2 pool | |
| `AgentToken` row (status, graduatedAt, raydiumPoolId) | |
| `AgentTokenTrade` rows (count, signatures) | |
| Anything that did not go as written above | |

## 6. What is not built

- **Trading on the graduated pool inside WheelsAI.** After graduation the token trades on the
  Meteora DAMM v2 pool. The trade panel buys and sells on the curve only; the page shows the
  graduated pool's address and its explorer link.
- **Claiming fees from the graduated pool.** The locked liquidity earns trading fees in the
  DAMM v2 pool, for the creator and for the platform. Nothing in WheelsAI claims them.
- **The platform's fee share reaching the agent's GPU treasury on chain.** The platform's share
  of a curve's fees can be claimed by the fee wallet named in the config. No route, screen or
  worker of WheelsAI claims it, and nothing moves it to an agent's treasury.
- **Tokens for workflows and models.** Only an agent with a published listing can launch one.
- **A real launch on mainnet.** Nothing here has run on mainnet. The presets other than
  `rehearsal` have been built by Meteora's curve builder and never launched.

Known limits of what is built are in `docs/HARDENING-BACKLOG.md`, section "Agent tokens on
Meteora". What only the founder can do is in `docs/FOUNDER-ACTIONS.md`, section 9.
