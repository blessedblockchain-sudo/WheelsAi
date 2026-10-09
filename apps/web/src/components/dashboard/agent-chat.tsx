"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, ChevronRight, Loader2, Send, Settings, User, Wrench } from "lucide-react";
import { toast } from "sonner";

import { ModelSelector } from "@/components/dashboard/model-selector";
import { SkillStatusBadge, SkillUnavailableNote } from "@/components/dashboard/skill-status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { ResultView } from "@/components/ui/result-view";
import { Skeleton } from "@/components/ui/skeleton";
import {
  agentsApi,
  getErrorMessage,
  playgroundApi,
  skillsApi,
  streamPlaygroundChat,
  type AgentDetail,
  type PlaygroundToolCall,
  type Skill,
} from "@/lib/api";
import { cn } from "@/lib/utils";

export interface AgentChatProps {
  agentId: string;
  /** Shown until the agent has loaded, and in place of its name when given. */
  agentName?: string;
  className?: string;
  /** The loaded agent, when the caller already has it. Left out, the chat loads it. */
  agent?: AgentDetail;
  /**
   * A chip beside the name in the top bar, such as "Playground". With it the
   * chat reads as a test bench; without it, as the owner's own chat with
   * their agent.
   */
  badge?: string;
  /** Leave the agent's name out of the top bar, for a page that already shows it. */
  hideName?: boolean;
}

interface Message {
  role: "user" | "assistant";
  content: string;
  /** Tools the model called to produce this answer, and how each ended. */
  toolCalls?: PlaygroundToolCall[];
}

/** Where the picker starts until the agent's own model, or the first one this server offers, takes its place. */
const DEFAULT_MODEL = "free/groq/llama-3.3-70b";

/** One line per tool call, honest about calls that could not run. */
function ToolCallNote({ call }: { call: PlaygroundToolCall }) {
  const tone = call.status === "ok" ? "text-muted-foreground" : "text-yellow-600 dark:text-yellow-500";
  const label =
    call.status === "ok"
      ? "used"
      : call.status === "unavailable"
        ? "unavailable"
        : call.status === "unknown"
          ? "not an enabled tool"
          : "failed";
  return (
    <div className={`flex items-start gap-1.5 text-xs ${tone}`}>
      <Wrench className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="min-w-0 break-words">
        <span className="font-medium">{call.name}</span>: {label}
        {call.status !== "ok" && call.detail ? ` (${call.detail})` : ""}
      </span>
    </div>
  );
}

/**
 * A chat with one agent: streamed answers on the free models, whole answers
 * on the others, and a line for every tool the agent called. The playground
 * page and the agent page's Chat tab are both this component.
 */
