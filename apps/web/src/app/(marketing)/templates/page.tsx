import type { Metadata } from "next";
import Link from "next/link";

import { PageBody, PageHero } from "@/components/marketing/page-hero";
import { TemplateGallery } from "@/components/marketing/template-gallery";

export const metadata: Metadata = {
  title: "Templates",
  description:
    "Browse WheelsAI's published agent templates: ready-made agents for Mastra, ElizaOS, LangChain, AutoGen, CrewAI and custom frameworks.",
};

export default function PublicTemplatesPage() {
  return (
    <>
      <PageHero
        width="6xl"
        eyebrow="Templates"
        title="Start from a working agent"
        description="Ready-made agents with a system prompt, tools and model settings already configured. Pick one, make it yours, and chat with it in the playground."
      >
        <p className="mt-4 text-sm text-navy-200/70">
          How templates work:{" "}
          <Link href="/docs/guides/templates" className="font-medium text-navy-300 underline-offset-4 hover:underline">
            read the guide
          </Link>
          .
        </p>
      </PageHero>
      <PageBody width="6xl">
        <h2 className="sr-only">Published templates</h2>
        <TemplateGallery />
      </PageBody>
    </>
  );
}
