import { randomUUID } from "node:crypto";
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

type AgentLite = { id: string; name: string };
type DeploymentLite = { id: string; name: string };

function asObject(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function extractSummary(metadata: Prisma.JsonValue | null | undefined): string | null {
  const summary = asObject(metadata).summary;
  return typeof summary === "string" ? summary : null;
}

function serializeConversation(
  conversation: any,
  agent?: AgentLite,
  deployment?: DeploymentLite
) {
  const memoriesCount = conversation?._count?.memories ?? 0;
  const messagesCount = conversation?._count?.messages ?? 0;

  return {
    id: conversation.id,
    userId: conversation.userId ?? "",
    agentId: conversation.agentId ?? "",
    deploymentId: conversation.deploymentId ?? null,
    externalId: conversation.sessionId ?? null,
    title: conversation.title ?? null,
    summary: extractSummary(conversation.metadata),
    isActive: conversation.status === "active",
    messageCount: conversation.messageCount ?? 0,
    totalTokens: conversation.tokenCount ?? 0,
    metadata: conversation.metadata ?? null,
    lastMessageAt: conversation.lastMessageAt ?? conversation.createdAt,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    agent,
    deployment,
    _count: {
      messages: messagesCount,
      memoryContexts: memoriesCount,
    },
  };
}

function parseMessageFunctionArgs(
  functionCall: Prisma.JsonValue | null | undefined
): Record<string, unknown> | null {
  if (!functionCall || typeof functionCall !== "object" || Array.isArray(functionCall)) {
    return null;
  }
  const args = (functionCall as Record<string, unknown>).arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return null;
  }
  return args as Record<string, unknown>;
}

function parseMessageFunctionName(functionCall: Prisma.JsonValue | null | undefined): string | null {
  if (!functionCall || typeof functionCall !== "object" || Array.isArray(functionCall)) {
    return null;
  }
  const name = (functionCall as Record<string, unknown>).name;
  return typeof name === "string" ? name : null;
}

function serializeMessage(message: any) {
  const functionName = message.name ?? parseMessageFunctionName(message.functionCall);
  return {
    id: message.id,
    conversationId: message.conversationId,
    role: message.role,
    content: message.content,
    functionName,
    functionArgs: parseMessageFunctionArgs(message.functionCall),
    metadata: message.metadata ?? null,
    tokens: message.tokens ?? 0,
    createdAt: message.createdAt,
  };
}

function extractMemoryExpiresAt(sourceRange: Prisma.JsonValue | null | undefined): Date | null {
  const raw = asObject(sourceRange).expiresAt;
  if (typeof raw !== "string") return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function mergeMetadataWithExpiry(
  baseMetadata: Prisma.JsonValue | null | undefined,
  metadata: Record<string, unknown> | undefined,
  expiresAt: Date | null | undefined
): Prisma.InputJsonValue {
  const merged = {
    ...asObject(baseMetadata),
    ...(metadata ?? {}),
  };

  if (expiresAt === null) {
    delete merged.expiresAt;
  } else if (expiresAt instanceof Date) {
    merged.expiresAt = expiresAt.toISOString();
  }

  return merged as Prisma.InputJsonValue;
}

function extractMemoryMetadata(
  sourceRange: Prisma.JsonValue | null | undefined
): Record<string, unknown> | null {
  const metadata = asObject(sourceRange).metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  return metadata as Record<string, unknown>;
}

function mergeMemoryCompatPayload(
  baseSourceRange: Prisma.JsonValue | null | undefined,
  metadata: Record<string, unknown> | undefined,
  expiresAt: Date | null | undefined
): Prisma.InputJsonValue {
  const merged = {
    ...asObject(baseSourceRange),
  };

  if (metadata !== undefined) {
    if (Object.keys(metadata).length === 0) {
      delete merged.metadata;
    } else {
      merged.metadata = metadata;
    }
  }

  if (expiresAt === null) {
    delete merged.expiresAt;
  } else if (expiresAt instanceof Date) {
    merged.expiresAt = expiresAt.toISOString();
  }

  return merged as Prisma.InputJsonValue;
}

function serializeMemoryContext(memory: any) {
  const expiresAt = extractMemoryExpiresAt(memory.sourceRange);

  return {
    id: memory.id,
    conversationId: memory.conversationId,
    key: memory.key ?? "",
    value: memory.content,
    contextType: memory.type,
    importance: memory.importance,
    accessCount: memory.accessCount,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    metadata: extractMemoryMetadata(memory.sourceRange),
    lastAccessedAt: (memory.lastAccessedAt ?? memory.createdAt).toISOString(),
    createdAt: memory.createdAt.toISOString(),
    updatedAt: memory.updatedAt.toISOString(),
  };
}

function isMemoryExpired(memory: any, now = new Date()): boolean {
  const expiresAt = extractMemoryExpiresAt(memory.sourceRange);
  return expiresAt ? expiresAt <= now : false;
}

async function ensureConversationOwnership(conversationId: string, orgId: string) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, orgId },
  });

  if (!conversation) {
    throw new Error("Conversation not found");
  }

  return conversation;
}

