/**
 * "Prepare address": the platform opens the USDC account at an
 * organization's deposit address, so an exchange that refuses to send
 * USDC to an address without one can send.
 *
 * It costs the hot wallet about 0.002 SOL an account, so it is asked for
 * (never done unasked), only for an organization with a verified email or
 * a purchase, at most DEPOSIT_ACCOUNT_OPENS_PER_DAY times a day in all,
 * and only while the hot wallet holds HOT_WALLET_MIN_SOL.
 *
 * ONE transaction holding ONE instruction: the idempotent "create
 * associated token account". It does nothing when the account exists, so
 * a second send can never cost more than a fee, and no send here moves
 * anything but that rent.
 *
 * `prepareUsdcAccount` is the pure core: every read, write and send is an
 * argument. `buildDepositUsdcChain` binds the chain half to a connection
 * and the hot wallet it is given.
 */

import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  PublicKey,
  Transaction,
  type Connection,
  type Keypair,
} from "@solana/web3.js";

import { createLogger } from "../utils/logger.js";
import type { DepositAddressRead, DepositAddressStore } from "./depositAddresses.js";

const logger = createLogger("deposit-usdc-account");

/** A send under this long ago is not repeated: the account is looked for. */
export const USDC_ACCOUNT_RESEND_AFTER_MS = 2 * 60 * 1000;
/** How long one request looks for the account after a send. */
export const USDC_ACCOUNT_WAIT_MS = 45_000;
/** How often it looks. */
export const USDC_ACCOUNT_POLL_MS = 3_000;

// ============================================
// The core
// ============================================

export interface PrepareUsdcAccountDeps {
  /** The organization's address on this network (never writes). */
  readAddress: (orgId: string) => Promise<DepositAddressRead>;
  store: Pick<
    DepositAddressStore,
    | "markUsdcAccountOpen"
    | "claimUsdcAccountRequest"
    | "countUsdcAccountRequestsSince"
    | "isEligible"
  >;
  /** One read of the USDC account at the address. May throw. */
  usdcAccountExists: (address: string) => Promise<boolean>;
  /** Is the node on the cluster the settings name? Never throws. */
  ensureCluster: () => Promise<{ ok: boolean; reason?: string }>;
  /** The SOL the hot wallet holds, in lamports. May throw. */
  readHotWalletLamports: () => Promise<bigint>;
  /** HOT_WALLET_MIN_SOL, in lamports. */
  minHotWalletLamports: bigint;
  /** DEPOSIT_ACCOUNT_OPENS_PER_DAY. 0 opens none. */
  dailyLimit: number;
  /** Sends the one transaction that opens the account. May throw. */
  sendOpenUsdcAccount: (address: string) => Promise<void>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  waitMs?: number;
  pollMs?: number;
}

export type PrepareUsdcAccountResult =
  | { outcome: "open"; sent: boolean }
  | { outcome: "not_issued" }
  /** The stored address is not the derived one. */
  | { outcome: "address_unavailable" }
  | { outcome: "not_eligible" }
  | { outcome: "daily_limit" }
  | { outcome: "unavailable"; reason: PrepareUnavailableReason };

/** Why, for the log. Never part of an answer. */
export type PrepareUnavailableReason =
  | "cluster"
  | "hot_wallet_unreadable"
  | "hot_wallet_low"
  | "send_failed"
  | "not_seen";

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** Midnight UTC of the day `at` falls in. */
export function startOfUtcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

