/**
 * Drives apps/api/src/services/sweepPlan.ts: what may move off the deposit
 * addresses and out of the hot wallet, and where. Pure: plain facts in, a
 * plan out.
 *
 * Pinning:
 *   - the split at each float level (under, exactly at, over), counting
 *     "sent" rows on their way to the hot wallet and what the plan itself
 *     already gave it;
 *   - no proven treasury moves only toward the hot wallet;
 *   - a balance the scan has not accounted for is never planned, nor an
 *     address with a "sent" row; under the threshold stays;
 *   - SOL keeps 890,880 lamports and its fee, and is not planned with no
 *     price; no USDC while the hot wallet is under HOT_WALLET_MIN_SOL;
 *   - the excess above twice the float goes back, SOL keeping
 *     HOT_WALLET_MIN_SOL after every fee the hot wallet pays in the plan;
 *   - what open payouts need is held back: the hot wallet is filled to
 *     its float plus that, and only what is above both is its excess;
 *   - largest first, at most SWEEP_MAX_PER_RUN;
 *   - the treasury is proven only by rule 4.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { SolQuote } from "../services/solPrice.js";
import {
  NO_TREASURY_ADDRESS,
  SWEEP_FEE_PER_SIGNATURE_LAMPORTS,
  SWEEP_KEEP_LAMPORTS,
  lamportsWorthCents,
  planSweeps,
  readTreasuryAddress,
  treasuryVerdict,
  type SweepAddressFacts,
  type SweepPlanFacts,
  type SweepSettings,
} from "../services/sweepPlan.js";
import { addressOf, depositAddressOf, usdcAccountOf } from "./depositStandIn.js";

const HOT = addressOf("hot-wallet");
const TREASURY = addressOf("treasury");
const SOL = 1_000_000_000n;
const USDC = 1_000_000n;
const KEEP = 890_880n;
const FEE = 5_000n;

/** $200 a SOL, no uncertainty: 1 SOL is 20,000 cents; $25 is 0.125 SOL. */
const QUOTE: SolQuote = {
  source: "static",
  midMicroUsdPerSol: 200_000_000n,
  confMicroUsdPerSol: 0n,
  publishTime: 1_790_000_000,
  ageSeconds: 0,
  account: null,
};

const SETTINGS: SweepSettings = {
  minUsd: 25,
  maxPerRun: 20,
  floatUsdc: 200,
  floatSolUsd: 100,
  hotWalletMinLamports: 50_000_000n,
};

/** A deposit address that holds exactly what the scan last accounted for. */
function held(org: string, usdcRaw: bigint, lamports = 0n, over: Partial<SweepAddressFacts> = {}): SweepAddressFacts {
  return {
    orgId: org,
    address: depositAddressOf(org),
    lamports,
    usdcRaw,
    lastSeenLamports: lamports,
    lastSeenUsdcRaw: usdcRaw,
    ...over,
  };
}

function facts(over: Partial<SweepPlanFacts> = {}): SweepPlanFacts {
  return {
    settings: SETTINGS,
    addresses: [],
    sent: [],
    hotWallet: { address: HOT, lamports: SOL, usdcRaw: 0n },
    treasury: TREASURY,
    quote: QUOTE,
    ...over,
  };
}

/** What payouts need: `waiting` to be sent, and `open` in all (waiting or being sent; the same unless said). */
function owes(
  waiting: { usdcRaw?: bigint; solCents?: bigint },
  open: { usdcRaw?: bigint; solCents?: bigint } = waiting,
): NonNullable<SweepPlanFacts["openPayouts"]> {
  const whole = (x: { usdcRaw?: bigint; solCents?: bigint }) => ({ usdcRaw: x.usdcRaw ?? 0n, solCents: x.solCents ?? 0n });
  return { waiting: whole(waiting), open: whole(open) };
}

const where = (plan: ReturnType<typeof planSweeps>) =>
  plan.transfers.map((t) => [t.kind, t.asset, t.orgId, t.amountRaw] as const);

// ============================================
// The constants the contract names
// ============================================

test("the keep is 890,880 lamports and a signature costs 5,000", () => {
  assert.equal(SWEEP_KEEP_LAMPORTS, 890_880n);
  assert.equal(SWEEP_FEE_PER_SIGNATURE_LAMPORTS, 5_000n);
  assert.equal(NO_TREASURY_ADDRESS, "11111111111111111111111111111111");
  assert.equal(lamportsWorthCents(QUOTE, SOL), 20_000n);
  assert.equal(lamportsWorthCents(QUOTE, 0n), 0n);
});

// ============================================
// USDC: the split at each float level
// ============================================

test("USDC under the float goes whole to the hot wallet, paid for by the hot wallet", () => {
  const plan = planSweeps(
    facts({
      addresses: [held("org-a", 500n * USDC)],
      hotWallet: { address: HOT, lamports: SOL, usdcRaw: 199n * USDC + 999_999n },
    }),
  );
  assert.deepEqual(plan.transfers, [
    {
      kind: "sweep_to_hot",
      asset: "USDC",
      fromAddress: depositAddressOf("org-a"),
      toAddress: HOT,
      orgId: "org-a",
      amountRaw: 500n * USDC,
      feeLamports: 10_000n,
      feePayer: HOT,
      valueCents: 50_000n,
    },
  ]);
  assert.deepEqual(plan.held, []);
});

