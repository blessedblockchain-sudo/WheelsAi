/**
 * Drives apps/api/src/services/depositScan.ts: what one finalized
 * transaction did to one deposit address, from its plain facts.
 *
 * Fixtures: a plain SOL transfer, a USDC transfer, a checked USDC
 * transfer, a transfer that also opens the USDC account, one transaction
 * carrying both assets, a version 0 transaction whose address is a loaded
 * one, a failed transaction, and a transfer out.
 */

import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import {
  depositEffect,
  orderedAccountKeys,
  topupIdFromMemos,
  transactionFactsFromRpc,
} from "../services/depositScan.js";
import { topupMemo } from "../services/walletTopup.js";
import {
  OTHER_MINT,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  TOPUP_1,
  USDC_MINT,
  addressOf,
  rpcTx,
  solTransfer,
  usdcAccountOf,
  usdcTransfer,
  type TxShape,
} from "./depositStandIn.js";

const DEPOSIT = addressOf("deposit");
const DEPOSIT_USDC = usdcAccountOf(DEPOSIT);
const SENDER = addressOf("sender");
const TARGET = { address: DEPOSIT, usdcAccount: DEPOSIT_USDC, usdcMint: USDC_MINT.toBase58() };

function effectOf(shape: TxShape, signature = "sig") {
  const facts = transactionFactsFromRpc(signature, rpcTx(shape));
  assert.ok(facts, "the fixture is readable");
  return depositEffect(facts, TARGET);
}

test("a plain SOL transfer: the lamports that arrived, and what the address held after", () => {
  const effect = effectOf(solTransfer(DEPOSIT, 500_000_000n, 1_000n));
  assert.equal(effect.lamportsIn, 500_000_000n);
  assert.equal(effect.usdcIn, 0n);
  assert.equal(effect.lamportsOut, 0n);
  assert.equal(effect.lamportsAfter, 500_001_000n);
  assert.equal(effect.usdcAfter, null, "its USDC account is not in this transaction");
  assert.equal(effect.failed, false);
  assert.deepEqual(effect.signers, [SENDER]);
  assert.equal(effect.slot, 1_000n);
  assert.deepEqual(effect.blockTime, new Date(1_790_000_000 * 1000));
  assert.equal(effect.topupId, null);
});

test("a USDC transfer: base units in at the account the address owns", () => {
  const effect = effectOf(usdcTransfer(DEPOSIT, 50_000_000n, 1_250_000n));
  assert.equal(effect.usdcIn, 50_000_000n);
  assert.equal(effect.lamportsIn, 0n);
  assert.equal(effect.usdcAfter, 51_250_000n);
  assert.equal(effect.lamportsAfter, null, "the address itself is not in this transaction");
});

test("a checked USDC transfer names the mint too, and reads the same", () => {
  const shape = usdcTransfer(DEPOSIT, 12_345_678n);
  // transferChecked carries the mint as an account.
  shape.keys = [...shape.keys.slice(0, 3), USDC_MINT.toBase58(), TOKEN_PROGRAM];
  const effect = effectOf(shape);
  assert.equal(effect.usdcIn, 12_345_678n);
  assert.equal(effect.usdcAfter, 12_345_678n);
});

test("a transfer that also opens the USDC account: no balance before is a balance of nothing", () => {
  const shape = usdcTransfer(DEPOSIT, 50_000_000n, null);
  // The create instruction names the owner, and the sender pays the rent.
  shape.keys = [SENDER, usdcAccountOf(SENDER), DEPOSIT_USDC, DEPOSIT, USDC_MINT.toBase58(), SYSTEM_PROGRAM, TOKEN_PROGRAM];
  shape.lamports = {
    [SENDER]: [1_000_000_000n, 997_955_720n],
    [DEPOSIT_USDC]: [0n, 2_039_280n],
    [DEPOSIT]: [0n, 0n],
  };
  const effect = effectOf(shape);
  assert.equal(effect.usdcIn, 50_000_000n);
  assert.equal(effect.usdcAfter, 50_000_000n);
  assert.equal(effect.lamportsIn, 0n, "the rent went to the token account, not to the address");
  assert.equal(effect.lamportsAfter, 0n);
});

