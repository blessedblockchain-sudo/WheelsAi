// Stand-ins for the payout worker's tests: a database and a chain, both in
// memory. Nothing here opens a socket.
//
// The database keeps creator_payouts rows, what each creator is owed with
// its ledger, and credit balances with theirs. It applies a `where` the way
// the real one does (so a compare-and-set that should lose, loses), holds
// the two unique indexes the payout code leans on (one signature on one
// row; one open payout per creator), and runs a transaction all or nothing.
// One statement runs at a time, as in a database; `pause` lets a test put
// gaps between statements so two runs can interleave.
//
// The chain keeps a block height, the transfers that reached it, and which
// of them landed. A transfer can land only while the height has not passed
// its last valid block height: that is the chain's own rule, and the tests
// that hunt for a double payment judge by it, not by what the worker thinks.

import { AccountLayout, ACCOUNT_SIZE, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey, SystemProgram, Transaction, type AccountInfo, type Keypair } from "@solana/web3.js";
import bs58 from "bs58";

import {
  buildPayoutExecutorTickDeps,
  type PayoutExecutorConnection,
  type PayoutExecutorDb,
} from "../services/buildPayoutExecutorTickDeps.js";
import { moveEarnings, type EarningsLedgerTx } from "../services/earningsLedger.js";
import type { CancelPayoutDb } from "../services/payoutRequests.js";
import { runPayoutExecutorTick, type PayoutTickEvent } from "../services/runPayoutExecutorTick.js";
import type { SignatureFateAnswer, SignatureFateInput } from "../services/signatureFate.js";
import type { SolPriceResult } from "../services/solPrice.js";
import { earningsStandIn, type EarningsRow } from "./earningsStandIn.js";

// ---------------------------------------------------------------
// The database
// ---------------------------------------------------------------

export interface StandInPayout {
  id: string;
  publisherId: string;
  amountCents: bigint;
  payoutMethod: string;
  payoutAddress: string | null;
  status: string;
  txSignature: string | null;
  grossRevenueCents: bigint;
  platformFeeCents: bigint;
  periodStart: Date;
  periodEnd: Date;
  requestedAt: Date;
  processedAt: Date | null;
  failureReason: string | null;
  failureCode: string | null;
  waitingReason: string | null;
  signedTxB64: string | null;
  lastValidBlockHeight: bigint | null;
  claimedAt: Date | null;
  attemptCount: number;
  expiredSignatures: string[];
  amountRaw: string | null;
  quotePriceMicroUsd: bigint | null;
  quotePublishTime: Date | null;
  quoteSource: string | null;
}

export interface CreditLedgerRow {
  orgId: string;
  amountCents: bigint;
  type: string;
  description: string;
  referenceId: string;
  balanceAfter: bigint;
}

export interface PayoutStandInState {
  payouts: StandInPayout[];
  /** What each creator is owed. A creator with no entry has no publisher profile. */
  earnings: Record<string, bigint>;
  earningsLedger: EarningsRow[];
  credits: Record<string, bigint>;
  creditLedger: CreditLedgerRow[];
  /** Every write to a payout row that changed it, in order. */
  payoutWrites: Array<{ id: string; where: unknown; data: unknown }>;
}

export interface PayoutStandInOptions {
  /** Awaited before every statement and every transaction: a gap another run can use. */
  pause?: () => Promise<void>;
  /** Called after a payout row was changed, with the row before and after. */
  onPayoutWrite?: (before: StandInPayout, after: StandInPayout) => void;
  /** A statement that should fail: return an error to throw it instead of running the statement. */
  failStatement?: (op: string, args: unknown) => Error | null;
}

const OPEN = new Set(["pending", "processing"]);

function uniqueViolation(target: string): Error {
  return Object.assign(new Error(`Unique constraint failed on the fields: (${target})`), { code: "P2002" });
}

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

function atLeast(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined) return false;
  if (a instanceof Date && b instanceof Date) return a.getTime() >= b.getTime();
  return (a as bigint | number) >= (b as bigint | number);
}

