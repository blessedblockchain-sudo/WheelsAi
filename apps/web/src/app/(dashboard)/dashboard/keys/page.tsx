"use client";

import { useEffect, useState } from "react";
import { Key, Plus, Copy, Trash2, Eye, EyeOff, AlertTriangle } from "lucide-react";
import { toast } from "sonner";

import { Header } from "@/components/dashboard/header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataTable, type Column } from "@/components/ui/data-table";
import { apiKeysApi, type ApiKey } from "@/lib/api";

export default function ApiKeysPage() {
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<string | null>(null);
  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(new Set());

  async function loadApiKeys() {
    try {
      const data = await apiKeysApi.list();
      setApiKeys(data?.apiKeys ?? []);
    } catch (error) {
      toast.error("Failed to load API keys");
      setApiKeys([]);
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadApiKeys();
  }, []);

  async function handleCreateKey() {
    if (!newKeyName.trim()) {
      toast.error("Please enter a name for the API key");
      return;
    }

    setIsCreating(true);
    try {
      const { apiKey, key } = await apiKeysApi.create(newKeyName);
      setNewlyCreatedKey(key);
      setApiKeys([apiKey, ...apiKeys]);
      setNewKeyName("");
      toast.success("API key created successfully");
    } catch (error) {
      toast.error("Failed to create API key");
    } finally {
      setIsCreating(false);
    }
  }

  async function handleRevokeKey(id: string) {
    try {
      await apiKeysApi.revoke(id);
      setApiKeys(apiKeys.filter((k) => k.id !== id));
      toast.success("API key revoked");
    } catch (error) {
      toast.error("Failed to revoke API key");
    }
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
    toast.success("Copied to clipboard");
  }

  function toggleKeyVisibility(id: string) {
    const newVisible = new Set(visibleKeys);
    if (newVisible.has(id)) {
      newVisible.delete(id);
    } else {
      newVisible.add(id);
    }
    setVisibleKeys(newVisible);
  }

  function maskKey(key: string): string {
    if (key.length <= 8) return "••••••••";
    return key.slice(0, 4) + "••••••••" + key.slice(-4);
  }

  const keyColumns: Column<ApiKey>[] = [
    {
      key: "name",
      header: "Name",
      sortable: true,
      render: (apiKey) => (
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gray-100 dark:bg-gray-800">
            <Key className="h-4 w-4 text-gray-600 dark:text-gray-400" />
          </div>
          <span className="font-medium">{apiKey.name}</span>
        </div>
      ),
    },
    {
      key: "keyPrefix",
      header: "Key",
      render: (apiKey) => (
        <div className="flex items-center gap-2">
          <code className="text-sm text-gray-500 dark:text-gray-400">
            {visibleKeys.has(apiKey.id)
              ? apiKey.keyPrefix + "••••••••"
              : maskKey(apiKey.keyPrefix)}
          </code>
          <button
            onClick={(e) => {
              e.stopPropagation();
              toggleKeyVisibility(apiKey.id);
            }}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
          >
            {visibleKeys.has(apiKey.id) ? (
              <EyeOff className="h-4 w-4" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
          </button>
        </div>
      ),
    },
    {
      key: "scopes",
      header: "Scopes",
      render: (apiKey) =>
        apiKey.scopes && apiKey.scopes.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {apiKey.scopes.map((scope) => (
              <Badge key={scope} variant="secondary" className="text-[10px]">
                {scope}
              </Badge>
            ))}
          </div>
        ) : (
          <span className="text-sm text-gray-400 dark:text-gray-500">All</span>
        ),
    },
    {
      key: "status",
      header: "Status",
      render: (apiKey) => (
        <Badge variant={apiKey.status === "active" ? "success" : "destructive"}>
          {apiKey.status}
        </Badge>
      ),
    },
    {
      key: "lastUsedAt",
      header: "Last Used",
      sortable: true,
      render: (apiKey) => (
        <span className="text-sm text-gray-500 dark:text-gray-400">
          {apiKey.lastUsedAt
            ? new Date(apiKey.lastUsedAt).toLocaleDateString()
            : "Never"}
        </span>
      ),
    },
    {
      key: "createdAt",
      header: "Created",
      sortable: true,
      render: (apiKey) => (
        <span className="text-sm text-gray-500 dark:text-gray-400">
          {new Date(apiKey.createdAt).toLocaleDateString()}
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      className: "w-12",
      render: (apiKey) =>
        apiKey.status === "active" ? (
          <Button
            variant="ghost"
            size="icon"
            className="text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 hover:text-red-600"
            onClick={(e) => {
              e.stopPropagation();
              handleRevokeKey(apiKey.id);
            }}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="flex flex-col">
      <Header
        title="API Keys"
        description="Manage your API keys for accessing WheelsAI endpoints"
      />

      <div className="p-8">
        {/* Create new key section */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="text-base">Create New API Key</CardTitle>
            <CardDescription>
              API keys are used to authenticate requests to your deployed models
            </CardDescription>
          </CardHeader>
          <CardContent>
            {newlyCreatedKey ? (
              <div className="space-y-4">
                <div className="rounded-lg border border-yellow-200 dark:border-yellow-800 bg-yellow-50 dark:bg-yellow-950/30 p-4">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="h-5 w-5 text-yellow-600 dark:text-yellow-500" />
                    <div>
                      <p className="font-medium text-yellow-800 dark:text-yellow-200">
                        Save your API key now
                      </p>
                      <p className="mt-1 text-sm text-yellow-700 dark:text-yellow-300">
                        This is the only time you&apos;ll see this key. Store it securely.
                      </p>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <code className="flex-1 rounded-lg bg-gray-100 dark:bg-gray-800 px-4 py-3 text-sm font-mono text-gray-900 dark:text-gray-100">
                    {newlyCreatedKey}
                  </code>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => copyToClipboard(newlyCreatedKey)}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>

                <Button
                  variant="outline"
                  onClick={() => {
                    setNewlyCreatedKey(null);
                    setShowCreateForm(false);
                  }}
                >
                  Done
                </Button>
              </div>
            ) : showCreateForm ? (
              <div className="flex items-end gap-4">
                <div className="flex-1">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Key Name
                  </label>
                  <Input
                    value={newKeyName}
                    onChange={(e) => setNewKeyName(e.target.value)}
                    placeholder="e.g., Production, Development, CI/CD"
                    className="mt-1"
                  />
                </div>
                <Button onClick={handleCreateKey} isLoading={isCreating}>
                  Create Key
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setShowCreateForm(false);
                    setNewKeyName("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Button onClick={() => setShowCreateForm(true)}>
                <Plus className="mr-2 h-4 w-4" />
                Create New Key
              </Button>
            )}
          </CardContent>
        </Card>

        {/* API Keys table */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Your API Keys</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="h-16 animate-pulse rounded-lg bg-gray-200 dark:bg-gray-800" />
                ))}
              </div>
            ) : (
              <DataTable
                data={apiKeys}
                columns={keyColumns}
                pageSize={10}
                emptyMessage="No API keys yet. Create your first API key to start making requests."
                keyExtractor={(apiKey) => apiKey.id}
              />
            )}
          </CardContent>
        </Card>

        {/* Usage example */}
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="text-base">Usage Example</CardTitle>
            <CardDescription>
              Use your API key to authenticate requests to your deployed models
            </CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="overflow-x-auto rounded-lg bg-gray-900 p-4 text-sm text-gray-100">
{`curl https://api.wheelsai.io/v1/your-deployment/chat/completions \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 100
  }'`}
            </pre>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
