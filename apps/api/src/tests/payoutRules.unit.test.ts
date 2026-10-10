// The rules for requesting a payout (services/payoutRules.ts): every limit
// at its edge, the default amount for each method, each address refusal,
// and the limits a screen is shown.
import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import { Keypair, PublicKey } from "@solana/web3.js";
import { MIN_PAYOUT_CENTS, PAYOUT_METHODS, WALLET_PAYOUT_METHODS } from "@wheelsai/shared/payouts";

import {
  isOffCurveAddress,
  largestPayoutNowCents,
  payoutLimits,
  planPayoutRequest,
  readWalletAddress,
  startOfUtcDay,
  usdSettingToCents,
  type AddressOnChain,
  type PayoutRequestFacts,
} from "../services/payoutRules.js";

const WALLET = Keypair.generate().publicKey.toBase58();
const OWN = Keypair.generate().publicKey.toBase58();
const [PDA] = PublicKey.findProgramAddressSync([Buffer.from("x")], new PublicKey(OWN));

function facts(over: Partial<PayoutRequestFacts> = {}): PayoutRequestFacts {
  return {
    method: "credits",
    amountCents: null,
    address: null,
    balanceCents: 4120n,
    perPayoutCents: 50_000n,
    perDayCents: 100_000n,
    usedTodayCents: 0n,
    solOffered: true,
    hasOpenPayout: false,
    platformAddresses: [OWN],
    addressOnChain: null,
    ...over,
  };
}

const walletFacts = (over: Partial<PayoutRequestFacts> = {}) =>
  facts({ method: "crypto_usdc", address: WALLET, addressOnChain: "absent", ...over });

function refusal(plan: ReturnType<typeof planPayoutRequest>) {
  assert.equal(plan.outcome, "refuse");
  return plan.outcome === "refuse" ? plan.refusal : null;
}

function reserved(plan: ReturnType<typeof planPayoutRequest>) {
  assert.equal(plan.outcome, "reserve");
  if (plan.outcome !== "reserve") throw new Error("not reserved");
  return plan;
}

test("the minimum is one number, $5.00, shared with the web", () => {
  assert.equal(MIN_PAYOUT_CENTS, 500);
  assert.deepEqual([...PAYOUT_METHODS], ["credits", "crypto_usdc", "crypto_sol"]);
  assert.deepEqual([...WALLET_PAYOUT_METHODS], ["crypto_usdc", "crypto_sol"]);
});

test("the minimum at its edge, for every method", () => {
  for (const method of PAYOUT_METHODS) {
    const base = { method, address: WALLET, addressOnChain: "absent" as const };
    // The balance: 499 is refused and says what is there; 500 goes through.
    assert.deepEqual(refusal(planPayoutRequest(facts({ ...base, balanceCents: 499n }))), {
      code: "payout_below_minimum",
      balanceCents: 499n,
    });
    assert.equal(reserved(planPayoutRequest(facts({ ...base, balanceCents: 500n }))).amountCents, 500n);
    // The amount asked for, with enough in the balance: no balance in the sentence.
    assert.deepEqual(refusal(planPayoutRequest(facts({ ...base, amountCents: 499n }))), { code: "payout_below_minimum" });
    assert.equal(reserved(planPayoutRequest(facts({ ...base, amountCents: 500n }))).amountCents, 500n);
    // A balance below the minimum is the answer whatever was asked for.
    assert.deepEqual(refusal(planPayoutRequest(facts({ ...base, balanceCents: 310n, amountCents: 5000n }))), {
      code: "payout_below_minimum",
      balanceCents: 310n,
    });
  }
});

test("the balance at its edge, for every method", () => {
  for (const method of PAYOUT_METHODS) {
    const base = { method, address: WALLET, addressOnChain: "absent" as const };
    assert.equal(reserved(planPayoutRequest(facts({ ...base, amountCents: 4120n }))).amountCents, 4120n);
    assert.deepEqual(refusal(planPayoutRequest(facts({ ...base, amountCents: 4121n }))), {
      code: "payout_above_balance",
      balanceCents: 4120n,
    });
  }
});

