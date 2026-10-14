#!/usr/bin/env node
/*
 * One use of an agent paid from a Solana wallet by a caller with NO account,
 * at the agent's x402 door, on DEVNET, with the founder's own wallet as the
 * payer. Devnet only: no real money.
 *
 * The local walk of the door (on a test validator on this machine) proves the
 * rules with wallets made for it. This one proves that the same door holds on
 * a network it does not own: a public RPC, real confirmation times, and a
 * payment built by a client the way a real x402 client builds it, signed by a
 * wallet that exists outside this script.
 *
 * WHAT IT DOES, by itself:
 *   - refuses to run unless the RPC answers with devnet's genesis hash
 *   - reads the payer's devnet SOL and devnet USDC, and when either is short
 *     says exactly what to get and where, and stops before making anything
 *   - makes in memory, and never writes anywhere: the server's master key
 *     (from which the door's fee payer is derived) and the treasury wallet
 *     the payment goes to
 *   - makes an empty database of its own (wheelsai_walk_x402_<time>), starts
 *     a stand-in for Nosana on loopback (so the agent can answer with no GPU
 *     and no Nosana account) and its own API beside any other: port 4010,
 *     database 1 of the repository's Redis container, the x402 door open
 *   - the payer opens the treasury's USDC account (the reference client never
 *     opens payTo's account, so it must exist before anyone pays)
 *   - a seller puts an agent on sale per use at $0.05 and switches paying
 *     from a wallet on
 *   - an unpaid call: 402 with PAYMENT-REQUIRED, decoded and printed
 *   - sends the fee payer named in extra.feePayer 0.02 SOL from the payer
 *     (twice the floor under which the door says it is not available)
 *   - one paid use, built as a version 2 "exact" client builds it and signed
 *     by the payer only; then what moved on the chain, the rows written, and
 *     the same PAYMENT-SIGNATURE refused the second time
 *   - stops its API and the stand-in, then hands everything back: the fee
 *     payer's SOL and the treasury's USDC go to the payer, and the treasury's
 *     token account is closed with its rent returned to the payer. Only the
 *     network fees are spent.
 *
 *   node apps/api/scripts/payments-proof/walk-devnet-x402.cjs <outDir> --payer <keypair.json>
 *   X402_PAYER_KEYPAIR=<keypair.json> node apps/api/scripts/payments-proof/walk-devnet-x402.cjs <outDir>
 *
 * <keypair.json> is a Solana keypair file (a JSON list of 64 numbers, as
 * solana-keygen writes it). It is read once and never written, copied or
 * printed: only its address is shown. The payer needs about 0.03 devnet SOL
 * and at least 0.20 devnet USDC (mint 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU)
 * in its own USDC account; the walk spends only network fees of it.
 *
 * <outDir> receives the API's log (api.log) and the stand-in's
 * (nosana-stand-in.log). The stand-in's node speaks https, so a certificate
 * for 127.0.0.1 and its TLS key are made with openssl in a private temporary
 * folder and deleted at the end: they are not a wallet's key and open nothing
 * but that loopback server.
 *
 * Settings (all optional): WALK_API_PORT (4010), WALK_REDIS_DB (1),
 * WALK_STAND_IN_PORT (4330; the stand-in takes it and the next two),
 * SOLANA_RPC_URL (https://api.devnet.solana.com), WHEELSAI_PG_CONTAINER and
 * WHEELSAI_REDIS_CONTAINER (see lib.cjs). The database is left for reading
 * afterwards; its name is printed. Exit 0 when every check passed, 1 when one
 * failed, 2 when the walk stopped, 3 when the payer is not funded.
 */
const { spawn, spawnSync, execFileSync } = require("child_process");
const { randomBytes, hkdfSync } = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const lib = require("./lib.cjs");
const { req, sleep } = lib;
// The API's own copies, so the payment is built with the versions the door reads it with.
const web3 = req("@solana/web3.js");
const spl = req("@solana/spl-token");
const bs58Module = req("bs58");
const bs58 = typeof bs58Module.decode === "function" ? bs58Module : bs58Module.default;

const outDir = process.argv[2];
const flag = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const PAYER_FILE = flag("--payer") || process.env.X402_PAYER_KEYPAIR || "";
/**
 * A rehearsal of this same walk on the local test chain (local-chain.sh), so that the script itself is
 * proven before the founder's devnet run: the payer is made in memory and funded from the local faucet and
 * the local chain's own USDC mint authority. Allowed only with an RPC on this machine; devnet and mainnet
 * are never reached in this mode.
 */
const LOCAL = process.argv.includes("--local-chain");
if (!outDir || outDir.startsWith("--") || (!PAYER_FILE && !LOCAL)) {
  console.log("usage: node walk-devnet-x402.cjs <outDir> --payer <keypair.json>   (or X402_PAYER_KEYPAIR=<keypair.json>)");
  console.log("       node walk-devnet-x402.cjs <outDir> --local-chain              (a rehearsal on local-chain.sh)");
  process.exit(2);
}

const PORT = Number(process.env.WALK_API_PORT || 4010);
const REDIS_DB = Number(process.env.WALK_REDIS_DB || 1);
const REDIS_CONTAINER = process.env.WHEELSAI_REDIS_CONTAINER || "wheelsai-redis";
const API = `http://localhost:${PORT}`;
const RPC = process.env.SOLANA_RPC_URL || (LOCAL ? "http://127.0.0.1:18899" : "https://api.devnet.solana.com");
if (LOCAL) {
  let host = "";
  try {
    host = new URL(RPC).hostname;
  } catch {
    host = "";
  }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) {
    console.log("--local-chain runs only against a test chain on this machine (SOLANA_RPC_URL on 127.0.0.1)");
    process.exit(2);
  }
}
/**
 * The RPC as it is printed: its origin only. A provider's devnet URL often carries its API key in the path
 * or the query, and the walk prints no secret.
 */
const RPC_SHOWN = (() => {
  try {
    const u = new URL(RPC);
    return u.origin + (u.pathname.length > 1 || u.search ? "/..." : "");
  } catch {
    return "(the RPC in SOLANA_RPC_URL)";
  }
})();
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const DEVNET_CAIP2 = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const STAMP = String(Math.floor(Date.now() / 1000));
const DB = `wheelsai_walk_x402_${STAMP}`;
const PASSWORD = "Walk-devnet-x402-2026";

// The stand-in for Nosana: its REST API, its node and its (unused) Solana RPC, on three ports of their own,
// apart from the rehearsal's 4310 to 4312. The key is the stand-in's own and opens nothing anywhere else.
const STAND_IN_PORT = Number(process.env.WALK_STAND_IN_PORT || 4330);
const STAND_IN_KEY = "nos_rehearsal_00000000000000000000000042";
const MODEL = "llama-3.2-3b";
const HOSTED_ID = `wheelsai/${MODEL}`;

/** Devnet's USDC (Circle's faucet hands it out). */
const USDC = new web3.PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
/** The Memo program a reference client writes the memo with (the notes, section 3). */
const MEMO_PROGRAM = new web3.PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const PER_USE = 5;
/** One use in USDC atomic units: 5 cents times 10,000. */
const AMOUNT = 50_000n;
const SOL = 1_000_000_000;
/** What the payer must hold before anything is made: rent of one token account, 0.02 SOL and fees, with room. */
const NEEDED_LAMPORTS = 30_000_000;
const NEEDED_USDC = 200_000n;
/** Twice X402_FEE_PAYER_MIN_LAMPORTS, so a second call still reaches the duplicate refusal and not "not available". */
const FEE_PAYER_LAMPORTS = 20_000_000;
/** The door's fee payer, derived from the master key as services/x402FeePayer.ts derives it. */
const X402_FEE_PAYER_SALT = "wheelsai-x402-fee-payer-v1";
const X402_FEE_PAYER_INFO = "x402-fee-payer";
const DESCRIPTION = "A listing made by the devnet walk of the x402 door, safe to ignore.";