test("USDC exactly at the float, and over it, goes to the treasury", () => {
  for (const hotUsdc of [200n * USDC, 201n * USDC]) {
    const plan = planSweeps(
      facts({
        addresses: [held("org-a", 30n * USDC)],
        hotWallet: { address: HOT, lamports: SOL, usdcRaw: hotUsdc },
      }),
    );
    assert.deepEqual(where(plan), [["sweep_to_treasury", "USDC", "org-a", 30n * USDC]]);
    assert.equal(plan.transfers[0]!.toAddress, TREASURY);
    assert.equal(plan.transfers[0]!.feePayer, HOT);
  }
});

test("what is already on its way to the hot wallet in sent rows counts toward its float", () => {
  const onItsWay = [
    { fromAddress: depositAddressOf("org-x"), toAddress: HOT, asset: "USDC", amountRaw: 150n * USDC },
  ];
  // 60 held + 150 on its way = 210: at its float.
  const over = planSweeps(
    facts({
      addresses: [held("org-a", 30n * USDC)],
      sent: onItsWay,
      hotWallet: { address: HOT, lamports: SOL, usdcRaw: 60n * USDC },
    }),
  );
  assert.deepEqual(where(over), [["sweep_to_treasury", "USDC", "org-a", 30n * USDC]]);

  // 40 held + 150 on its way = 190: still under.
  const under = planSweeps(
    facts({
      addresses: [held("org-a", 30n * USDC)],
      sent: onItsWay,
      hotWallet: { address: HOT, lamports: SOL, usdcRaw: 40n * USDC },
    }),
  );
  assert.deepEqual(where(under), [["sweep_to_hot", "USDC", "org-a", 30n * USDC]]);

  // A sent row to the treasury, or of the other asset, does not count.
  const elsewhere = planSweeps(
    facts({
      addresses: [held("org-a", 30n * USDC)],
      sent: [
        { fromAddress: depositAddressOf("org-x"), toAddress: TREASURY, asset: "USDC", amountRaw: 900n * USDC },
        { fromAddress: depositAddressOf("org-y"), toAddress: HOT, asset: "SOL", amountRaw: 900n * SOL },
      ],
      hotWallet: { address: HOT, lamports: SOL, usdcRaw: 40n * USDC },
    }),
  );
  assert.deepEqual(where(elsewhere), [["sweep_to_hot", "USDC", "org-a", 30n * USDC]]);
});

test("what is on its way out of the hot wallet does not count as held by it", () => {
  const plan = planSweeps(
    facts({
      addresses: [held("org-a", 30n * USDC)],
      sent: [{ fromAddress: HOT, toAddress: TREASURY, asset: "USDC", amountRaw: 300n * USDC }],
      hotWallet: { address: HOT, lamports: SOL, usdcRaw: 450n * USDC },
    }),
  );
  // 450 less 300 leaving = 150, under the float; and no second transfer
  // from the hot wallet while one is out.
  assert.deepEqual(where(plan), [["sweep_to_hot", "USDC", "org-a", 30n * USDC]]);
});

test("what the plan already gave the hot wallet counts: the transfer that crosses the float is the last one to it", () => {
  const plan = planSweeps(
    facts({
      addresses: [
        held("org-a", 120n * USDC),
        held("org-b", 100n * USDC),
        held("org-c", 90n * USDC),
        held("org-d", 80n * USDC),
      ],
    }),
  );
  // 0 -> 120 (under) -> 220 (the whole 100 goes, crossing) -> treasury.
  assert.deepEqual(where(plan), [
    ["sweep_to_hot", "USDC", "org-a", 120n * USDC],
    ["sweep_to_hot", "USDC", "org-b", 100n * USDC],
    ["sweep_to_treasury", "USDC", "org-c", 90n * USDC],
    ["sweep_to_treasury", "USDC", "org-d", 80n * USDC],
  ]);
});

test("a float of 0 sends everything to the treasury", () => {
  const plan = planSweeps(
    facts({
      settings: { ...SETTINGS, floatUsdc: 0, floatSolUsd: 0 },
      addresses: [held("org-a", 30n * USDC, SOL)],
      hotWallet: { address: HOT, lamports: 60_000_000n, usdcRaw: 0n },
    }),
  );
  assert.deepEqual(
    plan.transfers.map((t) => [t.kind, t.asset]),
    [
      ["sweep_to_treasury", "SOL"],
      ["sweep_to_treasury", "USDC"],
    ],
  );
});

// ============================================
// SOL
// ============================================

test("SOL keeps 890,880 lamports and its fee, pays its own fee, and splits at the float by the quote", () => {
  // Hot wallet: 0.4 SOL = $80, under its $100 float.
  const under = planSweeps(
    facts({
      addresses: [held("org-a", 0n, SOL)],
      hotWallet: { address: HOT, lamports: 400_000_000n, usdcRaw: 0n },
    }),
  );
  assert.deepEqual(under.transfers, [
    {
      kind: "sweep_to_hot",
      asset: "SOL",
      fromAddress: depositAddressOf("org-a"),
      toAddress: HOT,
      orgId: "org-a",
      amountRaw: SOL - KEEP - FEE,
      feeLamports: 5_000n,
      feePayer: depositAddressOf("org-a"),
      valueCents: lamportsWorthCents(QUOTE, SOL - KEEP - FEE),
    },
  ]);

  // Exactly at the float (0.5 SOL = $100) and over it: the treasury.
  for (const hotLamports of [500_000_000n, 600_000_000n]) {
    const plan = planSweeps(
      facts({
        addresses: [held("org-a", 0n, SOL)],
        hotWallet: { address: HOT, lamports: hotLamports, usdcRaw: 0n },
      }),
    );
    assert.deepEqual(where(plan), [["sweep_to_treasury", "SOL", "org-a", SOL - KEEP - FEE]]);
    assert.equal(plan.transfers[0]!.feePayer, depositAddressOf("org-a"));
  }

  // One lamport under the float is under.
  const justUnder = planSweeps(
    facts({
      addresses: [held("org-a", 0n, SOL)],
      hotWallet: { address: HOT, lamports: 499_999_999n, usdcRaw: 0n },
    }),
  );
  assert.deepEqual(where(justUnder), [["sweep_to_hot", "SOL", "org-a", SOL - KEEP - FEE]]);
});