// Conversation Management
export async function createConversation(
  orgId: string,
  input: CreateConversationInput
) {
  // Verify agent belongs to org
  const agent = await prisma.agent.findFirst({
    where: { id: input.agentId, orgId },
  });

  if (!agent) {
    throw new Error("Agent not found");
  }

  const sessionId = input.externalId || randomUUID();
  const metadata = mergeMetadataWithExpiry(null, input.metadata, undefined);

  const conversation = await prisma.conversation.create({
    data: {
      orgId,
      agentId: input.agentId,
      deploymentId: input.deploymentId ?? null,
      sessionId,
      metadata,
      status: "active",
    },
    include: {
      _count: { select: { messages: true, memories: true } },
    },
  });

  let deployment: DeploymentLite | undefined;
  if (conversation.deploymentId) {
    deployment =
      (await prisma.deployment.findUnique({
        where: { id: conversation.deploymentId },
        select: { id: true, name: true },
      })) ?? undefined;
  }

  return serializeConversation(conversation, { id: agent.id, name: agent.name }, deployment);
}

export async function getConversations(
  orgId: string,
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
    orgId,
    ...(agentId ? { agentId } : {}),
    ...(deploymentId ? { deploymentId } : {}),
    ...(isActive === true ? { status: "active" } : {}),
    ...(isActive === false ? { status: { not: "active" } } : {}),
  };

  const [conversations, total] = await Promise.all([
    prisma.conversation.findMany({
      where,
      include: {
        _count: { select: { messages: true, memories: true } },
      },
      orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
      take: limit,
      skip: offset,
    }),
    prisma.conversation.count({ where }),
  ]);

  const agentIds = Array.from(
    new Set(conversations.map((conversation) => conversation.agentId).filter(Boolean))
  ) as string[];
  const deploymentIds = Array.from(
    new Set(conversations.map((conversation) => conversation.deploymentId).filter(Boolean))
  ) as string[];

  const [agents, deployments] = await Promise.all([
    agentIds.length
      ? prisma.agent.findMany({
          where: { id: { in: agentIds } },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
    deploymentIds.length
      ? prisma.deployment.findMany({
          where: { id: { in: deploymentIds } },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
  ]);

  const agentMap = new Map(agents.map((agent) => [agent.id, agent]));
  const deploymentMap = new Map(deployments.map((deployment) => [deployment.id, deployment]));

  const serialized = conversations.map((conversation) =>
    serializeConversation(
      conversation,
      conversation.agentId ? agentMap.get(conversation.agentId) : undefined,
      conversation.deploymentId ? deploymentMap.get(conversation.deploymentId) : undefined
    )
  );

  return { conversations: serialized, total, limit, offset };
}

export async function getConversation(conversationId: string, orgId: string) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, orgId },
    include: {
      messages: {
        orderBy: { sequenceNum: "asc" },
        take: 100,
      },
      memories: {
        where: { isActive: true },
        orderBy: [{ importance: "desc" }, { updatedAt: "desc" }],
      },
      _count: { select: { messages: true, memories: true } },
    },
  });

  if (!conversation) {
    throw new Error("Conversation not found");
  }

  const [agent, deployment] = await Promise.all([
    conversation.agentId
      ? prisma.agent.findUnique({
          where: { id: conversation.agentId },
          select: { id: true, name: true, systemPrompt: true },
        })
      : Promise.resolve(null),
    conversation.deploymentId
      ? prisma.deployment.findUnique({
          where: { id: conversation.deploymentId },
          select: { id: true, name: true },
        })
      : Promise.resolve(null),
  ]);

  const now = new Date();
  const memoryContexts = conversation.memories
    .filter((memory) => !isMemoryExpired(memory, now))
    .map(serializeMemoryContext);

  return {
    ...serializeConversation(
      conversation,
      agent ? { id: agent.id, name: agent.name } : undefined,
      deployment ? { id: deployment.id, name: deployment.name } : undefined
    ),
    agent: agent
      ? {
          id: agent.id,
          name: agent.name,
          systemPrompt: agent.systemPrompt,
        }
      : undefined,
    messages: conversation.messages.map(serializeMessage),
    memoryContexts,
  };
}

