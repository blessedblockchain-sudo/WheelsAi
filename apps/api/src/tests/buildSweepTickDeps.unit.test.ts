/**
 * Drives apps/api/src/services/buildSweepTickDeps.ts: how a sweep's
 * transaction is built and signed, and how the sweep is bound to the
 * database and to the node. Stand-ins only.
 *
 * Pinning:
 *   - each transaction has exactly the instructions, the fee payer and
 *     the signers the contract says;
 *   - no destination other than the hot wallet and the proven treasury
 *     can be reached, and no source other than the hot wallet and an
 *     address whose key this server derives;
 *   - the treasury is proven only by rule 4;
 *   - the reads (one call for 50 addresses, at finalized; a token account
 *     that is not that owner's USDC holds nothing) and the writes (the
 *     claim, the compare-and-set that ends a row);
 *   - the production wiring and the queue's two names.
 */

import "./unitEnv.js";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  decodeTransferCheckedInstruction,
} from "@solana/spl-token";
import {
  PublicKey,
  SystemInstruction,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import bs58 from "bs58";

import {
  SWEEP_ADDRESS_LIMIT,
  SWEEP_SENT_LIMIT,
  buildProductionSweepDeps,
  buildSweepTransaction,
  readProvenTreasury,
  signSweepTransaction,
  sweepSettingsFromEnv,
  sweepTickInputFromEnv,
  type BuildSweepTransactionInput,
  owedForOpenPayouts,
  readOpenWalletPayouts,
} from "../services/buildSweepTickDeps.js";
import { NO_TREASURY_ADDRESS, type PlannedTransfer } from "../services/sweepPlan.js";
import {
  DEVNET,
  FEE,
  HOT,
  HOT_KEYPAIR,
  KEEP,
  NOW,
  ORG_1,
  ORG_2,
  OTHER_MINT,
  SOL,
  TREASURY,
  USDC,
  USDC_MINT,
  addressRow,
  depositAddressOf,
  depositKeypairOf,
  keypairOf,
  makeSweepDb,
  setupSweep,
  tokenAccountInfo,
  transferRow,
  treasuryRow,
  usdcAccountOf,
} from "./sweepStandIn.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A1 = depositAddressOf(ORG_1);
const BLOCKHASH = keypairOf("a-blockhash").publicKey.toBase58();
const ELSEWHERE = keypairOf("elsewhere").publicKey.toBase58();

function planned(over: Partial<PlannedTransfer> = {}): PlannedTransfer {
  return {
    kind: "sweep_to_hot",
    asset: "USDC",
    fromAddress: A1,
    toAddress: HOT,
    orgId: ORG_1,
    amountRaw: 60n * USDC,
    feeLamports: 10_000n,
    feePayer: HOT,
    valueCents: 6_000n,
    ...over,
  };
}

function buildInput(transfer: PlannedTransfer, over: Partial<BuildSweepTransactionInput> = {}): BuildSweepTransactionInput {
  return {
    transfer,
    hotWallet: HOT_KEYPAIR.publicKey,
    treasury: new PublicKey(TREASURY),
    usdcMint: USDC_MINT,
    blockhash: BLOCKHASH,
    lastValidBlockHeight: 4_321,
    ...over,
  };
}

/** The signed transaction, read back from the bytes that would be stored. */
function signedAndRead(transfer: PlannedTransfer) {
  const artifact = signSweepTransaction(buildInput(transfer), {
    hotWallet: HOT_KEYPAIR,
    source: transfer.kind === "hot_to_treasury" ? null : depositKeypairOf(transfer.orgId as string),
  });
  const tx = Transaction.from(Buffer.from(artifact.signedTxB64, "base64"));
  return { artifact, tx };
}

const keysOf = (ix: { keys: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }> }) =>
  ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]);

/** Asserts the two instructions of a USDC transfer, and nothing else. */
function assertUsdcInstructions(tx: Transaction, want: { source: string; destination: string; amountRaw: bigint }) {
  assert.equal(tx.instructions.length, 2);
  const [open, move] = tx.instructions as [Transaction["instructions"][0], Transaction["instructions"][0]];

  // 1. The destination's USDC account, opened when missing (idempotent),
  //    paid for by the hot wallet.
  assert.ok(open.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID));
  assert.deepEqual([...open.data], [1], "the idempotent create");
  // (Read back from the bytes, a key carries the flags it has anywhere in
  // the transaction, so only the payer's are pinned here.)
  assert.deepEqual(
    open.keys.map((k) => k.pubkey.toBase58()),
    [
      HOT,
      usdcAccountOf(want.destination),
      want.destination,
      USDC_MINT.toBase58(),
      SystemProgram.programId.toBase58(),
      TOKEN_PROGRAM_ID.toBase58(),
    ],
  );
  assert.deepEqual(keysOf(open)[0], [HOT, true, true]);

  // 2. One checked transfer, signed by the owner of the source.
  assert.ok(move.programId.equals(TOKEN_PROGRAM_ID));
  const decoded = decodeTransferCheckedInstruction(move);
  assert.equal(decoded.keys.source.pubkey.toBase58(), usdcAccountOf(want.source));
  assert.equal(decoded.keys.mint.pubkey.toBase58(), USDC_MINT.toBase58());
  assert.equal(decoded.keys.destination.pubkey.toBase58(), usdcAccountOf(want.destination));
  assert.equal(decoded.keys.owner.pubkey.toBase58(), want.source);
  assert.equal(decoded.keys.owner.isSigner, true);
  assert.equal(decoded.data.amount, want.amountRaw);
  assert.equal(decoded.data.decimals, 6);
  assert.equal(move.keys.length, 4, "no further account");
}

