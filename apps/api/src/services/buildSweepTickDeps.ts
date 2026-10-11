/**
 * Composition root for the sweep (payments pass, batch 6): binds the pure
 * runSweepTick to Prisma, to the shared Solana connection and to
 * config/env.ts, and holds how a sweep's transaction is built and signed.
 *
 * The money rules live elsewhere; this file only wires them:
 *   - what may move and where: services/sweepPlan.ts
 *   - the order of a run, claim first: services/runSweepTick.ts
 *   - what became of a signature: services/signatureFate.ts
 *
 * What this file itself guarantees:
 *   - A TRANSACTION IS BUILT ONLY FOR THE HOT WALLET OR THE PROVEN
 *     TREASURY as its destination, and only from the hot wallet or from an
 *     address whose keypair this server derives for the organization on
 *     the transfer. Anything else throws before a blockhash is asked for.
 *   - The row is written as "sent" with the signature, the signed bytes
 *     and the last valid block height. An insert the database refuses
 *     (P2002: a "sent" row already holds that address and asset, or that
 *     signature) answers false, and nothing is sent.
 *   - Ending a row is a compare-and-set on "sent" and its signature.
 *
 * Deposit addresses are read at "finalized", the commitment the deposit
 * scan accounts at. No Connection is made here (lib/solana.ts owns the
 * only one).
 */

import {
  ACCOUNT_SIZE,
  AccountLayout,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  PublicKey,
  SystemProgram,
  Transaction,
  type AccountInfo,
  type Connection,
  type Keypair,
} from "@solana/web3.js";
import bs58 from "bs58";

import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { ensureSolanaCluster, getSolanaConnection } from "../lib/solana.js";
import { usdcMintForNetwork } from "../lib/solanaAssets.js";
import { createLogger } from "../utils/logger.js";
import { readSignatureFate } from "./buildSignatureFateDeps.js";
import { getSolQuote } from "./buildSolPriceDeps.js";
import { chainLabel, type ChainLabel } from "./depositTypes.js";
import { hotWallet, solToLamports } from "./hotWallet.js";
import type {
  OpenPayoutsOwed,
  SentTransferRow,
  SignedSweepArtifact,
  SweepAddressRow,
  SweepEvent,
  SweepTickDeps,
  SweepTickInput,
} from "./runSweepTick.js";
import type { SignatureFateAnswer, SignatureFateInput } from "./signatureFate.js";
import type { SolPriceResult } from "./solPrice.js";
import {
  SWEEP_FEE_PER_SIGNATURE_LAMPORTS,
  SWEEP_KEEP_LAMPORTS,
  readTreasuryAddress,
  treasuryVerdict,
  type PlannedTransfer,
  type SweepSettings,
  type TreasuryVerdict,
} from "./sweepPlan.js";
import { deriveTopupDepositKeypair } from "./topupKeypairs.js";

const logger = createLogger("deposit-sweep");

const USDC_DECIMALS = 6;
/** The most "sent" rows a run settles. */
export const SWEEP_SENT_LIMIT = 1_000;
/** The most deposit addresses a run reads for each asset, largest first. */
export const SWEEP_ADDRESS_LIMIT = 500;
/** Operators read failure_reason; the chain's words are kept, to a length. */
const FAILURE_REASON_MAX_LENGTH = 1_000;

// ============================================
// The transaction
// ============================================

export interface BuildSweepTransactionInput {
  transfer: PlannedTransfer;
  /** The only two addresses a sweep may send to. */
  hotWallet: PublicKey;
  treasury: PublicKey | null;
  usdcMint: PublicKey;
  blockhash: string;
  lastValidBlockHeight: number;
}