export async function getConversationByExternalId(
  externalId: string,
  orgId: string
) {
  const conversation = await prisma.conversation.findFirst({
    where: { sessionId: externalId, orgId },
    include: {
      _count: { select: { messages: true, memories: true } },
    },
  });

  if (!conversation) {
    return null;
  }

  const [agent, deployment] = await Promise.all([
    conversation.agentId
      ? prisma.agent.findUnique({
          where: { id: conversation.agentId },
          select: { id: true, name: true },
        })
      : Promise.resolve(null),
    conversation.deploymentId
      ? prisma.deployment.findUnique({
          where: { id: conversation.deploymentId },
          select: { id: true, name: true },
        })
      : Promise.resolve(null),
  ]);

  return serializeConversation(
    conversation,
    agent ? { id: agent.id, name: agent.name } : undefined,
    deployment ? { id: deployment.id, name: deployment.name } : undefined
  );
}

export async function updateConversation(
  conversationId: string,
  orgId: string,
  data: {
    title?: string;
    summary?: string;
    isActive?: boolean;
    metadata?: Record<string, unknown>;
  }
) {
  const conversation = await ensureConversationOwnership(conversationId, orgId);
  const currentMetadata = asObject(conversation.metadata);

  const nextMetadata: Record<string, unknown> = {
    ...currentMetadata,
    ...(data.metadata ?? {}),
  };

  if (data.summary !== undefined) {
    if (data.summary === "") {
      delete nextMetadata.summary;
    } else {
      nextMetadata.summary = data.summary;
    }
  }

  const updated = await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      ...(data.title !== undefined ? { title: data.title } : {}),
      ...(data.isActive !== undefined
        ? { status: data.isActive ? "active" : "archived" }
        : {}),
      metadata: nextMetadata as Prisma.InputJsonValue,
    },
    include: {
      _count: { select: { messages: true, memories: true } },
    },
  });

  const [agent, deployment] = await Promise.all([
    updated.agentId
      ? prisma.agent.findUnique({
          where: { id: updated.agentId },
          select: { id: true, name: true },
        })
      : Promise.resolve(null),
    updated.deploymentId
      ? prisma.deployment.findUnique({
          where: { id: updated.deploymentId },
          select: { id: true, name: true },
        })
      : Promise.resolve(null),
  ]);

  return serializeConversation(
    updated,
    agent ? { id: agent.id, name: agent.name } : undefined,
    deployment ? { id: deployment.id, name: deployment.name } : undefined
  );
}

export async function deleteConversation(conversationId: string, orgId: string) {
  await ensureConversationOwnership(conversationId, orgId);

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
  orgId: string,
  input: AddMessageInput
) {
  await ensureConversationOwnership(conversationId, orgId);

  const lastMessage = await prisma.message.findFirst({
    where: { conversationId },
    orderBy: { sequenceNum: "desc" },
    select: { sequenceNum: true },
  });

  const sequenceNum = (lastMessage?.sequenceNum ?? 0) + 1;
  const tokenCount = input.tokens ?? 0;

  const [message] = await prisma.$transaction([
    prisma.message.create({
      data: {
        conversationId,
        role: input.role,
        content: input.content,
        name: input.functionName ?? null,
        functionCall:
          input.functionName || input.functionArgs
            ? ({
                name: input.functionName ?? null,
                arguments: input.functionArgs ?? null,
              } as Prisma.InputJsonValue)
            : undefined,
        metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
        tokens: tokenCount,
        sequenceNum,
      },
    }),
    prisma.conversation.update({
      where: { id: conversationId },
      data: {
        lastMessageAt: new Date(),
        messageCount: { increment: 1 },
        tokenCount: tokenCount ? { increment: tokenCount } : undefined,
      },
    }),
  ]);

  return serializeMessage(message);
}

