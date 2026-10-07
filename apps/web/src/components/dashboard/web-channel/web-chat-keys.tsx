"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Eye, EyeOff, MessageSquare, Pencil, Plus, RotateCw, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  API_BASE_URL,
  agentsApi,
  getErrorMessage,
  openclawApi,
  webChannelApi,
  type Agent,
  type OpenClawDeployment,
  type WidgetKey,
  type WidgetKeyList,
} from "@/lib/api";
import { LIVE_CHAT_CHANNELS, chatChannelLabel } from "@/lib/chat-channels";
import { usageLabel } from "@/lib/web-channel";
import { EmbedSnippet } from "./embed-snippet";
import { WebChatKeyDialog } from "./web-chat-key-dialog";

declare global {
  interface Window {
    WheelsAI?: { loaded: boolean; open(): void; close(): void; reset(): void; destroy(): void };
  }
}

const PREVIEW_SCRIPT_ID = "wheelsai-widget-preview";

/** Takes the preview widget off this page, if one is on it. */
function removePreview() {
  window.WheelsAI?.destroy();
  document.getElementById(PREVIEW_SCRIPT_ID)?.remove();
}

function KeysSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true">
      <span className="sr-only">Loading web chat keys</span>
      {[0, 1].map((row) => (
        <div key={row} className="space-y-3 rounded-lg border p-4">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-4 w-72" />
          <Skeleton className="h-9 w-full" />
        </div>
      ))}
    </div>
  );
}

/**
 * The Channels tab: web chat keys (create, limit, embed, preview, rotate,
 * revoke) and where the other live channels are managed.
 */
