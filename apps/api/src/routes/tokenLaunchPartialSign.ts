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

import { Keypair, PublicKey } from "@solana/web3.js";
import { z } from "zod";
import type { FastifyPluginAsync } from "fastify";

import {
  checkTokenEligibility,
  type EligibilityResult,
} from "../services/tokenEligibility.js";
import { buildPumpfunCreateRequest } from "../services/pumpfunTxBuilder.js";
import {
  signPrepareToken,
  verifyPrepareToken,
} from "../services/pumpfunPrepareToken.js";
import { deriveTreasuryPda } from "../lib/programs/agentTreasury.js";
import { createLogger } from "../utils/logger.js";
import type { EligibilityState } from "./tokenLaunch.js";

const logger = createLogger("token-launch-partial-sign");

const CREATOR_LOCKUP_DAYS = 30;

// ============================================
// Schemas
// ============================================

const prepareBodySchema = z.object({
  agentId: z.string().min(1),
  symbol: z.string().min(1).max(10),
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

// ============================================
// DI surface
// ============================================

export interface PreparePumpfunResult {
  partialSignedTxBase64: string;
  mintAddress: string;
  creatorPubkey: string;
}

export interface BroadcastResult {
  mintAddress: string;
  txSignature: string;
}

export interface PersistAgentTokenWithTreasuryInput {
  agentListingId: string;
  orgId: string;
  mintAddress: string;
  txSignature: string;
  creatorAddress: string;
  creatorLockupEnd: Date;
  symbol: string;
  description: string;
  imageUri?: string;
  treasuryPdaAddress: string;
  treasuryAuthorityBump: number;
}

export interface PersistAgentTokenWithTreasuryResult {
  tokenId: string;
  creatorLockupEnd: Date;
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
  generateMintKeypair: () => Keypair;
  /**
   * Concrete prepare impl — wraps preparePumpfunCreate with a fetch
   * binding. The route doesn't know about HTTP transport.
   */
  preparePumpfunCreate: (input: {
    body: import("../services/pumpfunTxBuilder.js").PumpfunCreateRequestBody;
    mintKeypair: Keypair;
  }) => Promise<PreparePumpfunResult>;
  /**
   * Concrete broadcast impl — wraps broadcastSignedPumpfunCreate with
   * an RPC binding. The route doesn't know about Solana transport.
   */
  broadcastSignedPumpfunCreate: (input: {
    signedTxBase64: string;
    expectedMintAddress: string;
    expectedCreatorPubkey: string;
  }) => Promise<BroadcastResult>;
  persistAgentTokenWithTreasury: (
    input: PersistAgentTokenWithTreasuryInput,
  ) => Promise<PersistAgentTokenWithTreasuryResult>;
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
    // POST /tokens/launch/prepare
    // ============================================
    app.post("/tokens/launch/prepare", async (request, reply) => {
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

      const mint = deps.generateMintKeypair();
      const pumpfunBody = buildPumpfunCreateRequest({
        creatorPubkey: walletAddress,
        mintPubkey: mint.publicKey.toBase58(),
        name: state.agent.name,
        symbol: body.symbol,
        uri: body.imageUri ?? "",
        twitter: body.twitter,
        telegram: body.telegram,
        website: body.website,
        initialBuySol: body.initialBuySol,
      });

      let prepared: PreparePumpfunResult;
      try {
        prepared = await deps.preparePumpfunCreate({
          body: pumpfunBody,
          mintKeypair: mint,
        });
      } catch (err) {
        logger.error(
          { err, agentId: body.agentId },
          "pumpfun prepare failed",
        );
        return reply.status(502).send({
          error: "pumpfun_prepare_failed",
          message: (err as Error).message,
        });
      }

      const prepareToken = signPrepareToken({
        payload: {
          mintAddress: prepared.mintAddress,
          agentListingId,
          orgId,
          creatorPubkey: walletAddress,
          symbol: body.symbol,
          description: body.description,
          imageUri: body.imageUri,
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
    // POST /tokens/launch/submit
    // ============================================
    app.post("/tokens/launch/submit", async (request, reply) => {
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

      let submitted: BroadcastResult;
      try {
        submitted = await deps.broadcastSignedPumpfunCreate({
          signedTxBase64: body.signedTxBase64,
          expectedMintAddress: tokenPayload.mintAddress,
          expectedCreatorPubkey: tokenPayload.creatorPubkey,
        });
      } catch (err) {
        logger.error(
          { err, mint: tokenPayload.mintAddress },
          "pumpfun submit failed",
        );
        return reply.status(502).send({
          error: "pumpfun_submit_failed",
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
          symbol: tokenPayload.symbol,
          description: tokenPayload.description,
          imageUri: tokenPayload.imageUri,
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
  };
}
