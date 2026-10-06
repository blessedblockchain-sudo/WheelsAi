"use client";

import { useState, useEffect, useCallback, Suspense } from "react";
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
  Github,
  LayoutTemplate,
} from "lucide-react";
import { toast } from "sonner";

import { Header } from "@/components/dashboard/header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { SkillStatusBadge, SkillUnavailableNote } from "@/components/dashboard/skill-status";
import { agentsApi, skillsApi, type CreateAgentInput, type Skill, getErrorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

type Step = "start" | "framework" | "config" | "tools" | "code" | "review";

const steps: { id: Step; label: string; icon: React.ElementType }[] = [
  { id: "start", label: "Start", icon: Bot },
  { id: "framework", label: "Framework", icon: Bot },
  { id: "config", label: "Configuration", icon: Settings },
  { id: "tools", label: "Tools", icon: Wrench },
  { id: "code", label: "Code", icon: Code },
  { id: "review", label: "Review", icon: Check },
];

const frameworkColors: Record<string, { bg: string; text: string }> = {
  purple: { bg: "bg-purple-500/10", text: "text-purple-600" },
  green: { bg: "bg-green-500/10", text: "text-green-600" },
  blue: { bg: "bg-blue-500/10", text: "text-blue-600" },
  gray: { bg: "bg-muted", text: "text-muted-foreground" },
  cyan: { bg: "bg-cyan-500/10", text: "text-cyan-600" },
  orange: { bg: "bg-orange-500/10", text: "text-orange-600" },
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
    id: "elizaos",
    name: "ElizaOS",
    description: "Autonomous agent framework with multi-platform support",
    features: ["Multi-platform", "Autonomous", "Plugin system"],
    color: "cyan",
  },
  {
    id: "crewai",
    name: "CrewAI",
    description: "Multi-agent orchestration framework",
    features: ["Multi-agent", "Role-based", "Task planning"],
    color: "orange",
  },
  {
    id: "custom",
    name: "Custom",
    description: "Bring your own agent implementation",
    features: ["Full control", "Any language", "Docker-based"],
    color: "gray",
  },
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
  const _template = searchParams.get("template");

  const [currentStep, setCurrentStep] = useState<Step>("start");
  const [isCreating, setIsCreating] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [githubUrl, setGithubUrl] = useState("");

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
  // The tool list comes from the server (GET /api/skills) so what is
  // selectable is exactly what the runtime can execute, with honest
  // availability. Unavailable tools stay selectable, labelled.
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [customEnv, setCustomEnv] = useState<{ key: string; value: string }[]>([]);

  const loadSkills = useCallback(() => {
    setSkillsError(null);
    skillsApi
      .list()
      .then(({ skills }) => setSkills(skills))
      .catch((err) => setSkillsError(getErrorMessage(err, "Failed to load tools")));
  }, []);

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  // Visible steps exclude "start" once past it so progress bar shows correctly
  const visibleSteps = steps.filter((s) => s.id !== "start");
  const currentStepIndex = steps.findIndex((s) => s.id === currentStep);

  function goToStep(step: Step) {
    setCurrentStep(step);
  }

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

  async function handleGithubImport() {
    if (!githubUrl.trim()) {
      toast.error("Please enter a GitHub URL");
      return;
    }

    setIsImporting(true);
    try {
      const res = await fetch(`${API_URL}/api/agents/import-github`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ githubUrl }),
        credentials: "include",
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as any).message ?? "Failed to import from GitHub");
      }

      const data = await res.json() as {
        config: {
          framework: string;
          name: string;
          description: string;
          sourceUrl: string;
          detectedFiles: string[];
        };
        repoInfo: { owner: string; repo: string };
      };

      setFormData((prev) => ({
        ...prev,
        framework: data.config.framework as CreateAgentInput["framework"],
        name: data.config.name,
        description: data.config.description,
        sourceType: "github",
        sourceUrl: data.config.sourceUrl,
      }));

      toast.success(`Detected framework: ${data.config.framework}`);
      goToStep("config");
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to import from GitHub"));
    } finally {
      setIsImporting(false);
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
        description: skills?.find((t) => t.key === name)?.description || "",
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
      toast.error(getErrorMessage(error, "Failed to create agent"));
    } finally {
      setIsCreating(false);
    }
  }

  const isOnStart = currentStep === "start";
  // Progress bar uses visibleSteps (everything except "start")
  const visibleStepIndex = visibleSteps.findIndex((s) => s.id === currentStep);

  return (
    <div className="flex flex-col">
      <Header
        title="Create Agent"
        description="Build a new AI agent"
      />

      <div className="p-8">
        {/* Progress steps — only shown after the start screen */}
        {!isOnStart && (
          <div className="mb-8">
            <div className="flex items-center justify-between">
              {visibleSteps.map((step, index) => (
                <div key={step.id} className="flex items-center">
                  <button
                    onClick={() => setCurrentStep(step.id)}
                    className={cn(
                      "flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors",
                      currentStep === step.id
                        ? "bg-primary/15 text-primary-700"
                        : index < visibleStepIndex
                        ? "text-primary-600"
                        : "text-gray-400"
                    )}
                  >
                    <step.icon className="h-4 w-4" />
                    <span className="hidden md:inline">{step.label}</span>
                  </button>
                  {index < visibleSteps.length - 1 && (
                    <div
                      className={cn(
                        "mx-2 h-0.5 w-8 md:w-16",
                        index < visibleStepIndex ? "bg-primary-500" : "bg-muted"
                      )}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Step content */}
        <Card className="mb-6">
          <CardContent className="py-6">

            {/* Start — choose how to begin */}
            {currentStep === "start" && (
              <div>
                <h3 className="text-lg font-medium">How would you like to start?</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Import an existing project or build from scratch
                </p>

                <div className="mt-8 grid gap-4 md:grid-cols-3">
                  {/* Import from GitHub */}
                  <div className="flex flex-col rounded-lg border-2 border-border p-5 hover:border-primary/40 transition-all">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                        <Github className="h-5 w-5 text-foreground" />
                      </div>
                      <div>
                        <p className="font-semibold">Import from GitHub</p>
                        <p className="text-sm text-muted-foreground">Auto-detect framework</p>
                      </div>
                    </div>

                    <div className="mt-4 flex flex-col gap-2 flex-1">
                      <Input
                        value={githubUrl}
                        onChange={(e) => setGithubUrl(e.target.value)}
                        placeholder="https://github.com/owner/repo"
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleGithubImport();
                        }}
                      />
                      <Button
                        onClick={handleGithubImport}
                        isLoading={isImporting}
                        className="w-full"
                      >
                        Import
                      </Button>
                    </div>
                  </div>

                  {/* Choose a Framework */}
                  <button
                    onClick={() => goToStep("framework")}
                    className="flex flex-col items-start rounded-lg border-2 border-border p-5 text-left hover:border-primary/40 transition-all"
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/15">
                        <Bot className="h-5 w-5 text-primary-600" />
                      </div>
                      <div>
                        <p className="font-semibold">Choose a Framework</p>
                        <p className="text-sm text-muted-foreground">Mastra, LangChain, CrewAI & more</p>
                      </div>
                    </div>
                    <p className="mt-4 text-sm text-muted-foreground">
                      Pick the framework that best fits your needs and configure your agent from scratch.
                    </p>
                  </button>

                  {/* Start from Template */}
                  <button
                    onClick={() => router.push("/dashboard/templates")}
                    className="flex flex-col items-start rounded-lg border-2 border-border p-5 text-left hover:border-primary/40 transition-all"
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-500/10">
                        <LayoutTemplate className="h-5 w-5 text-green-600" />
                      </div>
                      <div>
                        <p className="font-semibold">Start from Template</p>
                        <p className="text-sm text-muted-foreground">Ready-to-use agent blueprints</p>
                      </div>
                    </div>
                    <p className="mt-4 text-sm text-muted-foreground">
                      Browse the template gallery to find a pre-built agent that matches your use case.
                    </p>
                  </button>
                </div>
              </div>
            )}

            {/* Framework selection */}
            {currentStep === "framework" && (
              <div>
                <h3 className="text-lg font-medium">Choose a Framework</h3>
                <p className="mt-1 text-sm text-muted-foreground">
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
                          ? "border-primary-500 bg-primary/10"
                          : "border-border hover:border-muted-foreground/40"
                      )}
                    >
                      <div className="flex items-center gap-3">
                        <div className={cn("flex h-10 w-10 items-center justify-center rounded-lg", frameworkColors[fw.color]?.bg)}>
                          <Bot className={cn("h-5 w-5", frameworkColors[fw.color]?.text)} />
                        </div>
                        <div>
                          <p className="font-medium">{fw.name}</p>
                          <p className="text-sm text-muted-foreground">{fw.description}</p>
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
                  <label className="block text-sm font-medium text-foreground">
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
                  <label className="block text-sm font-medium text-foreground">
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
                  <label className="block text-sm font-medium text-foreground">
                    System Prompt
                  </label>
                  <Textarea
                    value={formData.systemPrompt}
                    onChange={(e) => setFormData({ ...formData, systemPrompt: e.target.value })}
                    placeholder="You are a helpful AI assistant..."
                    rows={4}
                    className="mt-1"
                  />
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <label className="block text-sm font-medium text-foreground">
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
                        <option value="free/groq/llama-3.3-70b">GPT-OSS 120B - Groq (Free)</option>
                        <option value="free/groq/llama-3.1-8b">GPT-OSS 20B - Groq (Free)</option>
                        <option value="free/groq/qwen3-32b">Qwen3.8 27B - Groq (Free)</option>
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
                    <label className="block text-sm font-medium text-foreground">
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
                  <label className="block text-sm font-medium text-foreground">
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
                <p className="mt-1 text-sm text-muted-foreground">
                  Select the tools your agent can use
                </p>

                {skillsError && (
                  <div className="mt-6 flex items-center justify-between gap-3 rounded-lg border border-danger/30 bg-danger/10 p-4 text-sm">
                    <span>{skillsError}</span>
                    <Button type="button" variant="outline" size="sm" onClick={loadSkills}>
                      Retry
                    </Button>
                  </div>
                )}

                {!skills && !skillsError && (
                  <div className="mt-6 grid gap-4 md:grid-cols-2">
                    {[0, 1, 2, 3].map((i) => (
                      <div key={i} className="h-24 animate-pulse rounded-lg bg-muted" />
                    ))}
                  </div>
                )}

                {skills && (
                  <div className="mt-6 grid gap-4 md:grid-cols-2">
                    {skills.map((tool) => (
                      <label
                        key={tool.key}
                        className={cn(
                          "flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors",
                          selectedTools.includes(tool.key)
                            ? "border-primary-500 bg-primary/10"
                            : "border-border hover:border-muted-foreground/40"
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={selectedTools.includes(tool.key)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedTools([...selectedTools, tool.key]);
                            } else {
                              setSelectedTools(selectedTools.filter((t) => t !== tool.key));
                            }
                          }}
                          className="mt-1"
                        />
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="font-medium">{tool.name}</p>
                            <SkillStatusBadge skill={tool} />
                          </div>
                          <p className="text-sm text-muted-foreground">{tool.description}</p>
                          <SkillUnavailableNote skill={tool} />
                        </div>
                      </label>
                    ))}
                  </div>
                )}

                <div className="mt-6">
                  <h4 className="font-medium">Environment Variables</h4>
                  <p className="text-sm text-muted-foreground">
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
                <p className="mt-1 text-sm text-muted-foreground">
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
                            ? "border-primary-500 bg-primary/10"
                            : "border-border"
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
                      <label className="block text-sm font-medium text-foreground">
                        Agent Code ({formData.framework === "custom" ? "Dockerfile or script" : `${formData.framework} config`})
                      </label>
                      <Textarea
                        value={formData.sourceCode}
                        onChange={(e) => setFormData({ ...formData, sourceCode: e.target.value })}
                        placeholder={getCodePlaceholder(formData.framework as string)}
                        rows={15}
                        className="mt-1 font-mono"
                      />
                    </div>
                  )}

                  {formData.sourceType === "github" && (
                    <div className="mt-4">
                      <label className="block text-sm font-medium text-foreground">
                        GitHub Repository URL
                      </label>
                      <Input
                        value={formData.sourceUrl}
                        onChange={(e) => setFormData({ ...formData, sourceUrl: e.target.value })}
                        placeholder="https://github.com/username/repo"
                        className="mt-1"
                      />
                      <p className="mt-1 text-sm text-muted-foreground">
                        Repository must contain a valid agent configuration
                      </p>
                    </div>
                  )}

                  {formData.sourceType === "ipfs" && (
                    <div className="mt-4">
                      <label className="block text-sm font-medium text-foreground">
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
                <p className="mt-1 text-sm text-muted-foreground">
                  Review your agent configuration before creating
                </p>

                <div className="mt-6 space-y-4">
                  <div className="rounded-lg border p-4">
                    <h4 className="font-medium">Basic Info</h4>
                    <dl className="mt-2 grid gap-2 text-sm">
                      <div className="flex justify-between">
                        <dt className="text-muted-foreground">Name</dt>
                        <dd>{formData.name || "—"}</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-muted-foreground">Framework</dt>
                        <dd className="capitalize">{formData.framework}</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-muted-foreground">Model</dt>
                        <dd>{formData.modelConfig?.externalModel}</dd>
                      </div>
                    </dl>
                  </div>

                  <div className="rounded-lg border p-4">
                    <h4 className="font-medium">Tools ({selectedTools.length})</h4>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {selectedTools.length > 0 ? (
                        selectedTools.map((tool) => {
                          const skill = skills?.find((t) => t.key === tool);
                          return (
                            <Badge key={tool} variant={skill && !skill.available ? "warning" : "secondary"}>
                              {skill?.name ?? tool}
                              {skill && !skill.available ? " (needs configuration)" : ""}
                            </Badge>
                          );
                        })
                      ) : (
                        <span className="text-sm text-muted-foreground">No tools selected</span>
                      )}
                    </div>
                  </div>

                  <div className="rounded-lg border p-4">
                    <h4 className="font-medium">Source</h4>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Type: {formData.sourceType}
                    </p>
                    {formData.sourceUrl && (
                      <p className="mt-1 text-sm text-muted-foreground break-all">
                        URL: {formData.sourceUrl}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Navigation */}
        {!isOnStart && (
          <div className="flex justify-between">
            <Button
              variant="outline"
              onClick={prevStep}
              disabled={currentStepIndex <= 1}
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
        )}
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
    name: 'openai/gpt-oss-120b',
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
    case "elizaos":
      return `import { Character, ModelProviderName } from '@elizaos/core';

export const character: Character = {
  name: 'My Agent',
  bio: ['A helpful AI assistant.'],
  lore: [],
  messageExamples: [],
  postExamples: [],
  topics: [],
  style: { all: [], chat: [], post: [] },
  adjectives: [],
  modelProvider: ModelProviderName.GROQ,
  plugins: [],
};`;
    case "crewai":
      return `from crewai import Agent, Crew, Task

agent = Agent(
    role='Assistant',
    goal='Complete tasks effectively',
    backstory='You are a helpful AI agent.',
    verbose=False,
    allow_delegation=False,
)

task = Task(
    description='Your task description here',
    agent=agent,
    expected_output='A clear and concise result',
)

crew = Crew(agents=[agent], tasks=[task])
result = crew.kickoff()`;
    default:
      return `# Your custom agent implementation
# Can be a Dockerfile or any script`;
  }
}
