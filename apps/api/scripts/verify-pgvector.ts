/**
 * W2 RAG proof: pgvector cosine search works against the real database.
 *
 * This verifies the PLUMBING — the migration, the `vector` column, the
 * `<=>` operator, the dimension filter, the 1-distance score convention,
 * and the persist helpers — using hand-constructed vectors with KNOWN
 * geometry. It deliberately does NOT claim to verify embedding quality:
 * these are geometric fixtures, not sentence embeddings. Semantic
 * relevance is a property of the embedding model, and gets proven the day
 * a provider key is configured (EMBEDDING_PROVIDER).
 *
 * Fixtures (3-dimensional so the expected ordering is arithmetic, not
 * vibes): the query [1,0,0] must rank
 *   exact   [1,0,0]        score 1.00
 *   near    [0.9,0.1,0]    score ~0.99
 *   ortho   [0,1,0]        score 0.00
 * and a 4-dimensional row must be EXCLUDED (dimension filter), because
 * pgvector throws when comparing mismatched dimensions.
 *
 * Usage: npx tsx scripts/verify-pgvector.ts
 * Env:   DATABASE_URL
 */

import { prisma } from "../src/lib/prisma.js";
import {
  persistChunkEmbedding,
  searchChunksByVector,
} from "../src/services/vectorSearch.js";

function fail(msg: string): never {
  console.error(`\n❌ ${msg}`);
  process.exit(1);
}

function approx(actual: number, expected: number, tol = 0.02): boolean {
  return Math.abs(actual - expected) <= tol;
}

async function main() {
  const org = await prisma.organization.findFirst();
  if (!org) fail("no organization in the database to attach a knowledge base to");

  console.log("[1] creating throwaway knowledge base + document…");
  const kb = await prisma.knowledgeBase.create({
    data: {
      orgId: org.id,
      name: "pgvector verification (throwaway)",
      description: "Created by scripts/verify-pgvector.ts — safe to delete",
    },
  });
  const doc = await prisma.knowledgeDocument.create({
    data: {
      knowledgeBaseId: kb.id,
      title: "geometry fixtures",
      rawContent: "n/a",
      sourceType: "text",
      sizeBytes: BigInt(0),
      status: "ready",
    },
  });

  const fixtures: Array<{ label: string; vector: number[]; expected: number }> = [
    { label: "exact", vector: [1, 0, 0], expected: 1.0 },
    { label: "near", vector: [0.9, 0.1, 0], expected: 0.994 },
    { label: "ortho", vector: [0, 1, 0], expected: 0.0 },
  ];

  const chunkIds: Record<string, string> = {};
  for (const [i, f] of fixtures.entries()) {
    const chunk = await prisma.documentChunk.create({
      data: { documentId: doc.id, content: f.label, chunkIndex: i },
    });
    chunkIds[f.label] = chunk.id;
    await persistChunkEmbedding(prisma as never, {
      chunkId: chunk.id,
      vector: f.vector,
      model: "verification-fixture-3d",
      dimensions: 3,
    });
  }

  // A 4-dimensional row: pgvector would THROW comparing it to a 3-d
  // query, so the dimension filter must exclude it.
  const wrongDim = await prisma.documentChunk.create({
    data: { documentId: doc.id, content: "wrong-dimension", chunkIndex: 99 },
  });
  await persistChunkEmbedding(prisma as never, {
    chunkId: wrongDim.id,
    vector: [1, 0, 0, 0],
    model: "verification-fixture-4d",
    dimensions: 4,
  });
  console.log(`[2] persisted ${fixtures.length} 3-d fixtures + 1 mismatched-dimension row`);

  console.log("[3] querying with [1,0,0]…");
  const results = await searchChunksByVector(prisma as never, {
    knowledgeBaseId: kb.id,
    queryVector: [1, 0, 0],
    dimensions: 3,
    limit: 10,
  });

  for (const r of results) {
    console.log(`    ${r.content.padEnd(16)} score ${r.score.toFixed(4)}`);
  }

  // --- assertions ---
  if (results.length !== 3) {
    fail(
      `expected exactly 3 results (the mismatched-dimension row must be excluded), got ${results.length}`,
    );
  }
  const order = results.map((r) => r.content);
  if (order.join(",") !== "exact,near,ortho") {
    fail(`wrong cosine ordering: ${order.join(", ")}`);
  }
  for (const f of fixtures) {
    const row = results.find((r) => r.content === f.label)!;
    if (!approx(row.score, f.expected)) {
      fail(`${f.label}: score ${row.score} != expected ~${f.expected}`);
    }
  }
  if (results.some((r) => r.content === "wrong-dimension")) {
    fail("dimension filter failed — a 4-d row was compared against a 3-d query");
  }

  console.log("\n[4] cleaning up throwaway rows…");
  await prisma.knowledgeBase.delete({ where: { id: kb.id } });

  console.log("\n✅ pgvector verified: extension live, cosine ordering correct,");
  console.log("   score convention 1-distance correct, dimension filter excludes");
  console.log("   incompatible rows (which would otherwise throw).");

  await prisma.$disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