export async function getMessages(
  conversationId: string,
  orgId: string,
  options: { limit?: number; before?: Date; after?: Date } = {}
) {
  const { limit = 50, before, after } = options;

  await ensureConversationOwnership(conversationId, orgId);

  const createdAt: Prisma.DateTimeFilter = {};
  if (before) {
    createdAt.lt = before;
  }
  if (after) {
    createdAt.gt = after;
  }

  const messages = await prisma.message.findMany({
    where: {
      conversationId,
      ...(before || after ? { createdAt } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  return messages.map(serializeMessage);
}

export async function deleteMessage(
  messageId: string,
  conversationId: string,
  orgId: string
) {
  await ensureConversationOwnership(conversationId, orgId);

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
        tokenCount: message.tokens ? { decrement: message.tokens } : undefined,
      },
    }),
  ]);

  return { success: true };
}

// Memory Context Management
export async function addMemoryContext(
  conversationId: string,
  orgId: string,
  input: CreateMemoryContextInput
) {
  await ensureConversationOwnership(conversationId, orgId);

  const existing = await prisma.memoryContext.findFirst({
    where: { conversationId, key: input.key, isActive: true },
  });

  if (existing) {
    const updated = await prisma.memoryContext.update({
      where: { id: existing.id },
      data: {
        content: input.value,
        type: input.contextType,
        importance: input.importance ?? existing.importance,
        ...(input.metadata !== undefined || input.expiresAt !== undefined
          ? {
              sourceRange: mergeMemoryCompatPayload(
                existing.sourceRange,
                input.metadata,
                input.expiresAt ?? undefined
              ),
            }
          : {}),
        accessCount: { increment: 1 },
        lastAccessedAt: new Date(),
        isActive: true,
      },
    });
    return serializeMemoryContext(updated);
  }

  const created = await prisma.memoryContext.create({
    data: {
      conversationId,
      key: input.key,
      content: input.value,
      type: input.contextType,
      importance: input.importance ?? 0.5,
      sourceRange: mergeMemoryCompatPayload(
        null,
        input.metadata,
        input.expiresAt ?? undefined
      ),
      isActive: true,
    },
  });

  return serializeMemoryContext(created);
}

export async function getMemoryContexts(
  conversationId: string,
  orgId: string,
  options: SearchMemoryInput = {}
) {
  const { contextTypes, minImportance, limit = 50 } = options;

  await ensureConversationOwnership(conversationId, orgId);

  const memories = await prisma.memoryContext.findMany({
    where: {
      conversationId,
      isActive: true,
      ...(contextTypes?.length ? { type: { in: contextTypes } } : {}),
      ...(minImportance !== undefined ? { importance: { gte: minImportance } } : {}),
    },
    orderBy: [{ importance: "desc" }, { updatedAt: "desc" }],
    take: limit * 3,
  });

  const now = new Date();
  return memories
    .filter((memory) => !isMemoryExpired(memory, now))
    .slice(0, limit)
    .map(serializeMemoryContext);
}

export async function updateMemoryContext(
  contextId: string,
  conversationId: string,
  orgId: string,
  data: {
    value?: string;
    importance?: number;
    expiresAt?: Date | null;
    metadata?: Record<string, unknown>;
  }
) {
  await ensureConversationOwnership(conversationId, orgId);

  const context = await prisma.memoryContext.findFirst({
    where: { id: contextId, conversationId },
  });

  if (!context) {
    throw new Error("Memory context not found");
  }

  const updated = await prisma.memoryContext.update({
    where: { id: contextId },
    data: {
      ...(data.value !== undefined ? { content: data.value } : {}),
      ...(data.importance !== undefined ? { importance: data.importance } : {}),
      ...(data.metadata !== undefined || data.expiresAt !== undefined
        ? {
            sourceRange: mergeMemoryCompatPayload(
              context.sourceRange,
              data.metadata,
              data.expiresAt
            ),
          }
        : {}),
      lastAccessedAt: new Date(),
    },
  });

  return serializeMemoryContext(updated);
}

