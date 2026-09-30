"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Bot, Check, Circle, Cpu, GitBranch, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { authApi, marketplaceApi } from "@/lib/api";
import { cn } from "@/lib/utils";

const DISMISS_KEY = "wheelsai:get-started-dismissed";

/**
 * The three things WheelsAI builds, as entry points: an agent, a
 * workflow, or a small language model (deploy one, or fine-tune your
 * own).
 */
const ENTRY_POINTS = [
  {
    icon: Bot,
    title: "Build an agent",
    body: "Import from GitHub (Mastra, ElizaOS, LangChain, AutoGen, CrewAI, custom) or start from a template.",
    primary: { label: "Create agent", href: "/dashboard/agents/new" },
    secondary: { label: "Templates", href: "/dashboard/templates" },
  },
  {
    icon: GitBranch,
    title: "Build a workflow",
    body: "Chain agents into pipelines, give them branches and loops, and run them on a schedule.",
    primary: { label: "Open workflows", href: "/dashboard/orchestrations" },
    secondary: { label: "Scheduler", href: "/dashboard/scheduler" },
  },
  {
    icon: Cpu,
    title: "Deploy or fine-tune a model",
    body: "Serve an open model on Nosana GPUs behind an OpenAI-compatible API, or fine-tune one on your data.",
    primary: { label: "Model catalog", href: "/dashboard/models" },
    secondary: { label: "Fine-tune", href: "/dashboard/training/new" },
  },
] as const;

interface Props {
  agentCount: number;
  deploymentCount: number;
  creditCents: number;
}

export function GetStarted({ agentCount, deploymentCount, creditCents }: Props) {
  const [emailVerified, setEmailVerified] = useState<boolean | null>(null);
  const [hasListing, setHasListing] = useState<boolean | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    try {
      setDismissed(window.localStorage.getItem(DISMISS_KEY) === "1");
    } catch {
      // Storage can be unavailable (private mode); the checklist just shows.
    }
    authApi
      .me()
      .then(({ user }) => setEmailVerified(user.emailVerified !== false || !user.email))
      .catch(() => setEmailVerified(null));
    marketplaceApi
      .getMyListings()
      .then(({ listings }) => setHasListing(listings.some((l) => l.status === "published")))
      .catch(() => setHasListing(null));
  }, []);

  const steps = [
    { done: emailVerified === true, label: "Verify your email", detail: "Unlocks your $5 of free credits", href: "/dashboard/settings" },
    { done: agentCount > 0, label: "Build your first agent", detail: "Import, template, or from scratch", href: "/dashboard/agents/new" },
    { done: deploymentCount > 0, label: "Deploy on Nosana", detail: "A model or an agent, billed per second", href: "/dashboard/deployments/new" },
    { done: hasListing === true, label: "Publish to the marketplace", detail: "Free, per request, monthly or token-gated", href: "/dashboard/marketplace/publish" },
    { done: creditCents > 0, label: "Fund your account", detail: "Credits by card or crypto", href: "/dashboard/billing" },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  const allDone = doneCount === steps.length;

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
      <div className="grid gap-4 md:grid-cols-3">
        {ENTRY_POINTS.map((entry) => (
          <Card key={entry.title} className="flex flex-col">
            <CardContent className="flex flex-1 flex-col gap-3 py-5">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <entry.icon className="h-5 w-5 text-primary" />
              </div>
              <div className="flex-1">
                <h3 className="font-semibold text-foreground">{entry.title}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{entry.body}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Link href={entry.primary.href}>
                  <Button size="sm">
                    {entry.primary.label}
                    <ArrowRight className="ml-1.5 h-4 w-4" />
                  </Button>
                </Link>
                <Link href={entry.secondary.href}>
                  <Button size="sm" variant="outline">
                    {entry.secondary.label}
                  </Button>
                </Link>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {!dismissed && !allDone && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-3">
            <CardTitle className="text-base">
              Getting started{" "}
              <span className="font-mono text-sm font-normal tabular-nums text-muted-foreground">
                {doneCount}/{steps.length}
              </span>
            </CardTitle>
            <Button variant="ghost" size="icon" onClick={dismiss} aria-label="Hide the getting started checklist">
              <X className="h-4 w-4" />
            </Button>
          </CardHeader>
          <CardContent>
            <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
              {steps.map((step) => (
                <li key={step.label}>
                  <Link
                    href={step.href}
                    className={cn(
                      "flex h-full items-start gap-2 rounded-lg border p-3 transition-colors hover:bg-muted",
                      step.done && "border-success/30"
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
              ))}
            </ol>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