export async function prepareUsdcAccount(
  deps: PrepareUsdcAccountDeps,
  orgId: string,
): Promise<PrepareUsdcAccountResult> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const waitMs = deps.waitMs ?? USDC_ACCOUNT_WAIT_MS;
  const pollMs = Math.max(1, deps.pollMs ?? USDC_ACCOUNT_POLL_MS);

  const exists = async (address: string): Promise<boolean> => {
    try {
      return await deps.usdcAccountExists(address);
    } catch (err) {
      logger.warn({ err, orgId }, "USDC account of a deposit address could not be read");
      return false;
    }
  };

  // (a) no address on this network.
  const read = await deps.readAddress(orgId);
  if (read.kind === "mismatch") return { outcome: "address_unavailable" };
  if (read.kind === "none") return { outcome: "not_issued" };
  const row = read.row;

  // (b) already open: nothing is sent.
  if (row.usdcAccountOpenedAt) return { outcome: "open", sent: false };
  if (await exists(row.address)) {
    await deps.store.markUsdcAccountOpen({ orgId, at: now(), by: null });
    return { outcome: "open", sent: false };
  }

  // (c) who may ask the platform to pay for it.
  if (!(await deps.store.isEligible(orgId))) return { outcome: "not_eligible" };

  // (d) an open was sent for this address a moment ago: send nothing and
  // look for the account.
  const startedAt = now();
  const requestedAt = row.usdcAccountRequestedAt;
  const sentRecently =
    requestedAt !== null &&
    startedAt.getTime() - requestedAt.getTime() < USDC_ACCOUNT_RESEND_AFTER_MS;

  let sent = false;
  if (!sentRecently) {
    // (e) the day's limit. A soft guard on a small cost: no lock.
    const today = await deps.store.countUsdcAccountRequestsSince(
      startOfUtcDay(startedAt),
    );
    if (today >= deps.dailyLimit) {
      logger.warn({ orgId, today, dailyLimit: deps.dailyLimit }, "daily limit of USDC account opens reached");
      return { outcome: "daily_limit" };
    }

    // (f) the right chain, and a hot wallet that can pay.
    const cluster = await deps.ensureCluster();
    if (!cluster.ok) {
      logger.error({ reason: cluster.reason }, "Solana cluster check refused");
      return { outcome: "unavailable", reason: "cluster" };
    }
    let held: bigint;
    try {
      held = await deps.readHotWalletLamports();
    } catch (err) {
      logger.error({ err }, "hot wallet balance could not be read");
      return { outcome: "unavailable", reason: "hot_wallet_unreadable" };
    }
    if (held < deps.minHotWalletLamports) {
      logger.error(
        { heldLamports: held.toString(), minLamports: deps.minHotWalletLamports.toString() },
        "hot wallet holds less than HOT_WALLET_MIN_SOL; no USDC account is opened",
      );
      return { outcome: "unavailable", reason: "hot_wallet_low" };
    }

    // (g) take the send by compare-and-set on what was read. Losing it
    // means another request is sending: that is (d).
    const claimed = await deps.store.claimUsdcAccountRequest({
      orgId,
      expected: requestedAt,
      at: startedAt,
    });
    if (claimed) {
      try {
        await deps.sendOpenUsdcAccount(row.address);
        sent = true;
      } catch (err) {
        logger.error({ err, orgId }, "sending the open of a USDC account failed");
        return { outcome: "unavailable", reason: "send_failed" };
      }
    }
  }

  // (h) look for the account.
  let waited = 0;
  for (;;) {
    if (await exists(row.address)) {
      await deps.store.markUsdcAccountOpen({ orgId, at: now(), by: "platform" });
      return { outcome: "open", sent };
    }
    if (waited >= waitMs) break;
    const step = Math.min(pollMs, waitMs - waited);
    await sleep(step);
    waited += step;
  }
  logger.warn({ orgId, sent }, "USDC account not seen within the wait");
  return { outcome: "unavailable", reason: "not_seen" };
}

// ============================================
// The chain
// ============================================

/** Is this account a token account? An address that only holds SOL is not. */
export function isTokenAccount(
  account: { owner: PublicKey; data: { byteLength: number } } | null | undefined,
): boolean {
  // A token account is 165 bytes (more with extensions).
  return !!account && account.owner.equals(TOKEN_PROGRAM_ID) && account.data.byteLength >= 165;
}

/**
 * The one transaction "Prepare address" sends: the fee payer is the hot
 * wallet and the only instruction is the idempotent create of the
 * address's associated token account for the mint.
 */
export function buildOpenUsdcAccountTransaction(input: {
  payer: PublicKey;
  owner: PublicKey;
  usdcMint: PublicKey;
  blockhash: string;
  lastValidBlockHeight: number;
}): Transaction {
  const tx = new Transaction({
    feePayer: input.payer,
    blockhash: input.blockhash,
    lastValidBlockHeight: input.lastValidBlockHeight,
  });
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      input.payer,
      getAssociatedTokenAddressSync(input.usdcMint, input.owner),
      input.owner,
      input.usdcMint,
    ),
  );
  return tx;
}

export type DepositUsdcConnection = Pick<
  Connection,
  "getAccountInfo" | "getLatestBlockhash" | "sendRawTransaction"
>;

export interface DepositUsdcChain {
  usdcAccountExists: (address: string) => Promise<boolean>;
  sendOpenUsdcAccount: (address: string) => Promise<void>;
}

export function buildDepositUsdcChain(input: {
  getConnection: () => DepositUsdcConnection;
  ensureCluster: () => Promise<{ ok: boolean; reason?: string }>;
  usdcMint: PublicKey;
  /** The hot wallet's keypair. May throw. */
  hotWalletKeypair: () => Keypair;
}): DepositUsdcChain {
  const { getConnection, usdcMint } = input;

  // Nothing is read from, or sent to, a node on another chain.
  async function onTheRightChain(): Promise<void> {
    const check = await input.ensureCluster();
    if (!check.ok) {
      throw new Error(`Solana cluster check refused: ${check.reason ?? "unknown"}`);
    }
  }

  return {
    usdcAccountExists: async (address) => {
      await onTheRightChain();
      const account = await getConnection().getAccountInfo(
        getAssociatedTokenAddressSync(usdcMint, new PublicKey(address)),
        "confirmed",
      );
      return isTokenAccount(account);
    },

    sendOpenUsdcAccount: async (address) => {
      await onTheRightChain();
      const payer = input.hotWalletKeypair();
      const { blockhash, lastValidBlockHeight } =
        await getConnection().getLatestBlockhash("confirmed");
      const tx = buildOpenUsdcAccountTransaction({
        payer: payer.publicKey,
        owner: new PublicKey(address),
        usdcMint,
        blockhash,
        lastValidBlockHeight,
      });
      tx.sign(payer);
      await getConnection().sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      });
    },
  };
}