function assertSolInstruction(tx: Transaction, want: { source: string; destination: string; lamports: bigint }) {
  assert.equal(tx.instructions.length, 1);
  const ix = tx.instructions[0]!;
  assert.ok(ix.programId.equals(SystemProgram.programId));
  assert.equal(SystemInstruction.decodeInstructionType(ix), "Transfer");
  const decoded = SystemInstruction.decodeTransfer(ix);
  assert.equal(decoded.fromPubkey.toBase58(), want.source);
  assert.equal(decoded.toPubkey.toBase58(), want.destination);
  assert.equal(decoded.lamports, want.lamports);
}

const signersOf = (tx: Transaction) => tx.signatures.map((s) => s.publicKey.toBase58());

// ============================================
// The four transactions
// ============================================

test("USDC off a deposit address: the hot wallet pays, opens the destination's account, one checked transfer; both sign", () => {
  for (const [kind, destination] of [
    ["sweep_to_hot", HOT],
    ["sweep_to_treasury", TREASURY],
  ] as const) {
    const { artifact, tx } = signedAndRead(planned({ kind, toAddress: destination }));
    assert.equal(tx.feePayer!.toBase58(), HOT);
    assert.deepEqual(signersOf(tx), [HOT, A1]);
    assert.equal(tx.verifySignatures(), true);
    assertUsdcInstructions(tx, { source: A1, destination, amountRaw: 60n * USDC });
    assert.equal(tx.recentBlockhash, BLOCKHASH);
    // The stored signature is the transaction's own: the fee payer's.
    assert.equal(artifact.txSignature, bs58.encode(tx.signatures[0]!.signature!));
    assert.equal(artifact.lastValidBlockHeight, 4_321n);
  }
});

test("SOL off a deposit address: the address pays its own fee and is the only signer; one system transfer", () => {
  const lamports = SOL - KEEP - FEE;
  for (const [kind, destination] of [
    ["sweep_to_hot", HOT],
    ["sweep_to_treasury", TREASURY],
  ] as const) {
    const { artifact, tx } = signedAndRead(
      planned({ kind, asset: "SOL", toAddress: destination, amountRaw: lamports, feeLamports: 5_000n, feePayer: A1 }),
    );
    assert.equal(tx.feePayer!.toBase58(), A1);
    assert.deepEqual(signersOf(tx), [A1], "the hot wallet does not sign, and is not needed");
    assert.equal(tx.verifySignatures(), true);
    assertSolInstruction(tx, { source: A1, destination, lamports });
    assert.equal(artifact.txSignature, bs58.encode(tx.signatures[0]!.signature!));
  }
});

test("the hot wallet's excess: the hot wallet pays and is the only signer, to the treasury", () => {
  const usdc = signedAndRead(
    planned({ kind: "hot_to_treasury", fromAddress: HOT, toAddress: TREASURY, orgId: null, amountRaw: 800n * USDC, feeLamports: 5_000n }),
  );
  assert.equal(usdc.tx.feePayer!.toBase58(), HOT);
  assert.deepEqual(signersOf(usdc.tx), [HOT]);
  assert.equal(usdc.tx.verifySignatures(), true);
  assertUsdcInstructions(usdc.tx, { source: HOT, destination: TREASURY, amountRaw: 800n * USDC });

  const sol = signedAndRead(
    planned({ kind: "hot_to_treasury", asset: "SOL", fromAddress: HOT, toAddress: TREASURY, orgId: null, amountRaw: 2n * SOL, feeLamports: 5_000n }),
  );
  assert.equal(sol.tx.feePayer!.toBase58(), HOT);
  assert.deepEqual(signersOf(sol.tx), [HOT]);
  assert.equal(sol.tx.verifySignatures(), true);
  assertSolInstruction(sol.tx, { source: HOT, destination: TREASURY, lamports: 2n * SOL });
});

