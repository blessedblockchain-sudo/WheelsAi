"use client";

import { use, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { KeyRound, RefreshCw, ShieldCheck, Star, Trash2 } from "lucide-react";
import { toast } from "sonner";

import {
  DnsRecordTable,
  NotConfiguredBanner,
  ObservedField,
  PlanBanner,
  StateChip,
} from "@/components/dashboard/domains/domain-parts";
import {
  certificateState,
  DEFAULT_POLICY,
  domainBaseUrl,
  formatFingerprint,
  formatRequestCount,
  isSettling,
  ownershipState,
  routingRecordPlan,
  routingState,
  servingState,
  usageSnippet,
} from "@/components/dashboard/domains/domain-model";
import { CodeBlock } from "@/components/marketing/code-block";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { ErrorState } from "@/components/ui/error-state";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  domainsApi,
  getApiErrorBody,
  getErrorMessage,
  type CustomDomain,
  type DomainEvent,
  type DomainsConfig,
} from "@/lib/api";

const POLL_INTERVAL_MS = 5_000;
/** DNS and a first certificate either show up within minutes or need the owner; stop asking after this. */
const POLL_LIMIT_MS = 10 * 60_000;

function when(value: string | null | undefined): string | null {
  return value ? new Date(value).toLocaleString() : null;
}

function DetailSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true">
      <Skeleton className="h-8 w-72" />
      {[1, 2, 3].map((i) => (
        <div key={i} className="space-y-3 rounded-lg border border-border bg-card p-6">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-20 w-full" />
        </div>
      ))}
    </div>
  );
}

