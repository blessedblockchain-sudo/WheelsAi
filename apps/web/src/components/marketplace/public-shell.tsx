import Link from "next/link";
import { Cpu } from "lucide-react";

import { MarketplaceAuthNav } from "@/components/marketplace/auth-nav";

type MarketplaceSection = "marketplace" | "leaderboard";

const NAV_LINKS: { id: MarketplaceSection | "docs"; label: string; href: string }[] = [
  { id: "marketplace", label: "Marketplace", href: "/marketplace" },
  { id: "leaderboard", label: "Leaderboard", href: "/marketplace/leaderboard" },
  { id: "docs", label: "Docs", href: "/docs" },
];

/** The public marketplace header links. Drawn twice: in the header from md up, in a row below it on phones. */
export function MarketplaceNavLinks({ current = "marketplace" }: { current?: MarketplaceSection }) {
  return (
    <>
      {NAV_LINKS.map((link) => (
        <Link
          key={link.id}
          href={link.href}
          aria-current={link.id === current ? "page" : undefined}
          className={
            link.id === current
              ? "text-sm font-medium text-primary-600"
              : "text-sm font-medium text-muted-foreground hover:text-foreground"
          }
        >
          {link.label}
        </Link>
      ))}
    </>
  );
}

/** The public marketplace frame: the header and footer the browse, listing and leaderboard pages draw. */
export function MarketplacePublicShell({
  children,
  current = "marketplace",
}: {
  children: React.ReactNode;
  current?: MarketplaceSection;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="border-b bg-card">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <Link href="/" className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-600">
              <Cpu className="h-5 w-5 text-white" />
            </div>
            <span className="text-xl font-bold">WheelsAI</span>
          </Link>
          <nav aria-label="Marketplace" className="hidden items-center gap-6 md:flex">
            <MarketplaceNavLinks current={current} />
          </nav>
          <MarketplaceAuthNav />
        </div>
        {/* The header row has no room for these on a phone, so they get a row of their own. */}
        <nav aria-label="Marketplace" className="flex items-center gap-6 border-t px-4 py-2 sm:px-6 md:hidden">
          <MarketplaceNavLinks current={current} />
        </nav>
      </header>
      <main className="flex-1">{children}</main>
      <footer className="border-t bg-card py-8">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded bg-primary-600">
              <Cpu className="h-4 w-4 text-white" />
            </div>
            <span className="font-semibold">WheelsAI</span>
          </div>
          <p className="text-sm text-muted-foreground">Built on Nosana. Powered by decentralized compute.</p>
        </div>
      </footer>
    </div>
  );
}
