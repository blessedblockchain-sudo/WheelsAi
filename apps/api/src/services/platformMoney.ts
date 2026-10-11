/**
 * The operator's money report: what customers hold, what creators are owed,
 * what came in, what sits on the chain, what the sweeps moved, and whether
 * the deposit addresses hold exactly what the records say they should.
 *
 * READ-ONLY and pure: every read is injected (routes/platformMoneyBindings.ts
 * binds them to Prisma, the connection and the settings). The arithmetic is
 * here: the "other" rail, the signs, the reconciliation, and whether the
 * treasury counts as proven.
 *
 * Every amount in cents or base units leaves as a STRING of digits (a minus
 * sign in front when it is below zero): they are BigInt, and a JSON number
 * loses whole units above 2^53.
 *
 * A section whose read throws answers `{ state: "unreadable" }` and nothing
 * else; the other sections are still answered.
 */

import { PublicKey } from "@solana/web3.js";

import { readWalletAddress } from "./payoutRules.js";

/** TREASURY_WALLET_ADDRESS's default: the System Program, "no treasury". */
export const NO_TREASURY_ADDRESS = "11111111111111111111111111111111";

/** The kinds of ChainTransfer that leave a deposit address. */
export const SWEEP_KINDS_FROM_DEPOSIT = ["sweep_to_hot", "sweep_to_treasury"] as const;

/** How long one read may take before its section is called unreadable. */
export const MONEY_READ_TIMEOUT_MS = 20_000;

/** Payout statuses that are still open. */
export const OPEN_PAYOUT_STATUSES = ["pending", "processing"] as const;

export type MoneyNetwork = "mainnet-beta" | "devnet";
export type MoneyAsset = "USDC" | "SOL";
export type MoneySectionState = "ok" | "unreadable";

/** `from` is included, `to` is not. */
export interface MoneyRange {
  from: Date;
  to: Date;
}

// ============================================
// What the reads answer (BigInt, unformatted)
// ============================================

export interface MethodSum {
  method: string;
  count: number;
  amountCents: bigint;
}

export interface AssetSum {
  asset: string;
  count: number;
  amountCents: bigint;
}

export interface CustomersFacts {
  balanceCents: bigint;
  organizationsWithBalance: number;
}

export interface CreatorsFacts {
  owedCents: bigint;
  openPayouts: MethodSum[];
  paidOutInRange: MethodSum[];
}

export interface IncomeFacts {
  /** Credited wallet_topups in the range, by asset (amountUsdCents). */
  walletTopups: AssetSum[];
  /** Credited onchain_receipts whose source is "direct", by asset. */
  deposits: AssetSum[];
  /** Completed stripe_purchases in the range. */
  stripe: { count: number; amountCents: bigint };
  /** Every credit_transactions row of type "purchase" in the range. */
  purchases: { count: number; amountCents: bigint };
  bonusesGrantedCents: bigint;
  /** The negative credit_transactions by type, as stored (below zero). */
  debits: Array<{ type: string; amountCents: bigint }>;
  marketplaceFeesCents: bigint;
  x402: Array<{ asset: string; count: number; amountUsd: number }>;
}

export interface WalletHolding {
  lamports: bigint;
  usdcRaw: bigint;
}

export interface DepositHoldings {
  count: number;
  lamports: bigint;
  usdcRaw: bigint;
}

export interface SweepsFacts {
  sent: number;
  landedInRange: Array<{ kind: string; asset: string; count: number; amountRaw: bigint }>;
  failedInRange: number;
}

/**
 * Transfers that left, or tried to leave, a deposit address and reached the
 * chain, summed however the read likes. `landed` false is one that failed
 * on the chain: it moved nothing, and still cost its fee payer the fee.
 */
export interface SweptRow {
  asset: string;
  fromAddress: string;
  feePayer: string;
  landed: boolean;
  amountRaw: bigint;
  feeLamports: bigint;
}

export interface LedgerFacts {
  /** Every onchain_receipts.amountRaw of this chain, whatever its status. */
  receivedUsdcRaw: bigint;
  receivedLamports: bigint;
  swept: SweptRow[];
}

export type ClusterHealth = "ok" | "wrong_cluster" | "unreachable";

export interface MoneySwitches {
  walletTopups: boolean;
  deposits: boolean;
  depositScan: boolean;
  sweeps: boolean;
  payouts: boolean;
}

