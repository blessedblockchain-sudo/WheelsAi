"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { Send, Bot, User, Loader2, ChevronLeft, ChevronRight, Settings } from "lucide-react";
import { toast } from "sonner";

import { Header } from "@/components/dashboard/header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ModelSelector } from "@/components/dashboard/model-selector";
import {
  agentsApi,
  playgroundApi,
  streamPlaygroundChat,
  type AgentDetail,
  type PlaygroundChatResponse,
} from "@/lib/api";

interface Message {
  role: "user" | "assistant";
  content: string;
}

export default function PlaygroundPage() {
  const params = useParams();
  const agentId = params.id as string;

  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [isLoadingAgent, setIsLoadingAgent] = useState(true);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [selectedModel, setSelectedModel] = useState("free/groq/llama-3.3-70b");
  const [showSidebar, setShowSidebar] = useState(false);
  const [requestCount, setRequestCount] = useState(0);

  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    agentsApi
      .get(agentId)
      .then(({ agent }) => {
        setAgent(agent);
        // Default to agent's configured model if it's a free model
        const configured = (agent.modelConfig as any)?.externalModel;
        if (configured) setSelectedModel(configured);
      })
      .catch(() => toast.error("Failed to load agent"))
      .finally(() => setIsLoadingAgent(false));
  }, [agentId]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isStreaming) return;

    const userMessage: Message = { role: "user", content: text };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsStreaming(true);

    const chatMessages = [...messages, userMessage].map((m) => ({
      role: m.role,
      content: m.content,
    }));

    try {
      if (selectedModel.startsWith("free/")) {
        // Use streaming for free models
        const assistantMessage: Message = { role: "assistant", content: "" };
        setMessages((prev) => [...prev, assistantMessage]);

        let fullContent = "";
        for await (const chunk of streamPlaygroundChat(agentId, {
          messages: chatMessages,
          model: selectedModel,
        })) {
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
        const result = await playgroundApi.chat(agentId, {
          messages: chatMessages,
          model: selectedModel,
        });
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: result.content },
        ]);
      }
      setRequestCount((c) => c + 1);
    } catch (err: any) {
      const errorMessage =
        err?.data?.message || err?.message || "Failed to get response";
      toast.error(errorMessage);
      // Remove the empty assistant message on error
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant" && !last.content) {
          return prev.slice(0, -1);
        }
        return prev;
      });
    } finally {
      setIsStreaming(false);
      inputRef.current?.focus();
    }
  }, [input, isStreaming, messages, selectedModel, agentId]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (isLoadingAgent) {
    return (
      <div className="flex flex-col">
        <Header title="Loading..." />
        <div className="p-8">
          <div className="h-96 animate-pulse rounded-lg bg-gray-200" />
        </div>
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="flex flex-col">
        <Header title="Agent Not Found" />
        <div className="p-8 text-center text-gray-500">Agent not found</div>
      </div>
    );
  }

  const isFreeModel = selectedModel.startsWith("free/");

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col">
      {/* Top bar */}
      <div className="flex items-center justify-between border-b bg-white px-4 py-3">
        <div className="flex items-center gap-3">
          <Bot className="h-5 w-5 text-primary-600" />
          <span className="font-medium">{agent.name}</span>
          <Badge variant="secondary">Playground</Badge>
        </div>

        <div className="flex items-center gap-3">
          <div className="w-64">
            <ModelSelector
              agentId={agentId}
              value={selectedModel}
              onChange={setSelectedModel}
            />
          </div>
          {isFreeModel && (
            <span className="text-xs text-gray-500">
              {requestCount}/200 requests today
            </span>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setShowSidebar(!showSidebar)}
          >
            {showSidebar ? (
              <ChevronRight className="h-4 w-4" />
            ) : (
              <Settings className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Chat area */}
        <div className="flex flex-1 flex-col">
          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {messages.length === 0 && (
              <div className="flex h-full items-center justify-center">
                <div className="text-center">
                  <Bot className="mx-auto h-12 w-12 text-gray-300" />
                  <h3 className="mt-4 text-lg font-medium text-gray-700">
                    Test your agent
                  </h3>
                  <p className="mt-1 text-sm text-gray-500">
                    Send a message to start chatting with{" "}
                    <strong>{agent.name}</strong>
                  </p>
                  {isFreeModel && (
                    <Badge variant="success" className="mt-2">
                      Using free model - no API key needed
                    </Badge>
                  )}
                </div>
              </div>
            )}

            {messages.map((message, index) => (
              <div
                key={index}
                className={`flex gap-3 ${
                  message.role === "user" ? "justify-end" : "justify-start"
                }`}
              >
                {message.role === "assistant" && (
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary-100">
                    <Bot className="h-4 w-4 text-primary-600" />
                  </div>
                )}
                <div
                  className={`max-w-[75%] rounded-lg px-4 py-2 ${
                    message.role === "user"
                      ? "bg-primary-600 text-white"
                      : "bg-gray-100 text-gray-900"
                  }`}
                >
                  <div className="whitespace-pre-wrap text-sm">
                    {message.content}
                    {isStreaming &&
                      index === messages.length - 1 &&
                      message.role === "assistant" &&
                      !message.content && (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      )}
                  </div>
                </div>
                {message.role === "user" && (
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-200">
                    <User className="h-4 w-4 text-gray-600" />
                  </div>
                )}
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>

          {/* Input area */}
          <div className="border-t bg-white p-4">
            <div className="flex gap-2">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={`Message ${agent.name}...`}
                rows={1}
                disabled={isStreaming}
                className="flex-1 resize-none rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500 disabled:opacity-50"
              />
              <Button
                onClick={handleSend}
                disabled={!input.trim() || isStreaming}
              >
                {isStreaming ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>
        </div>

        {/* Sidebar */}
        {showSidebar && (
          <div className="w-80 shrink-0 overflow-y-auto border-l bg-gray-50 p-4">
            <h3 className="font-medium text-gray-900">Agent Config</h3>

            <div className="mt-4 space-y-4">
              <div>
                <p className="text-xs font-medium uppercase text-gray-500">
                  Model
                </p>
                <p className="text-sm">{selectedModel}</p>
              </div>

              <div>
                <p className="text-xs font-medium uppercase text-gray-500">
                  Temperature
                </p>
                <p className="text-sm">
                  {(agent.modelConfig as any)?.temperature ?? 0.7}
                </p>
              </div>

              <div>
                <p className="text-xs font-medium uppercase text-gray-500">
                  Max Tokens
                </p>
                <p className="text-sm">
                  {(agent.modelConfig as any)?.maxTokens ?? 4096}
                </p>
              </div>

              {agent.systemPrompt && (
                <div>
                  <p className="text-xs font-medium uppercase text-gray-500">
                    System Prompt
                  </p>
                  <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded bg-white p-2 text-xs text-gray-700 border">
                    {agent.systemPrompt}
                  </pre>
                </div>
              )}

              {(agent.tools as any[])?.length > 0 && (
                <div>
                  <p className="text-xs font-medium uppercase text-gray-500">
                    Tools ({(agent.tools as any[]).length})
                  </p>
                  <div className="mt-1 space-y-1">
                    {(agent.tools as any[]).map((tool: any, i: number) => (
                      <div
                        key={i}
                        className="rounded bg-white px-2 py-1 text-xs border"
                      >
                        {tool.name}
                      </div>
                    ))}
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
