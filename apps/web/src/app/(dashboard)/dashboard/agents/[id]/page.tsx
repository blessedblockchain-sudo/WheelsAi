"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Bot, RefreshCw, Copy, ChevronDown } from "lucide-react";
import { toast } from "sonner";

import { Header } from "@/components/dashboard/header";
import { AgentChat } from "@/components/dashboard/agent-chat";
import { AgentKindBadge } from "@/components/dashboard/agent-kind-badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { agentsApi, ApiError, type AgentDetail, getErrorMessage } from "@/lib/api";
import { frameworkLabel } from "@/lib/agent-list";
import {
  AGENT_ADVANCED_LABEL,
  AGENT_ADVANCED_STORAGE_KEY,
  AGENT_MORE_LABEL,
  AGENT_TAB_PARAM,
  agentCarriesCode,
  agentMoreLinks,
  buildAgentTabs,
  firstTabOf,
  initialAdvanced,
  resolveTab,
  storedAdvanced,
  type AgentTabId,
} from "@/lib/agent-tabs";
import { cn } from "@/lib/utils";
import {
  OverviewTab,
  ApiTab,
  GpuTab,
  VersionsTab,
  CodeTab,
  LogsTab,
  SettingsTab,
  RunTab,
  RunsTab,
  SellTab,
  ShareTab,
} from "@/components/dashboard/agent-tabs";

const frameworkColors: Record<string, string> = {
  mastra: "bg-purple-500/10 text-purple-500",
  langchain: "bg-green-500/10 text-green-500",
  autogen: "bg-blue-500/10 text-blue-500",
  custom: "bg-muted text-foreground",
};

const statusColors: Record<string, "success" | "warning" | "destructive" | "secondary"> = {
  running: "success",
  building: "warning",
  deploying: "warning",
  pending: "secondary",
  stopped: "secondary",
  failed: "destructive",
};

/** Tabs drawn in the placeholder: the four everyone sees. */
const SKELETON_TABS = 4;

/**
 * The API answers 404 for an agent outside this workspace and 400 for an id
 * that is not a UUID. Both mean there is no such agent, so the page says so
 * rather than offering a retry that cannot succeed.
 */
function isMissingAgent(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.status === 400);
}

/** Placeholder in the shape of the loaded page: status bar, tab bar, the first tab's cards. */
function AgentDetailSkeleton() {
  return (
    <div className="p-4 sm:p-8" aria-busy="true">
      <Card className="mb-6">
        <CardContent className="py-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <Skeleton className="h-12 w-12 rounded-lg" />
              <div className="space-y-2">
                <Skeleton className="h-5 w-44" />
                <Skeleton className="h-4 w-64" />
              </div>
            </div>
            <div className="flex gap-2">
              {["w-28", "w-24", "w-10"].map((width, i) => (
                <Skeleton key={i} className={cn("h-10", width)} />
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="mb-6 flex gap-2 overflow-hidden border-b">
        {Array.from({ length: SKELETON_TABS }).map((_, i) => (
          <div key={i} className="border-b-2 border-transparent px-4 py-2">
            <Skeleton className="h-5 w-16" />
          </div>
        ))}
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <Card key={i}>
            <CardHeader>
              <Skeleton className="h-5 w-32" />
            </CardHeader>
            <CardContent className="space-y-4">
              {Array.from({ length: 4 }).map((_, j) => (
                <div key={j} className="space-y-2">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-5 w-40" />
                </div>
              ))}
            </CardContent>
          </Card>
        ))}
        <Card className="md:col-span-2">
          <CardHeader>
            <Skeleton className="h-5 w-32" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-24 w-full" />
          </CardContent>
        </Card>
      </div>
      <span className="sr-only">Loading agent</span>
    </div>
  );
}

export default function AgentDetailPage() {
  // The open tab is read from the address, which needs a Suspense boundary.
  return (
    <Suspense
      fallback={
        <div className="flex flex-col">
          <Header title="Loading..." />
          <AgentDetailSkeleton />
        </div>
      }
    >
      <AgentDetailView />
    </Suspense>
  );
}