test("SOL on its way to the hot wallet, and SOL this plan gave it, count toward its float", () => {
  const plan = planSweeps(
    facts({
      addresses: [held("org-a", 0n, SOL), held("org-b", 0n, 2n * SOL)],
      sent: [{ fromAddress: depositAddressOf("org-x"), toAddress: HOT, asset: "SOL", amountRaw: 300_000_000n }],
      hotWallet: { address: HOT, lamports: 100_000_000n, usdcRaw: 0n },
    }),
  );
  // 0.1 + 0.3 on its way = 0.4 (under): the larger goes to the hot
  // wallet; then it is over, and the next goes to the treasury.
  assert.deepEqual(where(plan), [
    ["sweep_to_hot", "SOL", "org-b", 2n * SOL - KEEP - FEE],
    ["sweep_to_treasury", "SOL", "org-a", SOL - KEEP - FEE],
  ]);

  // 0.3 held + 0.3 on its way = 0.6, over the float: nothing more goes to
  // the hot wallet. Without the 0.3 on its way it would look under.
  const full = planSweeps(
    facts({
      addresses: [held("org-a", 0n, SOL)],
      sent: [{ fromAddress: depositAddressOf("org-x"), toAddress: HOT, asset: "SOL", amountRaw: 300_000_000n }],
      hotWallet: { address: HOT, lamports: 300_000_000n, usdcRaw: 0n },
    }),
  );
  assert.deepEqual(where(full), [["sweep_to_treasury", "SOL", "org-a", SOL - KEEP - FEE]]);
});

test("SOL under the threshold by the quote stays; exactly at it moves", () => {
  // $25 is 125,000,000 lamports at $200.
  const atThreshold = 125_000_000n + KEEP + FEE;
  const stays = planSweeps(facts({ addresses: [held("org-a", 0n, atThreshold - 1n)] }));
  assert.deepEqual(stays.transfers, []);
  assert.deepEqual(stays.held, []);
  const moves = planSweeps(facts({ addresses: [held("org-a", 0n, atThreshold)] }));
  assert.deepEqual(where(moves), [["sweep_to_treasury", "SOL", "org-a", 125_000_000n]]);
});

test("with no price no SOL is planned, off an address or out of the hot wallet; USDC still moves", () => {
  const plan = planSweeps(
    facts({
      quote: null,
      addresses: [held("org-a", 30n * USDC, 50n * SOL)],
      hotWallet: { address: HOT, lamports: 900n * SOL, usdcRaw: 0n },
    }),
  );
  assert.deepEqual(where(plan), [["sweep_to_hot", "USDC", "org-a", 30n * USDC]]);
  assert.deepEqual(plan.held, [{ reason: "no_price", asset: "SOL" }]);
});

test("a quote that values SOL at nothing plans no SOL", () => {
  const plan = planSweeps(
    facts({
      quote: { ...QUOTE, confMicroUsdPerSol: 200_000_000n },
      addresses: [held("org-a", 0n, 50n * SOL)],
    }),
  );
  assert.deepEqual(plan.transfers, []);
});

// ============================================
// Only what has been read; nothing twice
// ============================================

test("a balance the scan has not accounted for is never planned", () => {
  const plan = planSweeps(
    facts({
      addresses: [
        // More arrived than the scan has seen.
        held("org-a", 80n * USDC, 2n * SOL, { lastSeenUsdcRaw: 50n * USDC, lastSeenLamports: SOL }),
        // Less is there than the scan last saw.
        held("org-b", 40n * USDC, SOL, { lastSeenUsdcRaw: 90n * USDC, lastSeenLamports: 3n * SOL }),
        // One asset accounted for, the other not: only the first moves.
        held("org-c", 60n * USDC, SOL, { lastSeenLamports: SOL - 1n }),
      ],
    }),
  );
  assert.deepEqual(where(plan), [["sweep_to_hot", "USDC", "org-c", 60n * USDC]]);
  assert.deepEqual(
    plan.held.map((h) => [h.reason, h.orgId, h.asset]),
    [
      ["unaccounted", "org-a", "USDC"],
      ["unaccounted", "org-a", "SOL"],
      ["unaccounted", "org-b", "USDC"],
      ["unaccounted", "org-b", "SOL"],
      ["unaccounted", "org-c", "SOL"],
    ],
  );
});

test("an address with a sent row for an asset is not planned again for it; its other asset still is", () => {
  const plan = planSweeps(
    facts({
      addresses: [held("org-a", 60n * USDC, SOL)],
      sent: [
        { fromAddress: depositAddressOf("org-a"), toAddress: TREASURY, asset: "USDC", amountRaw: 60n * USDC },
      ],
      hotWallet: { address: HOT, lamports: 600_000_000n, usdcRaw: 300n * USDC },
    }),
  );
  assert.deepEqual(where(plan), [["sweep_to_treasury", "SOL", "org-a", SOL - KEEP - FEE]]);
  assert.deepEqual(plan.held, [
    { reason: "in_flight", address: depositAddressOf("org-a"), orgId: "org-a", asset: "USDC" },
  ]);
});

