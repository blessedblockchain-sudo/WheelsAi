"use client";

import { useEffect, useState, useRef } from "react";
import Link from "next/link";
import {
  Send,
  Settings,
  Trash2,
  Copy,
  User,
  Bot,
  Loader2,
  ChevronDown,
} from "lucide-react";
import { toast } from "sonner";

import { Header } from "@/components/dashboard/header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { deploymentsApi, playgroundApi, type Deployment } from "@/lib/api";
import { cn } from "@/lib/utils";

interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
  tokens?: number;
  latency?: number;
}

export default function PlaygroundPage() {
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [selectedDeployment, setSelectedDeployment] = useState<string>("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingDeployments, setIsLoadingDeployments] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Generation settings
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(1024);
  const [systemPrompt, setSystemPrompt] = useState("");

  useEffect(() => {
    async function loadDeployments() {
      try {
        const { deployments } = await deploymentsApi.list();
        const runningDeployments = deployments.filter((d) => d.status === "running");
        setDeployments(runningDeployments);
        const firstDeployment = runningDeployments[0];
        if (firstDeployment) {
          setSelectedDeployment(firstDeployment.id);
        }
      } catch (error) {
        toast.error("Failed to load deployments");
      } finally {
        setIsLoadingDeployments(false);
      }
    }
    loadDeployments();
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSend() {
    if (!input.trim() || !selectedDeployment || isLoading) return;

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: input.trim(),
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsLoading(true);

    const startTime = Date.now();

    try {
      // Build messages array for API
      const apiMessages = [
        ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
        ...messages.map((m) => ({ role: m.role, content: m.content })),
        { role: "user" as const, content: userMessage.content },
      ];

      const response = await playgroundApi.chat(selectedDeployment, {
        messages: apiMessages,
        temperature,
        max_tokens: maxTokens,
      });

      const latency = Date.now() - startTime;

      const assistantMessage: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: response.choices[0]?.message?.content ?? "",
        timestamp: new Date(),
        tokens: response.usage?.total_tokens,
        latency,
      };

      setMessages((prev) => [...prev, assistantMessage]);
    } catch (error) {
      toast.error("Failed to generate response");
      // Remove the user message on error
      setMessages((prev) => prev.filter((m) => m.id !== userMessage.id));
    } finally {
      setIsLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function clearConversation() {
    setMessages([]);
  }

  function copyMessage(content: string) {
    navigator.clipboard.writeText(content);
    toast.success("Copied to clipboard");
  }

  const selectedDeploymentData = deployments.find((d) => d.id === selectedDeployment);

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col">
      <Header
        title="Playground"
        description="Test your deployed models with an interactive chat interface"
      />

      <div className="flex flex-1 overflow-hidden">
        {/* Main chat area */}
        <div className="flex flex-1 flex-col">
          {/* Deployment selector */}
          <div className="border-b bg-white px-6 py-4">
            <div className="flex items-center gap-4">
              <div className="flex-1">
                <label className="block text-sm font-medium text-gray-700">
                  Deployment
                </label>
                {isLoadingDeployments ? (
                  <Skeleton className="mt-1 h-10 w-full" />
                ) : deployments.length === 0 ? (
                  <p className="mt-1 text-sm text-gray-500">
                    No running deployments.{" "}
                    <Link href="/dashboard/deployments/new" className="text-primary-600 hover:underline">
                      Deploy a model
                    </Link>{" "}
                    to get started.
                  </p>
                ) : (
                  <Select
                    value={selectedDeployment}
                    onChange={(e) => setSelectedDeployment(e.target.value)}
                    className="mt-1"
                  >
                    {deployments.map((deployment) => (
                      <option key={deployment.id} value={deployment.id}>
                        {deployment.name} ({deployment.model})
                      </option>
                    ))}
                  </Select>
                )}
              </div>

              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowSettings(!showSettings)}
              >
                <Settings className="mr-2 h-4 w-4" />
                Settings
                <ChevronDown
                  className={cn(
                    "ml-2 h-4 w-4 transition-transform",
                    showSettings && "rotate-180"
                  )}
                />
              </Button>

              <Button
                variant="ghost"
                size="sm"
                onClick={clearConversation}
                disabled={messages.length === 0}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Clear
              </Button>
            </div>

            {/* Settings panel */}
            {showSettings && (
              <div className="mt-4 grid gap-4 border-t pt-4 md:grid-cols-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    Temperature: {temperature}
                  </label>
                  <input
                    type="range"
                    min="0"
                    max="2"
                    step="0.1"
                    value={temperature}
                    onChange={(e) => setTemperature(parseFloat(e.target.value))}
                    className="mt-1 w-full"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    Max Tokens
                  </label>
                  <Select
                    value={maxTokens.toString()}
                    onChange={(e) => setMaxTokens(parseInt(e.target.value))}
                    className="mt-1"
                  >
                    {[256, 512, 1024, 2048, 4096].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </Select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    System Prompt
                  </label>
                  <Input
                    value={systemPrompt}
                    onChange={(e) => setSystemPrompt(e.target.value)}
                    placeholder="You are a helpful assistant..."
                    className="mt-1"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto bg-gray-50 p-6">
            {messages.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center text-center">
                <Bot className="h-16 w-16 text-gray-300" />
                <h3 className="mt-4 text-lg font-medium text-gray-900">
                  Start a conversation
                </h3>
                <p className="mt-2 max-w-md text-gray-500">
                  {selectedDeploymentData
                    ? `Send a message to ${selectedDeploymentData.name} to get started`
                    : "Select a deployment and send a message to begin"}
                </p>
              </div>
            ) : (
              <div className="mx-auto max-w-3xl space-y-6">
                {messages.map((message) => (
                  <div
                    key={message.id}
                    className={cn(
                      "flex gap-4",
                      message.role === "user" && "flex-row-reverse"
                    )}
                  >
                    <div
                      className={cn(
                        "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
                        message.role === "user"
                          ? "bg-primary-100"
                          : "bg-gray-200"
                      )}
                    >
                      {message.role === "user" ? (
                        <User className="h-4 w-4 text-primary-600" />
                      ) : (
                        <Bot className="h-4 w-4 text-gray-600" />
                      )}
                    </div>

                    <div
                      className={cn(
                        "group relative max-w-[80%] rounded-lg px-4 py-3",
                        message.role === "user"
                          ? "bg-primary-600 text-white"
                          : "bg-white shadow-sm"
                      )}
                    >
                      <p className="whitespace-pre-wrap">{message.content}</p>

                      {message.role === "assistant" && (
                        <div className="mt-2 flex items-center gap-3 border-t pt-2 text-xs text-gray-400">
                          {message.latency && <span>{message.latency}ms</span>}
                          {message.tokens && <span>{message.tokens} tokens</span>}
                          <button
                            onClick={() => copyMessage(message.content)}
                            className="opacity-0 transition-opacity group-hover:opacity-100"
                          >
                            <Copy className="h-3 w-3" />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}

                {isLoading && (
                  <div className="flex gap-4">
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-200">
                      <Bot className="h-4 w-4 text-gray-600" />
                    </div>
                    <div className="rounded-lg bg-white px-4 py-3 shadow-sm">
                      <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
                    </div>
                  </div>
                )}

                <div ref={messagesEndRef} />
              </div>
            )}
          </div>

          {/* Input area */}
          <div className="border-t bg-white p-4">
            <div className="mx-auto flex max-w-3xl gap-4">
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={
                  selectedDeployment
                    ? "Type your message..."
                    : "Select a deployment to start chatting"
                }
                disabled={!selectedDeployment || isLoading}
                className="flex-1"
              />
              <Button
                onClick={handleSend}
                disabled={!input.trim() || !selectedDeployment || isLoading}
              >
                <Send className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>

        {/* Code example sidebar */}
        {selectedDeploymentData && (
          <div className="hidden w-80 border-l bg-gray-900 p-4 lg:block">
            <h3 className="text-sm font-medium text-gray-400">API Example</h3>
            <pre className="mt-3 overflow-x-auto text-xs text-gray-300">
{`curl ${selectedDeploymentData.endpoint}/chat/completions \\
  -H "Authorization: Bearer $API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
  "messages": [
    {"role": "user", "content": "Hello!"}
  ],
  "temperature": ${temperature},
  "max_tokens": ${maxTokens}
}'`}
            </pre>

            <h3 className="mt-6 text-sm font-medium text-gray-400">Python</h3>
            <pre className="mt-3 overflow-x-auto text-xs text-gray-300">
{`from openai import OpenAI

client = OpenAI(
    base_url="${selectedDeploymentData.endpoint}",
    api_key="YOUR_API_KEY"
)

response = client.chat.completions.create(
    model="${selectedDeploymentData.model}",
    messages=[
        {"role": "user", "content": "Hello!"}
    ],
    temperature=${temperature},
    max_tokens=${maxTokens}
)`}
            </pre>

            <h3 className="mt-6 text-sm font-medium text-gray-400">JavaScript</h3>
            <pre className="mt-3 overflow-x-auto text-xs text-gray-300">
{`import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: '${selectedDeploymentData.endpoint}',
  apiKey: 'YOUR_API_KEY'
});

const response = await client.chat.completions.create({
  model: '${selectedDeploymentData.model}',
  messages: [
    { role: 'user', content: 'Hello!' }
  ],
  temperature: ${temperature},
  max_tokens: ${maxTokens}
});`}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
