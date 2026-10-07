import type { ReactNode } from "react";

import { PageBody, PageHero } from "@/components/marketing/page-hero";
import { Callout, Founder, Prose } from "@/components/marketing/prose";

export interface LegalSection {
  id: string;
  title: string;
}

interface LegalPageProps {
  eyebrow: string;
  title: string;
  description: string;
  sections: LegalSection[];
  children: ReactNode;
}

/** Shared frame for the privacy policy and terms: draft notice, contents, body. */
export function LegalPage({ eyebrow, title, description, sections, children }: LegalPageProps) {
  return (
    <>
      <PageHero width="3xl" eyebrow={eyebrow} title={title} description={description} />
      <PageBody width="3xl">
        {/* [FOUNDER: remove this notice once counsel has reviewed the document and every marker below is filled in.] */}
        <Callout variant="warning" title="Draft" className="mt-0">
          <p>
            This document is a draft and may change before it takes effect. Effective date:{" "}
            <Founder>effective date on publication</Founder>.
          </p>
        </Callout>

        <nav aria-labelledby="contents-heading" className="mt-10 rounded-lg border border-border bg-card p-5">
          <h2 id="contents-heading" className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Contents
          </h2>
          <ol className="mt-3 grid gap-1.5 text-sm sm:grid-cols-2">
            {sections.map((s, i) => (
              <li key={s.id}>
                <a href={`#${s.id}`} className="text-foreground/80 underline-offset-4 hover:text-primary hover:underline">
                  {i + 1}. {s.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <Prose className="mt-10">{children}</Prose>
      </PageBody>
    </>
  );
}
