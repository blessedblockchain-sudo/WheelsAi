/**
 * Production wiring for a creator's payouts (routes/payouts.ts).
 *
 * Three parts, so each can be given a stand-in:
 *   - buildPayoutAddressRead(getConnection): the ONE chain read a request
 *     makes, for the address a wallet payout is sent to.
 *   - payoutPlatformAddresses(settings, orgId): the addresses that are the
 *     platform's own, which a creator must never be paid to.
 *   - buildProductionPayoutRouteDeps(): the two above and the cores of
 *     services/payoutRequests.ts, bound to Prisma, the connection and
 *     config/env.ts.
 */

import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, type Connection } from "@solana/web3.js";
import type { FastifyPluginAsync } from "fastify";

import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { ensureSolanaCluster, getSolanaConnection } from "../lib/solana.js";
import { errorDetail } from "../services/buildSolPriceDeps.js";
import { derivePayoutKeypair } from "../services/payoutKeypair.js";
import {
  buildCancelPayoutDeps,
  buildRequestPayoutDeps,
  cancelPayout,
  listPayouts,
  payoutAvailability,
  payoutRequestSettingsFromEnv,
  requestPayout,
  type CancelPayoutDb,
  type PayoutReadsDb,
  type PayoutRequestInput,
  type RequestPayoutDb,
  type RequestPayoutDeps,
  type RequestPayoutResult,
} from "../services/payoutRequests.js";
import type { AddressOnChain } from "../services/payoutRules.js";
import { deriveTopupDepositKeypair } from "../services/topupKeypairs.js";
import { createLogger } from "../utils/logger.js";
import { createPayoutRoutes, type PayoutRouteDeps } from "./payouts.js";

const logger = createLogger("payout-bindings");

/** The longest a request waits for the chain's word on an address. */
export const PAYOUT_ADDRESS_READ_WAIT_MS = 8_000;

// ============================================
// The chain read
// ============================================

export type PayoutAddressConnection = Pick<Connection, "getAccountInfo">;

/**
 * ONE read of the account at the address. No account there yet is an unused
 * wallet, which is fine. An account owned by a token program is a token
 * account or a mint, and an executable one is a program: money sent to
 * either is lost to the creator. Anything else is a wallet. Never throws: a
 * failed, refused or slow read is "unavailable", and the reason goes to the
 * log only.
 */
export function buildPayoutAddressRead(input: {
  getConnection: () => PayoutAddressConnection;
  /** Is the node on the chain the settings name? Asked before the read. */
  ensureCluster?: () => Promise<{ ok: boolean }>;
  waitMs?: number;
}): (address: string) => Promise<AddressOnChain> {
  const waitMs = input.waitMs ?? PAYOUT_ADDRESS_READ_WAIT_MS;

  return async (address) => {
    let timer: NodeJS.Timeout | undefined;
    try {
      const read = (async (): Promise<AddressOnChain> => {
        // An address read on the wrong chain says nothing about the chain
        // the payout would be sent on.
        if (input.ensureCluster) {
          const cluster = await input.ensureCluster();
          if (!cluster || cluster.ok !== true) return "unavailable";
        }
        const account = await input.getConnection().getAccountInfo(new PublicKey(address), "confirmed");
        if (account === null) return "absent";
        if (typeof account !== "object" || !account.owner) return "unavailable";
        if (account.executable === true) return "not_a_wallet";
        const owner = new PublicKey(account.owner);
        if (owner.equals(TOKEN_PROGRAM_ID) || owner.equals(TOKEN_2022_PROGRAM_ID)) return "not_a_wallet";
        return "wallet";
      })();
      const limit = new Promise<AddressOnChain>((resolve) => {
        timer = setTimeout(() => resolve("unavailable"), waitMs);
      });
      const answer = await Promise.race([read, limit]);
      if (answer === "unavailable") logger.warn("payout address read gave no answer");
      return answer;
    } catch (err) {
      logger.warn({ detail: errorDetail(err) }, "payout address read failed");
      return "unavailable";
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

// ============================================
// The platform's own addresses
// ============================================

/** The address nobody controls, which TREASURY_WALLET_ADDRESS defaults to. */
const SYSTEM_PROGRAM_ADDRESS = "11111111111111111111111111111111";

/**
 * The paying wallet, the treasury and this organization's own deposit
 * address. Without WALLET_MASTER_KEY the derived two cannot be worked out
 * and this throws: a wallet payout is not planned against a list that may
 * be missing an address.
 */
export function payoutPlatformAddresses(
  settings: { WALLET_MASTER_KEY?: string | undefined; TREASURY_WALLET_ADDRESS: string },
  orgId: string,
): string[] {
  const masterKey = settings.WALLET_MASTER_KEY ?? "";
  const own = [
    derivePayoutKeypair(masterKey).publicKey.toBase58(),
    deriveTopupDepositKeypair({ masterKey, orgId }).publicKey.toBase58(),
  ];
  // The default treasury is the System Program: a program, which the chain
  // read refuses with the sentence that fits it.
  if (settings.TREASURY_WALLET_ADDRESS && settings.TREASURY_WALLET_ADDRESS !== SYSTEM_PROGRAM_ADDRESS) {
    own.push(settings.TREASURY_WALLET_ADDRESS);
  }
  return own;
}

// ============================================
// Production
// ============================================

export function buildProductionRequestPayoutDeps(): RequestPayoutDeps {
  return buildRequestPayoutDeps(prisma as unknown as RequestPayoutDb, {
    // Read per request, so a changed setting needs no new binding.
    settings: () => payoutRequestSettingsFromEnv(env),
    platformAddresses: (orgId) => payoutPlatformAddresses(env, orgId),
    readAddressOnChain: buildPayoutAddressRead({
      getConnection: () => getSolanaConnection(),
      ensureCluster: () => ensureSolanaCluster(),
    }),
  });
}

/**
 * Request a payout with the production wiring, for code that is not a route
 * (apps/api/scripts). The same checks, the same one transaction.
 */
export function requestPayoutProduction(input: PayoutRequestInput): Promise<RequestPayoutResult> {
  return requestPayout(buildProductionRequestPayoutDeps(), input);
}

export function buildProductionPayoutRouteDeps(): PayoutRouteDeps {
  const requestDeps = buildProductionRequestPayoutDeps();
  const cancelDeps = buildCancelPayoutDeps(prisma as unknown as CancelPayoutDb);
  return {
    payoutsAvailable: () => payoutAvailability(() => env).available,
    requestPayout: (input) => requestPayout(requestDeps, input),
    cancelPayout: (input) => cancelPayout(cancelDeps, input),
    listPayouts: (orgId) => listPayouts(prisma as unknown as PayoutReadsDb, orgId),
  };
}

export function createPayoutRoutesProduction(): FastifyPluginAsync {
  return createPayoutRoutes(buildProductionPayoutRouteDeps());
}