function AgentDetailView() {
  const params = useParams();
  const agentId = params.id as string;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);

  // The tab the address asks for. Kept here too, so a click shows its tab at
  // once and the address follows.
  const [requestedTab, setRequestedTab] = useState<string | null>(() => searchParams.get(AGENT_TAB_PARAM));
  useEffect(() => {
    setRequestedTab(searchParams.get(AGENT_TAB_PARAM));
  }, [searchParams]);

  // What is remembered for the Advanced switch: "on", "off", or nothing yet.
  const [rememberedAdvanced, setRememberedAdvanced] = useState<string | null>(null);
  useEffect(() => {
    try {
      setRememberedAdvanced(window.localStorage.getItem(AGENT_ADVANCED_STORAGE_KEY));
    } catch {
      // Storage is blocked: the switch starts where it starts for this agent.
    }
  }, []);

  // Also the background refresh from the tabs: a failed refresh keeps the
  // agent on screen (toast only); loadError replaces the page only while no
  // agent has loaded yet.
  const loadAgent = useCallback(async () => {
    try {
      const { agent } = await agentsApi.get(agentId);
      setAgent(agent);
      setLoadError(null);
    } catch (error) {
      setLoadError(error);
      toast.error(getErrorMessage(error, "Failed to load agent"));
    } finally {
      setIsLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    loadAgent();
  }, [loadAgent]);

  /** "Try again" on the error state: back to the skeleton while it reloads. */
  function retryLoad() {
    setLoadError(null);
    setIsLoading(true);
    void loadAgent();
  }

  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Could not copy. Select the text and copy it by hand.");
    }
  }

  const hasCode = agent ? agentCarriesCode(agent) : false;
  const agentKind = agent?.agentKind;
  const resolved = useMemo(
    () =>
      resolveTab(requestedTab, {
        agentKind,
        hasCode,
        advanced: initialAdvanced(rememberedAdvanced, hasCode),
      }),
    [requestedTab, agentKind, hasCode, rememberedAdvanced]
  );
  const advanced = resolved.advanced;
  const activeTab = resolved.tab;
  const turnOnAdvanced = resolved.turnOnAdvanced;
  // A link to an advanced tab turns the switch on, and it stays on (and is
  // remembered) while the person moves between tabs afterwards.
  useEffect(() => {
    if (!agent || !turnOnAdvanced) return;
    const value = storedAdvanced(true);
    setRememberedAdvanced(value);
    try {
      window.localStorage.setItem(AGENT_ADVANCED_STORAGE_KEY, value);
    } catch {
      // Storage is blocked: the switch still stays on for this visit.
    }
  }, [agent, turnOnAdvanced]);
  const tabs = useMemo(() => buildAgentTabs({ agentKind, hasCode, advanced }), [agentKind, hasCode, advanced]);

  const tabRefs = useRef<Partial<Record<AgentTabId, HTMLButtonElement | null>>>({});
  // On a phone the bar scrolls inside itself: keep the open tab in view.
  useEffect(() => {
    tabRefs.current[activeTab]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTab, tabs.length]);

  function selectTab(id: AgentTabId) {
    const first = firstTabOf(agentKind);
    setRequestedTab(id === first ? null : id);
    const next = new URLSearchParams(searchParams.toString());
    if (id === first) next.delete(AGENT_TAB_PARAM);
    else next.set(AGENT_TAB_PARAM, id);
    const query = next.toString();
    router.replace(`${pathname}${query ? `?${query}` : ""}`, { scroll: false });
  }

  function setAdvanced(next: boolean) {
    const value = storedAdvanced(next);
    setRememberedAdvanced(value);
    try {
      window.localStorage.setItem(AGENT_ADVANCED_STORAGE_KEY, value);
    } catch {
      // Storage is blocked: the switch still works for this visit.
    }
    // The open tab is an advanced one and they are being put away: open the first tab.
    if (!next && tabs.find((tab) => tab.id === activeTab)?.advanced) selectTab(firstTabOf(agentKind));
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let to = -1;
    if (event.key === "ArrowRight") to = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") to = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") to = 0;
    else if (event.key === "End") to = tabs.length - 1;
    if (to < 0) return;
    event.preventDefault();
    const target = tabs[to]!;
    selectTab(target.id);
    tabRefs.current[target.id]?.focus();
  }

  if (isLoading) {
    return (
      <div className="flex flex-col">
        <Header title="Loading..." />
        <AgentDetailSkeleton />
      </div>
    );
  }

  if (!agent) {
    if (loadError !== null && !isMissingAgent(loadError)) {
      return (
        <div className="flex flex-col">
          <Header title="Agent" />
          <div className="p-4 sm:p-8">
            <ErrorState
              title="Couldn't load agent"
              error={loadError}
              onRetry={retryLoad}
              actionLabel="Back to Agents"
              actionHref="/dashboard/agents"
            />
          </div>
        </div>
      );
    }

    return (
      <div className="flex flex-col">
        <Header title="Agent Not Found" />
        <div className="p-4 sm:p-8">
          <EmptyState
            icon={Bot}
            title="Agent not found"
            description="There's no agent with this ID in your workspace."
            actionLabel="Back to Agents"
            actionHref="/dashboard/agents"
          />
        </div>
      </div>
    );
  }

  const latestDeployment = agent.deployments?.[0];
  const panelId = "agent-tab-panel";
  // The tab this agent opens on stays mounted while another tab is open, so a
  // conversation or a result is still there after a visit to Share or Settings.
  const firstTab = firstTabOf(agentKind);

  return (
    <div className="flex min-w-0 flex-col">
      <Header title={agent.name} description={agent.description || undefined} />

      <div className="min-w-0 p-4 sm:p-8">
        {/* Status bar */}
        <Card className="mb-6">
          <CardContent className="py-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex min-w-0 items-center gap-4">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-primary/15">
                  <Bot className="h-6 w-6 text-primary" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <AgentKindBadge kind={agent.agentKind} />
                    {hasCode && (
                      <span
                        className={cn(
                          "rounded px-2 py-0.5 text-xs font-medium",
                          frameworkColors[agent.framework] ?? frameworkColors.custom
                        )}
                      >
                        {frameworkLabel(agent.framework)}
                      </span>
                    )}
                    {advanced && <span className="text-sm text-muted-foreground">v{agent.version}</span>}
                    {latestDeployment && (
                      <Badge variant={statusColors[latestDeployment.status]}>{latestDeployment.status}</Badge>
                    )}
                  </div>
                  {/* The agent's /v1 endpoint is served by the platform API
                      whether or not a deployment is running. */}
                  {advanced &&
                    (agent.apiEndpoint ? (
                      <div className="mt-1 flex min-w-0 items-center gap-2">
                        <code className="min-w-0 break-all text-sm text-muted-foreground">{agent.apiEndpoint}</code>
                        <button
                          type="button"
                          onClick={() => copyToClipboard(agent.apiEndpoint!)}
                          aria-label="Copy API endpoint"
                          className="shrink-0 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <Copy className="h-4 w-4 text-muted-foreground hover:text-foreground" aria-hidden="true" />
                        </button>
                      </div>
                    ) : (
                      <p className="mt-1 text-sm text-muted-foreground">Endpoint address unavailable right now</p>
                    ))}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2">
                  <Switch
                    id="agent-advanced"
                    checked={advanced}
                    onCheckedChange={setAdvanced}
                    aria-labelledby="agent-advanced-label"
                  />
                  <label
                    id="agent-advanced-label"
                    htmlFor="agent-advanced"
                    className="cursor-pointer text-sm font-medium text-foreground"
                  >
                    {AGENT_ADVANCED_LABEL}
                  </label>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline">
                      {AGENT_MORE_LABEL}
                      <ChevronDown className="ml-2 h-4 w-4" aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-[11rem]">
                    {agentMoreLinks(agentId).map((link) => (
                      <DropdownMenuItem key={link.id} asChild>
                        <Link href={link.href}>{link.label}</Link>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button variant="outline" size="icon" onClick={loadAgent} aria-label="Refresh">
                  <RefreshCw className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Tabs: the bar scrolls sideways inside itself, never the page. */}
        <div className="mb-6 max-w-full overflow-x-auto border-b">
          <div role="tablist" aria-label="Agent" className="flex w-max min-w-full gap-1 sm:gap-2">
            {tabs.map((tab, index) => {
              const selected = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  ref={(node) => {
                    tabRefs.current[tab.id] = node;
                  }}
                  type="button"
                  role="tab"
                  id={`agent-tab-${tab.id}`}
                  aria-selected={selected}
                  aria-controls={panelId}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => selectTab(tab.id)}
                  onKeyDown={(event) => onTabKeyDown(event, index)}
                  className={cn(
                    "shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-4",
                    selected
                      ? "border-primary text-primary"
                      : "border-transparent text-muted-foreground hover:text-foreground"
                  )}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Tab content */}
        <div id={panelId} role="tabpanel" aria-labelledby={`agent-tab-${activeTab}`} className="min-w-0">
          {(firstTab === "chat" || activeTab === "chat") && (
            <div hidden={activeTab !== "chat"}>
              <Card className="overflow-hidden">
                <AgentChat
                  key={agent.id}
                  agentId={agentId}
                  agent={agent}
                  hideName
                  className="h-[calc(100vh-20rem)] min-h-[28rem]"
                />
              </Card>
            </div>
          )}
          {(firstTab === "run" || activeTab === "run") && (
            <div hidden={activeTab !== "run"}>
              <RunTab key={agent.id} agent={agent} onEditQuestions={() => selectTab("settings")} />
            </div>
          )}
          {(activeTab === "runs" || activeTab === "schedule") && <RunsTab agent={agent} />}
          {activeTab === "share" && <ShareTab agent={agent} onAgentChanged={loadAgent} />}
          {activeTab === "sell" && <SellTab agent={agent} />}
          {activeTab === "settings" && <SettingsTab agent={agent} agentId={agentId} loadAgent={loadAgent} />}
          {activeTab === "api" && <ApiTab agent={agent} agentId={agentId} loadAgent={loadAgent} />}
          {activeTab === "versions" && <VersionsTab agent={agent} agentId={agentId} loadAgent={loadAgent} />}
          {activeTab === "code" && <CodeTab agent={agent} agentId={agentId} loadAgent={loadAgent} />}
          {activeTab === "logs" && <LogsTab agent={agent} agentId={agentId} loadAgent={loadAgent} />}
          {activeTab === "gpu" && <GpuTab agent={agent} agentId={agentId} loadAgent={loadAgent} />}
          {activeTab === "overview" && <OverviewTab agent={agent} agentId={agentId} loadAgent={loadAgent} />}
        </div>
      </div>
    </div>
  );
}