/**
 * The transaction of one planned transfer. Throws unless its destination
 * is the hot wallet (a sweep to it) or the treasury handed in (a sweep to
 * it, or the hot wallet's excess), and its fee payer is the one the
 * contract names.
 *
 *   SOL off a deposit address   the address pays its own fee; one system
 *                               transfer
 *   USDC off a deposit address  the hot wallet pays; the destination's
 *                               USDC account is opened when missing, then
 *                               one checked transfer the address signs
 *   from the hot wallet         the hot wallet pays and signs; the same
 *                               instructions
 */
export function buildSweepTransaction(input: BuildSweepTransactionInput): Transaction {
  const { transfer } = input;
  if (typeof transfer.amountRaw !== "bigint" || transfer.amountRaw <= 0n) {
    throw new Error("buildSweepTransaction: the amount must be base units above zero");
  }
  const hot = input.hotWallet.toBase58();
  const treasury = input.treasury?.toBase58() ?? null;

  let destination: PublicKey;
  if (transfer.kind === "sweep_to_hot") {
    if (transfer.toAddress !== hot) {
      throw new Error("buildSweepTransaction: a sweep to the hot wallet names another address");
    }
    destination = input.hotWallet;
  } else if (transfer.kind === "sweep_to_treasury" || transfer.kind === "hot_to_treasury") {
    if (treasury === null || input.treasury === null || transfer.toAddress !== treasury) {
      throw new Error("buildSweepTransaction: the destination is not the proven treasury");
    }
    if (treasury === hot) {
      throw new Error("buildSweepTransaction: the treasury is the hot wallet");
    }
    destination = input.treasury;
  } else {
    throw new Error("buildSweepTransaction: unknown kind of transfer");
  }

  const fromHot = transfer.kind === "hot_to_treasury";
  if (fromHot !== (transfer.fromAddress === hot)) {
    throw new Error("buildSweepTransaction: the sending address does not fit the kind of transfer");
  }
  if (transfer.fromAddress === transfer.toAddress) {
    throw new Error("buildSweepTransaction: the transfer goes nowhere");
  }
  const source = new PublicKey(transfer.fromAddress);

  if (transfer.asset === "SOL") {
    // A deposit address pays its own fee; the hot wallet pays for itself.
    if (transfer.feePayer !== transfer.fromAddress) {
      throw new Error("buildSweepTransaction: a SOL transfer is paid for by its sender");
    }
    return new Transaction({
      feePayer: source,
      blockhash: input.blockhash,
      lastValidBlockHeight: input.lastValidBlockHeight,
    }).add(
      SystemProgram.transfer({
        fromPubkey: source,
        toPubkey: destination,
        lamports: transfer.amountRaw,
      }),
    );
  }

  if (transfer.asset !== "USDC") {
    throw new Error("buildSweepTransaction: unknown asset");
  }
  if (transfer.feePayer !== hot) {
    throw new Error("buildSweepTransaction: a USDC transfer is paid for by the hot wallet");
  }
  const sourceAccount = getAssociatedTokenAddressSync(input.usdcMint, source);
  const destinationAccount = getAssociatedTokenAddressSync(input.usdcMint, destination);
  return new Transaction({
    feePayer: input.hotWallet,
    blockhash: input.blockhash,
    lastValidBlockHeight: input.lastValidBlockHeight,
  }).add(
    // Opens the destination's USDC account when there is none; does
    // nothing when there is one. The hot wallet pays its rent.
    createAssociatedTokenAccountIdempotentInstruction(
      input.hotWallet,
      destinationAccount,
      destination,
      input.usdcMint,
    ),
    createTransferCheckedInstruction(
      sourceAccount,
      input.usdcMint,
      destinationAccount,
      source,
      transfer.amountRaw,
      USDC_DECIMALS,
    ),
  );
}

/**
 * Builds the transfer and signs it. Does not send: the bytes go on the
 * row first (the claim), and only the stored bytes are ever broadcast.
 * `source` is the deposit address's keypair, or null for a transfer from
 * the hot wallet.
 */
