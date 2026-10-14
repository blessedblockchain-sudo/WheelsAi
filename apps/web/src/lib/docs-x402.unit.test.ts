/**
 * The docs of paying an agent's use from a wallet (the x402 door), held to
 * the code they describe. Run with:
 *   npx tsx --test src/lib/docs-x402.unit.test.ts
 *
 * The door speaks a published format whose every name is exact: a header, a
 * field, a network id or a mint written wrong in the docs is a client that
 * cannot pay. Each test reads the page's source beside the one place the
 * fact lives in the API.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = (path: string) => readFileSync(join(here, "..", path), "utf8");
const apiSource = (path: string) => readFileSync(join(here, "..", "..", "..", "api", "src", path), "utf8");
const repoSource = (path: string) => readFileSync(join(here, "..", "..", "..", "..", path), "utf8");

const inference = source("app/docs/api/inference/page.tsx");
const agents = source("app/docs/api/agents/page.tsx");
const market = source("app/docs/api/marketplace/page.tsx");
const billing = source("app/docs/guides/plans-and-billing/page.tsx");
const guide = source("app/docs/guides/marketplace/page.tsx");

/** A page's words however its source wraps its lines. */
const flat = (page: string) => page.split('{" "}').join(" ").replace(/\s+/g, " ");

/** The part of the inference reference about the listing's door. */
const door = inference.slice(inference.indexOf('<h2 id="x402">'), inference.indexOf('<h2 id="deployment-wallet">'));
/** The part about a deployment's own wallet payment. */
const deployment = inference.slice(inference.indexOf('<h2 id="deployment-wallet">'));

/** The number a source writes for a constant: `NAME = 30_000;` is 30000. */
function constant(text: string, name: string): number {
  const found = new RegExp(`export const ${name} = ([0-9_]+)n?;`).exec(text);
  assert.ok(found, `${name} is not in the source`);
  return Number(found[1]!.split("_").join(""));
}

test("the door and the deployment's wallet payment are two parts, and only the door is called x402", () => {
  assert.ok(door.length > 0 && deployment.length > 0);
  assert.match(inference, /\{ id: "x402", title: "Pay an agent from a wallet, with x402" \}/);
  assert.match(inference, /\{ id: "deployment-wallet", title: "Pay a deployment per request from a wallet" \}/);
  // The deployment's part names its own headers and says it is not the published format.
  assert.match(deployment, /<code>X-Payment-Required<\/code> and <code>X-Payment<\/code>/);
  assert.match(flat(deployment), /This is not the published x402 format/);
  // It never calls itself x402: the name is said only of the door and of a client of the published format.
  const words = flat(deployment)
    .replace(/x402_[a-z_.]*/g, "")
    .replace(/#x402/g, "")
    .replace(/x402 door/g, "")
    .replace("This is not the published x402 format", "")
    .replace("an x402 client does not pay it", "");
  assert.doesNotMatch(words, /x402/i);
  assert.doesNotMatch(deployment, /<h[23][^>]*>[^<]*x402/i);
  // The sentence the deployment sends now, and never the old one.
  const sentence = /message:\s+"([^"]+)"/.exec(apiSource("services/x402.ts"))![1]!;
  assert.ok(deployment.includes(`"message": "${sentence}"`), "the deployment's 402 sentence is not the API's");
  assert.doesNotMatch(inference, /X-402 protocol/);
  // A link to the deployment's part goes to its own anchor.
  assert.match(billing, /href="\/docs\/api\/inference#deployment-wallet"/);
  assert.match(billing, /<h3 id="deployment-wallet">/);
  assert.match(repoSource("docs/X402-RUN.md"), /`\/docs\/api\/inference#deployment-wallet`/);
});

