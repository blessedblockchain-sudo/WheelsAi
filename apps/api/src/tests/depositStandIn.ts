/**
 * Stand-ins for the deposit scan's tests (payments pass, batch 5): the
 * four tables it touches, in memory, and a node that answers from maps.
 * No database, no network.
 *
 * The database keeps the three things the money rules stand on:
 *   - `where` is honoured, so a compare-and-set can be lost;
 *   - onchain_receipts refuses a second row for (network, txSignature,
 *     asset) and for a topupId, and wallet_topups a second txSignature,
 *     with Prisma's P2002;
 *   - a transaction that throws rolls EVERYTHING back.
 */

import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";

import type { DepositScanConnection, DepositScanDb } from "../services/buildDepositScanTickDeps.js";
import { MEMO_PROGRAM_IDS, type RpcTransactionLike } from "../services/depositScan.js";

export const DEVNET = "solana:devnet";
export const USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
export const OTHER_MINT = new PublicKey("nosXBVoaCTtYdLvKY6Csb4AC8JCdQKKAaWYtx2ZMoo7");
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const TOKEN_PROGRAM = TOKEN_PROGRAM_ID.toBase58();

export const ORG_1 = "11111111-1111-4111-8111-111111111111";
export const ORG_2 = "22222222-2222-4222-8222-222222222222";
export const ORG_3 = "33333333-3333-4333-8333-333333333333";
export const TOPUP_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const TOPUP_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** A fixed address for a name: the same name is always the same key. */
export function addressOf(name: string): string {
  const seed = new Uint8Array(32);
  const bytes = Buffer.from(name, "utf8");
  for (let i = 0; i < 32; i += 1) seed[i] = bytes[i % bytes.length] ?? 0;
  seed[31] = bytes.length;
  return Keypair.fromSeed(seed).publicKey.toBase58();
}

/** The address "this server derives" for an organization, in tests. */
export function depositAddressOf(orgId: string): string {
  return addressOf(`deposit:${orgId}`);
}

export function usdcAccountOf(address: string): string {
  return getAssociatedTokenAddressSync(USDC_MINT, new PublicKey(address)).toBase58();
}

// ============================================
// The database
// ============================================

type Row = Record<string, any>;

function same(have: unknown, want: unknown): boolean {
  if (have instanceof Date && want instanceof Date) return have.getTime() === want.getTime();
  return have === want;
}

export function matches(row: Row, where: Row): boolean {
  for (const [key, want] of Object.entries(where)) {
    const have = row[key] ?? null;
    if (want !== null && typeof want === "object" && !(want instanceof Date)) {
      if ("in" in want && !want.in.some((v: unknown) => same(have, v))) return false;
      if ("not" in want && same(have, want.not)) return false;
    } else if (!same(have, want ?? null)) {
      return false;
    }
  }
  return true;
}

function unique(): Error {
  return Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
}

export function topupRow(over: Row = {}): Row {
  return {
    id: TOPUP_1,
    orgId: ORG_1,
    asset: "USDC",
    network: DEVNET,
    status: "submitted",
    amountUsdCents: 5_000n,
    bonusCents: 500n,
    amountRaw: "50000000",
    payerAddress: addressOf("payer"),
    depositAddress: depositAddressOf(ORG_1),
    txSignature: null,
    failureCode: null,
    creditedAt: null,
    expiresAt: new Date("2026-10-11T09:00:00.000Z"),
    quotePriceMicroUsd: null,
    quotePublishTime: null,
    quoteSource: null,
    ...over,
  };
}

export function addressRow(orgId: string, over: Row = {}): Row {
  return {
    orgId,
    address: depositAddressOf(orgId),
    network: DEVNET,
    usdcAccountOpenedAt: null,
    usdcAccountOpenedBy: null,
    usdcAccountRequestedAt: null,
    lastSolSignature: null,
    lastUsdcSignature: null,
    lastSeenLamports: 0n,
    lastSeenUsdcRaw: 0n,
    scanRequestedAt: null,
    lastScannedAt: null,
    ...over,
  };
}

