import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../middleware/auth.js";
import {
  createConversation,
  getConversations,
  getConversation,
  getConversationByExternalId,
  updateConversation,
  deleteConversation,
  addMessage,
  getMessages,
  deleteMessage,
  addMemoryContext,
  getMemoryContexts,
  updateMemoryContext,
  deleteMemoryContext,
  getRelevantMemory,
  summarizeConversation,
  extractFacts,
  getConversationStats,
} from "../services/memory.js";

export const memoryRoutes: FastifyPluginAsync = async (app) => {
  // Get conversation statistics
  app.get("/stats", {
    preHandler: [requireAuth],
    handler: async (request) => {
      const { agentId } = request.query as { agentId?: string };
      return getConversationStats(request.auth!.orgId, agentId);
    },
  });

  // List conversations
  app.get("/conversations", {
    preHandler: [requireAuth],
    handler: async (request) => {
      const query = request.query as {
        agentId?: string;
        deploymentId?: string;
        isActive?: string;
        limit?: string;
        offset?: string;
      };

      return getConversations(request.auth!.orgId, {
        agentId: query.agentId,
        deploymentId: query.deploymentId,
        isActive: query.isActive === "true" ? true : query.isActive === "false" ? false : undefined,
        limit: query.limit ? parseInt(query.limit) : undefined,
        offset: query.offset ? parseInt(query.offset) : undefined,
      });
    },
  });

  // Create conversation
  app.post("/conversations", {
    preHandler: [requireAuth],
    handler: async (request) => {
      const body = request.body as {
        agentId: string;
        deploymentId?: string;
        externalId?: string;
        metadata?: Record<string, unknown>;
      };

      return createConversation(request.auth!.orgId, body);
    },
  });

  // Get conversation by external ID
  app.get("/conversations/external/:externalId", {
    preHandler: [requireAuth],
    handler: async (request) => {
      const { externalId } = request.params as { externalId: string };
      const conversation = await getConversationByExternalId(
        externalId,
        request.auth!.orgId
      );

      if (!conversation) {
        return app.httpErrors.notFound("Conversation not found");
      }

      return conversation;
    },
  });

  // Get conversation details
  app.get("/conversations/:id", {
    preHandler: [requireAuth],
    handler: async (request) => {
      const { id } = request.params as { id: string };

      try {
        return await getConversation(id, request.auth!.orgId);
      } catch (error) {
        if ((error as Error).message === "Conversation not found") {
          return app.httpErrors.notFound("Conversation not found");
        }
        throw error;
      }
    },
  });

  // Update conversation
  app.patch("/conversations/:id", {
    preHandler: [requireAuth],
    handler: async (request) => {
      const { id } = request.params as { id: string };
      const body = request.body as {
        title?: string;
        summary?: string;
        isActive?: boolean;
        metadata?: Record<string, unknown>;
      };

      try {
        return await updateConversation(id, request.auth!.orgId, body);
      } catch (error) {
        if ((error as Error).message === "Conversation not found") {
          return app.httpErrors.notFound("Conversation not found");
        }
        throw error;
      }
    },
  });

  // Delete conversation
  app.delete("/conversations/:id", {
    preHandler: [requireAuth],
    handler: async (request) => {
      const { id } = request.params as { id: string };

      try {
        return await deleteConversation(id, request.auth!.orgId);
      } catch (error) {
        if ((error as Error).message === "Conversation not found") {
          return app.httpErrors.notFound("Conversation not found");
        }
        throw error;
      }
    },
  });

  // Get messages in conversation
  app.get("/conversations/:id/messages", {
    preHandler: [requireAuth],
    handler: async (request) => {
      const { id } = request.params as { id: string };
      const query = request.query as {
        limit?: string;
        before?: string;
        after?: string;
      };

      try {
        return await getMessages(id, request.auth!.orgId, {
          limit: query.limit ? parseInt(query.limit) : undefined,
          before: query.before ? new Date(query.before) : undefined,
          after: query.after ? new Date(query.after) : undefined,
        });
      } catch (error) {
        if ((error as Error).message === "Conversation not found") {
          return app.httpErrors.notFound("Conversation not found");
        }
        throw error;
      }
    },
  });

  // Add message to conversation
  app.post("/conversations/:id/messages", {
    preHandler: [requireAuth],
    handler: async (request) => {
      const { id } = request.params as { id: string };
      const body = request.body as {
        role: "user" | "assistant" | "system" | "function";
        content: string;
        functionName?: string;
        functionArgs?: Record<string, unknown>;
        metadata?: Record<string, unknown>;
        tokens?: number;
      };

      try {
        return await addMessage(id, request.auth!.orgId, body);
      } catch (error) {
        if ((error as Error).message === "Conversation not found") {
          return app.httpErrors.notFound("Conversation not found");
        }
        throw error;
      }
    },
  });

  // Delete message
  app.delete("/conversations/:id/messages/:messageId", {
    preHandler: [requireAuth],
    handler: async (request) => {
      const { id, messageId } = request.params as {
        id: string;
        messageId: string;
      };

      try {
        return await deleteMessage(messageId, id, request.auth!.orgId);
      } catch (error) {
        const msg = (error as Error).message;
        if (msg === "Conversation not found" || msg === "Message not found") {
          return app.httpErrors.notFound(msg);
        }
        throw error;
      }
    },
  });

  // Get memory contexts for conversation
  app.get("/conversations/:id/memory", {
    preHandler: [requireAuth],
    handler: async (request) => {
      const { id } = request.params as { id: string };
      const query = request.query as {
        contextTypes?: string;
        minImportance?: string;
        limit?: string;
      };

      try {
        return await getMemoryContexts(id, request.auth!.orgId, {
          contextTypes: query.contextTypes?.split(","),
          minImportance: query.minImportance
            ? parseFloat(query.minImportance)
            : undefined,
          limit: query.limit ? parseInt(query.limit) : undefined,
        });
      } catch (error) {
        if ((error as Error).message === "Conversation not found") {
          return app.httpErrors.notFound("Conversation not found");
        }
        throw error;
      }
    },
  });

  // Add memory context
  app.post("/conversations/:id/memory", {
    preHandler: [requireAuth],
    handler: async (request) => {
      const { id } = request.params as { id: string };
      const body = request.body as {
        key: string;
        value: string;
        contextType: "fact" | "preference" | "summary" | "entity" | "custom";
        importance?: number;
        expiresAt?: string;
        metadata?: Record<string, unknown>;
      };

      try {
        return await addMemoryContext(id, request.auth!.orgId, {
          ...body,
          expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
        });
      } catch (error) {
        if ((error as Error).message === "Conversation not found") {
          return app.httpErrors.notFound("Conversation not found");
        }
        throw error;
      }
    },
  });

  // Update memory context
  app.patch("/conversations/:id/memory/:contextId", {
    preHandler: [requireAuth],
    handler: async (request) => {
      const { id, contextId } = request.params as {
        id: string;
        contextId: string;
      };
      const body = request.body as {
        value?: string;
        importance?: number;
        expiresAt?: string | null;
        metadata?: Record<string, unknown>;
      };

      try {
        return await updateMemoryContext(contextId, id, request.auth!.orgId, {
          ...body,
          expiresAt:
            body.expiresAt === null
              ? null
              : body.expiresAt
                ? new Date(body.expiresAt)
                : undefined,
        });
      } catch (error) {
        const msg = (error as Error).message;
        if (
          msg === "Conversation not found" ||
          msg === "Memory context not found"
        ) {
          return app.httpErrors.notFound(msg);
        }
        throw error;
      }
    },
  });

  // Delete memory context
  app.delete("/conversations/:id/memory/:contextId", {
    preHandler: [requireAuth],
    handler: async (request) => {
      const { id, contextId } = request.params as {
        id: string;
        contextId: string;
      };

      try {
        return await deleteMemoryContext(contextId, id, request.auth!.orgId);
      } catch (error) {
        const msg = (error as Error).message;
        if (
          msg === "Conversation not found" ||
          msg === "Memory context not found"
        ) {
          return app.httpErrors.notFound(msg);
        }
        throw error;
      }
    },
  });

  // Get relevant memory for inference
  app.get("/conversations/:id/context", {
    preHandler: [requireAuth],
    handler: async (request) => {
      const { id } = request.params as { id: string };
      const query = request.query as {
        contextTypes?: string;
        minImportance?: string;
        limit?: string;
      };

      try {
        return await getRelevantMemory(id, request.auth!.orgId, {
          contextTypes: query.contextTypes?.split(","),
          minImportance: query.minImportance
            ? parseFloat(query.minImportance)
            : undefined,
          limit: query.limit ? parseInt(query.limit) : undefined,
        });
      } catch (error) {
        if ((error as Error).message === "Conversation not found") {
          return app.httpErrors.notFound("Conversation not found");
        }
        throw error;
      }
    },
  });

  // Summarize conversation
  app.post("/conversations/:id/summarize", {
    preHandler: [requireAuth],
    handler: async (request) => {
      const { id } = request.params as { id: string };
      const body = request.body as { summary: string };

      try {
        return await summarizeConversation(id, request.auth!.orgId, body.summary);
      } catch (error) {
        if ((error as Error).message === "Conversation not found") {
          return app.httpErrors.notFound("Conversation not found");
        }
        throw error;
      }
    },
  });

  // Extract facts from conversation
  app.post("/conversations/:id/extract", {
    preHandler: [requireAuth],
    handler: async (request) => {
      const { id } = request.params as { id: string };
      const body = request.body as {
        facts: Array<{
          key: string;
          value: string;
          contextType: "fact" | "preference" | "entity";
          importance?: number;
        }>;
      };

      try {
        return await extractFacts(id, request.auth!.orgId, body.facts);
      } catch (error) {
        if ((error as Error).message === "Conversation not found") {
          return app.httpErrors.notFound("Conversation not found");
        }
        throw error;
      }
    },
  });
};
