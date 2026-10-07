import { prisma } from "@wheelsai/db";

import { resolveEmbeddingConfig } from "../config/embeddings.js";
import { createLogger } from "../utils/logger.js";
import { createEmbeddings } from "./embeddings.js";
import { persistChunkEmbedding, searchChunksByVector } from "./vectorSearch.js";

const logger = createLogger("knowledge-service");

// ============================================
// Knowledge Base CRUD
// ============================================

export async function createKnowledgeBase(orgId: string, input: {
  name: string;
  description?: string;
  embeddingModel?: string;
  chunkSize?: number;
  chunkOverlap?: number;
  agentIds?: string[];
}) {
  return prisma.knowledgeBase.create({
    data: {
      orgId,
      name: input.name,
      description: input.description,
      embeddingModel: input.embeddingModel || "text-embedding-ada-002",
      chunkSize: input.chunkSize ?? 512,
      chunkOverlap: input.chunkOverlap ?? 50,
      agentIds: input.agentIds || [],
    },
  });
}

export async function getKnowledgeBases(orgId: string, options: {
  limit?: number;
  offset?: number;
  status?: string;
} = {}) {
  const { limit = 20, offset = 0, status } = options;
  const where: any = { orgId };
  if (status) where.status = status;

  const [bases, total] = await Promise.all([
    prisma.knowledgeBase.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
      include: { _count: { select: { documents: true } } },
    }),
    prisma.knowledgeBase.count({ where }),
  ]);
  return { knowledgeBases: bases, total };
}

export async function getKnowledgeBase(id: string, orgId: string) {
  const kb = await prisma.knowledgeBase.findFirst({
    where: { id, orgId },
    include: {
      documents: { orderBy: { createdAt: "desc" }, take: 20 },
      _count: { select: { documents: true } },
    },
  });
  if (!kb) throw new Error("Knowledge base not found");
  return kb;
}

export async function updateKnowledgeBase(id: string, orgId: string, updates: {
  name?: string;
  description?: string;
  embeddingModel?: string;
  chunkSize?: number;
  chunkOverlap?: number;
  agentIds?: string[];
}) {
  const kb = await prisma.knowledgeBase.findFirst({ where: { id, orgId } });
  if (!kb) throw new Error("Knowledge base not found");
  return prisma.knowledgeBase.update({ where: { id }, data: updates });
}

export async function deleteKnowledgeBase(id: string, orgId: string) {
  const kb = await prisma.knowledgeBase.findFirst({ where: { id, orgId } });
  if (!kb) throw new Error("Knowledge base not found");
  await prisma.knowledgeBase.delete({ where: { id } });
  return { success: true };
}

// ============================================
// Document CRUD
// ============================================

export async function addDocument(knowledgeBaseId: string, orgId: string, input: {
  title: string;
  content: string;
  sourceType: string;
  fileName?: string;
  mimeType?: string;
  sourceUrl?: string;
  metadata?: Record<string, any>;
  tags?: string[];
}) {
  const kb = await prisma.knowledgeBase.findFirst({ where: { id: knowledgeBaseId, orgId } });
  if (!kb) throw new Error("Knowledge base not found");

  const sizeBytes = Buffer.byteLength(input.content, "utf-8");

  const doc = await prisma.knowledgeDocument.create({
    data: {
      knowledgeBaseId,
      title: input.title,
      rawContent: input.content,
      sourceType: input.sourceType,
      fileName: input.fileName,
      mimeType: input.mimeType,
      sourceUrl: input.sourceUrl,
      sizeBytes: BigInt(sizeBytes),
      metadata: input.metadata || {},
      tags: input.tags || [],
      status: "processing",
    },
  });

  const chunks = chunkText(input.content, kb.chunkSize, kb.chunkOverlap);
  await prisma.documentChunk.createMany({
    data: chunks.map((content, index) => ({
      documentId: doc.id,
      content,
      chunkIndex: index,
      tokenCount: Math.ceil(content.length / 4), // rough estimate
    })),
  });

  // Embed the new chunks when a provider is configured (W2 RAG). A
  // provider failure must NOT fail the upload — the document is already
  // stored and searchable by keyword, and the backfill worker picks up
  // anything left unembedded.
  await embedDocumentChunks(doc.id).catch((err) => {
    logger.warn({ err, documentId: doc.id }, "inline chunk embedding failed; backfill will retry");
  });

  // Update document and KB stats
  await prisma.knowledgeDocument.update({
    where: { id: doc.id },
    data: { status: "ready", chunkCount: chunks.length, processedAt: new Date() },
  });

  await prisma.knowledgeBase.update({
    where: { id: knowledgeBaseId },
    data: {
      totalDocuments: { increment: 1 },
      totalChunks: { increment: chunks.length },
      totalSizeBytes: { increment: BigInt(sizeBytes) },
    },
  });

  return { ...doc, chunkCount: chunks.length };
}

