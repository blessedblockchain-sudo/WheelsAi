"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, Bot, Check, Circle, Cpu, GitBranch, X } from "lucide-react";

import { AgentKindBadge } from "@/components/dashboard/agent-kind-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
  agentsApi,
  authApi,
  marketplaceApi,
  templateApi,
  type Agent,
  type AgentTemplate,
  type BillingRails,
} from "@/lib/api";
import { KIND_CHOICES, frameworkLabel, newAgentHref, quickStartTemplates, showsFrameworkChip } from "@/lib/agent-list";
import {
  HOME_BUILD_MORE,
  HOME_CREATE_TITLE,
  IMPORT_CODE_HREF,
  accountSteps,
  agentLinks,
  newestAgents,
  nextSteps,
  type HomeListing,
  type HomeStep,
} from "@/lib/home";
import { cn } from "@/lib/utils";

// A key of its own: someone who hid the older "Getting started" list has not seen these steps.
const DISMISS_KEY = "wheelsai:next-steps-dismissed";

const BUILD_ICONS = { workflow: GitBranch, model: Cpu } as const;

const linkClass =
  "text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

interface Props {
  /** The person's agents; null while they load, or when they could not be read. */
  agents: Agent[] | null;
  agentsLoading: boolean;
  /** What the agents call threw; null when it answered. */
  agentsError: unknown;
  onRetry: () => void;
  creditCents: number;
  /** `capabilities.emailDelivery.available`; null when the capabilities could not be read. */
  emailDelivery: boolean | null;
  /** The live ways of paying; null when they could not be read. */
  rails: BillingRails | null;
}

/**
 * Home, top to bottom: create an agent (the three choices, then templates),
 * the person's newest agents, the two other things to build, and the
 * checklist of what to do next.
 */