test("credits: any amount from the minimum to the balance, with no cap and no day limit", () => {
  const rich = facts({ balanceCents: 5_000_000n, usedTodayCents: 100_000n });
  assert.equal(reserved(planPayoutRequest(rich)).amountCents, 5_000_000n, "the default is the whole balance");
  assert.equal(reserved(planPayoutRequest({ ...rich, amountCents: 5_000_000n })).amountCents, 5_000_000n);
  const plan = reserved(planPayoutRequest({ ...rich, amountCents: 700n }));
  assert.deepEqual(plan, { outcome: "reserve", method: "credits", amountCents: 700n, address: null, atCap: false });
  // Credits need no address and never ask for a chain read.
  assert.equal(planPayoutRequest(facts({ address: "garbage" })).outcome, "reserve");
});

test("a wallet: one payout's limit at its edge", () => {
  for (const method of WALLET_PAYOUT_METHODS) {
    const rich = walletFacts({ method, balanceCents: 74_000n });
    const atCap = reserved(planPayoutRequest({ ...rich, amountCents: 50_000n }));
    assert.equal(atCap.amountCents, 50_000n);
    assert.equal(atCap.atCap, true);
    assert.deepEqual(refusal(planPayoutRequest({ ...rich, amountCents: 50_001n })), {
      code: "payout_above_limit",
      perPayoutCents: 50_000n,
    });
    const below = reserved(planPayoutRequest({ ...rich, amountCents: 49_999n }));
    assert.equal(below.atCap, false);
    // No amount: the cap, and the plan says so.
    const defaulted = reserved(planPayoutRequest(rich));
    assert.equal(defaulted.amountCents, 50_000n);
    assert.equal(defaulted.atCap, true);
  }
});

test("a wallet: the day's limit at its edge", () => {
  const rich = walletFacts({ balanceCents: 500_000n });
  // $700 used: $300 is left.
  const used = { ...rich, usedTodayCents: 70_000n };
  assert.equal(reserved(planPayoutRequest({ ...used, amountCents: 30_000n })).amountCents, 30_000n);
  assert.deepEqual(refusal(planPayoutRequest({ ...used, amountCents: 30_001n })), { code: "payout_daily_limit" });
  assert.equal(reserved(planPayoutRequest(used)).amountCents, 30_000n, "the default is what is left today");
  assert.equal(reserved(planPayoutRequest(used)).atCap, false);
  // Exactly the minimum left: it can still be taken. One cent less: nothing can.
  assert.equal(reserved(planPayoutRequest({ ...rich, usedTodayCents: 99_500n })).amountCents, 500n);
  assert.deepEqual(refusal(planPayoutRequest({ ...rich, usedTodayCents: 99_501n })), { code: "payout_daily_limit" });
  assert.deepEqual(refusal(planPayoutRequest({ ...rich, usedTodayCents: 99_501n, amountCents: 500n })), {
    code: "payout_daily_limit",
  });
  // The day used up, or over (the limit was lowered since).
  for (const usedTodayCents of [100_000n, 250_000n]) {
    assert.deepEqual(refusal(planPayoutRequest({ ...rich, usedTodayCents })), { code: "payout_daily_limit" });
  }
  // The same creator can still take credits.
  assert.equal(planPayoutRequest(facts({ balanceCents: 500_000n, usedTodayCents: 100_000n })).outcome, "reserve");
});

test("a wallet: the default amount is the smallest of the balance, the cap and what is left today", () => {
  const cases: Array<[bigint, bigint, bigint]> = [
    // balance, used today, expected
    [4120n, 0n, 4120n],
    [50_000n, 0n, 50_000n],
    [50_001n, 0n, 50_000n],
    [74_000n, 60_000n, 40_000n],
    [20_000n, 60_000n, 20_000n],
  ];
  for (const [balanceCents, usedTodayCents, expected] of cases) {
    for (const method of WALLET_PAYOUT_METHODS) {
      assert.equal(reserved(planPayoutRequest(walletFacts({ method, balanceCents, usedTodayCents }))).amountCents, expected);
    }
  }
});

test("SOL is offered only while it can be priced; USDC and credits do not depend on it", () => {
  assert.deepEqual(refusal(planPayoutRequest(walletFacts({ method: "crypto_sol", solOffered: false }))), {
    code: "payout_method_unavailable",
  });
  assert.equal(planPayoutRequest(walletFacts({ method: "crypto_sol", solOffered: true })).outcome, "reserve");
  assert.equal(planPayoutRequest(walletFacts({ method: "crypto_usdc", solOffered: false })).outcome, "reserve");
  assert.equal(planPayoutRequest(facts({ solOffered: false })).outcome, "reserve");
});

