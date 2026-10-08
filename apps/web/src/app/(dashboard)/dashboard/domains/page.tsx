"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bot, Box, Globe, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";

import {
  NotConfiguredBanner,
  PlanBanner,
  StateChip,
} from "@/components/dashboard/domains/domain-parts";
import {
  certificateState,
  DEFAULT_POLICY,
  domainAllowanceHint,
  ownershipState,
  routingState,
  servingState,
} from "@/components/dashboard/domains/domain-model";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Stat } from "@/components/ui/stat";
import { Switch } from "@/components/ui/switch";
import {
  agentsApi,
  deploymentsApi,
  domainsApi,
  getErrorMessage,
  type CustomDomain,
  type DomainsConfig,
  type DomainStats,
} from "@/lib/api";

interface Target {
  id: string;
  name: string;
}

const EMPTY_FORM = { domain: "", targetType: "agent" as "agent" | "deployment", targetId: "" };

/** Placeholder shaped like the stats row and three domain rows. */
function DomainsSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="space-y-2 rounded-lg border border-border bg-card p-4">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-7 w-10" />
          </div>
        ))}
      </div>
      <div className="divide-y divide-border rounded-lg border border-border bg-card">
        {[1, 2, 3].map((i) => (
          <div key={i} className="flex items-center justify-between p-5">
            <div className="space-y-2">
              <Skeleton className="h-5 w-56" />
              <Skeleton className="h-4 w-80" />
            </div>
            <Skeleton className="h-9 w-40" />
          </div>
        ))}
      </div>
    </div>
  );
}

