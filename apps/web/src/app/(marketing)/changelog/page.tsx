import type { Metadata } from "next";
import Link from "next/link";

import { CHANGELOG, type ChangeKind } from "@/components/marketing/changelog-entries";
import { PageBody, PageHero } from "@/components/marketing/page-hero";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Changelog",
  description: "What changed in WheelsAI, newest first: new features, improvements, fixes and security hardening.",
};

const kindClass: Record<ChangeKind, string> = {
  New: "bg-primary/15 text-primary",
  Improved: "bg-muted text-foreground",
  Fixed: "bg-success/10 text-success",
  Security: "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400",
};

function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

export default function ChangelogPage() {
  return (
    <>
      <PageHero
        width="4xl"
        eyebrow="Changelog"
        title="What's new in WheelsAI"
        description="Every notable change to the platform, newest first. Written from our commit history in plain language."
      />
      <PageBody width="4xl">
        <ol className="space-y-14">
          {CHANGELOG.map((day) => (
            <li key={day.date} className="grid gap-4 md:grid-cols-[10rem_1fr] md:gap-8">
              <h2 className="text-sm font-semibold text-muted-foreground md:sticky md:top-24 md:self-start md:pt-1">
                <time dateTime={day.date}>{formatDate(day.date)}</time>
              </h2>
              <ul className="space-y-6 border-l border-border pl-6">
                {day.items.map((item) => (
                  <li key={item.title} className="relative">
                    <span
                      className="absolute -left-[1.84rem] top-2 h-2.5 w-2.5 rounded-full border-2 border-background bg-primary"
                      aria-hidden="true"
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", kindClass[item.kind])}>
                        {item.kind}
                      </span>
                      <h3 className="text-base font-semibold text-foreground">{item.title}</h3>
                    </div>
                    <p className="mt-2 text-[15px] leading-7 text-foreground/80">{item.body}</p>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
        <p className="mt-16 border-t border-border pt-8 text-sm text-muted-foreground">
          Looking for how things work rather than what changed? Read the <Link href="/docs" className="font-medium text-primary underline-offset-4 hover:underline">documentation</Link>, or check live health on the{" "}
          <Link href="/status" className="font-medium text-primary underline-offset-4 hover:underline">status page</Link>.
        </p>
      </PageBody>
    </>
  );
}