// What a caller at the door is told, from the rules of the slice (X402_DOOR_MESSAGES).
const SAID = {
  payFirst:
    "Pay $0.05 in USDC from a Solana wallet for one message, as the PAYMENT-REQUIRED header of this answer says, or send an API key.",
  presentedTwice:
    "This payment was already presented once. A payment pays for one answer only, so it was not sent again. Pay with a new transaction.",
};

const sql = (statement) => lib.sql(statement, DB);
const rowsOf = (statement) =>
  sql(statement)
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("|"));

const results = [];
function check(name, ok, detail) {
  results.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `   [${detail}]` : ""}`);
}
const started = Date.now();
const clock = () => `${Math.round((Date.now() - started) / 1000)}s`;
const step = (title) => console.log(`\n-- ${title}   (at ${clock()})`);
/** JSON that holds bigints, which JSON.stringify alone refuses. */
const json = (value) => JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v));
const short = (v, n = 240) => {
  const s = typeof v === "string" ? v : json(v);
  return s && s.length > n ? `${s.slice(0, n)}...` : s;
};
const same = (a, b) => json(a) === json(b);
const sol = (lamports) => `${(Number(lamports) / SOL).toFixed(6)} SOL`;
const usdc = (units) => (units === null ? "no USDC account" : `${(Number(units) / 1e6).toFixed(6)} USDC`);
const explorer = (signature) =>
  LOCAL ? `${signature} (the local chain)` : `https://explorer.solana.com/tx/${signature}?cluster=devnet`;

// ============================================
// The payer's keypair: read once, never written or printed
// ============================================

function readPayer(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new Error(`there is no file at ${file}: name the payer's keypair file with --payer or X402_PAYER_KEYPAIR`);
  }
  if (!stat.isFile()) throw new Error(`${file} is not a file: name the payer's keypair file`);
  let bytes;
  try {
    bytes = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // Never what the file holds: it may be a secret in another shape.
    throw new Error(`${file} does not hold a Solana keypair (a JSON list of 64 numbers, as solana-keygen writes it)`);
  }
  if (!Array.isArray(bytes) || bytes.length !== 64 || !bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
    throw new Error(`${file} does not hold a Solana keypair (a JSON list of 64 numbers, as solana-keygen writes it)`);
  }
  try {
    return web3.Keypair.fromSecretKey(Uint8Array.from(bytes));
  } catch {
    throw new Error(`${file} does not hold a valid Solana keypair: its two halves do not match`);
  }
}

// ============================================
// The walk's API, as a caller with no account and as the seller
// ============================================

/** Every answer from a door address (POST to an agent's chat or run, or /v1 with model a/...), for the leak check. */
const seen = [];
const DOOR_PATH = /^\/api\/a\/[^/?]+\/(chat|run)$/;
const isDoorCall = (method, route, body) =>
  method === "POST" &&
  (DOOR_PATH.test(route) ||
    (route === "/v1/chat/completions" && typeof body?.model === "string" && body.model.startsWith("a/")));

class Client {
  /** `cookies: false` for a caller with no account: it never sends a cookie, whatever an answer sets. */
  constructor({ cookies = true } = {}) {
    this.cookies = new Map();
    this.keepCookies = cookies;
  }
  async call(method, route, body, extraHeaders = {}) {
    const h = { ...extraHeaders };
    if (body !== undefined) h["content-type"] = "application/json";
    if (this.cookies.size) h.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const sentAt = Date.now();
    const res = await fetch(API + route, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    if (this.keepCookies) {
      for (const line of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
        const [pair] = line.split(";");
        const i = pair.indexOf("=");
        if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
    }
    const text = await res.text();
    const ms = Date.now() - sentAt;
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text.slice(0, 300) };
    }
    if (isDoorCall(method, route, body)) {
      seen.push({ what: `${method} ${route} -> ${res.status}`, headers: [...res.headers], text });
    }
    return { status: res.status, body: parsed, headers: res.headers, text, ms };
  }
}

async function account(label, cents) {
  const client = new Client();
  const email = `devnet-x402-${label}-${STAMP}@example.test`;
  let r = await client.call("POST", "/api/auth/register", { email, password: PASSWORD });
  if (r.status === 429) {
    // Sign-up allows a few a minute from one address: wait the minute out.
    await sleep(62_000);
    r = await client.call("POST", "/api/auth/register", { email, password: PASSWORD });
  }
  if (r.status !== 200 && r.status !== 201) throw new Error(`register ${label}: ${r.status} ${short(r.body)}`);
  const me = await client.call("GET", "/api/auth/me");
  const orgId = me.body.organization.id;
  // The walk's own empty database: the seller's credits (which the stand-in GPU is billed from) are given
  // by hand, as the other walks do. No buyer in this walk holds credits: the payer has no account.
  sql(`insert into credit_balances (org_id, balance_cents, updated_at) values ('${orgId}', ${cents}, now()) on conflict (org_id) do update set balance_cents = ${cents}, updated_at = now()`);
  return { client, orgId, email, label };
}
async function waitFor(read, ok, seconds = 90) {
  let value;
  for (let waited = 0; waited < seconds; waited += 1) {
    value = await read();
    if (ok(value)) return value;
    await sleep(1000);
  }
  return value;
}
/** A model the seller runs on the stand-in, so the agent can answer with no GPU and nothing spent. */
async function deploy(seller, name) {
  const r = await seller.client.call("POST", "/api/deployments", { name, modelId: MODEL, gpuTier: "4090", engine: "ollama", replicas: 1 });
  if (r.status !== 201) throw new Error(`deploy on the stand-in: ${r.status} ${short(r.body, 400)}`);
  const id = r.body.deployment.id;
  const row = await waitFor(async () => (await seller.client.call("GET", `/api/deployments/${id}`)).body, (b) => (b.deployment ?? b)?.status === "running", 120);
  const d = row.deployment ?? row;
  if (d?.status !== "running") throw new Error(`the deployment on the stand-in did not run: ${short(d, 300)}`);
  return { id, slug: d.slug };
}
/** An agent that converses, on the model the seller runs on the stand-in, published for use at $0.05 a message. */
async function agentOnSale(seller, name) {
  let r = await seller.client.call("POST", "/api/agents", { name, description: "Made by the devnet walk of the x402 door.", agentKind: "conversation", systemPrompt: "You answer in one short sentence." });
  if (r.status !== 200 && r.status !== 201) throw new Error(`agent: ${r.status} ${short(r.body)}`);
  const agent = r.body.agent;
  r = await seller.client.call("PATCH", `/api/agents/${agent.id}`, { modelConfig: { externalModel: HOSTED_ID } });
  if (r.status !== 200) throw new Error(`agent model: ${r.status} ${short(r.body)}`);
  r = await seller.client.call("POST", "/api/marketplace/listings", {
    agentId: agent.id,
    title: agent.name,
    shortDescription: DESCRIPTION,
    category: "other",
    publish: true,
    pricingModel: "per_request",
    pricePerRequestCents: PER_USE,
  });
  return { agent, created: r, listing: r.body.listing || {}, handle: ((r.body.listing || {}).agent || {}).handle };
}
const answered = (r) => r.status === 200 && /stand-in node/.test(r.body?.message?.content ?? r.body?.choices?.[0]?.message?.content ?? "");
const billingOf = (r) => r.body?.billing ?? r.body?.wheelsai?.billing ?? null;