export function signSweepTransaction(
  input: BuildSweepTransactionInput,
  keys: { hotWallet: Keypair; source: Keypair | null },
): SignedSweepArtifact {
  if (!keys.hotWallet.publicKey.equals(input.hotWallet)) {
    throw new Error("signSweepTransaction: the hot wallet's key is not the hot wallet named");
  }
  const { transfer } = input;
  const fromHot = transfer.kind === "hot_to_treasury";
  if (fromHot) {
    if (keys.source !== null) {
      throw new Error("signSweepTransaction: a transfer from the hot wallet has no other signer");
    }
  } else if (
    keys.source === null ||
    keys.source.publicKey.toBase58() !== transfer.fromAddress
  ) {
    throw new Error("signSweepTransaction: the key is not the sending address's");
  }

  const tx = buildSweepTransaction(input);
  if (fromHot) tx.sign(keys.hotWallet);
  else if (transfer.asset === "SOL") tx.sign(keys.source as Keypair);
  else tx.sign(keys.hotWallet, keys.source as Keypair);
  if (!tx.signature) {
    throw new Error("signSweepTransaction: the transfer did not sign");
  }
  return {
    txSignature: bs58.encode(tx.signature),
    // serialize() refuses a transaction with a signature missing.
    signedTxB64: tx.serialize().toString("base64"),
    lastValidBlockHeight: BigInt(input.lastValidBlockHeight),
  };
}

// ============================================
// The binding
// ============================================

/** The connection calls the sweep makes. */
export type SweepConnection = Pick<
  Connection,
  "getMultipleAccountsInfo" | "getLatestBlockhash" | "sendRawTransaction"
>;

/** The columns of chain_transfers the sweep reads back. */
interface ChainTransferDbRow {
  id: string;
  kind: string;
  asset: string;
  fromAddress: string;
  toAddress: string;
  amountRaw: bigint;
  txSignature: string;
  signedTxB64: string;
  lastValidBlockHeight: bigint;
}

/** The part of the Prisma client the sweep uses. */
export interface SweepDb {
  chainTransfer: {
    findMany: (args: {
      where: { network: string; status: "sent" };
      orderBy: { createdAt: "asc" };
      take: number;
    }) => Promise<ChainTransferDbRow[]>;
    updateMany: (args: {
      where: { id: string; status: "sent"; txSignature: string };
      data: { status: string; settledAt: Date; failureReason: string | null };
    }) => Promise<{ count: number }>;
    create: (args: { data: Record<string, unknown> }) => Promise<unknown>;
  };
  depositAddress: {
    findMany: (args: {
      where: Record<string, unknown>;
      orderBy: Record<string, "desc">;
      take: number;
    }) => Promise<SweepAddressRow[]>;
    findUnique: (args: {
      where: { address: string };
    }) => Promise<{ orgId: string } | null>;
  };
  platformWallet: {
    findUnique: (args: {
      where: { role_network: { role: string; network: string } };
    }) => Promise<{ address: string } | null>;
  };
  walletTopUp: {
    findFirst: (args: {
      where: { depositAddress: string };
      select: { id: true };
    }) => Promise<{ id: string } | null>;
  };
}

/** The part of the client the treasury's proof is read with. */
export type TreasuryProofDb = Pick<SweepDb, "platformWallet" | "walletTopUp"> & {
  depositAddress: Pick<SweepDb["depositAddress"], "findUnique">;
};

/**
 * Is the treasury proven (the contract's rule 4)? Reads the
 * platform_wallets row of this chain and whether the address is a deposit
 * address, and hands both to services/sweepPlan.ts treasuryVerdict.
 */