export function makeDb(
  init: {
    topups?: Row[];
    receipts?: Row[];
    addresses?: Row[];
    balances?: Record<string, bigint>;
    /** chain_transfers rows: the sweeps this server made (batch 6). */
    chainTransfers?: Row[];
  } = {},
) {
  const state = {
    topups: init.topups ?? [],
    receipts: init.receipts ?? [],
    addresses: init.addresses ?? [],
    chainTransfers: init.chainTransfers ?? [],
    balances: { ...(init.balances ?? {}) } as Record<string, bigint>,
    ledger: [] as Row[],
  };
  const calls: Array<{ op: string; args: any }> = [];
  let receiptSeq = 0;
  let inTransaction = false;

  const client = {
    walletTopUp: {
      findFirst: async (args: { where: Row }) => {
        calls.push({ op: "walletTopUp.findFirst", args });
        const row = state.topups.find((r) => matches(r, args.where));
        return row ? { ...row } : null;
      },
      findUnique: async (args: { where: { id: string } }) => {
        const row = state.topups.find((r) => r.id === args.where.id);
        return row ? { ...row } : null;
      },
      updateMany: async (args: { where: Row; data: Row }) => {
        calls.push({ op: "walletTopUp.updateMany", args });
        const hit = state.topups.filter((r) => matches(r, args.where));
        const signature = args.data.txSignature;
        if (
          signature != null &&
          hit.length > 0 &&
          state.topups.some((r) => r.txSignature === signature && !hit.includes(r))
        ) {
          throw unique();
        }
        for (const row of hit) Object.assign(row, args.data);
        return { count: hit.length };
      },
    },
    onchainReceipt: {
      create: async (args: { data: Row }) => {
        calls.push({ op: "onchainReceipt.create", args });
        const d = args.data;
        if (
          state.receipts.some(
            (r) =>
              (r.network === d.network && r.txSignature === d.txSignature && r.asset === d.asset) ||
              (d.topupId != null && r.topupId === d.topupId),
          )
        ) {
          throw unique();
        }
        receiptSeq += 1;
        const row = {
          id: `receipt-${receiptSeq}`,
          status: "detected",
          bonusCents: 0n,
          amountUsdCents: null,
          topupId: null,
          createdAt: new Date(Date.UTC(2026, 9, 11, 0, 0, receiptSeq)),
          ...d,
        };
        state.receipts.push(row);
        return { ...row };
      },
      findUnique: async (args: { where: { network_txSignature_asset: Row } }) => {
        const key = args.where.network_txSignature_asset;
        const row = state.receipts.find((r) => matches(r, key));
        return row ? { ...row } : null;
      },
      findMany: async (args: { where: Row; take: number }) => {
        calls.push({ op: "onchainReceipt.findMany", args });
        return state.receipts
          .filter((r) => matches(r, args.where))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .slice(0, args.take)
          .map((r) => ({ ...r }));
      },
      updateMany: async (args: { where: Row; data: Row }) => {
        const hit = state.receipts.filter((r) => matches(r, args.where));
        for (const row of hit) Object.assign(row, args.data);
        return { count: hit.length };
      },
    },
    chainTransfer: {
      findUnique: async (args: { where: { txSignature: string } }) => {
        calls.push({ op: "chainTransfer.findUnique", args });
        const row = state.chainTransfers.find((r) => r.txSignature === args.where.txSignature);
        return row ? { ...row } : null;
      },
    },
    depositAddress: {
      findMany: async (args: { where: Row; take: number }) => {
        calls.push({ op: "depositAddress.findMany", args });
        const time = (d: Date | null, ifNull: number) => (d ? d.getTime() : ifNull);
        return state.addresses
          .filter((r) => matches(r, args.where))
          .sort(
            (a, b) =>
              // Asked first (nulls last), then least recently scanned
              // (never scanned first).
              time(a.scanRequestedAt, Infinity) - time(b.scanRequestedAt, Infinity) ||
              time(a.lastScannedAt, -Infinity) - time(b.lastScannedAt, -Infinity) ||
              0,
          )
          .slice(0, args.take)
          .map((r) => ({ ...r }));
      },
      findUnique: async (args: { where: { orgId: string } }) => {
        const row = state.addresses.find((r) => r.orgId === args.where.orgId);
        return row ? { ...row } : null;
      },
      updateMany: async (args: { where: Row; data: Row }) => {
        calls.push({ op: "depositAddress.updateMany", args });
        const hit = state.addresses.filter((r) => matches(r, args.where));
        for (const row of hit) Object.assign(row, args.data);
        return { count: hit.length };
      },
    },
    creditBalance: {
      upsert: async (args: { where: { orgId: string }; update: Row }) => {
        const next = (state.balances[args.where.orgId] ?? 0n) + args.update.balanceCents.increment;
        state.balances[args.where.orgId] = next;
        return { balanceCents: next };
      },
      update: async (args: { where: { orgId: string }; data: Row }) => {
        const next = (state.balances[args.where.orgId] ?? 0n) + args.data.balanceCents.increment;
        state.balances[args.where.orgId] = next;
        return { balanceCents: next };
      },
    },
    creditTransaction: {
      create: async (args: { data: Row }) => {
        state.ledger.push(args.data);
        return {};
      },
    },
  };

  const restore = (target: Row[], saved: Row[]) => {
    target.splice(0, target.length, ...saved);
  };

  const db = {
    ...client,
    $transaction: async <T>(fn: (tx: typeof client) => Promise<T>): Promise<T> => {
      if (inTransaction) throw new Error("stand-in: nested transaction");
      inTransaction = true;
      const saved = structuredClone({
        topups: state.topups,
        receipts: state.receipts,
        addresses: state.addresses,
        balances: state.balances,
        ledger: state.ledger,
      });
      try {
        return await fn(client);
      } catch (err) {
        restore(state.topups, saved.topups);
        restore(state.receipts, saved.receipts);
        restore(state.addresses, saved.addresses);
        restore(state.ledger, saved.ledger);
        state.balances = saved.balances;
        throw err;
      } finally {
        inTransaction = false;
      }
    },
  };

  // `db` is what the code under test is handed; `raw` is the same object
  // with the stand-in's own loose types, for a test that swaps a method.
  return { db: db as unknown as DepositScanDb, raw: db, state, calls };
}

