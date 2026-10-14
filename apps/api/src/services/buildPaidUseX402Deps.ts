/**
 * Composition root for one use paid from a wallet at a listing's x402 door
 * (services/paidUseX402.ts, runX402Use): binds the pure core to the real
 * agent, the real chain and the database, once per process.
 *
 *   the agent and its listing  paid use's reads (services/buildPaidUseDeps.ts),
 *                              the listing with the creator's switch, its
 *                              workflow marker and its one line
 *   the answer                 paid use's own prepareChat, with the door's
 *                              metering (beginX402Metering), which charges
 *                              nothing and notes the model cost for the sale
 *   the limits                 the one fail-closed limiter of the process
 *                              (publicChatLimiter) and paid use's numbers
 *   the chain                  the shared connection, asked first whether it
 *                              is on the cluster SOLANA_NETWORK names
 *   the payment rows and sale  services/buildX402PaymentsDeps.ts
 *   the fee payer              derived ONCE from WALLET_MASTER_KEY and handed
 *                              only to signAsFeePayer, which checks again the
 *                              exact bytes it is given
 *   the shutdown slot          a set of in-flight uses of the door's own,
 *                              cancelled on SIGTERM (cancelInFlightX402Uses)
 *
 * Whether the door is usable is ONE answer, x402DoorUsable: its settings
 * are on (x402DoorOpen) and its fee payer is a wallet of its own, neither the
 * treasury nor the payout wallet. The capabilities read it (the Sell tab
 * offers the switch only when it holds) and so does this binding: when the
 * fee payer collides, every use the door would serve is answered 503
 * x402_unavailable, logged once.
 *
 * Building it connects to nothing; the limiter's Redis and the chain's
 * connection open on first use.
 */

import { randomBytes } from "node:crypto";

import type { Keypair } from "@solana/web3.js";