// ============================================
// No other destination, no other source
// ============================================

test("no transaction is built for a destination other than the hot wallet and the treasury handed in", () => {
  const refused: Array<[string, PlannedTransfer, Partial<BuildSweepTransactionInput>?]> = [
    ["a sweep to the hot wallet that names another address", planned({ toAddress: ELSEWHERE })],
    ["a sweep to the hot wallet that names the treasury", planned({ toAddress: TREASURY })],
    ["a sweep to the treasury that names another address", planned({ kind: "sweep_to_treasury", toAddress: ELSEWHERE })],
    ["a sweep to the treasury that names the hot wallet", planned({ kind: "sweep_to_treasury", toAddress: HOT })],
    ["a sweep to the treasury with no treasury", planned({ kind: "sweep_to_treasury", toAddress: TREASURY }), { treasury: null }],
    ["a sweep to a treasury that is not the one handed in", planned({ kind: "sweep_to_treasury", toAddress: TREASURY }), { treasury: new PublicKey(ELSEWHERE) }],
    ["a treasury that is the hot wallet", planned({ kind: "sweep_to_treasury", toAddress: HOT }), { treasury: HOT_KEYPAIR.publicKey }],
    ["the excess to another address", planned({ kind: "hot_to_treasury", fromAddress: HOT, toAddress: ELSEWHERE, orgId: null })],
    ["the excess with no treasury", planned({ kind: "hot_to_treasury", fromAddress: HOT, toAddress: TREASURY, orgId: null }), { treasury: null }],
    ["the excess from an address that is not the hot wallet", planned({ kind: "hot_to_treasury", toAddress: TREASURY })],
    ["a sweep from the hot wallet", planned({ kind: "sweep_to_treasury", fromAddress: HOT, toAddress: TREASURY })],
    ["a sweep of an address to itself", planned({ fromAddress: HOT, toAddress: HOT })],
    ["a kind nobody knows", planned({ kind: "refund" as PlannedTransfer["kind"], toAddress: ELSEWHERE })],
    ["an asset nobody knows", planned({ asset: "BONK" as PlannedTransfer["asset"] })],
    ["no amount", planned({ amountRaw: 0n })],
    ["a negative amount", planned({ amountRaw: -1n })],
    ["USDC paid for by its sender", planned({ feePayer: A1 })],
    ["USDC paid for by a stranger", planned({ feePayer: ELSEWHERE })],
    ["SOL off an address paid for by the hot wallet", planned({ asset: "SOL", amountRaw: SOL, feePayer: HOT })],
  ];
  for (const [name, transfer, over] of refused) {
    assert.throws(() => buildSweepTransaction(buildInput(transfer, over)), /buildSweepTransaction/, name);
  }
});

test("a transfer is signed only with the keys of the wallets it names", () => {
  const stranger = keypairOf("stranger");
  assert.throws(
    () => signSweepTransaction(buildInput(planned()), { hotWallet: HOT_KEYPAIR, source: stranger }),
    /not the sending address/,
  );
  assert.throws(
    () => signSweepTransaction(buildInput(planned()), { hotWallet: HOT_KEYPAIR, source: null }),
    /not the sending address/,
  );
  assert.throws(
    () => signSweepTransaction(buildInput(planned()), { hotWallet: stranger, source: depositKeypairOf(ORG_1) }),
    /not the hot wallet named/,
  );
  assert.throws(
    () =>
      signSweepTransaction(
        buildInput(planned({ kind: "hot_to_treasury", fromAddress: HOT, toAddress: TREASURY, orgId: null })),
        { hotWallet: HOT_KEYPAIR, source: depositKeypairOf(ORG_1) },
      ),
    /no other signer/,
  );
});

test("prepare refuses what this server may not sign before it asks the node for anything", async () => {
  const w = setupSweep();
  const allowed = { hotWallet: HOT, treasury: TREASURY };
  const refused: Array<[string, PlannedTransfer, { hotWallet: string; treasury: string | null }]> = [
    ["another destination", planned({ toAddress: ELSEWHERE }), allowed],
    ["the treasury with none proven", planned({ kind: "sweep_to_treasury", toAddress: TREASURY }), { hotWallet: HOT, treasury: null }],
    ["an address this server does not derive for the organization", planned({ fromAddress: depositAddressOf(ORG_2) }), allowed],
    ["a sweep with no organization", planned({ orgId: null }), allowed],
    ["a plan made for another hot wallet", planned(), { hotWallet: ELSEWHERE, treasury: TREASURY }],
    ["the excess to another address", planned({ kind: "hot_to_treasury", fromAddress: HOT, toAddress: ELSEWHERE, orgId: null }), allowed],
  ];
  for (const [name, transfer, allow] of refused) {
    await assert.rejects(() => w.deps.prepare(transfer, allow), name);
  }
  assert.equal(w.chain.calls.getLatestBlockhash.length, 0);
  assert.deepEqual(w.order, []);

  // And what it may sign, it signs with a fresh blockhash, sending nothing.
  const artifact = await w.deps.prepare(planned(), allowed);
  assert.deepEqual(w.chain.calls.getLatestBlockhash, ["confirmed"]);
  assert.equal(artifact.lastValidBlockHeight, 5_001n);
  assert.equal(w.chain.calls.sendRawTransaction.length, 0);
  assert.equal(Transaction.from(Buffer.from(artifact.signedTxB64, "base64")).verifySignatures(), true);
});