export interface SolPriceHealth {
  source: string;
  ok: boolean;
  ageSeconds: number | null;
}

export interface PlatformMoneyDeps {
  /** PLATFORM_ADMIN_KEY, read per request. */
  adminKey: () => string | undefined;
  now: () => Date;
  network: () => MoneyNetwork;

  readCustomers: () => Promise<CustomersFacts>;
  readCreators: (range: MoneyRange) => Promise<CreatorsFacts>;
  readIncome: (range: MoneyRange) => Promise<IncomeFacts>;

  /** TREASURY_WALLET_ADDRESS as set. */
  treasurySetting: () => string | undefined;
  /** May throw (no WALLET_MASTER_KEY): the on-chain section is then unreadable. */
  hotWalletAddress: () => string;
  /** The PlatformWallet row with role "treasury" for this chain. */
  readTreasuryRow: () => Promise<{ address: string } | null>;
  /** Is this a deposit address this server derives. */
  isDepositAddress: (address: string) => Promise<boolean>;
  /**
   * What each address holds now, in the order asked, in ONE call to the
   * node. Throws when the node cannot be read or is on the wrong cluster.
   */
  readWallets: (addresses: string[]) => Promise<WalletHolding[]>;
  /** deposit_addresses of this chain: the stored lastSeen figures, summed. */
  readDepositHoldings: () => Promise<DepositHoldings>;

  readSweeps: (range: MoneyRange) => Promise<SweepsFacts>;
  readLedger: () => Promise<LedgerFacts>;

  clusterCheck: () => Promise<ClusterHealth>;
  switches: () => MoneySwitches;
  solPrice: () => Promise<SolPriceHealth>;

  /** Told about a section that could not be read. Never throws. */
  reportUnreadable?: (section: string, err: unknown) => void;
  /** Ceiling for each section's read, the cluster check and the price. */
  timeoutMs?: number;
}

// ============================================
// The response
// ============================================

type Unreadable = { state: "unreadable" };

export interface PlatformMoneyResponse {
  generatedAt: string;
  network: MoneyNetwork;
  range: { from: string; to: string };
  customers:
    | { state: "ok"; balanceCents: string; organizationsWithBalance: number }
    | Unreadable;
  creators:
    | {
        state: "ok";
        owedCents: string;
        openPayouts: Array<{ method: string; count: number; amountCents: string }>;
        paidOutInRange: Array<{ method: string; count: number; amountCents: string }>;
      }
    | Unreadable;
  income:
    | {
        state: "ok";
        creditsSold: Array<{
          rail: "wallet_topup" | "deposit" | "stripe" | "other";
          asset: string | null;
          count: number;
          amountCents: string;
        }>;
        bonusesGrantedCents: string;
        creditsUsed: Array<{ type: string; amountCents: string }>;
        marketplaceFeesCents: string;
        x402Received: Array<{ asset: string; count: number; amountUsd: number }>;
      }
    | Unreadable;
  onChain:
    | {
        state: "ok";
        hotWallet: { address: string; lamports: string; usdcRaw: string };
        treasury: {
          address: string;
          proven: boolean;
          /** Null only when the setting is not an address at all. */
          lamports: string | null;
          usdcRaw: string | null;
        } | null;
        depositAddresses: { count: number; lamports: string; usdcRaw: string };
      }
    | Unreadable;
  sweeps:
    | {
        state: "ok";
        sent: number;
        landedInRange: Array<{ kind: string; asset: string; count: number; amountRaw: string }>;
        failedInRange: number;
      }
    | Unreadable;
  reconciliation:
    | {
        state: "ok";
        usdc: {
          receivedRaw: string;
          sweptRaw: string;
          expectedRaw: string;
          heldRaw: string;
          differenceRaw: string;
        };
        sol: {
          receivedLamports: string;
          sweptLamports: string;
          feeLamports: string;
          expectedLamports: string;
          heldLamports: string;
          differenceLamports: string;
        };
      }
    | Unreadable;
  health: MoneySwitches & { cluster: ClusterHealth; solPrice: SolPriceHealth };
}

// ============================================
// The range
// ============================================

const DAY_MS = 86_400_000;

/** A calendar day written YYYY-MM-DD, as its first instant in UTC. */
export function parseUtcDay(text: unknown): Date | null {
  if (typeof text !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  // 2026-02-30 would roll over into March: it is not a day.
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== m[0].trim()) return null;
  return date;
}

