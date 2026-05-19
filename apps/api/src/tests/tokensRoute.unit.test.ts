import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { Keypair } from "@solana/web3.js";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

// Drives apps/api/src/routes/tokens.ts — the wizard endpoint that ties
// together the eligibility gate, the pumpfun create-token tx builder, and
// the AgentToken persistence. This route is what the launch UI calls when
// the user clicks "Launch Token". Every IO surface is DI'd so the test
// covers the orchestration and the failure-recovery semantics without
// touching pumpfun, Solana, or Prisma.
//
// Failure-recovery contract (pinned below):
//   - 400 not_eligible: NO mint generated, NO submit, NO persist
//   - 502 pumpfun_submit_failed: NO persist (no half-created token row)
//   - 500 persistence_failed AFTER submit: response surfaces mintAddress +
//     txSignature so the user can manually reconcile
//   - 200: AgentToken persisted with creatorLockupEnd = now + 30d

const eligibleState = () => ({
  agent: { id: "agent_1", name: "Eliza" },
  reputationScore: 60,
  deploymentAgeDays: 10,
  hasPublishedListing: true,
  alreadyTokenized: false,
  creatorAddress: "PaYer11111111111111111111111111111111111111",
});

function makeApp(opts: {
  authed?: boolean;
  loadEligibilityState?: (a: { agentId: string; orgId: string }) => Promise<any | null>;
  generateMintKeypair?: () => Keypair;
  submitPumpfunCreate?: (body: any) => Promise<{ mintAddress: string; txSignature: string }>;
  persistAgentToken?: (input: any) => Promise<{ tokenId: string; creatorLockupEnd: Date }>;
  now?: () => Date;
}) {
  setupEnv();
  const app = Fastify();
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    if (opts.authed !== false) {
      request.auth = { userId: "u1", orgId: "org_1", type: "jwt" };
    }
  });

  return import("../routes/tokenLaunch.js").then(async (mod) => {
    await app.register(
      mod.createTokenRoutes({
        loadEligibilityState:
          opts.loadEligibilityState ?? (async () => eligibleState()),
        generateMintKeypair:
          opts.generateMintKeypair ?? (() => Keypair.generate()),
        submitPumpfunCreate:
          opts.submitPumpfunCreate ??
          (async () => ({ mintAddress: "MintAddr", txSignature: "sig_x" })),
        persistAgentToken:
          opts.persistAgentToken ??
          (async () => ({
            tokenId: "tok_x",
            creatorLockupEnd: new Date("2026-05-26T00:00:00Z"),
          })),
        now: opts.now ?? (() => new Date("2026-04-26T00:00:00Z")),
      }),
    );
    return app;
  });
}

const validBody = () => ({
  agentId: "agent_1",
  symbol: "TEST",
  description: "Test agent token",
  imageUri: "ipfs://QmImage",
});

// ============================================
// Auth + lookup
// ============================================

test("POST /tokens returns 401 when unauthenticated", async () => {
  const app = await makeApp({ authed: false });
  const res = await app.inject({
    method: "POST",
    url: "/tokens",
    payload: validBody(),
  });
  assert.equal(res.statusCode, 401);
});

test("POST /tokens returns 404 when the agent is missing for this org", async () => {
  const app = await makeApp({ loadEligibilityState: async () => null });
  const res = await app.inject({
    method: "POST",
    url: "/tokens",
    payload: validBody(),
  });
  assert.equal(res.statusCode, 404);
});

test("POST /tokens scopes the eligibility lookup by orgId", async () => {
  let observedOrgId = "";
  const app = await makeApp({
    loadEligibilityState: async ({ orgId }) => {
      observedOrgId = orgId;
      return null;
    },
  });
  await app.inject({ method: "POST", url: "/tokens", payload: validBody() });
  assert.equal(observedOrgId, "org_1");
});

// ============================================
// Eligibility gate (400 not_eligible)
// ============================================

test("POST /tokens returns 400 with the reasons[] when the agent is not eligible", async () => {
  let submitCalls = 0;
  let persistCalls = 0;
  let mintCalls = 0;
  const app = await makeApp({
    loadEligibilityState: async () => ({
      ...eligibleState(),
      reputationScore: 30,
      deploymentAgeDays: 2,
    }),
    generateMintKeypair: () => {
      mintCalls += 1;
      return Keypair.generate();
    },
    submitPumpfunCreate: async () => {
      submitCalls += 1;
      return { mintAddress: "x", txSignature: "x" };
    },
    persistAgentToken: async () => {
      persistCalls += 1;
      return { tokenId: "x", creatorLockupEnd: new Date() };
    },
  });

  const res = await app.inject({
    method: "POST",
    url: "/tokens",
    payload: validBody(),
  });
  assert.equal(res.statusCode, 400);
  const body = res.json();
  assert.equal(body.error, "not_eligible");
  assert.deepEqual(body.reasons.sort(), [
    "reputation_too_low",
    "uptime_insufficient",
  ]);
  // Zero side effects when ineligible.
  assert.equal(mintCalls, 0);
  assert.equal(submitCalls, 0);
  assert.equal(persistCalls, 0);
});

// ============================================
// Schema validation
// ============================================

test("POST /tokens returns 400 when the body is missing required fields", async () => {
  const app = await makeApp({});
  const res = await app.inject({
    method: "POST",
    url: "/tokens",
    payload: { symbol: "X" }, // missing agentId
  });
  assert.equal(res.statusCode, 400);
});

