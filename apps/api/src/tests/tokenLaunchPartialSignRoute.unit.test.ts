import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { Keypair } from "@solana/web3.js";

import {
  createPartialSignTokenRoutes,
  type PartialSignTokenRouteDeps,
} from "../routes/tokenLaunchPartialSign.js";
import { signPrepareToken } from "../services/pumpfunPrepareToken.js";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

// Drives apps/api/src/routes/tokenLaunchPartialSign.ts — the browser-
// partial-sign launch path. Every IO surface is DI'd so the test
// exercises the orchestration + failure-recovery without touching
// pumpfun, Solana, or Prisma.

const PREPARE_SECRET = "test-prepare-secret-1234567890ab";

const eligibleState = () => ({
  agent: { id: "agent_1", name: "Eliza" },
  reputationScore: 80,
  deploymentAgeDays: 14,
  hasPublishedListing: true,
  alreadyTokenized: false,
  creatorAddress: "ignored-by-partial-sign-route",
});

// Deterministic mint keypair so we can predict the prepared mintAddress.
const FIXED_MINT_BYTES = new Uint8Array(32).fill(7);
function makeFixedMint(): Keypair {
  return Keypair.fromSeed(FIXED_MINT_BYTES);
}

const USER_WALLET = "EeYpfM4mEYHRJV6w3WAyKVMv47o6sNFM4nXjN3JoEHbW";

interface MakeAppOpts {
  authed?: boolean;
  walletAddress?: string | null;
  deps?: Partial<PartialSignTokenRouteDeps>;
}

async function makeApp(opts: MakeAppOpts = {}) {
  setupEnv();
  const app = Fastify();
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    if (opts.authed !== false) {
      request.auth = {
        userId: "u1",
        orgId: "org_1",
        type: "jwt",
        walletAddress:
          opts.walletAddress === null
            ? undefined
            : (opts.walletAddress ?? USER_WALLET),
      };
    }
  });

  const baseDeps: PartialSignTokenRouteDeps = {
    loadEligibilityState: async () => eligibleState(),
    resolveAgentListingId: async () => "listing_1",
    generateMintKeypair: () => makeFixedMint(),
    preparePumpfunCreate: async ({ mintKeypair }) => ({
      partialSignedTxBase64: "FAKE_PARTIAL_SIGNED_TX_BASE64",
      mintAddress: mintKeypair.publicKey.toBase58(),
      creatorPubkey: USER_WALLET,
    }),
    broadcastSignedPumpfunCreate: async ({ expectedMintAddress }) => ({
      mintAddress: expectedMintAddress,
      txSignature: "fake_signature_xyz",
    }),
    persistAgentTokenWithTreasury: async () => ({
      tokenId: "tok_new",
      creatorLockupEnd: new Date("2026-06-26T00:00:00Z"),
    }),
    prepareTokenSecret: PREPARE_SECRET,
    now: () => new Date("2026-05-27T00:00:00Z"),
  };
  const deps: PartialSignTokenRouteDeps = { ...baseDeps, ...opts.deps };

  await app.register(createPartialSignTokenRoutes(deps));
  return app;
}

const validPrepareBody = () => ({
  agentId: "agent_1",
  symbol: "ELZ",
  description: "Test agent token",
  imageUri: "https://example.com/elza.png",
});

// ============================================
// /prepare
// ============================================

test("/prepare 401 when unauthenticated", async () => {
  const app = await makeApp({ authed: false });
  const res = await app.inject({
    method: "POST",
    url: "/tokens/launch/prepare",
    payload: validPrepareBody(),
  });
  assert.equal(res.statusCode, 401);
});