import { env, type Env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { ensureSolanaCluster, getSolanaConnection } from "../lib/solana.js";
import { usdcMintForNetwork } from "../lib/solanaAssets.js";
import { createLogger } from "../utils/logger.js";
import { productionPaidUseDeps } from "./buildPaidUseDeps.js";
import { publicChatLimiter } from "./buildPublicChatDeps.js";
import {
  buildX402DoorPaymentsDeps,
  recordX402SaleInTransaction,
  X402_FATE_READ_TIMEOUT_MS,
  x402DoorChainReads,
  type X402DoorConnection,
} from "./buildX402PaymentsDeps.js";
import { createInFlightRuns } from "./inFlightRuns.js";
import { PAID_USE_LIMITS, type PaidUseDeps } from "./paidUse.js";
import { paidListingPausedNow } from "./paidUsePause.js";
import { createX402AnswerMaker, type X402DoorWire, type X402ListingRow, type X402UseDeps } from "./paidUseX402.js";
import { derivePayoutKeypair } from "./payoutKeypair.js";
import { USE_LISTING_COLUMNS } from "./useListing.js";
import { beginX402Metering } from "./useMeteringProduction.js";
import { hashBucket, ipBucket } from "./widgetKeys.js";
import { x402NetworkFor } from "./x402.js";
import { x402DoorOpenNow, x402DoorSettingsOf, type X402DoorEnv } from "./x402DoorSettings.js";
import { deriveX402FeePayerKeypair, signAsFeePayer } from "./x402FeePayer.js";
import { x402ResourceUrl } from "./x402Wire.js";

const logger = createLogger("x402-door");

// ============================================
// Whether the door is usable
// ============================================

// The settings, and whether they open the door, live in a light module of
// their own that the routes read without loading this binding.
export { x402DoorOpenNow, x402DoorSettingsOf };
export type { X402DoorEnv };

/**
 * Why a fee payer cannot be the door's: it is the treasury (payTo, whose key
 * the product does not hold) or the payout wallet (which pays creators). The
 * fee payer signs strangers' transactions and must never be either. Null
 * when it is a wallet of its own.
 */
export function x402FeePayerConflict(wallets: {
  feePayer: string;
  treasury: string | null | undefined;
  payout: string;
}): "treasury" | "payout" | null {
  if (wallets.treasury && wallets.feePayer === wallets.treasury) return "treasury";
  if (wallets.feePayer === wallets.payout) return "payout";
  return null;
}

/** The fee payer of one master key, derived once, with the payout wallet it must not be. */
let derived: { masterKey: string; keypair: Keypair; address: string; payout: string } | null = null;

function feePayerOfKey(masterKey: string): { keypair: Keypair; address: string; payout: string } {
  if (derived?.masterKey !== masterKey) {
    const keypair = deriveX402FeePayerKeypair(masterKey);
    derived = {
      masterKey,
      keypair,
      address: keypair.publicKey.toBase58(),
      payout: derivePayoutKeypair(masterKey).publicKey.toBase58(),
    };
  }
  return derived;
}

/** The door's fee payer, or why there is none. The keypair never leaves this file but to signAsFeePayer. */
type FeePayerReading =
  | { ok: true; keypair: Keypair; address: string }
  | { ok: false; reason: "closed" | "underived" | "treasury" | "payout" };

function readFeePayer(settings: X402DoorEnv): FeePayerReading {
  if (!x402DoorOpenNow(settings)) return { ok: false, reason: "closed" };
  const masterKey = settings.WALLET_MASTER_KEY;
  if (typeof masterKey !== "string") return { ok: false, reason: "closed" };
  let wallet: { keypair: Keypair; address: string; payout: string };
  try {
    wallet = feePayerOfKey(masterKey);
  } catch {
    return { ok: false, reason: "underived" };
  }
  const conflict = x402FeePayerConflict({
    feePayer: wallet.address,
    treasury: settings.TREASURY_WALLET_ADDRESS,
    payout: wallet.payout,
  });
  if (conflict) return { ok: false, reason: conflict };
  return { ok: true, keypair: wallet.keypair, address: wallet.address };
}

/**
 * Whether the door can take a payment now: its settings are on and its fee
 * payer is a wallet of its own. The ONE answer the capabilities and this
 * binding read, so the Sell tab never offers a switch whose door answers
 * 503. Never throws.
 */
export function x402DoorUsable(settings: X402DoorEnv = env): boolean {
  try {
    return readFeePayer(settings).ok;
  } catch {
    return false;
  }
}

/** The fee payer's address when the door is usable, for the operator to fund; null otherwise. */
export function x402FeePayerAddress(settings: X402DoorEnv = env): string | null {
  try {
    const reading = readFeePayer(settings);
    return reading.ok ? reading.address : null;
  } catch {
    return null;
  }
}

// ============================================
// The shutdown slots
// ============================================

const inFlightX402Uses = createInFlightRuns();

/**
 * Called on SIGTERM beside the paid workflow runs. A use whose payment is
 * still only held stops with nothing sent; one already sent is waited for
 * (up to `timeoutMs`), so its confirmation and its sale are written. A use
 * still waiting when the process ends leaves its row submitted for the
 * settlement worker.
 */
export function cancelInFlightX402Uses(timeoutMs: number) {
  return inFlightX402Uses.cancelAll(timeoutMs);
}

// ============================================
// The binding
// ============================================

/** What the door reads of the listing: paid use's columns, the workflow marker and the one line. */
export const X402_LISTING_COLUMNS = {
  ...USE_LISTING_COLUMNS,
  orchestrationId: true,
  shortDescription: true,
} as const;

/** The one read of a listing the door makes. Prisma's client satisfies it. */
export interface X402ListingDb {
  agentListing: {
    findUnique(args: {
      where: { agentId: string };
      select: typeof X402_LISTING_COLUMNS;
    }): Promise<(Omit<X402ListingRow, "agentId"> & { agentId: string | null }) | null>;
  };
}

/** The settings the binding reads per use. */
export type X402BindingEnv = X402DoorEnv & Pick<Env, "JWT_SECRET">;

/** Where the binding takes each thing from. Each defaults to production; a test hands in stand-ins. */
export interface X402BindingSources {
  env: () => X402BindingEnv;
  /** Paid use's reads and its chat: the door makes its answer as a buyer's is made. */
  paidUse: () => Pick<PaidUseDeps, "loadAgentByHandle" | "prepareChat" | "outboundToolNames">;
  db: X402ListingDb;
  limiter: X402UseDeps["limiter"];
  /** The connection the chain is read on. */
  connection: () => X402DoorConnection;
  /** Whether the node behind the connection is on the cluster SOLANA_NETWORK names. */
  clusterOk: () => Promise<boolean>;
  /** How long the cluster check may take before the node counts as not there. */
  clusterTimeoutMs: number;
  pausedNow: X402UseDeps["pausedNow"];
  payments: () => X402UseDeps["payments"];
  recordSale: X402UseDeps["recordSale"];
  now: () => Date;
  logger: NonNullable<X402UseDeps["logger"]>;
}

function productionSources(): X402BindingSources {
  return {
    env: () => env,
    paidUse: productionPaidUseDeps,
    db: prisma,
    limiter: publicChatLimiter,
    connection: getSolanaConnection,
    clusterOk: async () => {
      try {
        return (await ensureSolanaCluster()).ok;
      } catch {
        return false;
      }
    },
    clusterTimeoutMs: X402_FATE_READ_TIMEOUT_MS,
    pausedNow: (args) => paidListingPausedNow(args),
    payments: buildX402DoorPaymentsDeps,
    recordSale: recordX402SaleInTransaction,
    now: () => new Date(),
    logger,
  };
}

class X402DoorClosedError extends Error {
  constructor(why: string) {
    super(`x402 door not available: ${why}`);
    this.name = "X402DoorClosedError";
  }
}

export function buildPaidUseX402Deps(over: Partial<X402BindingSources> = {}): X402UseDeps {
  const sources: X402BindingSources = { ...productionSources(), ...over };
  const log = sources.logger;

  let toldWhy: string | null = null;
  /** The fee payer, or the door closed. A collision is logged once, not on every call. */
  const feePayer = (): { keypair: Keypair; address: string } => {
    const reading = readFeePayer(sources.env());
    if (reading.ok) return reading;
    if (reading.reason !== "closed" && toldWhy !== reading.reason) {
      toldWhy = reading.reason;
      log.error(
        { reason: reading.reason },
        reading.reason === "underived"
          ? "x402 door closed: its fee payer could not be derived from the master key"
          : `x402 door closed: its fee payer is the ${reading.reason} wallet; every use it would serve is answered 503`,
      );
    }
    throw new X402DoorClosedError(reading.reason);
  };

  /** Every read of the chain is made on the cluster the settings name, or not at all. */
  const reads = x402DoorChainReads(sources.connection);
  // The cluster check is a read of the node too, and is bound like the others:
  // a node that does not answer in time is a node the door does not use.
  const clusterOkInTime = (): Promise<boolean> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), sources.clusterTimeoutMs);
      sources.clusterOk().then(
        (ok) => {
          clearTimeout(timer);
          resolve(ok);
        },
        () => {
          clearTimeout(timer);
          resolve(false);
        },
      );
    });
  const onCluster = async (): Promise<void> => {
    if (!(await clusterOkInTime())) {
      throw new Error("x402 door: the node is not on the cluster SOLANA_NETWORK names, or cannot be reached");
    }
  };

  const makeAnswer = createX402AnswerMaker({
    // Paid use's own chat, as a buyer's answer is made; only the metering is the door's.
    prepareChat: (input, beginMetering) => sources.paidUse().prepareChat(input, beginMetering),
    beginMetering: (args) => beginX402Metering(args),
    outboundToolNames: () => sources.paidUse().outboundToolNames(),
    limits: PAID_USE_LIMITS,
    now: sources.now,
  });

  return {
    limiter: sources.limiter,
    limits: PAID_USE_LIMITS,

    loadAgentByHandle: (handle) => sources.paidUse().loadAgentByHandle(handle),

    // The agent's one listing, in any state: the core judges it. One with no
    // agent is not this agent's and is answered as no listing.
    loadListing: async (agentId) => {
      const listing = await sources.db.agentListing.findUnique({ where: { agentId }, select: X402_LISTING_COLUMNS });
      return listing && listing.agentId !== null ? { ...listing, agentId: listing.agentId } : null;
    },

    pausedNow: sources.pausedNow,

    wire: (): X402DoorWire => {
      const settings = sources.env();
      const network = settings.SOLANA_NETWORK;
      const treasury = settings.TREASURY_WALLET_ADDRESS;
      if (network === undefined || !treasury) throw new X402DoorClosedError("its settings are not all there");
      const { address } = feePayer();
      return {
        network,
        rowNetwork: x402NetworkFor(network),
        usdcMint: usdcMintForNetwork(network).toBase58(),
        treasury,
        feePayer: address,
        memoSecret: settings.JWT_SECRET,
      };
    },

    chain: {
      accounts: async (input) => {
        await onCluster();
        return reads.accounts(input);
      },
      blockhashValid: async (blockhash) => {
        await onCluster();
        return reads.blockhashValid(blockhash);
      },
      simulate: async (transactionB64) => {
        await onCluster();
        return reads.simulate(transactionB64);
      },
    },

    payments: sources.payments(),

    // The key goes to signAsFeePayer and nowhere else; it checks the bytes again.
    signAsFeePayer: (transactionB64, requirements) =>
      signAsFeePayer(transactionB64, requirements, feePayer().keypair),

    makeAnswer,
    recordSale: sources.recordSale,
    inFlight: inFlightX402Uses,
    now: sources.now,
    nonce: () => new Uint8Array(randomBytes(16)),
    logger: log,
  };
}

