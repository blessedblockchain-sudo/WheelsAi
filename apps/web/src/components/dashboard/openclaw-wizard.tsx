"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import {
  ArrowRight,
  ArrowLeft,
  Check,
  Loader2,
  MessageSquare,
  Send,
  Twitter,
  Hash,
  Bot,
  Sparkles,
} from "lucide-react";
import { CHANNELS_WEBSITE_CHAT_HREF } from "@/lib/nav";
import { cn } from "@/lib/utils";
import { getErrorMessage } from "@/lib/api";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

const MODELS = [
  { value: "gpt-4", label: "GPT-4", description: "Most capable model" },
  { value: "gpt-3.5-turbo", label: "GPT-3.5 Turbo", description: "Fast and efficient" },
  { value: "claude-3-opus", label: "Claude 3 Opus", description: "Advanced reasoning" },
  { value: "claude-3-sonnet", label: "Claude 3 Sonnet", description: "Balanced performance" },
];

const GPU_TIERS = [
  { value: "basic", label: "Basic", description: "1x GPU, 8GB VRAM" },
  { value: "standard", label: "Standard", description: "2x GPU, 16GB VRAM" },
  { value: "premium", label: "Premium", description: "4x GPU, 32GB VRAM" },
];

const PLATFORMS = [
  { id: "discord", name: "Discord", icon: MessageSquare, color: "text-[#5865F2]" },
  { id: "telegram", name: "Telegram", icon: Send, color: "text-[#0088cc]" },
  { id: "twitter", name: "Twitter", icon: Twitter, color: "text-[#1DA1F2]" },
  { id: "slack", name: "Slack", icon: Hash, color: "text-[#4A154B]" },
  { id: "whatsapp", name: "WhatsApp", icon: MessageSquare, color: "text-[#25D366]" },
  { id: "webchat", name: "Web Chat", icon: MessageSquare, color: "text-blue-600" },
];

interface AgentConfig {
  agentName: string;
  slug: string;
  description: string;
  systemPrompt: string;
  model: string;
  gpuTier: string;
  temperature: number;
  maxTokens: number;
}

interface ChannelConfig {
  platform: string;
  enabled: boolean;
  config: Record<string, string>;
}

type WizardStep = "agent" | "channels" | "review";