test("one transaction carrying both assets reports both", () => {
  const usdc = usdcTransfer(DEPOSIT, 7_000_000n, 3_000_000n);
  const shape: TxShape = {
    keys: [...usdc.keys, DEPOSIT, SYSTEM_PROGRAM],
    lamports: { ...usdc.lamports, [DEPOSIT]: [100n, 250_000_100n] },
    tokens: usdc.tokens,
    memos: [topupMemo(TOPUP_1)],
  };
  const effect = effectOf(shape);
  assert.equal(effect.usdcIn, 7_000_000n);
  assert.equal(effect.lamportsIn, 250_000_000n);
  assert.equal(effect.usdcAfter, 10_000_000n);
  assert.equal(effect.lamportsAfter, 250_000_100n);
  assert.equal(effect.topupId, TOPUP_1);
});

test("a version 0 transaction: the balances are in the order static, loaded writable, loaded read-only", () => {
  assert.deepEqual(
    orderedAccountKeys({ staticKeys: ["a", "b"], loadedWritable: ["c"], loadedReadonly: ["d", "e"] }),
    ["a", "b", "c", "d", "e"],
  );
  assert.deepEqual(orderedAccountKeys({ staticKeys: ["a"] }), ["a"]);

  // The deposit address and its USDC account come from a lookup table.
  const decoy = addressOf("decoy");
  const shape: TxShape = {
    keys: [SENDER, usdcAccountOf(SENDER)],
    loadedWritable: [decoy, DEPOSIT, DEPOSIT_USDC],
    loadedReadonly: [SYSTEM_PROGRAM, TOKEN_PROGRAM],
    lamports: {
      [SENDER]: [5_000_000_000n, 3_999_995_000n],
      [decoy]: [77n, 99_999n],
      [DEPOSIT]: [0n, 1_000_000_000n],
    },
    tokens: [{ account: DEPOSIT_USDC, owner: DEPOSIT, amounts: [0n, 2_500_000n] }],
  };
  const facts = transactionFactsFromRpc("sig_v0", rpcTx(shape));
  assert.ok(facts);
  assert.deepEqual(facts.accountKeys, [
    SENDER,
    usdcAccountOf(SENDER),
    decoy,
    DEPOSIT,
    DEPOSIT_USDC,
    SYSTEM_PROGRAM,
    TOKEN_PROGRAM,
  ]);
  const effect = depositEffect(facts, TARGET);
  assert.equal(effect.lamportsIn, 1_000_000_000n, "the address's own balance, not its neighbour's");
  assert.equal(effect.lamportsAfter, 1_000_000_000n);
  assert.equal(effect.usdcIn, 2_500_000n);
  assert.deepEqual(effect.signers, [SENDER], "a loaded address never signs");
});

test("a failed transaction moved nothing in; its balances are still what it left", () => {
  // Its balances are told as if the transfer had happened, to prove the
  // failure alone decides.
  const effect = effectOf({ ...solTransfer(DEPOSIT, 500_000_000n, 42n), failed: true });
  assert.equal(effect.failed, true);
  assert.equal(effect.lamportsIn, 0n);
  assert.equal(effect.usdcIn, 0n);

  const real = effectOf({
    keys: [SENDER, DEPOSIT, SYSTEM_PROGRAM],
    lamports: { [SENDER]: [1_000_000n, 995_000n], [DEPOSIT]: [42n, 42n] },
    failed: true,
  });
  assert.equal(real.lamportsIn, 0n);
  assert.equal(real.lamportsAfter, 42n);
});