test("/prepare 400 wallet_required when no walletAddress on auth", async () => {
  const app = await makeApp({ walletAddress: null });
  const res = await app.inject({
    method: "POST",
    url: "/tokens/launch/prepare",
    payload: validPrepareBody(),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, "wallet_required");
});

test("/prepare 404 when the agent is missing for this org", async () => {
  const app = await makeApp({
    deps: { loadEligibilityState: async () => null },
  });
  const res = await app.inject({
    method: "POST",
    url: "/tokens/launch/prepare",
    payload: validPrepareBody(),
  });
  assert.equal(res.statusCode, 404);
});

test("/prepare 400 not_eligible when reputation too low", async () => {
  const app = await makeApp({
    deps: {
      loadEligibilityState: async () => ({
        ...eligibleState(),
        reputationScore: 10,
      }),
    },
  });
  const res = await app.inject({
    method: "POST",
    url: "/tokens/launch/prepare",
    payload: validPrepareBody(),
  });
  assert.equal(res.statusCode, 400);
  const body = JSON.parse(res.body);
  assert.equal(body.error, "not_eligible");
  assert.ok(Array.isArray(body.reasons) && body.reasons.length > 0);
});

test("/prepare 400 listing_required when the agent has no published listing", async () => {
  const app = await makeApp({
    deps: { resolveAgentListingId: async () => null },
  });
  const res = await app.inject({
    method: "POST",
    url: "/tokens/launch/prepare",
    payload: validPrepareBody(),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, "listing_required");
});

test("/prepare 502 pumpfun_prepare_failed when pumpportal errors", async () => {
  const app = await makeApp({
    deps: {
      preparePumpfunCreate: async () => {
        throw new Error("pumpportal_local: returned 502 (upstream timed out)");
      },
    },
  });
  const res = await app.inject({
    method: "POST",
    url: "/tokens/launch/prepare",
    payload: validPrepareBody(),
  });
  assert.equal(res.statusCode, 502);
  assert.equal(JSON.parse(res.body).error, "pumpfun_prepare_failed");
});

test("/prepare 200 returns partial-signed tx + prepare token", async () => {
  const app = await makeApp();
  const res = await app.inject({
    method: "POST",
    url: "/tokens/launch/prepare",
    payload: validPrepareBody(),
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.partialSignedTxBase64, "FAKE_PARTIAL_SIGNED_TX_BASE64");
  assert.equal(body.mintAddress, makeFixedMint().publicKey.toBase58());
  assert.equal(body.creatorPubkey, USER_WALLET);
  assert.ok(typeof body.prepareToken === "string" && body.prepareToken.length > 0);
  // Token has three base64url segments
  assert.equal(body.prepareToken.split(".").length, 3);
});

// ============================================
// /submit
// ============================================

function makeValidPrepareToken(opts: {
  mintAddress?: string;
  agentListingId?: string;
  orgId?: string;
  creatorPubkey?: string;
  symbol?: string;
  description?: string;
  imageUri?: string;
} = {}) {
  return signPrepareToken({
    payload: {
      mintAddress: opts.mintAddress ?? makeFixedMint().publicKey.toBase58(),
      agentListingId: opts.agentListingId ?? "listing_1",
      orgId: opts.orgId ?? "org_1",
      creatorPubkey: opts.creatorPubkey ?? USER_WALLET,
      symbol: opts.symbol ?? "ELZ",
      description: opts.description ?? "Test agent token",
      imageUri: opts.imageUri ?? "https://example.com/elza.png",
    },
    secret: PREPARE_SECRET,
    now: () => new Date("2026-05-27T00:00:00Z"),
  });
}

test("/submit 401 when unauthenticated", async () => {
  const app = await makeApp({ authed: false });
  const res = await app.inject({
    method: "POST",
    url: "/tokens/launch/submit",
    payload: {
      prepareToken: makeValidPrepareToken(),
      signedTxBase64: "anything",
    },
  });
  assert.equal(res.statusCode, 401);
});

test("/submit 400 prepare_token_invalid for a malformed token", async () => {
  const app = await makeApp();
  const res = await app.inject({
    method: "POST",
    url: "/tokens/launch/submit",
    payload: {
      prepareToken: "not-a-real-token",
      signedTxBase64: "anything",
    },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, "prepare_token_invalid");
});

test("/submit 400 prepare_token_org_mismatch when token belongs to a different org", async () => {
  const app = await makeApp();
  const token = makeValidPrepareToken({ orgId: "org_OTHER" });
  const res = await app.inject({
    method: "POST",
    url: "/tokens/launch/submit",
    payload: { prepareToken: token, signedTxBase64: "anything" },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, "prepare_token_org_mismatch");
});

test("/submit 400 prepare_token_creator_mismatch when token belongs to a different wallet", async () => {
  const app = await makeApp();
  const token = makeValidPrepareToken({
    creatorPubkey: "DifferentWaLLet111111111111111111111111111",
  });
  const res = await app.inject({
    method: "POST",
    url: "/tokens/launch/submit",
    payload: { prepareToken: token, signedTxBase64: "anything" },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, "prepare_token_creator_mismatch");
});

test("/submit 502 pumpfun_submit_failed on broadcast failure (and no persist)", async () => {
  let persistCalled = false;
  const app = await makeApp({
    deps: {
      broadcastSignedPumpfunCreate: async () => {
        throw new Error("rpc_submit: blockhash not found");
      },
      persistAgentTokenWithTreasury: async () => {
        persistCalled = true;
        return {
          tokenId: "should-not-happen",
          creatorLockupEnd: new Date(),
        };
      },
    },
  });
  const res = await app.inject({
    method: "POST",
    url: "/tokens/launch/submit",
    payload: {
      prepareToken: makeValidPrepareToken(),
      signedTxBase64: "anything",
    },
  });
  assert.equal(res.statusCode, 502);
  assert.equal(JSON.parse(res.body).error, "pumpfun_submit_failed");
  assert.equal(persistCalled, false, "persist must not run after broadcast fails");
});

test("/submit 500 persistence_failed surfaces mintAddress + txSignature for recovery", async () => {
  const app = await makeApp({
    deps: {
      persistAgentTokenWithTreasury: async () => {
        throw new Error("db connection lost");
      },
    },
  });
  const res = await app.inject({
    method: "POST",
    url: "/tokens/launch/submit",
    payload: {
      prepareToken: makeValidPrepareToken(),
      signedTxBase64: "anything",
    },
  });
  assert.equal(res.statusCode, 500);
  const body = JSON.parse(res.body);
  assert.equal(body.error, "persistence_failed");
  assert.equal(body.mintAddress, makeFixedMint().publicKey.toBase58());
  assert.equal(body.txSignature, "fake_signature_xyz");
});

test("/submit 200 returns persisted ids + on-chain refs on the happy path", async () => {
  const captured: any = {};
  const app = await makeApp({
    deps: {
      persistAgentTokenWithTreasury: async (input) => {
        captured.persistInput = input;
        return {
          tokenId: "tok_persisted",
          creatorLockupEnd: input.creatorLockupEnd,
        };
      },
    },
  });
  const res = await app.inject({
    method: "POST",
    url: "/tokens/launch/submit",
    payload: {
      prepareToken: makeValidPrepareToken(),
      signedTxBase64: "anything",
    },
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.tokenId, "tok_persisted");
  assert.equal(body.mintAddress, makeFixedMint().publicKey.toBase58());
  assert.equal(body.txSignature, "fake_signature_xyz");
  // Treasury PDA address is deterministic from mint — present in response.
  assert.ok(
    typeof body.treasuryPdaAddress === "string" &&
      body.treasuryPdaAddress.length > 0,
  );
  // Verify the persist input carries the symbol + description from the token
  // (not from the request body — the token is the source of truth for what
  // the user signed).
  assert.equal(captured.persistInput.symbol, "ELZ");
  assert.equal(captured.persistInput.description, "Test agent token");
  assert.equal(captured.persistInput.imageUri, "https://example.com/elza.png");
  assert.equal(captured.persistInput.creatorAddress, USER_WALLET);
  assert.equal(captured.persistInput.agentListingId, "listing_1");
  assert.equal(captured.persistInput.orgId, "org_1");
});
