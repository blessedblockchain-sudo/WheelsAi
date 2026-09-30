import type { ReactNode } from "react";

import { Footer } from "@/components/landing/footer";
import { Navbar } from "@/components/landing/navbar";
import { SkipLink } from "@/components/marketing/skip-link";

/**
 * Shared chrome for the public site pages the footer links to (about, blog,
 * careers, changelog, status, templates, privacy, terms). The route group
 * does not change URLs.
 */
export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <SkipLink />
      <Navbar />
      <main id="main" className="flex-1">
        {children}
      </main>
      <Footer />
    </div>
  );
}