test("a change below zero is a transfer out, never a transfer in", () => {
  const sol = effectOf({
    keys: [DEPOSIT, SENDER, SYSTEM_PROGRAM],
    lamports: { [DEPOSIT]: [900_000_000n, 399_995_000n], [SENDER]: [0n, 500_000_000n] },
  });
  assert.equal(sol.lamportsIn, 0n);
  assert.equal(sol.lamportsOut, 500_005_000n);
  assert.equal(sol.lamportsAfter, 399_995_000n);

  const usdc = effectOf({
    keys: [DEPOSIT, DEPOSIT_USDC, usdcAccountOf(SENDER), TOKEN_PROGRAM],
    lamports: { [DEPOSIT]: [10_000n, 5_000n] },
    tokens: [
      { account: DEPOSIT_USDC, owner: DEPOSIT, amounts: [40_000_000n, 0n] },
      { account: usdcAccountOf(SENDER), owner: SENDER, amounts: [0n, 40_000_000n] },
    ],
  });
  assert.equal(usdc.usdcIn, 0n);
  assert.equal(usdc.usdcOut, 40_000_000n);
  assert.equal(usdc.usdcAfter, 0n);
});

test("another mint, and another owner's account, are not ours", () => {
  const otherMint = effectOf({
    keys: [SENDER, DEPOSIT_USDC, TOKEN_PROGRAM],
    tokens: [{ account: DEPOSIT_USDC, mint: OTHER_MINT.toBase58(), owner: DEPOSIT, amounts: [0n, 9_000_000n] }],
  });
  assert.equal(otherMint.usdcIn, 0n);

  const stranger = addressOf("stranger");
  const otherOwner = effectOf({
    keys: [SENDER, usdcAccountOf(stranger), TOKEN_PROGRAM],
    tokens: [{ account: usdcAccountOf(stranger), owner: stranger, amounts: [0n, 9_000_000n] }],
  });
  assert.equal(otherOwner.usdcIn, 0n);
  assert.equal(otherOwner.usdcAfter, null);
});

test("USDC at any token account the address owns counts; with no owner told, only its own USDC account", () => {
  const second = addressOf("second token account");
  const owned = effectOf({
    keys: [SENDER, second, TOKEN_PROGRAM],
    tokens: [{ account: second, owner: DEPOSIT, amounts: [0n, 3_000_000n] }],
  });
  assert.equal(owned.usdcIn, 3_000_000n);
  assert.equal(owned.usdcAfter, null, "that is not the account the cursor follows");

  const noOwnerOurs = effectOf({
    keys: [SENDER, DEPOSIT_USDC, TOKEN_PROGRAM],
    tokens: [{ account: DEPOSIT_USDC, owner: null, amounts: [1n, 4_000_001n] }],
  });
  assert.equal(noOwnerOurs.usdcIn, 4_000_000n);

  const noOwnerOther = effectOf({
    keys: [SENDER, second, TOKEN_PROGRAM],
    tokens: [{ account: second, owner: null, amounts: [0n, 4_000_000n] }],
  });
  assert.equal(noOwnerOther.usdcIn, 0n);
});

test("the memo names a top-up only in the exact form a prepared transfer carries", () => {
  assert.equal(topupIdFromMemos([topupMemo(TOPUP_1)]), TOPUP_1);
  assert.equal(topupIdFromMemos(["hello", ` ${topupMemo(TOPUP_1)} `]), TOPUP_1);
  assert.equal(topupIdFromMemos(["wheelsai-topup:not-an-id"]), null);
  assert.equal(topupIdFromMemos(["wheelsai-topup:' OR 1=1 --"]), null);
  assert.equal(topupIdFromMemos([`other:${TOPUP_1}`]), null);
  assert.equal(topupIdFromMemos([]), null);
});

test("an answer without its balances, or none at all, cannot be read", () => {
  assert.equal(transactionFactsFromRpc("sig", null), null);
  assert.equal(transactionFactsFromRpc("sig", undefined), null);
  const noMeta = { ...rpcTx(solTransfer(DEPOSIT, 1n)), meta: null };
  assert.equal(transactionFactsFromRpc("sig", noMeta), null);
  const short = rpcTx(solTransfer(DEPOSIT, 1n));
  short.meta!.postBalances = short.meta!.postBalances.slice(1);
  assert.equal(transactionFactsFromRpc("sig", short), null, "balances that do not line up with the accounts");
});
