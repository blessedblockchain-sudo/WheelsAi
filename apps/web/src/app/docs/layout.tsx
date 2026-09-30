import type { Metadata } from "next";
import type { ReactNode } from "react";

import { Footer } from "@/components/landing/footer";
import { Navbar } from "@/components/landing/navbar";
import { DocsMobileNav, DocsSidebar } from "@/components/marketing/docs/sidebar";
import { SkipLink } from "@/components/marketing/skip-link";

export const metadata: Metadata = {
  title: {
    default: "Documentation",
    template: "%s | WheelsAI Docs",
  },
  description:
    "Guides, API reference and SDK documentation for WheelsAI: build, deploy and monetize AI agents on Nosana GPUs with Solana settlement.",
};

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <SkipLink />
      <Navbar />
      {/* The landing navbar is transparent white-on-navy until scrolled;
          this band keeps it legible in the light theme too. */}
      <div className="border-b border-navy-600/30 bg-navy-950 pt-16">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 text-sm sm:px-6 lg:px-8">
          <span className="font-semibold text-white">Docs</span>
          <span className="text-navy-200/40" aria-hidden="true">/</span>
          <span className="text-navy-200/70">Build, deploy and monetize on WheelsAI</span>
        </div>
      </div>
      <div className="mx-auto flex w-full max-w-7xl flex-1 gap-10 px-4 sm:px-6 lg:px-8">
        <DocsSidebar />
        <main id="main" className="min-w-0 flex-1 py-10">
          <DocsMobileNav />
          {children}
        </main>
      </div>
      <Footer />
    </div>
  );
}