export default function DomainDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const confirmAction = useConfirm();
  const router = useRouter();
  const [domain, setDomain] = useState<CustomDomain | null>(null);
  const [config, setConfig] = useState<DomainsConfig | null>(null);
  const [events, setEvents] = useState<DomainEvent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [busy, setBusy] = useState<"check" | "certificate" | "switch" | "token" | "primary" | "delete" | null>(null);
  const hasLoadedRef = useRef(false);
  const pollStartedRef = useRef<number | null>(null);
  const [pollExpired, setPollExpired] = useState(false);

  async function load({ quiet = false }: { quiet?: boolean } = {}) {
    try {
      const [domainRes, eventsRes] = await Promise.all([
        domainsApi.getDomain(id),
        domainsApi.getDomainEvents(id, { limit: 20 }),
      ]);
      setDomain(domainRes.data);
      setEvents(eventsRes.data.events);
      hasLoadedRef.current = true;
      setLoadError(null);
    } catch (error) {
      // A background refresh that fails keeps what is on screen.
      if (!quiet) toast.error(getErrorMessage(error, "Failed to load the domain"));
      if (!hasLoadedRef.current) setLoadError(error);
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    hasLoadedRef.current = false;
    setIsLoading(true);
    load();
    domainsApi
      .getConfig()
      .then((res) => setConfig(res.data))
      .catch((error) => toast.error(getErrorMessage(error, "Could not read the custom-domain configuration")));
  }, [id]);

  const settling = domain !== null && isSettling(domain) && Boolean(config?.configured);

  // While the owner waits on DNS or the first certificate, re-read what the
  // checker observed. Reading never triggers a check or a handshake.
  useEffect(() => {
    if (!settling) {
      pollStartedRef.current = null;
      setPollExpired(false);
      return;
    }
    pollStartedRef.current ??= Date.now();
    const timer = setInterval(() => {
      if (Date.now() - (pollStartedRef.current ?? Date.now()) > POLL_LIMIT_MS) {
        setPollExpired(true);
        clearInterval(timer);
        return;
      }
      if (document.visibilityState === "visible") load({ quiet: true });
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [settling, id]);

  function retryLoad() {
    setLoadError(null);
    setIsLoading(true);
    load();
  }

  function restartPolling() {
    pollStartedRef.current = Date.now();
    setPollExpired(false);
  }

  if (isLoading) {
    return (
      <div className="p-6">
        <DetailSkeleton />
      </div>
    );
  }

  if (loadError || !domain) {
    const missing = getApiErrorBody(loadError)?.status === 404 || getApiErrorBody(loadError)?.status === 400;
    return (
      <div className="p-6">
        <ErrorState
          title={missing ? "Domain not found" : "Couldn't load the domain"}
          description={missing ? "It may have been deleted, or it belongs to another organization." : undefined}
          error={missing ? undefined : loadError}
          onRetry={missing ? undefined : retryLoad}
          actionLabel="Back to domains"
          actionHref="/dashboard/domains"
        />
      </div>
    );
  }

  const current = domain;
  const policy = config?.policy ?? DEFAULT_POLICY;
  const now = Date.now();
  const canManage = Boolean(config?.configured && config.plan.entitled);
  const ownership = ownershipState(current, policy, now);
  const routing = routingState(current);
  const certificate = certificateState(current);
  const serving = servingState(current);
  const records = routingRecordPlan(current.dnsRecords);
  const verified = current.verificationStatus === "verified";
  const routed = current.routingStatus === "ok";

  async function checkNow() {
    setBusy("check");
    try {
      const { data } = await domainsApi.verifyDomain(current.id);
      if (data.verified && data.routingStatus === "ok") toast.success(data.message);
      else toast.info(data.message);
      restartPolling();
      await load();
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not check the domain"));
    } finally {
      setBusy(null);
    }
  }

  async function recheckCertificate() {
    setBusy("certificate");
    try {
      const { data } = await domainsApi.renewSsl(current.id);
      if (data.sslStatus === "active") toast.success(data.message);
      else toast.info(data.message);
      await load();
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not check the certificate"));
    } finally {
      setBusy(null);
    }
  }

  async function setEnabled(enabled: boolean) {
    if (!enabled) {
      const confirmed = await confirmAction({
        title: `Switch off ${current.domain}?`,
        description: "Requests to this domain are answered 404 until you switch it back on. DNS and the verification are kept.",
        confirmLabel: "Switch off",
      });
      if (!confirmed) return;
    }
    setBusy("switch");
    try {
      const res = await domainsApi.toggleDomain(current.id, enabled);
      toast.success(res.message);
      await load();
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not change the domain"));
    } finally {
      setBusy(null);
    }
  }

  async function newToken() {
    const confirmed = await confirmAction({
      title: "Generate a new verification token?",
      description:
        "The current TXT record stops counting at once: the domain stops serving and its verification is released until the new record is published and found. Use this only if the token may have leaked or the verification expired.",
      confirmLabel: "Generate new token",
      destructive: true,
    });
    if (!confirmed) return;
    setBusy("token");
    try {
      const res = await domainsApi.reverifyDomain(current.id);
      toast.success(res.message);
      restartPolling();
      await load();
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not generate a new token"));
    } finally {
      setBusy(null);
    }
  }

  async function makePrimary() {
    setBusy("primary");
    try {
      await domainsApi.updateDomain(current.id, { isPrimary: true });
      toast.success("This is now the primary domain of its target.");
      await load();
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not update the domain"));
    } finally {
      setBusy(null);
    }
  }

  async function deleteDomain() {
    const confirmed = await confirmAction({
      title: `Delete ${current.domain}?`,
      description:
        "Requests to this domain stop being served at once and its verification is released, so another organization can verify the name. This cannot be undone.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!confirmed) return;
    setBusy("delete");
    try {
      await domainsApi.deleteDomain(current.id);
      toast.success("Domain deleted");
      router.push("/dashboard/domains");
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not delete the domain"));
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span className="break-all">{current.domain}</span>
            {current.isPrimary && <Badge variant="default">Primary</Badge>}
            <StateChip state={serving} />
          </span>
        }
        description={serving.detail}
        breadcrumbs={[{ label: "Domains", href: "/dashboard/domains" }, { label: current.domain }]}
        actions={
          <>
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <Switch
                checked={current.enabled}
                // Switching off is always allowed; switching on needs the edge and the plan.
                disabled={busy !== null || (!current.enabled && !canManage)}
                onCheckedChange={setEnabled}
                aria-label={current.enabled ? "Switch the domain off" : "Switch the domain on"}
              />
              {current.enabled ? "On" : "Off"}
            </label>
            <Button variant="outline" size="sm" onClick={deleteDomain} disabled={busy !== null}>
              <Trash2 className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
              Delete
            </Button>
          </>
        }
      />

      {config && <NotConfiguredBanner config={config} />}
      {config && <PlanBanner config={config} />}

      {settling && (
        <p role="status" className="text-sm text-muted-foreground">
          {pollExpired ? (
            <>
              Stopped refreshing after 10 minutes.{" "}
              <button type="button" onClick={restartPolling} className="text-primary underline-offset-4 hover:underline">
                Keep watching
              </button>
            </>
          ) : (
            "This page refreshes every few seconds with what the checker observes. DNS changes can take minutes to hours to be visible."
          )}
        </p>
      )}

      {/* 1. Ownership */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">1. Ownership</CardTitle>
            <StateChip state={ownership} />
          </div>
          <CardDescription>{ownership.detail}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Publish this TXT record at your DNS provider. It proves you control the domain, and it must stay in place
            for as long as the domain is used here.
          </p>
          <DnsRecordTable records={[current.dnsRecords.txtRecord]} caption="Ownership record" />
          <dl className="grid gap-4 sm:grid-cols-2">
            <ObservedField label="Last checked" value={when(current.lastCheckedAt)} />
            <ObservedField label="Verified" value={when(current.verifiedAt)} />
          </dl>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={checkNow}
              isLoading={busy === "check"}
              disabled={!canManage || busy !== null || current.verificationStatus === "expired"}
            >
              <RefreshCw className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
              Check now
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={newToken}
              isLoading={busy === "token"}
              disabled={!config?.configured || busy !== null}
            >
              <KeyRound className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
              Generate new token
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 2. Routing */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">2. Routing</CardTitle>
            <StateChip state={routing} />
          </div>
          <CardDescription>{routing.detail}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">{records.note}</p>
          {records.available && (
            <>
              <DnsRecordTable
                records={records.recommended}
                caption={current.dnsRecords.recommended === "a" ? "Address records to publish" : "CNAME record to publish"}
              />
              {records.alternative.length > 0 && (
                <details className="text-sm">
                  <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                    My DNS provider cannot publish a CNAME here
                  </summary>
                  <div className="mt-3">
                    <DnsRecordTable records={records.alternative} caption="Address records to publish instead of the CNAME" />
                  </div>
                </details>
              )}
              <p className="text-sm text-muted-foreground">
                The domain must resolve to these addresses and no others. A CDN or proxy in front of the record (for
                example a proxied Cloudflare record) is read as pointing elsewhere; set the record to DNS only.
              </p>
            </>
          )}
          <dl className="grid gap-4 sm:grid-cols-2">
            <ObservedField
              label="Addresses observed"
              value={current.observedAddresses.length > 0 ? current.observedAddresses.join(", ") : null}
              mono
            />
            <ObservedField label="Last looked up" value={when(current.routingCheckedAt)} />
          </dl>
        </CardContent>
      </Card>

      {/* 3. Certificate */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">3. Certificate</CardTitle>
            <StateChip state={certificate} />
          </div>
          <CardDescription>{certificate.detail}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Nothing here is assumed. Every value below was read from a TLS handshake made with the edge for this
            domain, and a certificate counts only if a browser would accept it.
          </p>
          <dl className="grid gap-4 sm:grid-cols-2">
            <ObservedField label="Issuer" value={current.sslIssuer} />
            <ObservedField label="Last handshake" value={when(current.sslCheckedAt)} />
            <ObservedField label="Valid from" value={when(current.sslValidFrom)} />
            <ObservedField label="Valid until" value={when(current.sslExpiresAt)} />
            <div className="sm:col-span-2">
              <ObservedField label="SHA-256 fingerprint" value={formatFingerprint(current.sslFingerprint256)} mono />
            </div>
            {current.sslError && (
              <div className="sm:col-span-2">
                <dt className="text-xs text-muted-foreground">Last error</dt>
                <dd className="mt-0.5 break-words font-mono text-sm text-danger">{current.sslError}</dd>
              </div>
            )}
          </dl>
          <div>
            <Button
              variant="outline"
              size="sm"
              onClick={recheckCertificate}
              isLoading={busy === "certificate"}
              disabled={!canManage || !verified || !routed || busy !== null}
            >
              <ShieldCheck className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
              Re-check certificate
            </Button>
            {(!verified || !routed) && (
              <p className="mt-2 text-xs text-muted-foreground">
                Available once ownership is verified and DNS points at the edge.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Use it */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Use the domain</CardTitle>
          <CardDescription>
            {current.isActive ? (
              <>
                <code>{domainBaseUrl(current)}</code> is an OpenAI-compatible base URL for this{" "}
                {current.targetType === "agent" ? "agent" : "model deployment"}.
              </>
            ) : (
              <>
                Once the domain is serving, <code>{domainBaseUrl(current)}</code> is an OpenAI-compatible base URL for
                this {current.targetType === "agent" ? "agent" : "model deployment"}. It does not answer yet.
              </>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <CodeBlock language="bash" code={usageSnippet(current)} />
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>
              It answers <code>POST /v1/chat/completions</code> and <code>GET /v1/models</code> and nothing else; no
              other part of the API is reachable through it.
            </li>
            <li>
              Authenticate with an <Link href="/dashboard/keys" className="text-primary underline-offset-4 hover:underline">API key</Link>{" "}
              of this organization. A key of another organization is refused with <code>403 wrong_organization</code>.
            </li>
            <li>Requests are metered and billed exactly as on the platform&apos;s own URL.</li>
            <li>HTTPS is always enforced. A plain-HTTP request is redirected with a 308.</li>
          </ul>
          <dl className="grid gap-4 sm:grid-cols-3">
            <ObservedField label="Requests served" value={formatRequestCount(current.totalRequests)} mono />
            <ObservedField label="Last request" value={when(current.lastRequestAt)} />
            <div>
              <dt className="text-xs text-muted-foreground">Primary domain</dt>
              <dd className="mt-0.5 text-sm text-foreground">
                {current.isPrimary ? (
                  "Yes: shown as the target's custom endpoint"
                ) : (
                  <Button variant="outline" size="sm" onClick={makePrimary} isLoading={busy === "primary"} disabled={busy !== null}>
                    <Star className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                    Make primary
                  </Button>
                )}
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      {/* History */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">History</CardTitle>
          <CardDescription>What was done to this domain and what the checker observed, newest first.</CardDescription>
        </CardHeader>
        <CardContent>
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing recorded yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {events.map((event) => (
                <li key={event.id} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">{event.eventType.replace(/_/g, " ")}</p>
                    {event.message && <p className="break-words text-sm text-muted-foreground">{event.message}</p>}
                  </div>
                  <time dateTime={event.createdAt} className="shrink-0 text-xs text-muted-foreground">
                    {new Date(event.createdAt).toLocaleString()}
                  </time>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