function chunkText(text: string, chunkSize: number, overlap: number): string[] {
  const chunks: string[] = [];
  const words = text.split(/\s+/);
  let i = 0;
  while (i < words.length) {
    const chunk = words.slice(i, i + chunkSize).join(" ");
    if (chunk.trim()) chunks.push(chunk);
    i += chunkSize - overlap;
  }
  return chunks.length > 0 ? chunks : [text];
}

export async function getDocuments(knowledgeBaseId: string, orgId: string, options: {
  status?: string;
  limit?: number;
  offset?: number;
} = {}) {
  const kb = await prisma.knowledgeBase.findFirst({ where: { id: knowledgeBaseId, orgId } });
  if (!kb) throw new Error("Knowledge base not found");

  const { status, limit = 20, offset = 0 } = options;
  const where: any = { knowledgeBaseId };
  if (status) where.status = status;

  const [documents, total] = await Promise.all([
    prisma.knowledgeDocument.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.knowledgeDocument.count({ where }),
  ]);
  return { documents, total };
}

export async function getDocument(docId: string, knowledgeBaseId: string, orgId: string) {
  const kb = await prisma.knowledgeBase.findFirst({ where: { id: knowledgeBaseId, orgId } });
  if (!kb) throw new Error("Knowledge base not found");

  const doc = await prisma.knowledgeDocument.findFirst({
    where: { id: docId, knowledgeBaseId },
    include: { chunks: { orderBy: { chunkIndex: "asc" } } },
  });
  if (!doc) throw new Error("Document not found");
  return doc;
}

export async function deleteDocument(docId: string, knowledgeBaseId: string, orgId: string) {
  const kb = await prisma.knowledgeBase.findFirst({ where: { id: knowledgeBaseId, orgId } });
  if (!kb) throw new Error("Knowledge base not found");

  const doc = await prisma.knowledgeDocument.findFirst({ where: { id: docId, knowledgeBaseId } });
  if (!doc) throw new Error("Document not found");

  await prisma.knowledgeDocument.delete({ where: { id: docId } });

  await prisma.knowledgeBase.update({
    where: { id: knowledgeBaseId },
    data: {
      totalDocuments: { decrement: 1 },
      totalChunks: { decrement: doc.chunkCount },
      totalSizeBytes: { decrement: doc.sizeBytes },
    },
  });

  return { success: true };
}

// ============================================
// Search / Query
// ============================================

/**
 * Searches a knowledge base, semantically when embeddings are available
 * and by keyword otherwise — and REPORTS WHICH (`mode`). The two are not
 * equivalent, so the caller and the UI are told which one answered rather
 * than being left to assume the better one (W2 RAG).
 *
 * Semantic requires both an embedding provider (env) and chunks that have
 * actually been embedded; either missing falls back to keyword with
 * `fallbackReason` explaining it. A provider error also falls back — a
 * degraded search beats a 500 on a search box.
 */
export async function searchKnowledgeBase(knowledgeBaseId: string, orgId: string, input: {
  query: string;
  limit?: number;
  minScore?: number;
}) {
  const kb = await prisma.knowledgeBase.findFirst({ where: { id: knowledgeBaseId, orgId } });
  if (!kb) throw new Error("Knowledge base not found");

  const { query, limit = 5 } = input;

  const semantic = await trySemanticSearch(knowledgeBaseId, query, limit);
  if (semantic.ok) return semantic.payload;
  const fallbackReason = semantic.reason;

  // Keyword-based search using database filtering to avoid loading all chunks into memory
  const queryWords = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (queryWords.length === 0) {
    return {
      results: [],
      query,
      totalChunksSearched: 0,
      mode: "keyword" as const,
      fallbackReason,
    };
  }

  // Use database-level filtering: find chunks containing at least one query word
  const chunks = await prisma.documentChunk.findMany({
    where: {
      document: { knowledgeBaseId },
      OR: queryWords.map((word) => ({
        content: { contains: word, mode: "insensitive" as const },
      })),
    },
    include: { document: { select: { title: true, sourceType: true } } },
    take: Math.max(limit * 10, 100), // Fetch a reasonable superset for scoring
  });

  const totalChunksSearched = chunks.length;

  // Score by how many query words match
  const scored = chunks.map((chunk) => {
    const content = chunk.content.toLowerCase();
    const matchCount = queryWords.filter((w) => content.includes(w)).length;
    const score = matchCount / queryWords.length;
    return { ...chunk, score };
  });

  scored.sort((a, b) => b.score - a.score);

  return {
    results: scored.slice(0, limit).map((c) => ({
      chunkId: c.id,
      documentId: c.documentId,
      documentTitle: c.document.title,
      content: c.content,
      score: c.score,
      chunkIndex: c.chunkIndex,
    })),
    query,
    totalChunksSearched,
    // Word-overlap ranking, NOT semantic similarity. Named so the caller
    // can say so too (same doctrine as the test runner's relabeled
    // "semantic" assertion).
    mode: "keyword" as const,
    fallbackReason,
  };
}

