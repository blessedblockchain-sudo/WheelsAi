/**
 * POST /tokens/launch/prepare + POST /tokens/launch/submit — pump.fun
 * agent token launch via browser-partial-sign (plan A1 Phase 1.5).
 *
 * Two-step browser-signed flow:
 *
 *   prepare
 *     1. Auth gate (must have a connected wallet — the creator).
 *     2. Eligibility check — 400 with reasons if not eligible. Zero
 *        side effects on the not-eligible path.
 *     3. Generate ephemeral mint Keypair (server-side, discarded after
 *        this request — the partial-signed tx embeds its signature).
 *     4. buildPumpfunCreateRequest with the *user's wallet* as creator
 *        — NOT a server-derived custodial key.
 *     5. preparePumpfunCreate — POST pumpportal /api/trade-local +
 *        sign mint slot only + return base64 partial-signed tx.
 *     6. Sign an HMAC prepare token that carries (mintAddress,
 *        agentListingId, orgId, creatorPubkey, symbol, description,
 *        imageUri). The token is what /submit consumes; without it the
 *        server has no way to know what /submit was meant to broadcast.
 *
 *   submit
 *     1. Auth gate.
 *     2. Verify prepare token (HMAC + expiry).
 *     3. Cross-check orgId + creatorPubkey against the authenticated
 *        user. Prevents prepare-token forwarding between users/orgs.
 *     4. broadcastSignedPumpfunCreate — validates the signed tx
 *        actually references the expected mint + creator and that
 *        every signer slot is populated, then RPC-submits.
 *     5. persistAgentTokenWithTreasury — atomic AgentToken +
 *        AgentTreasury insert.
 *
 * Failure-recovery contract:
 *   prepare:
 *     - 400 not_eligible           → no side effects
 *     - 400 wallet_required        → no side effects
 *     - 400 listing_required       → no side effects
 *     - 502 pumpfun_prepare_failed → no side effects
 *   submit:
 *     - 400 prepare_token_invalid  → no side effects
 *     - 400 org/creator_mismatch   → no side effects
 *     - 502 pumpfun_submit_failed  → no AgentToken row
 *     - 500 persistence_failed     → response surfaces mintAddress +
 *       txSignature so the wizard can recover (mint exists on-chain).
 */

import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import type { FastifyPluginAsync } from "fastify";

import {
  checkTokenEligibility,
  CREATOR_LOCKUP_DAYS,
  type EligibilityResult,
} from "../services/tokenEligibility.js";
import {
  signPrepareToken,
  verifyPrepareToken,
} from "../services/launchpadPrepareToken.js";
import type {
  LaunchpadAdapter,
  LaunchTokenMetadata,
  PrepareLaunchResult,
  BroadcastLaunchResult,
} from "../services/launchpad/types.js";
import { deriveTreasuryPda } from "../lib/programs/agentTreasury.js";
import { createLogger } from "../utils/logger.js";
import type { EligibilityState } from "./tokenLaunch.js";

const logger = createLogger("token-launch-partial-sign");

// ============================================
// Schemas
// ============================================

const prepareBodySchema = z.object({
  agentId: z.string().min(1),
  // The on-chain + DB token name. Editable by the creator in the wizard;
  // single source of truth (was previously split across agent.name and
  // listing.title).
  name: z.string().min(2).max(32),
  symbol: z.string().min(2).max(10),
  description: z.string(),
  imageUri: z.string().optional(),
  twitter: z.string().optional(),
  telegram: z.string().optional(),
  website: z.string().optional(),
  initialBuySol: z.number().nonnegative().optional(),
});

const submitBodySchema = z.object({
  prepareToken: z.string().min(1),
  signedTxBase64: z.string().min(1),
});

// Recovery path: the broadcast already landed on-chain (the mint exists)
// but the DB persist failed, so the client retries persistence with the
// mint + tx it received in the persistence_failed response.
const reconcileBodySchema = z.object({
  prepareToken: z.string().min(1),
  mintAddress: z.string().min(1),
  txSignature: z.string().min(1),
});

// ============================================
// DI surface
// ============================================

export interface PersistAgentTokenWithTreasuryInput {
  agentListingId: string;
  orgId: string;
  mintAddress: string;
  txSignature: string;
  creatorAddress: string;
  creatorLockupEnd: Date;
  name: string;
  symbol: string;
  description: string;
  imageUri?: string;
  /** Launchpad that minted this token ("pumpfun" | "bags"). */
  launchpad: string;
  /** Bags Meteora fee-share config key; undefined for pump.fun. */
  meteoraConfigKey?: string;
  treasuryPdaAddress: string;
  treasuryAuthorityBump: number;
}