export async function deleteMemoryContext(
  contextId: string,
  conversationId: string,
  orgId: string
) {
  await ensureConversationOwnership(conversationId, orgId);

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
  orgId: string,
  options: {
    contextTypes?: string[];
    minImportance?: number;
    limit?: number;
  } = {}
) {
  const { contextTypes, minImportance = 0.3, limit = 20 } = options;

  const conversation = await ensureConversationOwnership(conversationId, orgId);

  const [recentMessages, memoryContexts, agent] = await Promise.all([
    prisma.message.findMany({
      where: { conversationId },
      orderBy: { sequenceNum: "desc" },
      take: 10,
    }),
    prisma.memoryContext.findMany({
      where: {
        conversationId,
        isActive: true,
        importance: { gte: minImportance },
        ...(contextTypes?.length ? { type: { in: contextTypes } } : {}),
      },
      orderBy: [{ importance: "desc" }, { lastAccessedAt: "desc" }],
      take: limit * 3,
    }),
    conversation.agentId
      ? prisma.agent.findUnique({
          where: { id: conversation.agentId },
          select: { systemPrompt: true },
        })
      : Promise.resolve(null),
  ]);

  const now = new Date();
  const activeMemories = memoryContexts
    .filter((memory) => !isMemoryExpired(memory, now))
    .slice(0, limit);

  if (activeMemories.length > 0) {
    await prisma.memoryContext.updateMany({
      where: { id: { in: activeMemories.map((memory) => memory.id) } },
      data: { accessCount: { increment: 1 }, lastAccessedAt: now },
    });
  }

  return {
    systemPrompt: agent?.systemPrompt ?? null,
    summary: extractSummary(conversation.metadata),
    recentMessages: recentMessages.reverse().map(serializeMessage),
    memoryContexts: activeMemories.map(serializeMemoryContext),
  };
}

// Auto-summarize conversation
export async function summarizeConversation(
  conversationId: string,
  orgId: string,
  summary: string
) {
  return updateConversation(conversationId, orgId, { summary });
}

// Extract facts from conversation (would be called by AI)
export async function extractFacts(
  conversationId: string,
  orgId: string,
  facts: Array<{
    key: string;
    value: string;
    contextType: "fact" | "preference" | "entity";
    importance?: number;
  }>
) {
  await ensureConversationOwnership(conversationId, orgId);

  return Promise.all(
    facts.map((fact) =>
      addMemoryContext(conversationId, orgId, {
        key: fact.key,
        value: fact.value,
        contextType: fact.contextType,
        importance: fact.importance ?? 0.5,
      })
    )
  );
}

// Decay importance over time (would be run periodically)
export async function decayMemoryImportance(
  decayFactor: number = 0.95,
  minImportance: number = 0.1
) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 7);

  const contexts = await prisma.memoryContext.findMany({
    where: {
      isActive: true,
      lastAccessedAt: { lt: cutoffDate },
      importance: { gt: minImportance },
    },
  });

  for (const context of contexts) {
    const newImportance = Math.max(context.importance * decayFactor, minImportance);
    await prisma.memoryContext.update({
      where: { id: context.id },
      data: { importance: newImportance },
    });
  }

  return { decayed: contexts.length };
}

// Get conversation statistics
export async function getConversationStats(orgId: string, agentId?: string) {
  const where: Prisma.ConversationWhereInput = {
    orgId,
    ...(agentId ? { agentId } : {}),
  };

  const [totalConversations, activeConversations, conversationStats, memoryStats] =
    await Promise.all([
      prisma.conversation.count({ where }),
      prisma.conversation.count({ where: { ...where, status: "active" } }),
      prisma.conversation.aggregate({
        where,
        _sum: { messageCount: true, tokenCount: true },
        _avg: { messageCount: true },
      }),
      prisma.memoryContext.count({
        where: {
          isActive: true,
          conversation: {
            orgId,
            ...(agentId ? { agentId } : {}),
          },
        },
      }),
    ]);

  return {
    totalConversations,
    activeConversations,
    totalMessages: conversationStats._sum.messageCount ?? 0,
    totalTokens: conversationStats._sum.tokenCount ?? 0,
    avgMessagesPerConversation: Math.round(conversationStats._avg.messageCount ?? 0),
    totalMemoryContexts: memoryStats,
  };
}
