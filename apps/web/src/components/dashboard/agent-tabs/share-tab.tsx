"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, ExternalLink, Plus } from "lucide-react";
import { toast } from "sonner";

import { EmbedSnippet } from "@/components/dashboard/web-channel/embed-snippet";
import { WebChatKeyDialog } from "@/components/dashboard/web-channel/web-chat-key-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  ApiError,
  agentsApi,
  authApi,
  getErrorMessage,
  getValidationError,
  webChannelApi,
  type Agent,
  type AgentDetail,
  type PublicLink,
  type PublicLinkInput,
  type WidgetKey,
  type WidgetKeyList,
} from "@/lib/api";
import {
  DAILY_CAP_MAX,
  DAILY_CAP_MIN,
  PUBLIC_LINK_WORDS,
  addressPrefix,
  codeCard,
  linkView,
  parseDailyCap,
  switchOf,
  websiteCard,
} from "@/lib/agent-share";
import { CHANNELS_WEBSITE_CHAT_HREF } from "@/lib/nav";
import { usageLabel } from "@/lib/web-channel";
import { CopyRow, Snippet } from "./api-tab";

export interface ShareTabProps {
  agent: AgentDetail;
  /** Called after a change the rest of the page should see (the page turned on, a description saved). */
  onAgentChanged?: () => void;
}

const DESCRIPTION_MAX = 300;

const isForbidden = (error: unknown) => error instanceof ApiError && error.status === 403;

const textButton =
  "rounded text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

// ============================================
// The public link
// ============================================

interface LinkCardProps extends ShareTabProps {
  link: PublicLink;
  /** false for a member who may look and not change. */
  canManage: boolean;
  onLink: (link: PublicLink) => void;
  onForbidden: () => void;
}

