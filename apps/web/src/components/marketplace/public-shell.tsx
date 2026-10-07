import Link from "next/link";
import { Cpu } from "lucide-react";

import { MarketplaceAuthNav } from "@/components/marketplace/auth-nav";

/** The public marketplace frame: the header and footer the browse and listing pages draw. */
export function MarketplacePublicShell({ children }: { children: React.ReactNode }) {
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
          <nav className="hidden items-center gap-6 md:flex">
            <Link href="/marketplace" className="text-sm font-medium text-primary-600">
              Marketplace
            </Link>
            <Link href="/docs" className="text-sm font-medium text-muted-foreground hover:text-foreground">
              Docs
            </Link>
          </nav>
          <MarketplaceAuthNav />
        </div>
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