export async function readProvenTreasury(
  db: TreasuryProofDb,
  facts: {
    network: ChainLabel;
    /** TREASURY_WALLET_ADDRESS. */
    setting: string | null | undefined;
    hotWalletAddress: string;
  },
): Promise<TreasuryVerdict> {
  // The address checks that need no read come first: a setting that could
  // never be sent to costs no query.
  const reading = readTreasuryAddress({
    setting: facts.setting,
    hotWalletAddress: facts.hotWalletAddress,
    isDepositAddress: () => false,
  });
  if (!reading.ok) return { proven: false, reason: reading.reason };
  // An address this server derives is one it has handed out: the row of an
  // organization's deposit address, or the address a prepared top-up was
  // sent to (the same derivation, from before the row existed).
  const [issued, prepared] = await Promise.all([
    db.depositAddress.findUnique({ where: { address: reading.address } }),
    db.walletTopUp.findFirst({
      where: { depositAddress: reading.address },
      select: { id: true },
    }),
  ]);
  const deposit = issued ?? prepared;
  const row = await db.platformWallet.findUnique({
    where: { role_network: { role: "treasury", network: facts.network } },
  });
  return treasuryVerdict({
    setting: facts.setting,
    provenAddress: row?.address ?? null,
    hotWalletAddress: facts.hotWalletAddress,
    isDepositAddress: () => deposit !== null,
  });
}

export interface BuildSweepDepsInput {
  db: SweepDb;
  /** The row label of the chain the settings name. */
  network: ChainLabel;
  usdcMint: PublicKey;
  getConnection: () => SweepConnection;
  /** lib/solana.ts ensureSolanaCluster. */
  checkCluster: () => Promise<{ ok: boolean; reason?: string }>;
  /** The hot wallet's keypair (services/hotWallet.ts). May throw. */
  hotWalletKeypair: () => Keypair;
  /** The keypair this server derives for an organization's deposit
   * address (services/topupKeypairs.ts). May throw. */
  deriveKeypair: (orgId: string) => Keypair;
  /** TREASURY_WALLET_ADDRESS. */
  treasurySetting: () => string | null | undefined;
  /** services/buildSolPriceDeps.ts getSolQuote. */
  getSolQuote: () => Promise<SolPriceResult>;
  /** services/buildSignatureFateDeps.ts readSignatureFate. */
  readSignatureFate: (input: SignatureFateInput) => Promise<SignatureFateAnswer>;
  /** What payouts to a wallet need from the hot wallet, in cents by asset
   * (readOpenWalletPayouts). Left out: nothing is owed. */
  readOpenPayouts?: () => Promise<OpenPayoutsOwed>;
  log?: (event: SweepEvent) => void;
  now?: () => Date;
}

/** One sum of creator_payouts, as the reader groups them. */
export interface OpenPayoutSum {
  payoutMethod: string;
  status: string;
  amountCents: bigint;
}

const NOTHING_OWED: OpenPayoutsOwed = {
  waiting: { usdcCents: 0n, solCents: 0n },
  open: { usdcCents: 0n, solCents: 0n },
};

/**
 * What the hot wallet must hold for payouts to a wallet, in cents by asset:
 * for those waiting to be sent (pending), and for all that are open
 * (pending or processing).
 *
 * Nothing while payouts are not running: a payout that cannot be sent is
 * no reason to hold money in the wallet whose key the server has. And
 * never more, USDC and SOL TOGETHER, than the platform's own limit for a
 * day of payouts: it is the most that can leave in a day, and it is what
 * bounds how much the hot wallet can come to hold on top of its floats.
 * USDC is counted first and SOL has what is left of the limit.
 */