// ============================================
// The treasury, by rule 4
// ============================================

test("the treasury is proven only when the row of this chain names exactly the setting", async () => {
  const facts = { network: DEVNET, setting: TREASURY as string | null, hotWalletAddress: HOT };
  const ask = (wallets: any[], over: Partial<typeof facts> = {}, addresses: any[] = [], topups: any[] = []) =>
    readProvenTreasury(makeSweepDb({ wallets, addresses, topups }).db, { ...facts, ...over });

  assert.deepEqual(await ask([treasuryRow()]), { proven: true, address: TREASURY });
  assert.deepEqual(await ask([]), { proven: false, reason: "not_proven" });
  assert.deepEqual(await ask([treasuryRow(TREASURY, { network: "solana:mainnet" })]), { proven: false, reason: "not_proven" });
  assert.deepEqual(await ask([treasuryRow(TREASURY, { role: "cold" })]), { proven: false, reason: "not_proven" });
  assert.deepEqual(await ask([treasuryRow(ELSEWHERE)]), { proven: false, reason: "proven_for_another_address" });
  assert.deepEqual(await ask([treasuryRow(NO_TREASURY_ADDRESS)], { setting: NO_TREASURY_ADDRESS }), { proven: false, reason: "not_set" });
  assert.deepEqual(await ask([treasuryRow()], { setting: null }), { proven: false, reason: "not_set" });
  assert.deepEqual(await ask([treasuryRow(HOT)], { setting: HOT }), { proven: false, reason: "is_hot_wallet" });
  assert.deepEqual(
    await ask([treasuryRow(usdcAccountOf(TREASURY))], { setting: usdcAccountOf(TREASURY) }),
    { proven: false, reason: "not_a_wallet" },
  );
  assert.deepEqual(
    await ask([treasuryRow(A1)], { setting: A1 }, [addressRow(ORG_1)]),
    { proven: false, reason: "is_deposit_address" },
  );
  // A deposit address of any chain is a deposit address.
  assert.deepEqual(
    await ask([treasuryRow(A1)], { setting: A1 }, [addressRow(ORG_1, 0n, 0n, { network: "solana:mainnet" })]),
    { proven: false, reason: "is_deposit_address" },
  );
  // So is the address a prepared top-up was sent to, with no deposit row.
  assert.deepEqual(
    await ask([treasuryRow(A1)], { setting: A1 }, [], [{ id: "topup-1", depositAddress: A1 }]),
    { proven: false, reason: "is_deposit_address" },
  );
  assert.deepEqual(
    await ask([treasuryRow()], {}, [], [{ id: "topup-1", depositAddress: A1 }]),
    { proven: true, address: TREASURY },
    "a top-up sent somewhere else changes nothing",
  );
});

test("a setting that could never be sent to costs no query", async () => {
  const data = makeSweepDb({ wallets: [treasuryRow(HOT)] });
  await readProvenTreasury(data.db, { network: DEVNET, setting: HOT, hotWalletAddress: HOT });
  await readProvenTreasury(data.db, { network: DEVNET, setting: NO_TREASURY_ADDRESS, hotWalletAddress: HOT });
  assert.equal(data.calls.length, 0);
});

test("the binding answers the proven treasury's address, or null", async () => {
  const proven = setupSweep({ wallets: [treasuryRow()] });
  assert.equal(await proven.deps.readTreasury(), TREASURY);
  const unproven = setupSweep({ wallets: [] });
  assert.equal(await unproven.deps.readTreasury(), null);
  const moved = setupSweep({ wallets: [treasuryRow()] }, { treasurySetting: ELSEWHERE });
  assert.equal(await moved.deps.readTreasury(), null, "the row proves an address the setting no longer names");
});

// ============================================
// The reads
// ============================================