export function GetStarted({ agents, agentsLoading, agentsError, onRetry, creditCents, emailDelivery, rails }: Props) {
  const [account, setAccount] = useState<{ hasEmail: boolean; emailVerified: boolean } | null>(null);
  const [listings, setListings] = useState<HomeListing[] | null>(null);
  // The templates are a convenience: when they cannot be read the chips are left out.
  const [templates, setTemplates] = useState<AgentTemplate[] | null>(null);
  const [linkState, setLinkState] = useState<string | null>(null);
  const [used, setUsed] = useState<boolean | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let gone = false;
    try {
      setDismissed(window.localStorage.getItem(DISMISS_KEY) === "1");
    } catch {
      // Storage can be unavailable (private mode); the checklist just shows.
    }
    authApi
      .me()
      .then(({ user }) => {
        if (!gone) setAccount({ hasEmail: Boolean(user.email), emailVerified: user.emailVerified !== false });
      })
      .catch(() => undefined);
    marketplaceApi
      .getMyListings()
      .then(({ listings: mine }) => {
        if (!gone) setListings(mine);
      })
      .catch(() => undefined);
    templateApi
      .list({ limit: 12 })
      .then((res) => {
        if (!gone) setTemplates(quickStartTemplates(res.templates ?? [], 6));
      })
      .catch(() => {
        if (!gone) setTemplates([]);
      });
    return () => {
      gone = true;
    };
  }, []);

  const recent = useMemo(() => newestAgents(agents ?? [], 3), [agents]);
  const newest = recent[0];
  const newestId = newest?.id;
  const newestKind = newest?.agentKind;

  // What the checklist needs to know of the newest agent: its public link, and a first use.
  useEffect(() => {
    setLinkState(null);
    setUsed(null);
    if (!newestId) return;
    let gone = false;
    agentsApi
      .getPublicLink(newestId)
      .then((link) => {
        if (!gone) setLinkState(link.state);
      })
      .catch(() => undefined);
    Promise.allSettled([
      agentsApi.usage(newestId, "30d").then(({ usage }) => usage.total.requests > 0),
      newestKind === "scheduled"
        ? agentsApi.listRuns(newestId, { limit: 1 }).then((page) => page.runs.length > 0)
        : Promise.resolve(false),
    ]).then((answers) => {
      if (gone) return;
      const known = answers.filter((a): a is PromiseFulfilledResult<boolean> => a.status === "fulfilled");
      if (known.some((a) => a.value)) setUsed(true);
      else if (known.length === answers.length) setUsed(false);
    });
    return () => {
      gone = true;
    };
  }, [newestId, newestKind]);

  const steps = nextSteps({ agents: agents ?? [], used, linkState, listings });
  const extra = accountSteps({
    hasEmail: account?.hasEmail ?? false,
    emailVerified: account ? account.emailVerified : null,
    emailDelivery,
    rails,
    creditCents,
  });
  const doneCount = steps.filter((s) => s.done).length;
  const allDone = doneCount === steps.length && extra.every((s) => s.done);

  function dismiss() {
    setDismissed(true);
    try {
      window.localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // ignore
    }
  }

  return (
    <div className="mb-8 space-y-6">
      {/* 1. Create an agent */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Bot className="h-5 w-5 text-primary" aria-hidden="true" />
            Create an agent
          </CardTitle>
          <CardDescription>
            Pick how people will use it and say what it should do. It is live as soon as you create it.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div>
            <h2 className="mb-3 text-sm font-medium text-foreground">{HOME_CREATE_TITLE}</h2>
            <ul className="grid gap-4 md:grid-cols-3">
              {KIND_CHOICES.map((choice) => (
                <li key={choice.kind}>
                  <Link
                    href={newAgentHref({ kind: choice.kind })}
                    className="flex h-full flex-col gap-2 rounded-lg border p-4 transition-colors hover:border-primary/40 hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-medium text-foreground">{choice.title}</p>
                      <AgentKindBadge kind={choice.kind} />
                    </div>
                    <p className="text-sm text-muted-foreground">{choice.description}</p>
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {templates === null ? (
            <div className="flex flex-wrap gap-2" aria-busy="true">
              <span className="sr-only">Loading templates</span>
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-9 w-44 rounded-full" />
              ))}
            </div>
          ) : (
            templates.length > 0 && (
              <div>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <h2 className="text-sm font-medium text-foreground">Start from a template</h2>
                  <Link href="/dashboard/templates" className={linkClass}>
                    Browse all templates
                  </Link>
                </div>
                <ul className="flex flex-wrap gap-2">
                  {templates.map((template) => (
                    <li key={template.id} className="max-w-full">
                      <Link
                        href={newAgentHref({ template: template.id })}
                        className="flex max-w-full items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors hover:border-primary/40 hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <span className="truncate font-medium text-foreground">{template.title}</span>
                        <AgentKindBadge kind={template.agentKind} />
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )
          )}

          <p className="text-sm text-muted-foreground">
            Have code already? Import it from GitHub: Mastra, ElizaOS, LangChain, AutoGen, CrewAI or custom.{" "}
            <Link href={IMPORT_CODE_HREF} className={linkClass}>
              Import your code
            </Link>
          </p>
        </CardContent>
      </Card>

      {/* 2. The person's agents: not shown when there is none yet */}
      {agentsLoading ? (
        <div className="space-y-3" aria-busy="true">
          <span className="sr-only">Loading agents</span>
          {[1, 2].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : agentsError !== null ? (
        <ErrorState title="Couldn't load agents" error={agentsError} onRetry={onRetry} />
      ) : (
        recent.length > 0 && (
          <section aria-labelledby="home-your-agents">
            <div className="flex items-center justify-between gap-3">
              <h2 id="home-your-agents" className="text-lg font-semibold text-foreground">
                Your agents
              </h2>
              <Link href="/dashboard/agents" className={linkClass}>
                View all
              </Link>
            </div>
            <ul className="mt-4 space-y-3">
              {recent.map((agent) => {
                const links = agentLinks(agent);
                return (
                  <li key={agent.id}>
                    <Card>
                      <CardContent className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <Link
                            href={`/dashboard/agents/${agent.id}`}
                            className="min-w-0 truncate font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            {agent.name}
                          </Link>
                          <AgentKindBadge kind={agent.agentKind} />
                          {showsFrameworkChip(agent) && (
                            <span className="rounded bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                              {frameworkLabel(agent.framework)}
                            </span>
                          )}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {[links.first, links.share, links.sell].map((link, index) => (
                            <Link key={link.href} href={link.href} aria-label={`${link.label}: ${agent.name}`}>
                              <Button size="sm" variant={index === 0 ? "default" : "outline"} tabIndex={-1}>
                                {link.label}
                              </Button>
                            </Link>
                          ))}
                        </div>
                      </CardContent>
                    </Card>
                  </li>
                );
              })}
            </ul>
          </section>
        )
      )}

      {/* 3. The two other things to build */}
      <div className="grid gap-4 md:grid-cols-2">
        {HOME_BUILD_MORE.map((entry) => {
          const Icon = BUILD_ICONS[entry.id];
          return (
            <Card key={entry.id} className="flex flex-col">
              <CardContent className="flex flex-1 flex-col gap-3 py-5">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                  <Icon className="h-5 w-5 text-primary" aria-hidden="true" />
                </div>
                <div className="flex-1">
                  <h3 className="font-semibold text-foreground">{entry.title}</h3>
                  <p className="mt-1 text-sm text-foreground">{entry.first}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{entry.second}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Link href={entry.primary.href}>
                    <Button size="sm" tabIndex={-1}>
                      {entry.primary.label}
                      <ArrowRight className="ml-1.5 h-4 w-4" aria-hidden="true" />
                    </Button>
                  </Link>
                  <Link href={entry.secondary.href}>
                    <Button size="sm" variant="outline" tabIndex={-1}>
                      {entry.secondary.label}
                    </Button>
                  </Link>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* 4. What to do next. Drawn once the agents are known, so no step is shown undone by mistake. */}
      {agents !== null && !dismissed && !allDone && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-3">
            <CardTitle className="text-base">
              Next steps{" "}
              <span className="font-mono text-sm font-normal tabular-nums text-muted-foreground">
                {doneCount}/{steps.length}
              </span>
            </CardTitle>
            <Button variant="ghost" size="icon" onClick={dismiss} aria-label="Hide the next steps checklist">
              <X className="h-4 w-4" />
            </Button>
          </CardHeader>
          <CardContent className="space-y-4">
            <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {steps.map((step) => (
                <StepItem key={step.id} step={step} />
              ))}
            </ol>
            {extra.length > 0 && (
              <div>
                <h3 className="mb-2 text-sm font-medium text-foreground">Your account</h3>
                <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  {extra.map((step) => (
                    <StepItem key={step.id} step={step} />
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function StepItem({ step }: { step: HomeStep }) {
  return (
    <li>
      <Link
        href={step.href}
        className={cn(
          "flex h-full items-start gap-2 rounded-lg border p-3 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          step.done && "border-success/30",
        )}
      >
        {step.done ? (
          <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-label="Done" />
        ) : (
          <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-label="Not done" />
        )}
        <span>
          <span className={cn("block text-sm font-medium", step.done && "text-muted-foreground line-through")}>
            {step.label}
          </span>
          <span className="block text-xs text-muted-foreground">{step.detail}</span>
        </span>
      </Link>
    </li>
  );
}
