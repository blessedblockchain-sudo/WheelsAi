import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

/** A linked card for doc index pages. `data-plain` opts out of prose link styling. */
export function CardLink({ href, title, children }: { href: string; title: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      prefetch={false}
      data-plain=""
      className="group block rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex items-center justify-between gap-2 font-semibold text-foreground group-hover:text-primary">
        {title}
        <ArrowRight className="h-4 w-4 shrink-0 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
      </span>
      <span className="mt-1 block text-sm leading-6 text-muted-foreground">{children}</span>
    </Link>
  );
}

export function CardGrid({ children }: { children: ReactNode }) {
  return <div className="mt-6 grid gap-4 sm:grid-cols-2">{children}</div>;
}
