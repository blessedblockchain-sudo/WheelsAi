import { prisma } from "@wheelsai/db";
import type { Prisma } from "@wheelsai/db";

// Types
export interface CreateConversationInput {
  agentId: string;
  deploymentId?: string;
  externalId?: string;
  metadata?: Record<string, unknown>;
}

export interface AddMessageInput {
  role: "user" | "assistant" | "system" | "function";
  content: string;
  functionName?: string;
  functionArgs?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  tokens?: number;
}

export interface CreateMemoryContextInput {
  key: string;
  value: string;
  contextType: "fact" | "preference" | "summary" | "entity" | "custom";
  importance?: number;
  expiresAt?: Date;
  metadata?: Record<string, unknown>;
}

export interface SearchMemoryInput {
  query?: string;
  contextTypes?: string[];
  minImportance?: number;
  limit?: number;
}

// Conversation Management
export async function createConversation(
  userId: string,
  input: CreateConversationInput
) {
  // Verify agent belongs to user
  const agent = await prisma.agent.findFirst({
    where: { id: input.agentId, userId },
  });

  if (!agent) {
    throw new Error("Agent not found");
  }

  return prisma.conversation.create({
    data: {
      userId,
      agentId: input.agentId,
      deploymentId: input.deploymentId,
      externalId: input.externalId,
      metadata: input.metadata as Prisma.InputJsonValue,
    },
    include: {
      agent: { select: { id: true, name: true } },
      deployment: { select: { id: true, name: true } },
      _count: { select: { messages: true, memoryContexts: true } },
    },
  });
}

export async function getConversations(
  userId: string,
  options: {
    agentId?: string;
    deploymentId?: string;
    isActive?: boolean;
    limit?: number;
    offset?: number;
  } = {}
) {
  const { agentId, deploymentId, isActive, limit = 20, offset = 0 } = options;

  const where: Prisma.ConversationWhereInput = {
    userId,
    ...(agentId && { agentId }),
    ...(deploymentId && { deploymentId }),
    ...(isActive !== undefined && { isActive }),
  };

  const [conversations, total] = await Promise.all([
    prisma.conversation.findMany({
      where,
      include: {
        agent: { select: { id: true, name: true } },
        deployment: { select: { id: true, name: true } },
        _count: { select: { messages: true, memoryContexts: true } },
      },
      orderBy: { lastMessageAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.conversation.count({ where }),
  ]);

  return { conversations, total, limit, offset };
}

export async function getConversation(conversationId: string, userId: string) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, userId },
    include: {
      agent: { select: { id: true, name: true, systemPrompt: true } },
      deployment: { select: { id: true, name: true } },
      messages: {
        orderBy: { createdAt: "asc" },
        take: 100, // Limit messages loaded
      },
      memoryContexts: {
        where: {
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        orderBy: { importance: "desc" },
      },
      _count: { select: { messages: true, memoryContexts: true } },
    },
  });

  if (!conversation) {
    throw new Error("Conversation not found");
  }

  return conversation;
}

export async function getConversationByExternalId(
  externalId: string,
  userId: string
) {
  return prisma.conversation.findFirst({
    where: { externalId, userId },
    include: {
      agent: { select: { id: true, name: true } },
      _count: { select: { messages: true, memoryContexts: true } },
    },
  });
}

export async function updateConversation(
  conversationId: string,
  userId: string,
  data: {
    title?: string;
    summary?: string;
    isActive?: boolean;
    metadata?: Record<string, unknown>;
  }
) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, userId },
  });

  if (!conversation) {
    throw new Error("Conversation not found");
  }

  return prisma.conversation.update({
    where: { id: conversationId },
    data: {
      ...(data.title !== undefined && { title: data.title }),
      ...(data.summary !== undefined && { summary: data.summary }),
      ...(data.isActive !== undefined && { isActive: data.isActive }),
      ...(data.metadata && { metadata: data.metadata as Prisma.InputJsonValue }),
    },
    include: {
      agent: { select: { id: true, name: true } },
      _count: { select: { messages: true, memoryContexts: true } },
    },
  });
}

export async function deleteConversation(conversationId: string, userId: string) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, userId },
  });

  if (!conversation) {
    throw new Error("Conversation not found");
  }

  // Delete in order due to foreign keys
  await prisma.memoryContext.deleteMany({
    where: { conversationId },
  });

  await prisma.message.deleteMany({
    where: { conversationId },
  });

  await prisma.conversation.delete({
    where: { id: conversationId },
  });

  return { success: true };
}