function PublicLinkCard({ agent, link, canManage, onLink, onForbidden, onAgentChanged }: LinkCardProps) {
  const id = useId();
  const confirm = useConfirm();
  // The description as it is saved, which the link card may have just written.
  const [description, setDescription] = useState(agent.description ?? "");
  const [descriptionDraft, setDescriptionDraft] = useState("");
  const [descriptionError, setDescriptionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingCap, setEditingCap] = useState(false);
  const [capDraft, setCapDraft] = useState("");
  const [capError, setCapError] = useState<string | null>(null);
  const [handleDraft, setHandleDraft] = useState(link.handle ?? "");
  const [handleError, setHandleError] = useState<string | null>(null);

  useEffect(() => setDescription(agent.description ?? ""), [agent.description]);
  useEffect(() => setHandleDraft(link.handle ?? ""), [link.handle]);

  const view = linkView(link, { agentKind: agent.agentKind, description });
  const live = link.state === "on" || link.state === "paused";

  /** One change of the link. Answers the link as it then is, or null when this member may not change it. */
  async function change(what: string, input: PublicLinkInput): Promise<PublicLink | null> {
    setBusy(what);
    setError(null);
    try {
      const next = await agentsApi.setPublicLink(agent.id, input);
      onLink(next);
      return next;
    } catch (err) {
      if (isForbidden(err)) {
        onForbidden();
        return null;
      }
      throw err;
    } finally {
      setBusy(null);
    }
  }

  async function turnOn() {
    setDescriptionError(null);
    setError(null);
    if (view.askDescription) {
      const line = descriptionDraft.trim();
      if (!line) {
        setDescriptionError(PUBLIC_LINK_WORDS.describe);
        return;
      }
      setBusy("on");
      try {
        await agentsApi.update(agent.id, { description: line });
        setDescription(line);
      } catch (err) {
        setBusy(null);
        if (isForbidden(err)) return onForbidden();
        setDescriptionError(getValidationError(err)?.fields.description ?? getErrorMessage(err, "The line could not be saved."));
        return;
      }
    }
    try {
      const next = await change("on", { state: "on" });
      if (next) {
        toast.success("The public link is on");
        onAgentChanged?.();
      }
    } catch (err) {
      setError(getErrorMessage(err, "The link could not be turned on."));
      // The description may have been saved even so.
      if (view.askDescription) onAgentChanged?.();
    }
  }

  async function pause() {
    try {
      if (await change("pause", { state: "paused" })) toast.success("The public link is paused");
    } catch (err) {
      setError(getErrorMessage(err, "The link could not be paused."));
    }
  }

  async function turnOff() {
    const ok = await confirm({
      title: "Turn the public link off?",
      description:
        "The page stops opening for everyone who has the link. Its address is kept, so turning the link on again brings the same page back.",
      confirmLabel: "Turn link off",
      destructive: true,
    });
    if (!ok) return;
    try {
      if (await change("off", { state: "off" })) {
        toast.success("The public link is off");
        onAgentChanged?.();
      }
    } catch (err) {
      setError(getErrorMessage(err, "The link could not be turned off."));
    }
  }

  async function saveCap(event: React.FormEvent) {
    event.preventDefault();
    const parsed = parseDailyCap(capDraft);
    if (!parsed.ok) {
      setCapError(parsed.message);
      return;
    }
    setCapError(null);
    try {
      if (await change("cap", { state: switchOf(link.state), dailyCap: parsed.value })) setEditingCap(false);
    } catch (err) {
      setCapError(getValidationError(err)?.fields.dailyCap ?? getErrorMessage(err, "The limit could not be saved."));
    }
  }

  async function setShowResults(showResults: boolean) {
    try {
      if (await change("results", { state: switchOf(link.state), showResults })) onAgentChanged?.();
    } catch (err) {
      setError(getErrorMessage(err, "That could not be saved."));
    }
  }

  async function saveHandle(event: React.FormEvent) {
    event.preventDefault();
    setHandleError(null);
    try {
      if (await change("handle", { state: switchOf(link.state), handle: handleDraft })) {
        toast.success("The address was changed");
        onAgentChanged?.();
      }
    } catch (err) {
      // The server says why: taken, reserved, or not a name an address can have.
      setHandleError(getValidationError(err)?.fields.handle ?? getErrorMessage(err, "The address could not be changed."));
    }
  }

  const statusVariant = link.state === "on" ? "success" : link.state === "paused" ? "warning" : "secondary";

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-3">
          <CardTitle className="text-base">Public link</CardTitle>
          {view.status && <Badge variant={statusVariant}>{view.status}</Badge>}
        </div>
        <CardDescription>{view.sentence}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {link.state !== "off" &&
          (link.url ? (
            <div className="space-y-2">
              <CopyRow label="Link" value={link.url} />
              <a
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className={`inline-flex items-center gap-1 text-sm ${textButton}`}
              >
                Open
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                <span className="sr-only">the public page in a new tab</span>
              </a>
            </div>
          ) : (
            link.handle && (
              <p className="rounded-md border border-dashed bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                {PUBLIC_LINK_WORDS.addressUnavailable} The page is at <code>/a/{link.handle}</code> on WheelsAI.
              </p>
            )
          ))}

        {view.capLine && (
          <div className="space-y-2 text-sm">
            <p className="text-foreground">
              {view.capLine}{" "}
              {canManage && !editingCap && (
                <button
                  type="button"
                  className={textButton}
                  onClick={() => {
                    setCapDraft(String(link.dailyCap));
                    setCapError(null);
                    setEditingCap(true);
                  }}
                >
                  {PUBLIC_LINK_WORDS.change}
                </button>
              )}
            </p>
            {editingCap && canManage && (
              <form onSubmit={saveCap} className="flex flex-wrap items-start gap-2" noValidate>
                <div className="w-40">
                  <Label htmlFor={`${id}-cap`} className="sr-only">
                    Uses a day
                  </Label>
                  <Input
                    id={`${id}-cap`}
                    type="number"
                    inputMode="numeric"
                    min={DAILY_CAP_MIN}
                    max={DAILY_CAP_MAX}
                    step={1}
                    value={capDraft}
                    onChange={(event) => setCapDraft(event.target.value)}
                    aria-describedby={capError ? `${id}-cap-error` : undefined}
                    aria-invalid={capError ? true : undefined}
                    autoFocus
                  />
                </div>
                <Button type="submit" size="sm" className="h-10" isLoading={busy === "cap"}>
                  Save
                </Button>
                <Button type="button" size="sm" variant="ghost" className="h-10" onClick={() => setEditingCap(false)}>
                  Cancel
                </Button>
                {capError && (
                  <p id={`${id}-cap-error`} role="alert" className="w-full text-sm text-danger">
                    {capError}
                  </p>
                )}
              </form>
            )}
            {view.usedLine && <p className="text-muted-foreground">{view.usedLine}</p>}
          </div>
        )}

        {view.toolsLine && <p className="text-sm text-muted-foreground">{view.toolsLine}</p>}

        {view.offerShowResults && (
          <div className="flex items-center justify-between gap-4 rounded-lg border px-4 py-3">
            <Label htmlFor={`${id}-results`} className="text-sm font-normal text-foreground">
              {PUBLIC_LINK_WORDS.showResults}
            </Label>
            <Switch
              id={`${id}-results`}
              checked={link.showResults}
              onCheckedChange={(checked) => void setShowResults(checked)}
              disabled={!canManage || busy !== null}
            />
          </div>
        )}

        {canManage && view.askDescription && (
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-description`}>{PUBLIC_LINK_WORDS.describe}</Label>
            <Input
              id={`${id}-description`}
              value={descriptionDraft}
              maxLength={DESCRIPTION_MAX}
              placeholder="Answers questions about our opening hours and prices"
              onChange={(event) => {
                setDescriptionDraft(event.target.value);
                setDescriptionError(null);
              }}
              aria-describedby={descriptionError ? `${id}-description-error` : `${id}-description-hint`}
              aria-invalid={descriptionError ? true : undefined}
            />
            {descriptionError ? (
              <p id={`${id}-description-error`} role="alert" className="text-sm text-danger">
                {descriptionError}
              </p>
            ) : (
              <p id={`${id}-description-hint`} className="text-xs text-muted-foreground">
                It shows under the agent's name on its public page. Visitors never see its instructions.
              </p>
            )}
          </div>
        )}

        {error && (
          <p role="alert" className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}

        {canManage ? (
          <div className="flex flex-wrap items-center gap-3">
            {link.state === "off" ? (
              <div className="flex items-center gap-3">
                <Switch
                  id={`${id}-switch`}
                  checked={false}
                  onCheckedChange={() => void turnOn()}
                  disabled={busy !== null}
                  aria-label={view.turnOnLabel}
                />
                <Label htmlFor={`${id}-switch`} className="text-sm font-normal text-foreground">
                  {busy === "on" ? "Turning the link on" : view.turnOnLabel}
                </Label>
              </div>
            ) : (
              view.actions.map((action) =>
                action === "turn_on" ? (
                  <Button key={action} onClick={() => void turnOn()} isLoading={busy === "on"} disabled={busy !== null}>
                    {view.turnOnLabel}
                  </Button>
                ) : action === "pause" ? (
                  <Button
                    key={action}
                    variant="outline"
                    onClick={() => void pause()}
                    isLoading={busy === "pause"}
                    disabled={busy !== null}
                  >
                    Pause link
                  </Button>
                ) : (
                  <Button
                    key={action}
                    variant="ghost"
                    onClick={() => void turnOff()}
                    isLoading={busy === "off"}
                    disabled={busy !== null}
                  >
                    Turn link off
                  </Button>
                ),
              )
            )}
          </div>
        ) : (
          <p className="rounded-md border border-dashed bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            {PUBLIC_LINK_WORDS.membersOnly}
          </p>
        )}

        {canManage && (
          <details className="rounded-lg border px-4 py-3">
            <summary className="cursor-pointer rounded text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              Advanced
            </summary>
            <form onSubmit={saveHandle} className="mt-4 space-y-2" noValidate>
              <Label htmlFor={`${id}-handle`}>Address</Label>
              <div className="flex flex-wrap items-start gap-2">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="max-w-[50%] shrink-0 truncate font-mono text-xs text-muted-foreground" aria-hidden="true">
                    {addressPrefix(link)}
                  </span>
                  <Input
                    id={`${id}-handle`}
                    value={handleDraft}
                    maxLength={40}
                    spellCheck={false}
                    autoCapitalize="none"
                    autoCorrect="off"
                    className="font-mono"
                    onChange={(event) => {
                      setHandleDraft(event.target.value);
                      setHandleError(null);
                    }}
                    aria-describedby={handleError ? `${id}-handle-error` : `${id}-handle-hint`}
                    aria-invalid={handleError ? true : undefined}
                  />
                </div>
                <Button
                  type="submit"
                  variant="outline"
                  isLoading={busy === "handle"}
                  disabled={busy !== null || handleDraft === "" || handleDraft === (link.handle ?? "")}
                >
                  Save address
                </Button>
              </div>
              {handleError ? (
                <p id={`${id}-handle-error`} role="alert" className="text-sm text-danger">
                  {handleError}
                </p>
              ) : (
                <p id={`${id}-handle-hint`} className="text-xs text-muted-foreground">
                  3 to 40 lower-case letters, digits and hyphens. Links you already shared stop working when the address
                  changes.
                </p>
              )}
            </form>
          </details>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================
// On a website
// ============================================

/** The agent's own website keys with their snippets; made and edited in the Channels dialog. */
function ChatBoxKeys({ agent }: { agent: AgentDetail }) {
  const [list, setList] = useState<WidgetKeyList | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<WidgetKey | null>(null);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const keys = await webChannelApi.listKeys({ agentId: agent.id });
      if (mounted.current) setList(keys);
    } catch (error) {
      if (mounted.current) setLoadError(error);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [agent.id]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  const replace = (key: WidgetKey) =>
    setList((current) => {
      if (!current) return current;
      const known = current.keys.some((existing) => existing.id === key.id);
      return { ...current, keys: known ? current.keys.map((k) => (k.id === key.id ? key : k)) : [key, ...current.keys] };
    });

  // The dialog picks from a list of agents; here there is one.
  const agents: Agent[] = [{ ...agent, latestDeployment: null }];
  // The key of the public page is the link above, not a snippet for a site.
  const keys = (list?.keys ?? []).filter((key) => key.pageOfAgentId === null);

  if (loading) {
    return (
      <div className="space-y-3" aria-busy="true">
        <span className="sr-only">Loading the chat box snippet</span>
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }
  if (loadError !== null) {
    return <ErrorState title="Couldn't load the chat box" error={loadError} onRetry={() => void load()} />;
  }

  return (
    <div className="space-y-4">
      {keys.length === 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed px-4 py-3">
          <p className="min-w-0 text-sm text-muted-foreground">No chat box yet. Create a key to get the snippet for your site.</p>
          <Button
            size="sm"
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
          >
            <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
            Create a chat box
          </Button>
        </div>
      ) : (
        <>
          <ul className="space-y-4">
            {keys.map((key) => (
              <li key={key.id} className="space-y-2 rounded-lg border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="break-words font-medium text-foreground">{key.name}</span>
                    <Badge variant={key.enabled ? "success" : "secondary"}>{key.enabled ? "Live" : "Paused"}</Badge>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setEditing(key);
                      setDialogOpen(true);
                    }}
                  >
                    Edit
                    <span className="sr-only"> {key.name}</span>
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {usageLabel(key.usageToday, key.dailyMessageCap, list?.defaults.dailyMessageCap ?? 0)}
                  {" · "}
                  {key.allowedOrigins.length === 0
                    ? "No sites allowed yet"
                    : `Allowed on ${key.allowedOrigins.join(", ")}`}
                </p>
                <EmbedSnippet snippet={key.snippet} unavailableReason={key.snippetUnavailableReason} />
              </li>
            ))}
          </ul>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
          >
            <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
            Another chat box
          </Button>
        </>
      )}
      <p className="text-sm text-muted-foreground">
        Paste the snippet before <code>&lt;/body&gt;</code>.{" "}
        <Link href={CHANNELS_WEBSITE_CHAT_HREF} className={textButton}>
          Preview, rotate or revoke a key in Channels
        </Link>
      </p>

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

function WebsiteCardView({ agent, link }: { agent: AgentDetail; link: PublicLink | null }) {
  const card = websiteCard(agent, link);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{card.title}</CardTitle>
        <CardDescription>{card.description}</CardDescription>
      </CardHeader>
      <CardContent>
        {card.type === "chat_box" ? (
          <ChatBoxKeys agent={agent} />
        ) : card.snippet ? (
          <div className="space-y-2">
            <Snippet code={card.snippet} />
            <p className="text-sm text-muted-foreground">Paste it where the button should show, and style it as you like.</p>
          </div>
        ) : (
          <p className="rounded-md border border-dashed bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            {card.unavailable}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================
// Use from code
// ============================================

function CodeCardView({ agent }: { agent: AgentDetail }) {
  const card = codeCard(agent);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{card.title}</CardTitle>
        <CardDescription>{card.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {card.rows.map((row) => (
          <CopyRow key={row.label} label={row.label} value={row.value} />
        ))}
        {card.note && (
          <p className="rounded-md border border-dashed bg-muted/40 px-3 py-2 text-sm text-muted-foreground">{card.note}</p>
        )}
        {card.snippet && <Snippet code={card.snippet} />}
        <p className="text-sm text-muted-foreground">
          {card.webhookLine && (
            <>
              {card.webhookLine}{" "}
              <Link href="/dashboard/integrations" className={textButton}>
                Set up a webhook
              </Link>
              .{" "}
            </>
          )}
          Authenticate with an API key as <code>Authorization: Bearer …</code>.{" "}
          <Link href="/dashboard/keys" className={textButton}>
            Create or manage API keys
          </Link>
          .{" "}
          <Link href="/docs/api/agents" className={textButton}>
            Read the API reference
          </Link>
          .
        </p>
      </CardContent>
    </Card>
  );
}

// ============================================
// The tab
// ============================================

/** Where people reach this agent: its public link, a website, and code. */
export function ShareTab({ agent, onAgentChanged }: ShareTabProps) {
  const [link, setLink] = useState<PublicLink | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  // Only an owner or admin may change the link. Assumed until the server says otherwise.
  const [canManage, setCanManage] = useState(true);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const next = await agentsApi.getPublicLink(agent.id);
      if (mounted.current) setLink(next);
    } catch (error) {
      if (mounted.current) setLoadError(error);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [agent.id]);

  useEffect(() => {
    mounted.current = true;
    void load();
    // Secondary: when it cannot be read, a refused change says the same thing later.
    authApi
      .listOrgs()
      .then(({ organizations }) => {
        const role = organizations.find((organization) => organization.current)?.role;
        if (mounted.current && role && role !== "owner" && role !== "admin") setCanManage(false);
      })
      .catch(() => undefined);
    return () => {
      mounted.current = false;
    };
  }, [load]);

  return (
    <div className="space-y-6">
      {loading ? (
        <Card aria-busy="true">
          <CardHeader>
            <span className="sr-only">Loading the public link</span>
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-4 w-full max-w-xl" />
          </CardHeader>
          <CardContent className="space-y-3">
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-10 w-40" />
          </CardContent>
        </Card>
      ) : loadError !== null || !link ? (
        <ErrorState title="Couldn't load the public link" error={loadError ?? undefined} onRetry={() => void load()} />
      ) : (
        <PublicLinkCard
          agent={agent}
          link={link}
          canManage={canManage}
          onLink={setLink}
          onForbidden={() => setCanManage(false)}
          onAgentChanged={onAgentChanged}
        />
      )}

      <WebsiteCardView agent={agent} link={link} />
      <CodeCardView agent={agent} />

      <Link
        href={CHANNELS_WEBSITE_CHAT_HREF}
        className="flex items-center justify-between gap-4 rounded-lg border bg-card px-5 py-4 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="min-w-0">
          <span className="block text-sm font-medium text-foreground">More places</span>
          <span className="block text-sm text-muted-foreground">
            Chat apps, webhooks and every website key are in Channels.
          </span>
        </span>
        <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </Link>
    </div>
  );
}