// ============================================
// The wire, as a version 2 client speaks it
// ============================================

const toBase64Json = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64");
function fromBase64Json(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    return null;
  }
}
const requiredOf = (r) => fromBase64Json(r.headers.get("payment-required"));
const responseOf = (r) => fromBase64Json(r.headers.get("payment-response"));
const isAddress = (value) => {
  if (typeof value !== "string") return false;
  try {
    return new web3.PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
};
const isSignature = (value) => {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    return bs58.decode(value).length === 64;
  } catch {
    return false;
  }
};

/**
 * One payment as a version 2 "exact" client builds it on Solana (the notes, section 4), the same steps as
 * the local walk of the door and the stand-in client of the door's tests (apps/api/src/tests/
 * x402DoorStandIns.ts), written again here: SetComputeUnitLimit 20,000, SetComputeUnitPrice 1
 * microlamport, TransferChecked of `amount` with 6 decimals from the payer's USDC account to payTo's, and a
 * Memo of exactly extra.memo; compiled as a version 0 message whose fee payer is extra.feePayer, on devnet's
 * latest blockhash, and signed by the PAYER ONLY. The fee payer's slot stays empty: only the door can fill
 * it, and only once the answer is made.
 */
function exactPayment({ payer, accepted, amount, blockhash }) {
  const mint = new web3.PublicKey(accepted.asset);
  const payTo = new web3.PublicKey(accepted.payTo);
  const feePayer = new web3.PublicKey(accepted.extra.feePayer);
  const source = spl.getAssociatedTokenAddressSync(mint, payer.publicKey);
  const destination = spl.getAssociatedTokenAddressSync(mint, payTo, true);
  const instructions = [
    web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 20_000 }),
    web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
    spl.createTransferCheckedInstruction(source, mint, destination, payer.publicKey, amount, 6),
    new web3.TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from(accepted.extra.memo, "utf8") }),
  ];
  const message = new web3.TransactionMessage({ payerKey: feePayer, recentBlockhash: blockhash, instructions }).compileToV0Message();
  const transaction = new web3.VersionedTransaction(message);
  transaction.sign([payer]);
  return Buffer.from(transaction.serialize()).toString("base64");
}

/** PAYMENT-SIGNATURE as a version 2 client sends it: the 402's resource, its one way to pay as received, the transaction. */
const paymentSignatureOf = (required, transactionB64) =>
  toBase64Json({ x402Version: 2, resource: required.resource, accepted: required.accepts[0], payload: { transaction: transactionB64 } });

// The chat body of the page's address: paid use's own schema (services/publicChat.ts, strict), not
// streamed, so the answer is one JSON object.
const chatBody = () => ({ messages: [{ role: "user", content: "Say hello." }], stream: false });

// ============================================
// The chain, asked politely: a public RPC answers "too many requests" now and then
// ============================================

const chain = new web3.Connection(RPC, "confirmed");
/** True once the walk is ending: from then on the walk starts no transaction of its own but the hand-back. */
let ending = false;
/** The walk's own transactions still on their way, which end() waits for before it reads any balance. */
const inFlight = new Set();
/**
 * The slot of the newest transaction the walk saw confirmed. Every read of a balance or an account asks
 * for a state at least that new: a public RPC is many nodes behind one address, and a node a slot or two
 * behind would answer a balance from before the transfer. Such a node answers "not reached yet" instead,
 * which rpc() waits out.
 */
let lastSlot = 0;
const seenAt = (slot) => {
  if (Number.isInteger(slot) && slot > lastSlot) lastSlot = slot;
};
async function rpc(ask, tries = 6) {
  for (let i = 0; ; i++) {
    try {
      return await ask();
    } catch (err) {
      if (i >= tries - 1) throw err;
      await sleep(1500 * (i + 1));
    }
  }
}
const ataOf = (owner) => spl.getAssociatedTokenAddressSync(USDC, owner, true);
const solOf = async (owner) => BigInt(await rpc(() => chain.getBalance(owner, { commitment: "confirmed", minContextSlot: lastSlot })));
const accountOf = (address) => rpc(() => chain.getAccountInfo(address, { commitment: "confirmed", minContextSlot: lastSlot }));
/**
 * A wallet's devnet USDC in atomic units, or null when it has no USDC account. Read from the account
 * itself, in one answer at least as new as lastSlot (getTokenAccountBalance takes no such bound).
 */
async function usdcOf(owner) {
  const info = await accountOf(ataOf(owner));
  if (!info) return null;
  return spl.unpackAccount(ataOf(owner), info).amount;
}
/** Waits until the chain says the transaction is confirmed; throws if it failed or never got there. */
async function settled(signature, seconds = 120) {
  for (let i = 0; i < seconds; i++) {
    const s = (await rpc(() => chain.getSignatureStatuses([signature], { searchTransactionHistory: true }))).value[0];
    if (s?.err) throw new Error(`the transaction ${signature} failed on chain: ${JSON.stringify(s.err)}`);
    if (s && ["confirmed", "finalized"].includes(s.confirmationStatus)) {
      seenAt(s.slot);
      return;
    }
    await sleep(1000);
  }
  throw new Error(`the transaction ${signature} was not confirmed after ${seconds} seconds`);
}
/** One transaction of the walk's own, its fee paid by the first signer, followed until confirmed. */
async function sendNow(instructions, signers) {
  const latest = await rpc(() => chain.getLatestBlockhash("confirmed"));
  const tx = new web3.Transaction({ feePayer: signers[0].publicKey, recentBlockhash: latest.blockhash }).add(...instructions);
  tx.sign(...signers);
  // Sending the same signed bytes again is harmless: the chain knows them by one signature.
  const signature = await rpc(() => chain.sendRawTransaction(tx.serialize()));
  await settled(signature);
  return signature;
}
/**
 * The walk's own sends, but the hand-back's. Once the walk is ending none starts, and end() waits for those
 * already started: one still in flight would otherwise land after the hand-back read the fee payer as
 * empty, and stay with a key that dies with this process.
 */
function send(instructions, signers) {
  if (ending) return Promise.reject(new Error("the walk is ending: nothing more is sent"));
  const sending = sendNow(instructions, signers);
  inFlight.add(sending);
  sending.then(
    () => inFlight.delete(sending),
    () => inFlight.delete(sending),
  );
  return sending;
}
/** The fee a transaction paid, as the chain recorded it. A public RPC may take a moment to serve it. */
async function feeOf(signature) {
  for (let i = 0; i < 20; i++) {
    const tx = await rpc(() => chain.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })).catch(() => null);
    if (tx?.meta) return BigInt(tx.meta.fee);
    await sleep(1500);
  }
  return null;
}

// ============================================
// The walk's own processes: the stand-in for Nosana and the API
// ============================================

let api = null;
let apiEnv = null;
let standIn = null;
let tlsDir = null;
const redis = (...args) => execFileSync("docker", ["exec", REDIS_CONTAINER, "redis-cli", "-n", String(REDIS_DB), ...args], { encoding: "utf8" }).trim();
const answers = (url) => fetch(url).then((r) => r.status).catch(() => 0);

