import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, ChevronRight } from "lucide-react";

import { Prose } from "@/components/marketing/prose";
import { DOCS_FLAT, DOCS_NAV } from "./nav";

export interface TocItem {
  id: string;
  title: string;
  /** Nest under the previous top-level item. */
  sub?: boolean;
}

interface DocPageProps {
  /** Path of this page, used for breadcrumbs and previous/next. */
  href: string;
  title: string;
  lead?: ReactNode;
  toc?: TocItem[];
  children: ReactNode;
}

/**
 * One documentation page: breadcrumb, title, body (styled by <Prose>), an
 * "On this page" list on wide screens, and previous/next links taken from
 * the sidebar order.
 */
export function DocPage({ href, title, lead, toc = [], children }: DocPageProps) {
  const index = DOCS_FLAT.findIndex((i) => i.href === href);
  const prev = index > 0 ? DOCS_FLAT[index - 1] : undefined;
  const next = index >= 0 && index < DOCS_FLAT.length - 1 ? DOCS_FLAT[index + 1] : undefined;
  const section = DOCS_NAV.find((s) => s.items.some((i) => i.href === href));

  return (
    <div className="flex gap-10">
      <article className="min-w-0 max-w-3xl flex-1">
        <nav aria-label="Breadcrumb">
          <ol className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
            <li>
              <Link href="/docs" prefetch={false} className="hover:text-foreground">
                Docs
              </Link>
            </li>
            {section && section.title !== "Overview" && (
              <li className="flex items-center gap-1">
                <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{section.title}</span>
              </li>
            )}
          </ol>
        </nav>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">{title}</h1>
        {lead && <p className="mt-4 text-lg leading-relaxed text-muted-foreground">{lead}</p>}

        <Prose className="mt-8">{children}</Prose>

        {(prev || next) && (
          <nav aria-label="Previous and next pages" className="mt-16 grid gap-4 border-t border-border pt-8 sm:grid-cols-2">
            {prev ? (
              <Link
                href={prev.href}
                prefetch={false}
                className="group rounded-lg border border-border p-4 transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> Previous
                </span>
                <span className="mt-1 block font-medium text-foreground group-hover:text-primary">{prev.title}</span>
              </Link>
            ) : (
              <span />
            )}
            {next && (
              <Link
                href={next.href}
                prefetch={false}
                className="group rounded-lg border border-border p-4 text-right transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="flex items-center justify-end gap-1 text-xs text-muted-foreground">
                  Next <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                </span>
                <span className="mt-1 block font-medium text-foreground group-hover:text-primary">{next.title}</span>
              </Link>
            )}
          </nav>
        )}
      </article>

      {toc.length > 0 && (
        <aside className="hidden w-52 shrink-0 xl:block" aria-labelledby="on-this-page">
          <div className="sticky top-24">
            <p id="on-this-page" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              On this page
            </p>
            <ul className="mt-3 space-y-1.5 text-sm">
              {toc.map((item) => (
                <li key={item.id} className={item.sub ? "pl-3" : undefined}>
                  <a href={`#${item.id}`} className="text-foreground/70 transition-colors hover:text-primary">
                    {item.title}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      )}
    </div>
  );
}