test("the door's headers and objects are the published names the API writes", () => {
  const wire = apiSource("services/x402Wire.ts");
  assert.match(wire, /export const X402_VERSION = 2;/);
  assert.match(wire, /export const PAYMENT_SIGNATURE_HEADER = "payment-signature";/);
  for (const header of ["PAYMENT-REQUIRED", "PAYMENT-SIGNATURE", "PAYMENT-RESPONSE"]) {
    assert.ok(door.includes(`<code>${header}</code>`), header);
  }
  assert.match(door, /"x402Version": 2,/);
  // The requirements, field by field, in the order listingRequirements builds them.
  const order = ["scheme", "network", "amount", "asset", "payTo", "maxTimeoutSeconds", "extra"];
  const at = order.map((field) => door.indexOf(`"${field}": `));
  assert.ok(at.every((index) => index > 0), "a field of the requirements is missing");
  assert.deepEqual([...at].sort((a, b) => a - b), at, "the fields are not in the order the API writes them");
  assert.match(door, /"scheme": "exact",/);
  assert.match(door, /"feePayer": "<WheelsAI's fee payer>",/);
  assert.match(door, /"memo": "<24 characters>"/);
  assert.match(wire, /export const X402_MEMO_CHARS = 24;/);
  // The memo is never shown in its first, longer form.
  assert.doesNotMatch(inference, /wheelsai-x402:/);
  // The settlement answer's fields, in the order encodePaymentResponse writes them on a success.
  assert.match(
    door,
    /&quot;success&quot;: true, &quot;payer&quot;, &quot;transaction&quot;, &quot;network&quot;, &quot;amount&quot;/,
  );
  assert.match(wire, /success: value\.success,[\s\S]*payer[\s\S]*transaction: value\.transaction,\s+network: value\.network,[\s\S]*amount/);
});