test("a pair whose transfer ended a moment ago is not planned in the same run", () => {
  const plan = planSweeps(
    facts({
      addresses: [held("org-a", 60n * USDC)],
      alsoBusy: [{ fromAddress: depositAddressOf("org-a"), asset: "USDC" }],
    }),
  );
  assert.deepEqual(plan.transfers, []);
  // And with nothing in the way, a later run plans it.
  assert.equal(planSweeps(facts({ addresses: [held("org-a", 60n * USDC)] })).transfers.length, 1);
});

test("USDC under the threshold stays; exactly at it moves whole", () => {
  const stays = planSweeps(facts({ addresses: [held("org-a", 25n * USDC - 1n)] }));
  assert.deepEqual(stays.transfers, []);
  assert.deepEqual(stays.held, []);
  const moves = planSweeps(facts({ addresses: [held("org-a", 25n * USDC)] }));
  assert.deepEqual(where(moves), [["sweep_to_hot", "USDC", "org-a", 25n * USDC]]);
});

test("no USDC is planned while the hot wallet is under HOT_WALLET_MIN_SOL; SOL still is, and is how it gets its SOL", () => {
  const plan = planSweeps(
    facts({
      addresses: [held("org-a", 500n * USDC, SOL)],
      hotWallet: { address: HOT, lamports: 49_999_999n, usdcRaw: 0n },
    }),
  );
  assert.deepEqual(where(plan), [["sweep_to_hot", "SOL", "org-a", SOL - KEEP - FEE]]);
  assert.deepEqual(plan.held, [
    { reason: "hot_wallet_low_sol", address: depositAddressOf("org-a"), orgId: "org-a", asset: "USDC" },
  ]);

  // Exactly at the minimum it can pay.
  const atMinimum = planSweeps(
    facts({
      addresses: [held("org-a", 500n * USDC)],
      hotWallet: { address: HOT, lamports: 50_000_000n, usdcRaw: 0n },
    }),
  );
  assert.deepEqual(where(atMinimum), [["sweep_to_hot", "USDC", "org-a", 500n * USDC]]);
});

// ============================================
// No proven treasury
// ============================================

test("with no proven treasury only sweeps to the hot wallet happen: the rest stays where it is", () => {
  const plan = planSweeps(
    facts({
      treasury: null,
      addresses: [
        held("org-a", 150n * USDC, 2n * SOL),
        held("org-b", 100n * USDC, SOL),
        held("org-c", 90n * USDC),
      ],
      // Far over twice both floats: with a treasury the excess would go back.
      hotWallet: { address: HOT, lamports: 400_000_000n, usdcRaw: 0n },
    }),
  );
  assert.deepEqual(where(plan), [
    ["sweep_to_hot", "SOL", "org-a", 2n * SOL - KEEP - FEE],
    ["sweep_to_hot", "USDC", "org-a", 150n * USDC],
    ["sweep_to_hot", "USDC", "org-b", 100n * USDC],
  ]);
  assert.ok(plan.transfers.every((t) => t.toAddress === HOT));
  assert.deepEqual(
    plan.held.map((h) => [h.reason, h.orgId, h.asset]),
    [
      ["no_treasury", "org-b", "SOL"],
      ["no_treasury", "org-c", "USDC"],
    ],
  );

  const rich = planSweeps(
    facts({
      treasury: null,
      addresses: [held("org-a", 150n * USDC, 2n * SOL)],
      hotWallet: { address: HOT, lamports: 900n * SOL, usdcRaw: 90_000n * USDC },
    }),
  );
  assert.deepEqual(rich.transfers, [], "nothing leaves the hot wallet, and nothing more enters it");
});

// ============================================
// Largest first, and the limit
// ============================================

test("largest first across both assets, at most SWEEP_MAX_PER_RUN off deposit addresses", () => {
  const plan = planSweeps(
    facts({
      settings: { ...SETTINGS, maxPerRun: 3 },
      addresses: [
        held("org-a", 30n * USDC), //  $30
        held("org-b", 0n, SOL), //    ~$199.8
        held("org-c", 400n * USDC), // $400
        held("org-d", 60n * USDC), //  $60
        held("org-e", 0n, 3n * SOL), // ~$599.8
      ],
      hotWallet: { address: HOT, lamports: 600_000_000n, usdcRaw: 300n * USDC },
    }),
  );
  assert.deepEqual(
    plan.transfers.map((t) => t.orgId),
    ["org-e", "org-c", "org-b"],
  );
  assert.deepEqual(
    plan.held.map((h) => [h.reason, h.orgId]),
    [
      ["over_run_limit", "org-d"],
      ["over_run_limit", "org-a"],
    ],
  );
});

// ============================================
// The hot wallet's excess
// ============================================

test("USDC above twice the float goes back to the treasury, down to the float; exactly twice stays", () => {
  const twice = planSweeps(facts({ hotWallet: { address: HOT, lamports: SOL / 10n, usdcRaw: 400n * USDC } }));
  assert.deepEqual(twice.transfers, []);

  const over = planSweeps(facts({ hotWallet: { address: HOT, lamports: SOL / 10n, usdcRaw: 400n * USDC + 1n } }));
  assert.deepEqual(over.transfers, [
    {
      kind: "hot_to_treasury",
      asset: "USDC",
      fromAddress: HOT,
      toAddress: TREASURY,
      orgId: null,
      amountRaw: 200n * USDC + 1n,
      feeLamports: 5_000n,
      feePayer: HOT,
      valueCents: 20_000n,
    },
  ]);
});