export function WebChatKeys() {
  const confirm = useConfirm();
  const [list, setList] = useState<WidgetKeyList | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  // The other channels live on OpenClaw deployments. null = could not be read.
  const [deployments, setDeployments] = useState<OpenClawDeployment[] | null>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<WidgetKey | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [keys, agentList] = await Promise.all([webChannelApi.listKeys(), agentsApi.list()]);
      if (!mounted.current) return;
      setList(keys);
      setAgents(agentList.agents);
      // Secondary: the keys still show when this fails, and the summary says so.
      openclawApi
        .listDeployments()
        .then((res) => mounted.current && setDeployments(res.deployments))
        .catch(() => mounted.current && setDeployments(null));
    } catch (error) {
      if (mounted.current) setLoadError(error);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      // The preview belongs to this tab, not to the rest of the dashboard.
      removePreview();
    };
  }, [load]);

  const replace = (key: WidgetKey) =>
    setList((current) => {
      if (!current) return current;
      const known = current.keys.some((existing) => existing.id === key.id);
      return { ...current, keys: known ? current.keys.map((k) => (k.id === key.id ? key : k)) : [key, ...current.keys] };
    });

  function stopPreview() {
    removePreview();
    setPreviewing(null);
  }

  function preview(key: WidgetKey) {
    removePreview();
    // The same file a customer's site loads, with this page as the host.
    // The dashboard's origin is always allowed, so a key with no sites yet
    // can still be tried here.
    const script = document.createElement("script");
    script.id = PREVIEW_SCRIPT_ID;
    script.src = "/widget.js";
    script.async = true;
    script.setAttribute("data-wheelsai-key", key.publicKey);
    script.setAttribute("data-api", API_BASE_URL);
    script.onload = () => window.WheelsAI?.open();
    script.onerror = () => {
      toast.error("The widget script could not be loaded from this site.");
      stopPreview();
    };
    document.body.appendChild(script);
    setPreviewing(key.id);
  }

  async function toggle(key: WidgetKey) {
    try {
      const { key: updated } = await webChannelApi.updateKey(key.id, { enabled: !key.enabled });
      replace(updated);
      if (!updated.enabled && previewing === key.id) stopPreview();
    } catch (error) {
      toast.error(getErrorMessage(error, "The key could not be changed."));
    }
  }

  async function rotate(key: WidgetKey) {
    const ok = await confirm({
      title: `Rotate "${key.name}"?`,
      description:
        "The key gets a new value. Every page that carries the current snippet stops showing a working chat until you paste the new one.",
      confirmLabel: "Rotate key",
      destructive: true,
    });
    if (!ok) return;
    try {
      const { key: rotated } = await webChannelApi.rotateKey(key.id);
      replace(rotated);
      if (previewing === key.id) stopPreview();
      toast.success("Key rotated. Copy the new snippet into your site.");
    } catch (error) {
      toast.error(getErrorMessage(error, "The key could not be rotated."));
    }
  }

  async function revoke(key: WidgetKey) {
    const ok = await confirm({
      title: `Revoke "${key.name}"?`,
      description: "The chat stops working everywhere this key is embedded. This cannot be undone.",
      confirmLabel: "Revoke key",
      destructive: true,
    });
    if (!ok) return;
    try {
      await webChannelApi.revokeKey(key.id);
      setList((current) => (current ? { ...current, keys: current.keys.filter((k) => k.id !== key.id) } : current));
      if (previewing === key.id) stopPreview();
      toast.success("Key revoked");
    } catch (error) {
      toast.error(getErrorMessage(error, "The key could not be revoked."));
    }
  }

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  const otherChannels = LIVE_CHAT_CHANNELS.filter((platform) => platform !== "web");

  return (
    <div className="space-y-10">
      <section className="space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold">Web chat</h2>
            <p className="text-sm text-muted-foreground">
              Put an agent on your own site as a chat widget. Create a key, list the sites that may use it, and paste
              the snippet before <code>&lt;/body&gt;</code>.{" "}
              <Link href="/docs/guides/web-chat-widget" className="text-primary underline-offset-4 hover:underline">
                Read the guide
              </Link>
            </p>
          </div>
          {!loading && loadError === null && agents.length > 0 && (
            <Button onClick={openCreate}>
              <Plus className="mr-2 h-4 w-4" />
              New key
            </Button>
          )}
        </div>

        {loading ? (
          <KeysSkeleton />
        ) : loadError !== null ? (
          <ErrorState title="Couldn't load your web chat keys" error={loadError} onRetry={() => void load()} />
        ) : agents.length === 0 ? (
          <EmptyState
            icon={MessageSquare}
            title="Create an agent first"
            description="A web chat key belongs to an agent. Once you have one, you can put it on your site."
            actionLabel="Create an agent"
            actionHref="/dashboard/agents/new"
          />
        ) : !list || list.keys.length === 0 ? (
          <EmptyState
            icon={MessageSquare}
            title="No web chat keys yet"
            description="Create a key to get the snippet for your site. Visitors chat with your agent; tools that spend, write, read saved files or send requests out are withheld from them."
            actionLabel="New key"
            onAction={openCreate}
          />
        ) : (
          <ul className="space-y-4">
            {list.keys.map((key) => (
              <li key={key.id} className="space-y-4 rounded-lg border bg-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-foreground">{key.name}</span>
                      <span
                        className={`rounded px-2 py-0.5 text-xs ${
                          key.enabled ? "bg-success/10 text-success" : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {key.enabled ? "Live" : "Paused"}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Agent: {key.agentName} · {usageLabel(key.usageToday, key.dailyMessageCap, list.defaults.dailyMessageCap)}
                      {" · "}
                      {key.lastUsedAt ? `Last used ${new Date(key.lastUsedAt).toLocaleString()}` : "Not used yet"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground" id={`enabled-${key.id}`}>
                      {key.enabled ? "On" : "Off"}
                    </span>
                    <Switch
                      checked={key.enabled}
                      onCheckedChange={() => void toggle(key)}
                      aria-labelledby={`enabled-${key.id}`}
                      aria-label={`${key.enabled ? "Pause" : "Resume"} ${key.name}`}
                    />
                  </div>
                </div>

                <div>
                  <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Allowed sites</h3>
                  {key.allowedOrigins.length === 0 ? (
                    <p className="mt-1 text-sm text-muted-foreground">
                      None yet. Only the preview on this dashboard works until you add your site.
                    </p>
                  ) : (
                    <ul className="mt-1 flex flex-wrap gap-1">
                      {key.allowedOrigins.map((origin) => (
                        <li key={origin} className="rounded bg-secondary px-2 py-0.5 font-mono text-xs">
                          {origin}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div>
                  <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Snippet</h3>
                  <EmbedSnippet snippet={key.snippet} unavailableReason={key.snippetUnavailableReason} />
                </div>

                <div className="flex flex-wrap gap-2">
                  {previewing === key.id ? (
                    <Button variant="outline" size="sm" onClick={stopPreview}>
                      <EyeOff className="mr-2 h-4 w-4" />
                      Stop preview
                    </Button>
                  ) : (
                    <Button variant="outline" size="sm" onClick={() => preview(key)} disabled={!key.enabled}>
                      <Eye className="mr-2 h-4 w-4" />
                      Preview here
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setEditing(key);
                      setDialogOpen(true);
                    }}
                  >
                    <Pencil className="mr-2 h-4 w-4" />
                    Edit
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => void rotate(key)}>
                    <RotateCw className="mr-2 h-4 w-4" />
                    Rotate
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => void revoke(key)}>
                    <Trash2 className="mr-2 h-4 w-4" />
                    Revoke
                  </Button>
                </div>
                {previewing === key.id && (
                  <p className="text-xs text-muted-foreground" role="status">
                    The widget is open in the corner of this page. Messages you send in the preview are real: they
                    count toward this key's daily cap and your plan.
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-xl font-semibold">{otherChannels.map(chatChannelLabel).join(", ")}</h2>
          <p className="text-sm text-muted-foreground">
            These channels are connected on an OpenClaw deployment, with the bot token from each platform.
          </p>
        </div>
        {deployments === null ? (
          <p className="rounded-lg border border-dashed px-4 py-3 text-sm text-muted-foreground">
            Your OpenClaw deployments could not be loaded, so their channels are not listed here.{" "}
            <Link href="/dashboard/openclaw" className="text-primary underline-offset-4 hover:underline">
              Open OpenClaw
            </Link>
          </p>
        ) : (
          (() => {
            const rows = deployments
              .map((deployment) => ({
                deployment,
                channels: deployment.channels.filter((channel) =>
                  (otherChannels as readonly string[]).includes(channel.platform),
                ),
              }))
              .filter((row) => row.channels.length > 0);
            if (rows.length === 0) {
              return (
                <p className="rounded-lg border border-dashed px-4 py-3 text-sm text-muted-foreground">
                  No deployment has one of these channels yet.{" "}
                  <Link href="/dashboard/openclaw" className="text-primary underline-offset-4 hover:underline">
                    Set one up in OpenClaw
                  </Link>
                </p>
              );
            }
            return (
              <ul className="space-y-2">
                {rows.map(({ deployment, channels }) => (
                  <li key={deployment.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4">
                    <div>
                      <div className="font-medium text-foreground">{deployment.agentName}</div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {channels.map((channel) => (
                          <span key={channel.id} className="rounded bg-secondary px-2 py-0.5 text-xs">
                            {chatChannelLabel(channel.platform)}
                            {channel.enabled ? "" : " (off)"}
                          </span>
                        ))}
                      </div>
                    </div>
                    <Link
                      href={`/dashboard/openclaw/${deployment.id}`}
                      className="text-sm text-primary underline-offset-4 hover:underline"
                    >
                      Manage
                    </Link>
                  </li>
                ))}
              </ul>
            );
          })()
        )}
      </section>

      <WebChatKeyDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
        agents={agents}
        defaultDailyCap={list?.defaults.dailyMessageCap ?? 0}
        whiteLabel={list?.whiteLabel ?? false}
        onSaved={replace}
      />
    </div>
  );
}