test("the sent rows are asked for by chain, oldest first", async () => {
  const w = setupSweep({
    transfers: [
      transferRow({ id: "ct-new", txSignature: "sig_new", createdAt: new Date("2026-10-11T08:30:00.000Z"), fromAddress: ELSEWHERE }),
      transferRow({ id: "ct-old", txSignature: "sig_old", createdAt: new Date("2026-10-11T08:00:00.000Z") }),
      transferRow({ id: "ct-done", txSignature: "sig_done", status: "landed", fromAddress: HOT }),
      transferRow({ id: "ct-main", txSignature: "sig_main", network: "solana:mainnet", fromAddress: TREASURY }),
    ],
  });
  const rows = await w.deps.loadSent();
  assert.deepEqual(rows.map((r) => r.id), ["ct-old", "ct-new"]);
  assert.deepEqual(Object.keys(rows[0]!).sort(), [
    "amountRaw",
    "asset",
    "fromAddress",
    "id",
    "kind",
    "lastValidBlockHeight",
    "signedTxB64",
    "toAddress",
    "txSignature",
  ]);
  assert.deepEqual(w.calls[0], {
    op: "chainTransfer.findMany",
    args: { where: { network: DEVNET, status: "sent" }, orderBy: { createdAt: "asc" }, take: SWEEP_SENT_LIMIT },
  });
});

test("only rows the scan has accounted something on are loaded, by chain, the largest of each asset first", async () => {
  const w = setupSweep({
    addresses: [
      addressRow("org-usdc", 70n * USDC),
      addressRow("org-both", 90n * USDC, 3n * SOL),
      addressRow("org-sol", 0n, 2n * SOL),
      addressRow("org-empty"),
      addressRow("org-rent-only", 0n, KEEP + FEE),
      addressRow("org-mainnet", 900n * USDC, 9n * SOL, { network: "solana:mainnet" }),
    ],
  });
  const rows = await w.deps.loadAddresses();
  assert.deepEqual(rows.map((r) => r.orgId), ["org-both", "org-usdc", "org-sol"]);
  assert.deepEqual(
    w.calls.filter((c) => c.op === "depositAddress.findMany").map((c) => c.args),
    [
      { where: { network: DEVNET, lastSeenUsdcRaw: { gt: 0n } }, orderBy: { lastSeenUsdcRaw: "desc" }, take: SWEEP_ADDRESS_LIMIT },
      { where: { network: DEVNET, lastSeenLamports: { gt: KEEP + FEE } }, orderBy: { lastSeenLamports: "desc" }, take: SWEEP_ADDRESS_LIMIT },
    ],
  );
});

test("balances: one call at finalized; an account that is not that owner's USDC account holds nothing", async () => {
  const w = setupSweep();
  const [a, b, c, d, e] = ["a", "b", "c", "d", "e"].map((n) => keypairOf(`holder-${n}`).publicKey.toBase58()) as [string, string, string, string, string];
  w.chain.setBalance(a, 7n * SOL, 55n * USDC);
  w.chain.setBalance(b, 0n, null);
  w.chain.setBalance(c, 1n, null);
  // c's USDC address answers with a token account of another mint.
  w.chain.rawAccounts.set(usdcAccountOf(c), tokenAccountInfo(99n * USDC, c, OTHER_MINT));
  w.chain.setBalance(d, 2n, null);
  // d's answers with a USDC account somebody else owns.
  w.chain.rawAccounts.set(usdcAccountOf(d), tokenAccountInfo(99n * USDC, a));
  w.chain.setBalance(e, 3n, null);
  // e's answers with an account the token program does not own.
  w.chain.rawAccounts.set(usdcAccountOf(e), { ...tokenAccountInfo(99n * USDC, e), owner: SystemProgram.programId });

  const balances = await w.deps.readBalances([a, b, c, d, e]);
  assert.deepEqual(balances, [
    { lamports: 7n * SOL, usdcRaw: 55n * USDC },
    { lamports: 0n, usdcRaw: 0n },
    { lamports: 1n, usdcRaw: 0n },
    { lamports: 2n, usdcRaw: 0n },
    { lamports: 3n, usdcRaw: 0n },
  ]);
  assert.equal(w.chain.calls.getMultipleAccountsInfo.length, 1);
  const call = w.chain.calls.getMultipleAccountsInfo[0]!;
  assert.equal(call.commitment, "finalized");
  assert.deepEqual(call.keys, [a, b, c, d, e, ...[a, b, c, d, e].map((x) => usdcAccountOf(x))]);
});

test("a node that does not answer for every account is a failed read, never an empty address", async () => {
  const w = setupSweep();
  (w.chain.connection as any).getMultipleAccountsInfo = async () => [null];
  await assert.rejects(() => w.deps.readBalances([A1]), /did not answer for every account/);
  await assert.rejects(() => w.deps.readHotWallet(), /did not answer for the hot wallet/);
});