async function startStandIn() {
  for (const port of [STAND_IN_PORT, STAND_IN_PORT + 1, STAND_IN_PORT + 2]) {
    if ((await answers(`http://127.0.0.1:${port}/`)) !== 0) throw new Error(`something already answers on port ${port}: choose other ports for the stand-in with WALK_STAND_IN_PORT`);
  }
  // The platform takes only https endpoints, so the stand-in's node needs a certificate for 127.0.0.1 that
  // the API trusts. Made for this run in a folder only this user can read, and deleted at the end.
  tlsDir = fs.mkdtempSync(path.join(os.tmpdir(), "wheelsai-x402-walk-"));
  const made = spawnSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", path.join(tlsDir, "node.key"), "-out", path.join(tlsDir, "node.crt")],
    { encoding: "utf8" },
  );
  if (made.status !== 0) throw new Error("openssl could not make the stand-in node's certificate");
  const log = fs.openSync(path.join(outDir, "nosana-stand-in.log"), "w");
  standIn = spawn("npx", ["tsx", "scripts/nosana-fake-api.ts"], {
    cwd: path.join(lib.REPO, "apps/api"),
    env: {
      ...process.env,
      FAKE_NOSANA_PORT: String(STAND_IN_PORT),
      FAKE_NODE_PORT: String(STAND_IN_PORT + 1),
      FAKE_RPC_PORT: String(STAND_IN_PORT + 2),
      FAKE_NOSANA_KEY: STAND_IN_KEY,
      FAKE_START_MS: "5000",
      FAKE_STOP_MS: "2000",
      FAKE_BALANCE_USD: "15",
      FAKE_NODE_TLS_CERT: path.join(tlsDir, "node.crt"),
      FAKE_NODE_TLS_KEY: path.join(tlsDir, "node.key"),
    },
    stdio: ["ignore", log, log],
    detached: true,
  });
  // A child that cannot start (npx missing, no processes left) says so by an event: with no listener it
  // would end this process before the hand-back.
  standIn.on("error", (err) => {
    standIn.failed = err;
  });
  for (let i = 0; i < 60; i++) {
    if ((await answers(`http://127.0.0.1:${STAND_IN_PORT}/`)) !== 0) return;
    if (standIn.exitCode !== null || standIn.failed) break;
    await sleep(1000);
  }
  throw new Error(`the stand-in for Nosana did not come up: see ${path.join(outDir, "nosana-stand-in.log")}`);
}

async function startApi(masterKey, treasuryAddress) {
  if ((await answers(`${API}/health`)) !== 0) throw new Error(`something already answers at ${API}: choose another port with WALK_API_PORT`);
  const keys = Number(redis("dbsize"));
  if (keys !== 0) throw new Error(`database ${REDIS_DB} of the Redis container holds ${keys} keys: the walk's API starts on an empty one (choose another with WALK_REDIS_DB)`);
  const made = spawnSync("node", [path.join(__dirname, "make-run-database.cjs"), DB], { encoding: "utf8" });
  if (made.status !== 0) throw new Error(`the walk's database could not be made: ${short(`${made.stdout}${made.stderr}`, 300)}`);
  apiEnv = {
    ...process.env,
    RUN_DATABASE: DB,
    RUN_REDIS_DB: String(REDIS_DB),
    API_PORT: String(PORT),
    // Made here and held in memory: the door's fee payer is derived from it.
    WALLET_MASTER_KEY: masterKey,
    TREASURY_WALLET_ADDRESS: treasuryAddress,
    SOLANA_RPC_URL: RPC,
    // The door; start-api.sh adds what it needs on --run devnet (sending, the settlement worker).
    X402_ENABLED: "true",
    // The settlement worker every 5 seconds, so a payment is seen settled within the walk.
    X402_SETTLEMENT_INTERVAL_MS: "5000",
    // The stand-in for Nosana, kept by WITH_NOSANA=1 in place of the account of apps/api/.env: every
    // Nosana setting is named here, so none of the settings file's is used. The answer is the stand-in
    // node's fixed sentence; no GPU runs and nothing is spent.
    WITH_NOSANA: "1",
    NOSANA_API_URL: `http://127.0.0.1:${STAND_IN_PORT}`,
    NOSANA_API_KEY: STAND_IN_KEY,
    NOSANA_ACCESS_MODE: "api_key",
    NOSANA_WALLET_PRIVATE_KEY: "",
    NOSANA_CREDITS_CACHE_MS: "0",
    ALLOW_NOSANA_MOCK: "false",
    ALLOW_LOOPBACK_NODE_URLS: "true",
    NODE_EXTRA_CA_CERTS: path.join(tlsDir, "node.crt"),
    DEPLOYMENT_STATUS_INTERVAL_MS: "3000",
    GPU_BILLING_INTERVAL_MS: "4000",
    // Sign-up writes its emails to the API's log: no email leaves this machine.
    EMAIL_PROVIDER: "log",
    PRISMA_QUERY_LOG: "off",
  };
  delete apiEnv.DATABASE_URL;
  delete apiEnv.REDIS_URL;
  delete apiEnv.WALLET_MASTER_KEY_FILE;
  const log = fs.openSync(path.join(outDir, "api.log"), "w");
  api = spawn("bash", [path.join(__dirname, "start-api.sh"), "--run", "devnet"], { env: apiEnv, stdio: ["ignore", log, log], detached: true });
  api.on("error", (err) => {
    api.failed = err;
  });
  for (let i = 0; i < 60; i++) {
    if ((await answers(`${API}/health`)) === 200) return;
    if (api.exitCode !== null || api.failed) break;
    await sleep(2000);
  }
  throw new Error(`the walk's API did not come up at ${API}: see ${path.join(outDir, "api.log")}`);
}

/** Stops a process group and waits for it to go, so nothing of the walk's is left running. */
async function stopGroup(child, isUp) {
  if (!child || !child.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  // The API drains its in-flight runs for up to 15 seconds before it ends.
  for (let i = 0; i < 40 && (await isUp()); i++) await sleep(1000);
  if (await isUp()) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }
}

// ============================================
// The walk
// ============================================

const anyone = new Client({ cookies: false });
const report = {};
/** What the give-back needs, filled as the walk goes. */
const held = { payer: null, treasury: null, feePayer: null, ownFees: [], payerStart: null, rent: 0n, walked: false };

/**
 * --local-chain only: a payer made in memory, given 1 SOL by the local faucet and 0.20 USDC by the local
 * chain's mint authority (the throwaway key local-chain.sh keeps), so the rest of the walk runs as on devnet.
 */