// Message Management
export async function addMessage(
  conversationId: string,
  userId: string,
  input: AddMessageInput
) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, userId },
  });

  if (!conversation) {
    throw new Error("Conversation not found");
  }

  const [message] = await prisma.$transaction([
    prisma.message.create({
      data: {
        conversationId,
        role: input.role,
        content: input.content,
        functionName: input.functionName,
        functionArgs: input.functionArgs as Prisma.InputJsonValue,
        metadata: input.metadata as Prisma.InputJsonValue,
        tokens: input.tokens,
      },
    }),
    prisma.conversation.update({
      where: { id: conversationId },
      data: {
        lastMessageAt: new Date(),
        messageCount: { increment: 1 },
        totalTokens: input.tokens
          ? { increment: input.tokens }
          : undefined,
      },
    }),
  ]);

  return message;
}

export async function getMessages(
  conversationId: string,
  userId: string,
  options: { limit?: number; before?: Date; after?: Date } = {}
) {
  const { limit = 50, before, after } = options;

  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, userId },
  });

  if (!conversation) {
    throw new Error("Conversation not found");
  }

  return prisma.message.findMany({
    where: {
      conversationId,
      ...(before && { createdAt: { lt: before } }),
      ...(after && { createdAt: { gt: after } }),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

export async function deleteMessage(
  messageId: string,
  conversationId: string,
  userId: string
) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, userId },
  });

  if (!conversation) {
    throw new Error("Conversation not found");
  }

  const message = await prisma.message.findFirst({
    where: { id: messageId, conversationId },
  });

  if (!message) {
    throw new Error("Message not found");
  }

  await prisma.$transaction([
    prisma.message.delete({ where: { id: messageId } }),
    prisma.conversation.update({
      where: { id: conversationId },
      data: {
        messageCount: { decrement: 1 },
        totalTokens: message.tokens
          ? { decrement: message.tokens }
          : undefined,
      },
    }),
  ]);

  return { success: true };
}

// Memory Context Management
export async function addMemoryContext(
  conversationId: string,
  userId: string,
  input: CreateMemoryContextInput
) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, userId },
  });

  if (!conversation) {
    throw new Error("Conversation not found");
  }

  // Check if context with same key exists
  const existing = await prisma.memoryContext.findFirst({
    where: { conversationId, key: input.key },
  });

  if (existing) {
    // Update existing context
    return prisma.memoryContext.update({
      where: { id: existing.id },
      data: {
        value: input.value,
        contextType: input.contextType,
        importance: input.importance ?? existing.importance,
        expiresAt: input.expiresAt,
        metadata: input.metadata as Prisma.InputJsonValue,
        accessCount: { increment: 1 },
        lastAccessedAt: new Date(),
      },
    });
  }

  return prisma.memoryContext.create({
    data: {
      conversationId,
      key: input.key,
      value: input.value,
      contextType: input.contextType,
      importance: input.importance ?? 0.5,
      expiresAt: input.expiresAt,
      metadata: input.metadata as Prisma.InputJsonValue,
    },
  });
}

export async function getMemoryContexts(
  conversationId: string,
  userId: string,
  options: SearchMemoryInput = {}
) {
  const { contextTypes, minImportance, limit = 50 } = options;

  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, userId },
  });

  if (!conversation) {
    throw new Error("Conversation not found");
  }

  return prisma.memoryContext.findMany({
    where: {
      conversationId,
      ...(contextTypes?.length && { contextType: { in: contextTypes } }),
      ...(minImportance !== undefined && {
        importance: { gte: minImportance },
      }),
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    orderBy: { importance: "desc" },
    take: limit,
  });
}

export async function updateMemoryContext(
  contextId: string,
  conversationId: string,
  userId: string,
  data: {
    value?: string;
    importance?: number;
    expiresAt?: Date | null;
    metadata?: Record<string, unknown>;
  }
) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, userId },
  });

  if (!conversation) {
    throw new Error("Conversation not found");
  }

  const context = await prisma.memoryContext.findFirst({
    where: { id: contextId, conversationId },
  });

  if (!context) {
    throw new Error("Memory context not found");
  }

  return prisma.memoryContext.update({
    where: { id: contextId },
    data: {
      ...(data.value !== undefined && { value: data.value }),
      ...(data.importance !== undefined && { importance: data.importance }),
      ...(data.expiresAt !== undefined && { expiresAt: data.expiresAt }),
      ...(data.metadata && { metadata: data.metadata as Prisma.InputJsonValue }),
      lastAccessedAt: new Date(),
    },
  });
}

