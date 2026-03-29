"use client";

import { useState, useEffect } from "react";
import {
  webhooksApi,
  integrationsApi,
  Webhook,
  WebhookDelivery,
  Integration,
  AvailableIntegration,
  WebhookEventType,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

// Icons
function WebhookIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2" />
      <path d="m6 17 3.13-5.78c.53-.97.43-2.22-.26-3.07a2.5 2.5 0 0 1 3.92-3.12" />
      <path d="m12 8 3.13 5.73c.53.98 1.45 1.7 2.53 1.98A4 4 0 0 1 18 22a4 4 0 0 1-3.86-3.01" />
      <circle cx="12" cy="12" r="2" />
    </svg>
  );
}

function PlugIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 22v-5" />
      <path d="M9 8V2" />
      <path d="M15 8V2" />
      <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
    </svg>
  );
}

function CheckCircleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <path d="m9 11 3 3L22 4" />
    </svg>
  );
}

function XCircleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <path d="m15 9-6 6" />
      <path d="m9 9 6 6" />
    </svg>
  );
}

function RefreshIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </svg>
  );
}

function PlusIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

function TrashIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    </svg>
  );
}

function CopyIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </svg>
  );
}

// Integration icons
const integrationIcons: Record<string, React.ReactNode> = {
  slack: (
    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
      <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" />
    </svg>
  ),
  discord: (
    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
    </svg>
  ),
  github: (
    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
    </svg>
  ),
  zapier: (
    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.562 8.438L13.5 12.5l4.062 4.062-.875.875L12.625 13.5 8.562 17.438l-.874-.875L11.75 12.5 7.688 8.438l.874-.875 4.063 4.062 4.062-4.062.875.875z" />
    </svg>
  ),
  make: (
    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="12" cy="12" r="10" />
    </svg>
  ),
  n8n: (
    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
    </svg>
  ),
};