async function localPayer() {
  const payer = web3.Keypair.generate();
  const airdrop = await chain.requestAirdrop(payer.publicKey, SOL);
  await chain.confirmTransaction(airdrop, "confirmed");
  const keys = path.join(process.env.WHEELSAI_LOCAL_CHAIN_DIR || path.join(os.homedir(), ".wheelsai", "local-chain"), "keys");
  const authority = web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(keys, "mint-authority.json"), "utf8"))));
  const account = await spl.getOrCreateAssociatedTokenAccount(chain, payer, USDC, payer.publicKey);
  await spl.mintTo(chain, payer, USDC, account.address, authority, NEEDED_USDC);
  return payer;
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  console.log(`The x402 door on devnet: RPC ${RPC_SHOWN}, API ${API}, database ${DB}`);

  step(LOCAL ? "Before the walk: the local test chain, and a payer made for it" : "Before the walk: devnet, and the payer's wallet");
  const payer = LOCAL ? await localPayer() : readPayer(PAYER_FILE);
  held.payer = payer;
  console.log(
    LOCAL
      ? `      the payer is ${payer.publicKey.toBase58()} (made in memory for the local chain)`
      : `      the payer is ${payer.publicKey.toBase58()} (read from ${PAYER_FILE}; nothing of it is written)`,
  );
  const genesis = await rpc(() => chain.getGenesisHash()).catch(() => null);
  if (!LOCAL && genesis !== DEVNET_GENESIS) throw new Error(`the RPC at ${RPC_SHOWN} is not devnet${genesis ? "" : " (it did not answer)"}: this walk runs on devnet and nowhere else`);
  if (LOCAL && genesis === DEVNET_GENESIS) throw new Error("--local-chain found devnet itself at this address: it runs only on a local test chain");
  const startSol = await solOf(payer.publicKey);
  const startUsdc = await usdcOf(payer.publicKey);
  console.log(`      it holds ${sol(startSol)} and ${usdc(startUsdc)} on devnet`);
  if (startSol < BigInt(NEEDED_LAMPORTS) || startUsdc === null || startUsdc < NEEDED_USDC) {
    const address = payer.publicKey.toBase58();
    console.log(`\nThe payer is not funded for this walk. It needs, on DEVNET, at ${address}:`);
    if (startSol < BigInt(NEEDED_LAMPORTS)) {
      console.log(`  - about 0.03 devnet SOL (it holds ${sol(startSol)}): from https://faucet.solana.com (choose devnet),`);
      console.log(`    or: solana airdrop 1 ${address} --url devnet`);
    }
    if (startUsdc === null || startUsdc < NEEDED_USDC) {
      console.log(`  - at least 0.20 devnet USDC (it holds ${usdc(startUsdc)}): from https://faucet.circle.com (choose Solana, Devnet),`);
      console.log(`    sent to ${address}; it lands in the wallet's own USDC account of the mint ${USDC.toBase58()}`);
    }
    console.log("Get it and run the walk again. Nothing was made and nothing was sent.");
    return "unfunded";
  }
  held.payerStart = { sol: startSol, usdc: startUsdc };

  // Wallets that exist only while this walk runs. The fee payer is the door's, derived from the master key
  // exactly as the API derives it, so that the walk can hand its SOL back at the end.
  const masterKey = randomBytes(32).toString("hex");
  const treasury = web3.Keypair.generate();
  const feePayer = web3.Keypair.fromSeed(
    new Uint8Array(hkdfSync("sha512", Buffer.from(masterKey, "utf8"), Buffer.from(X402_FEE_PAYER_SALT, "utf8"), Buffer.from(X402_FEE_PAYER_INFO, "utf8"), 32)),
  );
  held.treasury = treasury;
  held.feePayer = feePayer;
  console.log(`      the treasury of this walk is ${treasury.publicKey.toBase58()}, made in memory`);

  step("The payer opens the treasury's USDC account");
  // Idempotent: an account that is already there is left as it is.
  const opened = await send([spl.createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ataOf(treasury.publicKey), treasury.publicKey, USDC)], [payer]);
  held.ownFees.push({ what: "open the treasury's USDC account", signature: opened });
  const treasuryAccount = await accountOf(ataOf(treasury.publicKey));
  held.rent = treasuryAccount ? BigInt(treasuryAccount.lamports) : 0n;
  check("the treasury's USDC account is open, holding nothing", treasuryAccount !== null && (await usdcOf(treasury.publicKey)) === 0n, `${ataOf(treasury.publicKey).toBase58()} rent ${held.rent} | ${explorer(opened)}`);

  step("The walk's own API, with the x402 door open, and a stand-in for Nosana");
  await startStandIn();
  await startApi(masterKey, treasury.publicKey.toBase58());
  console.log(`      the API answers at ${API}, on the database ${DB}`);

  step("A seller puts an agent on sale per use at $0.05 and lets people pay from a wallet");
  const seller = await account("seller", 5000);
  await deploy(seller, `x402-devnet-walk-${STAMP}`);
  const sale = await agentOnSale(seller, `Devnet Door Agent ${STAMP}`);
  const { listing, handle } = sale;
  check(
    "an agent that converses, on the model the seller runs on the stand-in, is on sale for use at $0.05 a message",
    sale.created.status === 201 && listing.sells === "use" && listing.pricingModel === "per_request" && Number(listing.pricePerRequestCents) === PER_USE && !!handle,
    `${sale.created.status} ${short(sale.created.body, 200)}`,
  );
  let r = await seller.client.call("PATCH", `/api/marketplace/listings/${listing.id}`, { x402Enabled: true });
  check("the seller switches paying from a wallet on: saved, and the answer says so", r.status === 200 && r.body.listing?.x402Enabled === true, `${r.status} ${short(r.body.fields ?? r.body, 240)}`);
  r = await seller.client.call("GET", "/api/capabilities");
  check("the capabilities say paying from a wallet is available", r.status === 200 && r.body.x402?.available === true, `${r.status} x402=${short(r.body.x402)}`);
  const pageAt = { route: `/api/a/${handle}/chat`, body: chatBody() };

  step("A call with no account and no payment is answered 402, with what to pay");
  const unpaid = await anyone.call("POST", pageAt.route, pageAt.body);
  const required = requiredOf(unpaid);
  const want = Array.isArray(required?.accepts) ? (required.accepts[0] ?? null) : null;
  check(
    "an unpaid call is answered 402 with a PAYMENT-REQUIRED header that decodes",
    unpaid.status === 402 && !!want,
    `${unpaid.status} ${short(unpaid.body)} header=${short(unpaid.headers.get("payment-required") ?? "none", 60)}`,
  );
  if (!want) throw new Error("the door asked for no payment; nothing after this can be walked");
  report.required = required;
  console.log("      PAYMENT-REQUIRED, decoded:");
  console.log(JSON.stringify(required, null, 2).replace(/^/gm, "        "));
  check(
    "it is version 2, with no error, names this use's address and offers one way to pay",
    required.x402Version === 2 && required.error === undefined && typeof required.resource?.url === "string" && required.resource.url.endsWith(`/api/a/${handle}/chat`) && required.accepts.length === 1,
    short({ x402Version: required.x402Version, error: required.error, resource: required.resource, ways: required.accepts.length }, 300),
  );
  check(
    "the way to pay: exact, on devnet's CAIP-2 network, 50000 units of devnet USDC, to the treasury wallet (not its USDC account), within 180 seconds",
    want.scheme === "exact" && want.network === DEVNET_CAIP2 && want.amount === "50000" && want.asset === USDC.toBase58() && want.payTo === treasury.publicKey.toBase58() && want.maxTimeoutSeconds === 180,
    short({ ...want, extra: undefined }, 400),
  );
  check(
    "the fee payer is the door's own, derived from the walk's master key: not the treasury and not the payer",
    want.extra?.feePayer === feePayer.publicKey.toBase58() && want.extra.feePayer !== treasury.publicKey.toBase58() && want.extra.feePayer !== payer.publicKey.toBase58(),
    `feePayer=${want.extra?.feePayer}`,
  );
  check(
    "the memo is short enough for a standard client to pay: 24 base64url characters",
    typeof want.extra?.memo === "string" && /^[A-Za-z0-9_-]{24}$/.test(want.extra.memo),
    `memo=${want.extra?.memo}`,
  );
  check(
    "the body is the house refusal with the price and the unit: x402_payment_required, in a sentence, 5 cents, message",
    unpaid.body.error === "x402_payment_required" && unpaid.body.message === SAID.payFirst && unpaid.body.priceCents === PER_USE && unpaid.body.unit === "message" && Object.keys(unpaid.body).sort().join(",") === "error,message,priceCents,unit",
    short(unpaid.body, 300),
  );
  // SOL is sent only to a fee payer whose key the walk holds, so it can always be handed back.
  if (!isAddress(want.extra?.feePayer) || want.extra.feePayer !== feePayer.publicKey.toBase58()) {
    throw new Error("the door named a fee payer the walk did not derive: no SOL is sent to it");
  }

  step("The payer sends the fee payer 0.02 SOL");
  const funded = await send([web3.SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: feePayer.publicKey, lamports: FEE_PAYER_LAMPORTS })], [payer]);
  held.ownFees.push({ what: "0.02 SOL to the fee payer", signature: funded });
  const feePayerFunded = await solOf(feePayer.publicKey);
  check("the fee payer holds 0.02 SOL, twice the floor under which the door is not available", feePayerFunded === BigInt(FEE_PAYER_LAMPORTS), `${feePayerFunded} lamports | ${explorer(funded)}`);

  step("One use, paid from the payer's wallet");
  const money = async () => ({
    payerUsdc: await usdcOf(payer.publicKey),
    payerSol: await solOf(payer.publicKey),
    treasuryUsdc: await usdcOf(treasury.publicKey),
    feePayerSol: await solOf(feePayer.publicKey),
  });
  const beforePaid = await money();
  // The payer's SOL before the use is what it held, less only its own two transactions: the rent of the
  // treasury's account, 0.02 SOL, and the fee of each.
  const feesSoFar = await Promise.all(held.ownFees.map((t) => feeOf(t.signature)));
  const ownSoFar = feesSoFar.every((f) => f !== null) ? feesSoFar.reduce((a, b) => a + b, 0n) + held.rent + BigInt(FEE_PAYER_LAMPORTS) : null;
  check(
    "so far the payer's SOL moved only by its own two transactions: the treasury account's rent, 0.02 SOL, and their fees",
    ownSoFar !== null && startSol - beforePaid.payerSol === ownSoFar,
    `${startSol} -> ${beforePaid.payerSol} (its own: ${ownSoFar}, fees ${feesSoFar.join(" + ")}, rent ${held.rent})`,
  );
  // A fresh 402 just before paying, as a client does when it pays: its own memo. The blockhash is taken at
  // finalized: devnet's RPC is many nodes behind one address, and a blockhash only confirmed on one of them
  // can be unknown to the node the door asks a moment later, which then refuses the payment as one that
  // would not go through. A finalized one is known to every node and still lives well past the door's 45
  // seconds.
  const payOnce = async () => {
    const ask = await anyone.call("POST", pageAt.route, pageAt.body);
    const askRequired = requiredOf(ask);
    const askAccepted = askRequired?.accepts?.[0];
    if (ask.status !== 402 || !askAccepted) throw new Error(`the 402 before paying asked for no payment: ${ask.status} ${short(ask.body)}`);
    const blockhash = (await rpc(() => chain.getLatestBlockhash("finalized"))).blockhash;
    const signed = paymentSignatureOf(askRequired, exactPayment({ payer, accepted: askAccepted, amount: AMOUNT, blockhash }));
    return { header: signed, paid: await anyone.call("POST", pageAt.route, pageAt.body, { "PAYMENT-SIGNATURE": signed }) };
  };
  let { header, paid } = await payOnce();
  if (paid.status === 402 && requiredOf(paid)?.error === "transaction_simulation_failed") {
    // The door writes nothing before its claim, so a payment refused here left no row and sent nothing.
    // One more try, on a new 402 and a new blockhash, tells a node that was behind from a payment that
    // cannot go through; the run says it tried twice.
    console.log("      the door said this payment would not go through; trying once more with a new 402 and a new blockhash");
    ({ header, paid } = await payOnce());
  }
  // Read at once: the claim is that the chain has confirmed the payment by the time the answer arrives. A
  // node of the public RPC a slot behind may not know it yet, so up to three more reads, a second apart.
  const paidResponse = responseOf(paid);
  const signature = isSignature(paidResponse?.transaction) ? paidResponse.transaction : null;
  const isConfirmed = (s) => !!s && ["confirmed", "finalized"].includes(s.confirmationStatus);
  let statusAt200 = null;
  let statusReads = 0;
  while (signature && !isConfirmed(statusAt200) && statusReads < 4) {
    if (statusReads > 0) await sleep(1000);
    statusReads += 1;
    statusAt200 = (await rpc(() => chain.getSignatureStatuses([signature], { searchTransactionHistory: true }))).value[0];
  }
  if (isConfirmed(statusAt200)) seenAt(statusAt200.slot);
  const afterPaid = await money();
  const feePaid = beforePaid.feePayerSol - afterPaid.feePayerSol;
  Object.assign(report, { signature, ms: paid.ms, feeBefore: beforePaid.feePayerSol, feeAfter: afterPaid.feePayerSol, feePaid });
  console.log(`      from the request to the answer: ${paid.ms} ms (${(paid.ms / 1000).toFixed(1)} s)`);
  if (signature) console.log(`      the payment: ${signature}\n      ${explorer(signature)}`);
  check("the paid call is answered 200 with the agent's answer", paid.status === 200 && answered(paid), `${paid.status} ${short(paid.body, 300)}`);
  check(
    "PAYMENT-RESPONSE says it went through: success, the transaction's signature, devnet's CAIP-2 network, the payer, 50000 units",
    paidResponse?.success === true && !!signature && paidResponse.network === DEVNET_CAIP2 && paidResponse.payer === payer.publicKey.toBase58() && paidResponse.amount === "50000",
    short(paidResponse, 300),
  );
  check(
    "the answer says what was paid: x-wheelsai-charged-cents 5, and the billing of one use at $0.05 with no balance",
    paid.headers.get("x-wheelsai-charged-cents") === "5" && billingOf(paid)?.chargedCents === PER_USE && billingOf(paid).balanceCents === null && billingOf(paid).access === "listing_pricing",
    `charged=${paid.headers.get("x-wheelsai-charged-cents")} billing=${short(billingOf(paid))}`,
  );
  check(
    "the transaction is confirmed on devnet when the answer arrives",
    isConfirmed(statusAt200) && statusAt200.err === null,
    `${short(statusAt200)} (read ${statusReads} of at most 4)`,
  );
  check(
    "the payer's USDC went down by exactly 50,000 units, and the use took none of its SOL",
    beforePaid.payerUsdc !== null && afterPaid.payerUsdc !== null && beforePaid.payerUsdc - afterPaid.payerUsdc === AMOUNT && afterPaid.payerSol === beforePaid.payerSol,
    `USDC ${beforePaid.payerUsdc} -> ${afterPaid.payerUsdc}, SOL ${beforePaid.payerSol} -> ${afterPaid.payerSol}`,
  );
  check(
    "the treasury's USDC went up by exactly 50,000 units",
    beforePaid.treasuryUsdc !== null && afterPaid.treasuryUsdc !== null && afterPaid.treasuryUsdc - beforePaid.treasuryUsdc === AMOUNT,
    `${beforePaid.treasuryUsdc} -> ${afterPaid.treasuryUsdc}`,
  );
  check(
    "the fee payer paid the fee: between 10,000 and 20,000 lamports",
    feePaid >= 10_000n && feePaid <= 20_000n,
    `${beforePaid.feePayerSol} -> ${afterPaid.feePayerSol} (${feePaid})`,
  );

  step("What was written: one payment, one sale with no buyer, one line in the creator's earnings");
  const payments = rowsOf(`select id, status, payer_address, coalesce(message_hash,''), coalesce(tx_signature,''), org_id from x402_payments where listing_id='${listing.id}'`);
  const [paymentId, paymentStatus, paymentPayer, messageHash, paymentSignature, paymentOrg] = payments[0] ?? [];
  check(
    "exactly one payment row for the listing: verified or settled, from the payer, with the message's hash, the transaction PAYMENT-RESPONSE named, in the seller's organization",
    payments.length === 1 && ["verified", "settled"].includes(paymentStatus) && paymentPayer === payer.publicKey.toBase58() && /^[0-9a-f]{64}$/.test(messageHash ?? "") && !!signature && paymentSignature === signature && paymentOrg === seller.orgId,
    short(payments, 400),
  );
  const sales = paymentId
    ? rowsOf(`select id, coalesce(buyer_id::text,'NULL'), coalesce(payer_wallet,''), type, status, gross_amount_cents, platform_fee_cents, creator_amount_cents, coalesce(listing_id::text,'') from marketplace_revenue where x402_payment_id='${paymentId}'`)
    : [];
  const [revenueId, buyerId, payerWallet, saleType, saleStatus, gross, fee, creator, saleListing] = sales[0] ?? [];
  const listingSales = sql(`select count(*) from marketplace_revenue where listing_id='${listing.id}'`);
  check(
    "exactly one sale for that payment, the listing's only one: no buyer, the paying wallet, type x402, settled, $0.05 of which platform and creator are every cent",
    sales.length === 1 && listingSales === "1" && buyerId === "NULL" && payerWallet === payer.publicKey.toBase58() && saleType === "x402" && saleStatus === "settled" && Number(gross) === PER_USE && Number(fee) + Number(creator) === PER_USE && saleListing === listing.id,
    `${short(sales, 400)} listing sales=${listingSales}`,
  );
  const ledger = revenueId
    ? rowsOf(`select amount_cents, coalesce(description,'') from earnings_transactions where org_id='${seller.orgId}' and type='sale' and reference_id='${revenueId}'`)
    : [];
  check(
    "one line of type sale in the seller's earnings, for that sale, of the creator's part",
    ledger.length === 1 && Number(ledger[0][0]) === Number(creator) && ledger[0][1] === `Sale: ${listing.title}`,
    short(ledger),
  );

  step("The same PAYMENT-SIGNATURE sent again");
  const written = () => ({
    payments: sql(`select count(*) from x402_payments where listing_id='${listing.id}'`),
    sales: sql(`select count(*) from marketplace_revenue where listing_id='${listing.id}'`),
    earnings: sql(`select count(*) || ':' || coalesce(sum(amount_cents),0) from earnings_transactions where org_id='${seller.orgId}'`),
    sent: paymentId ? sql(`select coalesce(tx_signature,'') from x402_payments where id='${paymentId}'`) : "",
  });
  const writtenAgain = written();
  const moneyAgain = await money();
  const again = await anyone.call("POST", pageAt.route, pageAt.body, { "PAYMENT-SIGNATURE": header });
  const againRequired = requiredOf(again);
  check(
    "it is refused 402 x402_payment_invalid: PAYMENT-REQUIRED says duplicate_settlement, the sentence that it was presented once",
    again.status === 402 && again.body.error === "x402_payment_invalid" && againRequired?.error === "duplicate_settlement" && again.body.message === SAID.presentedTwice,
    `${again.status} ${again.body.error} error=${againRequired?.error} ${short(again.body.message, 120)}`,
  );
  const moneyAgain2 = await money();
  check("no row and no balance changed", same(written(), writtenAgain) && same(moneyAgain2, moneyAgain), `rows ${json(writtenAgain)} -> ${json(written())} | money ${json(moneyAgain)} -> ${json(moneyAgain2)}`);

  step("The settlement worker");
  const finalStatus = paymentId ? await waitFor(() => sql(`select status from x402_payments where id='${paymentId}'`), (s) => s === "settled", 120) : null;
  check("the settlement worker marks the payment settled within 2 minutes, once devnet has made it final", finalStatus === "settled", `status=${finalStatus}`);

  step("What the door's answers never say");
  // Wallets, the mint and signatures are keys, not words: three letters of one could read as SQL by chance.
  const keys = new Set([treasury.publicKey, ataOf(treasury.publicKey), payer.publicKey, ataOf(payer.publicKey), feePayer.publicKey, USDC].map((k) => k.toBase58()));
  const wordsOf = (answer) => {
    const parts = [answer.text];
    for (const [name, value] of answer.headers) {
      const decoded = name === "payment-required" || name === "payment-response" ? fromBase64Json(value) : null;
      if (decoded && typeof decoded === "object") {
        // The published reason strings are the one place a reason may be named.
        const rest = { ...decoded };
        delete rest.error;
        delete rest.errorReason;
        parts.push(`${name}: ${JSON.stringify(rest)}`);
      } else {
        parts.push(`${name}: ${value}`);
      }
    }
    let text = parts.join("\n");
    for (const value of keys) text = text.split(value).join("<key>");
    return text
      .replace(/[1-9A-HJ-NP-Za-km-z]{86,88}/g, (found) => (isSignature(found) ? "<signature>" : found))
      // A memo is 24 base64url characters, quoted in the JSON it travels in.
      .replace(/"[A-Za-z0-9_-]{24}"/g, '"<memo>"');
  };
  const banned = [
    ["prisma", (t) => /prisma/i.exec(t)],
    ["postgres", (t) => /postgres/i.exec(t)],
    ["a Prisma code", (t) => /P20\d\d/.exec(t)],
    ["SQL", (t) => /SQL/.exec(t)],
    ["InstructionError", (t) => /InstructionError/.exec(t)],
    ["BlockhashNotFound", (t) => /BlockhashNotFound/.exec(t)],
    ["lamports", (t) => /lamports/i.exec(t)],
    ["Too Many Requests", (t) => /Too Many Requests/i.exec(t)],
    ["the seller's organization", (t) => (t.includes(seller.orgId) ? { index: t.indexOf(seller.orgId) } : null)],
    ["the model", (t) => /llama/i.exec(t)],
  ];
  const leaks = [];
  for (const answer of seen) {
    const text = wordsOf(answer);
    for (const [name, find] of banned) {
      const found = find(text);
      if (found) leaks.push(`${answer.what}: ${name} in "${text.slice(Math.max(0, found.index - 40), found.index + 40).replace(/\s+/g, " ")}"`);
    }
  }
  check(
    `no answer of the door (${seen.length} of them) holds prisma, postgres, a P20 code, SQL, InstructionError, BlockhashNotFound, lamports, Too Many Requests, the seller's organization or the model`,
    seen.length > 0 && leaks.length === 0,
    leaks.slice(0, 3).join(" || "),
  );
  held.walked = true;
}