export function AgentChat({ agentId, agentName, className, agent: givenAgent, badge, hideName = false }: AgentChatProps) {
  const [loadedAgent, setLoadedAgent] = useState<AgentDetail | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const agent = givenAgent ?? loadedAgent;

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL);
  // false until the model picker has settled on a model this server offers.
  const [modelReady, setModelReady] = useState(false);
  const [showSidebar, setShowSidebar] = useState(false);
  // Availability of the tools this agent has, from GET /api/skills.
  const [skills, setSkills] = useState<Skill[] | null>(null);

  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const hasMessages = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  // Leaving the page stops an answer that is still arriving.
  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    if (givenAgent) return;
    let cancelled = false;
    setLoadError(null);
    agentsApi
      .get(agentId)
      .then(({ agent }) => {
        if (!cancelled) setLoadedAgent(agent);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, givenAgent, loadAttempt]);

  // Start on the agent's own model when it has one.
  const configuredModel = agent?.modelConfig?.externalModel;
  useEffect(() => {
    if (configuredModel) setSelectedModel(configuredModel);
  }, [configuredModel]);

  useEffect(() => {
    skillsApi
      .list(agentId)
      .then(({ skills }) => setSkills(skills))
      // The sidebar degrades to plain tool names; chat itself is unaffected.
      .catch(() => setSkills(null));
  }, [agentId]);

  useEffect(() => {
    // Not on first paint: inside a tab that would pull the page down to the chat.
    if (messages.length === 0 && !hasMessages.current) return;
    hasMessages.current = true;
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isStreaming || !modelReady) return;

    const userMessage: Message = { role: "user", content: text };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsStreaming(true);

    const chatMessages = [...messages, userMessage].map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const abort = new AbortController();
    abortRef.current = abort;
    try {
      if (selectedModel.startsWith("free/")) {
        // Use streaming for free models
        const assistantMessage: Message = { role: "assistant", content: "" };
        setMessages((prev) => [...prev, assistantMessage]);

        let fullContent = "";
        for await (const chunk of streamPlaygroundChat(
          agentId,
          { messages: chatMessages, model: selectedModel },
          {
            onToolCalls: (toolCalls) =>
              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last?.role === "assistant") {
                  updated[updated.length - 1] = { ...last, toolCalls };
                }
                return updated;
              }),
            signal: abort.signal,
          }
        )) {
          fullContent += chunk;
          setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last?.role === "assistant") {
              updated[updated.length - 1] = { ...last, content: fullContent };
            }
            return updated;
          });
        }
      } else {
        // Non-streaming for paid models
        const result = await playgroundApi.agentChat(agentId, {
          messages: chatMessages,
          model: selectedModel,
        });
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: result.content,
            toolCalls: result.toolCalls,
          },
        ]);
        // Marketplace installs bill per request. Say so at the moment the
        // money moves rather than leaving it to the credit statement.
        if (result.billing) {
          toast.info(
            `Charged $${(result.billing.chargedCents / 100).toFixed(4)} to "${result.billing.listingTitle}". $${(
              result.billing.creatorCents / 100
            ).toFixed(4)} goes to the publisher.`
          );
        }
      }
    } catch (err) {
      // The page was left while the answer was arriving: nothing to say.
      if (abort.signal.aborted) return;
      toast.error(getErrorMessage(err, "Failed to get response"));
      // Remove the empty assistant message on error
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant" && !last.content) {
          return prev.slice(0, -1);
        }
        return prev;
      });
    } finally {
      if (abortRef.current === abort) abortRef.current = null;
      if (!abort.signal.aborted) {
        setIsStreaming(false);
        inputRef.current?.focus();
      }
    }
  }, [input, isStreaming, modelReady, messages, selectedModel, agentId]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (!agent) {
    if (loadError !== null) {
      return (
        <div className={cn("p-4", className)}>
          <ErrorState title="Couldn't load this chat" error={loadError} onRetry={() => setLoadAttempt((n) => n + 1)} />
        </div>
      );
    }
    return (
      <div className={cn("flex h-full flex-col gap-4 p-4", className)} aria-busy="true">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-64 w-full flex-1" />
        <Skeleton className="h-10 w-full" />
        <span className="sr-only">Loading chat</span>
      </div>
    );
  }

  const name = agentName ?? agent.name;
  const isFreeModel = selectedModel.startsWith("free/");
  const testBench = Boolean(badge);
  const tools = Array.isArray(agent.tools) ? (agent.tools as Array<{ name: string }>) : [];
  const inputId = `agent-chat-input-${agentId}`;

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      {/* Top bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-card px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <Bot className="h-5 w-5 shrink-0 text-primary-600" aria-hidden="true" />
          {!hideName && <span className="truncate font-medium">{name}</span>}
          {badge && <Badge variant="secondary">{badge}</Badge>}
        </div>

        <div className="flex min-w-0 flex-1 items-center justify-end gap-3 sm:flex-none">
          <div className="min-w-0 flex-1 sm:w-64 sm:flex-none">
            <ModelSelector
              agentId={agentId}
              value={selectedModel}
              onChange={setSelectedModel}
              onReady={() => setModelReady(true)}
              ariaLabel="Model"
            />
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setShowSidebar(!showSidebar)}
            aria-label={showSidebar ? "Hide agent settings" : "Show agent settings"}
            aria-expanded={showSidebar}
          >
            {showSidebar ? <ChevronRight className="h-4 w-4" /> : <Settings className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {/* Chat area */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Messages */}
          <div className="flex-1 space-y-4 overflow-y-auto p-4" aria-live="polite">
            {messages.length === 0 && (
              <div className="flex h-full items-center justify-center">
                <div className="text-center">
                  <Bot className="mx-auto h-12 w-12 text-muted-foreground/40" aria-hidden="true" />
                  <h3 className="mt-4 text-lg font-medium text-foreground">
                    {testBench ? "Test your agent" : `Chat with ${name}`}
                  </h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {testBench ? (
                      <>
                        Send a message to start chatting with <strong>{name}</strong>
                      </>
                    ) : (
                      "Send a message and it answers here."
                    )}
                  </p>
                  {testBench && isFreeModel && (
                    <Badge variant="success" className="mt-2">
                      Using a free model. No API key needed.
                    </Badge>
                  )}
                </div>
              </div>
            )}

            {messages.map((message, index) => (
              <div key={index} className={`flex gap-3 ${message.role === "user" ? "justify-end" : "justify-start"}`}>
                {message.role === "assistant" && (
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/15">
                    <Bot className="h-4 w-4 text-primary-600" aria-hidden="true" />
                  </div>
                )}
                <div
                  className={`min-w-0 max-w-[75%] rounded-lg px-4 py-2 ${
                    message.role === "user" ? "bg-primary-600 text-white" : "bg-muted text-foreground"
                  }`}
                >
                  {message.role === "assistant" ? (
                    message.content ? (
                      <ResultView text={message.content} />
                    ) : (
                      isStreaming &&
                      index === messages.length - 1 && (
                        <Loader2 className="h-4 w-4 animate-spin" aria-label="Waiting for the answer" />
                      )
                    )
                  ) : (
                    <div className="whitespace-pre-wrap break-words text-sm">{message.content}</div>
                  )}
                  {message.toolCalls && message.toolCalls.length > 0 && (
                    <div className="mt-2 space-y-1 border-t border-border/50 pt-2">
                      {message.toolCalls.map((call, i) => (
                        <ToolCallNote key={i} call={call} />
                      ))}
                    </div>
                  )}
                </div>
                {message.role === "user" && (
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted">
                    <User className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                  </div>
                )}
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>

          {/* Input area */}
          <div className="border-t bg-card p-4">
            <div className="flex gap-2">
              <label htmlFor={inputId} className="sr-only">
                Message {name}
              </label>
              <textarea
                id={inputId}
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={`Message ${name}...`}
                rows={1}
                disabled={isStreaming}
                className="min-w-0 flex-1 resize-none rounded-lg border border-input bg-background px-4 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
              />
              <Button onClick={handleSend} disabled={!input.trim() || isStreaming || !modelReady} aria-label="Send message">
                {isStreaming ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </Button>
            </div>
          </div>
        </div>

        {/* Sidebar: beside the chat on a wide screen, over it on a phone. */}
        {showSidebar && (
          <div className="absolute inset-y-0 right-0 z-10 w-80 max-w-full shrink-0 overflow-y-auto border-l bg-muted p-4 md:static">
            <h3 className="font-medium text-foreground">{testBench ? "Agent Config" : "This agent's settings"}</h3>

            <div className="mt-4 space-y-4">
              <div>
                <p className="text-xs font-medium uppercase text-muted-foreground">Model</p>
                <p className="break-words text-sm">{selectedModel}</p>
              </div>

              <div>
                <p className="text-xs font-medium uppercase text-muted-foreground">{testBench ? "Temperature" : "Creativity"}</p>
                <p className="text-sm">{agent.modelConfig?.temperature ?? 0.7}</p>
              </div>

              <div>
                <p className="text-xs font-medium uppercase text-muted-foreground">Max Tokens</p>
                <p className="text-sm">{agent.modelConfig?.maxTokens ?? 4096}</p>
              </div>

              {agent.systemPrompt && (
                <div>
                  <p className="text-xs font-medium uppercase text-muted-foreground">Instructions</p>
                  <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded border bg-card p-2 text-xs text-foreground">
                    {agent.systemPrompt}
                  </pre>
                </div>
              )}

              {tools.length > 0 && (
                <div>
                  <p className="text-xs font-medium uppercase text-muted-foreground">Tools ({tools.length})</p>
                  <div className="mt-1 space-y-1">
                    {tools.map((tool, i) => {
                      const skill = skills?.find((s) => s.key === tool.name);
                      return (
                        <div key={i} className="rounded border bg-card px-2 py-1.5 text-xs">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="font-medium">{skill?.name ?? tool.name}</span>
                            {skill ? (
                              <SkillStatusBadge skill={skill} />
                            ) : skills ? (
                              <Badge variant="secondary">Not supported</Badge>
                            ) : null}
                          </div>
                          {skill && <SkillUnavailableNote skill={skill} />}
                          {skills && !skill && (
                            <p className="mt-1 text-xs text-muted-foreground">
                              WheelsAI does not run a tool with this name, so the model is not offered it.
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
