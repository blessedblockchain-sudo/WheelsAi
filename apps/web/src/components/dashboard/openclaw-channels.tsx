"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import {
  Plus,
  Trash2,
  MessageSquare,
  Hash,
  Send,
  Twitter,
  Phone,
  Globe,
  Bot,
} from "lucide-react";
import { cn } from "@/lib/utils";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

interface Channel {
  id: string;
  platform: string;
  enabled: boolean;
  createdAt: string;
}

interface OpenClawChannelsProps {
  deploymentId: string;
  channels: Channel[];
  onRefresh: () => void;
}

const platformConfig: Record<string, { label: string; icon: typeof MessageSquare; color: string; fields: { key: string; label: string; placeholder: string; type?: string }[] }> = {
  discord: {
    label: "Discord",
    icon: Hash,
    color: "bg-indigo-500",
    fields: [
      { key: "botToken", label: "Bot Token", placeholder: "Enter Discord bot token", type: "password" },
      { key: "guildId", label: "Guild ID", placeholder: "Enter server/guild ID" },
    ],
  },
  telegram: {
    label: "Telegram",
    icon: Send,
    color: "bg-blue-500",
    fields: [
      { key: "botToken", label: "Bot Token", placeholder: "Enter Telegram bot token", type: "password" },
    ],
  },
  slack: {
    label: "Slack",
    icon: MessageSquare,
    color: "bg-purple-700",
    fields: [
      { key: "botToken", label: "Bot Token", placeholder: "xoxb-...", type: "password" },
      { key: "signingSecret", label: "Signing Secret", placeholder: "Enter signing secret", type: "password" },
    ],
  },
  twitter: {
    label: "Twitter / X",
    icon: Twitter,
    color: "bg-black",
    fields: [
      { key: "apiKey", label: "API Key", placeholder: "Enter API key", type: "password" },
      { key: "apiSecret", label: "API Secret", placeholder: "Enter API secret", type: "password" },
      { key: "accessToken", label: "Access Token", placeholder: "Enter access token", type: "password" },
      { key: "accessTokenSecret", label: "Access Token Secret", placeholder: "Enter access token secret", type: "password" },
    ],
  },
  whatsapp: {
    label: "WhatsApp",
    icon: Phone,
    color: "bg-green-600",
    fields: [
      { key: "phoneNumberId", label: "Phone Number ID", placeholder: "Enter phone number ID" },
      { key: "accessToken", label: "Access Token", placeholder: "Enter access token", type: "password" },
      { key: "verifyToken", label: "Verify Token", placeholder: "Enter verify token", type: "password" },
    ],
  },
  webhook: {
    label: "Webhook",
    icon: Globe,
    color: "bg-gray-700",
    fields: [
      { key: "webhookUrl", label: "Webhook URL", placeholder: "https://..." },
      { key: "secret", label: "Secret", placeholder: "HMAC signing secret", type: "password" },
    ],
  },
};