// ============================================
// The give-back: nothing of the payer's is left with the walk's wallets
// ============================================

/**
 * Runs after the API and the stand-in are stopped, whether the walk passed, failed or stopped: the fee
 * payer's SOL goes back to the payer, and the treasury's USDC too, its token account closed with the rent
 * to the payer. The keys of both exist only in this process, so this is the last chance: each step is
 * tried a few times on a public RPC before the walk says what is left where.
 */
async function giveBack() {
  const { payer, treasury, feePayer } = held;
  if (!payer || !treasury || !feePayer) return null;
  step("Handing back: the fee payer's SOL and the treasury's USDC go to the payer");
  const done = { feePayer: null, treasury: null, returnedLamports: 0n, returnedUsdc: 0n };
  for (let attempt = 1; attempt <= 5 && done.feePayer === null; attempt++) {
    try {
      const left = await solOf(feePayer.publicKey);
      if (left === 0n) {
        done.feePayer = "nothing to hand back";
        break;
      }
      // The fee of this one transfer, read from the chain, so the fee payer ends at exactly 0 lamports
      // (an account may hold 0, but not less than its rent).
      const latest = await rpc(() => chain.getLatestBlockhash("confirmed"));
      const probe = new web3.Transaction({ feePayer: feePayer.publicKey, recentBlockhash: latest.blockhash }).add(
        web3.SystemProgram.transfer({ fromPubkey: feePayer.publicKey, toPubkey: payer.publicKey, lamports: 1 }),
      );
      const fee = BigInt((await rpc(() => chain.getFeeForMessage(probe.compileMessage(), "confirmed"))).value ?? 5000);
      if (left <= fee) {
        done.feePayer = `${left} lamports left, less than the fee of sending them`;
        break;
      }
      const signature = await sendNow([web3.SystemProgram.transfer({ fromPubkey: feePayer.publicKey, toPubkey: payer.publicKey, lamports: Number(left - fee) })], [feePayer]);
      done.returnedLamports = left - fee;
      done.feePayer = signature;
      console.log(`      ${sol(left - fee)} from the fee payer to the payer: ${explorer(signature)}`);
    } catch (err) {
      console.log(`      the fee payer's SOL could not be sent back yet (try ${attempt} of 5): ${short(String(err && err.message ? err.message : err), 160)}`);
      await sleep(5000);
    }
  }
  const treasuryAta = ataOf(treasury.publicKey);
  for (let attempt = 1; attempt <= 5 && done.treasury === null; attempt++) {
    try {
      const account = await accountOf(treasuryAta);
      if (!account) {
        done.treasury = "no account to close";
        break;
      }
      const units = spl.unpackAccount(treasuryAta, account).amount;
      const instructions = [];
      if (units > 0n) instructions.push(spl.createTransferCheckedInstruction(treasuryAta, USDC, ataOf(payer.publicKey), treasury.publicKey, units, 6));
      // The rent of the account goes back to the payer, who paid it.
      instructions.push(spl.createCloseAccountInstruction(treasuryAta, payer.publicKey, treasury.publicKey));
      // The payer pays the fee: the treasury holds no SOL.
      const signature = await sendNow(instructions, [payer, treasury]);
      held.ownFees.push({ what: "the treasury's USDC back, its account closed", signature });
      done.returnedUsdc = units;
      done.treasury = signature;
      console.log(`      ${usdc(units)} from the treasury to the payer, its account closed: ${explorer(signature)}`);
    } catch (err) {
      console.log(`      the treasury's USDC could not be sent back yet (try ${attempt} of 5): ${short(String(err && err.message ? err.message : err), 160)}`);
      await sleep(5000);
    }
  }
  if (done.feePayer === null) console.log(`NOTE: the fee payer ${feePayer.publicKey.toBase58()} still holds devnet SOL the walk could not send back.`);
  if (done.treasury === null) console.log(`NOTE: the treasury's USDC account ${treasuryAta.toBase58()} still holds devnet USDC the walk could not send back.`);
  return done;
}

