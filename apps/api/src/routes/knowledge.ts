import { FastifyInstance } from "fastify";
import { requireAuth } from "../middleware/auth.js";
import {
  createKnowledgeBase,
  getKnowledgeBases,
  getKnowledgeBase,
  updateKnowledgeBase,
  deleteKnowledgeBase,
  addDocument,
  getDocuments,
  getDocument,
  deleteDocument,
  searchKnowledgeBase,
  getKnowledgeStats,
} from "../services/knowledge.js";

// ============================================
// RAG / Knowledge Base Routes
// ============================================

export async function knowledgeRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // Get knowledge stats
  app.get("/stats", async (request, reply) => {
    try {
      const stats = await getKnowledgeStats(request.auth!.orgId);
      return reply.send(stats);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // Create knowledge base
  app.post<{
    Body: {
      name: string;
      description?: string;
      embeddingModel?: string;
      chunkSize?: number;
      chunkOverlap?: number;
      agentIds?: string[];
    };
  }>("/", async (request, reply) => {
    try {
      const kb = await createKnowledgeBase(request.auth!.orgId, request.body);
      return reply.status(201).send(kb);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // List knowledge bases
  app.get<{
    Querystring: { status?: string; limit?: string; offset?: string };
  }>("/", async (request, reply) => {
    try {
      const { status, limit, offset } = request.query;
      const result = await getKnowledgeBases(request.auth!.orgId, {
        status,
        limit: limit ? parseInt(limit) : undefined,
        offset: offset ? parseInt(offset) : undefined,
      });
      return reply.send(result);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // Get knowledge base
  app.get<{ Params: { kbId: string } }>("/:kbId", async (request, reply) => {
    try {
      const kb = await getKnowledgeBase(request.params.kbId, request.auth!.orgId);
      return reply.send(kb);
    } catch (error: any) {
      return reply.status(404).send({ error: error.message });
    }
  });

  // Update knowledge base
  app.patch<{
    Params: { kbId: string };
    Body: {
      name?: string;
      description?: string;
      embeddingModel?: string;
      chunkSize?: number;
      chunkOverlap?: number;
      agentIds?: string[];
    };
  }>("/:kbId", async (request, reply) => {
    try {
      const kb = await updateKnowledgeBase(request.params.kbId, request.auth!.orgId, request.body);
      return reply.send(kb);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // Delete knowledge base
  app.delete<{ Params: { kbId: string } }>("/:kbId", async (request, reply) => {
    try {
      await deleteKnowledgeBase(request.params.kbId, request.auth!.orgId);
      return reply.status(204).send();
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // Search knowledge base
  app.post<{
    Params: { kbId: string };
    Body: { query: string; limit?: number; minScore?: number };
  }>("/:kbId/search", async (request, reply) => {
    try {
      const result = await searchKnowledgeBase(request.params.kbId, request.auth!.orgId, request.body);
      return reply.send(result);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // Add document to knowledge base
  app.post<{
    Params: { kbId: string };
    Body: {
      title: string;
      content: string;
      sourceType: string;
      fileName?: string;
      mimeType?: string;
      sourceUrl?: string;
      metadata?: Record<string, any>;
      tags?: string[];
    };
  }>("/:kbId/documents", async (request, reply) => {
    try {
      const doc = await addDocument(request.params.kbId, request.auth!.orgId, request.body);
      return reply.status(201).send(doc);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // List documents
  app.get<{
    Params: { kbId: string };
    Querystring: { status?: string; limit?: string; offset?: string };
  }>("/:kbId/documents", async (request, reply) => {
    try {
      const { status, limit, offset } = request.query;
      const result = await getDocuments(request.params.kbId, request.auth!.orgId, {
        status,
        limit: limit ? parseInt(limit) : undefined,
        offset: offset ? parseInt(offset) : undefined,
      });
      return reply.send(result);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // Get document
  app.get<{
    Params: { kbId: string; docId: string };
  }>("/:kbId/documents/:docId", async (request, reply) => {
    try {
      const doc = await getDocument(request.params.docId, request.params.kbId, request.auth!.orgId);
      return reply.send(doc);
    } catch (error: any) {
      return reply.status(404).send({ error: error.message });
    }
  });

  // Delete document
  app.delete<{
    Params: { kbId: string; docId: string };
  }>("/:kbId/documents/:docId", async (request, reply) => {
    try {
      await deleteDocument(request.params.docId, request.params.kbId, request.auth!.orgId);
      return reply.status(204).send();
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });
}