export function OpenClawChannels({ deploymentId, channels, onRefresh }: OpenClawChannelsProps) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [selectedPlatform, setSelectedPlatform] = useState<string | null>(null);
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const handleAddChannel = async () => {
    if (!selectedPlatform) return;

    try {
      setSubmitting(true);
      const response = await fetch(`${API_URL}/api/openclaw/deployments/${deploymentId}/channels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          platform: selectedPlatform,
          config: formData,
        }),
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.message || "Failed to add channel");
      }

      toast.success(`${platformConfig[selectedPlatform]?.label || selectedPlatform} channel added`);
      setShowAddForm(false);
      setSelectedPlatform(null);
      setFormData({});
      onRefresh();
    } catch (error: any) {
      toast.error(error.message || "Failed to add channel");
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggle = async (channelId: string, enabled: boolean) => {
    try {
      const response = await fetch(`${API_URL}/api/openclaw/channels/${channelId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ enabled }),
      });

      if (!response.ok) throw new Error("Failed to update channel");
      toast.success(`Channel ${enabled ? "enabled" : "disabled"}`);
      onRefresh();
    } catch {
      toast.error("Failed to update channel");
    }
  };

  const handleDelete = async (channelId: string) => {
    if (!confirm("Remove this channel?")) return;

    try {
      const response = await fetch(`${API_URL}/api/openclaw/channels/${channelId}`, {
        method: "DELETE",
        credentials: "include",
      });

      if (!response.ok) throw new Error("Failed to remove channel");
      toast.success("Channel removed");
      onRefresh();
    } catch {
      toast.error("Failed to remove channel");
    }
  };

  const availablePlatforms = Object.keys(platformConfig).filter(
    (p) => !channels.some((c) => c.platform === p)
  );

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Channels ({channels.length})</CardTitle>
            <CardDescription>Manage messaging platform integrations</CardDescription>
          </div>
          {!showAddForm && availablePlatforms.length > 0 && (
            <Button size="sm" onClick={() => setShowAddForm(true)}>
              <Plus className="mr-1 h-4 w-4" />
              Add Channel
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Existing Channels */}
        {channels.length === 0 && !showAddForm ? (
          <div className="text-center py-8 text-muted-foreground">
            <Bot className="h-12 w-12 mx-auto mb-3 opacity-50" />
            <p>No channels configured yet</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => setShowAddForm(true)}
            >
              <Plus className="mr-1 h-4 w-4" />
              Add your first channel
            </Button>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {channels.map((channel) => {
              const config = platformConfig[channel.platform];
              const Icon = config?.icon || Globe;
              return (
                <div
                  key={channel.id}
                  className="flex items-center justify-between p-4 border rounded-lg"
                >
                  <div className="flex items-center gap-3">
                    <div className={cn("w-8 h-8 rounded-md flex items-center justify-center text-white", config?.color || "bg-gray-500")}>
                      <Icon className="h-4 w-4" />
                    </div>
                    <div>
                      <div className="font-medium text-sm">{config?.label || channel.platform}</div>
                      <div className="text-xs text-muted-foreground">
                        {new Date(channel.createdAt).toLocaleDateString()}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={channel.enabled}
                      onCheckedChange={(checked) => handleToggle(channel.id, checked)}
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8 text-red-500 hover:text-red-600 hover:bg-red-50"
                      onClick={() => handleDelete(channel.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Add Channel Form */}
        {showAddForm && (
          <div className="border rounded-lg p-4 space-y-4 bg-muted/30">
            <div className="flex items-center justify-between">
              <h4 className="font-medium">Add Channel</h4>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setShowAddForm(false);
                  setSelectedPlatform(null);
                  setFormData({});
                }}
              >
                Cancel
              </Button>
            </div>

            {/* Platform Selection */}
            {!selectedPlatform ? (
              <div className="grid gap-2 sm:grid-cols-3">
                {availablePlatforms.map((platform) => {
                  const config = platformConfig[platform];
                  const Icon = config.icon;
                  return (
                    <button
                      key={platform}
                      onClick={() => setSelectedPlatform(platform)}
                      className="flex items-center gap-3 p-3 border rounded-lg hover:bg-muted transition-colors text-left"
                    >
                      <div className={cn("w-8 h-8 rounded-md flex items-center justify-center text-white", config.color)}>
                        <Icon className="h-4 w-4" />
                      </div>
                      <span className="font-medium text-sm">{config.label}</span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{platformConfig[selectedPlatform]?.label}</Badge>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setSelectedPlatform(null);
                      setFormData({});
                    }}
                  >
                    Change
                  </Button>
                </div>

                {platformConfig[selectedPlatform]?.fields.map((field) => (
                  <div key={field.key} className="space-y-1">
                    <Label htmlFor={field.key}>{field.label}</Label>
                    <Input
                      id={field.key}
                      type={field.type || "text"}
                      placeholder={field.placeholder}
                      value={formData[field.key] || ""}
                      onChange={(e) =>
                        setFormData((prev) => ({ ...prev, [field.key]: e.target.value }))
                      }
                    />
                  </div>
                ))}

                <Button
                  onClick={handleAddChannel}
                  disabled={submitting}
                  className="w-full"
                >
                  {submitting ? "Adding..." : "Add Channel"}
                </Button>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
