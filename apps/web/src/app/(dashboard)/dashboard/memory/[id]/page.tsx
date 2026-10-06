"use client";

import { useState, useEffect, useCallback, use } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Brain,
  MessageSquare,
  User,
  Bot,
  Settings2,
  Tag,
  Clock,
  Zap,
  Plus,
  Trash2,
  Edit2,
  Save,
  X,
  ChevronDown,
  ChevronUp,
  Sparkles,
  FileText,
  AlertCircle,
} from "lucide-react";
import {
  ApiError,
  memoryApi,
  type ConversationDetail,
  type Message,
  type MemoryContext,
  type ContextType,
} from "@/lib/api";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";

export default function ConversationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const resolvedParams = use(params);
  const router = useRouter();
  const [conversation, setConversation] = useState<ConversationDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [activeTab, setActiveTab] = useState<"messages" | "memory">("messages");
  const [editingTitle, setEditingTitle] = useState(false);
  const [title, setTitle] = useState("");
  const [editingSummary, setEditingSummary] = useState(false);
  const [summary, setSummary] = useState("");
  const [showAddMemory, setShowAddMemory] = useState(false);
  const [newMemory, setNewMemory] = useState({
    key: "",
    value: "",
    contextType: "fact" as ContextType,
    importance: 0.5,
  });

  const loadConversation = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const data = await memoryApi.getConversation(resolvedParams.id);
      setConversation(data);
      setTitle(data.title || "");
      setSummary(data.summary || "");
    } catch (error) {
      console.error("Failed to load conversation:", error);
      setLoadError(error);
    } finally {
      setLoading(false);
    }
  }, [resolvedParams.id]);

  useEffect(() => {
    loadConversation();
  }, [loadConversation]);

  async function updateTitle() {
    if (!conversation) return;
    try {
      const updated = await memoryApi.updateConversation(conversation.id, { title });
      setConversation({ ...conversation, title: updated.title });
      setEditingTitle(false);
    } catch (error) {
      console.error("Failed to update title:", error);
    }
  }

  async function updateSummary() {
    if (!conversation) return;
    try {
      const updated = await memoryApi.summarizeConversation(conversation.id, summary);
      setConversation({ ...conversation, summary: updated.summary });
      setEditingSummary(false);
    } catch (error) {
      console.error("Failed to update summary:", error);
    }
  }

  async function addMemoryContext() {
    if (!conversation || !newMemory.key || !newMemory.value) return;
    try {
      const created = await memoryApi.addMemoryContext(conversation.id, newMemory);
      setConversation({
        ...conversation,
        memoryContexts: [...conversation.memoryContexts, created],
      });
      setNewMemory({ key: "", value: "", contextType: "fact", importance: 0.5 });
      setShowAddMemory(false);
    } catch (error) {
      console.error("Failed to add memory context:", error);
    }
  }

  async function deleteMemoryContext(contextId: string) {
    if (!conversation) return;
    try {
      await memoryApi.deleteMemoryContext(conversation.id, contextId);
      setConversation({
        ...conversation,
        memoryContexts: conversation.memoryContexts.filter((m) => m.id !== contextId),
      });
    } catch (error) {
      console.error("Failed to delete memory context:", error);
    }
  }

  async function toggleActive() {
    if (!conversation) return;
    try {
      const updated = await memoryApi.updateConversation(conversation.id, {
        isActive: !conversation.isActive,
      });
      setConversation({ ...conversation, isActive: updated.isActive });
    } catch (error) {
      console.error("Failed to toggle active status:", error);
    }
  }

  if (loading) {
    return <ConversationDetailSkeleton />;
  }

  // A 404 is "not found"; anything else is a failed load the user can retry.
  const notFound = loadError instanceof ApiError && loadError.status === 404;

  if (loadError && !notFound) {
    return (
      <ErrorState
        title="Couldn't load conversation"
        error={loadError}
        onRetry={() => void loadConversation()}
        actionLabel="Go back to Memory"
        actionHref="/dashboard/memory"
      />
    );
  }

  if (notFound || !conversation) {
    return (
      <EmptyState
        icon={AlertCircle}
        title="Conversation not found"
        description="It may have been deleted, or the link may be wrong."
        actionLabel="Go back to Memory"
        actionHref="/dashboard/memory"
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <button
            onClick={() => router.push("/dashboard/memory")}
            className="p-2 hover:bg-muted rounded-lg transition-colors"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div>
            {editingTitle ? (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="text-2xl font-bold text-foreground border-b-2 border-primary-500 focus:outline-none bg-transparent"
                  autoFocus
                />
                <button
                  onClick={updateTitle}
                  className="p-1 text-green-600 hover:bg-green-500/10 rounded"
                >
                  <Save className="h-4 w-4" />
                </button>
                <button
                  onClick={() => {
                    setTitle(conversation.title || "");
                    setEditingTitle(false);
                  }}
                  className="p-1 text-gray-400 hover:bg-muted rounded"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-bold text-foreground">
                  {conversation.title || `Conversation ${conversation.id.slice(0, 8)}`}
                </h1>
                <button
                  onClick={() => setEditingTitle(true)}
                  className="p-1 text-gray-400 hover:text-foreground hover:bg-muted rounded"
                >
                  <Edit2 className="h-4 w-4" />
                </button>
              </div>
            )}
            <div className="flex items-center gap-3 mt-1 text-sm text-muted-foreground">
              {conversation.agent && (
                <span className="flex items-center gap-1">
                  <Bot className="h-4 w-4" />
                  {conversation.agent.name}
                </span>
              )}
              <span className="flex items-center gap-1">
                <MessageSquare className="h-4 w-4" />
                {conversation.messageCount} messages
              </span>
              <span className="flex items-center gap-1">
                <Zap className="h-4 w-4" />
                {conversation.totalTokens} tokens
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={toggleActive}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              conversation.isActive
                ? "bg-green-500/10 text-green-500"
                : "bg-muted text-muted-foreground"
            }`}
          >
            {conversation.isActive ? "Active" : "Inactive"}
          </button>
        </div>
      </div>

      {/* Summary */}
      <div className="bg-card rounded-xl border border-border p-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-medium text-foreground flex items-center gap-2">
            <FileText className="h-4 w-4" />
            Summary
          </h3>
          {!editingSummary && (
            <button
              onClick={() => setEditingSummary(true)}
              className="p-1 text-gray-400 hover:text-foreground hover:bg-muted rounded"
            >
              <Edit2 className="h-4 w-4" />
            </button>
          )}
        </div>
        {editingSummary ? (
          <div className="space-y-2">
            <textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 bg-background text-foreground placeholder:text-muted-foreground border border-input rounded-lg focus:outline-none focus:ring-2 focus:ring-ring focus:border-primary"
              placeholder="Add a summary of this conversation..."
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  setSummary(conversation.summary || "");
                  setEditingSummary(false);
                }}
                className="px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted rounded-lg"
              >
                Cancel
              </button>
              <button
                onClick={updateSummary}
                className="px-3 py-1.5 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700"
              >
                Save
              </button>
            </div>
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">
            {conversation.summary || "No summary yet. Click edit to add one."}
          </p>
        )}
      </div>

      {/* Tabs */}
      <div className="border-b border-border">
        <nav className="flex space-x-8">
          <button
            onClick={() => setActiveTab("messages")}
            className={`py-4 px-1 border-b-2 font-medium text-sm transition-colors ${
              activeTab === "messages"
                ? "border-primary-500 text-primary-600"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <MessageSquare className="inline h-4 w-4 mr-2" />
            Messages ({conversation.messages.length})
          </button>
          <button
            onClick={() => setActiveTab("memory")}
            className={`py-4 px-1 border-b-2 font-medium text-sm transition-colors ${
              activeTab === "memory"
                ? "border-primary-500 text-primary-600"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <Brain className="inline h-4 w-4 mr-2" />
            Memory Contexts ({conversation.memoryContexts.length})
          </button>
        </nav>
      </div>

      {/* Messages Tab */}
      {activeTab === "messages" &&
        (conversation.messages.length === 0 ? (
          <EmptyState
            icon={MessageSquare}
            title="No messages"
            description="This conversation has no messages yet."
          />
        ) : (
          <div className="bg-card rounded-xl border border-border overflow-hidden">
            <div className="divide-y divide-border">
              {conversation.messages.map((message) => (
                <MessageItem key={message.id} message={message} />
              ))}
            </div>
          </div>
        ))}

      {/* Memory Tab */}
      {activeTab === "memory" && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button
              onClick={() => setShowAddMemory(true)}
              className="flex items-center gap-2 px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors"
            >
              <Plus className="h-4 w-4" />
              Add Memory
            </button>
          </div>

          {/* Add Memory Form */}
          {showAddMemory && (
            <div className="bg-card rounded-xl border border-border p-4 space-y-4">
              <h3 className="font-medium text-foreground">Add Memory Context</h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1">
                    Key
                  </label>
                  <input
                    type="text"
                    value={newMemory.key}
                    onChange={(e) => setNewMemory({ ...newMemory, key: e.target.value })}
                    className="w-full px-3 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary-500"
                    placeholder="e.g., user_name"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1">
                    Type
                  </label>
                  <select
                    value={newMemory.contextType}
                    onChange={(e) =>
                      setNewMemory({ ...newMemory, contextType: e.target.value as ContextType })
                    }
                    className="w-full px-3 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary-500"
                  >
                    <option value="fact">Fact</option>
                    <option value="preference">Preference</option>
                    <option value="summary">Summary</option>
                    <option value="entity">Entity</option>
                    <option value="custom">Custom</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">
                  Value
                </label>
                <textarea
                  value={newMemory.value}
                  onChange={(e) => setNewMemory({ ...newMemory, value: e.target.value })}
                  rows={2}
                  className="w-full px-3 py-2 bg-background text-foreground placeholder:text-muted-foreground border border-input rounded-lg focus:outline-none focus:ring-2 focus:ring-ring"
                  placeholder="The memory content..."
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">
                  Importance: {newMemory.importance}
                </label>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.1"
                  value={newMemory.importance}
                  onChange={(e) =>
                    setNewMemory({ ...newMemory, importance: parseFloat(e.target.value) })
                  }
                  className="w-full"
                />
              </div>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setShowAddMemory(false)}
                  className="px-4 py-2 text-muted-foreground hover:bg-muted rounded-lg"
                >
                  Cancel
                </button>
                <button
                  onClick={addMemoryContext}
                  disabled={!newMemory.key || !newMemory.value}
                  className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Add Memory
                </button>
              </div>
            </div>
          )}

          {/* Memory List */}
          {conversation.memoryContexts.length === 0 ? (
            <EmptyState
              icon={Brain}
              title="No memory contexts"
              description="Add memory contexts to help your agent remember important information."
              actionLabel="Add Memory"
              // Hidden while the add form above is already open.
              onAction={showAddMemory ? undefined : () => setShowAddMemory(true)}
            />
          ) : (
            <div className="bg-card rounded-xl border border-border overflow-hidden">
              <div className="divide-y divide-border">
                {conversation.memoryContexts.map((context) => (
                  <MemoryContextItem
                    key={context.id}
                    context={context}
                    onDelete={() => deleteMemoryContext(context.id)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Mirrors the page layout: header, summary card, tab bar, message rows. */
function ConversationDetailSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-4 min-w-0">
          <Skeleton className="h-9 w-9 rounded-lg shrink-0" />
          <div className="space-y-2 min-w-0">
            <Skeleton className="h-8 w-64 max-w-full" />
            <Skeleton className="h-5 w-72 max-w-full" />
          </div>
        </div>
        <Skeleton className="h-8 w-20 rounded-lg shrink-0" />
      </div>

      <div className="bg-card rounded-xl border border-border p-4 space-y-2">
        <Skeleton className="h-6 w-28" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>

      <div className="border-b border-border">
        <div className="flex space-x-8">
          <div className="py-4 px-1">
            <Skeleton className="h-5 w-32" />
          </div>
          <div className="py-4 px-1">
            <Skeleton className="h-5 w-44" />
          </div>
        </div>
      </div>

      <div className="bg-card rounded-xl border border-border overflow-hidden divide-y divide-border">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="px-6 py-4 flex gap-3">
            <Skeleton className="h-8 w-8 rounded-lg shrink-0" />
            <div className="flex-1 min-w-0 space-y-2">
              <div className="flex items-center gap-2">
                <Skeleton className="h-5 w-20" />
                <Skeleton className="h-3 w-32" />
              </div>
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
            </div>
          </div>
        ))}
      </div>
      <span className="sr-only">Loading conversation</span>
    </div>
  );
}

function MessageItem({ message }: { message: Message }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = message.content.length > 500;

  const roleConfig = {
    user: {
      icon: User,
      bg: "bg-blue-500/10",
      iconBg: "bg-blue-500/10",
      iconColor: "text-blue-600",
    },
    assistant: {
      icon: Bot,
      bg: "bg-muted",
      iconBg: "bg-primary/15",
      iconColor: "text-primary-600",
    },
    system: {
      icon: Settings2,
      bg: "bg-yellow-500/10",
      iconBg: "bg-yellow-500/10",
      iconColor: "text-yellow-600",
    },
    function: {
      icon: Sparkles,
      bg: "bg-purple-500/10",
      iconBg: "bg-purple-500/10",
      iconColor: "text-purple-600",
    },
  };

  const config = roleConfig[message.role] || roleConfig.user;
  const Icon = config.icon;

  return (
    <div className={`px-6 py-4 ${config.bg}`}>
      <div className="flex gap-3">
        <div className={`p-2 rounded-lg ${config.iconBg} h-fit`}>
          <Icon className={`h-4 w-4 ${config.iconColor}`} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-medium text-foreground capitalize">{message.role}</span>
            {message.functionName && (
              <span className="text-xs bg-purple-500/10 text-purple-500 px-2 py-0.5 rounded">
                {message.functionName}
              </span>
            )}
            <span className="text-xs text-muted-foreground">
              {new Date(message.createdAt).toLocaleString()}
            </span>
            {message.tokens && (
              <span className="text-xs text-gray-400">{message.tokens} tokens</span>
            )}
          </div>
          <div className="text-sm text-foreground whitespace-pre-wrap">
            {isLong && !expanded ? (
              <>
                {message.content.slice(0, 500)}...
                <button
                  onClick={() => setExpanded(true)}
                  className="text-primary-600 hover:underline ml-1"
                >
                  Show more
                </button>
              </>
            ) : (
              <>
                {message.content}
                {isLong && (
                  <button
                    onClick={() => setExpanded(false)}
                    className="text-primary-600 hover:underline ml-1"
                  >
                    Show less
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function MemoryContextItem({
  context,
  onDelete,
}: {
  context: MemoryContext;
  onDelete: () => void;
}) {
  const typeColors: Record<string, string> = {
    fact: "bg-blue-500/10 text-blue-500",
    preference: "bg-green-500/10 text-green-500",
    summary: "bg-yellow-500/10 text-yellow-500",
    entity: "bg-purple-500/10 text-purple-500",
    custom: "bg-muted text-foreground",
  };

  return (
    <div className="px-6 py-4 hover:bg-muted transition-colors">
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-medium text-foreground">{context.key}</span>
            <span
              className={`text-xs px-2 py-0.5 rounded ${typeColors[context.contextType] || typeColors.custom}`}
            >
              {context.contextType}
            </span>
            <span className="text-xs text-gray-400">
              Importance: {(context.importance * 100).toFixed(0)}%
            </span>
          </div>
          <p className="text-sm text-muted-foreground">{context.value}</p>
          <div className="flex items-center gap-4 mt-2 text-xs text-gray-400">
            <span>Accessed {context.accessCount} times</span>
            <span>Last: {new Date(context.lastAccessedAt).toLocaleDateString()}</span>
            {context.expiresAt && (
              <span className="text-yellow-600">
                Expires: {new Date(context.expiresAt).toLocaleDateString()}
              </span>
            )}
          </div>
        </div>
        <button
          onClick={onDelete}
          className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-500/10 rounded-lg transition-colors"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
