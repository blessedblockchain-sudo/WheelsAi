/**
 * POST /tokens — agent token launch wizard endpoint (plan A1 + A4).
 *
 * Distinct from the existing routes/tokens.ts (which exposes the
 * marketplace listing API). This is the *launch* surface — what the
 * launch wizard hits when the user clicks "Launch Token".
 *
 * Flow:
 *   1. Auth gate.
 *   2. loadEligibilityState(agentId, orgId) — null → 404.
 *   3. checkTokenEligibility — return 400 with reasons if not eligible.
 *      Zero side effects on the not-eligible path.
 *   4. Generate (or accept injected) mint Keypair.
 *   5. buildPumpfunCreateRequest — prepare the pumpportal body.
 *   6. submitPumpfunCreate — pumpportal POST + sign + RPC submit (DI'd).
 *   7. persistAgentToken — Prisma write with creatorLockupEnd = now + 30d.
 *
 * Failure-recovery contract:
 *   - 400 not_eligible       → no side effects
 *   - 502 pumpfun_submit_failed → no AgentToken row created
 *   - 500 persistence_failed AFTER submit → response surfaces mintAddress
 *     + txSignature so the wizard can show "your token exists at <mint>;
 *     retry locally" rather than losing the on-chain mint
 */

import { Keypair } from "@solana/web3.js";
import { z } from "zod";
import type { FastifyPluginAsync } from "fastify";

import {
  checkTokenEligibility,
  type EligibilityResult,
} from "../services/tokenEligibility.js";
import {
  buildPumpfunCreateRequest,
  type PumpfunCreateRequestBody,
} from "../services/pumpfunTxBuilder.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("token-launch-route");

const CREATOR_LOCKUP_DAYS = 30;

// ============================================
// Schema
// ============================================

const tokenBodySchema = z.object({
  agentId: z.string().min(1),
  symbol: z.string().min(1).max(10),
  description: z.string(),
  imageUri: z.string().optional(),
  twitter: z.string().optional(),
  telegram: z.string().optional(),
  website: z.string().optional(),
  initialBuySol: z.number().nonnegative().optional(),
});

// ============================================
// DI surface
// ============================================

export interface EligibilityState {
  agent: { id: string; name: string };
  reputationScore: number;
  deploymentAgeDays: number;
  hasPublishedListing: boolean;
  alreadyTokenized: boolean;
  creatorAddress: string;
}

export interface PersistAgentTokenInput {
  agentId: string;
  orgId: string;
  mintAddress: string;
  txSignature: string;
  creatorAddress: string;
  creatorLockupEnd: Date;
  name: string;
  symbol: string;
  description: string;
  imageUri?: string;
}

export interface PersistAgentTokenResult {
  tokenId: string;
  creatorLockupEnd: Date;
}

export interface TokenLaunchRouteDeps {
  loadEligibilityState: (args: {
    agentId: string;
    orgId: string;
  }) => Promise<EligibilityState | null>;
  generateMintKeypair: () => Keypair;
  submitPumpfunCreate: (
    body: PumpfunCreateRequestBody,
  ) => Promise<{ mintAddress: string; txSignature: string }>;
  persistAgentToken: (
    input: PersistAgentTokenInput,
  ) => Promise<PersistAgentTokenResult>;
  /** Defaults to wall clock — overridable for deterministic tests. */
  now?: () => Date;
}

// ============================================
// Plugin
// ============================================

export function createTokenRoutes(
  deps: TokenLaunchRouteDeps,
): FastifyPluginAsync {
  const now = deps.now ?? (() => new Date());

  return async (app) => {
    app.post("/tokens", async (request, reply) => {
      // 1. Auth
      if (!request.auth) {
        return reply.status(401).send({ error: "unauthenticated" });
      }
      const { orgId } = request.auth;

      // 2. Schema
      const parsed = tokenBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_payload",
          details: parsed.error.flatten(),
        });
      }
      const body = parsed.data;

      // 3. Lookup
      const state = await deps.loadEligibilityState({
        agentId: body.agentId,
        orgId,
      });
      if (!state) {
        return reply.status(404).send({ error: "agent_not_found" });
      }

      // 4. Eligibility gate
      const eligibility: EligibilityResult = checkTokenEligibility({
        reputationScore: state.reputationScore,
        deploymentAgeDays: state.deploymentAgeDays,
        hasPublishedListing: state.hasPublishedListing,
        alreadyTokenized: state.alreadyTokenized,
        creatorAddress: state.creatorAddress,
      });
      if (!eligibility.eligible) {
        return reply.status(400).send({
          error: "not_eligible",
          reasons: eligibility.reasons,
        });
      }

      // 5. Mint keypair + pumpfun request body
      const mint = deps.generateMintKeypair();
      const pumpfunBody = buildPumpfunCreateRequest({
        creatorPubkey: state.creatorAddress,
        mintPubkey: mint.publicKey.toBase58(),
        name: state.agent.name,
        symbol: body.symbol,
        // Until the IPFS-upload step ships, the imageUri doubles as the
        // metadata uri. The orchestrator will swap to a real metadata-json
        // uri once that lands; tests stay valid.
        uri: body.imageUri ?? "",
        twitter: body.twitter,
        telegram: body.telegram,
        website: body.website,
        initialBuySol: body.initialBuySol,
      });

      // 6. Submit
      let submitted: { mintAddress: string; txSignature: string };
      try {
        submitted = await deps.submitPumpfunCreate(pumpfunBody);
      } catch (err) {
        logger.error({ err, agentId: body.agentId }, "pumpfun submit failed");
        return reply.status(502).send({
          error: "pumpfun_submit_failed",
          message: (err as Error).message,
        });
      }

      // 7. Persist
      const lockupEnd = new Date(
        now().getTime() + CREATOR_LOCKUP_DAYS * 86_400 * 1000,
      );
      try {
        const persisted = await deps.persistAgentToken({
          agentId: body.agentId,
          orgId,
          mintAddress: submitted.mintAddress,
          txSignature: submitted.txSignature,
          creatorAddress: state.creatorAddress,
          creatorLockupEnd: lockupEnd,
          name: state.agent.name,
          symbol: body.symbol,
          description: body.description,
          imageUri: body.imageUri,
        });
        return reply.status(200).send({
          tokenId: persisted.tokenId,
          mintAddress: submitted.mintAddress,
          txSignature: submitted.txSignature,
          creatorLockupEnd: persisted.creatorLockupEnd.toISOString(),
        });
      } catch (err) {
        logger.error(
          { err, agentId: body.agentId, mintAddress: submitted.mintAddress },
          "persistAgentToken failed AFTER pumpfun submit succeeded; mint exists on-chain",
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