export default function IntegrationsPage() {
  const [activeTab, setActiveTab] = useState<"webhooks" | "integrations">("webhooks");
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [availableIntegrations, setAvailableIntegrations] = useState<AvailableIntegration[]>([]);
  const [webhookEvents, setWebhookEvents] = useState<WebhookEventType[]>([]);
  const [loading, setLoading] = useState(true);

  // Modals
  const [showWebhookModal, setShowWebhookModal] = useState(false);
  const [showIntegrationModal, setShowIntegrationModal] = useState(false);
  const [selectedWebhook, setSelectedWebhook] = useState<Webhook | null>(null);
  const [selectedIntegrationType, setSelectedIntegrationType] = useState<string | null>(null);

  // Form state
  const [webhookForm, setWebhookForm] = useState({
    name: "",
    description: "",
    url: "",
    events: [] as string[],
  });
  const [integrationForm, setIntegrationForm] = useState({
    name: "",
    config: {} as Record<string, string>,
  });

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    setLoading(true);
    try {
      const [webhooksRes, integrationsRes, availableRes, eventsRes] = await Promise.all([
        webhooksApi.getWebhooks(),
        integrationsApi.getIntegrations(),
        integrationsApi.getAvailable(),
        webhooksApi.getEvents(),
      ]);
      setWebhooks(webhooksRes.webhooks);
      setIntegrations(integrationsRes.integrations);
      setAvailableIntegrations(availableRes.integrations);
      setWebhookEvents(eventsRes.events);
    } catch (error) {
      console.error("Failed to load data:", error);
    } finally {
      setLoading(false);
    }
  }

  async function createWebhook() {
    try {
      const webhook = await webhooksApi.createWebhook({
        name: webhookForm.name,
        description: webhookForm.description,
        url: webhookForm.url,
        events: webhookForm.events,
      });
      setWebhooks([webhook, ...webhooks]);
      setShowWebhookModal(false);
      setWebhookForm({ name: "", description: "", url: "", events: [] });
    } catch (error) {
      console.error("Failed to create webhook:", error);
    }
  }

  async function deleteWebhook(id: string) {
    if (!confirm("Are you sure you want to delete this webhook?")) return;
    try {
      await webhooksApi.deleteWebhook(id);
      setWebhooks(webhooks.filter((w) => w.id !== id));
    } catch (error) {
      console.error("Failed to delete webhook:", error);
    }
  }

  async function testWebhook(id: string) {
    try {
      const result = await webhooksApi.testWebhook(id);
      if (result.success) {
        toast.success(`Test successful! Response time: ${result.responseTimeMs}ms`);
      } else {
        toast.error(`Test failed: ${result.error}`);
      }
    } catch (error) {
      console.error("Failed to test webhook:", error);
    }
  }

  async function toggleWebhook(webhook: Webhook) {
    try {
      const updated = await webhooksApi.updateWebhook(webhook.id, {
        isEnabled: !webhook.isEnabled,
      });
      setWebhooks(webhooks.map((w) => (w.id === webhook.id ? updated : w)));
    } catch (error) {
      console.error("Failed to toggle webhook:", error);
    }
  }

  async function createIntegration() {
    if (!selectedIntegrationType) return;
    try {
      const integration = await integrationsApi.createIntegration({
        type: selectedIntegrationType as any,
        name: integrationForm.name,
        config: integrationForm.config,
      });
      setIntegrations([integration, ...integrations]);
      setShowIntegrationModal(false);
      setSelectedIntegrationType(null);
      setIntegrationForm({ name: "", config: {} });
    } catch (error) {
      console.error("Failed to create integration:", error);
    }
  }

  async function deleteIntegration(id: string) {
    if (!confirm("Are you sure you want to delete this integration?")) return;
    try {
      await integrationsApi.deleteIntegration(id);
      setIntegrations(integrations.filter((i) => i.id !== id));
    } catch (error) {
      console.error("Failed to delete integration:", error);
    }
  }

  async function testIntegration(id: string, type: string) {
    try {
      const result = await integrationsApi.testIntegration(id, "send_message");
      if (result.success) {
        alert("Test message sent successfully!");
      }
    } catch (error: any) {
      alert(`Test failed: ${error.message}`);
    }
  }

  if (loading) {
    return (
      <div className="p-8 flex items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-8">
      <div>
        <h1 className="text-3xl font-bold">Webhooks & Integrations</h1>
        <p className="text-muted-foreground mt-2">
          Connect WheelsAI to external services and receive real-time event notifications
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b">
        <button
          onClick={() => setActiveTab("webhooks")}
          className={`px-4 py-2 font-medium ${
            activeTab === "webhooks"
              ? "border-b-2 border-primary text-primary"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <WebhookIcon className="w-4 h-4 inline-block mr-2" />
          Webhooks
        </button>
        <button
          onClick={() => setActiveTab("integrations")}
          className={`px-4 py-2 font-medium ${
            activeTab === "integrations"
              ? "border-b-2 border-primary text-primary"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <PlugIcon className="w-4 h-4 inline-block mr-2" />
          Integrations
        </button>
      </div>

      {/* Webhooks Tab */}
      {activeTab === "webhooks" && (
        <div className="space-y-6">
          <div className="flex justify-between items-center">
            <div>
              <h2 className="text-xl font-semibold">Webhooks</h2>
              <p className="text-sm text-muted-foreground">
                Receive HTTP callbacks when events occur in your account
              </p>
            </div>
            <Button onClick={() => setShowWebhookModal(true)}>
              <PlusIcon className="w-4 h-4 mr-2" />
              Add Webhook
            </Button>
          </div>

          {webhooks.length === 0 ? (
            <div className="border rounded-lg p-12 text-center">
              <WebhookIcon className="w-12 h-12 mx-auto text-muted-foreground" />
              <h3 className="mt-4 font-semibold">No webhooks configured</h3>
              <p className="text-sm text-muted-foreground mt-2">
                Create a webhook to receive real-time notifications
              </p>
              <Button className="mt-4" onClick={() => setShowWebhookModal(true)}>
                Create Webhook
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              {webhooks.map((webhook) => (
                <div
                  key={webhook.id}
                  className="border rounded-lg p-4 flex items-center justify-between"
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{webhook.name}</span>
                      {webhook.isEnabled ? (
                        <span className="px-2 py-0.5 bg-green-100 text-green-700 text-xs rounded">
                          Active
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 bg-gray-100 text-gray-600 text-xs rounded">
                          Disabled
                        </span>
                      )}
                      {webhook.consecutiveFailures > 0 && (
                        <span className="px-2 py-0.5 bg-red-100 text-red-700 text-xs rounded">
                          {webhook.consecutiveFailures} failures
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground mt-1">{webhook.url}</p>
                    <div className="flex flex-wrap gap-1 mt-2">
                      {webhook.events.slice(0, 3).map((event) => (
                        <span
                          key={event}
                          className="px-2 py-0.5 bg-secondary text-xs rounded"
                        >
                          {event}
                        </span>
                      ))}
                      {webhook.events.length > 3 && (
                        <span className="px-2 py-0.5 bg-secondary text-xs rounded">
                          +{webhook.events.length - 3} more
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => testWebhook(webhook.id)}
                    >
                      Test
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => toggleWebhook(webhook)}
                    >
                      {webhook.isEnabled ? "Disable" : "Enable"}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => deleteWebhook(webhook.id)}
                    >
                      <TrashIcon className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Integrations Tab */}
      {activeTab === "integrations" && (
        <div className="space-y-6">
          <div>
            <h2 className="text-xl font-semibold">Available Integrations</h2>
            <p className="text-sm text-muted-foreground">
              Connect WheelsAI to your favorite tools
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {availableIntegrations.map((integration) => {
              const connected = integrations.find(
                (i) => i.type === integration.type && i.isConnected
              );
              return (
                <div
                  key={integration.type}
                  className="border rounded-lg p-4 hover:border-primary/50 transition-colors"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg bg-secondary flex items-center justify-center text-foreground">
                        {integrationIcons[integration.type] || (
                          <PlugIcon className="w-5 h-5" />
                        )}
                      </div>
                      <div>
                        <h3 className="font-medium">{integration.name}</h3>
                        {connected && (
                          <span className="text-xs text-green-600 flex items-center gap-1">
                            <CheckCircleIcon className="w-3 h-3" />
                            Connected
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground mt-3">
                    {integration.description}
                  </p>
                  <div className="flex flex-wrap gap-1 mt-3">
                    {integration.features.map((feature) => (
                      <span
                        key={feature}
                        className="px-2 py-0.5 bg-secondary text-xs rounded capitalize"
                      >
                        {feature}
                      </span>
                    ))}
                  </div>
                  <div className="mt-4">
                    {connected ? (
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="flex-1"
                          onClick={() => testIntegration(connected.id, integration.type)}
                        >
                          Test
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="flex-1"
                          onClick={() => deleteIntegration(connected.id)}
                        >
                          Disconnect
                        </Button>
                      </div>
                    ) : (
                      <Button
                        className="w-full"
                        onClick={() => {
                          setSelectedIntegrationType(integration.type);
                          setIntegrationForm({ name: integration.name, config: {} });
                          setShowIntegrationModal(true);
                        }}
                      >
                        Connect
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Connected Integrations */}
          {integrations.length > 0 && (
            <div className="mt-8">
              <h2 className="text-xl font-semibold mb-4">Connected Integrations</h2>
              <div className="space-y-4">
                {integrations.map((integration) => (
                  <div
                    key={integration.id}
                    className="border rounded-lg p-4 flex items-center justify-between"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg bg-secondary flex items-center justify-center">
                        {integrationIcons[integration.type] || (
                          <PlugIcon className="w-5 h-5" />
                        )}
                      </div>
                      <div>
                        <div className="font-medium">{integration.name}</div>
                        <div className="text-sm text-muted-foreground capitalize">
                          {integration.type}
                          {integration.externalName && ` - ${integration.externalName}`}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {integration.isConnected ? (
                        <span className="text-xs text-green-600 flex items-center gap-1">
                          <CheckCircleIcon className="w-3 h-3" />
                          Connected
                        </span>
                      ) : (
                        <span className="text-xs text-yellow-600 flex items-center gap-1">
                          <XCircleIcon className="w-3 h-3" />
                          Not connected
                        </span>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => deleteIntegration(integration.id)}
                      >
                        <TrashIcon className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Create Webhook Modal */}
      {showWebhookModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-background rounded-lg p-6 max-w-lg w-full mx-4 max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-semibold mb-4">Create Webhook</h2>
            <div className="space-y-4">
              <div>
                <Label>Name</Label>
                <Input
                  value={webhookForm.name}
                  onChange={(e) =>
                    setWebhookForm({ ...webhookForm, name: e.target.value })
                  }
                  placeholder="My Webhook"
                />
              </div>
              <div>
                <Label>Description (optional)</Label>
                <Input
                  value={webhookForm.description}
                  onChange={(e) =>
                    setWebhookForm({ ...webhookForm, description: e.target.value })
                  }
                  placeholder="Notify on agent events"
                />
              </div>
              <div>
                <Label>Endpoint URL</Label>
                <Input
                  value={webhookForm.url}
                  onChange={(e) =>
                    setWebhookForm({ ...webhookForm, url: e.target.value })
                  }
                  placeholder="https://example.com/webhook"
                />
              </div>
              <div>
                <Label>Events</Label>
                <div className="grid grid-cols-2 gap-2 mt-2 max-h-48 overflow-y-auto border rounded p-2">
                  {webhookEvents.map((event) => (
                    <label
                      key={event}
                      className="flex items-center gap-2 text-sm cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={webhookForm.events.includes(event)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setWebhookForm({
                              ...webhookForm,
                              events: [...webhookForm.events, event],
                            });
                          } else {
                            setWebhookForm({
                              ...webhookForm,
                              events: webhookForm.events.filter((e) => e !== event),
                            });
                          }
                        }}
                      />
                      {event}
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-6">
              <Button variant="outline" onClick={() => setShowWebhookModal(false)}>
                Cancel
              </Button>
              <Button onClick={createWebhook}>Create Webhook</Button>
            </div>
          </div>
        </div>
      )}

      {/* Create Integration Modal */}
      {showIntegrationModal && selectedIntegrationType && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-background rounded-lg p-6 max-w-lg w-full mx-4">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-lg bg-secondary flex items-center justify-center">
                {integrationIcons[selectedIntegrationType] || (
                  <PlugIcon className="w-5 h-5" />
                )}
              </div>
              <h2 className="text-xl font-semibold capitalize">
                Connect {selectedIntegrationType}
              </h2>
            </div>
            <div className="space-y-4">
              <div>
                <Label>Name</Label>
                <Input
                  value={integrationForm.name}
                  onChange={(e) =>
                    setIntegrationForm({ ...integrationForm, name: e.target.value })
                  }
                  placeholder="My Integration"
                />
              </div>

              {/* Discord webhook URL */}
              {selectedIntegrationType === "discord" && (
                <div>
                  <Label>Webhook URL</Label>
                  <Input
                    value={integrationForm.config.webhookUrl || ""}
                    onChange={(e) =>
                      setIntegrationForm({
                        ...integrationForm,
                        config: { ...integrationForm.config, webhookUrl: e.target.value },
                      })
                    }
                    placeholder="https://discord.com/api/webhooks/..."
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Get this from Discord channel settings &gt; Integrations &gt; Webhooks
                  </p>
                </div>
              )}

              {/* Zapier webhook URL */}
              {selectedIntegrationType === "zapier" && (
                <div>
                  <Label>Webhook URL</Label>
                  <Input
                    value={integrationForm.config.webhookUrl || ""}
                    onChange={(e) =>
                      setIntegrationForm({
                        ...integrationForm,
                        config: { ...integrationForm.config, webhookUrl: e.target.value },
                      })
                    }
                    placeholder="https://hooks.zapier.com/..."
                  />
                </div>
              )}

              {/* Make webhook URL */}
              {selectedIntegrationType === "make" && (
                <div>
                  <Label>Webhook URL</Label>
                  <Input
                    value={integrationForm.config.webhookUrl || ""}
                    onChange={(e) =>
                      setIntegrationForm({
                        ...integrationForm,
                        config: { ...integrationForm.config, webhookUrl: e.target.value },
                      })
                    }
                    placeholder="https://hook.make.com/..."
                  />
                </div>
              )}

              {/* n8n webhook URL */}
              {selectedIntegrationType === "n8n" && (
                <div>
                  <Label>Webhook URL</Label>
                  <Input
                    value={integrationForm.config.webhookUrl || ""}
                    onChange={(e) =>
                      setIntegrationForm({
                        ...integrationForm,
                        config: { ...integrationForm.config, webhookUrl: e.target.value },
                      })
                    }
                    placeholder="https://your-n8n.com/webhook/..."
                  />
                </div>
              )}

              {/* Slack - requires OAuth */}
              {selectedIntegrationType === "slack" && (
                <div className="p-4 bg-secondary/50 rounded-lg">
                  <p className="text-sm text-muted-foreground">
                    Slack integration requires OAuth authentication. Click Connect to authorize
                    WheelsAI to send messages to your Slack workspace.
                  </p>
                </div>
              )}

              {/* GitHub - requires OAuth */}
              {selectedIntegrationType === "github" && (
                <div className="p-4 bg-secondary/50 rounded-lg">
                  <p className="text-sm text-muted-foreground">
                    GitHub integration requires OAuth authentication. Click Connect to authorize
                    WheelsAI to access your repositories.
                  </p>
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 mt-6">
              <Button
                variant="outline"
                onClick={() => {
                  setShowIntegrationModal(false);
                  setSelectedIntegrationType(null);
                }}
              >
                Cancel
              </Button>
              <Button onClick={createIntegration}>Connect</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
