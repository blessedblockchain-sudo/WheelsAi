// Stand-ins for the x402 tests: a database in memory that behaves like
// Postgres where the code under test leans on it, a chain that says what
// the test tells it to, and payers who sign real transactions offline.
// Nothing here opens a socket.

import {
  createTransferCheckedInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";

import type { EarningsRow } from "./earningsStandIn.js";
import type { SignatureFate, SignatureConfirmationLevel } from "../services/signatureFate.js";
import { decodeX402Payment } from "../services/x402Decode.js";
import type {
  X402DoorWorkerEvent,
  X402NewPayment,
  X402PaymentEvent,
  X402PaymentsDeps,
  X402Settings,
  X402SettlementDeps,
} from "../services/x402Payments.js";
import { microUsdToUsd, x402PriceFor } from "../services/x402Price.js";
import { readX402Quote, signX402Quote } from "../services/x402Quote.js";
import { returnX402Payment, type X402RefundDb, type X402RefundTx } from "../services/x402Refund.js";
import type { X402SaleTx } from "../services/x402Sale.js";

// ============================================
// The database
// ============================================

export interface PaymentRow {
  id: string;
  orgId: string;
  deploymentId: string | null;
  /** Set on a payment at a listing's door; null on a deployment's. */
  listingId: string | null;
  /** The door payment's one key, unique; null on a deployment's. */
  messageHash: string | null;
  requestId: string;
  network: string;
  asset: string;
  amountRaw: string;
  amountUsd: number;
  payerAddress: string;
  payeeAddress: string;
  txSignature: string | null;
  status: string;
  verifiedAt: Date | null;
  settledAt: Date | null;
  failureReason: string | null;
  signedTxB64: string | null;
  recentBlockhash: string | null;
  submittedAt: Date | null;
  amountReceivedRaw: string | null;
  amountMicroUsd: bigint | null;
  solMicroUsdPerSol: bigint | null;
  servedAt: Date | null;
  refundedAt: Date | null;
  refundMicroUsd: bigint | null;
  createdAt: Date;
}

export interface BalanceRow {
  balanceCents: bigint;
  x402RefundCarryMicroUsd: bigint;
}

export interface LedgerRow {
  orgId: string;
  amountCents: bigint;
  type: string;
  description: string;
  referenceId: string;
  balanceAfter: bigint;
}

/** A marketplace_revenue row a door sale writes. */
export type RevenueRow = Parameters<X402SaleTx["marketplaceRevenue"]["create"]>[0]["data"] & { id: string };

/** The listing columns a door sale touches. */
export interface SaleListingRow {
  agentId: string | null;
  useModelCostMicros: bigint;
  totalRequests: bigint;
}

/** A creator's publisher profile. */
export interface ProfileRow {
  pendingPayoutCents: bigint;
  totalRevenueCents: bigint;
}

/** The statuses the one-open index covers, on a payment with a listing. */
const OPEN_DOOR_STATUSES = new Set(["held", "submitted"]);

function uniqueViolation(target: string | string[]): Error {
  return Object.assign(new Error(`Unique constraint failed on the fields: (\`${String(target)}\`)`), {
    code: "P2002",
    meta: { target },
  });
}

interface Held {
  owner: object;
  released: Promise<void>;
  release: () => void;
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Rows in memory with the two things of Postgres the money code leans on:
 *   - a transaction that throws leaves nothing behind;
 *   - a row a transaction has written is locked until that transaction
 *     ends, and a second writer waits, then judges its `where` against the
 *     row as the first one left it.
 */
export class FakeX402Db implements X402RefundDb {
  payments = new Map<string, PaymentRow>();
  balances = new Map<string, BalanceRow>();
  ledger: LedgerRow[] = [];
  // A door sale's tables (services/x402Sale.ts).
  revenues: RevenueRow[] = [];
  listings = new Map<string, SaleListingRow>();
  profiles = new Map<string, ProfileRow>();
  earnings: EarningsRow[] = [];
  /** Every write, in order: "what was touched". */
  writes: string[] = [];
  private held = new Map<string, Held>();
  private nextId = 1;

  private async lock(owner: object, key: string, keys: string[]): Promise<void> {
    for (;;) {
      const current = this.held.get(key);
      if (!current) break;
      if (current.owner === owner) return;
      await current.released;
    }
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.held.set(key, { owner, released, release });
    keys.push(key);
  }

  async $transaction<T>(fn: (tx: X402RefundTx) => Promise<T>): Promise<T> {
    const owner = {};
    const keys: string[] = [];
    const undo: Array<() => void> = [];
    const db = this;

    const tx: X402RefundTx = {
      x402Payment: {
        findUnique: async ({ where }) => {
          await tick();
          const row = db.payments.get(where.id);
          return row
            ? {
                id: row.id,
                orgId: row.orgId,
                listingId: row.listingId,
                asset: row.asset,
                amountReceivedRaw: row.amountReceivedRaw,
                solMicroUsdPerSol: row.solMicroUsdPerSol,
              }
            : null;
        },
        updateMany: async ({ where, data }) => {
          await tick();
          await db.lock(owner, `payment:${where.id}`, keys);
          const row = db.payments.get(where.id);
          if (
            !row ||
            !(where.status.in as string[]).includes(row.status) ||
            row.servedAt !== null ||
            row.refundedAt !== null
          ) {
            return { count: 0 };
          }
          const before = { ...row };
          undo.push(() => db.payments.set(row.id, before));
          db.payments.set(row.id, { ...row, ...data });
          db.writes.push(`payment:${row.id}:${data.status}`);
          return { count: 1 };
        },
      },
      creditBalance: {
        upsert: async ({ where, create, update }) => {
          await tick();
          await db.lock(owner, `balance:${where.orgId}`, keys);
          const before = db.balances.get(where.orgId);
          undo.push(() => {
            if (before) db.balances.set(where.orgId, before);
            else db.balances.delete(where.orgId);
          });
          const after: BalanceRow = before
            ? {
                ...before,
                x402RefundCarryMicroUsd:
                  before.x402RefundCarryMicroUsd + update.x402RefundCarryMicroUsd.increment,
              }
            : {
                balanceCents: create.balanceCents,
                x402RefundCarryMicroUsd: create.x402RefundCarryMicroUsd,
              };
          db.balances.set(where.orgId, after);
          db.writes.push(`carry:${where.orgId}`);
          return { ...after };
        },
        update: async ({ where, data }) => {
          await tick();
          await db.lock(owner, `balance:${where.orgId}`, keys);
          const before = db.balances.get(where.orgId);
          if (!before) throw new Error("no balance row");
          undo.push(() => db.balances.set(where.orgId, before));
          const after: BalanceRow = {
            balanceCents: before.balanceCents + data.balanceCents.increment,
            x402RefundCarryMicroUsd:
              before.x402RefundCarryMicroUsd - data.x402RefundCarryMicroUsd.decrement,
          };
          db.balances.set(where.orgId, after);
          db.writes.push(`balance:${where.orgId}`);
          return { ...after };
        },
      },
      creditTransaction: {
        create: async ({ data }) => {
          await tick();
          const row = { ...data };
          db.ledger.push(row);
          undo.push(() => {
            db.ledger.splice(db.ledger.indexOf(row), 1);
          });
          db.writes.push(`ledger:${data.orgId}`);
          return data;
        },
      },
    };

    const end = () => {
      for (const key of keys) {
        const lock = this.held.get(key);
        this.held.delete(key);
        lock?.release();
      }
    };
    try {
      const result = await fn(tx);
      end();
      return result;
    } catch (err) {
      for (const step of undo.reverse()) step();
      end();
      throw err;
    }
  }

  // ---- what the bindings do, outside a transaction ----

  insert(data: X402NewPayment, createdAt: Date): PaymentRow {
    for (const row of this.payments.values()) {
      // A unique index lets any number of NULLs through.
      if (data.txSignature !== null && row.txSignature === data.txSignature) {
        throw Object.assign(new Error("Unique constraint failed on the fields: (`tx_signature`)"), {
          code: "P2002",
        });
      }
    }
    const listingId = data.listingId ?? null;
    const messageHash = data.messageHash ?? null;
    this.holdDoorUniques({ id: null, listingId, messageHash, payerAddress: data.payerAddress, status: data.status });
    const row: PaymentRow = {
      ...data,
      listingId,
      messageHash,
      id: `pay_${this.nextId++}`,
      settledAt: null,
      failureReason: null,
      servedAt: null,
      refundedAt: null,
      refundMicroUsd: null,
      createdAt,
    };
    this.payments.set(row.id, row);
    this.writes.push(`payment:${row.id}:${row.status}`);
    return row;
  }

  /** A compare-and-set on a payment: waits for a transaction holding the row. */
  async cas(
    id: string,
    expect: (row: PaymentRow) => boolean,
    change: Partial<PaymentRow>,
  ): Promise<boolean> {
    await tick();
    const owner = {};
    const keys: string[] = [];
    await this.lock(owner, `payment:${id}`, keys);
    try {
      const row = this.payments.get(id);
      if (!row || !expect(row)) return false;
      const next = { ...row, ...change };
      if (change.txSignature !== undefined && change.txSignature !== null) {
        for (const other of this.payments.values()) {
          if (other.id !== id && other.txSignature === change.txSignature) throw uniqueViolation(["tx_signature"]);
        }
      }
      this.holdDoorUniques(next);
      this.payments.set(id, next);
      this.writes.push(`payment:${id}:${change.status ?? "served"}`);
      return true;
    } finally {
      const lock = this.held.get(`payment:${id}`);
      this.held.delete(`payment:${id}`);
      lock?.release();
    }
  }

  /**
   * The door's two uniques, as Postgres holds them: one row per message
   * hash, and one held or submitted door payment per paying wallet (the
   * partial index). A row without a listing meets neither.
   */
  private holdDoorUniques(row: {
    id: string | null;
    listingId: string | null;
    messageHash: string | null;
    payerAddress: string;
    status: string;
  }): void {
    for (const other of this.payments.values()) {
      if (other.id === row.id) continue;
      if (row.messageHash !== null && other.messageHash === row.messageHash) {
        throw uniqueViolation(["message_hash"]);
      }
      if (
        row.listingId !== null &&
        OPEN_DOOR_STATUSES.has(row.status) &&
        other.listingId !== null &&
        OPEN_DOOR_STATUSES.has(other.status) &&
        other.payerAddress === row.payerAddress
      ) {
        throw uniqueViolation("x402_payments_one_open_door_payment_per_wallet");
      }
    }
  }

  /**
   * A door sale's transaction (services/x402Sale.ts): the payment, the
   * revenue row (unique per payment), the listing's counters, and the
   * earnings ledger. A throw leaves nothing behind. It has no credit
   * balance and no credit ledger: a sale from a wallet never reaches either.
   */
  async $saleTransaction<T>(fn: (tx: X402SaleTx) => Promise<T>): Promise<T> {
    const owner = {};
    const keys: string[] = [];
    const undo: Array<() => void> = [];
    const db = this;

    const tx: X402SaleTx = {
      x402Payment: {
        updateMany: async ({ where, data }) => {
          await tick();
          await db.lock(owner, `payment:${where.id}`, keys);
          const row = db.payments.get(where.id);
          if (
            !row ||
            row.status !== where.status ||
            row.listingId !== where.listingId ||
            row.orgId !== where.orgId ||
            row.payerAddress !== where.payerAddress ||
            row.amountRaw !== where.amountRaw ||
            row.servedAt !== null
          ) {
            return { count: 0 };
          }
          const before = { ...row };
          undo.push(() => db.payments.set(row.id, before));
          db.payments.set(row.id, { ...row, ...data });
          db.writes.push(`payment:${row.id}:${data.status}`);
          return { count: 1 };
        },
      },
      marketplaceRevenue: {
        create: async ({ data }) => {
          await tick();
          if (db.revenues.some((r) => r.x402PaymentId === data.x402PaymentId)) {
            throw uniqueViolation(["x402_payment_id"]);
          }
          const row: RevenueRow = { ...data, id: `rev_${db.nextId++}` };
          db.revenues.push(row);
          undo.push(() => {
            db.revenues.splice(db.revenues.indexOf(row), 1);
          });
          db.writes.push(`revenue:${row.id}`);
          return { id: row.id };
        },
        update: async ({ where, data }) => {
          await tick();
          const row = db.revenues.find((r) => r.id === where.id);
          if (!row) throw new Error("no revenue row");
          const before = { ...row };
          undo.push(() => Object.assign(row, before));
          row.platformFeeCents += data.platformFeeCents.increment;
          row.creatorAmountCents -= data.creatorAmountCents.decrement;
          db.writes.push(`revenue:${row.id}:model_cost`);
          return row;
        },
      },
      agentListing: {
        updateMany: async ({ where, data }) => {
          await tick();
          await db.lock(owner, `listing:${where.id}`, keys);
          const row = db.listings.get(where.id);
          if (!row) return { count: 0 };
          const before = { ...row };
          undo.push(() => db.listings.set(where.id, before));
          if ("useModelCostMicros" in data) {
            db.listings.set(where.id, { ...row, useModelCostMicros: row.useModelCostMicros + data.useModelCostMicros.increment });
          } else {
            db.listings.set(where.id, { ...row, totalRequests: row.totalRequests + data.totalRequests.increment });
          }
          db.writes.push(`listing:${where.id}`);
          return { count: 1 };
        },
        // Answers whichever columns are asked for: the split reads agentId.
        findUnique: (async ({ where, select }: { where: { id: string }; select: Record<string, true> }) => {
          await tick();
          const row = db.listings.get(where.id);
          if (!row) return null;
          return Object.fromEntries(Object.keys(select).map((key) => [key, row[key as keyof SaleListingRow]]));
        }) as X402SaleTx["agentListing"]["findUnique"],
      },
      publisherProfile: {
        updateMany: async ({ where, data }) => {
          await tick();
          await db.lock(owner, `profile:${where.orgId}`, keys);
          const row = db.profiles.get(where.orgId);
          if (!row) return { count: 0 };
          if (where.pendingPayoutCents && row.pendingPayoutCents < where.pendingPayoutCents.gte) return { count: 0 };
          const before = { ...row };
          undo.push(() => db.profiles.set(where.orgId, before));
          const change =
            "increment" in data.pendingPayoutCents ? data.pendingPayoutCents.increment : -data.pendingPayoutCents.decrement;
          db.profiles.set(where.orgId, {
            pendingPayoutCents: row.pendingPayoutCents + change,
            totalRevenueCents: row.totalRevenueCents + (data.totalRevenueCents?.increment ?? 0n),
          });
          db.writes.push(`profile:${where.orgId}`);
          return { count: 1 };
        },
        findUnique: async ({ where }) => {
          await tick();
          const row = db.profiles.get(where.orgId);
          return row ? { pendingPayoutCents: row.pendingPayoutCents } : null;
        },
      },
      earningsTransaction: {
        create: async ({ data }) => {
          await tick();
          const row = { ...data };
          db.earnings.push(row);
          undo.push(() => {
            db.earnings.splice(db.earnings.indexOf(row), 1);
          });
          db.writes.push(`earnings:${data.orgId}:${data.type}`);
          return row;
        },
      },
    };

    const end = () => {
      for (const key of keys) {
        const lock = this.held.get(key);
        this.held.delete(key);
        lock?.release();
      }
    };
    try {
      const result = await fn(tx);
      end();
      return result;
    } catch (err) {
      for (const step of undo.reverse()) step();
      end();
      throw err;
    }
  }

  only(): PaymentRow {
    const rows = [...this.payments.values()];
    if (rows.length !== 1) throw new Error(`expected one payment row, found ${rows.length}`);
    return rows[0]!;
  }
}

// ============================================
// The world a payment lives in
// ============================================

export const TREASURY = Keypair.generate().publicKey.toBase58();
export const USDC_MINT_TEST = Keypair.generate().publicKey.toBase58();
export const OTHER_MINT_TEST = Keypair.generate().publicKey.toBase58();
export const TREASURY_USDC_ACCOUNT = getAssociatedTokenAddressSync(
  new PublicKey(USDC_MINT_TEST),
  new PublicKey(TREASURY),
  true,
).toBase58();
export const QUOTE_SECRET = "x402-test-secret-0123456789abcdef";

/** What a node would say. It must never reach a payer. */
export const NODE_TEXT = "RPC-NODE-SAID: Transaction simulation failed: custom program error 0x1";

export interface World {
  db: FakeX402Db;
  deps: X402PaymentsDeps;
  settlementDeps: X402SettlementDeps;
  settings: X402Settings;
  events: X402PaymentEvent[];
  /** Everything that happened, in order: writes, sends, reads of the chain. */
  trail: string[];
  broadcasts: string[];
  fateReads: number;
  clusterChecks: number;
  decodes: number;
  /** Milliseconds; `sleep` moves it. */
  nowMs: number;
  /** null: there is no SOL price. */
  solRate: bigint | null;
  clusterOk: boolean;
  /** What the chain says about a signature, read by read; the last answer repeats. */
  fates: Array<SignatureFate | { fate: SignatureFate; confirmationStatus: SignatureConfirmationLevel }>;
  broadcastThrows: boolean;
  /** Called between the row being written and the next step, to stage a race. */
  onFateRead: (() => Promise<void>) | null;
  /** What the worker told the operator about door payments. */
  doorWorkerEvents: X402DoorWorkerEvent[];
  /** Times the worker returned a payment as credits. */
  refunds: number;
}

export function makeWorld(over: Partial<X402Settings> = {}): World {
  const db = new FakeX402Db();
  const settings: X402Settings = {
    network: "solana:devnet",
    defaultAsset: "USDC",
    payTo: TREASURY,
    usdcMint: USDC_MINT_TEST,
    payToTokenAccount: TREASURY_USDC_ACCOUNT,
    quoteTtlSeconds: 120,
    confirmWaitMs: 30_000,
    pollIntervalMs: 1_000,
    submitTransactions: true,
    ...over,
  };
  const world: World = {
    db,
    settings,
    events: [],
    trail: [],
    broadcasts: [],
    fateReads: 0,
    clusterChecks: 0,
    decodes: 0,
    nowMs: Date.UTC(2026, 9, 11, 12, 0, 0),
    solRate: 150_000_000n,
    clusterOk: true,
    fates: ["landed_ok"],
    broadcastThrows: false,
    onFateRead: null,
    doorWorkerEvents: [],
    refunds: 0,
    deps: undefined as unknown as X402PaymentsDeps,
    settlementDeps: undefined as unknown as X402SettlementDeps,
  };
  const now = () => new Date(world.nowMs);

  const readFate = async () => {
    world.fateReads += 1;
    world.trail.push("fate");
    if (world.onFateRead) await world.onFateRead();
    const next = world.fates.length > 1 ? world.fates.shift()! : world.fates[0]!;
    return typeof next === "string"
      ? { fate: next, confirmationStatus: next.startsWith("landed") ? ("confirmed" as const) : null }
      : next;
  };
  const refund: X402PaymentsDeps["refund"] = (input) => {
    world.refunds += 1;
    return returnX402Payment(db, input);
  };

  world.deps = {
    settings: () => world.settings,
    now,
    sleep: async (ms) => {
      world.nowMs += ms;
    },
    priceFor: x402PriceFor,
    microUsdToUsd,
    solRate: async () => world.solRate,
    signQuote: (payload) =>
      signX402Quote(
        { ...payload, asset: "SOL" },
        { secret: QUOTE_SECRET, ttlSeconds: world.settings.quoteTtlSeconds, now },
      ),
    readQuote: (token, scope) => {
      const read = readX402Quote(token, { secret: QUOTE_SECRET, ...scope, now });
      return read.ok ? read.quote.solMicroUsdPerSol : null;
    },
    decode: (signedTxBase64, want) => {
      world.decodes += 1;
      return decodeX402Payment(signedTxBase64, want);
    },
    clusterOk: async () => {
      world.clusterChecks += 1;
      return world.clusterOk;
    },
    broadcast: async (signedTxB64) => {
      world.broadcasts.push(signedTxB64);
      world.trail.push("broadcast");
      if (world.broadcastThrows) throw new Error(NODE_TEXT);
    },
    readFate,
    findPaymentBySignature: async (signature) => {
      for (const row of db.payments.values()) {
        if (row.txSignature === signature) return { id: row.id };
      }
      return null;
    },
    insertPayment: async (data) => {
      try {
        const row = db.insert(data, now());
        world.trail.push(`insert:${row.status}`);
        return { ok: true, id: row.id };
      } catch (err) {
        if ((err as { code?: string }).code !== "P2002") throw err;
        return { ok: false, reason: "duplicate_signature", id: null };
      }
    },
    markVerified: (id, at) =>
      db.cas(id, (row) => row.status === "submitted", { status: "verified", verifiedAt: at }),
    markFailedOnChain: (id) =>
      db.cas(id, (row) => row.status === "submitted", {
        status: "failed",
        failureReason: "The payment failed on the chain. Nothing was taken.",
      }),
    markServed: (id, at) =>
      db.cas(
        id,
        (row) => row.status === "verified" && row.servedAt === null && row.refundedAt === null,
        { servedAt: at },
      ),
    refund,
    log: (event) => {
      world.events.push(event);
    },
  };

  world.settlementDeps = {
    get submitTransactions() {
      return world.settings.submitTransactions;
    },
    get confirmWaitMs() {
      return world.settings.confirmWaitMs;
    },
    now,
    clusterOk: async () => {
      world.clusterChecks += 1;
      return world.clusterOk;
    },
    readFate,
    markSettled: (id, at) =>
      db.cas(
        id,
        (row) => row.status === "verified" && row.servedAt !== null && row.refundedAt === null,
        { status: "settled", settledAt: at },
      ),
    markFailed: (id, why) =>
      db.cas(id, (row) => row.status === "submitted", { status: "failed", failureReason: why }),
    refund,
    markHeldFailed: (id, reason) =>
      db.cas(id, (row) => row.status === "held" && row.listingId !== null, { status: "failed", failureReason: reason }),
    markUnserved: (id) =>
      db.cas(id, (row) => row.status === "submitted" && row.listingId !== null, { status: "unserved" }),
    logDoor: (event) => {
      world.doorWorkerEvents.push(event);
    },
  };
  return world;
}

// ============================================
// Payers
// ============================================

function signed(payer: Keypair, build: (tx: Transaction) => void): string {
  const tx = new Transaction();
  tx.feePayer = payer.publicKey;
  // Any 32 bytes read as a blockhash; nothing here asks a chain for one.
  tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
  build(tx);
  tx.sign(payer);
  return tx.serialize().toString("base64");
}

/** A wallet's checked USDC transfer, with the compute-budget lines wallets add. */
export function usdcPayment(args: {
  amount: bigint;
  payer?: Keypair;
  mint?: string;
  /** The token account paid. Defaults to the treasury's USDC account. */
  to?: string;
  checked?: boolean;
}): string {
  const payer = args.payer ?? Keypair.generate();
  const mint = new PublicKey(args.mint ?? USDC_MINT_TEST);
  const to = new PublicKey(args.to ?? TREASURY_USDC_ACCOUNT);
  const source = getAssociatedTokenAddressSync(mint, payer.publicKey, true);
  return signed(payer, (tx) => {
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
    tx.add(
      args.checked === false
        ? createTransferInstruction(source, to, payer.publicKey, args.amount)
        : createTransferCheckedInstruction(source, mint, to, payer.publicKey, args.amount, 6),
    );
  });
}

export function solPayment(args: { lamports: bigint; payer?: Keypair; to?: string }): string {
  const payer = args.payer ?? Keypair.generate();
  return signed(payer, (tx) => {
    tx.add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: new PublicKey(args.to ?? TREASURY),
        lamports: args.lamports,
      }),
    );
  });
}