export default function DomainsPage() {
  const confirmAction = useConfirm();
  const router = useRouter();
  const [config, setConfig] = useState<DomainsConfig | null>(null);
  const [stats, setStats] = useState<DomainStats | null>(null);
  const [domains, setDomains] = useState<CustomDomain[]>([]);
  const [agents, setAgents] = useState<Target[]>([]);
  const [deployments, setDeployments] = useState<Target[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  // After the first good load a failed refresh keeps the list on screen.
  const hasLoadedRef = useRef(false);

  async function loadData() {
    try {
      const [configRes, statsRes, domainsRes] = await Promise.all([
        domainsApi.getConfig(),
        domainsApi.getStats(),
        domainsApi.getDomains({ limit: 100 }),
      ]);
      setConfig(configRes.data);
      setStats(statsRes.data);
      setDomains(domainsRes.data.domains);
      hasLoadedRef.current = true;
      setLoadError(null);
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to load domains"));
      if (!hasLoadedRef.current) setLoadError(error);
    } finally {
      setIsLoading(false);
    }
  }

  // Only names for the rows and the "add" form; the list works without them.
  async function loadTargets() {
    const [agentsRes, deploymentsRes] = await Promise.allSettled([agentsApi.list(), deploymentsApi.list()]);
    if (agentsRes.status === "fulfilled") setAgents(agentsRes.value.agents);
    if (deploymentsRes.status === "fulfilled") setDeployments(deploymentsRes.value.deployments);
  }

  useEffect(() => {
    loadData();
    loadTargets();
  }, []);

  function retryLoad() {
    setLoadError(null);
    setIsLoading(true);
    loadData();
    loadTargets();
  }

  const canManage = Boolean(config?.configured && config.plan.entitled);
  const policy = config?.policy ?? DEFAULT_POLICY;
  const now = Date.now();
  const targets = form.targetType === "agent" ? agents : deployments;

  function targetName(domain: CustomDomain): string {
    const list = domain.targetType === "agent" ? agents : deployments;
    return list.find((t) => t.id === domain.targetId)?.name ?? `${domain.targetId.slice(0, 8)}…`;
  }

  async function createDomain() {
    if (!form.domain.trim() || !form.targetId) return;
    setCreating(true);
    try {
      const { data } = await domainsApi.createDomain({
        domain: form.domain.trim(),
        targetType: form.targetType,
        targetId: form.targetId,
      });
      setShowAdd(false);
      setForm(EMPTY_FORM);
      // The next thing to do is publish the DNS records, which the detail page shows.
      router.push(`/dashboard/domains/${data.id}`);
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not add the domain"));
    } finally {
      setCreating(false);
    }
  }

  async function checkNow(domain: CustomDomain) {
    setBusy(domain.id);
    try {
      const { data } = await domainsApi.verifyDomain(domain.id);
      if (data.verified && data.routingStatus === "ok") toast.success(data.message);
      else toast.info(data.message);
      await loadData();
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not check the domain"));
    } finally {
      setBusy(null);
    }
  }

  async function setEnabled(domain: CustomDomain, enabled: boolean) {
    setBusy(domain.id);
    try {
      const res = await domainsApi.toggleDomain(domain.id, enabled);
      toast.success(res.message);
      await loadData();
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not change the domain"));
    } finally {
      setBusy(null);
    }
  }

  async function deleteDomain(domain: CustomDomain) {
    const confirmed = await confirmAction({
      title: `Delete ${domain.domain}?`,
      description:
        "Requests to this domain stop being served at once and its verification is released, so another organization can verify the name. This cannot be undone.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!confirmed) return;
    setBusy(domain.id);
    try {
      await domainsApi.deleteDomain(domain.id);
      toast.success("Domain deleted");
      await loadData();
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not delete the domain"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="p-6">
      <PageHeader
        title="Domains"
        description="Serve an agent or a model deployment on your own hostname, over HTTPS, as an OpenAI-compatible base URL."
        actions={
          <Button
            onClick={() => setShowAdd(true)}
            disabled={!canManage}
            title={canManage ? undefined : "See the notice below"}
          >
            <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
            Add domain
          </Button>
        }
      />

      {isLoading ? (
        <DomainsSkeleton />
      ) : loadError ? (
        <ErrorState title="Couldn't load domains" error={loadError} onRetry={retryLoad} />
      ) : (
        <div className="space-y-6">
          {config && <NotConfiguredBanner config={config} />}
          {config && <PlanBanner config={config} />}

          {stats && stats.total > 0 && (
            <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
              {[
                { label: "Domains", value: stats.total, hint: domainAllowanceHint(stats.total, config?.limits) },
                { label: "Serving", value: stats.active, hint: "answering requests now" },
                { label: "Awaiting verification", value: stats.pending, hint: undefined },
                { label: "Paused", value: stats.paused, hint: undefined },
                {
                  label: "Certificates expiring",
                  value: stats.sslExpiringSoon,
                  hint: "observed expiry within 14 days",
                },
              ].map((stat) => (
                <div key={stat.label} className="rounded-lg border border-border bg-card p-4">
                  <Stat label={stat.label} value={stat.value} hint={stat.hint} size="sm" />
                </div>
              ))}
            </div>
          )}

          {domains.length === 0 ? (
            <EmptyState
              icon={Globe}
              title="No custom domains"
              description={
                canManage
                  ? "Add a hostname you control, publish two DNS records, and it serves your agent or deployment over HTTPS."
                  : "Nothing has been added. See the notice above for what is needed before a domain can be added."
              }
              actionLabel={canManage ? "Add domain" : undefined}
              onAction={canManage ? () => setShowAdd(true) : undefined}
            />
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border bg-card">
              {domains.map((domain) => (
                <li key={domain.id} className="flex flex-col gap-4 p-5 lg:flex-row lg:items-center lg:justify-between">
                  <div className="min-w-0 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/dashboard/domains/${domain.id}`}
                        className="truncate font-medium text-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {domain.domain}
                      </Link>
                      {domain.isPrimary && <Badge variant="default">Primary</Badge>}
                      <StateChip state={servingState(domain)} />
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span>Ownership</span>
                      <StateChip state={ownershipState(domain, policy, now)} prefix="Ownership" />
                      <span>DNS</span>
                      <StateChip state={routingState(domain)} prefix="DNS" />
                      <span>Certificate</span>
                      <StateChip state={certificateState(domain)} prefix="Certificate" />
                    </div>
                    <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                      {domain.targetType === "agent" ? (
                        <Bot className="h-3.5 w-3.5" aria-hidden="true" />
                      ) : (
                        <Box className="h-3.5 w-3.5" aria-hidden="true" />
                      )}
                      {domain.targetType === "agent" ? "Agent" : "Deployment"}: {targetName(domain)}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-3">
                    <label className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Switch
                        checked={domain.enabled}
                        // Switching off is always allowed; switching on needs the edge and the plan.
                        disabled={busy === domain.id || (!domain.enabled && !canManage)}
                        onCheckedChange={(next) => setEnabled(domain, next)}
                        aria-label={`${domain.enabled ? "Switch off" : "Switch on"} ${domain.domain}`}
                      />
                      {domain.enabled ? "On" : "Off"}
                    </label>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => checkNow(domain)}
                      disabled={!canManage || busy === domain.id || domain.verificationStatus === "expired"}
                    >
                      <RefreshCw className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                      Check now
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => deleteDomain(domain)}
                      disabled={busy === domain.id}
                      aria-label={`Delete ${domain.domain}`}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a custom domain</DialogTitle>
            <DialogDescription>
              The domain answers <code>POST /v1/chat/completions</code> and <code>GET /v1/models</code> for the one
              target you choose. HTTPS is always enforced.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="domain-name">Domain</Label>
              <Input
                id="domain-name"
                value={form.domain}
                onChange={(e) => setForm({ ...form, domain: e.target.value })}
                placeholder="api.example.com"
                autoComplete="off"
                spellCheck={false}
              />
              <p className="text-xs text-muted-foreground">
                A hostname you control DNS for. Wildcards are not supported.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="domain-target-type">Serves</Label>
              <Select
                id="domain-target-type"
                value={form.targetType}
                onChange={(e) =>
                  setForm({ ...form, targetType: e.target.value as "agent" | "deployment", targetId: "" })
                }
              >
                <option value="agent">An agent</option>
                <option value="deployment">A model deployment</option>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="domain-target">{form.targetType === "agent" ? "Agent" : "Deployment"}</Label>
              <Select
                id="domain-target"
                value={form.targetId}
                onChange={(e) => setForm({ ...form, targetId: e.target.value })}
                disabled={targets.length === 0}
              >
                <option value="">
                  {targets.length === 0
                    ? `No ${form.targetType === "agent" ? "agents" : "deployments"} yet`
                    : `Choose ${form.targetType === "agent" ? "an agent" : "a deployment"}`}
                </option>
                {targets.map((target) => (
                  <option key={target.id} value={target.id}>
                    {target.name}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAdd(false)} disabled={creating}>
              Cancel
            </Button>
            <Button onClick={createDomain} isLoading={creating} disabled={!form.domain.trim() || !form.targetId}>
              Add domain
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
