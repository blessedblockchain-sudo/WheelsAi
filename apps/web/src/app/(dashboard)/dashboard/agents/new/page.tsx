"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Bot,
  Code,
  Settings,
  Wrench,
  ArrowLeft,
  ArrowRight,
  Check,
  Plus,
  Trash2,
  ExternalLink,
} from "lucide-react";
import { toast } from "sonner";

import { Header } from "@/components/dashboard/header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { agentsApi, type CreateAgentInput } from "@/lib/api";
import { cn } from "@/lib/utils";

type Step = "framework" | "config" | "tools" | "code" | "review";

const steps: { id: Step; label: string; icon: React.ElementType }[] = [
  { id: "framework", label: "Framework", icon: Bot },
  { id: "config", label: "Configuration", icon: Settings },
  { id: "tools", label: "Tools", icon: Wrench },
  { id: "code", label: "Code", icon: Code },
  { id: "review", label: "Review", icon: Check },
];

const frameworkColors: Record<string, { bg: string; text: string }> = {
  purple: { bg: "bg-purple-100", text: "text-purple-600" },
  green: { bg: "bg-green-100", text: "text-green-600" },
  blue: { bg: "bg-blue-100", text: "text-blue-600" },
  gray: { bg: "bg-gray-100", text: "text-gray-600" },
};

const frameworks = [
  {
    id: "mastra",
    name: "Mastra",
    description: "Modern TypeScript framework for building AI agents",
    features: ["Type-safe", "Built-in tools", "Easy deployment"],
    color: "purple",
  },
  {
    id: "langchain",
    name: "LangChain",
    description: "Popular framework with extensive tool ecosystem",
    features: ["Large ecosystem", "RAG support", "Memory management"],
    color: "green",
  },
  {
    id: "autogen",
    name: "AutoGen",
    description: "Multi-agent conversation framework by Microsoft",
    features: ["Multi-agent", "Code execution", "Human-in-loop"],
    color: "blue",
  },
  {
    id: "custom",
    name: "Custom",
    description: "Bring your own agent implementation",
    features: ["Full control", "Any language", "Docker-based"],
    color: "gray",
  },
];

const builtInTools = [
  { name: "web_search", label: "Web Search", description: "Search the web for information" },
  { name: "calculator", label: "Calculator", description: "Perform mathematical calculations" },
  { name: "code_interpreter", label: "Code Interpreter", description: "Execute Python code" },
  { name: "http_request", label: "HTTP Request", description: "Make API calls" },
  { name: "file_read", label: "File Read", description: "Read file contents" },
  { name: "file_write", label: "File Write", description: "Write to files" },
];

export default function NewAgentPage() {
  return (
    <Suspense fallback={<div className="flex h-96 items-center justify-center"><div className="h-8 w-8 animate-spin rounded-full border-4 border-primary-500 border-t-transparent" /></div>}>
      <NewAgentContent />
    </Suspense>
  );
}

function NewAgentContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const template = searchParams.get("template");

  const [currentStep, setCurrentStep] = useState<Step>("framework");
  const [isCreating, setIsCreating] = useState(false);

  // Form state
  const [formData, setFormData] = useState<Partial<CreateAgentInput>>({
    name: "",
    description: "",
    framework: "mastra",
    systemPrompt: "",
    tools: [],
    modelConfig: {
      externalModel: "free/groq/llama-3.3-70b",
      temperature: 0.7,
      maxTokens: 4096,
    },
    sourceType: "inline",
    sourceCode: "",
    env: {},
    tags: [],
    isPublic: false,
  });

  const [selectedTools, setSelectedTools] = useState<string[]>([]);
  const [customEnv, setCustomEnv] = useState<{ key: string; value: string }[]>([]);

  const currentStepIndex = steps.findIndex((s) => s.id === currentStep);

  function nextStep() {
    const nextIndex = currentStepIndex + 1;
    const nextStepConfig = steps[nextIndex];
    if (nextStepConfig) {
      setCurrentStep(nextStepConfig.id);
    }
  }

  function prevStep() {
    const prevIndex = currentStepIndex - 1;
    const prevStepConfig = steps[prevIndex];
    if (prevStepConfig) {
      setCurrentStep(prevStepConfig.id);
    }
  }

  async function handleCreate() {
    if (!formData.name) {
      toast.error("Please enter an agent name");
      return;
    }

    setIsCreating(true);
    try {
      // Build tools array from selected tools
      const tools = selectedTools.map((name) => ({
        name,
        type: "function" as const,
        description: builtInTools.find((t) => t.name === name)?.description || "",
      }));

      // Build env from customEnv
      const env: Record<string, string> = {};
      customEnv.forEach(({ key, value }) => {
        if (key) env[key] = value;
      });

      const { agent } = await agentsApi.create({
        ...formData,
        tools,
        env,
      } as CreateAgentInput);

      toast.success("Agent created successfully");
      router.push(`/dashboard/agents/${agent.id}`);
    } catch (error) {
      toast.error("Failed to create agent");
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <div className="flex flex-col">
      <Header
        title="Create Agent"
        description="Build a new AI agent"
      />

      <div className="p-8">
        {/* Progress steps */}
        <div className="mb-8">
          <div className="flex items-center justify-between">
            {steps.map((step, index) => (
              <div key={step.id} className="flex items-center">
                <button
                  onClick={() => setCurrentStep(step.id)}
                  className={cn(
                    "flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors",
                    currentStep === step.id
                      ? "bg-primary-100 text-primary-700"
                      : index < currentStepIndex
                      ? "text-primary-600"
                      : "text-gray-400"
                  )}
                >
                  <step.icon className="h-4 w-4" />
                  <span className="hidden md:inline">{step.label}</span>
                </button>
                {index < steps.length - 1 && (
                  <div
                    className={cn(
                      "mx-2 h-0.5 w-8 md:w-16",
                      index < currentStepIndex ? "bg-primary-500" : "bg-gray-200"
                    )}
                  />
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Step content */}
        <Card className="mb-6">
          <CardContent className="py-6">
            {/* Framework selection */}
            {currentStep === "framework" && (
              <div>
                <h3 className="text-lg font-medium">Choose a Framework</h3>
                <p className="mt-1 text-sm text-gray-500">
                  Select the agent framework that best fits your needs
                </p>

                <div className="mt-6 grid gap-4 md:grid-cols-2">
                  {frameworks.map((fw) => (
                    <button
                      key={fw.id}
                      onClick={() => setFormData({ ...formData, framework: fw.id as any })}
                      className={cn(
                        "rounded-lg border-2 p-4 text-left transition-all",
                        formData.framework === fw.id
                          ? "border-primary-500 bg-primary-50"
                          : "border-gray-200 hover:border-gray-300"
                      )}
                    >
                      <div className="flex items-center gap-3">
                        <div className={cn("flex h-10 w-10 items-center justify-center rounded-lg", frameworkColors[fw.color]?.bg)}>
                          <Bot className={cn("h-5 w-5", frameworkColors[fw.color]?.text)} />
                        </div>
                        <div>
                          <p className="font-medium">{fw.name}</p>
                          <p className="text-sm text-gray-500">{fw.description}</p>
                        </div>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {fw.features.map((feature) => (
                          <Badge key={feature} variant="secondary" className="text-xs">
                            {feature}
                          </Badge>
                        ))}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Configuration */}
            {currentStep === "config" && (
              <div className="space-y-6">
                <h3 className="text-lg font-medium">Agent Configuration</h3>

                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    Agent Name *
                  </label>
                  <Input
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    placeholder="My AI Assistant"
                    className="mt-1"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    Description
                  </label>
                  <Input
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                    placeholder="A helpful assistant that..."
                    className="mt-1"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    System Prompt
                  </label>
                  <textarea
                    value={formData.systemPrompt}
                    onChange={(e) => setFormData({ ...formData, systemPrompt: e.target.value })}
                    placeholder="You are a helpful AI assistant..."
                    rows={4}
                    className="mt-1 w-full rounded-lg border border-gray-300 px-4 py-2 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
                  />
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      Model
                    </label>
                    <Select
                      value={formData.modelConfig?.externalModel}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          modelConfig: { ...formData.modelConfig!, externalModel: e.target.value },
                        })
                      }
                      className="mt-1"
                    >
                      <optgroup label="Free Models (No API Key)">
                        <option value="free/groq/llama-3.3-70b">Llama 3.3 70B - Groq (Free)</option>
                        <option value="free/groq/llama-3.1-8b">Llama 3.1 8B Instant - Groq (Free)</option>
                        <option value="free/groq/qwen3-32b">Qwen3 32B - Groq (Free)</option>
                        <option value="free/gemini/gemini-2.5-flash">Gemini 2.5 Flash - Google (Free)</option>
                        <option value="free/together/llama-3.1-8b">Llama 3.1 8B - Together (Free)</option>
                      </optgroup>
                      <optgroup label="OpenAI (API Key Required)">
                        <option value="openai/gpt-4">GPT-4</option>
                        <option value="openai/gpt-4-turbo">GPT-4 Turbo</option>
                        <option value="openai/gpt-3.5-turbo">GPT-3.5 Turbo</option>
                      </optgroup>
                      <optgroup label="Anthropic (API Key Required)">
                        <option value="anthropic/claude-3-opus">Claude 3 Opus</option>
                        <option value="anthropic/claude-3-sonnet">Claude 3 Sonnet</option>
                      </optgroup>
                      <optgroup label="WheelsAI (Your Deployments)">
                        <option value="wheelsai/llama-3.1-8b">Llama 3.1 8B</option>
                        <option value="wheelsai/llama-3.1-70b">Llama 3.1 70B</option>
                      </optgroup>
                    </Select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      Temperature: {formData.modelConfig?.temperature}
                    </label>
                    <input
                      type="range"
                      min="0"
                      max="2"
                      step="0.1"
                      value={formData.modelConfig?.temperature}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          modelConfig: { ...formData.modelConfig!, temperature: parseFloat(e.target.value) },
                        })
                      }
                      className="mt-3 w-full"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    Tags (comma separated)
                  </label>
                  <Input
                    value={formData.tags?.join(", ")}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        tags: e.target.value.split(",").map((t) => t.trim()).filter(Boolean),
                      })
                    }
                    placeholder="customer-support, chatbot, internal"
                    className="mt-1"
                  />
                </div>
              </div>
            )}

            {/* Tools */}
            {currentStep === "tools" && (
              <div>
                <h3 className="text-lg font-medium">Configure Tools</h3>
                <p className="mt-1 text-sm text-gray-500">
                  Select the tools your agent can use
                </p>

                <div className="mt-6 grid gap-4 md:grid-cols-2">
                  {builtInTools.map((tool) => (
                    <label
                      key={tool.name}
                      className={cn(
                        "flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors",
                        selectedTools.includes(tool.name)
                          ? "border-primary-500 bg-primary-50"
                          : "border-gray-200 hover:border-gray-300"
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={selectedTools.includes(tool.name)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedTools([...selectedTools, tool.name]);
                          } else {
                            setSelectedTools(selectedTools.filter((t) => t !== tool.name));
                          }
                        }}
                        className="mt-1"
                      />
                      <div>
                        <p className="font-medium">{tool.label}</p>
                        <p className="text-sm text-gray-500">{tool.description}</p>
                      </div>
                    </label>
                  ))}
                </div>

                <div className="mt-6">
                  <h4 className="font-medium">Environment Variables</h4>
                  <p className="text-sm text-gray-500">
                    Add API keys and configuration for your tools
                  </p>

                  <div className="mt-4 space-y-3">
                    {customEnv.map((env, index) => (
                      <div key={index} className="flex gap-2">
                        <Input
                          value={env.key}
                          onChange={(e) => {
                            const newEnv = [...customEnv];
                            const target = newEnv[index];
                            if (!target) return;
                            target.key = e.target.value;
                            setCustomEnv(newEnv);
                          }}
                          placeholder="KEY"
                          className="w-1/3"
                        />
                        <Input
                          value={env.value}
                          onChange={(e) => {
                            const newEnv = [...customEnv];
                            const target = newEnv[index];
                            if (!target) return;
                            target.value = e.target.value;
                            setCustomEnv(newEnv);
                          }}
                          placeholder="value"
                          type="password"
                          className="flex-1"
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setCustomEnv(customEnv.filter((_, i) => i !== index))}
                        >
                          <Trash2 className="h-4 w-4 text-red-500" />
                        </Button>
                      </div>
                    ))}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setCustomEnv([...customEnv, { key: "", value: "" }])}
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      Add Variable
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {/* Code */}
            {currentStep === "code" && (
              <div>
                <h3 className="text-lg font-medium">Agent Code</h3>
                <p className="mt-1 text-sm text-gray-500">
                  Provide your agent implementation
                </p>

                <div className="mt-6">
                  <div className="flex gap-4">
                    {(["inline", "github", "ipfs"] as const).map((type) => (
                      <label
                        key={type}
                        className={cn(
                          "flex cursor-pointer items-center gap-2 rounded-lg border px-4 py-2",
                          formData.sourceType === type
                            ? "border-primary-500 bg-primary-50"
                            : "border-gray-200"
                        )}
                      >
                        <input
                          type="radio"
                          checked={formData.sourceType === type}
                          onChange={() => setFormData({ ...formData, sourceType: type })}
                        />
                        <span className="capitalize">{type}</span>
                      </label>
                    ))}
                  </div>

                  {formData.sourceType === "inline" && (
                    <div className="mt-4">
                      <label className="block text-sm font-medium text-gray-700">
                        Agent Code ({formData.framework === "custom" ? "Dockerfile or script" : `${formData.framework} config`})
                      </label>
                      <textarea
                        value={formData.sourceCode}
                        onChange={(e) => setFormData({ ...formData, sourceCode: e.target.value })}
                        placeholder={getCodePlaceholder(formData.framework as string)}
                        rows={15}
                        className="mt-1 w-full rounded-lg border border-gray-300 bg-gray-50 px-4 py-2 font-mono text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
                      />
                    </div>
                  )}

                  {formData.sourceType === "github" && (
                    <div className="mt-4">
                      <label className="block text-sm font-medium text-gray-700">
                        GitHub Repository URL
                      </label>
                      <Input
                        value={formData.sourceUrl}
                        onChange={(e) => setFormData({ ...formData, sourceUrl: e.target.value })}
                        placeholder="https://github.com/username/repo"
                        className="mt-1"
                      />
                      <p className="mt-1 text-sm text-gray-500">
                        Repository must contain a valid agent configuration
                      </p>
                    </div>
                  )}

                  {formData.sourceType === "ipfs" && (
                    <div className="mt-4">
                      <label className="block text-sm font-medium text-gray-700">
                        IPFS Hash
                      </label>
                      <Input
                        value={formData.sourceUrl}
                        onChange={(e) => setFormData({ ...formData, sourceUrl: e.target.value })}
                        placeholder="ipfs://Qm..."
                        className="mt-1"
                      />
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Review */}
            {currentStep === "review" && (
              <div>
                <h3 className="text-lg font-medium">Review Agent</h3>
                <p className="mt-1 text-sm text-gray-500">
                  Review your agent configuration before creating
                </p>

                <div className="mt-6 space-y-4">
                  <div className="rounded-lg border p-4">
                    <h4 className="font-medium">Basic Info</h4>
                    <dl className="mt-2 grid gap-2 text-sm">
                      <div className="flex justify-between">
                        <dt className="text-gray-500">Name</dt>
                        <dd>{formData.name || "—"}</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-gray-500">Framework</dt>
                        <dd className="capitalize">{formData.framework}</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-gray-500">Model</dt>
                        <dd>{formData.modelConfig?.externalModel}</dd>
                      </div>
                    </dl>
                  </div>

                  <div className="rounded-lg border p-4">
                    <h4 className="font-medium">Tools ({selectedTools.length})</h4>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {selectedTools.length > 0 ? (
                        selectedTools.map((tool) => (
                          <Badge key={tool} variant="secondary">
                            {tool}
                          </Badge>
                        ))
                      ) : (
                        <span className="text-sm text-gray-500">No tools selected</span>
                      )}
                    </div>
                  </div>

                  <div className="rounded-lg border p-4">
                    <h4 className="font-medium">Source</h4>
                    <p className="mt-1 text-sm text-gray-500">
                      Type: {formData.sourceType}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Navigation */}
        <div className="flex justify-between">
          <Button
            variant="outline"
            onClick={prevStep}
            disabled={currentStepIndex === 0}
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back
          </Button>

          {currentStep === "review" ? (
            <Button onClick={handleCreate} isLoading={isCreating}>
              <Check className="mr-2 h-4 w-4" />
              Create Agent
            </Button>
          ) : (
            <Button onClick={nextStep}>
              Next
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function getCodePlaceholder(framework: string): string {
  switch (framework) {
    case "mastra":
      return `import { Agent } from '@mastra/core';

export const agent = new Agent({
  name: 'My Agent',
  instructions: 'You are a helpful assistant.',
  model: {
    provider: 'groq',
    name: 'llama-3.3-70b-versatile',
  },
  tools: [],
});`;
    case "langchain":
      return `from langchain.agents import create_react_agent
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(model="gpt-4")

agent = create_react_agent(
    llm=llm,
    tools=[],
    prompt="You are a helpful assistant."
)`;
    case "autogen":
      return `from autogen import AssistantAgent

agent = AssistantAgent(
    name="assistant",
    system_message="You are a helpful AI assistant.",
    llm_config={"model": "gpt-4"}
)`;
    default:
      return `# Your custom agent implementation
# Can be a Dockerfile or any script`;
  }
}
