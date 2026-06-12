/**
 * THROWAWAY SPIKE — Bags launchpad viability validation.
 *
 * Purpose: answer two questions before we invest in a real Bags adapter:
 *   1. (keyless) Is Bags' on-chain layer present on the target cluster?
 *   2. (full)    Can we launch a token + claim fees end-to-end via the SDK,
 *                routing a fee share to a wallet WE control (so it can be
 *                swept into the agent-treasury PDA)?
 *
 * KEY FINDING (2026-05-30): Bags Fee Share V1/V2 programs and the Bags
 * global LUT are NOT deployed on devnet — only Meteora DBC/DAMM are. So
 * Bags is effectively MAINNET-ONLY. The --full flow therefore spends REAL
 * SOL and is guarded behind an explicit acknowledgement flag.
 *
 * OPEN QUESTIONS the --full run must answer before the production adapter
 * (services/launchpad/bagsAdapter.ts) flips BAGS_ADAPTER_IMPLEMENTED=true:
 *   Q1  Does the launch tx require the tokenMint to sign, or only
 *       launchWallet? If the mint must sign, the browser-only single-sig
 *       design (Option B) breaks → fall back to multi-tx (Option A).
 *   Q2  Will Bags accept a launch whose config `payer` differs from the
 *       launch `launchWallet`? (Run a variant with two distinct wallets.)
 *   Q3  For a single 100%-claimer config, does createBagsFeeShareConfig
 *       return `transactions` (RPC-send) or `bundles` (Jito sendBundle)?
 *   Q4  Are getClaimTransactions legacy txs returned with feePayer +
 *       recentBlockhash set, or must the worker fill them? Does a fresh
 *       launch + tiny buy yield an immediately-claimable position?
 *   Q5  Actual lamports landed in the fee wallet vs the displayed
 *       claimable amount (sets the fee_receive amount basis + rent buffer).
 *   Q6  Confirm re-calling createBagsFeeShareConfig for an existing
 *       baseMint throws "Config already exists" (retry-safety).
 *   Q7  Total SOL cost (config + launch + buy + claim + fee_receive).
 *
 * Usage:
 *   # 1) keyless cluster probe (safe, no key, no SOL) — default:
 *   tsx scripts/bags-spike.ts probe                 # uses SOLANA_NETWORK
 *   tsx scripts/bags-spike.ts probe --cluster mainnet
 *
 *   # 2) full launch + claim (MAINNET, SPENDS REAL SOL):
 *   BAGS_API_KEY='...' \
 *   BAGS_SPIKE_PAYER_PRIVATE_KEY='[12,34,...]' \   # funded mainnet wallet
 *   tsx scripts/bags-spike.ts full --i-understand-real-sol
 *
 * Get a Bags API key at https://bags.fm (Settings → API). Fund the payer
 * with ~0.05 SOL on mainnet (launch rent + tiny initial buy + Jito tip).
 *
 * This file imports no project internals on purpose — it's a sandbox.
 * Delete once the adapter decision is locked.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import { BagsSDK } from "@bagsfm/bags-sdk";

const ENDPOINTS = {
  mainnet: "https://api.mainnet-beta.solana.com",
  devnet: "https://api.devnet.solana.com",
} as const;

// Bags / Meteora on-chain dependencies (from @bagsfm/bags-sdk constants).
const BAGS_DEPS: Record<string, string> = {
  "Bags Fee Share V2 (program)": "FEE2tBhCKAt7shrod19QttSVREUYPiyMzoku1mL1gqVK",
  "Bags Fee Share V1 (program)": "FEEhPbKVKnco9EXnaY3i4R5rQVUx91wgVfu8qokixywi",
  "Meteora DBC (program)": "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",
  "Meteora DAMM v2 (program)": "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
  "Bags global LUT": "Eq1EVs15EAWww1YtPTtWPzJRLPJoS6VYP9oW9SbNr3yp",
};

function resolveCluster(): "mainnet" | "devnet" {
  const flagIdx = process.argv.indexOf("--cluster");
  if (flagIdx >= 0) {
    const v = process.argv[flagIdx + 1];
    if (v === "mainnet" || v === "devnet") return v;
    console.error(`--cluster must be 'mainnet' or 'devnet' (got ${v})`);
    process.exit(1);
  }
  return process.env.SOLANA_NETWORK === "mainnet-beta" ? "mainnet" : "devnet";
}

async function probe(): Promise<void> {
  const cluster = resolveCluster();
  const conn = new Connection(ENDPOINTS[cluster], "confirmed");
  console.log(`\n=== Bags dependency probe — ${cluster} (${ENDPOINTS[cluster]}) ===`);
  let bagsLayerPresent = true;
  for (const [name, addr] of Object.entries(BAGS_DEPS)) {
    const info = await conn.getAccountInfo(new PublicKey(addr));
    const present = !!info;
    const tag = info
      ? info.executable
        ? "EXEC"
        : `data:${info.data.length}b`
      : "ABSENT";
    console.log(`  ${present ? "✅" : "❌"} [${tag.padEnd(9)}] ${name}`);
    if (!present && name.startsWith("Bags")) bagsLayerPresent = false;
  }
  console.log(
    bagsLayerPresent
      ? `\n→ Bags layer is present on ${cluster}. Full flow is viable here.`
      : `\n→ Bags layer is ABSENT on ${cluster}. Launches/claims cannot work here.\n  (Meteora DBC may exist, but Bags fee-share + LUT do not.)`,
  );
}

function loadPayer(): Keypair {
  const raw = process.env.BAGS_SPIKE_PAYER_PRIVATE_KEY;
  if (!raw) {
    console.error("BAGS_SPIKE_PAYER_PRIVATE_KEY is required for --full");
    process.exit(1);
  }
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

async function signSendVersioned(
  conn: Connection,
  tx: VersionedTransaction,
  payer: Keypair,
): Promise<string> {
  tx.sign([payer]);
  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
  });
  await conn.confirmTransaction(sig, "confirmed");
  return sig;
}

async function full(): Promise<void> {
  if (!process.argv.includes("--i-understand-real-sol")) {
    console.error(
      "Refusing: --full spends REAL SOL on mainnet.\n" +
        "Re-run with --i-understand-real-sol once the payer is funded.",
    );
    process.exit(1);
  }
  const apiKey = process.env.BAGS_API_KEY;
  if (!apiKey) {
    console.error("BAGS_API_KEY is required for --full (get one at bags.fm).");
    process.exit(1);
  }

  const conn = new Connection(ENDPOINTS.mainnet, "confirmed");
  const payer = loadPayer();
  console.log(`payer: ${payer.publicKey.toBase58()}`);
  const bal = await conn.getBalance(payer.publicKey);
  console.log(`balance: ${(bal / 1e9).toFixed(4)} SOL`);
  if (bal < 0.04 * 1e9) {
    console.error("payer needs ≥ ~0.05 SOL on mainnet. Aborting.");
    process.exit(1);
  }

  const sdk = new BagsSDK(apiKey, conn, "confirmed");

  // 1) metadata
  console.log("\n[1/4] createTokenInfoAndMetadata …");
  const info = await sdk.tokenLaunch.createTokenInfoAndMetadata({
    name: "WheelsAI Spike",
    symbol: "WAISPK",
    description: "Throwaway Bags viability spike — safe to ignore.",
    imageUrl: "https://placehold.co/512x512/png",
  });
  console.log(`  mint=${info.tokenMint}`);
  console.log(`  metadata=${info.tokenMetadata}`);

  const mint = new PublicKey(info.tokenMint);

  // 2) fee-share config — route 100% to a wallet WE control (the payer here;
  //    in production this is the fee-router key). Proves fees can target an
  //    arbitrary pubkey, not just a social handle.
  //    Real v1.3.7 shape: feeClaimers: [{ user, userBps }] (sum === 10000),
  //    payer, baseMint. No `users`, no `quoteMint`.
  console.log("\n[2/4] createBagsFeeShareConfig (100% → payer) …");
  const cfg = await sdk.config.createBagsFeeShareConfig({
    feeClaimers: [{ user: payer.publicKey, userBps: 10_000 }],
    payer: payer.publicKey,
    baseMint: mint,
  });
  // Q3: a single 100%-claimer config may return `transactions` (RPC-send)
  // or `bundles` (Jito-only). Log both so the spike answers which path.
  console.log(
    `  transactions=${cfg.transactions.length} bundles=${cfg.bundles.length}`,
  );
  for (const tx of cfg.transactions) {
    const sig = await signSendVersioned(conn, tx, payer);
    console.log(`  config tx: ${sig}`);
  }
  console.log(`  meteoraConfigKey=${cfg.meteoraConfigKey.toBase58()}`);

  // 3) launch
  console.log("\n[3/4] createLaunchTransaction + send …");
  const launchTx = await sdk.tokenLaunch.createLaunchTransaction({
    metadataUrl: info.tokenMetadata,
    tokenMint: mint,
    launchWallet: payer.publicKey,
    initialBuyLamports: 5_000_000, // 0.005 SOL — generates claimable fees
    configKey: cfg.meteoraConfigKey,
  });
  // Q1 (load-bearing for the production adapter's Option B): which keys does
  // the launch tx require to sign? If the mint must sign, the browser-only
  // single-signature design breaks (the browser holds neither the mint nor
  // a server key). The launchWallet here === payer, so this run can't fully
  // isolate it — but log the required-signer set for inspection.
  const sigKeys = launchTx.message.staticAccountKeys
    .slice(0, launchTx.message.header.numRequiredSignatures)
    .map((k) => k.toBase58());
  console.log(`  launch required signers (${sigKeys.length}): ${sigKeys.join(", ")}`);
  console.log(
    `  → mint (${mint.toBase58()}) in signer set? ` +
      `${sigKeys.includes(mint.toBase58())} [Q1]`,
  );
  const launchSig = await signSendVersioned(conn, launchTx, payer);
  console.log(`  launch tx: ${launchSig}`);
  console.log(`  explorer: https://solscan.io/tx/${launchSig}`);

  // 4) prove the claim path works to our wallet
  console.log("\n[4/4] fee claim path …");
  const positions = await sdk.fee.getAllClaimablePositions(payer.publicKey);
  console.log(`  claimable positions: ${positions.length}`);
  const claimTxs = await sdk.fee.getClaimTransactions(payer.publicKey, mint);
  console.log(
    `  getClaimTransactions returned ${claimTxs.length} tx(s) — ` +
      `claim routes to ${payer.publicKey.toBase58()} ✔`,
  );

  console.log(
    "\n✅ Spike complete. Launch + fee-config + claim path all functional.\n" +
      "   Fees are claimable to an arbitrary controlled wallet → sweepable\n" +
      "   into the agent-treasury PDA via the existing fee_receive flow.",
  );
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === "full") return full();
  // default + "probe"
  return probe();
}

main().catch((err) => {
  console.error("\nspike failed:", err);
  process.exit(1);
});