export function owedForOpenPayouts(input: {
  /** Sums of creator_payouts by method and status. */
  sums: OpenPayoutSum[];
  /** PAYOUT_PLATFORM_MAX_PER_DAY_USD, in cents. */
  capCents: bigint;
  /** PAYOUTS_ENABLED with the executor scheduled. */
  payoutsRunning: boolean;
}): OpenPayoutsOwed {
  if (!input.payoutsRunning) return NOTHING_OWED;
  const cap = input.capCents > 0n ? input.capCents : 0n;
  const total = (method: string, statuses: string[]) => {
    let sum = 0n;
    for (const row of input.sums) {
      if (row.payoutMethod === method && statuses.includes(row.status) && row.amountCents > 0n) {
        sum += row.amountCents;
      }
    }
    return sum;
  };
  const capped = (statuses: string[]) => {
    const usdc = total("crypto_usdc", statuses);
    const usdcCents = usdc > cap ? cap : usdc;
    const left = cap - usdcCents;
    const sol = total("crypto_sol", statuses);
    return { usdcCents, solCents: sol > left ? left : sol };
  };
  return { waiting: capped(["pending"]), open: capped(["pending", "processing"]) };
}

/** The one table the reader asks. */
export interface OpenPayoutsDb {
  creatorPayout: {
    groupBy: (args: {
      by: ["payoutMethod", "status"];
      where: {
        status: { in: string[] };
        payoutMethod: { in: string[] };
      };
      _sum: { amountCents: true };
    }) => Promise<Array<{ payoutMethod: string; status: string; _sum: { amountCents: bigint | null } }>>;
  };
}

/**
 * Reads what payouts to a wallet need from the hot wallet. A payout taken
 * as credits needs nothing from it, and one that is completed, failed or
 * cancelled is not open. The table is not read at all while payouts are
 * not running.
 */
export async function readOpenWalletPayouts(
  db: OpenPayoutsDb,
  settings: { payoutsRunning: boolean; capCents: bigint },
): Promise<OpenPayoutsOwed> {
  if (!settings.payoutsRunning) return NOTHING_OWED;
  const rows = await db.creatorPayout.groupBy({
    by: ["payoutMethod", "status"],
    where: {
      status: { in: ["pending", "processing"] },
      payoutMethod: { in: ["crypto_usdc", "crypto_sol"] },
    },
    _sum: { amountCents: true },
  });
  return owedForOpenPayouts({
    sums: rows.map((row) => ({
      payoutMethod: row.payoutMethod,
      status: row.status,
      amountCents: row._sum.amountCents ?? 0n,
    })),
    capCents: settings.capCents,
    payoutsRunning: settings.payoutsRunning,
  });
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "P2002";
}

/** What a USDC account of `owner` holds. An account that is not there, or
 * is not that owner's token account of our mint, holds nothing. */
function usdcHeld(
  account: AccountInfo<Buffer> | null | undefined,
  mint: PublicKey,
  owner: PublicKey,
): bigint {
  if (!account || !account.owner.equals(TOKEN_PROGRAM_ID)) return 0n;
  if (account.data.length < ACCOUNT_SIZE) return 0n;
  const decoded = AccountLayout.decode(account.data.subarray(0, ACCOUNT_SIZE));
  if (!decoded.mint.equals(mint) || !decoded.owner.equals(owner)) return 0n;
  return decoded.amount;
}

