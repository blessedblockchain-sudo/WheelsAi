/**
 * Stand-ins for the sweep's tests (payments pass, batch 6): the three
 * tables it touches, in memory, a node that answers from maps, and
 * keypairs with fixed names. No database, no network.
 *
 * The database keeps what the money rules stand on:
 *   - `where` is honoured, so a compare-and-set can be lost;
 *   - chain_transfers refuses a second row with a signature, and a second
 *     "sent" row for the same sending address and asset (the partial
 *     unique index of the migration), with Prisma's P2002.
 */

import {
  ACCOUNT_SIZE,
  AccountLayout,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";

import {
  buildSweepDeps,
  type SweepConnection,
  type SweepDb,
} from "../services/buildSweepTickDeps.js";
import {
  runSweepTick,
  type SweepEvent,
  type SweepTickInput,
} from "../services/runSweepTick.js";
import type { SignatureFate, SignatureFateAnswer } from "../services/signatureFate.js";
import type { SolPriceResult, SolQuote } from "../services/solPrice.js";
import type { SweepSettings } from "../services/sweepPlan.js";

export const DEVNET = "solana:devnet" as const;
export const USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
export const OTHER_MINT = new PublicKey("nosXBVoaCTtYdLvKY6Csb4AC8JCdQKKAaWYtx2ZMoo7");
export const SOL = 1_000_000_000n;
export const USDC = 1_000_000n;
export const KEEP = 890_880n;
export const FEE = 5_000n;
export const NOW = new Date("2026-10-11T09:00:00.000Z");

export const ORG_1 = "11111111-1111-4111-8111-111111111111";
export const ORG_2 = "22222222-2222-4222-8222-222222222222";
export const ORG_3 = "33333333-3333-4333-8333-333333333333";

/** A fixed keypair for a name: the same name is always the same key. */
export function keypairOf(name: string): Keypair {
  const seed = new Uint8Array(32);
  const bytes = Buffer.from(name, "utf8");
  for (let i = 0; i < 32; i += 1) seed[i] = bytes[i % bytes.length] ?? 0;
  seed[31] = bytes.length;
  return Keypair.fromSeed(seed);
}

export const HOT_KEYPAIR = keypairOf("hot-wallet");
export const HOT = HOT_KEYPAIR.publicKey.toBase58();
export const TREASURY = keypairOf("treasury").publicKey.toBase58();

/** The keypair "this server derives" for an organization, in tests. */
export function depositKeypairOf(orgId: string): Keypair {
  return keypairOf(`deposit:${orgId}`);
}
export function depositAddressOf(orgId: string): string {
  return depositKeypairOf(orgId).publicKey.toBase58();
}
export function usdcAccountOf(address: string, mint: PublicKey = USDC_MINT): string {
  return getAssociatedTokenAddressSync(mint, new PublicKey(address)).toBase58();
}

/** $200 a SOL, no uncertainty: 1 SOL is 20,000 cents; $25 is 0.125 SOL. */
export const QUOTE_200: SolQuote = {
  source: "static",
  midMicroUsdPerSol: 200_000_000n,
  confMicroUsdPerSol: 0n,
  publishTime: 1_790_000_000,
  ageSeconds: 0,
  account: null,
};

export const SETTINGS: SweepSettings = {
  minUsd: 25,
  maxPerRun: 20,
  floatUsdc: 200,
  floatSolUsd: 100,
  hotWalletMinLamports: 50_000_000n,
};

// ============================================
// The database
// ============================================

type Row = Record<string, any>;

function same(have: unknown, want: unknown): boolean {
  if (have instanceof Date && want instanceof Date) return have.getTime() === want.getTime();
  return have === want;
}

function matches(row: Row, where: Row): boolean {
  for (const [key, want] of Object.entries(where)) {
    const have = row[key] ?? null;
    if (want !== null && typeof want === "object" && !(want instanceof Date)) {
      if ("gt" in want && !(have > want.gt)) return false;
      if ("in" in want && !want.in.some((v: unknown) => same(have, v))) return false;
    } else if (!same(have, want ?? null)) {
      return false;
    }
  }
  return true;
}

function unique(): Error {
  return Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
}

/** A deposit_addresses row that the scan has accounted `usdcRaw` and
 * `lamports` on. */
export function addressRow(orgId: string, usdcRaw = 0n, lamports = 0n, over: Row = {}): Row {
  return {
    orgId,
    address: depositAddressOf(orgId),
    network: DEVNET,
    lastSeenLamports: lamports,
    lastSeenUsdcRaw: usdcRaw,
    ...over,
  };
}

/** A chain_transfers row, "sent" unless said otherwise. */
export function transferRow(over: Row = {}): Row {
  return {
    id: "ct-1",
    kind: "sweep_to_hot",
    network: DEVNET,
    asset: "USDC",
    fromAddress: depositAddressOf(ORG_1),
    toAddress: HOT,
    orgId: ORG_1,
    amountRaw: 60n * USDC,
    feeLamports: 10_000n,
    feePayer: HOT,
    status: "sent",
    txSignature: "sig_1",
    signedTxB64: Buffer.from("stored bytes of sig_1").toString("base64"),
    lastValidBlockHeight: 1_000n,
    failureReason: null,
    createdAt: new Date("2026-10-11T08:00:00.000Z"),
    settledAt: null,
    ...over,
  };
}

export function makeSweepDb(
  init: { transfers?: Row[]; addresses?: Row[]; wallets?: Row[]; topups?: Row[] } = {},
  order: string[] = [],
) {
  const state = {
    transfers: init.transfers ?? [],
    addresses: init.addresses ?? [],
    wallets: init.wallets ?? [],
    topups: init.topups ?? [],
  };
  const calls: Array<{ op: string; args: any }> = [];
  let seq = 0;

  const db = {
    chainTransfer: {
      findMany: async (args: { where: Row; take: number }) => {
        calls.push({ op: "chainTransfer.findMany", args });
        return state.transfers
          .filter((r) => matches(r, args.where))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .slice(0, args.take)
          .map((r) => ({ ...r }));
      },
      updateMany: async (args: { where: Row; data: Row }) => {
        calls.push({ op: "chainTransfer.updateMany", args });
        const hit = state.transfers.filter((r) => matches(r, args.where));
        for (const row of hit) Object.assign(row, args.data);
        return { count: hit.length };
      },
      create: async (args: { data: Row }) => {
        calls.push({ op: "chainTransfer.create", args });
        const d = args.data;
        if (
          state.transfers.some(
            (r) =>
              r.txSignature === d.txSignature ||
              (d.status === "sent" &&
                r.status === "sent" &&
                r.fromAddress === d.fromAddress &&
                r.asset === d.asset),
          )
        ) {
          throw unique();
        }
        seq += 1;
        const row = {
          id: `ct-new-${seq}`,
          failureReason: null,
          settledAt: null,
          createdAt: new Date(NOW.getTime() + seq * 1_000),
          ...d,
        };
        state.transfers.push(row);
        order.push(`row:${d.txSignature}`);
        return { ...row };
      },
    },
    walletTopUp: {
      findFirst: async (args: { where: { depositAddress: string } }) => {
        calls.push({ op: "walletTopUp.findFirst", args });
        const row = state.topups.find((r) => r.depositAddress === args.where.depositAddress);
        return row ? { id: row.id } : null;
      },
    },
    depositAddress: {
      findMany: async (args: { where: Row; orderBy: Row; take: number }) => {
        calls.push({ op: "depositAddress.findMany", args });
        const [[column]] = Object.entries(args.orderBy) as [[string, string]];
        return state.addresses
          .filter((r) => matches(r, args.where))
          .sort((a, b) => (a[column] === b[column] ? 0 : a[column] > b[column] ? -1 : 1))
          .slice(0, args.take)
          .map((r) => ({ ...r }));
      },
      findUnique: async (args: { where: { address: string } }) => {
        calls.push({ op: "depositAddress.findUnique", args });
        const row = state.addresses.find((r) => r.address === args.where.address);
        return row ? { ...row } : null;
      },
    },
    platformWallet: {
      findUnique: async (args: { where: { role_network: { role: string; network: string } } }) => {
        calls.push({ op: "platformWallet.findUnique", args });
        const key = args.where.role_network;
        const row = state.wallets.find((r) => r.role === key.role && r.network === key.network);
        return row ? { ...row } : null;
      },
    },
  };

  // `db` is what the code under test is handed; `raw` is the same object
  // with the stand-in's own loose types, for a test that swaps a method.
  return { db: db as unknown as SweepDb, raw: db, state, calls };
}

/** The platform_wallets row that proves an address. */
export function treasuryRow(address: string = TREASURY, over: Row = {}): Row {
  return {
    role: "treasury",
    network: DEVNET,
    address,
    verifiedAt: new Date("2026-10-10T00:00:00.000Z"),
    proofSignature: "sig_proof",
    ...over,
  };
}

// ============================================
// The node
// ============================================

export function tokenAccountInfo(raw: bigint, owner: string, mint: PublicKey = USDC_MINT) {
  const data = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode(
    {
      mint,
      owner: new PublicKey(owner),
      amount: raw,
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
  return { owner: TOKEN_PROGRAM_ID, data, lamports: 2_039_280, executable: false };
}

export function makeSweepChain(order: string[] = []) {
  /** What an address holds. usdcRaw null: it has no USDC account. */
  const balances = new Map<string, { lamports: bigint; usdcRaw: bigint | null }>();
  /** Accounts answered as they are, whatever `balances` says. */
  const rawAccounts = new Map<string, unknown>();
  const calls = {
    getMultipleAccountsInfo: [] as Array<{ keys: string[]; commitment: unknown }>,
    getLatestBlockhash: [] as unknown[],
    sendRawTransaction: [] as Array<{ b64: string; options: unknown }>,
  };
  const failing = {
    read: null as Error | null,
    blockhash: null as Error | null,
    send: null as Error | null,
  };
  let blockhashes = 0;

  function setBalance(address: string, lamports: bigint, usdcRaw: bigint | null = null) {
    balances.set(address, { lamports, usdcRaw });
  }

  const connection = {
    getMultipleAccountsInfo: async (keys: PublicKey[], commitment: unknown) => {
      const asked = keys.map((k) => k.toBase58());
      calls.getMultipleAccountsInfo.push({ keys: asked, commitment });
      order.push("read");
      if (failing.read) throw failing.read;
      const usdcOwners = new Map<string, string>();
      for (const address of balances.keys()) usdcOwners.set(usdcAccountOf(address), address);
      return asked.map((address) => {
        if (rawAccounts.has(address)) return rawAccounts.get(address);
        const own = balances.get(address);
        if (own) {
          return own.lamports === 0n
            ? null
            : { owner: SystemProgram.programId, data: Buffer.alloc(0), lamports: Number(own.lamports), executable: false };
        }
        const owner = usdcOwners.get(address);
        const usdc = owner ? balances.get(owner)?.usdcRaw : undefined;
        return usdc === null || usdc === undefined || !owner ? null : tokenAccountInfo(usdc, owner);
      });
    },
    getLatestBlockhash: async (commitment: unknown) => {
      calls.getLatestBlockhash.push(commitment);
      if (failing.blockhash) throw failing.blockhash;
      blockhashes += 1;
      return {
        // A new blockhash every time, so a new transfer is a new signature.
        blockhash: keypairOf(`blockhash-${blockhashes}`).publicKey.toBase58(),
        lastValidBlockHeight: 5_000 + blockhashes,
      };
    },
    sendRawTransaction: async (bytes: Buffer | Uint8Array, options: unknown) => {
      const b64 = Buffer.from(bytes).toString("base64");
      calls.sendRawTransaction.push({ b64, options });
      order.push("send");
      if (failing.send) throw failing.send;
      return "sent";
    },
  };

  return {
    connection: connection as unknown as SweepConnection,
    balances,
    rawAccounts,
    calls,
    failing,
    setBalance,
  };
}

// ============================================
// A fate, as readSignatureFate answers
// ============================================

export function fateAnswer(
  signature: string,
  fate: SignatureFate,
  error?: string,
  /** How final a landing is. A landed fate is finalized unless said. */
  level: "confirmed" | "finalized" = "finalized",
): SignatureFateAnswer {
  const reasons = {
    landed_ok: "status_ok",
    landed_failed: "status_err",
    in_flight: "absent_within_window",
    dead: "absent_expired_by_height",
    unknown: "status_read_failed",
  } as const;
  return {
    fate,
    reason: reasons[fate],
    signature,
    ...(error !== undefined ? { error } : {}),
    detail: {
      finalizedSlot: null,
      finalizedBlockHeight: null,
      lastValidBlockHeight: null,
      marginBlocks: 32,
      statusContextSlot: null,
      confirmationStatus: fate === "landed_ok" || fate === "landed_failed" ? level : null,
      landedSlot: null,
      blockhashValid: null,
      blockhashContextSlot: null,
    },
  };
}

// ============================================
// The whole thing, wired
// ============================================

export function setupSweep(
  init: Parameters<typeof makeSweepDb>[0] = {},
  opts: { treasurySetting?: string | null; hot?: { lamports: bigint; usdcRaw: bigint | null } } = {},
) {
  /** What happened, in order: "read", "row:<signature>", "send", "fate:<signature>". */
  const order: string[] = [];
  const data = makeSweepDb(init, order);
  const chain = makeSweepChain(order);
  const events: SweepEvent[] = [];
  const fates = new Map<string, SignatureFateAnswer>();
  const fateCalls: Array<{ signature: string; lastValidBlockHeight: unknown }> = [];
  const knobs = {
    price: { ok: true, quote: QUOTE_200 } as SolPriceResult,
    clusterOk: true,
    clusterChecks: 0,
    treasurySetting: (opts.treasurySetting === undefined ? TREASURY : opts.treasurySetting) as string | null,
    deriveKeypair: depositKeypairOf as (orgId: string) => Keypair,
  };
  const hot = opts.hot ?? { lamports: SOL, usdcRaw: 0n };
  chain.setBalance(HOT, hot.lamports, hot.usdcRaw);

  const deps = buildSweepDeps({
    db: data.db,
    network: DEVNET,
    usdcMint: USDC_MINT,
    getConnection: () => chain.connection,
    checkCluster: async () => {
      knobs.clusterChecks += 1;
      return { ok: knobs.clusterOk };
    },
    hotWalletKeypair: () => HOT_KEYPAIR,
    deriveKeypair: (orgId) => knobs.deriveKeypair(orgId),
    treasurySetting: () => knobs.treasurySetting,
    getSolQuote: async () => knobs.price,
    readSignatureFate: async (input) => {
      fateCalls.push({ signature: input.signature, lastValidBlockHeight: input.lastValidBlockHeight });
      order.push(`fate:${input.signature}`);
      return fates.get(input.signature) ?? fateAnswer(input.signature, "unknown", "no answer set");
    },
    log: (event) => events.push(event),
    now: () => NOW,
  });
  const input: SweepTickInput = {
    enabled: true,
    intervalMs: 300_000,
    network: DEVNET,
    settings: SETTINGS,
  };
  const run = (over: Partial<SweepTickInput> = {}) => runSweepTick({ ...input, ...over }, deps);
  /** An organization's deposit address holding exactly what its row says. */
  const fund = (orgId: string) => {
    const row = data.state.addresses.find((r) => r.orgId === orgId)!;
    chain.setBalance(row.address, row.lastSeenLamports, row.lastSeenUsdcRaw > 0n ? row.lastSeenUsdcRaw : null);
  };
  for (const row of data.state.addresses) fund(row.orgId);
  const errors = () => events.filter((e) => e.event === "error");
  return { ...data, chain, events, errors, fates, fateCalls, knobs, deps, run, order, fund };
}