function matches(row: StandInPayout, where: Record<string, unknown>): boolean {
  for (const [key, wanted] of Object.entries(where)) {
    if (wanted === undefined) continue;
    const have = (row as unknown as Record<string, unknown>)[key];
    if (wanted !== null && typeof wanted === "object" && !(wanted instanceof Date)) {
      const cond = wanted as { in?: unknown[]; gte?: unknown; not?: unknown };
      if ("not" in cond && same(have ?? null, cond.not)) return false;
      if (cond.in && !cond.in.some((v) => same(have, v))) return false;
      if (cond.gte !== undefined && !atLeast(have, cond.gte)) return false;
      continue;
    }
    if (!same(have ?? null, wanted)) return false;
  }
  return true;
}

function applied(row: StandInPayout, data: Record<string, unknown>): StandInPayout {
  const next = { ...row, expiredSignatures: [...row.expiredSignatures] } as StandInPayout;
  const fields = next as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (value !== null && typeof value === "object" && !(value instanceof Date)) {
      const change = value as { increment?: number; push?: string };
      if (change.increment !== undefined) fields[key] = (fields[key] as number) + change.increment;
      else if (change.push !== undefined) (fields[key] as string[]).push(change.push);
      else throw new Error(`payoutStandIn: unsupported write for ${key}`);
      continue;
    }
    fields[key] = value;
  }
  return next;
}

let nextId = 1;

export function standInPayout(over: Partial<StandInPayout> = {}): StandInPayout {
  const at = new Date("2026-10-10T12:00:00.000Z");
  return {
    id: `payout_${nextId++}`,
    publisherId: "org_creator",
    amountCents: 2_500n,
    payoutMethod: "crypto_usdc",
    payoutAddress: null,
    status: "pending",
    txSignature: null,
    grossRevenueCents: 2_778n,
    platformFeeCents: 278n,
    periodStart: at,
    periodEnd: at,
    requestedAt: at,
    processedAt: null,
    failureReason: null,
    failureCode: null,
    waitingReason: null,
    signedTxB64: null,
    lastValidBlockHeight: null,
    claimedAt: null,
    attemptCount: 0,
    expiredSignatures: [],
    amountRaw: null,
    quotePriceMicroUsd: null,
    quotePublishTime: null,
    quoteSource: null,
    ...over,
  };
}