export function buildSweepDeps(input: BuildSweepDepsInput): SweepTickDeps {
  const { db, network, usdcMint, getConnection } = input;
  const now = input.now ?? (() => new Date());

  return {
    checkCluster: input.checkCluster,
    log: input.log,
    getSolQuote: input.getSolQuote,
    readFate: input.readSignatureFate,
    deriveAddress: (orgId) => input.deriveKeypair(orgId).publicKey.toBase58(),

    loadSent: async () => {
      const rows = await db.chainTransfer.findMany({
        where: { network, status: "sent" },
        orderBy: { createdAt: "asc" },
        take: SWEEP_SENT_LIMIT,
      });
      return rows.map(
        (row): SentTransferRow => ({
          id: row.id,
          kind: row.kind,
          asset: row.asset,
          fromAddress: row.fromAddress,
          toAddress: row.toAddress,
          amountRaw: row.amountRaw,
          txSignature: row.txSignature,
          signedTxB64: row.signedTxB64,
          lastValidBlockHeight: row.lastValidBlockHeight,
        }),
      );
    },

    settle: async (row, as, reason) => {
      const res = await db.chainTransfer.updateMany({
        where: { id: row.id, status: "sent", txSignature: row.txSignature },
        data: {
          status: as,
          settledAt: now(),
          failureReason: reason === null ? null : reason.slice(0, FAILURE_REASON_MAX_LENGTH),
        },
      });
      return res.count === 1;
    },

    broadcast: async (signedTxB64) => {
      await getConnection().sendRawTransaction(Buffer.from(signedTxB64, "base64"), {
        skipPreflight: false,
        maxRetries: 3,
      });
    },

    // Only rows the scan has accounted something on: an address is swept
    // only when it holds exactly what the scan last saw, so a row that
    // saw nothing has nothing to move. The largest of each asset first.
    loadAddresses: async () => {
      const usdc = await db.depositAddress.findMany({
        where: { network, lastSeenUsdcRaw: { gt: 0n } },
        orderBy: { lastSeenUsdcRaw: "desc" },
        take: SWEEP_ADDRESS_LIMIT,
      });
      const sol = await db.depositAddress.findMany({
        where: {
          network,
          lastSeenLamports: { gt: SWEEP_KEEP_LAMPORTS + SWEEP_FEE_PER_SIGNATURE_LAMPORTS },
        },
        orderBy: { lastSeenLamports: "desc" },
        take: SWEEP_ADDRESS_LIMIT,
      });
      const byOrg = new Map<string, SweepAddressRow>();
      for (const row of [...usdc, ...sol]) {
        if (byOrg.has(row.orgId)) continue;
        byOrg.set(row.orgId, {
          orgId: row.orgId,
          address: row.address,
          network: row.network,
          lastSeenLamports: row.lastSeenLamports,
          lastSeenUsdcRaw: row.lastSeenUsdcRaw,
        });
      }
      return [...byOrg.values()];
    },

    // ONE call: the addresses, then their USDC accounts.
    readBalances: async (addresses) => {
      const owners = addresses.map((address) => new PublicKey(address));
      const keys = [
        ...owners,
        ...owners.map((owner) => getAssociatedTokenAddressSync(usdcMint, owner)),
      ];
      const infos = await getConnection().getMultipleAccountsInfo(keys, "finalized");
      if (!Array.isArray(infos) || infos.length !== keys.length) {
        throw new Error("the node did not answer for every account");
      }
      return owners.map((owner, i) => ({
        lamports: BigInt(infos[i]?.lamports ?? 0),
        usdcRaw: usdcHeld(infos[owners.length + i], usdcMint, owner),
      }));
    },

    // Read at "confirmed" and at "finalized", and both are handed on
    // (services/sweepPlan.ts says what each is for). What it can spend is
    // THE LOWER of the two: at "finalized" alone a payout that has just
    // left is still in the balance, and the excess would be worked out
    // from money that is gone. What is on its way is counted from what
    // is FINAL: a "sent" row is ended at "finalized", so a transfer that
    // has landed and is not final yet is in the confirmed balance and in
    // its row at once, and would be counted twice from there.
    readHotWallet: async () => {
      const owner = input.hotWalletKeypair().publicKey;
      const keys = [owner, getAssociatedTokenAddressSync(usdcMint, owner)];
      const [confirmed, finalized] = await Promise.all([
        getConnection().getMultipleAccountsInfo(keys, "confirmed"),
        getConnection().getMultipleAccountsInfo(keys, "finalized"),
      ]);
      for (const infos of [confirmed, finalized]) {
        if (!Array.isArray(infos) || infos.length !== keys.length) {
          throw new Error("the node did not answer for the hot wallet");
        }
      }
      const lower = (a: bigint, b: bigint) => (a < b ? a : b);
      const final = {
        lamports: BigInt(finalized[0]?.lamports ?? 0),
        usdcRaw: usdcHeld(finalized[1], usdcMint, owner),
      };
      return {
        address: owner.toBase58(),
        lamports: lower(BigInt(confirmed[0]?.lamports ?? 0), final.lamports),
        usdcRaw: lower(usdcHeld(confirmed[1], usdcMint, owner), final.usdcRaw),
        finalized: final,
      };
    },

    readOpenPayouts: async () => (input.readOpenPayouts ? input.readOpenPayouts() : NOTHING_OWED),

    readTreasury: async () => {
      const verdict = await readProvenTreasury(db, {
        network,
        setting: input.treasurySetting(),
        hotWalletAddress: input.hotWalletKeypair().publicKey.toBase58(),
      });
      return verdict.proven ? verdict.address : null;
    },

    prepare: async (transfer, allowed) => {
      const hot = input.hotWalletKeypair();
      if (hot.publicKey.toBase58() !== allowed.hotWallet) {
        throw new Error("the hot wallet is not the one the plan was made for");
      }
      let source: Keypair | null = null;
      if (transfer.kind !== "hot_to_treasury") {
        if (transfer.orgId === null) {
          throw new Error("a sweep names no organization");
        }
        source = input.deriveKeypair(transfer.orgId);
        if (source.publicKey.toBase58() !== transfer.fromAddress) {
          throw new Error(
            "the sending address is not the one this server derives for the organization",
          );
        }
      }
      // Every check that needs no node runs before a blockhash is asked
      // for: a transfer this server may not sign costs no call.
      const build = (blockhash: string, lastValidBlockHeight: number) => ({
        transfer,
        hotWallet: hot.publicKey,
        treasury: allowed.treasury === null ? null : new PublicKey(allowed.treasury),
        usdcMint,
        blockhash,
        lastValidBlockHeight,
      });
      buildSweepTransaction(build(PublicKey.default.toBase58(), 0));
      const { blockhash, lastValidBlockHeight } =
        await getConnection().getLatestBlockhash("confirmed");
      return signSweepTransaction(build(blockhash, lastValidBlockHeight), {
        hotWallet: hot,
        source,
      });
    },

    claim: async (transfer, artifact) => {
      try {
        await db.chainTransfer.create({
          data: {
            kind: transfer.kind,
            network,
            asset: transfer.asset,
            fromAddress: transfer.fromAddress,
            toAddress: transfer.toAddress,
            orgId: transfer.orgId,
            amountRaw: transfer.amountRaw,
            feeLamports: transfer.feeLamports,
            feePayer: transfer.feePayer,
            status: "sent",
            txSignature: artifact.txSignature,
            signedTxB64: artifact.signedTxB64,
            lastValidBlockHeight: artifact.lastValidBlockHeight,
          },
        });
        return true;
      } catch (err) {
        // A "sent" row already holds this address and asset (or this
        // signature): another worker has that money. Nothing was written,
        // so nothing may be sent.
        if (isUniqueViolation(err)) return false;
        throw err;
      }
    },
  };
}

