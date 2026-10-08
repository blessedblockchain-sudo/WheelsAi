"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

import { featureFlags } from "@/lib/feature-flags";
import { locate, tabsNeedSearch } from "@/lib/nav";
import { cn } from "@/lib/utils";
import type { NavSearch } from "@/lib/nav";

const navOptions = { tokenUi: featureFlags.tokenUi };

/** How far from an edge the row fades, and how much room the current tab keeps from it. */
const EDGE = 24;

/**
 * The sibling pages of the current menu item, as links in one bar above the
 * page. Shown on a tab's own page only: detail and "new" pages, and items
 * with a single page, get nothing. These are links, not an ARIA tablist.
 *
 * Reads the query string, so mount it inside <Suspense> with
 * <SectionTabsFallback /> as the fallback.
 */
export function SectionTabs() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  return <SectionTabsBar pathname={pathname} search={searchParams} markCurrent />;
}

/**
 * The bar before the query string is known, so a hard load does not paint
 * the page and then push it down. Where the query string picks the tab, the
 * tabs are drawn without marking one.
 */
export function SectionTabsFallback() {
  const pathname = usePathname();
  return <SectionTabsBar pathname={pathname} search={null} markCurrent={!tabsNeedSearch(pathname)} />;
}

function SectionTabsBar({
  pathname,
  search,
  markCurrent,
}: {
  pathname: string;
  search: NavSearch;
  markCurrent: boolean;
}) {
  const location = locate(pathname, search, navOptions);
  const shown = location !== null && location.showTabs;
  const currentHref = shown && markCurrent ? location.tab?.href : undefined;

  const navRef = useRef<HTMLElement>(null);
  const [fade, setFade] = useState({ left: false, right: false });

  // On a phone the row scrolls sideways: bring the current tab into view, and
  // fade whichever edge has more tabs beyond it.
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;

    const current = nav.querySelector<HTMLElement>('[aria-current="page"]');
    if (current) {
      const row = nav.getBoundingClientRect();
      const tab = current.getBoundingClientRect();
      if (tab.left < row.left + EDGE) nav.scrollLeft -= row.left + EDGE - tab.left;
      else if (tab.right > row.right - EDGE) nav.scrollLeft += tab.right - (row.right - EDGE);
    }

    const measure = () => {
      const left = nav.scrollLeft > 1;
      const right = nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 1;
      setFade((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
    };
    measure();
    nav.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      nav.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, [shown, currentHref]);

  if (!shown) return null;
  const { item } = location;

  const mask =
    fade.left || fade.right
      ? `linear-gradient(to right, ${fade.left ? "transparent" : "black"}, black ${EDGE}px, black calc(100% - ${EDGE}px), ${fade.right ? "transparent" : "black"})`
      : undefined;

  return (
    <nav
      ref={navRef}
      aria-label={`${item.label} pages`}
      className="shrink-0 overflow-x-auto border-b border-border bg-card px-4 sm:px-8"
      style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
    >
      <ul className="flex items-center gap-1">
        {item.tabs.map((tab) => {
          const active = tab.href === currentHref;
          return (
            <li key={tab.href} className="shrink-0">
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex items-center whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors duration-150",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  active
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                )}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
