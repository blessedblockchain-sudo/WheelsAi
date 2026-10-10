/**
 * Linking a Solana wallet to the signed-in account (POST
 * /api/settings/link-wallet/nonce and POST /api/settings/link-wallet).
 *
 * The wallet signs the nonce text exactly as wallet sign-in does
 * (routes/auth.ts /wallet/verify): the signature is base58, it is checked
 * first, and only then is the nonce claimed, for the purpose "link-wallet",
 * so a message signed to sign in can never link a wallet and the other way
 * round. On success the session cookie is issued again, built from the
 * account as it is now, so the session carries the wallet at once.
 *
 * Every sentence a person reads is written here, chosen by a code. Text
 * from Redis, Prisma or a thrown error goes to the log only.
 */

import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { clearAuthCookie, generateTokens, requireJwtAuth, setAuthCookie } from "../middleware/auth.js";
import type { JwtPayload, NoncePurpose } from "../services/auth.js";

export const LINK_WALLET_PURPOSE: NoncePurpose = "link-wallet";

export type LinkWalletRefusal =
  | "invalid_nonce"
  | "invalid_wallet_address"
  | "invalid_signature"
  | "wallet_in_use"
  | "nonce_unavailable"
  | "membership_revoked";

const REFUSALS: Record<LinkWalletRefusal, { status: number; message: string }> = {
  invalid_nonce: { status: 401, message: "That request to link a wallet has expired. Try again." },
  invalid_wallet_address: {
    status: 400,
    message: "That is not a Solana wallet address. Connect a wallet and try again.",
  },
  invalid_signature: { status: 400, message: "The wallet's signature could not be checked. Try again." },
  wallet_in_use: {
    status: 409,
    message:
      "This wallet already signs in to another WheelsAI account. Use that account, or link a different wallet.",
  },
  nonce_unavailable: { status: 503, message: "We could not start linking this wallet. Try again shortly." },
  membership_revoked: {
    status: 401,
    message: "You are no longer a member of this organization. Sign in again.",
  },
};

export const LINKED_MESSAGE = "Wallet linked.";

export interface LinkWalletDeps {
  /** Issue the one-time message the wallet signs (services/auth.ts generateNonce). */
  generateNonce(walletAddress: string, purpose: NoncePurpose): Promise<string>;
  /** Claim it once: true only for this wallet, this purpose, never used (claimNonce). */
  claimNonce(walletAddress: string, nonce: string, purpose: NoncePurpose): Promise<boolean>;
  /** A base58 ed25519 signature of the nonce text by the wallet (verifySolanaSignature). */
  verifySignature(nonce: string, signature: string, walletAddress: string): boolean;
  /**
   * Put the wallet on the user. "in_use" when another account holds it
   * (nothing is written); "user_missing" when the user is gone.
   */
  linkWallet(input: { userId: string; walletAddress: string }): Promise<"linked" | "in_use" | "user_missing">;
  /**
   * The claims for a new session token, read from the user and their
   * membership of this organization as they are now; null when the user is
   * no longer a member.
   */
  loadSession(input: { userId: string; orgId: string }): Promise<JwtPayload | null>;
}

const nonceBodySchema = z.object({ walletAddress: z.string() });
// Only the address is typed here: a nonce or a signature that is missing or
// not text gets its own refusal below, not the address one.
const linkBodySchema = z.object({
  walletAddress: z.string(),
  signature: z.unknown(),
  nonce: z.unknown(),
});

/** A Solana public key in its one canonical base58 spelling. */
export function isSolanaAddress(value: string): boolean {
  if (value.length < 32 || value.length > 44) return false;
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}

function refuse(reply: FastifyReply, code: LinkWalletRefusal) {
  const { status, message } = REFUSALS[code];
  return reply.status(status).send({ error: code, message });
}

// Ten a minute per caller, as wallet sign-in allows.
const RATE_LIMIT = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };

export function createLinkWalletRoutes(deps: LinkWalletDeps): FastifyPluginAsync {
  return async (fastify) => {
    // Linking acts for a person and ends by issuing their session again, so
    // an API key (which has no user behind it) cannot do it.
    fastify.addHook("preHandler", requireJwtAuth);

    // Request nonce for wallet linking
    fastify.post("/link-wallet/nonce", RATE_LIMIT, async (request, reply) => {
      const body = nonceBodySchema.safeParse(request.body);
      if (!body.success || !isSolanaAddress(body.data.walletAddress)) {
        return refuse(reply, "invalid_wallet_address");
      }
      const { walletAddress } = body.data;

      let nonce: string;
      try {
        nonce = await deps.generateNonce(walletAddress, LINK_WALLET_PURPOSE);
      } catch (err) {
        request.log.error({ err, walletAddress }, "link-wallet: the nonce could not be issued");
        return refuse(reply, "nonce_unavailable");
      }
      return { nonce, walletAddress };
    });

    // Link Solana wallet: signature first, then the one-time claim of the nonce
    fastify.post("/link-wallet", RATE_LIMIT, async (request, reply) => {
      const { userId, orgId } = request.auth!;
      const body = linkBodySchema.safeParse(request.body);
      if (!body.success || !isSolanaAddress(body.data.walletAddress)) {
        return refuse(reply, "invalid_wallet_address");
      }
      const { walletAddress, signature, nonce } = body.data;
      if (typeof nonce !== "string" || !nonce) return refuse(reply, "invalid_nonce");
      if (typeof signature !== "string" || !signature) return refuse(reply, "invalid_signature");

      // Verify the signature over the exact message the client returned...
      if (!deps.verifySignature(nonce, signature, walletAddress)) {
        return refuse(reply, "invalid_signature");
      }

      // ...then atomically claim it: only a message this server issued, for
      // this wallet, for linking, and never used before (prevents replay,
      // including of sign-in messages).
      if (!(await deps.claimNonce(walletAddress, nonce, LINK_WALLET_PURPOSE))) {
        return refuse(reply, "invalid_nonce");
      }

      // requireJwtAuth guarantees a JWT principal (non-null userId)
      const outcome = await deps.linkWallet({ userId: userId!, walletAddress });
      if (outcome === "in_use") return refuse(reply, "wallet_in_use");

      // The new token is built from the account as it is now, never from the
      // old token's claims (as POST /api/auth/refresh does).
      const session = outcome === "linked" ? await deps.loadSession({ userId: userId!, orgId }) : null;
      if (!session) {
        clearAuthCookie(reply);
        return refuse(reply, "membership_revoked");
      }

      const { accessToken } = generateTokens(fastify, session);
      setAuthCookie(reply, accessToken);

      request.log.info({ userId, walletAddress }, "Wallet linked to account");

      return { walletAddress, message: LINKED_MESSAGE };
    });
  };
}
