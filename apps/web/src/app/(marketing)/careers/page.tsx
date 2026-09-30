import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { PageBody, PageHero } from "@/components/marketing/page-hero";
import { Founder } from "@/components/marketing/prose";

export const metadata: Metadata = {
  title: "Careers",
  description:
    "WheelsAI is an early-stage team building the platform to build, deploy and monetize AI agents on Nosana and Solana. Here is who we would like to hear from and how to reach us.",
};

const areas = [
  {
    title: "Backend and payments",
    body: "TypeScript on Fastify, PostgreSQL with Prisma and pgvector, Redis and BullMQ workers. Most of our hard problems are money moving exactly once: holds, settlements, refunds and payouts built on conditional writes and compare-and-swap, with a test for every race we can think of.",
  },
  {
    title: "Frontend and product",
    body: "Next.js 15, React and Tailwind. Dashboards that show real numbers or say plainly that there are none, accessible markup, and flows that get a new user from sign-up to a working agent quickly.",
  },
  {
    title: "Solana programs",
    body: "Rust and Anchor. Our agent-treasury and reputation-oracle programs let an agent's earnings pay for its compute and record attested usage on-chain. Careful arithmetic, canonical PDAs and adversarial tests matter here.",
  },
  {
    title: "Models and GPU infrastructure",
    body: "Serving open-weight models with vLLM and Ollama on Nosana GPU markets, LoRA and QLoRA fine-tuning, and runtime containers for agent frameworks. Small models, served well, billed by the second.",
  },
  {
    title: "Developer experience",
    body: "Integrations for Mastra, ElizaOS, LangChain, AutoGen and CrewAI, our SDK and CLI, documentation and examples. If you like making someone else's first ten minutes go well, this is for you.",
  },
];

export default function CareersPage() {
  return (
    <>
      <PageHero
        eyebrow="Careers"
        title="Build the rails AI creators ship on"
        description="WheelsAI is early. We are not posting formal openings right now, but we want to hear from builders who would like to work on this with us."
      />
      <PageBody>
        <section aria-labelledby="areas-heading">
          <h2 id="areas-heading" className="text-2xl font-semibold text-foreground">
            Who we would like to hear from
          </h2>
          <p className="mt-3 max-w-3xl leading-7 text-foreground/80">
            These are the parts of the system we work on every day. If one of them is where you do your best work, tell us.
          </p>
          <div className="mt-6 grid gap-6 md:grid-cols-2">
            {areas.map((a) => (
              <div key={a.title} className="rounded-lg border border-border bg-card p-6">
                <h3 className="font-semibold text-foreground">{a.title}</h3>
                <p className="mt-2 text-sm leading-6 text-foreground/80">{a.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section aria-labelledby="how-heading" className="mt-16 max-w-3xl">
          <h2 id="how-heading" className="text-2xl font-semibold text-foreground">
            How we work
          </h2>
          <ul className="mt-4 space-y-3 leading-7 text-foreground/80">
            <li className="flex gap-3">
              <span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
              <span>
                <strong className="text-foreground">Honest claims.</strong> We build up to what we say the product does, and
                we say what is not done yet. Unfinished features answer with a named error, never a fake success.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
              <span>
                <strong className="text-foreground">Proof over assertion.</strong> Money-moving features ship with tests, and
                with written proof runs that record real transactions.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
              <span>
                <strong className="text-foreground">Small team, whole system.</strong> Everyone touches the API, the product and
                the chain.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
              <span>
                <strong className="text-foreground">Where:</strong> <Founder>location and remote-work policy</Founder>
              </span>
            </li>
          </ul>
        </section>

        <section aria-labelledby="reach-heading" className="mt-16 max-w-3xl rounded-lg border border-border bg-card p-6">
          <h2 id="reach-heading" className="text-xl font-semibold text-foreground">
            How to reach us
          </h2>
          <p className="mt-3 leading-7 text-foreground/80">
            Send us a note through the contact form. Tell us which area you are interested in, link to something you have
            built (code, a product, a write-up), and say how you would like to work with us.
          </p>
          <Link
            href="/contact?topic=other"
            className="mt-5 inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Get in touch <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </section>
      </PageBody>
    </>
  );
}