// ============================================
// Production
// ============================================

/** How a run's events reach the log. Nothing here reaches a customer. */
export function logSweepEvent(event: SweepEvent): void {
  switch (event.event) {
    case "settled": {
      const line = {
        id: event.id,
        kind: event.kind,
        asset: event.asset,
        signature: event.signature,
        detail: event.detail,
      };
      if (event.as === "landed") logger.info(line, "Sweep: a transfer landed");
      else logger.warn(line, `Sweep: a transfer ended as ${event.as}`);
      return;
    }
    case "resent":
      logger.info({ id: event.id, signature: event.signature }, "Sweep: the same transfer was sent again");
      return;
    case "resend_error":
    case "fate_unknown":
      logger.warn(
        { id: event.id, signature: event.signature, detail: event.detail },
        event.event === "resend_error"
          ? "Sweep: a transfer could not be sent again"
          : "Sweep: the chain did not say what became of a transfer",
      );
      return;
    case "not_final_yet":
      logger.info(
        { id: event.id, signature: event.signature },
        "Sweep: a transfer reached the chain and is not finalized yet",
      );
      return;
    case "held": {
      const line = {
        reason: event.hold.reason,
        orgId: event.hold.orgId,
        address: event.hold.address,
        asset: event.hold.asset,
      };
      if (event.hold.reason === "no_treasury" || event.hold.reason === "hot_wallet_low_sol") {
        logger.warn(line, "Sweep: money stays where it is");
      } else {
        logger.info(line, "Sweep: money stays where it is for now");
      }
      return;
    }
    case "claimed":
    case "claim_lost":
    case "send_error": {
      const t = event.transfer;
      const line = {
        kind: t.kind,
        asset: t.asset,
        orgId: t.orgId,
        from: t.fromAddress,
        to: t.toAddress,
        amountRaw: t.amountRaw.toString(),
        ...(event.event !== "claim_lost" ? { signature: event.signature } : {}),
        ...(event.event === "send_error" ? { detail: event.detail } : {}),
      };
      if (event.event === "claimed") logger.info(line, "Sweep: a transfer was signed and stored");
      else if (event.event === "claim_lost") logger.info(line, "Sweep: another worker has that money, nothing sent");
      else logger.warn(line, "Sweep: the send threw, the chain will say what became of it");
      return;
    }
    case "error":
    default:
      logger.error(
        { id: event.id, orgId: event.orgId, address: event.address, detail: event.detail },
        "Sweep: error",
      );
  }
}

