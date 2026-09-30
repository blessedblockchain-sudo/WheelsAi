"use client";

import { useEffect, useMemo, useState } from "react";
import { KeyRound, Plus, Save, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ModelSelector } from "@/components/dashboard/model-selector";
import { agentsApi, getErrorMessage, knowledgeApi, type KnowledgeBase } from "@/lib/api";
import type { AgentTabProps } from "./types";

/** The API returns secret names only (values are write-only). */
function secretKeys(env: unknown): string[] {
  if (env && typeof env === "object" && Array.isArray((env as { keys?: unknown }).keys)) {
    return (env as { keys: string[] }).keys;
  }
  return [];
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function SettingsTab({ agent, agentId, loadAgent }: AgentTabProps) {
  const router = useRouter();

  const initial = useMemo(
    () => ({
      name: agent.name,
      description: agent.description ?? "",
      systemPrompt: agent.systemPrompt ?? "",
      model: agent.modelConfig?.externalModel ?? agent.modelConfig?.modelId ?? "",
      temperature: String(agent.modelConfig?.temperature ?? 0.7),
      maxTokens: String(agent.modelConfig?.maxTokens ?? 4096),
      tags: (agent.tags ?? []).join(", "),
      isPublic: agent.isPublic,
      knowledgeBaseId: (agent as { knowledgeBaseId?: string | null }).knowledgeBaseId ?? "",
    }),
    [agent]
  );
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);

  // Secrets: existing names from the API, plus pending sets and deletes.
  const existingKeys = secretKeys(agent.env);
  const [secretSets, setSecretSets] = useState<Array<{ key: string; value: string }>>([]);
  const [secretDeletes, setSecretDeletes] = useState<string[]>([]);

  useEffect(() => setForm(initial), [initial]);
  useEffect(() => {
    knowledgeApi
      .list({ limit: 100 })
      .then((res) => setKnowledgeBases(res.knowledgeBases))
      .catch(() => setKnowledgeBases([]));
  }, []);

  const update = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const dirty =
    JSON.stringify(form) !== JSON.stringify(initial) || secretSets.length > 0 || secretDeletes.length > 0;

  async function handleSave() {
    const temperature = Number(form.temperature);
    const maxTokens = Number(form.maxTokens);
    if (form.name.trim().length < 3) return toast.error("Name must be at least 3 characters");
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      return toast.error("Temperature must be between 0 and 2");
    }
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 32768) {
      return toast.error("Max tokens must be a whole number from 1 to 32768");
    }
    const badKey = secretSets.find((s) => !ENV_KEY.test(s.key) || !s.value);
    if (badKey) {
      return toast.error(
        badKey.value ? `"${badKey.key}" is not a valid variable name` : `Enter a value for ${badKey.key || "the new variable"}`
      );
    }

    const env: Record<string, string | null> = {};
    for (const key of secretDeletes) env[key] = null;
    for (const { key, value } of secretSets) env[key] = value;

    // Send only what changed, so an untouched prompt is not re-versioned.
    const changes: Record<string, unknown> = {};
    if (form.name !== initial.name) changes.name = form.name.trim();
    if (form.description !== initial.description) changes.description = form.description;
    if (form.systemPrompt !== initial.systemPrompt) changes.systemPrompt = form.systemPrompt;
    if (form.model !== initial.model || form.temperature !== initial.temperature || form.maxTokens !== initial.maxTokens) {
      changes.modelConfig = { ...agent.modelConfig, externalModel: form.model || undefined, temperature, maxTokens };
    }
    if (form.tags !== initial.tags) {
      changes.tags = form.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
    }
    if (form.isPublic !== initial.isPublic) changes.isPublic = form.isPublic;
    if (form.knowledgeBaseId !== initial.knowledgeBaseId) changes.knowledgeBaseId = form.knowledgeBaseId || null;
    if (Object.keys(env).length > 0) changes.env = env;

    setSaving(true);
    try {
      await agentsApi.update(agentId, changes as Parameters<typeof agentsApi.update>[1]);
      setSecretSets([]);
      setSecretDeletes([]);
      toast.success("Settings saved");
      await loadAgent();
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to save settings"));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    await agentsApi.delete(agentId);
    toast.success("Agent deleted");
    router.push("/dashboard/agents");
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">General</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="agent-name">Name</Label>
              <Input id="agent-name" value={form.name} onChange={(e) => update("name", e.target.value)} maxLength={100} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="agent-tags">Tags</Label>
              <Input
                id="agent-tags"
                value={form.tags}
                onChange={(e) => update("tags", e.target.value)}
                placeholder="research, support"
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="agent-description">Description</Label>
            <Textarea
              id="agent-description"
              value={form.description}
              onChange={(e) => update("description", e.target.value)}
              maxLength={500}
              rows={2}
            />
          </div>
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <p className="text-sm font-medium">Public agent page</p>
              <p className="text-xs text-muted-foreground">
                Shows the agent&apos;s public page and on-chain track record at /a/{agent.slug}.
              </p>
            </div>
            <Switch checked={form.isPublic} onCheckedChange={(v) => update("isPublic", v)} aria-label="Public agent page" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Behaviour</CardTitle>
          <CardDescription>What the agent is told, which model answers, and what it grounds on.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="agent-prompt">System prompt</Label>
            <Textarea
              id="agent-prompt"
              value={form.systemPrompt}
              onChange={(e) => update("systemPrompt", e.target.value)}
              maxLength={10000}
              rows={8}
              className="font-mono text-sm"
            />
            <p className="text-right text-xs text-muted-foreground tabular-nums">
              {form.systemPrompt.length.toLocaleString()} / 10,000
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2 md:col-span-3">
              <Label>Model</Label>
              <ModelSelector agentId={agentId} value={form.model} onChange={(v) => update("model", v)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="agent-temperature">Temperature</Label>
              <Input
                id="agent-temperature"
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={form.temperature}
                onChange={(e) => update("temperature", e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="agent-max-tokens">Max tokens</Label>
              <Input
                id="agent-max-tokens"
                type="number"
                min={1}
                max={32768}
                step={1}
                value={form.maxTokens}
                onChange={(e) => update("maxTokens", e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="agent-kb">Knowledge base</Label>
              <Select id="agent-kb" value={form.knowledgeBaseId} onChange={(e) => update("knowledgeBaseId", e.target.value)}>
                <option value="">None</option>
                {knowledgeBases.map((kb) => (
                  <option key={kb.id} value={kb.id}>
                    {kb.name}
                  </option>
                ))}
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="h-4 w-4" />
            Environment variables
          </CardTitle>
          <CardDescription>
            Encrypted at rest and never shown again after saving. Marketplace buyers never receive them.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {existingKeys.length === 0 && secretSets.length === 0 && (
            <p className="text-sm text-muted-foreground">No variables set.</p>
          )}
          {existingKeys.map((key) => {
            const deleting = secretDeletes.includes(key);
            return (
              <div key={key} className="flex items-center justify-between rounded-lg border px-3 py-2">
                <span className={deleting ? "font-mono text-sm text-muted-foreground line-through" : "font-mono text-sm"}>
                  {key}
                </span>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">{deleting ? "will be removed" : "set"}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setSecretDeletes((d) => (deleting ? d.filter((k) => k !== key) : [...d, key]))
                    }
                  >
                    {deleting ? "Keep" : "Remove"}
                  </Button>
                </div>
              </div>
            );
          })}
          {secretSets.map((row, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                placeholder="NAME"
                value={row.key}
                onChange={(e) =>
                  setSecretSets((s) => s.map((r, j) => (j === i ? { ...r, key: e.target.value.trim() } : r)))
                }
                className="font-mono"
                aria-label="Variable name"
              />
              <Input
                type="password"
                placeholder={existingKeys.includes(row.key) ? "New value (replaces the current one)" : "Value"}
                value={row.value}
                onChange={(e) => setSecretSets((s) => s.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
                aria-label="Variable value"
                autoComplete="off"
              />
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setSecretSets((s) => s.filter((_, j) => j !== i))}
                aria-label="Discard this variable"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={() => setSecretSets((s) => [...s, { key: "", value: "" }])}>
            <Plus className="mr-2 h-4 w-4" />
            Add or replace a variable
          </Button>
        </CardContent>
      </Card>

      <div className="flex justify-end gap-2">
        <Button
          variant="outline"
          disabled={!dirty || saving}
          onClick={() => {
            setForm(initial);
            setSecretSets([]);
            setSecretDeletes([]);
          }}
        >
          Discard changes
        </Button>
        <Button onClick={handleSave} disabled={!dirty} isLoading={saving}>
          <Save className="mr-2 h-4 w-4" />
          Save settings
        </Button>
      </div>

      <Card className="border-red-500/30">
        <CardHeader>
          <CardTitle className="text-base text-red-600">Danger Zone</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">Delete Agent</p>
              <p className="text-sm text-muted-foreground">Permanently delete this agent and all its deployments</p>
            </div>
            <ConfirmDialog
              title="Delete this agent?"
              description="Its deployments are stopped and it cannot be recovered."
              confirmLabel="Delete agent"
              destructive
              onConfirm={handleDelete}
            >
              <Button variant="destructive">
                <Trash2 className="mr-2 h-4 w-4" />
                Delete Agent
              </Button>
            </ConfirmDialog>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
