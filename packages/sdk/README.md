# @wheelsai/sdk

Typed TypeScript client for the WheelsAI API. Every method is one HTTP call to a documented
endpoint, and unit tests pin each method's path, verb and body. It has no runtime
dependencies, and the [CLI](../cli) is built on it. Build it from a checkout of this
repository (see [Build and test](#build-and-test)).

```ts
import { WheelsAI, WheelsAIError } from "@wheelsai/sdk";

const wheels = new WheelsAI({
  baseUrl: process.env.WHEELSAI_API_URL!,
  apiKey: process.env.WHEELSAI_API_KEY, // wheels_live_...; sent as `Authorization: Bearer`
});

// Only a name is needed. The agent's OpenAI-compatible API is on as soon as it exists.
const { agent } = await wheels.agents.create({ name: "My support bot" });
const reply = await wheels.agents.chatCompletion(agent.slug, {
  messages: [{ role: "user", content: "How long do refunds take?" }],
});

const { agents } = await wheels.agents.list();
const found = await wheels.agents.resolve("my-support-bot"); // slug or id, one request

// A dedicated GPU is optional. Ask what the server can do before starting one.
const { agentGpu } = await wheels.platform.capabilities();
if (agentGpu.available) {
  const tiers = await wheels.models.gpuTiers();              // the GPU tiers open for deployment now
  const { deployment } = await wheels.agents.deploy(agent.id, { gpuTier: tiers[0]!.id });
  const { deployment: row } = await wheels.agents.getDeployment(agent.id, deployment.id);
}
```

When `agentGpu.available` is `false`, `agents.deploy` throws a `WheelsAIError` with status 501
and code `agent_gpu_unavailable`. Nothing is reserved or charged, and the agent keeps answering
on its API.

## Creating an agent

Only a name is needed. An agent is one of three kinds, which decides how people use it:
`conversation` (they talk to it; the default), `task` (made for one request in and one result
back, with a form that says what a request holds) or `scheduled` (made to run on its own at set
times). Every kind still answers a chat.

```ts
const { agent } = await wheels.agents.create({ name: "Release notes helper" });
// agent: { id, name, slug, framework, agentKind, apiEndpoint, openaiBaseUrl, openaiModel }

// A task agent with its form. A question's `key` is its name in code; left out, it is made
// from the label ("Code to review" -> code_to_review) and then kept.
await wheels.agents.create({
  name: "Code review",
  agentKind: "task",
  systemPrompt: "Review the code you are given and list the problems, most serious first.",
  kindConfig: {
    task: {
      fields: [
        { label: "Code to review", type: "long_text", required: true, help: "Paste the code or the diff." },
        { label: "What to look for", type: "choice", options: ["Everything", "Bugs", "Security"] },
      ],
    },
  },
});

// From a template: its values are the defaults, and what you send replaces them field by field.
await wheels.agents.create({ name: "Support desk", templateId });

// Change the kind later. Settings are kept per kind, so changing back loses nothing.
// The schedule here is a suggestion stored with the agent: saving it starts no runs.
await wheels.agents.update(agent.id, {
  agentKind: "scheduled",
  kindConfig: { scheduled: { schedule: { cronExpression: "0 9 * * *", timezone: "UTC" } } },
});
```

A form has 1 to 12 questions of type `short_text`, `long_text`, `number`, `choice` (2 to 50
`options`), `yes_no`, `link` or `list`. Inside `kindConfig`, a key you send (`task` or
`scheduled`) replaces that key and the other stays; `null` removes it. `agents.list()`,
`agents.get()`, marketplace listings (`listing.agent.agentKind`) and versions carry the kind;
a rollback restores the kind and settings a version recorded.

`platform.capabilities()` says what the server can do right now: the models an agent can answer
on (`chat.models`, `chat.defaultModel`) and whether `payouts`, `emailDelivery`, `agentGpu` and
`paidTasks` are `available`.

## Talking to an agent

Every agent has an OpenAI-compatible endpoint on the API, on as soon as the agent exists. Each
agent row says where: `apiEndpoint`, `openaiBaseUrl` and `openaiModel` (`agent/<slug>`); the
two URLs are `null` when they cannot be determined.

```ts
// One call, OpenAI's response shape. `tools` are functions YOU run: they come back as
// message.tool_calls with finish_reason "tool_calls"; send a `tool` message per call to continue.
const reply = await wheels.agents.chatCompletion(
  "my-support-bot",
  { messages: [{ role: "user", content: "How long do refunds take?" }] },
  { timeoutMs: 120_000 },
);
console.log(reply.choices[0]?.message.content, reply.wheelsai?.model);

// The same on the unified base, where `model` picks an agent, a workflow or a model deployment:
const { data: models } = await wheels.inference.listModels(); // free: not a metered call
await wheels.inference.chat({ model: "agent/my-support-bot", messages: [{ role: "user", content: "Hi" }] });

// A workflow answers as a chat completion too: one call is one run, and its output is the answer.
const { orchestrations } = await wheels.workflows.list();
const workflow = orchestrations[0]; // .slug, .apiEndpoint, .openaiBaseUrl, .openaiModel ("workflow/<slug>")
const result = await wheels.workflows.chatCompletion(
  workflow.slug,
  { messages: [{ role: "user", content: "Changes merged this week: ..." }] },
  { timeoutMs: workflow.timeout + 60_000 }, // a client that gives up first cancels the run
);
console.log(result.choices[0]?.message.content, result.wheelsai?.workflow.executionId);
```

These methods return whole responses. For streaming, point the official OpenAI client at
`agent.openaiBaseUrl` (or `<api>/v1` with `model: "agent/<slug>"` or a deployment's slug) with your
WheelsAI API key. Model deployments stream and take `tools` too.

`agents.update(id, { entrypoint: "graph" })` makes an agent answer through its saved graph, and
`agents.usage(id, "7d")` returns its requests, errors, tokens and latency.

`agents.hostedModels()` lists the models your organization runs on its own deployments, as model
choices for an agent; `agents.playgroundModels(id)` carries the same list as `hostedModels`, beside
the free and own-key models.

```ts
const { hostedModels } = await wheels.agents.hostedModels();
const mine = hostedModels.find((m) => m.available); // .id is "wheelsai/<model id>", .deployment.slug
if (mine) await wheels.agents.update(agent.id, { modelConfig: { externalModel: mine.id } });
```

An agent set to one of these answers from that deployment, and only while the deployment is running
(`available`). `state` says why not: `starting`, or `not_answering`. Its GPU time is billed by the
second on the deployment.

## Using an agent you pay for

A listing sells either use of the creator's own agent (the default) or copies. Someone who pays to
use an agent never gets a copy or its instructions: they start using it, then chat with it or run it.
Each use is charged when it is sent and refunded if no answer is delivered; a monthly price charges
30 days at a time. The answer arrives whole.

```ts
// What it asks and where you stand. Needs sign-in; 404 agent_not_found.
const { access, terms, balanceCents, canAccept } = await wheels.use.access("refund-helper");

// Agree to the price you were shown (an owner or admin, or a key granted marketplace:install).
// A changed price answers 409 pricing_changed with the new pricing; pass acceptNewPricing to continue.
const { listing } = await wheels.marketplace.get("refund-helper-bot");
await wheels.marketplace.startUsing(listing.id, {
  expected: { pricingModel: listing.pricingModel, pricePerRequestCents: listing.pricePerRequestCents, monthlyPriceCents: listing.monthlyPriceCents },
});

const answer = await wheels.use.chat("refund-helper", { messages: [{ role: "user", content: "How long do refunds take?" }] });
console.log(answer.message.content, answer.billing.chargedCents, answer.billing.balanceCents);

// A task agent takes its form's answers; a self-running agent's results are read, not asked for.
const run = await wheels.use.run("brief-writer", { input: { topic: "Q3 churn" } });
const { results, hasMore } = await wheels.use.results("daily-brief");

await wheels.marketplace.stopUsing(listing.id); // a subscription ends now, with no refund
```

`use.chat` and `use.run` need an API key granted `agents:use`, created with both caps:
`auth.createApiKey({ scopes: ["agents:use"], maxUsePriceCents: 50, dailySpendCapCents: 2000 })`. A
refusal throws a `WheelsAIError` whose `data` is a `UseRefusal`; show its `message` as it comes. Two to
know: `not_a_member` (403) when you are no longer a member of the paying organization, and
`copy_subscription_active` (409 on `marketplace.startUsing`, with `until`) when you hold a copy of the
agent with a month paid for; `use.access` then carries `startBlocked` and `canAccept` is false. The
same agent answers `inference.chat({ model: "a/refund-helper", ... })`. To sell, `marketplace.createListing`
takes `sells` (`"use"` by default, or `"copies"`), `allowedTools` and `publish`.

## Hiring an offering

An offering is a fixed task a publisher's agent, workflow or model runs for a set price. Hiring
puts the price in escrow; it is released when you accept the deliverable and refunded when the
job is rejected, fails its checks, expires or is cancelled.

```ts
const { offerings } = await wheels.offerings.search({ productKind: "agent", query: "brief" });
const offering = offerings[0]!;

const { job } = await wheels.offerings.hire(
  offering, // the offering as you read it: its price, delivery time and termsVersion are sent along
  { topic: "GPU rental prices" }, // must match offering.inputSchema
  { idempotencyKey: "order-42" }, // a retry with the same key returns this job, charged once
);

let current = (await wheels.jobs.get(job.id)).job;
while (current.status === "funded" || current.status === "running") {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  current = (await wheels.jobs.get(job.id)).job;
}
if (current.status === "submitted") {
  console.log(current.output?.text);
  await wheels.jobs.accept(job.id, { rating: 5 }); // or wheels.jobs.reject(job.id, "why")
}
```

A publisher can edit an active offering. Passing the offering object holds the hire to the terms
you read: if its price, delivery time, checks or instructions changed since, the hire is refused
with 409 `offering_terms_changed`, nothing is charged, and `err.data.current` has the terms as they
are now. Hiring by id (`hire(offering.id, ...)`) sends no expected terms unless you pass
`{ expected: { priceCents } }`; an API key is then hired at the current terms, inside its per-job
cap.

An API key can hire only when it was granted `jobs:hire` by name, with both spend caps; accepting
and rejecting need `jobs:review`. A key with no scopes, or with `*`, cannot spend:

```ts
await wheels.auth.createApiKey({
  name: "buyer agent",
  scopes: ["jobs:hire", "jobs:read", "jobs:review"],
  maxJobPriceCents: 500, // the most one job may cost
  dailySpendCapCents: 2000, // the most the key may spend in one UTC day
});
```

Publishers use `offerings.create`, `update`, `validate`, `testRun`, `activate`, `pause` and
`archive`, and read incoming jobs with `jobs.list({ role: "publisher" })`.

An offering's form is its `inputSchema`, and its questions keep the order you saved them in. For a
task agent, `offerings.create({ ..., fromAgentForm: true })` takes the agent's own form in place of
an `inputSchema` (both together are a 400; an agent that is not a task agent is 409
`not_a_task_agent`). Your offering then answers `formInSync`: `false` once the agent's form was
edited, until `offerings.update(id, { fromAgentForm: true })` shows buyers the new one.

### Payouts

Take your earnings out as credits, or to a Solana wallet in USDC or SOL. `revenue()` says what a
request may ask for right now:

```ts
const { pendingPayoutCents, payoutLimits } = await wheels.marketplace.revenue();
// payoutLimits: { minimumCents, perPayoutCents, perDayCents, usedTodayCents,
//                 largestNowCents: { credits, wallet }, methods }

if (payoutLimits.methods.includes("crypto_usdc") && payoutLimits.largestNowCents.wallet >= payoutLimits.minimumCents) {
  const { payout, remainingCents, message } = await wheels.marketplace.requestPayout({
    payoutMethod: "crypto_usdc",
    payoutAddress: "<your Solana wallet address>",
    amountCents: payoutLimits.largestNowCents.wallet, // leave out to take the largest allowed
  });
  console.log(message, remainingCents, payout.status);
}
```

Amounts are whole cents. The smallest payout is $5.00 for every method; read it from
`minimumCents`. Credits can take any amount from the minimum up to your earnings. A
payout to a wallet also has a limit per payout and per UTC day (`perPayoutCents`, `perDayCents`,
with `usedTodayCents` already counted), and `methods` lists what is offered now. One payout can be
open at a time. Requesting needs a session token (`auth.login`) of an owner or admin; an API key
is refused.

A refused request reserves nothing and throws a `WheelsAIError` whose `message` is a sentence you
can show as it comes:

| `code` | Status | When |
| --- | --- | --- |
| `payouts_unavailable` | 503 | Payouts are not running. |
| `invalid_payload` | 400 | The request could not be read. |
| `payout_method_unavailable` | 400 | The method is not offered right now. |
| `payout_in_progress` | 409 | You already have an open payout. |
| `payout_below_minimum` | 400 | The amount, or your earnings, is under the minimum. |
| `payout_above_balance` | 400 | The amount is more than your earnings. |
| `payout_above_limit` | 400 | More than one payout to a wallet may be. |
| `payout_daily_limit` | 409 | Today's limit for payouts to a wallet is reached. |
| `payout_address_required` | 400 | A wallet method with no `payoutAddress`. |
| `invalid_payout_address` | 400 | The address is not a Solana wallet address, is a token account or a program, or belongs to WheelsAI. |
| `payout_check_unavailable` | 503 | The address could not be checked. Try again shortly. |
| `payout_reservation_conflict` | 409 | Your earnings changed during the request. Try again. |

```ts
const { payouts } = await wheels.marketplace.payouts();
const waiting = payouts.find((p) => p.cancellable);
if (waiting) await wheels.marketplace.cancelPayout(waiting.id); // the amount goes back to your earnings
```

`cancellable` is true while a payout is requested and not yet being sent; after that
`cancelPayout` answers 409 `payout_not_cancellable`. A payout carries `message`, a plain sentence
when there is something to say (a payout waiting to be sent, or one that failed) and `null`
otherwise. A failed payout also carries `failureReason`, and its amount is already back in your
earnings. Cancelling needs a session token (`auth.login`) of an owner or admin.

### Reading your credits

What is available, what is held and why, what the month cost by kind, and the ledger itself.
Every amount is in dollars. Works with an API key or a session.

```ts
const { balance } = await wheels.billing.getBalance();
console.log(balance.available, balance.held, balance.total); // total = available + held

const { holds } = await wheels.billing.getHolds();
for (const hold of holds) console.log(hold.name, hold.amount, hold.note);

const { usage } = await wheels.billing.getUsage(); // this UTC calendar month
console.log(usage.month, usage.currentMonth, usage.gpuHours);
for (const line of usage.spend) {
  if (line.amount !== 0) console.log(line.label, line.amount);
}

// The ledger, newest first, a page at a time.
let cursor: string | undefined;
do {
  const page = await wheels.billing.getTransactions({ limit: 100, cursor, filter: "spent" });
  for (const row of page.transactions) console.log(row.createdAt, row.label, row.amount, row.balanceAfter);
  cursor = page.nextCursor ?? undefined;
} while (cursor);

// The same rows as a CSV file's text, oldest first.
const csv = await wheels.billing.exportTransactions({ from: "2026-09-01", to: "2026-09-30" });
```

- `balance.held` is what is set aside for things that are running or awaited, and it is the
  total of `getHolds()`. `balance.pending` is the same figure, kept for older callers.
- A hold has a `kind` (`deployment`, `agent_deployment`, `fine_tuning`, `job` or `try_it`), the
  `name` you gave the thing, `since`, and `note`: a sentence that says when it comes back.
- `usage.spend` has one line for each kind of spending, always in the same order, zero included.
  An `amount` is what was charged less what came back, so it can be below zero. `currentMonth` is
  their sum.
- A transaction's `amount` carries its own sign and `balanceAfter` is your balance after it.
  `label` is what the row is called, ready to show. `kind` is `added`, `spent`, `returned`,
  `held`, `released`, `taken_back` or `other`.
- `getTransactions` takes `limit` (1 to 200, 50 when left out), `cursor` (the `nextCursor` of the
  page before; it is `null` on the last page) and `filter` (`added`, `spent` or `held`).
- `exportTransactions` takes `from` and `to` as UTC days (`YYYY-MM-DD`, `to` included). Give both
  or neither: with neither, the file covers the current UTC month up to today. Its columns are
  Date (UTC), Type, What, Description, Amount (USD) and Balance after (USD).

| `code` | Status | When |
| --- | --- | --- |
| `invalid_request` | 400 | `getTransactions`: `limit`, `cursor` or `filter` cannot be read. |
| `invalid_range` | 400 | `exportTransactions`: a date cannot be read, `to` is before `from`, or only one was given. |
| `range_too_large` | 400 | `exportTransactions`: the range holds more than 100,000 rows. Choose a shorter range. |

Changed in 0.2.0: `UsageSummary` no longer has `avgCostPerHour`, `computeCost`, `requestsCost`,
`tokensCost` or `metered`; read `spend` and `gpuHours` instead. `getTransactions` answers
`nextCursor` beside `transactions`.

### Adding credits from a wallet

Pay in USDC or SOL from a Solana wallet. The API prepares the transfer, the wallet signs it, and
the credits are added once the network confirms it, exactly once.

```ts
const { rails } = await wheels.billing.packages();
// rails.wallet says whether wallet payments are open; rails.walletAssets lists "USDC" and, when offered, "SOL".

const prepared = await wheels.billing.topups.prepare({
  amountUsd: 50,
  asset: "USDC",
  payerAddress: wallet.publicKey.toBase58(), // the wallet that signs and pays
});
console.log(prepared.message); // a sentence for the person paying

// Sign prepared.unsignedTxBase64 with that wallet and encode the signed transaction as base64.
const signedTxBase64 = await signWithYourWallet(prepared.unsignedTxBase64);

let result = await wheels.billing.topups.submit(prepared.topupId, signedTxBase64);
while (!isTopupFinal(result.status)) {
  await new Promise((r) => setTimeout(r, 3000));
  result = await wheels.billing.topups.reconcile(prepared.topupId);
}
console.log(result.message); // "Added $55.00 in credits: $50.00 paid and a $5.00 bonus."
```

`isTopupFinal` is exported by the package. `signWithYourWallet` stands for your own signing code:
the wallet signs the prepared transfer as it is. A wallet may add its own fee setting; any other
change is refused with `message_mismatch` and nothing is sent.

- `payerAddress` is the wallet that pays. It does not have to be linked to your account. With a
  session that signed in with a wallet you can leave it out, and that wallet pays; with neither,
  `prepare` answers 400 `wallet_required`.
- A SOL top-up carries `quote: { solPriceUsd, validUntil }` and holds its price for 60 seconds. A
  USDC top-up has `quote: null` and can be sent for 120 seconds. `amountRaw` is the amount the
  wallet sends in base units, as a string.
- `submit` answers `status: "credited"` with `grantedUsd` and `balanceUsd` when the transfer was
  confirmed during the call. Otherwise `pendingConfirmation` is true: the credits are added when
  the network confirms the transfer, whether or not you keep asking. `reconcile` checks now and is
  safe to repeat. Sending the same signed transfer again answers where the top-up stands.
- `topups.get(id)` reads one top-up and `topups.list()` your organization's last 20, newest first.
  Each has a `status` (`prepared`, `submitting`, `submitted`, `credited`, `failed`, `expired`) and
  a `message`, a plain sentence that says where it stands.
- A refusal is a `WheelsAIError` whose `code` is the API's (`invalid_amount`,
  `invalid_payer_address`, `asset_unavailable`, `price_unavailable`, `wallet_balance_short`,
  `topup_expired`, `in_flight` and the others in the API reference) and whose `message` is a
  sentence you can show as it is.

### Adding credits by sending to your address

Your organization has its own address for USDC and SOL on Solana. Send to it from an exchange or
from any wallet: there is no top-up to prepare and nothing to sign here, and each transfer is
added to your credits once.

```ts
const { rails } = await wheels.billing.packages();
if (rails.deposits) {
  let deposit = await wheels.billing.depositAddress.get();
  if (!deposit.address) deposit = await wheels.billing.depositAddress.issue(); // safe to repeat
  console.log(deposit.address, deposit.network);
  console.log(deposit.message); // "Send USDC or SOL on Solana to this address. It belongs to ..."

  // After you have sent a transfer, look for it now instead of waiting:
  const { credited, waiting, message } = await wheels.billing.depositAddress.check();
  console.log(message); // "Credited $55.00 from your transfer: $50.00 sent and a $5.00 bonus."

  const { deposits } = await wheels.billing.deposits.list(); // the last 20, newest first
}
```

- `depositAddress.get()` never creates anything: `address` is `null` until `issue()` is called.
  An organization has one address, and `issue()` always answers with it.
- `assets` says what the address can receive. The USDC entry has `accountOpen`, and the SOL entry
  has `offered`: while it is false, send USDC only.
- Send on the Solana network named in `network`, and only USDC or SOL.
- USDC is credited one dollar for one USDC. SOL is credited at its dollar value when the transfer
  is seen. Transfers are usually credited within a few minutes without any call from you;
  `check()` looks now, is safe to repeat and never credits a transfer twice.
- `check()` answers `credited` (what this call added: `amount` in whole units as a string,
  `creditedUsd` and `bonusUsd` in dollars) and `waiting` (a SOL transfer that was seen while no
  current SOL price could be read; it is credited as soon as one can).
- A deposit in `deposits.list()` has a `status` (`credited`, `waiting` or `ignored`, a transfer
  too small to credit) and a `message`, a plain sentence that says where it stands.
- If a sender says the address cannot receive USDC yet, call `depositAddress.prepareUsdc()`. It
  answers `{ accountOpen: true, message }` once the address can, and can take up to a minute, so
  it waits 90 seconds by default (`prepareUsdc({ timeoutMs })` changes that).

A refusal is a `WheelsAIError` whose `message` is a sentence you can show as it is:

| `code` | Status | When |
| --- | --- | --- |
| `deposit_address_not_issued` | 404 | `prepareUsdc` or `check` before the address was issued. |
| `not_eligible` | 403 | `prepareUsdc`: verify your email or make one purchase first. |
| `daily_limit` | 429 | `prepareUsdc`: the address cannot be prepared right now. Try again later. |
| `unavailable` | 503 | `prepareUsdc`: the address cannot be prepared right now. Try again later. |
| `chain_unavailable` | 503 | `check`: deposits are paused for a moment. Nothing sent is lost. |
| `deposit_address_unavailable`, `deposits_unavailable` | 503 | Deposits are paused for a moment. Nothing sent is lost. |
| `deposits_not_enabled` | 501 | Deposits are not open. |

## Authentication

An API key (`apiKey`) and a session token (`token`, from `auth.login`) are both sent as
`Authorization: Bearer <credential>`; a token wins if both are set. `login` can answer a
two-factor challenge: check with `isTwoFactorChallenge(result)` and finish with `auth.login2fa`.

Some routes need a session rather than an API key (`auth.listApiKeys`, `auth.createApiKey`,
`auth.revokeApiKey`, `auth.refresh`, `auth.organizations`, `auth.switchOrg`, `billing.checkout`,
`billing.portal`).
They answer `401` to a key. The agent graph routes (`agents.getGraph`, `saveGraph`) authorize by
user too, and answer an opaque `404` to a key.

## Running a task agent and sharing it

A `task` agent takes the answers to its form and gives back one result. `agents.run` sends them
and waits for it (it asks for the JSON answer, not a stream). `input` holds one answer per
question, keyed by the question's `key`:

```ts
const { output, billing } = await wheels.agents.run(agent.id, { code_to_review: "def f(): ..." });
console.log(output.text);
// Also: toolCalls (every tool the agent called and how each ended), durationMs, and billing:
// what the run cost a buyer's copy, or null when nothing was charged.
```

Answers that do not fit the form throw a `WheelsAIError` with status 422 and code `input_invalid`;
`error.data.details` lists each answer to fix as `{ path, field, label, message }`. An agent that
is not a task agent answers 409 `not_a_task_agent`, and answers over 8,000 characters 413
`input_too_large`. Nothing is counted or charged for a refused form. A run may take up to two
minutes, so `agents.run` waits 130 seconds; pass `{ timeoutMs }` as a last argument to change that.

Every agent has one public address, `/a/<handle>`, with a switch for public use:

```ts
await wheels.agents.publicLink.set(agent.id, { state: "on", dailyCap: 200 });
// { state: "on", handle, url, dailyCap, usedToday, showResults, toolsOffForVisitors }
const link = await wheels.agents.publicLink.get(agent.id);
```

`state` is `on` (anyone with the link can use the agent), `paused` (the page shows, use is stopped
for now) or `off`; reading it can also give `view_only` for an agent made public before it had a
switch. `set` also takes `handle` (3 to 40 lower-case letters, digits and hyphens; an address
another agent has answers 409 `handle_taken`) and `showResults`.

## Running on a schedule

A `scheduled` agent runs on its own at set times, and each run is kept. The schedule can be made
with the agent, or set later:

```ts
// The places results can go to. Slack or Discord by the link the service gave you; an API key
// cannot choose email, which is the signed-in person's own verified address.
const place = await wheels.destinations.create({ type: "slack", link: slackLink, name: "Team Slack" });
await wheels.destinations.test(place.channelId); // { sent: true }

const { agent, schedule } = await wheels.agents.create({
  name: "Morning brief",
  agentKind: "scheduled",
  schedule: { cronExpression: "0 9 * * 1-5", timezone: "Europe/Berlin", deliver: { channelId: place.channelId } },
});
// schedule: { id, enabled, cronExpression, timezone, nextRunAt }, or null without one

await wheels.agents.schedule.set(agent.id, { enabled: true, cronExpression: "0 8 * * *", stampTime: true, maxRetries: 2 });
const { schedule: current, suggested, schedulerRunning } = await wheels.agents.schedule.get(agent.id);

const { run } = await wheels.agents.schedule.runNow(agent.id); // needs agents:invoke for a key
const { runs, hasMore } = await wheels.agents.runs.list(agent.id, { limit: 20 });
await wheels.agents.runs.resend(agent.id, runs[0].id); // posts the saved result again; runs nothing
```

A schedule is on in UTC unless you say otherwise, tells the agent the date and time at each run when
`stampTime` is on, tries once more after a failed run and stops a run after five minutes. A run's
`status` is `running`, `finished`, `did_not_finish` (with a plain `failure`) or `stopped`, and its
`delivery` lists every try to send the result. A delivery that fails never changes the run and never
runs the agent again; `runs.resend` throws 502 `delivery_failed` with the run in `error.data.run`. A
schedule changed somewhere else answers 409 `schedule_changed`. When `agents.update` or a rollback
moves an agent's kind away from `scheduled`, the answer carries `schedulePaused: true`: its schedule
was turned off, and setting the kind back turns nothing on.

## Errors

Every failure throws a `WheelsAIError`: `status` (the HTTP status, or `0` for a network error or
timeout), `message` (the API's `message` or `error`, with field errors spelled out), `code`
(the API's `error` code, e.g. `insufficient_credits`) and `data` (the parsed body, which carries
extras such as `requiredCents` or a token-gated listing's `tokenSymbol` and `mintAddress`).
A request the API cannot accept answers 400 `validation_failed`: `message` is the first problem as
a plain sentence, and `data.fields` has one sentence per field, keyed by its path (`name`,
`tools[1].type`, `kindConfig.task.fields[0].label`).
The `/v1` API answers in OpenAI's shape, `{ error: { message, type, param, code } }`; `message`
and `code` are read from there too (e.g. `agent_not_found`, `plan_limit_reached`).
Requests time out after 30 seconds (`timeoutMs`); `agents.chatCompletion`, `agents.playgroundChat`,
`agents.run` (130 seconds by default), `inference.chat` and `inference.chatCompletion` take `{ timeoutMs }` as a last argument for a
longer wait on one call.

Ids and slugs are percent-encoded into the path. An empty one, `.` and `..` are refused (they
would name a different route). A credential containing whitespace or control characters is
refused before anything is sent, with an error that does not repeat it.

## Resources

`auth`, `agents`, `destinations`, `deployments` (model deployments), `models`, `billing`, `marketplace`, `use` (agents you pay for),
`inference` (OpenAI-compatible `/v1`), `workflows` (definitions are read-only here: `list`, `get`,
`run`, `getRun`, `cancelRun`, `chatCompletion`), `offerings` and `jobs` (above), `versioning`, `openclaw` (chat channels), `platform`
(`/api/status`, `/api/public/stats`, `/api/capabilities`) and `skills`. Billing amounts are dollars, as the API
returns them. To stop an agent's deployment use `agents.stopDeployment`; to buy credits, use
`billing.checkout` (card), `billing.topups` (USDC or SOL from a wallet) or `billing.depositAddress`
(USDC or SOL sent to your organization's address, for example from an exchange).

## Build and test

```bash
npm run build -w @wheelsai/sdk       # dist/ (what `exports` points at; consumers import the compiled JS)
npm test -w @wheelsai/sdk            # node:test with an injected fake fetch, no network
npm run typecheck -w @wheelsai/sdk
```

`test/resources.test.ts` has one case per SDK method (verb, path, query, body and the
`Authorization` header) and a guard, read off the client itself, that fails when a method or a
whole resource is added without one.