export type MoneyRangeResult = { ok: true; range: MoneyRange } | { ok: false };

/**
 * `from` defaults to the first day of the current UTC month, `to` to now.
 * A `to` that is given covers that whole day: the range ends where the next
 * day begins. A date that cannot be read, or a range that ends before it
 * starts, is refused.
 */
export function resolveMoneyRange(
  input: { from?: unknown; to?: unknown },
  now: Date,
): MoneyRangeResult {
  let from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  let to = now;
  if (input.from !== undefined) {
    const day = parseUtcDay(input.from);
    if (!day) return { ok: false };
    from = day;
  }
  if (input.to !== undefined) {
    const day = parseUtcDay(input.to);
    if (!day) return { ok: false };
    // The last day asked for is before the first.
    if (day.getTime() < from.getTime()) return { ok: false };
    to = new Date(day.getTime() + DAY_MS);
  }
  if (to.getTime() < from.getTime()) return { ok: false };
  return { ok: true, range: { from, to } };
}

// ============================================
// Rule 4: is the treasury proven
// ============================================

export interface TreasuryFacts {
  /** TREASURY_WALLET_ADDRESS as set. */
  setting: string | undefined;
  /** The PlatformWallet row's address, or null when there is no row. */
  rowAddress: string | null;
  hotWalletAddress: string;
  /** Whether the setting is a deposit address this server derives. */
  isDepositAddress: boolean;
}

/**
 * Proven only when a PlatformWallet row exists for this chain AND its
 * address is exactly the setting AND the setting is an ordinary wallet
 * address that is not the all-ones default, not the hot wallet and not a
 * deposit address this server derives.
 */
export function treasuryProven(facts: TreasuryFacts): boolean {
  const setting = facts.setting;
  if (typeof setting !== "string" || setting.length === 0) return false;
  if (setting === NO_TREASURY_ADDRESS) return false;
  if (readWalletAddress(setting) !== setting) return false;
  if (setting === facts.hotWalletAddress) return false;
  if (facts.isDepositAddress) return false;
  if (facts.rowAddress === null || facts.rowAddress !== setting) return false;
  return true;
}

/**
 * Can the node be asked about this text: base58 that decodes to exactly 32
 * bytes. Whether it is an ordinary wallet is rule 4's business, not the
 * read's.
 */
export function isReadableAddress(text: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text)) return false;
  try {
    new PublicKey(text);
    return true;
  } catch {
    return false;
  }
}

/** Is any treasury address set at all (anything but empty and the default). */
export function treasuryIsSet(setting: string | undefined): setting is string {
  return typeof setting === "string" && setting.trim().length > 0 && setting.trim() !== NO_TREASURY_ADDRESS;
}

// ============================================
// Arithmetic
// ============================================

function nonNegative(value: bigint): bigint {
  return value < 0n ? 0n : value;
}

