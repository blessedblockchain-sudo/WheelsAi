"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";
import { DOCS_NAV, DOCS_FLAT } from "./nav";

function NavList({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  return (
    <div className="space-y-6">
      {DOCS_NAV.map((section) => (
        <div key={section.title}>
          <p className="px-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {section.title}
          </p>
          <ul className="mt-2 space-y-0.5">
            {section.items.map((item) => {
              const active = pathname === item.href;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    prefetch={false}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "block rounded-md px-2 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      active
                        ? "bg-primary/10 font-medium text-primary"
                        : "text-foreground/75 hover:bg-muted hover:text-foreground",
                    )}
                  >
                    {item.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** Sticky sidebar on large screens. */
export function DocsSidebar() {
  const pathname = usePathname() ?? "";
  return (
    <nav aria-label="Documentation" className="hidden w-60 shrink-0 pt-10 lg:block">
      <div className="sticky top-24 max-h-[calc(100vh-7rem)] overflow-y-auto pb-10 pr-2">
        <NavList pathname={pathname} />
      </div>
    </nav>
  );
}

/** Collapsible menu above the content on small screens (native <details>). */
export function DocsMobileNav() {
  const pathname = usePathname() ?? "";
  const current = DOCS_FLAT.find((i) => i.href === pathname);
  return (
    <details className="group mb-8 rounded-lg border border-border bg-card lg:hidden">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-sm font-medium text-foreground [&::-webkit-details-marker]:hidden">
        <span>
          <span className="text-muted-foreground">Docs menu</span>
          {current && <span className="ml-2">{current.title}</span>}
        </span>
        <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      <nav aria-label="Documentation" className="border-t border-border px-2 py-4">
        <NavList pathname={pathname} />
      </nav>
    </details>
  );
}