test("the hot wallet: its address, what it can spend (the lower of confirmed and finalized) and what is final", async () => {
  const w = setupSweep({}, { hot: { lamports: 3n * SOL, usdcRaw: 250n * USDC } });
  assert.deepEqual(await w.deps.readHotWallet(), {
    address: HOT,
    lamports: 3n * SOL,
    usdcRaw: 250n * USDC,
    finalized: { lamports: 3n * SOL, usdcRaw: 250n * USDC },
  });
  assert.deepEqual(
    w.chain.calls.getMultipleAccountsInfo.map((c) => [c.commitment, c.keys]).sort(),
    [
      ["confirmed", [HOT, usdcAccountOf(HOT)]],
      ["finalized", [HOT, usdcAccountOf(HOT)]],
    ],
  );

  // A payout has just left: what is confirmed is less than what is final. And a
  // transfer has just arrived in the other asset: what is final is less.
  const moving = setupSweep({}, { hot: { lamports: 3n * SOL, usdcRaw: 900n * USDC } });
  moving.chain.setConfirmedBalance(HOT, 5n * SOL, 300n * USDC);
  assert.deepEqual(await moving.deps.readHotWallet(), {
    address: HOT,
    lamports: 3n * SOL,
    usdcRaw: 300n * USDC,
    finalized: { lamports: 3n * SOL, usdcRaw: 900n * USDC },
  });

  const bare = setupSweep({}, { hot: { lamports: 0n, usdcRaw: null } });
  assert.deepEqual(await bare.deps.readHotWallet(), {
    address: HOT,
    lamports: 0n,
    usdcRaw: 0n,
    finalized: { lamports: 0n, usdcRaw: 0n },
  });
});

test("the derived address is the public key of the derived keypair", () => {
  const w = setupSweep();
  assert.equal(w.deps.deriveAddress(ORG_1), A1);
});

// ============================================
// The writes
// ============================================

test("the claim writes one sent row; a second for the same address and asset, or signature, answers false", async () => {
  const w = setupSweep();
  const artifact = { txSignature: "sig_a", signedTxB64: "Ynl0ZXM=", lastValidBlockHeight: 777n };
  assert.equal(await w.deps.claim(planned(), artifact), true);
  assert.deepEqual(w.calls.at(-1), {
    op: "chainTransfer.create",
    args: {
      data: {
        kind: "sweep_to_hot",
        network: DEVNET,
        asset: "USDC",
        fromAddress: A1,
        toAddress: HOT,
        orgId: ORG_1,
        amountRaw: 60n * USDC,
        feeLamports: 10_000n,
        feePayer: HOT,
        status: "sent",
        txSignature: "sig_a",
        signedTxB64: "Ynl0ZXM=",
        lastValidBlockHeight: 777n,
      },
    },
  });
  // The same address and asset while that one is sent.
  assert.equal(await w.deps.claim(planned(), { ...artifact, txSignature: "sig_b" }), false);
  // The same signature.
  assert.equal(await w.deps.claim(planned({ fromAddress: depositAddressOf(ORG_2), orgId: ORG_2 }), artifact), false);
  // The other asset of the same address is its own money.
  assert.equal(
    await w.deps.claim(planned({ asset: "SOL", amountRaw: SOL, feeLamports: 5_000n, feePayer: A1 }), { ...artifact, txSignature: "sig_c" }),
    true,
  );
  assert.equal(w.state.transfers.length, 2);

  // Any other database error is thrown, not read as "somebody has it".
  w.raw.chainTransfer.create = async () => {
    throw new Error("database is away");
  };
  await assert.rejects(() => w.deps.claim(planned(), { ...artifact, txSignature: "sig_d" }), /database is away/);
});

test("ending a row is a compare-and-set on sent and its signature, and keeps the chain's words to a length", async () => {
  const w = setupSweep({ transfers: [transferRow()] });
  const [row] = await w.deps.loadSent();
  assert.equal(await w.deps.settle(row!, "failed", "x".repeat(5_000)), true);
  assert.deepEqual(w.calls.at(-1)!.args.where, { id: "ct-1", status: "sent", txSignature: "sig_1" });
  const stored = w.state.transfers[0]!;
  assert.equal(stored.status, "failed");
  assert.equal(stored.settledAt, NOW);
  assert.equal(stored.failureReason.length, 1_000);
  // It is no longer sent: a second ending loses.
  assert.equal(await w.deps.settle(row!, "landed", null), false);
  assert.equal(stored.status, "failed");
});

test("the broadcast sends the stored bytes as they are", async () => {
  const w = setupSweep();
  await w.deps.broadcast("c3RvcmVkIGJ5dGVz");
  assert.deepEqual(w.chain.calls.sendRawTransaction, [
    { b64: "c3RvcmVkIGJ5dGVz", options: { skipPreflight: false, maxRetries: 3 } },
  ]);
});