function byText<T>(key: (row: T) => string): (a: T, b: T) => number {
  return (a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
}

/** The four rails. "other" is the purchases no rail accounts for, never below zero. */
export function creditsSold(income: IncomeFacts): Array<{
  rail: "wallet_topup" | "deposit" | "stripe" | "other";
  asset: string | null;
  count: number;
  amountCents: bigint;
}> {
  const rows: ReturnType<typeof creditsSold> = [];
  let knownCents = 0n;
  let knownCount = 0;
  for (const row of [...income.walletTopups].sort(byText((r) => r.asset))) {
    rows.push({ rail: "wallet_topup", asset: row.asset, count: row.count, amountCents: row.amountCents });
    knownCents += row.amountCents;
    knownCount += row.count;
  }
  for (const row of [...income.deposits].sort(byText((r) => r.asset))) {
    rows.push({ rail: "deposit", asset: row.asset, count: row.count, amountCents: row.amountCents });
    knownCents += row.amountCents;
    knownCount += row.count;
  }
  rows.push({
    rail: "stripe",
    asset: null,
    count: income.stripe.count,
    amountCents: income.stripe.amountCents,
  });
  knownCents += income.stripe.amountCents;
  knownCount += income.stripe.count;
  rows.push({
    rail: "other",
    asset: null,
    count: Math.max(0, income.purchases.count - knownCount),
    amountCents: nonNegative(income.purchases.amountCents - knownCents),
  });
  return rows;
}

export interface Reconciliation {
  usdc: { received: bigint; swept: bigint; expected: bigint; held: bigint; difference: bigint };
  sol: {
    received: bigint;
    swept: bigint;
    fee: bigint;
    expected: bigint;
    held: bigint;
    difference: bigint;
  };
}

/**
 * Per asset: expected = received less swept (less, for SOL, every fee an
 * address paid itself); difference = held less expected. A fee the hot
 * wallet paid took nothing from a deposit address and is not counted. A
 * sweep that failed on the chain moved nothing but its fee was still
 * taken, so its fee counts and its amount does not.
 */
export function reconcile(ledger: LedgerFacts, held: DepositHoldings): Reconciliation {
  let sweptUsdc = 0n;
  let sweptSol = 0n;
  let fee = 0n;
  for (const row of ledger.swept) {
    if (row.landed) {
      if (row.asset === "USDC") sweptUsdc += row.amountRaw;
      else if (row.asset === "SOL") sweptSol += row.amountRaw;
    }
    if (row.feePayer === row.fromAddress) fee += row.feeLamports;
  }
  const expectedUsdc = ledger.receivedUsdcRaw - sweptUsdc;
  const expectedSol = ledger.receivedLamports - sweptSol - fee;
  return {
    usdc: {
      received: ledger.receivedUsdcRaw,
      swept: sweptUsdc,
      expected: expectedUsdc,
      held: held.usdcRaw,
      difference: held.usdcRaw - expectedUsdc,
    },
    sol: {
      received: ledger.receivedLamports,
      swept: sweptSol,
      fee,
      expected: expectedSol,
      held: held.lamports,
      difference: held.lamports - expectedSol,
    },
  };
}

// ============================================
// The report
// ============================================

/** A read that has not answered in time is a read that failed: a node that hangs must not hang the report. */
async function withTimeout<T>(run: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(run),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function timeoutOf(deps: PlatformMoneyDeps): number {
  return deps.timeoutMs ?? MONEY_READ_TIMEOUT_MS;
}

async function section<T extends { state: "ok" }>(
  name: string,
  deps: PlatformMoneyDeps,
  read: () => Promise<T>,
): Promise<T | Unreadable> {
  try {
    return await withTimeout(read, timeoutOf(deps));
  } catch (err) {
    try {
      deps.reportUnreadable?.(name, err);
    } catch {
      // The report must not fail because its log did.
    }
    return { state: "unreadable" };
  }
}

function methodRows(rows: MethodSum[]) {
  return [...rows]
    .sort(byText((r) => r.method))
    .map((r) => ({ method: r.method, count: r.count, amountCents: r.amountCents.toString() }));
}

export async function computePlatformMoney(
  deps: PlatformMoneyDeps,
  range: MoneyRange,
): Promise<PlatformMoneyResponse> {
  const now = deps.now();

  // Read once, used by two sections. Either can fail on it without the other
  // being asked again.
  let holdings: Promise<DepositHoldings> | null = null;
  const depositHoldings = () => {
    if (!holdings) holdings = Promise.resolve().then(() => deps.readDepositHoldings());
    return holdings;
  };

  const customers = section("customers", deps, async () => {
    const facts = await deps.readCustomers();
    return {
      state: "ok" as const,
      balanceCents: facts.balanceCents.toString(),
      organizationsWithBalance: facts.organizationsWithBalance,
    };
  });

  const creators = section("creators", deps, async () => {
    const facts = await deps.readCreators(range);
    return {
      state: "ok" as const,
      owedCents: facts.owedCents.toString(),
      openPayouts: methodRows(facts.openPayouts),
      paidOutInRange: methodRows(facts.paidOutInRange),
    };
  });

  const income = section("income", deps, async () => {
    const facts = await deps.readIncome(range);
    return {
      state: "ok" as const,
      creditsSold: creditsSold(facts).map((r) => ({ ...r, amountCents: r.amountCents.toString() })),
      bonusesGrantedCents: facts.bonusesGrantedCents.toString(),
      creditsUsed: [...facts.debits]
        .sort(byText((r) => r.type))
        .map((r) => ({
          type: r.type,
          amountCents: (r.amountCents < 0n ? -r.amountCents : r.amountCents).toString(),
        })),
      marketplaceFeesCents: facts.marketplaceFeesCents.toString(),
      x402Received: [...facts.x402]
        .sort(byText((r) => r.asset))
        .map((r) => ({
          asset: r.asset,
          count: r.count,
          amountUsd: Math.round(r.amountUsd * 1_000_000) / 1_000_000,
        })),
    };
  });

  const onChain = section("onChain", deps, async () => {
    const hotAddress = deps.hotWalletAddress();
    const rawSetting = deps.treasurySetting();
    const setting = treasuryIsSet(rawSetting) ? rawSetting.trim() : null;

    // A setting the node cannot be asked about is shown and never read, so
    // it cannot take the hot wallet's figures down with it.
    const readable = setting !== null && isReadableAddress(setting);
    const [row, isDeposit, held, wallets] = await Promise.all([
      setting !== null ? deps.readTreasuryRow() : Promise.resolve(null),
      setting !== null ? deps.isDepositAddress(setting) : Promise.resolve(false),
      depositHoldings(),
      deps.readWallets(readable ? [hotAddress, setting] : [hotAddress]),
    ]);
    const hot = wallets[0];
    if (!hot) throw new Error("the hot wallet was not read");
    const treasuryHolding = readable ? wallets[1] : undefined;
    if (readable && !treasuryHolding) throw new Error("the treasury was not read");

    return {
      state: "ok" as const,
      hotWallet: {
        address: hotAddress,
        lamports: hot.lamports.toString(),
        usdcRaw: hot.usdcRaw.toString(),
      },
      treasury:
        setting === null
          ? null
          : {
              address: setting,
              proven: treasuryProven({
                setting,
                rowAddress: row?.address ?? null,
                hotWalletAddress: hotAddress,
                isDepositAddress: isDeposit,
              }),
              lamports: treasuryHolding ? treasuryHolding.lamports.toString() : null,
              usdcRaw: treasuryHolding ? treasuryHolding.usdcRaw.toString() : null,
            },
      depositAddresses: {
        count: held.count,
        lamports: held.lamports.toString(),
        usdcRaw: held.usdcRaw.toString(),
      },
    };
  });

  const sweeps = section("sweeps", deps, async () => {
    const facts = await deps.readSweeps(range);
    return {
      state: "ok" as const,
      sent: facts.sent,
      landedInRange: [...facts.landedInRange]
        .sort(byText((r) => `${r.kind} ${r.asset}`))
        .map((r) => ({
          kind: r.kind,
          asset: r.asset,
          count: r.count,
          amountRaw: r.amountRaw.toString(),
        })),
      failedInRange: facts.failedInRange,
    };
  });

  const reconciliation = section("reconciliation", deps, async () => {
    const [ledger, held] = await Promise.all([deps.readLedger(), depositHoldings()]);
    const r = reconcile(ledger, held);
    return {
      state: "ok" as const,
      usdc: {
        receivedRaw: r.usdc.received.toString(),
        sweptRaw: r.usdc.swept.toString(),
        expectedRaw: r.usdc.expected.toString(),
        heldRaw: r.usdc.held.toString(),
        differenceRaw: r.usdc.difference.toString(),
      },
      sol: {
        receivedLamports: r.sol.received.toString(),
        sweptLamports: r.sol.swept.toString(),
        feeLamports: r.sol.fee.toString(),
        expectedLamports: r.sol.expected.toString(),
        heldLamports: r.sol.held.toString(),
        differenceLamports: r.sol.difference.toString(),
      },
    };
  });

  const cluster = (async (): Promise<ClusterHealth> => {
    try {
      return await withTimeout(() => deps.clusterCheck(), timeoutOf(deps));
    } catch {
      return "unreachable";
    }
  })();

  const solPrice = (async (): Promise<SolPriceHealth> => {
    try {
      return await withTimeout(() => deps.solPrice(), timeoutOf(deps));
    } catch {
      return { source: "unknown", ok: false, ageSeconds: null };
    }
  })();

  return {
    generatedAt: now.toISOString(),
    network: deps.network(),
    range: { from: range.from.toISOString(), to: range.to.toISOString() },
    customers: await customers,
    creators: await creators,
    income: await income,
    onChain: await onChain,
    sweeps: await sweeps,
    reconciliation: await reconciliation,
    health: {
      cluster: await cluster,
      ...deps.switches(),
      solPrice: await solPrice,
    },
  };
}
