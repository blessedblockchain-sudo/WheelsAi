import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { Keypair } from "@solana/web3.js";

import {
  createPartialSignTokenRoutes,
  type PartialSignTokenRouteDeps,
} from "../routes/tokenLaunchPartialSign.js";
import { signPrepareToken } from "../services/launchpadPrepareToken.js";
import type { LaunchpadAdapter } from "../services/launchpad/types.js";

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
  settledPaidRequests: 0,
});

// Deterministic mint keypair so we can predict the prepared mintAddress.
const FIXED_MINT_BYTES = new Uint8Array(32).fill(7);
function makeFixedMint(): Keypair {
  return Keypair.fromSeed(FIXED_MINT_BYTES);
}

const USER_WALLET = "EeYpfM4mEYHRJV6w3WAyKVMv47o6sNFM4nXjN3JoEHbW";

// Mock launchpad adapter — the route's only launchpad-specific dep.
// Overridable per-test for the prepare/broadcast failure paths.
function makeMockLaunchpad(
  overrides: Partial<LaunchpadAdapter> = {},
): LaunchpadAdapter {
  return {
    id: "pumpfun",
    prepareLaunch: async () => ({
      partialSignedTxBase64: "FAKE_PARTIAL_SIGNED_TX_BASE64",
      mintAddress: makeFixedMint().publicKey.toBase58(),
      creatorPubkey: USER_WALLET,
      context: {},
    }),
    broadcastLaunch: async ({ expectedMintAddress }) => ({
      mintAddress: expectedMintAddress,
      txSignature: "fake_signature_xyz",
    }),
    ...overrides,
  };
}

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
    launchpad: makeMockLaunchpad(),
    persistAgentTokenWithTreasury: async () => ({
      tokenId: "tok_new",
      creatorLockupEnd: new Date("2026-06-26T00:00:00Z"),
    }),
    reconcileLaunch: async () => ({
      tokenId: "tok_reconciled",
      creatorLockupEnd: new Date("2026-06-26T00:00:00Z"),
      alreadyExisted: false,
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
  name: "Eliza Token",
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
    url: "/launch/prepare",
    payload: validPrepareBody(),
  });
  assert.equal(res.statusCode, 401);
});