export function OpenClawWizard() {
  const router = useRouter();
  const [currentStep, setCurrentStep] = useState<WizardStep>("agent");
  const [deploying, setDeploying] = useState(false);

  const [agentConfig, setAgentConfig] = useState<AgentConfig>({
    agentName: "",
    slug: "",
    description: "",
    systemPrompt: "You are a helpful AI assistant.",
    model: "gpt-4",
    gpuTier: "basic",
    temperature: 0.7,
    maxTokens: 2048,
  });

  const [channels, setChannels] = useState<ChannelConfig[]>(
    PLATFORMS.map((platform) => ({
      platform: platform.id,
      enabled: false,
      config: {},
    }))
  );

  const handleAgentConfigChange = (field: keyof AgentConfig, value: any) => {
    setAgentConfig((prev) => ({ ...prev, [field]: value }));

    // Auto-generate slug from agent name
    if (field === "agentName") {
      const slug = value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      setAgentConfig((prev) => ({ ...prev, slug }));
    }
  };

  const handleToggleChannel = (platform: string) => {
    setChannels((prev) =>
      prev.map((ch) =>
        ch.platform === platform ? { ...ch, enabled: !ch.enabled } : ch
      )
    );
  };

  const handleChannelConfigChange = (platform: string, key: string, value: string) => {
    setChannels((prev) =>
      prev.map((ch) =>
        ch.platform === platform
          ? { ...ch, config: { ...ch.config, [key]: value } }
          : ch
      )
    );
  };

  const validateAgentStep = () => {
    if (!agentConfig.agentName.trim()) {
      toast.error("Agent name is required");
      return false;
    }
    if (!agentConfig.slug.trim()) {
      toast.error("Slug is required");
      return false;
    }
    if (!agentConfig.systemPrompt.trim()) {
      toast.error("System prompt is required");
      return false;
    }
    return true;
  };

  const validateChannelsStep = () => {
    const enabledChannels = channels.filter((ch) => ch.enabled);
    if (enabledChannels.length === 0) {
      toast.error("At least one channel must be enabled");
      return false;
    }

    for (const channel of enabledChannels) {
      const configFields = getChannelConfigFields(channel.platform);
      for (const field of configFields) {
        if (field.required && !channel.config[field.key]?.trim()) {
          toast.error(`${field.label} is required for ${channel.platform}`);
          return false;
        }
      }
    }

    return true;
  };

  const handleNextStep = () => {
    if (currentStep === "agent") {
      if (validateAgentStep()) {
        setCurrentStep("channels");
      }
    } else if (currentStep === "channels") {
      if (validateChannelsStep()) {
        setCurrentStep("review");
      }
    }
  };

  const handlePreviousStep = () => {
    if (currentStep === "channels") {
      setCurrentStep("agent");
    } else if (currentStep === "review") {
      setCurrentStep("channels");
    }
  };

  const handleDeploy = async () => {
    try {
      setDeploying(true);

      const enabledChannels = channels.filter((ch) => ch.enabled);

      const payload = {
        agentName: agentConfig.agentName,
        slug: agentConfig.slug,
        description: agentConfig.description,
        systemPrompt: agentConfig.systemPrompt,
        modelConfig: {
          model: agentConfig.model,
          temperature: agentConfig.temperature,
          maxTokens: agentConfig.maxTokens,
        },
        gpuTier: agentConfig.gpuTier,
        channels: enabledChannels.map((ch) => ({
          platform: ch.platform,
          config: ch.config,
        })),
      };

      const response = await fetch(`${API_URL}/api/openclaw/deployments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || "Failed to create deployment");
      }

      const data = await response.json();
      toast.success("Deployment created successfully!");
      // "Web Chat" made a web chat key, which still needs the sites that
      // may embed it before it works anywhere but the dashboard preview.
      if (data.webChatKey) {
        toast.info("Web chat key created. Add your site and copy the snippet under Channels, Website chat.", {
          action: { label: "Open Website chat", onClick: () => router.push(CHANNELS_WEBSITE_CHAT_HREF) },
          duration: 15000,
        });
      }
      router.push(`/dashboard/openclaw/${data.deployment.id}`);
    } catch (error: any) {
      console.error("Error creating deployment:", error);
      toast.error(getErrorMessage(error, "Failed to create deployment"));
    } finally {
      setDeploying(false);
    }
  };

  const getChannelConfigFields = (platform: string) => {
    const fields: { key: string; label: string; type: string; required: boolean; placeholder?: string }[] = [];

    switch (platform) {
      case "discord":
        fields.push(
          { key: "botToken", label: "Bot Token", type: "password", required: true, placeholder: "Your Discord bot token" },
          { key: "guildId", label: "Guild ID", type: "text", required: false, placeholder: "Optional: Specific server ID" }
        );
        break;
      case "telegram":
        fields.push(
          { key: "botToken", label: "Bot Token", type: "password", required: true, placeholder: "Your Telegram bot token" }
        );
        break;
      case "twitter":
        fields.push(
          { key: "apiKey", label: "API Key", type: "password", required: true, placeholder: "Twitter API key" },
          { key: "apiSecret", label: "API Secret", type: "password", required: true, placeholder: "Twitter API secret" },
          { key: "accessToken", label: "Access Token", type: "password", required: true, placeholder: "Twitter access token" },
          { key: "accessSecret", label: "Access Secret", type: "password", required: true, placeholder: "Twitter access secret" }
        );
        break;
      case "slack":
        fields.push(
          { key: "botToken", label: "Bot Token", type: "password", required: true, placeholder: "Your Slack bot token" },
          { key: "signingSecret", label: "Signing Secret", type: "password", required: true, placeholder: "Slack signing secret" }
        );
        break;
      case "whatsapp":
        fields.push(
          { key: "phoneNumberId", label: "Phone Number ID", type: "text", required: true, placeholder: "WhatsApp phone number ID" },
          { key: "accessToken", label: "Access Token", type: "password", required: true, placeholder: "WhatsApp access token" }
        );
        break;
      case "webchat":
        fields.push(
          { key: "widgetTitle", label: "Widget Title", type: "text", required: false, placeholder: "Chat with us" },
          { key: "primaryColor", label: "Primary Color", type: "color", required: false, placeholder: "#0088cc" }
        );
        break;
    }

    return fields;
  };

  const renderStepIndicator = () => {
    const steps = [
      { id: "agent", label: "Agent Config" },
      { id: "channels", label: "Channels" },
      { id: "review", label: "Review" },
    ];

    return (
      <div className="flex items-center justify-center mb-8">
        {steps.map((step, index) => (
          <div key={step.id} className="flex items-center">
            <div className="flex flex-col items-center">
              <div
                className={cn(
                  "w-10 h-10 rounded-full flex items-center justify-center border-2 transition-colors",
                  currentStep === step.id
                    ? "border-primary bg-primary text-primary-foreground"
                    : steps.findIndex((s) => s.id === currentStep) > index
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-card text-muted-foreground"
                )}
              >
                {steps.findIndex((s) => s.id === currentStep) > index ? (
                  <Check className="h-5 w-5" />
                ) : (
                  <span>{index + 1}</span>
                )}
              </div>
              <span className="mt-2 text-sm font-medium">{step.label}</span>
            </div>
            {index < steps.length - 1 && (
              <div
                className={cn(
                  "w-24 h-0.5 mx-4 mb-6",
                  steps.findIndex((s) => s.id === currentStep) > index
                    ? "bg-primary"
                    : "bg-gray-300"
                )}
              />
            )}
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="max-w-4xl mx-auto">
      {renderStepIndicator()}

      {/* Step 1: Agent Configuration */}
      {currentStep === "agent" && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bot className="h-5 w-5" />
              Agent Configuration
            </CardTitle>
            <CardDescription>Configure your AI agent's identity and behavior</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div>
              <label className="block text-sm font-medium mb-2">Agent Name *</label>
              <input
                type="text"
                value={agentConfig.agentName}
                onChange={(e) => handleAgentConfigChange("agentName", e.target.value)}
                className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
                placeholder="My AI Assistant"
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">Slug *</label>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">/</span>
                <input
                  type="text"
                  value={agentConfig.slug}
                  onChange={(e) => handleAgentConfigChange("slug", e.target.value)}
                  className="flex-1 px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary font-mono"
                  placeholder="my-ai-assistant"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">Description</label>
              <input
                type="text"
                value={agentConfig.description}
                onChange={(e) => handleAgentConfigChange("description", e.target.value)}
                className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
                placeholder="A helpful AI assistant for..."
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">System Prompt *</label>
              <Textarea
                value={agentConfig.systemPrompt}
                onChange={(e) => handleAgentConfigChange("systemPrompt", e.target.value)}
                rows={6}
                className="font-mono"
                placeholder="You are a helpful AI assistant that..."
              />
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label className="block text-sm font-medium mb-2">AI Model *</label>
                <select
                  value={agentConfig.model}
                  onChange={(e) => handleAgentConfigChange("model", e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  {MODELS.map((model) => (
                    <option key={model.value} value={model.value}>
                      {model.label} - {model.description}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium mb-2">GPU Tier *</label>
                <select
                  value={agentConfig.gpuTier}
                  onChange={(e) => handleAgentConfigChange("gpuTier", e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  {GPU_TIERS.map((tier) => (
                    <option key={tier.value} value={tier.value}>
                      {tier.label} - {tier.description}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium mb-2">Temperature</label>
                <input
                  type="number"
                  min="0"
                  max="2"
                  step="0.1"
                  value={agentConfig.temperature}
                  onChange={(e) => handleAgentConfigChange("temperature", parseFloat(e.target.value))}
                  className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-2">Max Tokens</label>
                <input
                  type="number"
                  min="1"
                  max="8192"
                  step="1"
                  value={agentConfig.maxTokens}
                  onChange={(e) => handleAgentConfigChange("maxTokens", parseInt(e.target.value))}
                  className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
            </div>

            <div className="flex justify-end">
              <Button onClick={handleNextStep}>
                Next: Configure Channels
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step 2: Channels */}
      {currentStep === "channels" && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="h-5 w-5" />
              Channel Configuration
            </CardTitle>
            <CardDescription>Select and configure platform integrations</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid gap-4 md:grid-cols-2">
              {PLATFORMS.map((platform) => {
                const channel = channels.find((ch) => ch.platform === platform.id)!;
                const Icon = platform.icon;

                return (
                  <div
                    key={platform.id}
                    className={cn(
                      "border-2 rounded-lg p-4 cursor-pointer transition-all",
                      channel.enabled
                        ? "border-primary bg-primary/5"
                        : "border-border hover:border-muted-foreground/40"
                    )}
                    onClick={() => handleToggleChannel(platform.id)}
                  >
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-3">
                        <Icon className={cn("h-6 w-6", platform.color)} />
                        <span className="font-medium">{platform.name}</span>
                      </div>
                      <div
                        className={cn(
                          "w-5 h-5 rounded border-2 flex items-center justify-center",
                          channel.enabled
                            ? "border-primary bg-primary"
                            : "border-border"
                        )}
                      >
                        {channel.enabled && <Check className="h-3 w-3 text-white" />}
                      </div>
                    </div>

                    {channel.enabled && (
                      <div className="space-y-3 mt-4" onClick={(e) => e.stopPropagation()}>
                        {getChannelConfigFields(platform.id).map((field) => (
                          <div key={field.key}>
                            <label className="block text-xs font-medium mb-1">
                              {field.label} {field.required && "*"}
                            </label>
                            <input
                              type={field.type}
                              value={channel.config[field.key] || ""}
                              onChange={(e) =>
                                handleChannelConfigChange(platform.id, field.key, e.target.value)
                              }
                              className="w-full px-2 py-1.5 text-sm border rounded focus:outline-none focus:ring-2 focus:ring-primary"
                              placeholder={field.placeholder}
                            />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="flex justify-between">
              <Button variant="outline" onClick={handlePreviousStep}>
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back
              </Button>
              <Button onClick={handleNextStep}>
                Next: Review & Deploy
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step 3: Review & Deploy */}
      {currentStep === "review" && (
        <Card>
          <CardHeader>
            <CardTitle>Review & Deploy</CardTitle>
            <CardDescription>Confirm your deployment configuration</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-4">
              <div>
                <h3 className="font-semibold mb-2">Agent Configuration</h3>
                <div className="bg-muted p-4 rounded-lg space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Name:</span>
                    <span className="font-medium">{agentConfig.agentName}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Slug:</span>
                    <span className="font-mono">/{agentConfig.slug}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Model:</span>
                    <span>{MODELS.find((m) => m.value === agentConfig.model)?.label}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">GPU Tier:</span>
                    <span>{GPU_TIERS.find((t) => t.value === agentConfig.gpuTier)?.label}</span>
                  </div>
                </div>
              </div>

              <div>
                <h3 className="font-semibold mb-2">Enabled Channels</h3>
                <div className="flex flex-wrap gap-2">
                  {channels
                    .filter((ch) => ch.enabled)
                    .map((ch) => {
                      const platform = PLATFORMS.find((p) => p.id === ch.platform)!;
                      return (
                        <Badge key={ch.platform} variant="secondary">
                          {platform.name}
                        </Badge>
                      );
                    })}
                </div>
              </div>

              <div>
                <h3 className="font-semibold mb-2">System Prompt</h3>
                <div className="bg-muted p-4 rounded-lg">
                  <pre className="text-sm whitespace-pre-wrap font-mono">
                    {agentConfig.systemPrompt}
                  </pre>
                </div>
              </div>
            </div>

            <div className="flex justify-between">
              <Button variant="outline" onClick={handlePreviousStep} disabled={deploying}>
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back
              </Button>
              <Button onClick={handleDeploy} disabled={deploying}>
                {deploying ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Deploying...
                  </>
                ) : (
                  <>
                    <Sparkles className="mr-2 h-4 w-4" />
                    Deploy Agent
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