test("one open payout per creator, for every method", () => {
  for (const method of PAYOUT_METHODS) {
    assert.deepEqual(refusal(planPayoutRequest(walletFacts({ method, hasOpenPayout: true }))), {
      code: "payout_in_progress",
    });
  }
});

test("a wallet address must be 32 bytes on the curve", () => {
  assert.equal(readWalletAddress(WALLET), WALLET);
  assert.equal(readWalletAddress(`  ${WALLET} `), WALLET, "pasted with spaces");
  const bad = [
    "",
    "   ",
    "nope",
    "0x52908400098527886E0F7030069857D2E4169EE7",
    WALLET.slice(0, -1) + "0", // not base58
    WALLET + "1", // too long
    WALLET.slice(1, 30),
    PDA.toBase58(), // off the curve: a program's own account
    null,
    undefined,
    42,
    { toString: () => WALLET },
  ];
  for (const value of bad) assert.equal(readWalletAddress(value), null, String(value));

  assert.deepEqual(refusal(planPayoutRequest(walletFacts({ address: null }))), { code: "payout_address_required" });
  assert.deepEqual(refusal(planPayoutRequest(walletFacts({ address: "  " }))), { code: "payout_address_required" });
  for (const address of ["nope", WALLET + "1"]) {
    assert.deepEqual(refusal(planPayoutRequest(walletFacts({ address }))), {
      code: "invalid_payout_address",
      problem: "not_an_address",
    });
  }
});

test("a real address that is off the curve is told it is a token account or a program, with no chain read", () => {
  // Every associated token account is off the curve, and pasting one in
  // place of the wallet that owns it is the usual mistake.
  assert.equal(isOffCurveAddress(PDA.toBase58()), true);
  assert.equal(isOffCurveAddress(WALLET), false);
  for (const junk of ["nope", WALLET + "1", null, 42]) assert.equal(isOffCurveAddress(junk), false);
  for (const addressOnChain of [null, "absent", "wallet", "unavailable"] as Array<AddressOnChain | null>) {
    assert.deepEqual(refusal(planPayoutRequest(walletFacts({ address: PDA.toBase58(), addressOnChain }))), {
      code: "invalid_payout_address",
      problem: "not_a_wallet",
    });
  }
});

test("the platform's own addresses are refused before the chain is asked", () => {
  const plan = planPayoutRequest(walletFacts({ address: OWN, addressOnChain: null }));
  assert.deepEqual(refusal(plan), { code: "invalid_payout_address", problem: "platform" });
  // With nothing of the platform's in the list, the same address is only an address.
  assert.equal(planPayoutRequest(walletFacts({ address: OWN, platformAddresses: [] })).outcome, "reserve");
});

test("the chain is read last, once, and its word decides", () => {
  // Not read yet: every other check passed, so ask for the read.
  assert.deepEqual(planPayoutRequest(walletFacts({ address: ` ${WALLET}`, addressOnChain: null })), {
    outcome: "read_address",
    address: WALLET,
  });
  // No read is asked for while anything else is wrong.
  for (const wrong of [
    { hasOpenPayout: true },
    { balanceCents: 100n },
    { amountCents: 60_000n },
    { usedTodayCents: 100_000n },
    { address: "nope" },
    { address: OWN },
    { method: "crypto_sol", solOffered: false },
  ] as Partial<PayoutRequestFacts>[]) {
    assert.equal(planPayoutRequest(walletFacts({ addressOnChain: null, ...wrong })).outcome, "refuse");
  }
  // An address with nothing at it yet is fine; so is an ordinary account.
  for (const addressOnChain of ["absent", "wallet"] as AddressOnChain[]) {
    const plan = reserved(planPayoutRequest(walletFacts({ addressOnChain })));
    assert.equal(plan.address, WALLET);
  }
  assert.deepEqual(refusal(planPayoutRequest(walletFacts({ addressOnChain: "not_a_wallet" }))), {
    code: "invalid_payout_address",
    problem: "not_a_wallet",
  });
  assert.deepEqual(refusal(planPayoutRequest(walletFacts({ addressOnChain: "unavailable" }))), {
    code: "payout_check_unavailable",
  });
  // An answer this code does not know is no answer.
  assert.deepEqual(refusal(planPayoutRequest(walletFacts({ addressOnChain: "maybe" as AddressOnChain }))), {
    code: "payout_check_unavailable",
  });
});