/**
 * Embeds every not-yet-embedded chunk of a document. No-op when no
 * provider is configured. Shared by the upload path and the backfill
 * worker so both produce identical rows.
 */
export async function embedDocumentChunks(documentId: string): Promise<number> {
  const config = resolveEmbeddingConfig();
  if (!config) return 0;

  const pending = await prisma.documentChunk.findMany({
    where: { documentId, embeddedAt: null },
    select: { id: true, content: true },
    orderBy: { chunkIndex: "asc" },
  });
  if (pending.length === 0) return 0;

  const embedded = await createEmbeddings({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    input: pending.map((c) => c.content),
  });

  for (const [i, chunk] of pending.entries()) {
    const vector = embedded.vectors[i];
    if (!vector) continue;
    await persistChunkEmbedding(prisma as never, {
      chunkId: chunk.id,
      vector,
      model: config.model,
      dimensions: embedded.dimensions,
    });
  }
  return pending.length;
}

interface SemanticSearchPayload {
  results: Array<{
    chunkId: string;
    documentId: string;
    documentTitle: string;
    content: string;
    score: number;
    chunkIndex: number;
  }>;
  query: string;
  totalChunksSearched: number;
  mode: "semantic";
  embeddingModel: string;
  fallbackReason: string | null;
}

type SemanticAttempt =
  | { ok: true; payload: SemanticSearchPayload }
  | { ok: false; reason: string };

/**
 * Attempts semantic search. Returns the reason it could not answer —
 * no provider, nothing embedded yet, or a provider failure — rather than
 * a bare null, so the caller can report WHY the result is keyword-ranked.
 * The reason is returned (not stored) because concurrent searches would
 * otherwise overwrite each other's explanation.
 */
async function trySemanticSearch(
  knowledgeBaseId: string,
  query: string,
  limit: number,
): Promise<SemanticAttempt> {
  const config = resolveEmbeddingConfig();
  if (!config) {
    return { ok: false, reason: "semantic search is temporarily unavailable" };
  }
  if (query.trim().length === 0) {
    return { ok: false, reason: "empty query" };
  }

  let embedded;
  try {
    embedded = await createEmbeddings({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      input: [query],
    });
  } catch (err) {
    logger.warn(
      { err, knowledgeBaseId },
      "embedding query failed; falling back to keyword search",
    );
    return {
      ok: false,
      reason: `embedding provider error: ${(err as Error).message}`,
    };
  }

  const queryVector = embedded.vectors[0];
  if (!queryVector) {
    return { ok: false, reason: "embedding provider returned no vector" };
  }

  const results = await searchChunksByVector(prisma as never, {
    knowledgeBaseId,
    queryVector,
    dimensions: embedded.dimensions,
    limit,
  });

  if (results.length === 0) {
    // Nothing embedded with THIS model yet (backfill hasn't run, or the
    // model changed). Keyword can still answer, so let it.
    return {
      ok: false,
      reason: `no chunks embedded with ${config.model} yet`,
    };
  }

  return {
    ok: true,
    payload: {
      results,
      query,
      totalChunksSearched: results.length,
      mode: "semantic",
      embeddingModel: config.model,
      fallbackReason: null,
    },
  };
}

export async function getKnowledgeStats(orgId: string) {
  const [totalBases, totalDocs, totalChunks] = await Promise.all([
    prisma.knowledgeBase.count({ where: { orgId } }),
    prisma.knowledgeDocument.count({ where: { knowledgeBase: { orgId } } }),
    prisma.documentChunk.count({ where: { document: { knowledgeBase: { orgId } } } }),
  ]);

  return { totalBases, totalDocuments: totalDocs, totalChunks };
}
