/**
 * Drives apps/api/src/services/loadAgentsForAttestation.ts.
 *
 * Pinning:
 *   - WHERE clause filters: reputationProgramInitialized = true, mint
 *     not empty (the worker's eligibility gate before tx fees)
 *   - Joins through agentListing → agent to surface agentId + orgId
 *     so the downstream loadUsageRecordsForReputation call has the
 *     multi-tenant key
 *   - Flattens to a single-level row the runAttestationTick can consume
 */

import assert from "node:assert/strict";
import test from "node:test";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ??
    "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

test("loadAgentsForAttestation: WHERE clause requires reputationProgramInitialized and non-empty mint", async () => {
  setupEnv();
  const { loadAgentsForAttestation } = await import(
    "../services/loadAgentsForAttestation.js"
  );
  let observed: unknown = null;
  await loadAgentsForAttestation(
    { now: new Date() },
    {
      prisma: {
        agentToken: {
          findMany: async (args: unknown) => {
            observed = args;
            return [];
          },
        },
      } as any,
    },
  );
  // Cast through any: shape match.
  const where = (observed as { where: { reputationProgramInitialized: boolean; mintAddress: { not: string } } }).where;
  assert.equal(where.reputationProgramInitialized, true);
  assert.deepEqual(where.mintAddress, { not: "" });
});

test("loadAgentsForAttestation: flattens joined fields into AttestableAgentLoadedRow", async () => {
  setupEnv();
  const { loadAgentsForAttestation } = await import(
    "../services/loadAgentsForAttestation.js"
  );
  const rows = await loadAgentsForAttestation(
    { now: new Date() },
    {
      prisma: {
        agentToken: {
          findMany: async () => [
            {
              id: "tok_A",
              mintAddress: "MintA",
              lastOnChainAttestationAt: null,
              agentListing: { agentId: "agt_A", agent: { orgId: "org_A" } },
            },
            {
              id: "tok_B",
              mintAddress: "MintB",
              lastOnChainAttestationAt: new Date("2026-05-13T10:00:00Z"),
              agentListing: { agentId: "agt_B", agent: { orgId: "org_B" } },
            },
          ],
        },
      } as any,
    },
  );
  assert.deepEqual(rows, [
    {
      tokenId: "tok_A",
      mintAddress: "MintA",
      lastOnChainAttestationAt: null,
      agentId: "agt_A",
      orgId: "org_A",
    },
    {
      tokenId: "tok_B",
      mintAddress: "MintB",
      lastOnChainAttestationAt: new Date("2026-05-13T10:00:00Z"),
      agentId: "agt_B",
      orgId: "org_B",
    },
  ]);
});

test("loadAgentsForAttestation: empty DB returns empty array", async () => {
  setupEnv();
  const { loadAgentsForAttestation } = await import(
    "../services/loadAgentsForAttestation.js"
  );
  const rows = await loadAgentsForAttestation(
    { now: new Date() },
    {
      prisma: {
        agentToken: {
          findMany: async () => [],
        },
      } as any,
    },
  );
  assert.deepEqual(rows, []);
});

test("loadAgentsForAttestation: a token whose listing has no agent is dropped, and the others are still loaded", async () => {
  setupEnv();
  const { loadAgentsForAttestation } = await import(
    "../services/loadAgentsForAttestation.js"
  );
  const rows = await loadAgentsForAttestation(
    { now: new Date() },
    {
      prisma: {
        agentToken: {
          findMany: async () => [
            {
              id: "tok_A",
              mintAddress: "MintA",
              lastOnChainAttestationAt: null,
              agentListing: { agentId: "agt_A", agent: { orgId: "org_A" } },
            },
            {
              id: "tok_flow",
              mintAddress: "MintFlow",
              lastOnChainAttestationAt: null,
              agentListing: { agentId: null, agent: null },
            },
            {
              id: "tok_B",
              mintAddress: "MintB",
              lastOnChainAttestationAt: null,
              agentListing: { agentId: "agt_B", agent: { orgId: "org_B" } },
            },
          ],
        },
      },
    },
  );
  assert.deepEqual(
    rows.map((row) => [row.tokenId, row.agentId, row.orgId]),
    [
      ["tok_A", "agt_A", "org_A"],
      ["tok_B", "agt_B", "org_B"],
    ],
  );
});
