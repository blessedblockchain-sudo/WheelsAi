# Agent tokens on Meteora's bonding curve

**Date:** 2026-10-12 · **Branch:** `feat/bags-launchpad` · **Migration:** none

An agent that passes the launch gate can launch its own token on Meteora's Dynamic Bonding Curve
(DBC). WheelsAI builds a curve config for that one token from a named preset, and the token is
priced in SOL. People buy and sell it inside WheelsAI, and the creator claims a share of the
trading fees. When enough SOL has been raised the curve is full, and the token graduates: its
pool moves into a Meteora DAMM v2 pool where the liquidity is locked for good. No wallet of the
server's signs or pays at any step. It builds each transaction, the person's browser wallet signs
it, and the server checks that what came back is the transaction it built before it sends it. The
one thing a wallet may add is its own priority-fee instructions, and only to a transaction it
alone signs (part 3, "What submit accepts").

This document has six parts:

1. [The four curve presets](#1-the-four-curve-presets)
2. [What the server needs](#2-what-the-server-needs)
3. [The routes](#3-the-routes)
4. [What is on chain, and what the database keeps](#4-what-is-on-chain-and-what-the-database-keeps)
5. [The devnet walk](#5-the-devnet-walk), with the place for its proof
6. [What is not built](#6-what-is-not-built)

**Devnet walk: not run yet.** Part 5 has the steps and the table to fill in. Until it is filled
in, nothing in this document has been done by a person in a browser, and no transaction of this
feature has been sent to devnet or to mainnet. What has run against devnet is a probe that asks
the cluster to simulate the SDK's calls, described at the start of part 5.

---

## 1. The four curve presets

A preset is a set of fixed numbers. The creator picks one in the launch wizard; nobody types a
curve by hand. The numbers live in `apps/api/src/services/launchpad/meteoraPresets.ts`.

| id | Name | Start value | Graduation value | SOL raised at graduation | Trading fee: from, to, over | Creator's share of fees | Creator's locked tokens |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `community` | Community | 20 SOL | 320 SOL | 64.000 | 30% to 1%, 300 s in 30 steps | 70% | none |
| `committed` | Committed creator | 30 SOL | 400 SOL | 77.395 | 30% to 1%, 300 s in 30 steps | 50% | 100,000,000 (10% of supply): nothing for 30 days after graduation, then 10 equal parts of 10,000,000, one every 30 days (300 days) |
| `long` | Long runway | 50 SOL | 1,000 SOL | 173.607 | 20% to 0.5%, 600 s in 60 steps | 50% | 50,000,000 (5% of supply): nothing for 30 days after graduation, then 20 equal parts of 2,500,000, one every 30 days (600 days) |
| `rehearsal` | Devnet rehearsal | 0.25 SOL | 1.25 SOL | 0.348 | 5% to 1%, 120 s in 12 steps | 50% | 100,000,000 (10% of supply): nothing for 600 s after graduation, then 5 equal parts of 20,000,000, one every 600 s (3,000 s) |

How to read a row:

- **Start value** and **graduation value** are the value of the whole supply, in SOL, at the
  curve's first price and at the price where it graduates.
- **SOL raised at graduation** is how much SOL buyers must have put into the curve for it to be
  full. It comes out of Meteora's own curve builder for the numbers of that row, and a unit test
  pins all four to three decimals so that a change to a preset is seen. In lamports the four are
  64,000,000,000, 77,394,659,838, 173,606,797,749 and 347,644,118.
- **Trading fee** starts high and falls in steps to its lowest value. The high first minutes make
  it costly to buy the moment a token appears and sell straight after. On top of this base fee
  the curve's dynamic fee is on, which adds to the fee while the price moves fast.
- **Creator's share of fees** is the creator's part of the trading fees the curve collects. The
  rest is the platform's.
- **Creator's locked tokens** are set aside for the creator in the curve config. They are
  released by a locker on chain, on the schedule in the row. Nothing is released when the wait
  ends (the config's `cliffUnlockAmount` is 0 for every preset); the whole amount comes in the
  equal parts that follow. A unit test pins both. The wait counts from the moment the curve
  became full, which is the pool's `finishCurveTimestamp`.

`community` is the default. `rehearsal` is offered only when `SOLANA_NETWORK` is `devnet`: it is
small and fast so that a whole launch, a graduation and a release can be walked in one sitting.
The adapter itself refuses it on mainnet (`400 invalid_preset`).

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
| `NODE_ENV` | Decides which picture links are fetched (part 3, "The picture"). In `development` and `test`, and when it is unset, a link to this machine or a private network is allowed. Anywhere else it is refused. |

The Meteora SDK (`@meteora-ag/dynamic-bonding-curve-sdk` 1.5.12) is a dependency of `apps/api`
only. An older copy at the repository root belongs to the Bags SDK and is not used here.

### The launch gate

An agent may launch a token when all of these hold (`apps/api/src/services/tokenEligibility.ts`):
its publisher's reputation is at least the first number, its oldest running deployment is at
least as old as the second, its listing is published, it has no token yet, and the account
launching has a linked wallet. Each settled x402 payment to the agent takes one point off the
reputation it needs, up to 25 points.

The two numbers are read in one place, `launchGateThresholds()`, by everything that shows or
enforces them: the check the launch route runs, the preview behind
`GET /api/tokens/eligibility/:agentListingId` and its `requirements`, the `gate` of
`GET /api/tokens/launchpad`, and through those the wizard. So the numbers a person is shown are
the numbers the launch is held to, and the sentences of the preview name the numbers in force.

The preview has no rule of its own. It reads the facts the launch route reads (no publisher
profile counts as reputation 0, no running deployment as 0 days) and hands them to the same
check, so the two agree at every setting. With the days set to 0 the preview does not ask for a
running deployment, and an organization with no publisher profile gets what the gate decides.
The preview does not know the wallet and says nothing about one: an account with no linked
wallet is refused by the launch route itself, with `400 wallet_required`.

The defaults are the production rule. A devnet rehearsal may lower both so that a new agent can
be walked through a launch on the same day. A server that starts with either number below its
default writes one warning to its log, naming both numbers and the network. Lowering them on a
server that people use for real removes the reason the gate exists (section "Agent tokens on
Meteora" of `docs/HARDENING-BACKLOG.md`).

### The account's wallet

The launch is built for the wallet linked to the account, which the server reads from the login
session, not from the request. A person who signs in with a wallet has it linked from the start.
A person who signed in another way links one under Settings, in the Wallets tab: the link route
(`POST /api/settings/link-wallet`) issues the session cookie again, built from the account as it
is now, so the wallet takes effect at once in that browser. A session issued before the link, in
another browser or held by another client, keeps the old value until it is refreshed
(`POST /api/auth/refresh`) or signed in again.

The trade, fee and graduation routes take the `wallet` in the request instead: any wallet may
buy, sell or pay for a graduation, and only the pool's creator may claim.

## 3. The routes

All are under `/api/tokens`. `:id` is the token's id in our database. An amount travels twice in
JSON: as a string of raw units (lamports, or the token's smallest unit) and as a decimal string
for people. No decision is made on a float.

### Launch

| Route | Login | What it does |
| --- | --- | --- |
| `GET /launchpad` | no | Which launchpad this server uses (`launchpad`), the `network`, the `quote` (`SOL`), the `presets` with what the wizard shows for each (the numbers of part 1, a one-sentence summary and 24 `points` for a drawing of the curve), the `defaultPreset`, and the launch `gate`'s numbers. For the other launchpads `presets` is empty and `defaultPreset` is `null`. The gate's `creatorLockupDays` (30) is the lock pump.fun and Bags tokens are saved with; a Meteora token's lock is its preset's. |
| `GET /eligibility/:agentListingId` | yes | Whether this agent may launch, the reasons if not, and the gate's numbers. |
| `POST /launch/prepare` | yes | Takes the token's details (`agentId`, `name`, `symbol`, `description`, an optional `imageUri` and social links) and an optional `preset` (`community` when left out). Checks the gate, uploads the picture and the metadata, and builds ONE transaction that creates the curve config and the pool. The server signs it with two fresh keypairs it makes for the config and the mint and then forgets; the creator's signature is left empty. Answers `partialSignedTxBase64`, `mintAddress`, `creatorPubkey`, `creatorAddress` (the account's linked wallet, which the transaction was built for), a signed `prepareToken` that lasts 5 minutes, and the `preset` and `poolAddress`. |
| `POST /launch/submit` | yes | Takes `prepareToken` and `signedTxBase64`, the transaction signed by the creator's wallet. It is sent only if it carries the same message the server built, byte for byte (compared by sha256), names the expected mint and creator, and has every signature. Then the token is saved. Answers `tokenId`, `mintAddress`, `txSignature`, `treasuryPdaAddress` and `creatorLockupEnd`, which is `null` for a Meteora token. |
| `POST /launch/reconcile` | yes | Takes `prepareToken`, `mintAddress` and `txSignature`. Saves a token whose launch reached the chain but whose row was not written: after a `500 persistence_failed`, or after a launch that was sent and not seen confirmed. It asks the chain whether the mint exists before it writes anything, and it may be called again. |

Refused at prepare, before any wallet is asked to sign. Each of these is the creator's to fix
and answers `400` with the code as `error` and one sentence as `message`:

| Code | When |
| --- | --- |
| `invalid_preset` | An unknown preset, or one not offered on this network (`rehearsal` on mainnet). |
| `first_buy_not_supported` | A first buy above 0. The first buy is made on the token's page after launch. |
| `picture_required` | No picture: the agent has no icon and no link was typed. |
| `name_too_long` | The name is over 32 bytes of UTF-8. A letter with an accent or an emoji is more than one byte. |
| `symbol_too_long` | The symbol is over 10 bytes of UTF-8. |
| `metadata_link_too_long` | The transaction would be over 1,232 bytes. With the name and the symbol held to their limits, what is left to vary is the link to the uploaded metadata, so that is what the code names. |
| `picture_link_refused` | The picture's link may not be fetched (see "The picture" below). |

Also at prepare: `400 wallet_required`, `400 invalid_payload`, `404 agent_not_found`,
`400 not_eligible` (with `reasons`), `400 listing_required`, `502 picture_upload_failed` when the
picture could not be fetched or uploaded, and `502 launch_prepare_failed` for anything else.

At submit: `400 prepare_token_invalid` (bad or expired), `400 prepare_token_org_mismatch`,
`400 prepare_token_creator_mismatch`, `400 prepare_token_launchpad_mismatch`,
`502 launch_submit_failed` when nothing was sent or the node refused it,
`502 transaction_not_confirmed` with `signature` and `mintAddress` when it was sent and not seen
confirmed, and `500 persistence_failed` with `mintAddress` and `txSignature` when the launch is
on chain and the row could not be written. At reconcile: `400 mint_mismatch`,
`502 mint_check_failed`, `409 mint_not_on_chain`, `500 reconcile_failed`.

The launch transaction carries no compute-budget instruction: one would cost bytes the launch
does not have. It does not need one for a wallet's sake. A wallet adds its own fee instructions
only to a transaction nobody has signed yet, and the launch reaches the wallet already signed by
the config and the mint. So the check at submit stays strict: byte for byte. A unit test with the
real SDK pins that the launch holds no such instruction for any preset.

### The picture

A token needs a picture. It is the agent's icon, or, when the agent has none, a link the creator
types into the wizard's "Picture link" field, which travels as `imageUri`. The server fetches the
link (`apps/api/src/services/fetchImageBytes.ts`) and uploads the picture and the metadata to
`https://pump.fun/api/ipfs`, as a pump.fun launch does.

The link is one a person typed, and the request leaves from inside our network, so:

- A link that is not `http` or `https` is refused everywhere, before any request.
- Outside development and test, a link whose host is this machine or a private network is
  refused. The host's name is resolved first, and every redirect is checked the same way, up to
  three of them, so a public link cannot hand the server on to a private one.
- In development and test a local link is allowed: the demo's agents use the app's own icon.

Either refusal is `400 picture_link_refused`. The sentence never repeats the address that was
refused. A link that is allowed and then answers an error, is not a PNG, JPG, GIF or WebP image,
is over 5 MiB or is empty, becomes `502 picture_upload_failed`, the same code as a failure of the
upload service.

### The curve

Each of these answers `404 { "error": "token_not_found" }` when there is no token with that id
and `404 { "error": "not_a_curve_token" }` for a token that was not launched on Meteora.

| Route | Login | What it does |
| --- | --- | --- |
| `GET /:id/curve` | no | The pool as the chain has it: the `state` (`trading`, `full` or `graduated`), the price and the value of the supply in SOL, the SOL raised and the SOL it graduates at, the `progress`, the fee right now, the creator's address, what the creator can claim, the creator's share and locked tokens, the trading fees of the pool's whole life (`tradingFeesLamports`, `tradingFeesSol`), 24 `curvePoints` sampled from the pool's own config for a drawing, and the graduated pool's address once there is one. When the pool cannot be read it answers `503 { "error": "curve_unreadable" }`. It never guesses. |
| `POST /:id/trade/quote` | no | `{ side, amount, slippageBps }`: SOL in for a buy, tokens in for a sell. Answers what comes out, the least that will be accepted, the fee, the price afterwards, and how much of the amount the trade takes (`amountInUsed`, `amountInUsedRaw`). `400 invalid_amount` for an amount that is not a positive number the curve can take (when the SDK refuses a buy, the answer also carries `remainingLamports` and `remainingSol`); `409 curve_full` when the curve is not trading. A buy of more SOL than the curve has left to raise is not refused: it is quoted as a partial fill. |
| `POST /:id/trade/prepare` | yes | The quote's body plus the `wallet`. Answers an unsigned `transaction`, a `prepareToken`, the `quote` and `expiresAt`. |
| `POST /:id/trade/submit` | yes | `prepareToken` and `signedTransaction`. Answers the `signature`, the trade's amounts as the chain moved them, and `recorded`: false when the trade is confirmed on chain and its row could not be written. |
| `POST /:id/fees/prepare` | yes | `{ wallet }`. The wallet must be the pool's creator as the chain has it, or the answer is `403 not_the_creator`. `409 nothing_to_claim` when there is nothing. Answers the transaction, the prepare token and what is waiting (`claimableLamports`, `claimableSol`). |
| `POST /:id/fees/submit` | yes | Answers the `signature` and `claimedLamports`: what left the pool's SOL vault in the confirmed transaction. |
| `POST /:id/graduate/prepare` | yes | `{ wallet }`. Any wallet may pay. Answers one `step`, `locker` or `migrate`, its transaction, and `stepsLeftAfterThis`. `409 curve_not_full`; `409 already_graduated`, with the graduated pool's address. |
| `POST /:id/graduate/submit` | yes | Sends the step. After `migrate` it marks the token graduated and answers the DAMM v2 pool's address. If the pool moved and the row could not be written it answers `500 persistence_failed` with the signature and the address; the next read of the curve brings the row in line. |

**A buy is a partial fill.** A buy is built with the SDK's `swap2` in the mode `PartialFill`, and
quoted with `swapQuote2` in the same mode. A sell is `ExactIn`. The reason is the end of the
curve: a buy made with an exact amount in can run past the graduation threshold, and the program
then keeps the excess and gives no tokens for it. As a partial fill, a buy takes only what the
curve has left to sell. The quote says so: `amountInUsed` is smaller than `amountIn` for a buy
that would fill the curve, and equal to it otherwise. The least amount out is worked out for the
amount used, and the screen adds one line ("Only ... SOL is needed to fill the curve. The other
... SOL stays in your wallet."). The transaction is built with the whole amount typed: the SDK
wraps that whole amount as SOL before the swap and its closing instruction gives the rest back,
so the wallet must hold the whole typed amount even when only part of it is taken.

**Graduation takes one or two transactions**, and which is next is read from the pool's own
`migrationProgress`, not from whether a locker account exists. The `locker` step comes first when
the config locks tokens for the creator and the progress says the locker is not made. Otherwise
the step is `migrate`. The migrate transaction needs two more signatures than the payer's:
Meteora's SDK returns two position keypairs for the new pool, and the server signs with both
before it answers. They are made for that one transaction and hold no money.

### The prepare token

Every curve prepare answers a signed token that lasts 90 seconds. It carries who asked, for which
token and wallet, the prepared message itself (so that submit can see what a wallet changed, not
only that something did), whether the server signed first, the pool's two vaults, and what submit
must record. Submit refuses, before anything is sent:

- a bad or expired token, or one for another token or another kind of transaction:
  `400 prepare_token_invalid` with a `reason`;
- another user's or another organization's token: `403 prepare_token_not_yours`;
- a signed transaction that is not the one built, a missing signature, or a signature that is not
  a true one: `400 transaction_mismatch` with a `reason` (`undecodable`, `message_mismatch`,
  `missing_signature` or `bad_signature`).

A wallet that is not a Solana address is `400 invalid_wallet`. A transaction that could not be
built is `502 build_failed`, and one the node refuses is `502 send_failed`.

### What submit accepts

There are two kinds of prepared transaction, and the token says which (`strict`).

**Signed by the server first** (the `migrate` step, and the launch): the signed message must be,
byte for byte, the prepared one. A wallet leaves a transaction that already carries a signature
as it is, so nothing else needs to be allowed.

**Signed by the wallet alone** (a buy, a sell, a fee claim, the `locker` step): a wallet may
change what it is asked to sign. Phantom, for one, adds its own priority-fee instructions (the
ComputeBudget program) to a transaction that has no signature yet, and may add Lighthouse
assertion instructions. A byte-for-byte check would refuse every such transaction. So two things
are done:

1. The prepared transaction already begins with a compute-unit limit and a compute-unit price,
   so a wallet has no reason to add its own: 200,000 units for a trade or a claim, 400,000 for
   the locker, at a price of 1 micro-lamport. Only what the SDK's instructions do not already
   carry is added.
2. The check (`checkSignedTransaction` in `apps/api/src/services/meteoraCurve.ts`) passes the
   same bytes, and also passes a message for which ALL of these hold: it is a v0 message; the
   fee payer is the same; the set of required signers is the same; it uses the same address
   lookup tables (the prepared message uses none); every instruction that was prepared is there,
   in the same order, with the same program, the same accounts (addresses, with the same signer
   and writable flags) and the same data; and every other instruction belongs to the
   ComputeBudget program (`ComputeBudget111111111111111111111111111111`) or to Lighthouse
   (`L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95`).

Those two programs can cost the signer a fee or make the transaction fail; they cannot move
anything. A changed amount, an added transfer, another fee payer, an extra signer, a reordered or
removed instruction, a lookup table and any other program are each refused and never sent. The
recent blockhash is not compared for a wallet-signed transaction: a wallet that puts in a fresher
one changes how long the transaction may wait and nothing else.

For both kinds every signature slot must be filled, and every signature is verified (ed25519)
against its signer over the signed message. The node makes the same check when a transaction is
sent, but a submit does not always send (see below), so the server makes it too.

### A transaction that was sent and not seen confirmed

A transaction that was sent must not lose its record because the wait for its confirmation
failed. So a curve submit may be posted again with the same body, and works like this:

1. Before sending, the server asks the chain once for the status of the signed transaction's own
   signature. Succeeded: nothing is sent, and the route records it as it would have (a trade row
   is unique by signature, and a graduation's write is the same write). Failed on chain:
   `409 { "error": "transaction_failed", "signature", "message" }` and nothing is recorded.
2. Not seen: the transaction is sent, unless the prepare token has run out, which is
   `400 prepare_token_invalid` with the reason `expired`.
3. After a send, when the wait for the confirmation fails or times out, the server asks once
   more. Succeeded carries on as confirmed. Failed is the `409` above. Anything else is
   `502 { "error": "transaction_not_confirmed", "signature", "message" }`.

A prepare token that ran out less than ten minutes ago is still accepted for one purpose: to
record a transaction that has already succeeded on chain. Every other check on it is made the
same. An expired token is never a reason to send something.

On the screens, a trade, a claim or a graduation step answered with `transaction_not_confirmed`
shows that it was sent and is not confirmed yet, a link to the transaction on the explorer, and a
button "Check again" that posts the same body once more. `transaction_failed` says Solana refused
it and nothing was taken but the network fee, with the same link. Neither loses what was typed.

The launch differs. Its not-confirmed answer is `502 transaction_not_confirmed` with `signature`
and `mintAddress`, and the wizard's "Check again" calls `POST /launch/reconcile` with the prepare
token, that mint and that signature. It does not post `/launch/submit` again, which would send
the transaction again. `/launch/reconcile` has no allowance for an expired token: after the
launch's prepare token runs out (5 minutes), it answers `400 prepare_token_invalid`.

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

### What a launch saves

With no migration and no change to the schema, a Meteora token is a row of `AgentToken` with:

| Column | Holds |
| --- | --- |
| `launchpad` | `meteora` |
| `mintAddress` | The mint. |
| `creatorAddress` | The account's linked wallet, which signed the launch. |
| `meteoraConfigKey` | The curve config's address. |
| `bondingCurveAddress` | The pool's address. |
| `curveSupply` | The whole tokens this preset's curve sells before it is full. |
| `reservedSupply` | The rest of the 1,000,000,000: what goes into the graduated pool and what is locked for the creator. |
| `creatorLockupEnd` | `null`. On `community` nothing is ever locked; on the others the lock starts at graduation, and the date is written then. |
| `status` | `BONDING`. |

The supply split is taken from the builder's output for the preset, with the SDK's own sum over
the curve, not from a constant. A part of a token is not counted as sold, so the two always add
up to the whole supply:

| Preset | `curveSupply` | `reservedSupply` |
| --- | --- | --- |
| `community` | 799,999,986 | 200,000,014 |
| `committed` | 706,513,339 | 293,486,661 |
| `long` | 776,393,195 | 223,606,805 |
| `rehearsal` | 621,884,518 | 378,115,482 |

`pumpfunUrl` is not written for a Meteora token. As for every launchpad, the launch also writes
an `AgentTreasury` row with the treasury address derived from the mint; the launch creates
nothing on chain for it. A pump.fun or Bags token keeps what it had: the columns' default supply
split and a `creatorLockupEnd` of the launch plus 30 days.

### What graduation saves

| Column | Holds |
| --- | --- |
| `status` | `GRADUATED`. Only a row that says `BONDING` is changed, so a repeat changes nothing. |
| `graduatedAt` | When our migrate step was confirmed. For a pool found already graduated, when we noticed. |
| `raydiumPoolId` | The DAMM v2 pool's address. The column's name is older than this use. |
| `creatorLockupEnd` | For a config that locks tokens: the pool's `finishCurveTimestamp` plus the config's wait. Left alone for a config that locks nothing, or a pool that does not say when its curve was finished. |

A pool can graduate without us: on mainnet Meteora's own service graduates full pools. The
chain's word is what every answer says, and a row that still says `BONDING` is brought in line by
whichever read of that token's curve first sees it: `GET /:id/curve`, a quote, or any prepare.
Nothing does that on a schedule, so a graduated token that nobody opens keeps a `BONDING` row
until somebody does. A repair that fails is logged and tried again on the next read.

### Trades

Each trade made through WheelsAI and confirmed writes one row of `AgentTokenTrade`. The
signature is unique, so a repeat is not written twice. Both amounts come from the pool's two
vaults in the confirmed transaction: for a buy the SOL is what the SOL vault gained and the
tokens are what the token vault lost; for a sell the reverse. What the wallet asked to spend is
not used, because a buy that fills the curve takes less than was asked. If either vault's change
cannot be read, both of the prepared quote's numbers are written (for a buy, the SOL the quote
said the trade takes) and the log says so.

A trade of the same token made outside WheelsAI, with any other tool, is on chain and moves the
price the curve route shows. It is not in `AgentTokenTrade`: nothing reads a Meteora pool's
history.

### Two older workers leave Meteora tokens alone

- **The pump.fun trade indexer** (`apps/api/src/services/buildTokenIndexerOuterTickDeps.ts`)
  takes only tokens whose `launchpad` is `pumpfun`.
- **The fee router** (`apps/api/src/services/loadUnroutedFeesByPrisma.ts`) pays 1% of a token's
  recorded volume from the router's wallet, a rule written for pump.fun tokens. A Meteora token
  shares its trading fees on chain, through the curve itself, and its trades sit in the same
  table. Routing 1% of that volume would pay for fees the router never received, so the router
  takes pump.fun tokens' trades only. A token on any other launchpad, or whose launchpad cannot
  be read, is left out.

## 5. The devnet walk

### What has already run against devnet

Two scripts ask devnet to simulate what the feature builds. They sign nothing and send nothing:
the simulations run with signature checks off, against a named address that holds devnet SOL and
against pools other people made. Both were run on 2026-10-12, after this round's changes.

`apps/api/scripts/meteora-devnet-probe.ts` builds the SDK's calls directly, and with `--presets`
builds the launch through the server's own adapter for each curve on offer. Devnet accepted:

| Step | Size | Signatures |
|---|---|---|
| The launch, each of the four curves, through the adapter | 1,127 of 1,232 bytes | 3 |
| A buy as a partial fill, with the two compute-budget instructions | 728 bytes | 1 |
| The locker for the creator's locked tokens | 651 bytes | 1 |
| The move into DAMM v2 | 1,141 bytes | 3 |

The launch was measured with a name of 18 bytes, a symbol of 7 and a metadata link of 80 bytes,
which is the length of the link the upload returns. A quote for a buy far larger than a curve can
take answered with the part it would use, not with an error.

`apps/api/scripts/meteora-bindings-probe.ts` runs the curve routes' own chain wiring
(`routes/tokenCurveBindings.ts`): the reads as the routes make them, and each transaction as the
routes build and compile it. Devnet accepted:

| Step | Size | Signatures | Compute units |
|---|---|---|---|
| A buy of 0.01 SOL | 728 bytes | 1 | about 63,000 |
| The creator's fee claim, the creator paying and signing alone | 671 bytes | 1 | about 34,000 |
| The locker step | 703 bytes | 1 | about 59,000 |
| The move into DAMM v2 | 1,141 bytes | 3 | about 142,000 |

It also settled what the pool's `migrationProgress` holds. A full pool whose config locks tokens
read 1: devnet accepted the locker for it and refused the move. A full pool with nothing to lock
read 2: devnet accepted the move and refused the locker. A pool still trading read 0.

One upload of a picture and its metadata through the uploader the launch uses was made that day
and answered in under three seconds with a link of 80 bytes.

Devnet's public RPC answered 429 to the first probe's heavier calls, which is why the server
keeps what it reads.

That shows the chain accepts what the server builds. It does not show the feature: no route was
called, no screen and no browser wallet took part, and no transaction was sent.

### Before the walk

- An API with `LAUNCHPAD=meteora`, `SOLANA_NETWORK=devnet`, `METEORA_FEE_CLAIMER_ADDRESS` set to
  an address the founder controls, `WALLET_MASTER_KEY` set, and a devnet `SOLANA_RPC_URL`.
- The web app built for devnet (`NEXT_PUBLIC_SOLANA_CLUSTER`, `NEXT_PUBLIC_SOLANA_RPC_URL`) with
  the token pages on (`NEXT_PUBLIC_ENABLE_TOKEN_UI`, `NEXT_PUBLIC_ENABLE_TRADING`).
- Phantom set to devnet, holding devnet SOL. The `rehearsal` curve is full at 0.348 SOL raised
  (347,644,118 lamports); the wallet also pays the fees on its buys, the network's fees, and the
  rent of the accounts the launch and the graduation create.
- An account whose linked wallet is that Phantom wallet: sign in with it, or link it under
  Settings. The wizard compares the connected wallet with the one the launch was prepared for
  and does not ask for a signature when they differ.
- An agent with a published listing and a running deployment that passes the launch gate. If the
  agent is new, lower `TOKEN_LAUNCH_MIN_REPUTATION` and `TOKEN_LAUNCH_MIN_DEPLOYMENT_AGE_DAYS`
  on this devnet server only, and write the values used into the table below.
- A picture for the token: the agent's icon, or a link to type into the wizard. On a server whose
  `NODE_ENV` is not `development` the link must be a public one.

### The steps

Every step is done by a person, in the browser, signing in Phantom.

1. **Connect.** Sign in to WheelsAI with Phantom on devnet.
2. **Launch.** Open the launch wizard for the agent. Choose the "Devnet rehearsal" curve, type a
   picture link if the agent has no icon, review (the last step says what the curve locks for
   you), launch, and sign once. The success screen links to the token's page and to the
   transaction on Solana's explorer.
3. **Read the curve.** On the token's page the "Curve" card shows "Trading on the curve", the
   price, the fee right now, "0 of 0.347644118 SOL raised", and the pool's address. With no price
   history yet, the chart is the token's curve with a dot at the price now.
4. **Buy.** Type a small amount of SOL in the trade panel, read the quote (what you get, the
   least you will accept, the fee), buy, and sign. The card's raised SOL and price move. Note in
   the table whether Phantom added instructions of its own: the server's log says so when it did.
5. **Sell.** Sell part of what was bought, and sign.
6. **Claim.** With the creator's wallet connected, the creator's card shows what can be claimed.
   Claim, and sign.
7. **Fill the curve.** Buy until the card says "The curve is full: it can graduate". A buy of
   more SOL than the curve has left to raise is not refused: the quote says how much is needed
   to fill the curve and that the rest stays in the wallet. The wallet must hold the whole
   amount typed.
8. **Graduate.** Press Graduate. The `rehearsal` preset locks tokens for the creator, so there
   are two steps, each signed once: the locker, then the move to the Meteora pool. The card then
   says "Graduated to a Meteora pool" and shows the DAMM v2 pool's address.

If a step answers that the transaction was sent and is not confirmed yet, open its link on the
explorer and press "Check again". Write down that it happened.

### What counts as proof

For each step below: the transaction's signature, opened on `https://explorer.solana.com` with
`?cluster=devnet` and showing success, and what the screen said afterwards. Together with:

- the pool's address on the explorer, owned by Meteora's DBC program, and the DAMM v2 pool's
  address after graduation;
- the token's `AgentToken` row: `launchpad`, `meteoraConfigKey`, `bondingCurveAddress`,
  `curveSupply` 621,884,518 and `reservedSupply` 378,115,482, a `creatorLockupEnd` of `null`
  after launch, then `status = GRADUATED`, `graduatedAt`, `raydiumPoolId` and a
  `creatorLockupEnd` 600 seconds after the moment the curve became full;
- one `AgentTokenTrade` row for the buy and one for the sell, with the same signatures, and for
  the buy that filled the curve a SOL amount smaller than the amount typed;
- the SOL the creator's wallet received from the claim, as the explorer shows it, equal to the
  `claimedLamports` the route answered;
- the pool's `migrationProgress`, read from the pool account before the locker, after the locker
  and after the move. The code takes those to be 1, 2 and 3; the SDK gives the values no names,
  so the walk is the first check of them.

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
| `AgentToken` row (status, graduatedAt, raydiumPoolId, creatorLockupEnd) | |
| `AgentTokenTrade` rows (count, signatures) | |
| Whether the wallet added instructions of its own, and to which steps | |
| `migrationProgress` before the locker, after it, after the move | |
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
- **Taking released tokens out of the locker.** The locker releases the creator's tokens on the
  preset's schedule. No route or screen of WheelsAI takes them out for the creator.
- **A history of trades made elsewhere.** No indexer reads a Meteora pool, so trades made
  outside WheelsAI are not in our tables.
- **A scheduled check of graduated pools.** A row is brought in line when its curve is read, not
  by a worker.
- **A dollar price for a Meteora token in the lists.** Nothing in this feature writes a dollar
  price or a market value to the token's row. Where the row's dollar price is zero, the token
  list and the token card say "On a Meteora curve" or "Graduated to a Meteora pool" instead.
- **Tokens for workflows and models.** Only an agent with a published listing can launch one.
- **A real launch on mainnet.** Nothing here has run on mainnet. The presets have been built by
  Meteora's curve builder and never launched.

Known limits of what is built are in `docs/HARDENING-BACKLOG.md`, section "Agent tokens on
Meteora". What only the founder can do is in `docs/FOUNDER-ACTIONS.md`, section 9.