export interface PersistAgentTokenWithTreasuryResult {
  tokenId: string;
  creatorLockupEnd: Date;
}

export interface ReconcileLaunchResult {
  tokenId: string;
  creatorLockupEnd: Date;
  /** True when the token row already existed (idempotent replay). */
  alreadyExisted: boolean;
}

export interface PartialSignTokenRouteDeps {
  loadEligibilityState: (args: {
    agentId: string;
    orgId: string;
  }) => Promise<EligibilityState | null>;
  /**
   * Resolve the AgentListing.id for a given agentId+orgId. Returns
   * null when the agent has not been published.
   */
  resolveAgentListingId: (args: {
    agentId: string;
    orgId: string;
  }) => Promise<string | null>;
  /**
   * The active launchpad (pump.fun or Bags). Owns all launchpad-specific
   * network + signing; the route only knows the prepare/broadcast contract.
   */
  launchpad: LaunchpadAdapter;
  persistAgentTokenWithTreasury: (
    input: PersistAgentTokenWithTreasuryInput,
  ) => Promise<PersistAgentTokenWithTreasuryResult>;
  /**
   * Idempotent persistence for the recovery path: returns the existing
   * token row if one already exists for the mint, otherwise persists.
   */
  reconcileLaunch: (
    input: PersistAgentTokenWithTreasuryInput,
  ) => Promise<ReconcileLaunchResult>;
  /**
   * Optional on-chain existence check — guards reconcile against creating
   * a DB row for a mint that never actually broadcast. Undefined skips it.
   */
  confirmMintOnChain?: (mintAddress: string) => Promise<boolean>;
  prepareTokenSecret: string;
  prepareTokenTtlSeconds?: number;
  now?: () => Date;
}

// ============================================
// Plugin
// ============================================