test("SOL above twice the float goes back, down to the float", () => {
  // Float $100 = 0.5 SOL. Twice is 1 SOL.
  const twice = planSweeps(facts({ hotWallet: { address: HOT, lamports: SOL, usdcRaw: 0n } }));
  assert.deepEqual(twice.transfers, []);

  const over = planSweeps(facts({ hotWallet: { address: HOT, lamports: 3n * SOL, usdcRaw: 0n } }));
  assert.deepEqual(where(over), [["hot_to_treasury", "SOL", null, 3n * SOL - 500_000_000n]]);
  assert.equal(over.transfers[0]!.feePayer, HOT);
  assert.equal(over.transfers[0]!.toAddress, TREASURY);
});

test("the SOL excess keeps at least HOT_WALLET_MIN_SOL after its fee", () => {
  // A float of $5 is 0.025 SOL, under the 0.05 SOL the wallet must keep.
  const plan = planSweeps(
    facts({
      settings: { ...SETTINGS, floatSolUsd: 5 },
      hotWallet: { address: HOT, lamports: SOL, usdcRaw: 0n },
    }),
  );
  assert.equal(plan.transfers.length, 1);
  const sent = plan.transfers[0]!;
  assert.equal(sent.amountRaw, SOL - 50_000_000n - FEE);
  assert.equal(SOL - sent.amountRaw - sent.feeLamports, 50_000_000n, "what is left is exactly the minimum");
});

test("the SOL excess leaves the minimum after EVERY fee the hot wallet pays in the same plan", () => {
  // Floats of 0: the hot wallet hands back what it holds. It pays three
  // fees in this plan: a USDC sweep off an address (two signatures), its own
  // USDC excess, and the SOL transfer itself.
  const plan = planSweeps(
    facts({
      settings: { ...SETTINGS, minUsd: 1, floatUsdc: 0, floatSolUsd: 0 },
      addresses: [held("a", 30n * USDC)],
      hotWallet: { address: HOT, lamports: SOL, usdcRaw: 40n * USDC },
    }),
  );
  assert.deepEqual(
    plan.transfers.map((t) => [t.kind, t.asset]),
    [
      ["sweep_to_treasury", "USDC"],
      ["hot_to_treasury", "USDC"],
      ["hot_to_treasury", "SOL"],
    ],
  );
  const paidByHot = plan.transfers.filter((t) => t.feePayer === HOT).reduce((sum, t) => sum + t.feeLamports, 0n);
  assert.equal(paidByHot, 10_000n + 5_000n + 5_000n);
  const sol = plan.transfers[2]!;
  assert.equal(sol.amountRaw, SOL - 50_000_000n - paidByHot);
  assert.equal(SOL - sol.amountRaw - paidByHot, 50_000_000n, "after all three fees it holds exactly the minimum, not a fee or two under it");
});

// ============================================
// What open payouts need
// ============================================

test("USDC goes to the hot wallet until it holds its float AND what open payouts need", () => {
  // Float $200. A $300 payout is open. The hot wallet holds $350: over its float, under float plus the payout.
  const owed = owes({ usdcRaw: 300n * USDC });
  const filling = planSweeps(
    facts({
      addresses: [held("a", 100n * USDC)],
      hotWallet: { address: HOT, lamports: SOL / 10n, usdcRaw: 350n * USDC },
      openPayouts: owed,
    }),
  );
  assert.deepEqual(where(filling), [["sweep_to_hot", "USDC", "a", 100n * USDC]]);

  // With nothing open the same money goes to the treasury, as it always did.
  const asBefore = planSweeps(
    facts({
      addresses: [held("a", 100n * USDC)],
      hotWallet: { address: HOT, lamports: SOL / 10n, usdcRaw: 350n * USDC },
    }),
  );
  assert.deepEqual(where(asBefore), [["sweep_to_treasury", "USDC", "a", 100n * USDC]]);

  // At float plus the payout exactly, it is full.
  const full = planSweeps(
    facts({
      addresses: [held("a", 100n * USDC)],
      hotWallet: { address: HOT, lamports: SOL / 10n, usdcRaw: 500n * USDC },
      openPayouts: owed,
    }),
  );
  assert.deepEqual(where(full), [["sweep_to_treasury", "USDC", "a", 100n * USDC]]);
});

test("the USDC excess is what the hot wallet holds above its float and what open payouts need", () => {
  // Float $200, a $300 payout open. Without the payout, $650 would send $450 away and starve it.
  const owed = owes({ usdcRaw: 300n * USDC });
  const held650 = planSweeps(facts({ hotWallet: { address: HOT, lamports: SOL / 10n, usdcRaw: 650n * USDC }, openPayouts: owed }));
  assert.deepEqual(held650.transfers, [], "650 is not more than twice the float on top of the 300 owed");

  const held701 = planSweeps(facts({ hotWallet: { address: HOT, lamports: SOL / 10n, usdcRaw: 701n * USDC }, openPayouts: owed }));
  assert.deepEqual(where(held701), [["hot_to_treasury", "USDC", null, 201n * USDC]]);
  assert.equal(701n * USDC - held701.transfers[0]!.amountRaw, 500n * USDC, "it keeps its float and the payout");
});

