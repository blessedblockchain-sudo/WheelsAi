"use client";

import Link from "next/link";
import { Copy, PlugZap } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EntrypointCard, UsageCard } from "./agent-runtime-cards";
import type { AgentTabProps } from "./types";

function copy(text: string) {
  navigator.clipboard.writeText(text);
  toast.success("Copied to clipboard");
}

export function CopyRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-sm font-medium text-foreground">{label}</p>
      <div className="mt-1 flex items-center gap-2">
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-lg bg-muted px-4 py-3 text-sm">
          {value}
        </code>
        <Button variant="outline" size="icon" onClick={() => copy(value)} aria-label={`Copy ${label}`}>
          <Copy className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

export function Snippet({ code }: { code: string }) {
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-lg bg-gray-900 p-4 text-sm text-gray-100">{code}</pre>
      <Button
        variant="outline"
        size="icon"
        className="absolute right-2 top-2"
        onClick={() => copy(code)}
        aria-label="Copy snippet"
      >
        <Copy className="h-4 w-4" />
      </Button>
    </div>
  );
}

/** The snippets, for the agent's real base URL and model id. */
function snippets(baseUrl: string, endpoint: string, model: string) {
  return {
    curl: `curl ${endpoint} \\
  -H "Authorization: Bearer $WHEELSAI_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`,
    node: `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${baseUrl}",
  apiKey: process.env.WHEELSAI_API_KEY,
});

const stream = await client.chat.completions.create({
  model: "${model}",
  messages: [{ role: "user", content: "Hello!" }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}`,
    python: `import os
from openai import OpenAI

client = OpenAI(base_url="${baseUrl}", api_key=os.environ["WHEELSAI_API_KEY"])

stream = client.chat.completions.create(
    model="${model}",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")`,
    tools: `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${baseUrl}",
  apiKey: process.env.WHEELSAI_API_KEY,
});

// Your functions run in YOUR code. The agent's own tools (and its knowledge
// base) keep running on the platform, in the same turn.
const tools = [{
  type: "function",
  function: {
    name: "get_order_status",
    description: "Look up an order by id",
    parameters: {
      type: "object",
      properties: { orderId: { type: "string" } },
      required: ["orderId"],
    },
  },
}];

const messages = [{ role: "user", content: "Where is order 1042?" }];
const first = await client.chat.completions.create({ model: "${model}", messages, tools });

const reply = first.choices[0].message;
if (reply.tool_calls) {
  messages.push(reply);
  for (const call of reply.tool_calls) {
    const args = JSON.parse(call.function.arguments);
    const result = await getOrderStatus(args.orderId); // your code
    messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
  }
  const final = await client.chat.completions.create({ model: "${model}", messages, tools });
  console.log(final.choices[0].message.content);
} else {
  console.log(reply.content);
}`,
  };
}

/**
 * The agent's OpenAI-compatible API: where it is, how to name it, and code
 * that calls it. The endpoint is served by the platform API whether or not a
 * GPU deployment is running.
 */
export function ApiTab({ agent, agentId, loadAgent }: AgentTabProps) {
  const { apiEndpoint, openaiBaseUrl, openaiModel } = agent;

  if (!apiEndpoint || !openaiBaseUrl) {
    return (
      <div className="space-y-6">
        <EmptyState
          icon={PlugZap}
          title="Endpoint address unavailable"
          description={`The full endpoint address cannot be shown right now. Your agent is still served at /v1/agents/${agent.slug}/chat/completions on the WheelsAI API.`}
        />
        <EntrypointCard agent={agent} agentId={agentId} loadAgent={loadAgent} />
        <UsageCard agentId={agentId} />
      </div>
    );
  }

  const code = snippets(openaiBaseUrl, apiEndpoint, openaiModel);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">OpenAI-compatible API</CardTitle>
          <CardDescription>
            Always on: this agent answers on the platform API
            {agent.entrypoint === "graph"
              ? " by running its graph."
              : " with its prompt, model, tools and knowledge base."}{" "}
            Point any OpenAI client at the base URL below. A chat completion counts as one API call on your plan.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <CopyRow label="Endpoint" value={apiEndpoint} />
          <CopyRow label="OpenAI base URL" value={openaiBaseUrl} />
          <CopyRow label="Model id" value={openaiModel} />
          <p className="text-sm text-muted-foreground">
            Authenticate with an API key as <code>Authorization: Bearer …</code>.{" "}
            <Link href="/dashboard/keys" className="text-primary-600 hover:underline">
              Create or manage API keys
            </Link>
            . The model id also selects this agent on the unified base URL (the same address ending in{" "}
            <code>/v1</code>), next to your other agents and model deployments.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Call it</CardTitle>
          <CardDescription>
            Streaming, function calling and tool use work as they do against OpenAI.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="curl">
            <TabsList aria-label="Code samples">
              <TabsTrigger value="curl">curl</TabsTrigger>
              <TabsTrigger value="node">Node (streaming)</TabsTrigger>
              <TabsTrigger value="python">Python (streaming)</TabsTrigger>
              <TabsTrigger value="tools">Function calling</TabsTrigger>
            </TabsList>
            <TabsContent value="curl" className="mt-4">
              <Snippet code={code.curl} />
            </TabsContent>
            <TabsContent value="node" className="mt-4">
              <Snippet code={code.node} />
            </TabsContent>
            <TabsContent value="python" className="mt-4">
              <Snippet code={code.python} />
            </TabsContent>
            <TabsContent value="tools" className="mt-4">
              <Snippet code={code.tools} />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      <EntrypointCard agent={agent} agentId={agentId} loadAgent={loadAgent} />
      <UsageCard agentId={agentId} />
    </div>
  );
}