export function createPartialSignTokenRoutes(
  deps: PartialSignTokenRouteDeps,
): FastifyPluginAsync {
  const now = deps.now ?? (() => new Date());

  return async (app) => {
    // ============================================
    // POST /launch/prepare  (mounted under /api/tokens)
    // ============================================
    app.post("/launch/prepare", async (request, reply) => {
      if (!request.auth) {
        return reply.status(401).send({ error: "unauthenticated" });
      }
      const { orgId, walletAddress } = request.auth;
      if (!walletAddress) {
        return reply.status(400).send({
          error: "wallet_required",
          message:
            "Connect a Solana wallet before launching a token — partial-sign needs an on-chain creator pubkey.",
        });
      }

      const parsed = prepareBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_payload",
          details: parsed.error.flatten(),
        });
      }
      const body = parsed.data;

      const state = await deps.loadEligibilityState({
        agentId: body.agentId,
        orgId,
      });
      if (!state) {
        return reply.status(404).send({ error: "agent_not_found" });
      }
      const eligibility: EligibilityResult = checkTokenEligibility({
        reputationScore: state.reputationScore,
        deploymentAgeDays: state.deploymentAgeDays,
        hasPublishedListing: state.hasPublishedListing,
        alreadyTokenized: state.alreadyTokenized,
        creatorAddress: walletAddress,
      });
      if (!eligibility.eligible) {
        return reply.status(400).send({
          error: "not_eligible",
          reasons: eligibility.reasons,
        });
      }

      const agentListingId = await deps.resolveAgentListingId({
        agentId: body.agentId,
        orgId,
      });
      if (!agentListingId) {
        return reply.status(400).send({
          error: "listing_required",
          message:
            "Agent must be published to the marketplace before tokenization.",
        });
      }

      const metadata: LaunchTokenMetadata = {
        name: body.name,
        symbol: body.symbol,
        imageUrl: body.imageUri ?? "",
        description: body.description,
        twitter: body.twitter,
        telegram: body.telegram,
        website: body.website,
      };

      let prepared: PrepareLaunchResult;
      try {
        prepared = await deps.launchpad.prepareLaunch({
          creatorPubkey: walletAddress,
          metadata,
          initialBuySol: body.initialBuySol,
        });
      } catch (err) {
        logger.error(
          { err, agentId: body.agentId, launchpad: deps.launchpad.id },
          "launch prepare failed",
        );
        return reply.status(502).send({
          error: "launch_prepare_failed",
          message: (err as Error).message,
        });
      }

      const prepareToken = signPrepareToken({
        payload: {
          mintAddress: prepared.mintAddress,
          agentListingId,
          orgId,
          creatorPubkey: walletAddress,
          name: body.name,
          symbol: body.symbol,
          description: body.description,
          imageUri: body.imageUri,
          launchpad: deps.launchpad.id,
          context: prepared.context,
        },
        secret: deps.prepareTokenSecret,
        ttlSeconds: deps.prepareTokenTtlSeconds,
        now,
      });

      return reply.status(200).send({
        partialSignedTxBase64: prepared.partialSignedTxBase64,
        mintAddress: prepared.mintAddress,
        creatorPubkey: prepared.creatorPubkey,
        prepareToken,
      });
    });

    // ============================================
    // POST /launch/submit  (mounted under /api/tokens)
    // ============================================
    app.post("/launch/submit", async (request, reply) => {
      if (!request.auth) {
        return reply.status(401).send({ error: "unauthenticated" });
      }
      const { orgId, walletAddress } = request.auth;
      if (!walletAddress) {
        return reply.status(400).send({ error: "wallet_required" });
      }

      const parsed = submitBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_payload",
          details: parsed.error.flatten(),
        });
      }
      const body = parsed.data;

      const verified = verifyPrepareToken({
        token: body.prepareToken,
        secret: deps.prepareTokenSecret,
        now,
      });
      if (!verified.ok) {
        return reply.status(400).send({
          error: "prepare_token_invalid",
          reason: verified.reason,
        });
      }
      const tokenPayload = verified.payload;

      if (tokenPayload.orgId !== orgId) {
        return reply.status(400).send({
          error: "prepare_token_org_mismatch",
        });
      }
      if (tokenPayload.creatorPubkey !== walletAddress) {
        return reply.status(400).send({
          error: "prepare_token_creator_mismatch",
        });
      }
      // The active launchpad must match the one that prepared this token —
      // a redeploy that flips LAUNCHPAD would otherwise hand the new
      // adapter a context it can't interpret.
      if (tokenPayload.launchpad !== deps.launchpad.id) {
        return reply.status(400).send({
          error: "prepare_token_launchpad_mismatch",
          expected: deps.launchpad.id,
          got: tokenPayload.launchpad,
        });
      }

      let mintPub: PublicKey;
      try {
        mintPub = new PublicKey(tokenPayload.mintAddress);
      } catch {
        return reply.status(400).send({
          error: "prepare_token_invalid",
          reason: "mint_unparseable",
        });
      }
      const [treasuryPda, treasuryBump] = deriveTreasuryPda(mintPub);

      let submitted: BroadcastLaunchResult;
      try {
        submitted = await deps.launchpad.broadcastLaunch({
          signedTxBase64: body.signedTxBase64,
          expectedMintAddress: tokenPayload.mintAddress,
          expectedCreatorPubkey: tokenPayload.creatorPubkey,
          context: tokenPayload.context,
        });
      } catch (err) {
        logger.error(
          { err, mint: tokenPayload.mintAddress, launchpad: deps.launchpad.id },
          "launch submit failed",
        );
        return reply.status(502).send({
          error: "launch_submit_failed",
          message: (err as Error).message,
        });
      }

      const lockupEnd = new Date(
        now().getTime() + CREATOR_LOCKUP_DAYS * 86_400 * 1000,
      );
      try {
        const persisted = await deps.persistAgentTokenWithTreasury({
          agentListingId: tokenPayload.agentListingId,
          orgId,
          mintAddress: submitted.mintAddress,
          txSignature: submitted.txSignature,
          creatorAddress: tokenPayload.creatorPubkey,
          creatorLockupEnd: lockupEnd,
          name: tokenPayload.name,
          symbol: tokenPayload.symbol,
          description: tokenPayload.description,
          imageUri: tokenPayload.imageUri,
          launchpad: tokenPayload.launchpad,
          meteoraConfigKey:
            typeof tokenPayload.context.configKey === "string"
              ? tokenPayload.context.configKey
              : undefined,
          treasuryPdaAddress: treasuryPda.toBase58(),
          treasuryAuthorityBump: treasuryBump,
        });
        return reply.status(200).send({
          tokenId: persisted.tokenId,
          mintAddress: submitted.mintAddress,
          txSignature: submitted.txSignature,
          treasuryPdaAddress: treasuryPda.toBase58(),
          creatorLockupEnd: persisted.creatorLockupEnd.toISOString(),
        });
      } catch (err) {
        logger.error(
          {
            err,
            mint: submitted.mintAddress,
            txSignature: submitted.txSignature,
          },
          "persistAgentTokenWithTreasury failed AFTER broadcast succeeded; mint exists on-chain",
        );
        return reply.status(500).send({
          error: "persistence_failed",
          mintAddress: submitted.mintAddress,
          txSignature: submitted.txSignature,
          message: (err as Error).message,
        });
      }
    });

    // ============================================
    // POST /launch/reconcile  (mounted under /api/tokens)
    // ============================================
    //
    // Recovery for the persistence_failed case: the mint is already
    // on-chain but the DB write failed. Re-verify the prepare token,
    // confirm the mint matches + (optionally) exists on-chain, then
    // persist idempotently. Safe to call repeatedly.
    app.post("/launch/reconcile", async (request, reply) => {
      if (!request.auth) {
        return reply.status(401).send({ error: "unauthenticated" });
      }
      const { orgId, walletAddress } = request.auth;
      if (!walletAddress) {
        return reply.status(400).send({ error: "wallet_required" });
      }

      const parsed = reconcileBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_payload",
          details: parsed.error.flatten(),
        });
      }
      const body = parsed.data;

      const verified = verifyPrepareToken({
        token: body.prepareToken,
        secret: deps.prepareTokenSecret,
        now,
      });
      if (!verified.ok) {
        return reply.status(400).send({
          error: "prepare_token_invalid",
          reason: verified.reason,
        });
      }
      const tokenPayload = verified.payload;

      if (tokenPayload.orgId !== orgId) {
        return reply.status(400).send({ error: "prepare_token_org_mismatch" });
      }
      if (tokenPayload.creatorPubkey !== walletAddress) {
        return reply
          .status(400)
          .send({ error: "prepare_token_creator_mismatch" });
      }
      // The mint must be the one this token was prepared for — the client
      // can't reconcile an unrelated mint into existence.
      if (body.mintAddress !== tokenPayload.mintAddress) {
        return reply.status(400).send({ error: "mint_mismatch" });
      }

      let mintPub: PublicKey;
      try {
        mintPub = new PublicKey(tokenPayload.mintAddress);
      } catch {
        return reply.status(400).send({
          error: "prepare_token_invalid",
          reason: "mint_unparseable",
        });
      }

      // Guard against persisting a phantom token: only reconcile a mint
      // that actually exists on-chain (i.e. the broadcast really landed).
      if (deps.confirmMintOnChain) {
        let exists: boolean;
        try {
          exists = await deps.confirmMintOnChain(tokenPayload.mintAddress);
        } catch (err) {
          logger.error(
            { err, mint: tokenPayload.mintAddress },
            "reconcile on-chain check failed",
          );
          return reply.status(502).send({
            error: "mint_check_failed",
            message: (err as Error).message,
          });
        }
        if (!exists) {
          return reply.status(409).send({ error: "mint_not_on_chain" });
        }
      }

      const [treasuryPda, treasuryBump] = deriveTreasuryPda(mintPub);
      const lockupEnd = new Date(
        now().getTime() + CREATOR_LOCKUP_DAYS * 86_400 * 1000,
      );

      try {
        const result = await deps.reconcileLaunch({
          agentListingId: tokenPayload.agentListingId,
          orgId,
          mintAddress: tokenPayload.mintAddress,
          txSignature: body.txSignature,
          creatorAddress: tokenPayload.creatorPubkey,
          creatorLockupEnd: lockupEnd,
          name: tokenPayload.name,
          symbol: tokenPayload.symbol,
          description: tokenPayload.description,
          imageUri: tokenPayload.imageUri,
          launchpad: tokenPayload.launchpad,
          meteoraConfigKey:
            typeof tokenPayload.context.configKey === "string"
              ? tokenPayload.context.configKey
              : undefined,
          treasuryPdaAddress: treasuryPda.toBase58(),
          treasuryAuthorityBump: treasuryBump,
        });
        return reply.status(200).send({
          tokenId: result.tokenId,
          mintAddress: tokenPayload.mintAddress,
          txSignature: body.txSignature,
          treasuryPdaAddress: treasuryPda.toBase58(),
          creatorLockupEnd: result.creatorLockupEnd.toISOString(),
          alreadyExisted: result.alreadyExisted,
        });
      } catch (err) {
        logger.error(
          { err, mint: tokenPayload.mintAddress },
          "reconcileLaunch persistence failed",
        );
        return reply.status(500).send({
          error: "reconcile_failed",
          mintAddress: tokenPayload.mintAddress,
          txSignature: body.txSignature,
          message: (err as Error).message,
        });
      }
    });
  };
}
