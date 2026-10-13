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
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { SkeletonTable } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { API_BASE_URL, apiKeysApi, type ApiKey, getErrorMessage } from "@/lib/api";
import {
  ORDINARY_SCOPES,
  SPEND_SCOPES,
  describeKeyAccess,
  dollarsToCents,
  describeKeyCaps,
  formatCents,
  keyGrantProblem,
  keySpendDayNote,
  keySpentTodayLine,
  type ScopeOption,
} from "@/lib/jobs";
import { unifiedApiSnippets } from "@/lib/public-urls";

// Built once from the API origin this app talks to.
const usage = unifiedApiSnippets(API_BASE_URL);

type AccessChoice = "all" | "limited";

function ScopeCheckbox({
  option,
  checked,
  onChange,
}: {
  option: ScopeOption;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = `scope-${option.scope.replace(":", "-")}`;
  return (
    <div className="flex items-start gap-3">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-4 w-4 rounded border-border accent-primary"
        aria-describedby={`${id}-hint`}
      />
      <div>
        <label htmlFor={id} className="text-sm font-medium text-foreground">
          {option.label} <code className="ml-1 text-xs font-normal text-muted-foreground">{option.scope}</code>
        </label>
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {option.description}
        </p>
      </div>
    </div>
  );
}

export default function ApiKeysPage() {
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<string | null>(null);
  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(new Set());
  const confirmAction = useConfirm();
  // What the new key may do. Nothing is preselected: the person creating a
  // key chooses its access, and spending is never part of "everything".
  const [access, setAccess] = useState<AccessChoice | null>(null);
  const [scopes, setScopes] = useState<string[]>([]);
  const [maxJobPrice, setMaxJobPrice] = useState("");
  const [maxUsePrice, setMaxUsePrice] = useState("");
  const [dailySpendCap, setDailySpendCap] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  function toggleScope(scope: string, on: boolean) {
    setScopes((current) => (on ? [...new Set([...current, scope])] : current.filter((s) => s !== scope)));
  }

  function resetCreateForm() {
    setShowCreateForm(false);
    setNewKeyName("");
    setAccess(null);
    setScopes([]);
    setMaxJobPrice("");
    setMaxUsePrice("");
    setDailySpendCap("");
    setCreateError(null);
  }

  const spendChosen = SPEND_SCOPES.filter((option) => scopes.includes(option.scope));
  const canHire = scopes.includes("jobs:hire");
  const canUse = scopes.includes("agents:use");

  async function loadApiKeys() {
    setIsLoading(true);
    setLoadError(null);
    try {
      const data = await apiKeysApi.list();
      setApiKeys(data?.apiKeys ?? []);
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to load API keys"));
      setApiKeys([]);
      setLoadError(error);
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadApiKeys();
  }, []);

  async function handleCreateKey() {
    setCreateError(null);
    if (!newKeyName.trim()) {
      setCreateError("Give the key a name.");
      return;
    }
    if (access === null) {
      setCreateError("Choose what this key can do.");
      return;
    }
    const ordinary = scopes.filter((scope) => ORDINARY_SCOPES.some((option) => option.scope === scope));
    const spend = spendChosen.map((option) => option.scope);
    if (access === "limited" && ordinary.length + spend.length === 0) {
      setCreateError("Choose at least one thing this key can do.");
      return;
    }
    const problem = keyGrantProblem({ scopes: spend, maxJobPrice, maxUsePrice, dailySpendCap });
    if (problem) {
      setCreateError(problem);
      return;
    }
    // "All except spending" is "*"; spend scopes are always listed by name.
    const granted = [...(access === "all" ? ["*"] : ordinary), ...spend];
    const caps =
      canHire || canUse
        ? {
            ...(canHire ? { maxJobPriceCents: dollarsToCents(maxJobPrice)! } : {}),
            ...(canUse ? { maxUsePriceCents: dollarsToCents(maxUsePrice)! } : {}),
            dailySpendCapCents: dollarsToCents(dailySpendCap)!,
          }
        : undefined;

    if (spend.length > 0) {
      const ok = await confirmAction({
        title: "Create a key that can spend?",
        description: caps
          ? `Anyone holding this key can spend your credits${
              caps.maxJobPriceCents !== undefined ? `: up to ${formatCents(caps.maxJobPriceCents)} on a job` : ""
            }${
              caps.maxUsePriceCents !== undefined
                ? `${caps.maxJobPriceCents !== undefined ? " and" : ":"} up to ${formatCents(caps.maxUsePriceCents)} on one use of a paid agent`
                : ""
            }, and ${formatCents(caps.dailySpendCapCents)} a day in all. A refund does not give the day's allowance back.`
          : "Anyone holding this key can move your organization's money with it. Keep it as safe as a password.",
        confirmLabel: "Create spending key",
      });
      if (!ok) return;
    }

    setIsCreating(true);
    try {
      const { apiKey, key } = await apiKeysApi.create(newKeyName.trim(), granted, caps);
      setNewlyCreatedKey(key);
      setApiKeys([apiKey, ...apiKeys]);
      setNewKeyName("");
      toast.success("API key created successfully");
    } catch (error) {
      setCreateError(getErrorMessage(error, "Failed to create API key"));
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
      toast.error(getErrorMessage(error, "Failed to revoke API key"));
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
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted">
            <Key className="h-4 w-4 text-muted-foreground" />
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
          <code className="text-sm text-muted-foreground">
            {visibleKeys.has(apiKey.id)
              ? apiKey.keyPrefix + "••••••••"
              : maskKey(apiKey.keyPrefix)}
          </code>
          <button
            onClick={(e) => {
              e.stopPropagation();
              toggleKeyVisibility(apiKey.id);
            }}
            className="text-gray-400 hover:text-foreground"
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
      render: (apiKey) => {
        const { summary, spends } = describeKeyAccess(apiKey.scopes);
        const listed = (apiKey.scopes ?? []).filter((scope) => scope !== "*" && !spends.includes(scope));
        return (
          <div className="flex flex-wrap items-center gap-1">
            {summary === "All except spending" ? (
              <span className="text-sm text-muted-foreground">All except spending</span>
            ) : (
              listed.map((scope) => (
                <Badge key={scope} variant="secondary" className="text-[10px]">
                  {scope}
                </Badge>
              ))
            )}
            {spends.map((scope) => (
              <Badge key={scope} variant="warning" className="text-[10px]">
                {scope}
              </Badge>
            ))}
          </div>
        );
      },
    },
    {
      key: "spendCaps",
      header: "Spend caps",
      render: (apiKey) => {
        const caps = describeKeyCaps(apiKey);
        // What the key spent today against its daily cap. Nothing for a key that cannot pay, and
        // nothing when the day's spend could not be read.
        const spentToday = keySpentTodayLine(apiKey);
        return caps ? (
          <div className="whitespace-nowrap text-sm">
            <p className="text-foreground">{caps}</p>
            {spentToday && <p className="text-xs text-muted-foreground">{spentToday}</p>}
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">Cannot hire</span>
        );
      },
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
        <span className="text-sm text-muted-foreground">
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
        <span className="text-sm text-muted-foreground">
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
            className="text-red-500 hover:bg-red-500/10 hover:text-red-600"
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

  // Which day "today" is, said once under the list and only when a key shows what it spent.
  const spendDayNote = keySpendDayNote(apiKeys);

  return (
    <div className="flex flex-col">
      <Header
        title="API keys"
        description="Manage your API keys for accessing WheelsAI endpoints"
      />

      <div className="p-8">
        {/* Create new key section */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="text-base">Create New API Key</CardTitle>
            <CardDescription>
              A key acts for your whole organization. Choose what it can do; a key never spends unless you grant
              that by name.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {newlyCreatedKey ? (
              <div className="space-y-4">
                <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-4">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="h-5 w-5 text-yellow-600 dark:text-yellow-500" />
                    <div>
                      <p className="font-medium text-yellow-500">
                        Save your API key now
                      </p>
                      <p className="mt-1 text-sm text-yellow-500">
                        This is the only time you&apos;ll see this key. Store it securely.
                      </p>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <code className="flex-1 rounded-lg bg-muted px-4 py-3 text-sm font-mono text-foreground">
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
                    resetCreateForm();
                  }}
                >
                  Done
                </Button>
              </div>
            ) : showCreateForm ? (
              <div className="space-y-6">
                <div className="max-w-md">
                  <Label htmlFor="key-name">Key name</Label>
                  <Input
                    id="key-name"
                    value={newKeyName}
                    onChange={(e) => setNewKeyName(e.target.value)}
                    placeholder="e.g., Production, Development, CI/CD"
                    className="mt-1"
                    maxLength={100}
                  />
                </div>

                <fieldset>
                  <legend className="text-sm font-medium text-foreground">What this key can do</legend>
                  <div className="mt-2 grid gap-3 sm:grid-cols-2">
                    {(
                      [
                        {
                          value: "all",
                          title: "All except spending",
                          body: "Everything your organization can do through the API, except hiring, accepting, rejecting and installing.",
                        },
                        {
                          value: "limited",
                          title: "Only what I choose",
                          body: "Pick the scopes below. The key can do nothing else.",
                        },
                      ] as const
                    ).map((choice) => (
                      <label
                        key={choice.value}
                        className={`flex cursor-pointer gap-3 rounded-lg border p-3 ${
                          access === choice.value ? "border-primary bg-primary/10" : "border-border hover:bg-muted"
                        }`}
                      >
                        <input
                          type="radio"
                          name="key-access"
                          value={choice.value}
                          checked={access === choice.value}
                          onChange={() => setAccess(choice.value)}
                          className="mt-1 h-4 w-4 accent-primary"
                        />
                        <span>
                          <span className="block text-sm font-medium text-foreground">{choice.title}</span>
                          <span className="block text-xs text-muted-foreground">{choice.body}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>

                {access === "limited" && (
                  <fieldset className="space-y-3">
                    <legend className="text-sm font-medium text-foreground">Scopes</legend>
                    {ORDINARY_SCOPES.map((option) => (
                      <ScopeCheckbox
                        key={option.scope}
                        option={option}
                        checked={scopes.includes(option.scope)}
                        onChange={(on) => toggleScope(option.scope, on)}
                      />
                    ))}
                  </fieldset>
                )}

                {access !== null && (
                  <fieldset className="space-y-3 rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-4">
                    <legend className="px-1 text-sm font-medium text-foreground">Spending (off unless ticked)</legend>
                    <p className="text-xs text-muted-foreground">
                      These move your organization&apos;s money. Only an owner or admin can create a key with any of
                      them.
                    </p>
                    {SPEND_SCOPES.map((option) => (
                      <ScopeCheckbox
                        key={option.scope}
                        option={option}
                        checked={scopes.includes(option.scope)}
                        onChange={(on) => toggleScope(option.scope, on)}
                      />
                    ))}
                    {(canHire || canUse) && (
                      <div className="grid gap-4 pt-2 sm:grid-cols-2">
                        {canHire && (
                          <div>
                            <Label htmlFor="key-max-job">Most one job may cost (USD)</Label>
                            <Input
                              id="key-max-job"
                              className="mt-1"
                              inputMode="decimal"
                              value={maxJobPrice}
                              onChange={(e) => setMaxJobPrice(e.target.value)}
                              placeholder="5.00"
                            />
                          </div>
                        )}
                        {canUse && (
                          <div>
                            <Label htmlFor="key-max-use">The most one use may cost (USD)</Label>
                            <Input
                              id="key-max-use"
                              className="mt-1"
                              inputMode="decimal"
                              value={maxUsePrice}
                              onChange={(e) => setMaxUsePrice(e.target.value)}
                              placeholder="0.50"
                            />
                          </div>
                        )}
                        <div>
                          <Label htmlFor="key-daily-cap">
                            {canHire ? "Most it may spend in a day (USD)" : "The most this key may spend in a day (USD)"}
                          </Label>
                          <Input
                            id="key-daily-cap"
                            className="mt-1"
                            inputMode="decimal"
                            value={dailySpendCap}
                            onChange={(e) => setDailySpendCap(e.target.value)}
                            placeholder="20.00"
                            aria-describedby="key-daily-cap-hint"
                          />
                          <p id="key-daily-cap-hint" className="mt-1 text-xs text-muted-foreground">
                            {canHire && canUse
                              ? "A day is a UTC day. Hiring and using paid agents share it, and both prices are required."
                              : canUse
                                ? "A day is a UTC day. Both caps are required for a key that can use paid agents."
                                : "A day is a UTC day. Both caps are required for a key that can hire."}
                          </p>
                        </div>
                      </div>
                    )}
                  </fieldset>
                )}

                {createError && (
                  <p role="alert" className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
                    {createError}
                  </p>
                )}

                <div className="flex gap-3">
                  <Button onClick={handleCreateKey} isLoading={isCreating}>
                    Create Key
                  </Button>
                  <Button variant="outline" onClick={resetCreateForm} disabled={isCreating}>
                    Cancel
                  </Button>
                </div>
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
              <div aria-busy="true">
                <SkeletonTable rows={3} cols={7} />
                <span className="sr-only">Loading API keys</span>
              </div>
            ) : loadError !== null ? (
              <ErrorState
                title="Couldn't load API keys"
                error={loadError}
                onRetry={loadApiKeys}
              />
            ) : apiKeys.length === 0 ? (
              <EmptyState
                icon={Key}
                title="No API keys yet"
                description="Create your first API key to start making requests."
                actionLabel={showCreateForm ? undefined : "Create New Key"}
                onAction={showCreateForm ? undefined : () => setShowCreateForm(true)}
              />
            ) : (
              <>
                <DataTable
                  data={apiKeys}
                  columns={keyColumns}
                  pageSize={10}
                  keyExtractor={(apiKey) => apiKey.id}
                />
                {spendDayNote && <p className="mt-3 text-xs text-muted-foreground">{spendDayNote}</p>}
              </>
            )}
          </CardContent>
        </Card>

        {/* Usage example */}
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="text-base">Usage Example</CardTitle>
            <CardDescription>
              One OpenAI-compatible base URL serves your agents, your workflows and your model deployments.{" "}
              <code>model</code> picks which: <code>agent/&lt;slug&gt;</code> for an agent,{" "}
              <code>workflow/&lt;slug&gt;</code> for a workflow, or the slug of a running deployment.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <pre className="overflow-x-auto rounded-lg bg-gray-900 p-4 text-sm text-gray-100">
              {usage.curl}
            </pre>
            <pre className="overflow-x-auto rounded-lg bg-gray-900 p-4 text-sm text-gray-100">
              {usage.python}
            </pre>
            <p className="text-sm text-muted-foreground">
              A chat completion counts as one API call on your plan. Listing models and other reads are free.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