test("a request that cannot be read is refused as such, and floats decide nothing", () => {
  for (const method of ["paypal", "", null, undefined, 3]) {
    assert.deepEqual(refusal(planPayoutRequest(facts({ method }))), { code: "invalid_payload" });
  }
  for (const amountCents of [0n, -500n, 1000 as unknown as bigint, 10.5 as unknown as bigint]) {
    assert.deepEqual(refusal(planPayoutRequest(facts({ amountCents }))), { code: "invalid_payload" });
  }
  assert.throws(() => planPayoutRequest(facts({ balanceCents: 4120 as unknown as bigint })));
  assert.throws(() => planPayoutRequest(facts({ perDayCents: 1e5 as unknown as bigint })));
});

test("payoutLimits: what a screen is told before anyone asks", () => {
  const base = { balanceCents: 74_000n, perPayoutCents: 50_000n, perDayCents: 100_000n, usedTodayCents: 12_000n, solOffered: true };
  assert.deepEqual(payoutLimits(base), {
    minimumCents: 500,
    perPayoutCents: 50_000,
    perDayCents: 100_000,
    usedTodayCents: 12_000,
    largestNowCents: { credits: 74_000, wallet: 50_000 },
    methods: ["credits", "crypto_usdc", "crypto_sol"],
  });
  assert.deepEqual(payoutLimits({ ...base, solOffered: false }).methods, ["credits", "crypto_usdc"]);
  // What is left today holds the wallet amount; credits are not held.
  assert.deepEqual(payoutLimits({ ...base, usedTodayCents: 70_000n }).largestNowCents, { credits: 74_000, wallet: 30_000 });
  assert.deepEqual(payoutLimits({ ...base, usedTodayCents: 130_000n }).largestNowCents, { credits: 74_000, wallet: 0 });
  // A small balance is the largest for both, even below the minimum.
  assert.deepEqual(payoutLimits({ ...base, balanceCents: 310n }).largestNowCents, { credits: 310, wallet: 310 });
  assert.deepEqual(payoutLimits({ ...base, balanceCents: 0n }).largestNowCents, { credits: 0, wallet: 0 });
  assert.deepEqual(largestPayoutNowCents({ ...base, balanceCents: -5n }), { credits: 0n, wallet: 0n });
});

test("the largest shown is exactly what a request with no amount reserves", () => {
  for (const balanceCents of [500n, 4120n, 50_000n, 74_000n, 900_000n]) {
    for (const usedTodayCents of [0n, 12_000n, 70_000n, 99_500n]) {
      const limitFacts = { balanceCents, perPayoutCents: 50_000n, perDayCents: 100_000n, usedTodayCents, solOffered: true };
      const largest = largestPayoutNowCents(limitFacts);
      assert.equal(reserved(planPayoutRequest(facts(limitFacts))).amountCents, largest.credits);
      assert.equal(reserved(planPayoutRequest(walletFacts(limitFacts))).amountCents, largest.wallet);
    }
  }
});

test("the day starts at midnight UTC, and a limit in dollars becomes cents exactly", () => {
  assert.equal(startOfUtcDay(new Date("2026-10-10T23:59:59.999Z")).toISOString(), "2026-10-10T00:00:00.000Z");
  assert.equal(startOfUtcDay(new Date("2026-10-10T00:00:00.000Z")).toISOString(), "2026-10-10T00:00:00.000Z");
  // 01:30 on the 11th in a zone two hours ahead is still the 10th in UTC.
  assert.equal(startOfUtcDay(new Date("2026-10-11T01:30:00+02:00")).toISOString(), "2026-10-10T00:00:00.000Z");
  assert.equal(usdSettingToCents(500), 50_000n);
  assert.equal(usdSettingToCents(1000), 100_000n);
  for (const bad of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => usdSettingToCents(bad));
});