test("SOL the same, by the quote: filled to the float plus what is owed, and the excess measured above both", () => {
  // $200 a SOL. Float $100 = 0.5 SOL. A $300 SOL payout is open = 1.5 SOL.
  const owed = owes({ solCents: 30_000n });
  const sweepable = SOL + KEEP + FEE; // an address that can give 1 SOL
  const filling = planSweeps(
    facts({
      addresses: [held("a", 0n, sweepable)],
      hotWallet: { address: HOT, lamports: SOL, usdcRaw: 0n }, // $200: over its float, under float plus the payout
      openPayouts: owed,
    }),
  );
  assert.deepEqual(where(filling), [["sweep_to_hot", "SOL", "a", SOL]]);

  // 2.5 SOL is $500: more than twice the float ($200), not more than that on top of the $300 owed.
  const kept = planSweeps(facts({ hotWallet: { address: HOT, lamports: (5n * SOL) / 2n, usdcRaw: 0n }, openPayouts: owed }));
  assert.deepEqual(kept.transfers, []);
  // With nothing owed the same 2.5 SOL sends 2 away and keeps the float.
  const plain = planSweeps(facts({ hotWallet: { address: HOT, lamports: (5n * SOL) / 2n, usdcRaw: 0n } }));
  assert.deepEqual(where(plain), [["hot_to_treasury", "SOL", null, 2n * SOL]]);

  // 4 SOL is $800: above $500. It keeps the float and the payout, 2 SOL, and sends the rest.
  const over = planSweeps(facts({ hotWallet: { address: HOT, lamports: 4n * SOL, usdcRaw: 0n }, openPayouts: owed }));
  assert.deepEqual(where(over), [["hot_to_treasury", "SOL", null, 2n * SOL]]);
});

test("nothing owed, an absent figure and a negative one all plan as before", () => {
  const base = { addresses: [held("a", 100n * USDC)], hotWallet: { address: HOT, lamports: SOL / 10n, usdcRaw: 250n * USDC } };
  const plain = planSweeps(facts(base));
  for (const openPayouts of [undefined, owes({}), owes({ usdcRaw: -5n * USDC, solCents: -1n })]) {
    assert.deepEqual(planSweeps(facts({ ...base, ...(openPayouts ? { openPayouts } : {}) })), plain);
  }
});

test("a payout being sent is kept for, and not filled for", () => {
  // Float $200. Nothing waits; a $300 payout is being sent. Its money is in the
  // wallet or has left it: either way no deposit is to be added for it.
  const beingSent = owes({}, { usdcRaw: 300n * USDC });
  const notFilled = planSweeps(
    facts({
      addresses: [held("a", 100n * USDC)],
      hotWallet: { address: HOT, lamports: SOL / 10n, usdcRaw: 250n * USDC },
      openPayouts: beingSent,
    }),
  );
  assert.deepEqual(where(notFilled), [["sweep_to_treasury", "USDC", "a", 100n * USDC]]);

  // But the excess leaves it: 650 is not more than twice the float on top of the 300.
  const kept = planSweeps(facts({ hotWallet: { address: HOT, lamports: SOL / 10n, usdcRaw: 650n * USDC }, openPayouts: beingSent }));
  assert.deepEqual(kept.transfers, []);
  const over = planSweeps(facts({ hotWallet: { address: HOT, lamports: SOL / 10n, usdcRaw: 701n * USDC }, openPayouts: beingSent }));
  assert.deepEqual(where(over), [["hot_to_treasury", "USDC", null, 201n * USDC]]);
});

test("what is on its way in or out is counted from what is final, once", () => {
  // A transfer OUT of the hot wallet, 800, has landed and is not final: 1,000 is
  // final, 200 is confirmed (the lower), and its row is still "sent". Counted
  // from what is final, the wallet holds 200: its float, so a deposit goes to
  // the treasury. Counted from the lower, it would hold 200 - 800 and be filled.
  const out = planSweeps(
    facts({
      addresses: [held("a", 100n * USDC)],
      sent: [{ fromAddress: HOT, toAddress: TREASURY, asset: "USDC", amountRaw: 800n * USDC }],
      hotWallet: { address: HOT, lamports: SOL / 10n, usdcRaw: 200n * USDC, finalized: { lamports: SOL / 10n, usdcRaw: 1_000n * USDC } },
    }),
  );
  assert.deepEqual(where(out), [["sweep_to_treasury", "USDC", "a", 100n * USDC]]);

  // A transfer IN, 400, has landed and is not final: 100 is final (the lower),
  // 500 is confirmed. From what is final: 100 + 400, over its float.
  const into = planSweeps(
    facts({
      addresses: [held("a", 100n * USDC)],
      sent: [{ fromAddress: depositAddressOf("b"), toAddress: HOT, asset: "USDC", amountRaw: 400n * USDC }],
      hotWallet: { address: HOT, lamports: SOL / 10n, usdcRaw: 100n * USDC, finalized: { lamports: SOL / 10n, usdcRaw: 100n * USDC } },
    }),
  );
  assert.deepEqual(where(into), [["sweep_to_treasury", "USDC", "a", 100n * USDC]]);

  // The excess is from the lower of the two, whatever is final: 900 final, 500 to spend.
  const excess = planSweeps(
    facts({ hotWallet: { address: HOT, lamports: SOL / 10n, usdcRaw: 500n * USDC, finalized: { lamports: SOL / 10n, usdcRaw: 900n * USDC } } }),
  );
  assert.deepEqual(where(excess), [["hot_to_treasury", "USDC", null, 300n * USDC]]);

  // SOL the same: 3 SOL final, 1 SOL confirmed, 2 SOL on its way out. It holds 1 SOL ($200): over its $100 float.
  const sweepable = SOL + KEEP + FEE;
  const sol = planSweeps(
    facts({
      addresses: [held("a", 0n, sweepable)],
      sent: [{ fromAddress: HOT, toAddress: TREASURY, asset: "SOL", amountRaw: 2n * SOL }],
      hotWallet: { address: HOT, lamports: SOL, usdcRaw: 0n, finalized: { lamports: 3n * SOL, usdcRaw: 0n } },
    }),
  );
  assert.deepEqual(where(sol), [["sweep_to_treasury", "SOL", "a", SOL]]);
});