test("/prepare 400 wallet_required when no walletAddress on auth", async () => {
  const app = await makeApp({ walletAddress: null });
  const res = await app.inject({
    method: "POST",
    url: "/launch/prepare",
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
    url: "/launch/prepare",
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
    url: "/launch/prepare",
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
    url: "/launch/prepare",
    payload: validPrepareBody(),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, "listing_required");
});

test("/prepare 502 launch_prepare_failed when the launchpad errors", async () => {
  const app = await makeApp({
    deps: {
      launchpad: makeMockLaunchpad({
        prepareLaunch: async () => {
          throw new Error(
            "pumpportal_local: returned 502 (upstream timed out)",
          );
        },
      }),
    },
  });
  const res = await app.inject({
    method: "POST",
    url: "/launch/prepare",
    payload: validPrepareBody(),
  });
  assert.equal(res.statusCode, 502);
  assert.equal(JSON.parse(res.body).error, "launch_prepare_failed");
});

test("/prepare 200 returns partial-signed tx + prepare token", async () => {
  const app = await makeApp();
  const res = await app.inject({
    method: "POST",
    url: "/launch/prepare",
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
  name?: string;
  symbol?: string;
  description?: string;
  imageUri?: string;
  launchpad?: string;
  context?: Record<string, unknown>;
} = {}) {
  return signPrepareToken({
    payload: {
      mintAddress: opts.mintAddress ?? makeFixedMint().publicKey.toBase58(),
      agentListingId: opts.agentListingId ?? "listing_1",
      orgId: opts.orgId ?? "org_1",
      creatorPubkey: opts.creatorPubkey ?? USER_WALLET,
      name: opts.name ?? "Eliza Token",
      symbol: opts.symbol ?? "ELZ",
      description: opts.description ?? "Test agent token",
      imageUri: opts.imageUri ?? "https://example.com/elza.png",
      launchpad: opts.launchpad ?? "pumpfun",
      context: opts.context ?? {},
    },
    secret: PREPARE_SECRET,
    now: () => new Date("2026-05-27T00:00:00Z"),
  });
}

test("/submit 401 when unauthenticated", async () => {
  const app = await makeApp({ authed: false });
  const res = await app.inject({
    method: "POST",
    url: "/launch/submit",
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
    url: "/launch/submit",
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
    url: "/launch/submit",
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
    url: "/launch/submit",
    payload: { prepareToken: token, signedTxBase64: "anything" },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, "prepare_token_creator_mismatch");
});

test("/submit 502 launch_submit_failed on broadcast failure (and no persist)", async () => {
  let persistCalled = false;
  const app = await makeApp({
    deps: {
      launchpad: makeMockLaunchpad({
        broadcastLaunch: async () => {
          throw new Error("rpc_submit: blockhash not found");
        },
      }),
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
    url: "/launch/submit",
    payload: {
      prepareToken: makeValidPrepareToken(),
      signedTxBase64: "anything",
    },
  });
  assert.equal(res.statusCode, 502);
  assert.equal(JSON.parse(res.body).error, "launch_submit_failed");
  assert.equal(persistCalled, false, "persist must not run after broadcast fails");
});

test("/submit 400 prepare_token_launchpad_mismatch when the active adapter differs", async () => {
  // Active adapter is pumpfun (default mock); token was prepared for bags.
  const app = await makeApp();
  const token = makeValidPrepareToken({ launchpad: "bags" });
  const res = await app.inject({
    method: "POST",
    url: "/launch/submit",
    payload: { prepareToken: token, signedTxBase64: "anything" },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, "prepare_token_launchpad_mismatch");
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
    url: "/launch/submit",
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
    url: "/launch/submit",
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
  assert.equal(captured.persistInput.name, "Eliza Token");
  assert.equal(captured.persistInput.symbol, "ELZ");
  assert.equal(captured.persistInput.launchpad, "pumpfun");
  assert.equal(captured.persistInput.description, "Test agent token");
  assert.equal(captured.persistInput.imageUri, "https://example.com/elza.png");
  assert.equal(captured.persistInput.creatorAddress, USER_WALLET);
  assert.equal(captured.persistInput.agentListingId, "listing_1");
  assert.equal(captured.persistInput.orgId, "org_1");
});

// ============================================
// /reconcile (recovery path)
// ============================================

const FIXED_MINT_B58 = makeFixedMint().publicKey.toBase58();

test("/reconcile 200 persists from the token + body and returns the tokenId", async () => {
  const captured: any = {};
  const app = await makeApp({
    deps: {
      reconcileLaunch: async (input) => {
        captured.input = input;
        return {
          tokenId: "tok_reconciled",
          creatorLockupEnd: input.creatorLockupEnd,
          alreadyExisted: false,
        };
      },
    },
  });
  const res = await app.inject({
    method: "POST",
    url: "/launch/reconcile",
    payload: {
      prepareToken: makeValidPrepareToken(),
      mintAddress: FIXED_MINT_B58,
      txSignature: "broadcast_sig_123",
    },
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.tokenId, "tok_reconciled");
  assert.equal(body.mintAddress, FIXED_MINT_B58);
  assert.equal(body.txSignature, "broadcast_sig_123");
  assert.equal(body.alreadyExisted, false);
  // Persisted fields come from the HMAC token (name/symbol), not the body.
  assert.equal(captured.input.name, "Eliza Token");
  assert.equal(captured.input.symbol, "ELZ");
  assert.equal(captured.input.txSignature, "broadcast_sig_123");
});

test("/reconcile 200 alreadyExisted=true on idempotent replay", async () => {
  const app = await makeApp({
    deps: {
      reconcileLaunch: async (input) => ({
        tokenId: "tok_existing",
        creatorLockupEnd: input.creatorLockupEnd,
        alreadyExisted: true,
      }),
    },
  });
  const res = await app.inject({
    method: "POST",
    url: "/launch/reconcile",
    payload: {
      prepareToken: makeValidPrepareToken(),
      mintAddress: FIXED_MINT_B58,
      txSignature: "broadcast_sig_123",
    },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).alreadyExisted, true);
});

test("/reconcile 400 mint_mismatch when body mint differs from the token", async () => {
  const app = await makeApp();
  const res = await app.inject({
    method: "POST",
    url: "/launch/reconcile",
    payload: {
      prepareToken: makeValidPrepareToken(),
      mintAddress: "SomeOtherMint1111111111111111111111111111111",
      txSignature: "broadcast_sig_123",
    },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, "mint_mismatch");
});

test("/reconcile 409 mint_not_on_chain when the on-chain check fails", async () => {
  let reconcileCalled = false;
  const app = await makeApp({
    deps: {
      confirmMintOnChain: async () => false,
      reconcileLaunch: async (input) => {
        reconcileCalled = true;
        return {
          tokenId: "x",
          creatorLockupEnd: input.creatorLockupEnd,
          alreadyExisted: false,
        };
      },
    },
  });
  const res = await app.inject({
    method: "POST",
    url: "/launch/reconcile",
    payload: {
      prepareToken: makeValidPrepareToken(),
      mintAddress: FIXED_MINT_B58,
      txSignature: "broadcast_sig_123",
    },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(JSON.parse(res.body).error, "mint_not_on_chain");
  assert.equal(reconcileCalled, false, "must not persist when mint is absent");
});

test("/reconcile 400 prepare_token_org_mismatch for a foreign org token", async () => {
  const app = await makeApp();
  const token = makeValidPrepareToken({ orgId: "org_OTHER" });
  const res = await app.inject({
    method: "POST",
    url: "/launch/reconcile",
    payload: {
      prepareToken: token,
      mintAddress: FIXED_MINT_B58,
      txSignature: "broadcast_sig_123",
    },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, "prepare_token_org_mismatch");
});

// ============================================
// A launch on our own Meteora curve
// ============================================
//
// The route stays launchpad-neutral: it passes the chosen preset to the
// adapter, answers with what the adapter put in its context, and saves the
// curve's config and pool. The adapter itself is covered by
// meteoraAdapter.unit.test.ts.

const METEORA_CONTEXT = {
  configKey: "CoNFigKey1111111111111111111111111111111111",
  poolAddress: "PooLAddress11111111111111111111111111111111",
  preset: "committed",
  messageHash: "ab".repeat(32),
  lastValidBlockHeight: 4242,
};

function makeMeteoraLaunchpad(
  overrides: Partial<LaunchpadAdapter> = {},
): LaunchpadAdapter {
  return makeMockLaunchpad({
    id: "meteora",
    prepareLaunch: async () => ({
      partialSignedTxBase64: "FAKE_PARTIAL_SIGNED_TX_BASE64",
      mintAddress: makeFixedMint().publicKey.toBase58(),
      creatorPubkey: USER_WALLET,
      context: METEORA_CONTEXT,
    }),
    ...overrides,
  });
}

test("/prepare passes the chosen preset to the launchpad and answers with the preset and the pool", async () => {
  const captured: any = {};
  const app = await makeApp({
    deps: {
      launchpad: makeMeteoraLaunchpad({
        prepareLaunch: async (input) => {
          captured.input = input;
          return {
            partialSignedTxBase64: "FAKE_PARTIAL_SIGNED_TX_BASE64",
            mintAddress: makeFixedMint().publicKey.toBase58(),
            creatorPubkey: USER_WALLET,
            context: METEORA_CONTEXT,
          };
        },
      }),
    },
  });
  const res = await app.inject({
    method: "POST",
    url: "/launch/prepare",
    payload: { ...validPrepareBody(), preset: "committed" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(captured.input.preset, "committed");
  assert.equal(captured.input.creatorPubkey, USER_WALLET);
  const body = JSON.parse(res.body);
  assert.equal(body.preset, "committed");
  assert.equal(body.poolAddress, METEORA_CONTEXT.poolAddress);
  assert.ok(typeof body.prepareToken === "string" && body.prepareToken.length > 0);
});

test("/prepare without a preset leaves the choice to the launchpad, and a pump.fun answer names no preset or pool", async () => {
  const captured: any = {};
  const app = await makeApp({
    deps: {
      launchpad: makeMockLaunchpad({
        prepareLaunch: async (input) => {
          captured.input = input;
          return {
            partialSignedTxBase64: "FAKE_PARTIAL_SIGNED_TX_BASE64",
            mintAddress: makeFixedMint().publicKey.toBase58(),
            creatorPubkey: USER_WALLET,
            context: {},
          };
        },
      }),
    },
  });
  const res = await app.inject({
    method: "POST",
    url: "/launch/prepare",
    payload: validPrepareBody(),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(captured.input.preset, undefined);
  const body = JSON.parse(res.body);
  assert.equal("preset" in body, false);
  assert.equal("poolAddress" in body, false);
});

test("/prepare 502 carries the launchpad's sentence when it refuses a preset", async () => {
  const app = await makeApp({
    deps: {
      launchpad: makeMeteoraLaunchpad({
        prepareLaunch: async () => {
          throw new Error('unknown_preset: "moonshot" is not a curve that can be chosen here');
        },
      }),
    },
  });
  const res = await app.inject({
    method: "POST",
    url: "/launch/prepare",
    payload: { ...validPrepareBody(), preset: "moonshot" },
  });
  assert.equal(res.statusCode, 502);
  const body = JSON.parse(res.body);
  assert.equal(body.error, "launch_prepare_failed");
  assert.match(body.message, /unknown_preset/);
});

test("/submit saves a meteora launch with its config and its pool, and hands the adapter its context", async () => {
  const captured: any = {};
  const app = await makeApp({
    deps: {
      launchpad: makeMeteoraLaunchpad({
        broadcastLaunch: async (input) => {
          captured.broadcastInput = input;
          return {
            mintAddress: input.expectedMintAddress,
            txSignature: "meteora_signature",
          };
        },
      }),
      persistAgentTokenWithTreasury: async (input) => {
        captured.persistInput = input;
        return { tokenId: "tok_curve", creatorLockupEnd: input.creatorLockupEnd };
      },
    },
  });
  const res = await app.inject({
    method: "POST",
    url: "/launch/submit",
    payload: {
      prepareToken: makeValidPrepareToken({
        launchpad: "meteora",
        context: METEORA_CONTEXT,
      }),
      signedTxBase64: "anything",
    },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).txSignature, "meteora_signature");
  // The context comes back out of the signed token untouched.
  assert.deepEqual(captured.broadcastInput.context, METEORA_CONTEXT);
  assert.equal(captured.persistInput.launchpad, "meteora");
  assert.equal(captured.persistInput.meteoraConfigKey, METEORA_CONTEXT.configKey);
  assert.equal(captured.persistInput.bondingCurveAddress, METEORA_CONTEXT.poolAddress);
});

test("/submit saves no pool for a pump.fun launch", async () => {
  const captured: any = {};
  const app = await makeApp({
    deps: {
      persistAgentTokenWithTreasury: async (input) => {
        captured.persistInput = input;
        return { tokenId: "tok_pump", creatorLockupEnd: input.creatorLockupEnd };
      },
    },
  });
  const res = await app.inject({
    method: "POST",
    url: "/launch/submit",
    payload: { prepareToken: makeValidPrepareToken(), signedTxBase64: "anything" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(captured.persistInput.meteoraConfigKey, undefined);
  assert.equal(captured.persistInput.bondingCurveAddress, undefined);
});

test("/reconcile saves a meteora launch the same way submit would have", async () => {
  const captured: any = {};
  const app = await makeApp({
    deps: {
      launchpad: makeMeteoraLaunchpad(),
      confirmMintOnChain: async () => true,
      reconcileLaunch: async (input) => {
        captured.input = input;
        return {
          tokenId: "tok_curve",
          creatorLockupEnd: input.creatorLockupEnd,
          alreadyExisted: false,
        };
      },
    },
  });
  const res = await app.inject({
    method: "POST",
    url: "/launch/reconcile",
    payload: {
      prepareToken: makeValidPrepareToken({
        launchpad: "meteora",
        context: METEORA_CONTEXT,
      }),
      mintAddress: FIXED_MINT_B58,
      txSignature: "meteora_signature",
    },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(captured.input.launchpad, "meteora");
  assert.equal(captured.input.meteoraConfigKey, METEORA_CONTEXT.configKey);
  assert.equal(captured.input.bondingCurveAddress, METEORA_CONTEXT.poolAddress);
  assert.equal(captured.input.txSignature, "meteora_signature");
});

// The row itself. agentTokenCreateData is the pure half of the production
// persist (routes/tokenLaunchPartialSignBindings.ts); importing that file
// builds the database client and opens no connection.

const persistInput = (overrides: Record<string, unknown> = {}) => ({
  agentListingId: "listing_1",
  orgId: "org_1",
  mintAddress: FIXED_MINT_B58,
  txSignature: "sig_1",
  creatorAddress: USER_WALLET,
  creatorLockupEnd: new Date("2026-06-26T00:00:00Z"),
  name: "Eliza Token",
  symbol: "ELZ",
  description: "Test agent token",
  launchpad: "pumpfun",
  treasuryPdaAddress: "TreasuryPda11111111111111111111111111111111",
  treasuryAuthorityBump: 254,
  ...overrides,
});

test("a meteora launch is saved with its pool and config and no pump.fun link", async () => {
  setupEnv();
  const { agentTokenCreateData } = await import(
    "../routes/tokenLaunchPartialSignBindings.js"
  );
  const data = agentTokenCreateData(
    persistInput({
      launchpad: "meteora",
      meteoraConfigKey: METEORA_CONTEXT.configKey,
      bondingCurveAddress: METEORA_CONTEXT.poolAddress,
    }),
    { id: "listing_1", iconUrl: "https://example.com/icon.png" },
  );
  assert.equal(data.launchpad, "meteora");
  assert.equal(data.meteoraConfigKey, METEORA_CONTEXT.configKey);
  assert.equal(data.bondingCurveAddress, METEORA_CONTEXT.poolAddress);
  assert.equal(data.pumpfunUrl, undefined);
  assert.equal(data.status, "BONDING");
  assert.equal(data.mintAddress, FIXED_MINT_B58);
  assert.equal(data.imageUri, "https://example.com/icon.png");
});

test("a pump.fun launch keeps its pump.fun link, and a Bags launch has none", async () => {
  setupEnv();
  const { agentTokenCreateData } = await import(
    "../routes/tokenLaunchPartialSignBindings.js"
  );
  const listing = { id: "listing_1", iconUrl: null };
  const pump = agentTokenCreateData(persistInput(), listing);
  assert.equal(pump.pumpfunUrl, `https://pump.fun/coin/${FIXED_MINT_B58}`);
  assert.equal(pump.bondingCurveAddress, undefined);
  assert.equal(pump.meteoraConfigKey, undefined);

  const bags = agentTokenCreateData(
    persistInput({ launchpad: "bags", meteoraConfigKey: METEORA_CONTEXT.configKey }),
    listing,
  );
  assert.equal(bags.pumpfunUrl, undefined);
  assert.equal(bags.meteoraConfigKey, METEORA_CONTEXT.configKey);
});