test("the networks, the mints and the amount are the API's", () => {
  const wire = apiSource("services/x402Wire.ts");
  const networks = /devnet: "(solana:[A-Za-z0-9]+)",\s+"mainnet-beta": "(solana:[A-Za-z0-9]+)",/.exec(wire);
  assert.ok(networks);
  assert.ok(door.includes(`<code>${networks[1]}</code>`), "the devnet CAIP-2 id");
  assert.ok(door.includes(`<code>${networks[2]}</code>`), "the mainnet CAIP-2 id");
  const assets = apiSource("lib/solanaAssets.ts");
  const mints = /mainnet: new PublicKey\("([1-9A-Za-z]+)"\),\s+devnet: new PublicKey\("([1-9A-Za-z]+)"\),/.exec(assets);
  assert.ok(mints);
  assert.ok(door.includes(`<code>${mints[1]}</code> on mainnet`), "the mainnet USDC mint");
  assert.ok(door.includes(`<code>${mints[2]}</code> on devnet`), "the devnet USDC mint");
  // Cents times 10,000.
  assert.match(wire, /const USDC_ATOMIC_PER_CENT = 10_000n;/);
  assert.match(wire, /amount: \(input\.priceCents \* USDC_ATOMIC_PER_CENT\)\.toString\(\),/);
  assert.match(door, /the listing's price in cents times 10,000, so 50000 is \$0\.05/);
  assert.match(door, /"amount": "50000",/);
});

test("the numbers of the door are the rules' numbers", () => {
  const rules = apiSource("services/x402DoorRules.ts");
  const svm = apiSource("services/x402ExactSvm.ts");
  assert.equal(constant(rules, "X402_MAX_TIMEOUT_SECONDS"), 180);
  assert.match(door, /"maxTimeoutSeconds": 180,/);
  assert.equal(constant(rules, "X402_ANSWER_DEADLINE_MS"), 30_000);
  assert.match(flat(door), /must be ready within 30 seconds of the call/);
  assert.match(flat(door), /Allow up to 3 minutes for the whole call/);
  assert.equal(constant(rules, "X402_UNPAID_ANSWERS_PER_DAY"), 3);
  assert.match(flat(door), /After 3 answers in a day/);
  assert.equal(constant(svm, "X402_MAX_COMPUTE_UNIT_LIMIT"), 200_000);
  assert.equal(constant(svm, "X402_MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS"), 50_000);
  assert.match(flat(door), /set the compute unit limit \(at most 200,000\); set the compute unit price \(at most 50,000 microlamports a unit\)/);
  // A wallet's limits are a buyer's: no second set.
  const limits = apiSource("services/publicPageState.ts");
  assert.match(limits, /PAID_USE_PER_BUYER_PER_MINUTE = 10\b/);
  assert.match(limits, /PAID_USE_PER_BUYER_PER_DAY = 200\b/);
  assert.match(flat(door), /Each address can call one agent 10 times a minute/);
  assert.match(flat(door), /Each wallet can pay for 10 uses a minute and 200 a day of one agent; each address, for 200 uses a day\./);
  // The address's day has no handle in its key; a wallet's minute and day do.
  const core = apiSource("services/paidUseX402.ts");
  assert.match(core, /x402DoorKeys\.addressDay\(input\.bucket, day\)/);
  assert.match(core, /x402DoorKeys\.walletDay\(wallet, handle, day\)/);
});

test("the 402's sentence is the one the door sends", () => {
  const rules = apiSource("services/x402DoorRules.ts");
  assert.ok(
    rules.includes(
      "`Pay ${dollars(price)} in USDC from a Solana wallet for one ${unit}, as the PAYMENT-REQUIRED header of this answer says, or send an API key.`",
    ),
  );
  assert.ok(
    door.includes(
      '"message": "Pay $0.05 in USDC from a Solana wallet for one message, as the PAYMENT-REQUIRED header of this answer says, or send an API key.",',
    ),
  );
  // The body of a refusal at /api/a: priceCents and unit beside the code.
  const body = apiSource("services/paidUse.ts");
  assert.match(body, /\.\.\.\(refusal\.unit !== undefined && \{ unit: refusal\.unit \}\),/);
  assert.match(body, /\.\.\.\(refusal\.transaction !== undefined && \{ transaction: refusal\.transaction \}\),/);
});

test("every refusal of the door is in the table, with the status the API answers and its code on /v1", () => {
  const core = apiSource("services/paidUseX402.ts");
  const compat = apiSource("services/openaiCompat.ts");
  const task = apiSource("services/agentTask.ts");

  // What the door answers: each literal code of the core, and the run's own refusals.
  const statusOf = new Map<string, number>();
  for (const found of core.matchAll(/status: (\d{3}),\s*code: "([a-z0-9_]+)"/g)) {
    const [, status, code] = found;
    const known = statusOf.get(code!);
    assert.ok(known === undefined || known === Number(status), `${code} answers two statuses`);
    statusOf.set(code!, Number(status));
  }
  const taskStatuses = /TASK_REFUSAL_STATUS: Record<TaskRefusalCode, [^>]+> = \{([^}]+)\}/.exec(task)![1]!;
  for (const found of taskStatuses.matchAll(/([a-z_]+): (\d{3}),/g)) statusOf.set(found[1]!, Number(found[2]));
  assert.ok(statusOf.size >= 15, "the door's codes were not read");

  // The table's rows.
  const table = door.slice(door.indexOf('caption="Refusals of a use paid from a wallet"'));
  const rows = [...table.matchAll(/\{ status: <code>(\d{3})<\/code>, code: (.*?), v1: (.*?), when: /g)];
  const codesIn = (cell: string) => [...cell.matchAll(/<code>([a-z0-9_]+)<\/code>/g)].map((found) => found[1]!);
  const listed = new Set<string>();
  for (const [, status, codeCell, v1Cell] of rows) {
    for (const code of codesIn(codeCell!)) {
      listed.add(code);
      assert.equal(statusOf.get(code), Number(status), `${code}: the table says ${status}`);
      const v1 = new RegExp(`\\n  ${code}: "([a-z0-9_]+)",`).exec(compat);
      if (v1Cell === '""') continue;
      assert.ok(v1, `${code} has no row on /v1`);
      assert.ok(codesIn(v1Cell!).includes(v1[1]!), `${code} is ${v1[1]} on /v1`);
    }
  }
  assert.deepEqual([...listed].sort(), [...statusOf.keys()].sort());
  // A door that does not serve the listing is today's 401, on both addresses.
  assert.match(table, /\{ status: <code>401<\/code>, code: "", v1: <code>invalid_api_key<\/code>/);
  assert.match(apiSource("middleware/openaiAuth.ts"), /return replyOpenAiError\(reply, "invalid_api_key", \{ message: MISSING_API_KEY_MESSAGE \}\);/);
  // After the claim, /v1 tells an OpenAI client not to send the same payment again.
  assert.match(apiSource("routes/paidCompletions.ts"), /paidUseOpenAiError\(\{ \.\.\.result\.refusal, \.\.\.\(call\.claimed\(\) && \{ noAutomaticRetry: true \}\) \}\)/);
  // claimed() turns true at the claim (step 10), not at the checks: the limits and the chain's read come
  // before it and keep their own retry rule, so the docs name the claim as the moment.
  assert.match(apiSource("routes/paidUse.ts"), /insertHeld: \(row\) => \{\s+claimed = true;/);
  assert.match(flat(door), /Once your payment is taken up for its answer, after its checks, the limits and a read of Solana, every refusal on <code>\/v1<\/code> carries <code>x-should-retry: false<\/code>/);
  // Before the claim, a limit and an unavailable door may be retried; every 402 may not.
  assert.doesNotMatch(/\n  rate_limit_exceeded: \{[^}]*\}/.exec(compat)![0], /retry: false/);
  assert.match(compat, /\n  service_unavailable: server\(503, "[^"]+"\),/);
  assert.match(/\n  x402_payment_required: \{[^}]*\}/.exec(compat)![0], /retry: false/);
  assert.match(flat(door), /Every <code>402<\/code> of a use paid from a wallet carries <code>x-should-retry: false<\/code> on <code>\/v1<\/code>\./);
});

test("the paid answer is the one the routes send", () => {
  // billing of a use paid from a wallet: the price paid, no balance, listing pricing.
  const core = apiSource("services/paidUseX402.ts");
  assert.match(core, /chargedCents: Number\(priceCents\),\s+balanceCents: null,\s+access: "listing_pricing",/);
  assert.match(door, /"billing": \{ "chargedCents": 5, "balanceCents": null, "access": "listing_pricing" \}/);
  // The headers come before the body.
  const route = apiSource("routes/paidUse.ts");
  assert.match(route, /setX402Headers\(reply, result\.headers\);\s+setUsageHeaders\(reply, usageHeadersOf\(result\.billing\)\);/);
  assert.match(apiSource("services/usageHeaders.ts"), /"x-wheelsai-charged-cents"/);
  assert.match(door, /x-wheelsai-charged-cents: 5/);
  // /api/a streams unless stream is false; /v1 answers whole unless it is true.
  assert.match(core, /wantsStream = parsed\.data\.stream !== false;/);
  assert.match(flat(door), /answers as a stream unless <code>stream<\/code> is <code>false<\/code>/);
  assert.match(door, /"stream": false \}'/);
});

test("the switch on a listing is in the marketplace reference with its rules", () => {
  const route = apiSource("routes/marketplace.ts");
  assert.match(route, /x402Enabled: z\.boolean\(\)\.optional\(\),/);
  assert.match(market, /\{ name: "x402Enabled", type: "boolean", description: /);
  const service = apiSource("services/marketplace.ts");
  const sentences = /export const X402_LISTING_MESSAGES = \{\s+workflow: "([^"]+)",\s+notPerUse: "([^"]+)",\s+notCalled: "([^"]+)",/.exec(service);
  assert.ok(sentences);
  for (const sentence of sentences.slice(1)) {
    assert.ok(flat(market).includes(`&quot;${sentence.replace(/'/g, "&apos;")}&quot;`), `the reference does not say: ${sentence}`);
  }
  assert.match(apiSource("services/useListing.ts"), /MIN_PRICE_PER_USE_CENTS = 5n;/);
  assert.match(flat(market), /Only on an agent&apos;s listing that sells use, <code>per_request<\/code>, at 5 cents or more/);
  assert.match(flat(market), /turns <code>x402Enabled<\/code> off in the same write and refuses nothing/);
  // Only the owner's reads say the switch.
  assert.match(service, /x402Enabled: listing\.x402Enabled === true,/);
  assert.match(apiSource("routes/capabilities.ts"), /x402: available\(reads\.x402\),/);
  assert.match(flat(market), /<code>x402\.available<\/code> in <code>GET \/api\/capabilities<\/code>/);
  // The door's intro names every condition the door reads: the platform's door open and a published listing.
  assert.match(apiSource("services/x402DoorRules.ts"), /if \(listing\.status !== "published"\) return false;/);
  assert.match(flat(door), /An agent takes payments from a wallet while WheelsAI offers paying from a wallet \(<code>x402\.available<\/code> in <code>GET \/api\/capabilities<\/code>\) and its creator has turned them on for a published listing sold per use/);
  // A door sale on the earnings: its own type, never the wallet.
  assert.match(apiSource("services/x402Sale.ts"), /export const X402_SALE_TYPE = "x402";/);
  assert.match(flat(market), /a row of <code>type<\/code> <code>x402<\/code>/);
});

test("the agents reference and the guides point to the door, and the token bar counts a deployment's payments", () => {
  assert.match(agents, /<h3 id="paid-wallet">Pay from a wallet<\/h3>/);
  assert.match(agents, /\{ id: "paid-wallet", title: "Pay from a wallet", sub: true \}/);
  assert.match(agents, /href="\/docs\/api\/inference#x402"/);
  // Only a chat or a run reaches the door: the access and results reads keep their 401.
  assert.match(flat(agents), /Not signed in\. A chat or a run sent with no credential at all, to an agent whose creator lets people pay from a wallet, is answered <code>402<\/code> <code>x402_payment_required<\/code> with the price instead/);
  assert.match(flat(agents), /The access and results reads answer <code>401<\/code> as always\./);
  assert.match(guide, /<h3 id="wallet">Paid from a wallet<\/h3>/);
  assert.match(guide, /<strong>Let people with no account pay from a Solana wallet<\/strong>/);
  assert.match(source("lib/sell-x402.ts"), /label: "Let people with no account pay from a Solana wallet",/);
  assert.match(source("lib/earnings.ts"), /x402: "Paid from a wallet",/);
  // The token bar counts settled payments of the agent's deployments only.
  assert.match(apiSource("services/loadEligibilityState.ts"), /\{ agentDeploymentId: \{ in: agentDeploymentIds \} \},\s+\{ deploymentId: \{ in: modelDeploymentIds \} \},/);
  assert.match(flat(guide), /settled payments to the agent&apos;s deployments from a Solana wallet, request by request, lower the bar/);
  assert.doesNotMatch(guide, /settled x402 payments/);
});

test("the pages of the door keep the house's words", () => {
  for (const [name, page] of [
    ["inference", inference],
    ["agents", agents],
    ["marketplace", market],
    ["the deployment's part of plans and billing", billing.slice(billing.indexOf('<h3 id="deployment-wallet">'), billing.indexOf('<h2 id="who">'))],
    ["marketplace guide", guide],
    ["api", source("app/docs/api/page.tsx")],
    ["docs", source("app/docs/page.tsx")],
  ] as const) {
    assert.ok(page.length > 0, `${name}: not found`);
    assert.ok(/^[\x00-\x7F]*$/.test(page), `${name}: a character outside ASCII is typed in the page`);
    assert.ok(!page.includes(String.fromCharCode(0x2014)), `${name}: an em dash`);
  }
  // The door never speaks of a refund or a credit balance, and never says nothing was charged once a payment went through.
  assert.doesNotMatch(door, /refunded|credit balance|returned to your|given back/i);
  for (const code of ["x402_payment_unserved", "x402_payment_unconfirmed"]) {
    const row = door.slice(door.indexOf(`code: <code>${code}</code>`));
    const when = row.slice(0, row.indexOf("},"));
    assert.doesNotMatch(when, /nothing was charged/i, code);
  }
  // A payment presented before may have been charged on its first use: its sentence says nothing of a charge.
  const invalidRow = door.slice(door.indexOf("code: <code>x402_payment_invalid</code>"));
  const invalidWhen = flat(invalidRow.slice(0, invalidRow.indexOf("},")));
  const presented = invalidWhen.slice(invalidWhen.indexOf("presented before"));
  assert.ok(presented.length > 0 && invalidWhen.includes("presented before"), "the presented-before case is not in its row");
  assert.doesNotMatch(presented, /nothing was charged/i);
  // A first call from the docs carries no key.
  const firstCall = door.slice(door.indexOf('<CodeBlock\n        language="bash"'), door.indexOf('"x402Version": 2'));
  assert.doesNotMatch(firstCall, /Authorization|Bearer/);
});