test("a payout that has just left the hot wallet is gone from what it is filled against, final or not", () => {
  // Float $200. The wallet held 200, final. A 150 payout has landed and is not final:
  // 50 is confirmed, 200 is still final, and no row of this table is the payout.
  const justPaid = planSweeps(
    facts({
      addresses: [held("a", 60n * USDC)],
      hotWallet: { address: HOT, lamports: SOL / 10n, usdcRaw: 50n * USDC, finalized: { lamports: SOL / 10n, usdcRaw: 200n * USDC } },
    }),
  );
  assert.deepEqual(where(justPaid), [["sweep_to_hot", "USDC", "a", 60n * USDC]], "it holds 50, under its float, so the deposit is its");

  // A payout and a transfer out of the wallet at once: 1,000 final, an 800 transfer
  // out still "sent" and landed, and a 150 payout landed too. 50 is confirmed.
  // The row takes off 800 and the rest of what has gone, 150, is the payout: it holds 50.
  const both = planSweeps(
    facts({
      addresses: [held("a", 60n * USDC)],
      sent: [{ fromAddress: HOT, toAddress: TREASURY, asset: "USDC", amountRaw: 800n * USDC }],
      hotWallet: { address: HOT, lamports: SOL / 10n, usdcRaw: 50n * USDC, finalized: { lamports: SOL / 10n, usdcRaw: 1_000n * USDC } },
    }),
  );
  assert.deepEqual(where(both), [["sweep_to_hot", "USDC", "a", 60n * USDC]]);

  // SOL the same. $200 a SOL, float $100 is 0.5 SOL. 1 SOL final, 0.2 SOL confirmed after a payout.
  const sweepable = SOL + KEEP + FEE;
  const sol = planSweeps(
    facts({
      addresses: [held("a", 0n, sweepable)],
      hotWallet: { address: HOT, lamports: SOL / 5n, usdcRaw: 0n, finalized: { lamports: SOL, usdcRaw: 0n } },
    }),
  );
  assert.deepEqual(where(sol), [["sweep_to_hot", "SOL", "a", SOL]]);
});

test("the hot wallet is never filled for more than its excess leaves it", () => {
  // $200 a SOL, float $100. $800 of SOL payouts wait, and what is kept for all open
  // ones is $400 (the day's limit took the rest). The wallet holds 3.5 SOL, $700.
  // Filled for 800 it would take the deposit and send as much on in the same plan.
  const plan = planSweeps(
    facts({
      addresses: [held("a", 0n, SOL + KEEP + FEE)],
      hotWallet: { address: HOT, lamports: (7n * SOL) / 2n, usdcRaw: 0n },
      openPayouts: owes({ solCents: 80_000n }, { solCents: 40_000n }),
    }),
  );
  // It is filled to float plus 400: $700 is over that, so the deposit is the treasury's.
  // And $700 is more than twice the float on top of 400, so it keeps 500 and sends 1 SOL on.
  assert.deepEqual(where(plan), [
    ["sweep_to_treasury", "SOL", "a", SOL],
    ["hot_to_treasury", "SOL", null, SOL],
  ]);
  assert.ok(!plan.transfers.some((t) => t.kind === "sweep_to_hot"), "nothing goes in that goes straight out again");
});

test("one excess transfer an asset, never while another from the hot wallet for it is sent, never without a treasury", () => {
  const rich = { address: HOT, lamports: 9n * SOL, usdcRaw: 9_000n * USDC };
  const both = planSweeps(facts({ hotWallet: rich }));
  assert.deepEqual(
    both.transfers.map((t) => [t.kind, t.asset]),
    [
      ["hot_to_treasury", "USDC"],
      ["hot_to_treasury", "SOL"],
    ],
  );

  const usdcOut = planSweeps(
    facts({
      hotWallet: rich,
      sent: [{ fromAddress: HOT, toAddress: TREASURY, asset: "USDC", amountRaw: 100n * USDC }],
    }),
  );
  assert.deepEqual(usdcOut.transfers.map((t) => t.asset), ["SOL"]);

  const solOut = planSweeps(
    facts({
      hotWallet: rich,
      sent: [{ fromAddress: HOT, toAddress: TREASURY, asset: "SOL", amountRaw: SOL }],
    }),
  );
  assert.deepEqual(solOut.transfers.map((t) => t.asset), ["USDC"]);

  assert.deepEqual(planSweeps(facts({ hotWallet: rich, treasury: null })).transfers, []);
});

test("no USDC excess while the hot wallet could not pay for it", () => {
  const plan = planSweeps(
    facts({ hotWallet: { address: HOT, lamports: 49_999_999n, usdcRaw: 9_000n * USDC } }),
  );
  assert.deepEqual(plan.transfers, []);
});