export function payoutStandIn(
  seed: { payouts?: StandInPayout[]; earnings?: Record<string, bigint>; credits?: Record<string, bigint> } = {},
  opts: PayoutStandInOptions = {},
) {
  const state: PayoutStandInState = {
    payouts: [...(seed.payouts ?? [])],
    earnings: { ...(seed.earnings ?? {}) },
    earningsLedger: [],
    credits: { ...(seed.credits ?? {}) },
    creditLedger: [],
    payoutWrites: [],
  };

  // One statement (or one transaction) at a time.
  let tail: Promise<unknown> = Promise.resolve();
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  }
  const pause = async () => {
    await opts.pause?.();
  };
  const refuse = (op: string, args: unknown) => {
    const err = opts.failStatement?.(op, args);
    if (err) throw err;
  };

  // ---- statements, as they run once they hold the turn ----

  function updatePayouts(args: { where: Record<string, unknown>; data: Record<string, unknown> }): { count: number } {
    refuse("creatorPayout.updateMany", args);
    let count = 0;
    for (const [index, row] of state.payouts.entries()) {
      if (!matches(row, args.where)) continue;
      const next = applied(row, args.data);
      if (
        next.txSignature !== null &&
        state.payouts.some((other) => other.id !== next.id && other.txSignature === next.txSignature)
      ) {
        throw uniqueViolation("tx_signature");
      }
      if (
        OPEN.has(next.status) &&
        state.payouts.some(
          (other) => other.id !== next.id && other.publisherId === next.publisherId && OPEN.has(other.status),
        )
      ) {
        throw uniqueViolation("creator_payouts_one_open_per_publisher");
      }
      state.payouts[index] = next;
      state.payoutWrites.push({ id: row.id, where: args.where, data: args.data });
      opts.onPayoutWrite?.(row, next);
      count += 1;
    }
    return { count };
  }

  function createPayout(row: StandInPayout): StandInPayout {
    refuse("creatorPayout.create", row);
    if (OPEN.has(row.status) && state.payouts.some((p) => p.publisherId === row.publisherId && OPEN.has(p.status))) {
      throw uniqueViolation("creator_payouts_one_open_per_publisher");
    }
    state.payouts.push(row);
    return row;
  }

  const earnings = earningsStandIn({
    pending: (orgId) => state.earnings[orgId],
    add: (orgId, pendingCents) => {
      state.earnings[orgId] = (state.earnings[orgId] ?? 0n) + pendingCents;
    },
    write: (row) => {
      state.earningsLedger.push(row);
    },
  });

  const unlocked = {
    creatorPayout: {
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) =>
        updatePayouts(args),
      findMany: async (args: { where: Record<string, unknown>; take: number }) => {
        refuse("creatorPayout.findMany", args);
        return state.payouts
          .filter((row) => matches(row, args.where))
          .sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime())
          .slice(0, args.take)
          .map((row) => ({ ...row, expiredSignatures: [...row.expiredSignatures] }));
      },
      findFirst: async (args: { where: Record<string, unknown> }) => {
        refuse("creatorPayout.findFirst", args);
        const row = state.payouts.find((p) => matches(p, args.where));
        return row ? { ...row, expiredSignatures: [...row.expiredSignatures] } : null;
      },
      aggregate: async (args: { where: Record<string, unknown> }) => {
        refuse("creatorPayout.aggregate", args);
        const rows = state.payouts.filter((row) => matches(row, args.where));
        return { _sum: { amountCents: rows.length ? rows.reduce((sum, row) => sum + row.amountCents, 0n) : null } };
      },
    },
    publisherProfile: earnings.publisherProfile,
    earningsTransaction: earnings.earningsTransaction,
    creditBalance: {
      upsert: async (args: { where: { orgId: string }; update: { balanceCents: { increment: bigint } } }) => {
        const orgId = args.where.orgId;
        state.credits[orgId] = (state.credits[orgId] ?? 0n) + args.update.balanceCents.increment;
        return { balanceCents: state.credits[orgId]! };
      },
      update: async (args: { where: { orgId: string }; data: { balanceCents: { increment: bigint } } }) => {
        const orgId = args.where.orgId;
        state.credits[orgId] = (state.credits[orgId] ?? 0n) + args.data.balanceCents.increment;
        return { balanceCents: state.credits[orgId]! };
      },
    },
    creditTransaction: {
      create: async (args: { data: CreditLedgerRow }) => {
        refuse("creditTransaction.create", args);
        state.creditLedger.push({ ...args.data });
        return args.data;
      },
    },
  };

  /** All or nothing, holding the turn for the whole of `fn`. */
  async function transaction<T>(fn: (tx: typeof unlocked) => Promise<T>): Promise<T> {
    await pause();
    return serial(async () => {
      const before = structuredClone(state);
      try {
        return await fn(unlocked);
      } catch (err) {
        Object.assign(state, before);
        throw err;
      }
    });
  }

  const statement =
    <A, R>(fn: (args: A) => Promise<R>) =>
    async (args: A): Promise<R> => {
      await pause();
      return serial(() => fn(args));
    };

  const db = {
    creatorPayout: {
      updateMany: statement(unlocked.creatorPayout.updateMany),
      findMany: statement(unlocked.creatorPayout.findMany),
      findFirst: statement(unlocked.creatorPayout.findFirst),
      aggregate: statement(unlocked.creatorPayout.aggregate),
    },
    publisherProfile: unlocked.publisherProfile,
    earningsTransaction: unlocked.earningsTransaction,
    creditBalance: unlocked.creditBalance,
    creditTransaction: unlocked.creditTransaction,
    $transaction: transaction,
  };

  /**
   * A payout request, as THE CONTRACT has it: ONE transaction that creates
   * the payout row and reserves the amount through the earnings ledger. A
   * second open payout for the creator is refused by the unique index, and
   * a balance that does not cover it rolls the row back. It stands in for
   * the request core (services/payoutRequests.ts) so these tests need only
   * the database rules the worker and the request share.
   */
  async function request(input: {
    orgId: string;
    payoutMethod: string;
    payoutAddress?: string | null;
    amountCents: bigint;
    requestedAt?: Date;
  }): Promise<StandInPayout> {
    return transaction(async (tx) => {
      const row = createPayout(
        standInPayout({
          publisherId: input.orgId,
          payoutMethod: input.payoutMethod,
          payoutAddress: input.payoutAddress ?? null,
          amountCents: input.amountCents,
          ...(input.requestedAt ? { requestedAt: input.requestedAt } : {}),
        }),
      );
      const reserved = await moveEarnings(tx as unknown as EarningsLedgerTx, {
        orgId: input.orgId,
        amountCents: -input.amountCents,
        type: "payout_reserved",
        referenceId: row.id,
        description: "Payout requested",
      });
      if (!reserved.moved) {
        throw Object.assign(new Error(`reservation refused: ${reserved.reason}`), { code: "RESERVATION" });
      }
      return row;
    });
  }

  return {
    state,
    db: db as unknown as PayoutExecutorDb & CancelPayoutDb,
    request,
    payout: (id: string): StandInPayout => {
      const row = state.payouts.find((p) => p.id === id);
      if (!row) throw new Error(`payoutStandIn: no payout ${id}`);
      return row;
    },
    restores: (payoutId: string): EarningsRow[] =>
      state.earningsLedger.filter((row) => row.type === "payout_restored" && row.referenceId === payoutId),
  };
}