// ============================================
// Transactions, as a node answers them
// ============================================

export interface TxShape {
  /** Static account keys, in order. The first `signers` of them signed. */
  keys: string[];
  loadedWritable?: string[];
  loadedReadonly?: string[];
  /** Lamports by address: [before, after]. Others are 0 and 0. */
  lamports?: Record<string, [bigint, bigint]>;
  /** Token balances by token account: mint, owner, [before, after]. A
   * null side means no entry (the account did not exist). */
  tokens?: Array<{
    account: string;
    mint?: string;
    owner?: string | null;
    amounts: [bigint | null, bigint | null];
  }>;
  memos?: string[];
  failed?: boolean;
  signers?: number;
  slot?: number;
  blockTime?: number | null;
}

/** getTransaction's answer for a shape. */
export function rpcTx(shape: TxShape): RpcTransactionLike {
  const staticKeys = [...shape.keys];
  const memos = shape.memos ?? [];
  if (memos.length > 0 && !staticKeys.includes(MEMO_PROGRAM_IDS[0]!)) {
    staticKeys.push(MEMO_PROGRAM_IDS[0]!);
  }
  const all = [...staticKeys, ...(shape.loadedWritable ?? []), ...(shape.loadedReadonly ?? [])];
  const pre = all.map((key) => Number(shape.lamports?.[key]?.[0] ?? 0n));
  const post = all.map((key) => Number(shape.lamports?.[key]?.[1] ?? 0n));
  const side = (which: 0 | 1) =>
    (shape.tokens ?? [])
      .filter((t) => t.amounts[which] !== null)
      .map((t) => ({
        accountIndex: all.indexOf(t.account),
        mint: t.mint ?? USDC_MINT.toBase58(),
        ...(t.owner === null ? {} : { owner: t.owner }),
        uiTokenAmount: { amount: (t.amounts[which] as bigint).toString() },
      }));
  const key = (address: string) => ({ toBase58: () => address });
  return {
    slot: shape.slot ?? 1_000,
    blockTime: shape.blockTime === undefined ? 1_790_000_000 : shape.blockTime,
    transaction: {
      message: {
        staticAccountKeys: staticKeys.map(key),
        header: { numRequiredSignatures: shape.signers ?? 1 },
        compiledInstructions: memos.map((memo) => ({
          programIdIndex: staticKeys.indexOf(MEMO_PROGRAM_IDS[0]!),
          data: new Uint8Array(Buffer.from(memo, "utf8")),
        })),
      },
    },
    meta: {
      err: shape.failed ? { InstructionError: [0, "Custom"] } : null,
      preBalances: pre,
      postBalances: post,
      preTokenBalances: side(0),
      postTokenBalances: side(1),
      ...(shape.loadedWritable || shape.loadedReadonly
        ? {
            loadedAddresses: {
              writable: (shape.loadedWritable ?? []).map(key),
              readonly: (shape.loadedReadonly ?? []).map(key),
            },
          }
        : {}),
    },
  };
}

