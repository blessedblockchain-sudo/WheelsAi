import assert from "node:assert/strict";
import test from "node:test";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

// Drives apps/api/src/services/persistAgentToken.ts — the last untested A1
// dep. Persists the AgentToken row inside a $transaction so the launch
// route either wholly succeeds or has nothing to roll back.
//
// Why this is its own module: the launch route's failure-recovery contract
// (mintAddress surfaced on 500) depends on this function being a single
// atomic write, not a multi-statement sequence that can half-succeed.

interface CapturedTx {
  listingFindUnique?: any;
  agentTokenCreate?: any;
}

function makePrismaStub(opts: {
  listing: { id: string; agentId: string; orgId: string } | null;
}) {
  const captured: CapturedTx = {};
  const tx = {
    agentListing: {
      async findUnique(args: any) {
        captured.listingFindUnique = args;
        return opts.listing;
      },
    },
    agentToken: {
      async create(args: any) {
        captured.agentTokenCreate = args;
        return {
          id: "tok_new",
          creatorLockupEnd: args.data.creatorLockupEnd,
        };
      },
    },
  };
  let txCalls = 0;
  const prisma = {
    async $transaction<T>(fn: (c: typeof tx) => Promise<T>): Promise<T> {
      txCalls += 1;
      return fn(tx);
    },
  };
  return { prisma, captured, txCalls: () => txCalls };
}

const happyInput = () => ({
  agentId: "agent_1",
  orgId: "org_1",
  mintAddress: "MintAddr1",
  txSignature: "sig_1",
  creatorAddress: "CrEAToR111",
  creatorLockupEnd: new Date("2026-05-26T00:00:00Z"),
  name: "Eliza",
  symbol: "ELIZA",
  description: "Test token",
  imageUri: "ipfs://QmImage",
});

// ============================================
// Listing must exist
// ============================================

test("persistAgentTokenByPrisma throws when no listing exists for the agent", async () => {
  setupEnv();
  const { persistAgentTokenByPrisma } = await import(
    "../services/persistAgentToken.js"
  );
  const stub = makePrismaStub({ listing: null });
  await assert.rejects(
    () =>
      persistAgentTokenByPrisma(happyInput(), {
        prisma: stub.prisma as any,
      }),
    /listing/i,
  );
  // Token row is never created when the listing lookup fails.
  assert.equal(stub.captured.agentTokenCreate, undefined);
});

test("persistAgentTokenByPrisma scopes the listing lookup by agentId (orgId already verified upstream)", async () => {
  const { persistAgentTokenByPrisma } = await import(
    "../services/persistAgentToken.js"
  );
  const stub = makePrismaStub({
    listing: { id: "listing_1", agentId: "agent_1", orgId: "org_1" },
  });
  await persistAgentTokenByPrisma(happyInput(), { prisma: stub.prisma as any });
  assert.equal(stub.captured.listingFindUnique.where.agentId, "agent_1");
});

// ============================================
// Happy path
// ============================================

test("persistAgentTokenByPrisma writes an AgentToken row with every required field", async () => {
  const { persistAgentTokenByPrisma } = await import(
    "../services/persistAgentToken.js"
  );
  const stub = makePrismaStub({
    listing: { id: "listing_1", agentId: "agent_1", orgId: "org_1" },
  });
  await persistAgentTokenByPrisma(happyInput(), { prisma: stub.prisma as any });

  const data = stub.captured.agentTokenCreate.data;
  assert.equal(data.agentListingId, "listing_1");
  assert.equal(data.mintAddress, "MintAddr1");
  assert.equal(data.creatorAddress, "CrEAToR111");
  assert.equal(data.name, "Eliza");
  assert.equal(data.symbol, "ELIZA");
  assert.equal(data.imageUri, "ipfs://QmImage");
  assert.equal(
    data.creatorLockupEnd.toISOString(),
    "2026-05-26T00:00:00.000Z",
  );
});

test("persistAgentTokenByPrisma returns the created tokenId + lockupEnd", async () => {
  const { persistAgentTokenByPrisma } = await import(
    "../services/persistAgentToken.js"
  );
  const stub = makePrismaStub({
    listing: { id: "listing_1", agentId: "agent_1", orgId: "org_1" },
  });
  const result = await persistAgentTokenByPrisma(happyInput(), {
    prisma: stub.prisma as any,
  });
  assert.equal(result.tokenId, "tok_new");
  assert.equal(
    result.creatorLockupEnd.toISOString(),
    "2026-05-26T00:00:00.000Z",
  );
});

// ============================================
// Atomicity
// ============================================

test("persistAgentTokenByPrisma runs every write inside a single $transaction", async () => {
  const { persistAgentTokenByPrisma } = await import(
    "../services/persistAgentToken.js"
  );
  const stub = makePrismaStub({
    listing: { id: "listing_1", agentId: "agent_1", orgId: "org_1" },
  });
  await persistAgentTokenByPrisma(happyInput(), { prisma: stub.prisma as any });
  assert.equal(stub.txCalls(), 1);
});

// ============================================
// Optional fields
// ============================================

test("persistAgentTokenByPrisma omits imageUri when not supplied", async () => {
  const { persistAgentTokenByPrisma } = await import(
    "../services/persistAgentToken.js"
  );
  const stub = makePrismaStub({
    listing: { id: "listing_1", agentId: "agent_1", orgId: "org_1" },
  });
  const input = { ...happyInput(), imageUri: undefined };
  await persistAgentTokenByPrisma(input, { prisma: stub.prisma as any });
  // Field is undefined / absent — Prisma will default to nothing.
  assert.equal(stub.captured.agentTokenCreate.data.imageUri, undefined);
});

test("persistAgentTokenByPrisma sets pumpfunUrl from the well-known pump.fun /coin/<mint> path", async () => {
  // The route already has txSignature; the pumpfun URL is purely a function
  // of the mint address and is the link we render in the dashboard.
  const { persistAgentTokenByPrisma } = await import(
    "../services/persistAgentToken.js"
  );
  const stub = makePrismaStub({
    listing: { id: "listing_1", agentId: "agent_1", orgId: "org_1" },
  });
  await persistAgentTokenByPrisma(happyInput(), { prisma: stub.prisma as any });
  assert.equal(
    stub.captured.agentTokenCreate.data.pumpfunUrl,
    "https://pump.fun/coin/MintAddr1",
  );
});