// ---------------------------------------------------------------
// The chain
// ---------------------------------------------------------------

export const STAND_IN_MARGIN_BLOCKS = 32n;
export const STAND_IN_BLOCKHASH_LIFE = 150n;
export const STAND_IN_TOKEN_ACCOUNT_RENT = 2_039_280;

export type SendBehaviour =
  /** The node takes it. */
  | "accepted"
  /** The node refuses it before it goes anywhere (an empty wallet at preflight, say). */
  | "refused"
  /** The call throws, and the transfer reached the chain all the same. */
  | "throws_but_reached";

export interface ChainTransfer {
  signature: string;
  bytesB64: string;
  lastValidBlockHeight: bigint;
  /** Whether it ever reached the chain (a refused send did not). */
  reached: boolean;
  landed: "ok" | "failed" | null;
}

function tokenAccountData(mint: PublicKey, owner: PublicKey, amount: bigint): Buffer {
  const data = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode(
    {
      mint,
      owner,
      amount,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: 1,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  );
  return data;
}

export function chainStandIn(input: { payer: PublicKey; usdcMint: PublicKey; pause?: () => Promise<void> }) {
  const chain = {
    height: 1_000n,
    /** The paying wallet. */
    payerLamports: 10_000_000_000n,
    payerUsdcBaseUnits: 1_000_000_000_000n,
    /** Whether a receiving wallet already has a USDC account. */
    recipientHasUsdcAccount: true,
    send: "accepted" as SendBehaviour,
    /** Reads of the chain fail while true. */
    readsFail: false,
    /** readFate answers "unknown" while true. */
    fateUnknown: false,
    transfers: new Map<string, ChainTransfer>(),
    /** Every call to sendRawTransaction: the bytes handed over, in order. */
    broadcasts: [] as Array<{ signature: string; bytesB64: string }>,
    blockhashesIssued: 0,
  };
  const lastValidOf = new Map<string, bigint>();
  const pause = async () => {
    await input.pause?.();
  };
  const payerAta = getAssociatedTokenAddressSync(input.usdcMint, input.payer);

  const connection = {
    getLatestBlockhash: async () => {
      await pause();
      if (chain.readsFail) throw new Error("stand-in: getLatestBlockhash failed");
      chain.blockhashesIssued += 1;
      const bytes = Buffer.alloc(32);
      bytes.writeUInt32LE(chain.blockhashesIssued, 0);
      bytes.writeUInt8(7, 31);
      const blockhash = bs58.encode(bytes);
      const lastValidBlockHeight = chain.height + STAND_IN_BLOCKHASH_LIFE;
      lastValidOf.set(blockhash, lastValidBlockHeight);
      return { blockhash, lastValidBlockHeight: Number(lastValidBlockHeight) };
    },
    sendRawTransaction: async (raw: Buffer | Uint8Array | number[]) => {
      await pause();
      const bytes = Buffer.from(raw as Uint8Array);
      const tx = Transaction.from(bytes);
      if (!tx.signature || !tx.recentBlockhash) throw new Error("stand-in: an unsigned transfer was sent");
      const signature = bs58.encode(tx.signature);
      const bytesB64 = bytes.toString("base64");
      chain.broadcasts.push({ signature, bytesB64 });
      const lastValidBlockHeight = lastValidOf.get(tx.recentBlockhash);
      if (lastValidBlockHeight === undefined) throw new Error("stand-in: Blockhash not found");
      const known = chain.transfers.get(signature);
      const transfer: ChainTransfer = known ?? {
        signature,
        bytesB64,
        lastValidBlockHeight,
        reached: false,
        landed: null,
      };
      chain.transfers.set(signature, transfer);
      if (chain.send === "refused") {
        throw new Error("stand-in: Transaction simulation failed: Attempt to debit an account but found no record of a prior credit.");
      }
      if (chain.height <= lastValidBlockHeight) transfer.reached = true;
      if (chain.send === "throws_but_reached") throw new Error("stand-in: socket hang up");
      return signature;
    },
    getMultipleAccountsInfo: async (keys: PublicKey[]) => {
      await pause();
      if (chain.readsFail) throw new Error("stand-in: getMultipleAccountsInfo failed");
      return keys.map((key): AccountInfo<Buffer> | null => {
        if (key.equals(input.payer)) {
          return {
            lamports: Number(chain.payerLamports),
            owner: SystemProgram.programId,
            data: Buffer.alloc(0),
            executable: false,
          };
        }
        if (key.equals(payerAta)) {
          return {
            lamports: STAND_IN_TOKEN_ACCOUNT_RENT,
            owner: TOKEN_PROGRAM_ID,
            data: tokenAccountData(input.usdcMint, input.payer, chain.payerUsdcBaseUnits),
            executable: false,
          };
        }
        // Any other key asked for is a receiving wallet's USDC account.
        return chain.recipientHasUsdcAccount
          ? {
              lamports: STAND_IN_TOKEN_ACCOUNT_RENT,
              owner: TOKEN_PROGRAM_ID,
              data: tokenAccountData(input.usdcMint, key, 0n),
              executable: false,
            }
          : null;
      });
    },
    getMinimumBalanceForRentExemption: async () => {
      await pause();
      if (chain.readsFail) throw new Error("stand-in: getMinimumBalanceForRentExemption failed");
      return STAND_IN_TOKEN_ACCOUNT_RENT;
    },
  };

  /** What the chain says became of a signature, by the rules of services/signatureFate.ts. */
  async function readFate(fateInput: SignatureFateInput): Promise<SignatureFateAnswer> {
    await pause();
    const detail = {
      finalizedSlot: chain.height,
      finalizedBlockHeight: chain.height,
      lastValidBlockHeight: fateInput.lastValidBlockHeight === null ? null : BigInt(fateInput.lastValidBlockHeight),
      marginBlocks: Number(STAND_IN_MARGIN_BLOCKS),
      statusContextSlot: chain.height,
      confirmationStatus: null,
      landedSlot: null,
      blockhashValid: null,
      blockhashContextSlot: null,
    };
    const answer = (
      fate: SignatureFateAnswer["fate"],
      reason: SignatureFateAnswer["reason"],
      error?: string,
    ): SignatureFateAnswer => ({
      fate,
      reason,
      signature: fateInput.signature,
      ...(error === undefined ? {} : { error }),
      detail,
    });
    if (chain.fateUnknown || chain.readsFail) return answer("unknown", "status_read_failed", "stand-in: 503 from the node");
    const transfer = chain.transfers.get(fateInput.signature);
    if (transfer?.landed === "ok") return answer("landed_ok", "status_ok");
    if (transfer?.landed === "failed") {
      return answer("landed_failed", "status_err", '{"InstructionError":[1,{"Custom":1}]}');
    }
    if (detail.lastValidBlockHeight === null) return answer("in_flight", "absent_no_expiry_proof");
    return chain.height > detail.lastValidBlockHeight + STAND_IN_MARGIN_BLOCKS
      ? answer("dead", "absent_expired_by_height")
      : answer("in_flight", "absent_within_window");
  }

  /** Whether a transfer could still pay: it landed, or it reached the chain and can still land. */
  function couldPay(signature: string): boolean {
    const transfer = chain.transfers.get(signature);
    if (!transfer) return false;
    if (transfer.landed === "ok") return true;
    if (transfer.landed === "failed") return false;
    return transfer.reached && chain.height <= transfer.lastValidBlockHeight;
  }

  /** The chain includes a transfer. Only one that reached it and has not expired can land. */
  function land(signature: string, how: "ok" | "failed" = "ok"): boolean {
    const transfer = chain.transfers.get(signature);
    if (!transfer || transfer.landed !== null || !transfer.reached) return false;
    if (chain.height > transfer.lastValidBlockHeight) return false;
    transfer.landed = how;
    return true;
  }

  return {
    chain,
    connection: connection as unknown as PayoutExecutorConnection,
    readFate,
    couldPay,
    land,
    advance: (blocks: bigint | number) => {
      chain.height += BigInt(blocks);
    },
    landedOk: (): string[] =>
      [...chain.transfers.values()].filter((t) => t.landed === "ok").map((t) => t.signature),
    /** Transfers that reached the chain, have not landed and still can. */
    landable: (): string[] =>
      [...chain.transfers.values()]
        .filter((t) => t.reached && t.landed === null && chain.height <= t.lastValidBlockHeight)
        .map((t) => t.signature),
  };
}

/** A small seeded generator, so a run that fails can be run again. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

// ---------------------------------------------------------------
// The worker over both
// ---------------------------------------------------------------

/** A price answer as services/buildSolPriceDeps.ts getSolQuote gives one. */
export function standInSolPrice(usdPerSol: number): SolPriceResult {
  return {
    ok: true,
    quote: {
      source: "static",
      midMicroUsdPerSol: BigInt(usdPerSol) * 1_000_000n,
      confMicroUsdPerSol: 0n,
      publishTime: 1_791_633_600,
      ageSeconds: 0,
      account: null,
    },
  };
}

export interface StandInWorkerOptions {
  db: PayoutExecutorDb;
  chain: ReturnType<typeof chainStandIn>;
  /** The paying wallet, or none. */
  payoutWallet?: Keypair;
  usdcMint: PublicKey;
  now?: () => Date;
  maxAttempts?: number;
  platformMaxPerDayUsd?: number;
  /** The price answer, read on every call. */
  price?: () => SolPriceResult;
  /** The cluster check's answer, read on every call. */
  cluster?: () => { ok: true } | { ok: false; reason: string };
}

/** The real binding (services/buildPayoutExecutorTickDeps.ts) over the stand-ins. */
export function standInWorker(opts: StandInWorkerOptions) {
  const events: PayoutTickEvent[] = [];
  const deps = buildPayoutExecutorTickDeps({
    prisma: opts.db,
    connection: opts.chain.connection,
    payoutWallet: opts.payoutWallet,
    usdcMint: opts.usdcMint,
    maxAttempts: opts.maxAttempts ?? 3,
    platformMaxPerDayUsd: opts.platformMaxPerDayUsd ?? 5_000,
    checkCluster: async () => (opts.cluster ? opts.cluster() : { ok: true }),
    getSolQuote: async () => (opts.price ? opts.price() : standInSolPrice(200)),
    solQuoteMarginBps: () => 0,
    readSignatureFate: opts.chain.readFate,
    now: opts.now ?? (() => new Date("2026-10-10T12:00:00.000Z")),
    log: (event) => events.push(event),
  });
  return {
    deps,
    events,
    run: (limit = 10) => runPayoutExecutorTick({ limit }, deps),
  };
}