test("the excess is not capped by SWEEP_MAX_PER_RUN and does not use it up", () => {
  const plan = planSweeps(
    facts({
      settings: { ...SETTINGS, maxPerRun: 1 },
      addresses: [held("org-a", 60n * USDC), held("org-b", 50n * USDC)],
      hotWallet: { address: HOT, lamports: SOL / 10n, usdcRaw: 9_000n * USDC },
    }),
  );
  assert.deepEqual(where(plan), [
    ["sweep_to_treasury", "USDC", "org-a", 60n * USDC],
    ["hot_to_treasury", "USDC", null, 8_800n * USDC],
  ]);
});

// ============================================
// No other destination
// ============================================

test("every transfer of every plan goes to the hot wallet or the proven treasury, and never from one to itself", () => {
  const shapes: Array<Partial<SweepPlanFacts>> = [
    {},
    { treasury: null },
    { quote: null },
    { hotWallet: { address: HOT, lamports: 99n * SOL, usdcRaw: 99_000n * USDC } },
    { hotWallet: { address: HOT, lamports: 0n, usdcRaw: 0n } },
    // A deposit row that is, absurdly, the hot wallet or the treasury.
    {
      addresses: [
        { orgId: "org-hot", address: HOT, lamports: 9n * SOL, usdcRaw: 900n * USDC, lastSeenLamports: 9n * SOL, lastSeenUsdcRaw: 900n * USDC },
        { orgId: "org-tre", address: TREASURY, lamports: 9n * SOL, usdcRaw: 900n * USDC, lastSeenLamports: 9n * SOL, lastSeenUsdcRaw: 900n * USDC },
      ],
    },
  ];
  for (const shape of shapes) {
    const base = facts({
      addresses: [held("org-a", 500n * USDC, 5n * SOL), held("org-b", 90n * USDC, SOL), held("org-c", 30n * USDC)],
      ...shape,
    });
    const plan = planSweeps(base);
    for (const t of plan.transfers) {
      const allowed = base.treasury === null ? [HOT] : [HOT, TREASURY];
      assert.ok(allowed.includes(t.toAddress), `${t.kind} to ${t.toAddress}`);
      assert.notEqual(t.fromAddress, t.toAddress);
      assert.ok(t.amountRaw > 0n);
      if (t.kind === "sweep_to_hot") assert.equal(t.toAddress, HOT);
      else assert.equal(t.toAddress, TREASURY);
      if (t.kind !== "hot_to_treasury") {
        assert.notEqual(t.fromAddress, HOT);
        assert.notEqual(t.fromAddress, TREASURY);
      }
    }
  }
});

// ============================================
// The treasury is proven only by rule 4
// ============================================

test("the treasury is proven only when the row names exactly the setting, and the setting is a real wallet of its own", () => {
  const none = () => false;
  assert.deepEqual(
    treasuryVerdict({ setting: TREASURY, provenAddress: TREASURY, hotWalletAddress: HOT, isDepositAddress: none }),
    { proven: true, address: TREASURY },
  );
  // Spaces around the setting are not another address.
  assert.deepEqual(
    treasuryVerdict({ setting: ` ${TREASURY}\n`, provenAddress: TREASURY, hotWalletAddress: HOT, isDepositAddress: none }),
    { proven: true, address: TREASURY },
  );

  const refused = (over: Partial<Parameters<typeof treasuryVerdict>[0]>) => {
    const verdict = treasuryVerdict({
      setting: TREASURY,
      provenAddress: TREASURY,
      hotWalletAddress: HOT,
      isDepositAddress: none,
      ...over,
    });
    assert.equal(verdict.proven, false);
    return verdict.proven ? "" : verdict.reason;
  };
  assert.equal(refused({ provenAddress: null }), "not_proven");
  assert.equal(refused({ provenAddress: "" }), "not_proven");
  assert.equal(refused({ provenAddress: addressOf("an-older-treasury") }), "proven_for_another_address");
  assert.equal(refused({ setting: NO_TREASURY_ADDRESS, provenAddress: NO_TREASURY_ADDRESS }), "not_set");
  assert.equal(refused({ setting: undefined }), "not_set");
  assert.equal(refused({ setting: "" }), "not_set");
  assert.equal(refused({ setting: HOT, provenAddress: HOT }), "is_hot_wallet");
  const deposit = depositAddressOf("org-a");
  assert.equal(
    refused({ setting: deposit, provenAddress: deposit, isDepositAddress: (a) => a === deposit }),
    "is_deposit_address",
  );
  // A token account is a real address with no key.
  const tokenAccount = usdcAccountOf(TREASURY);
  assert.equal(refused({ setting: tokenAccount, provenAddress: tokenAccount }), "not_a_wallet");
  assert.equal(refused({ setting: "not an address", provenAddress: "not an address" }), "not_a_wallet");
  assert.equal(refused({ setting: `${TREASURY}x`, provenAddress: `${TREASURY}x` }), "not_a_wallet");
});

test("the address checks alone: what could ever be a treasury", () => {
  const read = (setting: string | undefined) =>
    readTreasuryAddress({ setting, hotWalletAddress: HOT, isDepositAddress: () => false });
  assert.deepEqual(read(TREASURY), { ok: true, address: TREASURY });
  assert.deepEqual(read(NO_TREASURY_ADDRESS), { ok: false, reason: "not_set" });
  assert.deepEqual(read(HOT), { ok: false, reason: "is_hot_wallet" });
  assert.deepEqual(read(usdcAccountOf(HOT)), { ok: false, reason: "not_a_wallet" });
});
