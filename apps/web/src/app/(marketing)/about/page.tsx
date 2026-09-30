import type { Metadata } from "next";
import Link from "next/link";
import { Coins, Cpu, Hammer, Receipt, ShieldCheck, Workflow } from "lucide-react";

import { PageBody, PageHero } from "@/components/marketing/page-hero";
import { Founder } from "@/components/marketing/prose";

export const metadata: Metadata = {
  title: "About",
  description:
    "WheelsAI is one platform to build, deploy and monetize AI agents, workflows and small language models, running on Nosana's decentralized GPU network and settling on Solana.",
};

const legs = [
  {
    icon: Hammer,
    title: "Build",
    points: [
      "AI agents in any of six frameworks: Mastra, ElizaOS, LangChain, AutoGen, CrewAI or your own. Import from GitHub, start from a template, or configure one from scratch.",
      "Small language models, fine-tuned with LoRA and QLoRA on your own datasets.",
      "Workflows that chain agents, models and retrieval over your knowledge bases, run on a schedule or drawn in a visual builder.",
    ],
  },
  {
    icon: Cpu,
    title: "Deploy",
    points: [
      "One step to Nosana's decentralized GPU markets, from RTX 3060 to H100.",
      "Priced per second of GPU time, from the same table that drives every estimate and charge.",
      "An OpenAI-compatible /v1 endpoint for every deployment, so existing clients work unchanged.",
    ],
  },
  {
    icon: Coins,
    title: "Monetize",
    points: [
      "A marketplace with four pricing models: free, per request, monthly, and tokenized.",
      "Creators keep 90% of what buyers pay. Payouts are processed exactly once, in credits or on Solana.",
      "Credits can be bought by card or from a Solana wallet, and API calls can be paid one at a time with x402 micropayments.",
    ],
  },
];

const principles = [
  {
    icon: Receipt,
    title: "Every earning has a receipt",
    body: "Every change to a balance is a ledger row, and every on-chain payment has a transaction signature. Public agents have a receipts page anyone can check before installing.",
  },
  {
    icon: ShieldCheck,
    title: "Nothing simulates success",
    body: "If a feature is not configured on a server, the API says so with a named error. What you see working is working.",
  },
  {
    icon: Workflow,
    title: "Bring what you built",
    body: "WheelsAI is framework-agnostic. You should not have to rewrite an agent to host it, bill for it, or list it.",
  },
];

export default function AboutPage() {
  return (
    <>
      <PageHero
        eyebrow="About"
        title="The path from working code to working business"
        description="Every AI creator hits the same wall: hosting, billing and distribution are a second product they never planned to build. WheelsAI removes that wall."
      />
      <PageBody>
        <section aria-labelledby="what-heading" className="max-w-3xl">
          <h2 id="what-heading" className="text-2xl font-semibold text-foreground">
            What WheelsAI is
          </h2>
          <p className="mt-4 text-lg leading-8 text-foreground/80">
            WheelsAI is one platform to build, deploy and monetize AI products: agents, workflows and small language models. You
            bring what you have built. We run it on Nosana&apos;s decentralized GPU network, meter every use, and settle the money
            through a credit ledger and Solana, so the tool you made becomes something people can install and pay for.
          </p>
          <p className="mt-4 text-lg leading-8 text-foreground/80">
            Hosting, billing and distribution are usually three separate problems solved with three separate vendors. We think
            the bundle is the product: when the place you deploy is also the place you sell, the numbers line up, and every
            figure a buyer or creator sees can be traced to where it came from.
          </p>
        </section>

        <section aria-labelledby="legs-heading" className="mt-16">
          <h2 id="legs-heading" className="text-2xl font-semibold text-foreground">
            Build, deploy, monetize
          </h2>
          <div className="mt-6 grid gap-6 md:grid-cols-3">
            {legs.map((leg) => (
              <div key={leg.title} className="rounded-lg border border-border bg-card p-6">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                  <leg.icon className="h-5 w-5 text-primary" aria-hidden="true" />
                </div>
                <h3 className="mt-4 text-lg font-semibold text-foreground">{leg.title}</h3>
                <ul className="mt-3 space-y-3 text-sm leading-6 text-foreground/80">
                  {leg.points.map((p) => (
                    <li key={p} className="flex gap-2">
                      <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
                      <span>{p}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>

        <section aria-labelledby="stack-heading" className="mt-16 max-w-3xl">
          <h2 id="stack-heading" className="text-2xl font-semibold text-foreground">
            Why Nosana and Solana
          </h2>
          <p className="mt-4 leading-7 text-foreground/80">
            <strong className="text-foreground">Nosana</strong> gives us a decentralized market for GPU time, priced by the
            second. That fits the workloads we care about most: small and fine-tuned language models, in the 7 to 14 billion
            parameter class, served on demand rather than on a reserved cluster. Every product type on WheelsAI, from model
            serving to fine-tuning to long-running agents, is a Nosana workload.
          </p>
          <p className="mt-4 leading-7 text-foreground/80">
            <strong className="text-foreground">Solana</strong> is where the money settles: wallet top-ups, x402 per-request
            payments and creator payouts. Two of our own Solana programs close the loop. An agent treasury lets a product&apos;s
            earnings pay the Nosana host that runs it, and a reputation oracle records attested usage on-chain, so an agent token
            can only be launched by an agent that has earned it with real use.
          </p>
        </section>

        <section aria-labelledby="principles-heading" className="mt-16">
          <h2 id="principles-heading" className="text-2xl font-semibold text-foreground">
            How we work
          </h2>
          <div className="mt-6 grid gap-6 md:grid-cols-3">
            {principles.map((p) => (
              <div key={p.title} className="rounded-lg border border-border bg-card p-6">
                <p.icon className="h-5 w-5 text-primary" aria-hidden="true" />
                <h3 className="mt-3 font-semibold text-foreground">{p.title}</h3>
                <p className="mt-2 text-sm leading-6 text-foreground/80">{p.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section aria-labelledby="team-heading" className="mt-16 max-w-3xl">
          <h2 id="team-heading" className="text-2xl font-semibold text-foreground">
            The team
          </h2>
          <p className="mt-4 leading-7 text-foreground/80">
            WheelsAI is built by <Founder>team names and short bios</Founder>, operating as <Founder>legal entity name and location</Founder>.
          </p>
          <p className="mt-4 leading-7 text-foreground/80">
            Want to build with us? See{" "}
            <Link href="/careers" className="font-medium text-primary underline-offset-4 hover:underline">
              careers
            </Link>
            . Anything else,{" "}
            <Link href="/contact?topic=other" className="font-medium text-primary underline-offset-4 hover:underline">
              get in touch
            </Link>
            .
          </p>
        </section>

        <section className="mt-16 flex flex-col gap-4 rounded-lg border border-border bg-card p-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Start building</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Create an account, verify your email for $5 of credits, and have an agent answering in minutes.
            </p>
          </div>
          <div className="flex gap-3">
            <Link
              href="/register"
              className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Get started
            </Link>
            <Link
              href="/docs"
              className="inline-flex h-10 items-center justify-center rounded-md border border-border px-4 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Read the docs
            </Link>
          </div>
        </section>
      </PageBody>
    </>
  );
}