/** The plan's settings, from config/env.ts. */
export function sweepSettingsFromEnv(): SweepSettings {
  return {
    minUsd: env.SWEEP_MIN_USD,
    maxPerRun: env.SWEEP_MAX_PER_RUN,
    floatUsdc: env.HOT_WALLET_FLOAT_USDC,
    floatSolUsd: env.HOT_WALLET_FLOAT_SOL_USD,
    hotWalletMinLamports: solToLamports(env.HOT_WALLET_MIN_SOL),
  };
}

/** What one run is handed, from config/env.ts. */
export function sweepTickInputFromEnv(): SweepTickInput {
  return {
    enabled: env.SWEEPS_ENABLED,
    intervalMs: env.SWEEP_INTERVAL_MS,
    network: chainLabel(env.SOLANA_NETWORK),
    settings: sweepSettingsFromEnv(),
  };
}

/** The sweep's dependencies, bound to Prisma, the shared connection and
 * the settings. */
export function buildProductionSweepDeps(): SweepTickDeps {
  return buildSweepDeps({
    db: prisma as unknown as SweepDb,
    network: chainLabel(env.SOLANA_NETWORK),
    usdcMint: usdcMintForNetwork(env.SOLANA_NETWORK),
    getConnection: () => getSolanaConnection(),
    checkCluster: () => ensureSolanaCluster(),
    hotWalletKeypair: () => hotWallet.keypair(),
    deriveKeypair: (orgId) =>
      deriveTopupDepositKeypair({
        // Sweeps on means deposits on, which means the wallet rail is on,
        // which means the key is present (config/env.ts). Without it this
        // throws and nothing is moved.
        masterKey: env.WALLET_MASTER_KEY ?? "",
        orgId,
      }),
    treasurySetting: () => env.TREASURY_WALLET_ADDRESS,
    getSolQuote: () => getSolQuote(),
    readSignatureFate: (input) => readSignatureFate(input),
    readOpenPayouts: () =>
      readOpenWalletPayouts(prisma as unknown as OpenPayoutsDb, {
        payoutsRunning: env.PAYOUTS_ENABLED && env.PAYOUT_EXECUTOR_INTERVAL_MS > 0,
        capCents: BigInt(env.PAYOUT_PLATFORM_MAX_PER_DAY_USD) * 100n,
      }),
    log: logSweepEvent,
  });
}