const SENDER = addressOf("sender");

/** A plain SOL transfer to a deposit address. */
export function solTransfer(to: string, lamports: bigint, before = 0n, over: Partial<TxShape> = {}): TxShape {
  return {
    keys: [SENDER, to, SYSTEM_PROGRAM],
    lamports: {
      [SENDER]: [10_000_000_000n, 10_000_000_000n - lamports - 5_000n],
      [to]: [before, before + lamports],
    },
    ...over,
  };
}

/** A USDC transfer into a deposit address's USDC account. */
export function usdcTransfer(to: string, raw: bigint, before: bigint | null = 0n, over: Partial<TxShape> = {}): TxShape {
  const account = usdcAccountOf(to);
  const senderAccount = usdcAccountOf(SENDER);
  return {
    keys: [SENDER, senderAccount, account, TOKEN_PROGRAM],
    lamports: { [SENDER]: [1_000_000_000n, 999_995_000n], [account]: [2_039_280n, 2_039_280n] },
    tokens: [
      { account: senderAccount, owner: SENDER, amounts: [1_000_000_000n, 1_000_000_000n - raw] },
      { account, owner: to, amounts: [before, (before ?? 0n) + raw] },
    ],
    ...over,
  };
}

// ============================================
// The node
// ============================================

export function makeChain() {
  /** What the WATCH answers for an address. */
  const balances = new Map<string, { lamports: bigint; usdcRaw: bigint | null }>();
  /** Signatures by account, OLDEST first (the node answers newest first). */
  const histories = new Map<string, string[]>();
  const transactions = new Map<string, RpcTransactionLike | null | Error>();
  const calls = {
    getMultipleAccountsInfo: [] as Array<{ keys: string[]; commitment: unknown }>,
    getSignaturesForAddress: [] as Array<{ account: string; options: any; commitment: unknown }>,
    getTransaction: [] as Array<{ signature: string; options: any }>,
  };
  const failing = { watch: null as Error | null, history: new Set<string>() };
  /** A provider that hands back at most this many signatures a page,
   * whatever limit it was asked for. null: it honours the limit. */
  let pageCap: number | null = null;
  /** How many of the next requests that read back from a signature are
   * answered by a node that does not know it: with nothing. */
  let forgetful = 0;

  /** Puts a transaction on the chain: in the history of every account it
   * names, and loadable. */
  function land(signature: string, shape: TxShape, opts: { in?: string[] } = {}) {
    const tx = rpcTx(shape);
    transactions.set(signature, tx);
    const named = opts.in ?? [
      ...shape.keys,
      ...(shape.loadedWritable ?? []),
      ...(shape.loadedReadonly ?? []),
    ];
    for (const account of named) {
      const list = histories.get(account) ?? [];
      list.push(signature);
      histories.set(account, list);
    }
  }

  function tokenAccountInfo(raw: bigint) {
    const data = Buffer.alloc(165);
    data.writeBigUInt64LE(raw, 64);
    return { owner: TOKEN_PROGRAM_ID, data, lamports: 2_039_280, executable: false };
  }

  const usdcOwners = new Map<string, string>();
  function setBalance(address: string, lamports: bigint, usdcRaw: bigint | null = null) {
    balances.set(address, { lamports, usdcRaw });
    usdcOwners.set(usdcAccountOf(address), address);
  }

  const connection = {
    getMultipleAccountsInfo: async (keys: PublicKey[], commitment: unknown) => {
      const asked = keys.map((k) => k.toBase58());
      calls.getMultipleAccountsInfo.push({ keys: asked, commitment });
      if (failing.watch) throw failing.watch;
      return asked.map((address) => {
        const own = balances.get(address);
        if (own) {
          return own.lamports === 0n
            ? null
            : { owner: new PublicKey(SYSTEM_PROGRAM), data: Buffer.alloc(0), lamports: Number(own.lamports), executable: false };
        }
        const owner = usdcOwners.get(address);
        const usdc = owner ? balances.get(owner)?.usdcRaw : undefined;
        return usdc === null || usdc === undefined ? null : tokenAccountInfo(usdc);
      });
    },
    getSignaturesForAddress: async (account: PublicKey, options: any, commitment: unknown) => {
      const address = account.toBase58();
      calls.getSignaturesForAddress.push({ account: address, options, commitment });
      if (failing.history.has(address)) throw new Error("node said: history unavailable api-key=SECRET");
      const newestFirst = [...(histories.get(address) ?? [])].reverse();
      if (options?.before && forgetful > 0) {
        forgetful -= 1;
        return [];
      }
      let from = 0;
      if (options?.before) {
        // A node that does not know the signature it is asked to read back from answers with nothing.
        const at = newestFirst.indexOf(options.before);
        if (at < 0) return [];
        from = at + 1;
      }
      let list = newestFirst.slice(from);
      if (options?.until) {
        const stop = list.indexOf(options.until);
        if (stop >= 0) list = list.slice(0, stop);
      }
      const asked = options?.limit ?? 1000;
      return list.slice(0, pageCap === null ? asked : Math.min(asked, pageCap)).map((signature) => ({ signature }));
    },
    getTransaction: async (signature: string, options: any) => {
      calls.getTransaction.push({ signature, options });
      const tx = transactions.get(signature);
      if (tx instanceof Error) throw tx;
      return tx ?? null;
    },
  };

  return {
    connection: connection as unknown as DepositScanConnection,
    capPages: (cap: number | null) => {
      pageCap = cap;
    },
    /** The next `count` requests that carry `before` reach a node that does not know that signature. */
    forgetBefore: (count: number) => {
      forgetful = count;
    },
    balances,
    histories,
    transactions,
    calls,
    failing,
    land,
    setBalance,
  };
}

export const QUOTE_200 = {
  source: "static" as const,
  midMicroUsdPerSol: 200_000_000n,
  confMicroUsdPerSol: 0n,
  publishTime: 1_790_000_000,
  ageSeconds: 0,
  account: null,
};