/** After the give-back of a walk that went through: the payer is where it started, less the network's fees. */
async function checkGivenBack(done) {
  const { payer, treasury, feePayer, payerStart } = held;
  const end = { sol: await solOf(payer.publicKey), usdc: await usdcOf(payer.publicKey), feePayer: await solOf(feePayer.publicKey) };
  const treasuryGone = (await accountOf(ataOf(treasury.publicKey))) === null;
  check("the fee payer's SOL is back with the payer: the fee payer holds 0 lamports", end.feePayer === 0n && typeof done?.feePayer === "string" && isSignature(done.feePayer), `${end.feePayer} lamports left`);
  check("the treasury's USDC is back with the payer and its token account is closed", treasuryGone && done?.returnedUsdc === AMOUNT, `returned ${done?.returnedUsdc} units, account ${treasuryGone ? "closed" : "still open"}`);
  check("the payer holds the USDC it started with", end.usdc === payerStart.usdc, `${payerStart.usdc} -> ${end.usdc}`);
  // The payer sent 0.02 SOL and got back what the fee payer had left, and paid the rent and got it back:
  // what it lost is the fees of its own three transactions, the paid use's fee and the hand-back's fee.
  const fees = await Promise.all(held.ownFees.map((t) => feeOf(t.signature)));
  const known = fees.every((f) => f !== null);
  const expected = known ? payerStart.sol - fees.reduce((a, b) => a + b, 0n) - BigInt(FEE_PAYER_LAMPORTS) + done.returnedLamports : null;
  check(
    "the payer's SOL is what it started with, less only the network's fees of the walk (the paid use's and the hand-back's paid from the 0.02 SOL it lent)",
    expected !== null && end.sol === expected,
    `${payerStart.sol} -> ${end.sol}, worked out here ${expected}: spent ${payerStart.sol - end.sol} lamports in all`,
  );
}