let production: X402UseDeps | null = null;

/** The one set of door deps of this process: /api/a and /v1 share its limits, its slots and its fee payer. */
export function productionPaidUseX402Deps(): X402UseDeps {
  return (production ??= buildPaidUseX402Deps());
}

// ============================================
// What a route needs of the door
// ============================================

/** The door as a route takes it. */
export interface X402DoorBinding {
  /** The door's deps, built on first use. */
  use(): X402UseDeps;
  /** The use address as the published format names it: PUBLIC_API_URL and the path. Throws when it is not set. */
  resourceUrl(path: string): string;
  /** A caller's address bucket, as the public page builds it: never a raw address. */
  bucketOf(ip: string | undefined): string;
}

export function x402DoorBindingOf(sources: { env: () => X402BindingEnv; use: () => X402UseDeps }): X402DoorBinding {
  return {
    use: sources.use,
    resourceUrl: (path) => {
      const base = sources.env().PUBLIC_API_URL;
      if (!base) throw new X402DoorClosedError("there is no public address to name a use by");
      return x402ResourceUrl(base, path);
    },
    bucketOf: (ip) => hashBucket(ipBucket(ip), sources.env().JWT_SECRET),
  };
}

let productionDoor: X402DoorBinding | null = null;

/** The production door, for routes/paidUseBindings.ts and /v1. */
export function productionX402Door(): X402DoorBinding {
  return (productionDoor ??= x402DoorBindingOf({ env: () => env, use: productionPaidUseX402Deps }));
}