test("POST /tokens rejects symbol > 10 chars (matches pumpfun limit)", async () => {
  const app = await makeApp({});
  const res = await app.inject({
    method: "POST",
    url: "/tokens",
    payload: { ...validBody(), symbol: "TOOLONGSYMBOL" },
  });
  assert.equal(res.statusCode, 400);
});

// ============================================
// Happy path
// ============================================

test("POST /tokens returns 200 with mintAddress + txSignature + lockupEnd on success", async () => {
  const submitCalls: any[] = [];
  const persistCalls: any[] = [];
  const fixedNow = new Date("2026-04-26T12:00:00Z");
  const expectedLockup = new Date(fixedNow.getTime() + 30 * 86_400 * 1000);

  const app = await makeApp({
    submitPumpfunCreate: async (body) => {
      submitCalls.push(body);
      return { mintAddress: "MintAddr1", txSignature: "sig_1" };
    },
    persistAgentToken: async (input) => {
      persistCalls.push(input);
      return {
        tokenId: "tok_1",
        creatorLockupEnd: expectedLockup,
      };
    },
    now: () => fixedNow,
  });

  const res = await app.inject({
    method: "POST",
    url: "/tokens",
    payload: validBody(),
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.mintAddress, "MintAddr1");
  assert.equal(body.txSignature, "sig_1");
  assert.equal(body.tokenId, "tok_1");
  assert.equal(body.creatorLockupEnd, expectedLockup.toISOString());

  // Submit was called with the right pumpportal body.
  assert.equal(submitCalls.length, 1);
  assert.equal(submitCalls[0].action, "create");
  assert.equal(submitCalls[0].tokenMetadata.symbol, "TEST");

  // Persist was called with creatorLockupEnd = now + 30d.
  assert.equal(persistCalls.length, 1);
  assert.equal(
    persistCalls[0].creatorLockupEnd.toISOString(),
    expectedLockup.toISOString(),
  );
});

test("POST /tokens forwards optional socials (twitter/telegram/website) into the pumpfun body", async () => {
  let observedBody: any = null;
  const app = await makeApp({
    submitPumpfunCreate: async (body) => {
      observedBody = body;
      return { mintAddress: "M", txSignature: "S" };
    },
  });
  const res = await app.inject({
    method: "POST",
    url: "/tokens",
    payload: {
      ...validBody(),
      twitter: "https://x.com/eliza",
      telegram: "https://t.me/eliza",
      website: "https://eliza.dev",
    },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(observedBody.tokenMetadata.twitter, "https://x.com/eliza");
  assert.equal(observedBody.tokenMetadata.telegram, "https://t.me/eliza");
  assert.equal(observedBody.tokenMetadata.website, "https://eliza.dev");
});

// ============================================
// Failure recovery
// ============================================

test("POST /tokens returns 502 when pumpfun submit fails — and does NOT persist a half-created token row", async () => {
  let persistCalls = 0;
  const app = await makeApp({
    submitPumpfunCreate: async () => {
      throw new Error("pumpportal 502");
    },
    persistAgentToken: async () => {
      persistCalls += 1;
      return { tokenId: "x", creatorLockupEnd: new Date() };
    },
  });
  const res = await app.inject({
    method: "POST",
    url: "/tokens",
    payload: validBody(),
  });
  assert.equal(res.statusCode, 502);
  assert.equal(res.json().error, "pumpfun_submit_failed");
  assert.equal(persistCalls, 0);
});

test("POST /tokens returns 500 with mintAddress + txSignature when persistence fails AFTER submit (manual reconciliation)", async () => {
  // The mint already exists on-chain at this point; the user must not lose it.
  // The error response includes both so the wizard can show "your token was created
  // at <mint>; click here to retry persisting it locally."
  const app = await makeApp({
    submitPumpfunCreate: async () => ({
      mintAddress: "MintOnChain",
      txSignature: "sig_onchain",
    }),
    persistAgentToken: async () => {
      throw new Error("db down");
    },
  });
  const res = await app.inject({
    method: "POST",
    url: "/tokens",
    payload: validBody(),
  });
  assert.equal(res.statusCode, 500);
  const body = res.json();
  assert.equal(body.error, "persistence_failed");
  assert.equal(body.mintAddress, "MintOnChain");
  assert.equal(body.txSignature, "sig_onchain");
});

// ============================================
// Creator lockup
// ============================================

test("POST /tokens computes creatorLockupEnd = now + 30 days deterministically", async () => {
  let observedInput: any = null;
  const fixedNow = new Date("2026-05-01T00:00:00Z");
  const app = await makeApp({
    persistAgentToken: async (input) => {
      observedInput = input;
      return { tokenId: "x", creatorLockupEnd: input.creatorLockupEnd };
    },
    now: () => fixedNow,
  });
  await app.inject({ method: "POST", url: "/tokens", payload: validBody() });
  assert.equal(
    observedInput.creatorLockupEnd.toISOString(),
    new Date(fixedNow.getTime() + 30 * 86_400 * 1000).toISOString(),
  );
});

// ============================================
// Mint keypair injection
// ============================================

test("POST /tokens uses the injected mint keypair so callers can pre-publish the mint or supply a vanity key", async () => {
  const presetMint = Keypair.generate();
  let observedMint = "";
  const app = await makeApp({
    generateMintKeypair: () => presetMint,
    submitPumpfunCreate: async (body) => {
      observedMint = body.mint;
      return { mintAddress: presetMint.publicKey.toBase58(), txSignature: "S" };
    },
  });
  await app.inject({ method: "POST", url: "/tokens", payload: validBody() });
  assert.equal(observedMint, presetMint.publicKey.toBase58());
});