function finish() {
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed} of ${results.length} checks passed, in ${clock()}`);
  console.log(`The walk's records are in the database ${DB}; the API's log is ${path.join(outDir, "api.log")}.`);
  return passed === results.length ? 0 : 1;
}

async function end(outcome) {
  if (ending) return;
  ending = true;
  // The API first, so nothing of the door can use the fee payer while its SOL is handed back.
  await stopGroup(api, async () => (await answers(`${API}/health`)) !== 0);
  await stopGroup(standIn, async () => (await answers(`http://127.0.0.1:${STAND_IN_PORT}/`)) !== 0);
  // main() is not stopped by an interrupt: a transfer it had already started lands, or not, before the
  // hand-back reads what the fee payer and the treasury hold.
  await Promise.allSettled([...inFlight]);
  let done = null;
  try {
    done = await giveBack();
  } catch (err) {
    console.log(`NOTE: the hand-back stopped: ${short(String(err && err.message ? err.message : err), 200)}`);
  }
  if (held.walked && outcome === "walked") {
    await checkGivenBack(done).catch((err) => check("the hand-back could be checked", false, short(String(err && err.message ? err.message : err), 200)));
  }
  if (report.required) {
    console.log("\n-- For the founder");
    console.log(`The paid use: ${report.signature ?? "(none)"}, answered ${report.ms} ms after the request`);
    if (report.signature) console.log(`On the explorer: ${explorer(report.signature)}`);
    console.log(`The fee payer paid ${report.feePaid} lamports for it (${report.feeBefore} before, ${report.feeAfter} after)`);
  }
  // The walk filled its Redis database itself, on one that was empty when it started.
  try {
    if (apiEnv) redis("flushdb");
  } catch {}
  // The stand-in node's certificate and its TLS key are of no use after the walk.
  if (tlsDir) fs.rmSync(tlsDir, { recursive: true, force: true });
  if (outcome === "unfunded") process.exit(3);
  if (outcome === "stopped") {
    if (results.length) finish();
    process.exit(2);
  }
  if (outcome === "interrupted") process.exit(130);
  process.exit(finish());
}
/** Every way out goes through end(): the treasury's and the fee payer's keys exist only in this process. */
function stoppedBy(err) {
  try {
    console.error("\nWALK STOPPED:", err && err.stack ? err.stack : err);
  } catch {}
  return end("stopped");
}
process.on("SIGINT", () => end("interrupted"));
process.on("SIGTERM", () => end("interrupted"));
// A closed terminal ends the walk the way Ctrl+C does, not by Node's default of leaving at once.
process.on("SIGHUP", () => end("interrupted"));
process.on("uncaughtException", stoppedBy);
process.on("unhandledRejection", stoppedBy);
// With the terminal gone, a write to it fails; that must not cut the hand-back short.
for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});
main()
  .then((outcome) => end(outcome === "unfunded" ? "unfunded" : "walked"))
  .catch(stoppedBy);