export async function deleteMemoryContext(
  contextId: string,
  conversationId: string,
  userId: string
) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, userId },
  });

  if (!conversation) {
    throw new Error("Conversation not found");
  }

  const context = await prisma.memoryContext.findFirst({
    where: { id: contextId, conversationId },
  });

  if (!context) {
    throw new Error("Memory context not found");
  }

  await prisma.memoryContext.delete({ where: { id: contextId } });

  return { success: true };
}

// Utility functions for memory retrieval
export async function getRelevantMemory(
  conversationId: string,
  userId: string,
  options: {
    contextTypes?: string[];
    minImportance?: number;
    limit?: number;
  } = {}
) {
  const { contextTypes, minImportance = 0.3, limit = 20 } = options;

  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, userId },
    include: {
      agent: { select: { systemPrompt: true } },
    },
  });

  if (!conversation) {
    throw new Error("Conversation not found");
  }

  // Get recent messages for context
  const recentMessages = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  // Get relevant memory contexts
  const memoryContexts = await prisma.memoryContext.findMany({
    where: {
      conversationId,
      importance: { gte: minImportance },
      ...(contextTypes?.length && { contextType: { in: contextTypes } }),
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    orderBy: [{ importance: "desc" }, { lastAccessedAt: "desc" }],
    take: limit,
  });

  // Update access counts
  if (memoryContexts.length > 0) {
    await prisma.memoryContext.updateMany({
      where: { id: { in: memoryContexts.map((m) => m.id) } },
      data: { accessCount: { increment: 1 }, lastAccessedAt: new Date() },
    });
  }

  return {
    systemPrompt: conversation.agent?.systemPrompt,
    summary: conversation.summary,
    recentMessages: recentMessages.reverse(),
    memoryContexts,
  };
}

// Auto-summarize conversation
export async function summarizeConversation(
  conversationId: string,
  userId: string,
  summary: string
) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, userId },
  });

  if (!conversation) {
    throw new Error("Conversation not found");
  }

  return prisma.conversation.update({
    where: { id: conversationId },
    data: { summary },
  });
}

// Extract facts from conversation (would be called by AI)
export async function extractFacts(
  conversationId: string,
  userId: string,
  facts: Array<{
    key: string;
    value: string;
    contextType: "fact" | "preference" | "entity";
    importance?: number;
  }>
) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, userId },
  });

  if (!conversation) {
    throw new Error("Conversation not found");
  }

  const results = await Promise.all(
    facts.map((fact) =>
      addMemoryContext(conversationId, userId, {
        key: fact.key,
        value: fact.value,
        contextType: fact.contextType,
        importance: fact.importance ?? 0.5,
      })
    )
  );

  return results;
}

// Decay importance over time (would be run periodically)
export async function decayMemoryImportance(
  decayFactor: number = 0.95,
  minImportance: number = 0.1
) {
  // Decay all memory contexts that haven't been accessed recently
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 7); // 7 days ago

  const contexts = await prisma.memoryContext.findMany({
    where: {
      lastAccessedAt: { lt: cutoffDate },
      importance: { gt: minImportance },
    },
  });

  for (const context of contexts) {
    const newImportance = Math.max(
      context.importance * decayFactor,
      minImportance
    );

    await prisma.memoryContext.update({
      where: { id: context.id },
      data: { importance: newImportance },
    });
  }

  return { decayed: contexts.length };
}

// Get conversation statistics
export async function getConversationStats(userId: string, agentId?: string) {
  const where: Prisma.ConversationWhereInput = {
    userId,
    ...(agentId && { agentId }),
  };

  const [totalConversations, activeConversations, messageStats, memoryStats] =
    await Promise.all([
      prisma.conversation.count({ where }),
      prisma.conversation.count({ where: { ...where, isActive: true } }),
      prisma.conversation.aggregate({
        where,
        _sum: { messageCount: true, totalTokens: true },
        _avg: { messageCount: true },
      }),
      prisma.memoryContext.count({
        where: { conversation: where },
      }),
    ]);

  return {
    totalConversations,
    activeConversations,
    totalMessages: messageStats._sum.messageCount ?? 0,
    totalTokens: messageStats._sum.totalTokens ?? 0,
    avgMessagesPerConversation: Math.round(messageStats._avg.messageCount ?? 0),
    totalMemoryContexts: memoryStats,
  };
}