// ============================================
// Production
// ============================================

test("production: every dependency is bound, and no node is asked to build them", () => {
  const deps = buildProductionSweepDeps();
  for (const name of [
    "checkCluster",
    "loadSent",
    "readFate",
    "settle",
    "broadcast",
    "loadAddresses",
    "deriveAddress",
    "readBalances",
    "readHotWallet",
    "readTreasury",
    "getSolQuote",
    "prepare",
    "claim",
    "log",
  ] as const) {
    assert.equal(typeof deps[name], "function", name);
  }
});

test("production: the settings are the six the runbook names, and sweeps are off unless switched on", () => {
  assert.deepEqual(sweepSettingsFromEnv(), {
    minUsd: 25,
    maxPerRun: 20,
    floatUsdc: 200,
    floatSolUsd: 100,
    hotWalletMinLamports: 50_000_000n,
  });
  const input = sweepTickInputFromEnv();
  assert.equal(input.enabled, false);
  assert.equal(input.intervalMs, 300_000);
  assert.equal(input.network, DEVNET);
});

test("the queue exports the two names the wiring uses, and no file here makes a connection", () => {
  const queue = readFileSync(path.join(HERE, "..", "queues", "deposit-sweep.queue.ts"), "utf8");
  assert.match(queue, /export async function startDepositSweepQueue\(\): Promise<void>/);
  assert.match(queue, /export async function stopDepositSweepQueue\(\): Promise<void>/);
  assert.match(queue, /repeat: \{ every: env\.SWEEP_INTERVAL_MS \}/);
  for (const file of ["buildSweepTickDeps.ts", "runSweepTick.ts", "sweepPlan.ts", "treasuryVerify.ts"]) {
    const text = readFileSync(path.join(HERE, "..", "services", file), "utf8");
    assert.ok(!/new\s+Connection\s*\(/.test(text), file);
  }
  // The pure files read no setting.
  for (const file of ["runSweepTick.ts", "sweepPlan.ts", "treasuryVerify.ts"]) {
    const text = readFileSync(path.join(HERE, "..", "services", file), "utf8");
    assert.ok(!/config\/env/.test(text), file);
  }
});

// ============================================
// What open payouts need
// ============================================

const SUMS = [
  { payoutMethod: "crypto_usdc", status: "pending", amountCents: 30_000n },
  { payoutMethod: "crypto_usdc", status: "processing", amountCents: 5_000n },
  { payoutMethod: "crypto_sol", status: "pending", amountCents: 12_000n },
  { payoutMethod: "crypto_sol", status: "processing", amountCents: 8_000n },
  // None of these is owed: a payout taken as credits needs nothing from the
  // wallet, one that is over is not open, and a figure that is no amount counts for nothing.
  { payoutMethod: "credits", status: "pending", amountCents: 99_000n },
  { payoutMethod: "crypto_usdc", status: "completed", amountCents: 70_000n },
  { payoutMethod: "crypto_usdc", status: "failed", amountCents: 70_000n },
  { payoutMethod: "crypto_sol", status: "cancelled", amountCents: 70_000n },
  { payoutMethod: "crypto_sol", status: "pending", amountCents: -1n },
];

test("what payouts need: those waiting, and all that are open, by asset", () => {
  assert.deepEqual(owedForOpenPayouts({ sums: SUMS, capCents: 500_000n, payoutsRunning: true }), {
    waiting: { usdcCents: 30_000n, solCents: 12_000n },
    open: { usdcCents: 35_000n, solCents: 20_000n },
  });
  assert.deepEqual(owedForOpenPayouts({ sums: [], capCents: 500_000n, payoutsRunning: true }), {
    waiting: { usdcCents: 0n, solCents: 0n },
    open: { usdcCents: 0n, solCents: 0n },
  });
});

test("nothing is owed while payouts are not running", () => {
  // A payout that cannot be sent is no reason to hold money in the hot wallet.
  assert.deepEqual(owedForOpenPayouts({ sums: SUMS, capCents: 500_000n, payoutsRunning: false }), {
    waiting: { usdcCents: 0n, solCents: 0n },
    open: { usdcCents: 0n, solCents: 0n },
  });
});

test("USDC and SOL together are never counted above the platform's limit for a day of payouts", () => {
  // The limit is $400.00. USDC is counted first; SOL has what is left of it.
  assert.deepEqual(owedForOpenPayouts({ sums: SUMS, capCents: 40_000n, payoutsRunning: true }), {
    waiting: { usdcCents: 30_000n, solCents: 10_000n },
    open: { usdcCents: 35_000n, solCents: 5_000n },
  });
  // A limit under the USDC alone leaves SOL nothing.
  assert.deepEqual(owedForOpenPayouts({ sums: SUMS, capCents: 20_000n, payoutsRunning: true }), {
    waiting: { usdcCents: 20_000n, solCents: 0n },
    open: { usdcCents: 20_000n, solCents: 0n },
  });
  for (const capCents of [0n, -5n]) {
    const owed = owedForOpenPayouts({ sums: SUMS, capCents, payoutsRunning: true });
    assert.deepEqual(owed.open, { usdcCents: 0n, solCents: 0n });
  }
  // Whatever the limit, the two never pass it together.
  for (const capCents of [1n, 12_345n, 40_000n, 54_999n, 55_000n, 900_000n]) {
    const owed = owedForOpenPayouts({ sums: SUMS, capCents, payoutsRunning: true });
    assert.ok(owed.open.usdcCents + owed.open.solCents <= capCents, String(capCents));
    assert.ok(owed.waiting.usdcCents + owed.waiting.solCents <= capCents, String(capCents));
  }
});

test("the reader sums open payouts to a wallet by method and status, and does not read the table while payouts are off", async () => {
  // A table holding a payout of every method in every status.
  const table = [
    { payoutMethod: "crypto_usdc", status: "pending", amountCents: 10_000n },
    { payoutMethod: "crypto_usdc", status: "pending", amountCents: 20_000n },
    { payoutMethod: "crypto_usdc", status: "processing", amountCents: 5_000n },
    { payoutMethod: "crypto_usdc", status: "completed", amountCents: 70_000n },
    { payoutMethod: "crypto_sol", status: "pending", amountCents: 12_000n },
    { payoutMethod: "crypto_sol", status: "failed", amountCents: 70_000n },
    { payoutMethod: "crypto_sol", status: "cancelled", amountCents: 70_000n },
    { payoutMethod: "credits", status: "pending", amountCents: 99_000n },
    { payoutMethod: "credits", status: "processing", amountCents: 99_000n },
  ];
  const asked: unknown[] = [];
  const db = {
    creatorPayout: {
      // Does what the database does with the arguments it is given: filters, groups, sums.
      groupBy: async (args: { by: string[]; where: { status: { in: string[] }; payoutMethod: { in: string[] } }; _sum: unknown }) => {
        asked.push(args);
        const groups = new Map<string, { payoutMethod: string; status: string; _sum: { amountCents: bigint | null } }>();
        for (const row of table) {
          if (!args.where.status.in.includes(row.status) || !args.where.payoutMethod.in.includes(row.payoutMethod)) continue;
          const key = args.by.map((column) => (row as Record<string, unknown>)[column]).join("|");
          const group = groups.get(key) ?? { payoutMethod: row.payoutMethod, status: row.status, _sum: { amountCents: 0n } };
          group._sum.amountCents = (group._sum.amountCents ?? 0n) + row.amountCents;
          groups.set(key, group);
        }
        return [...groups.values()];
      },
    },
  };
  const owed = await readOpenWalletPayouts(db, { payoutsRunning: true, capCents: 500_000n });
  assert.deepEqual(owed, {
    waiting: { usdcCents: 30_000n, solCents: 12_000n },
    open: { usdcCents: 35_000n, solCents: 12_000n },
  });
  assert.equal(asked.length, 1);
  assert.deepEqual((asked[0] as { by: string[] }).by, ["payoutMethod", "status"]);

  // The limit reaches it.
  assert.deepEqual((await readOpenWalletPayouts(db, { payoutsRunning: true, capCents: 31_000n })).open, { usdcCents: 31_000n, solCents: 0n });

  // Payouts off: nothing owed, and the table is not asked.
  const off = await readOpenWalletPayouts(db, { payoutsRunning: false, capCents: 500_000n });
  assert.deepEqual(off.open, { usdcCents: 0n, solCents: 0n });
  assert.equal(asked.length, 2, "only the two reads above");
});

test("the statuses and methods the reader asks for are the ones the payout code writes", () => {
  const read = (file: string) => readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", file), "utf8");
  // A requested payout is written "pending"; one the executor has claimed is "processing".
  assert.match(read("services/payoutRequests.ts"), /status: "pending"/);
  assert.match(read("services/buildPayoutExecutorTickDeps.ts"), /status: "processing"/);
  // Production wires the reader to the settings that say whether payouts run, and to the day's limit.
  const production = read("services/buildSweepTickDeps.ts");
  assert.match(production, /payoutsRunning: env\.PAYOUTS_ENABLED && env\.PAYOUT_EXECUTOR_INTERVAL_MS > 0/);
  assert.match(production, /capCents: BigInt\(env\.PAYOUT_PLATFORM_MAX_PER_DAY_USD\) \* 100n/);
});
