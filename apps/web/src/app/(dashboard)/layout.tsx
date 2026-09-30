"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { Sidebar } from "@/components/dashboard/sidebar";
import { SolanaWalletProvider } from "@/components/providers/solana-wallet-provider";
import { ThemeProvider } from "@/components/providers/theme-provider";
import { BrandingProvider } from "@/components/providers/branding-provider";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { VerifyEmailBanner } from "@/components/dashboard/verify-email-banner";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const pathname = usePathname();

  // The mobile drawer used to stay open over the page after navigating.
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!mobileMenuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileMenuOpen]);

  return (
    <ThemeProvider>
      <BrandingProvider>
        <SolanaWalletProvider>
          <ConfirmProvider>
            <div className="flex h-screen bg-background">
              {/* Desktop sidebar */}
              <div className="hidden md:block">
                <Sidebar />
              </div>

              {/* Mobile sidebar overlay */}
              {mobileMenuOpen && (
                <div className="fixed inset-0 z-40 md:hidden">
                  <div
                    className="fixed inset-0 bg-black/50"
                    onClick={() => setMobileMenuOpen(false)}
                  />
                  <div className="fixed inset-y-0 left-0 z-50 w-64">
                    <Sidebar />
                  </div>
                </div>
              )}

              {/* Main content */}
              <div className="flex flex-1 flex-col overflow-auto">
                {/* Mobile header with menu toggle */}
                <div className="flex items-center gap-3 border-b border-border bg-card px-4 py-3 md:hidden">
                  <button
                    onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                    className="rounded-lg p-2 text-muted-foreground hover:bg-muted"
                    aria-label="Toggle menu"
                  >
                    {mobileMenuOpen ? (
                      <X className="h-5 w-5" />
                    ) : (
                      <Menu className="h-5 w-5" />
                    )}
                  </button>
                  <span className="text-lg font-bold text-foreground">WheelsAI</span>
                </div>

                <VerifyEmailBanner />
                <main className="flex-1 overflow-auto">{children}</main>
              </div>
            </div>
          </ConfirmProvider>
        </SolanaWalletProvider>
      </BrandingProvider>
    </ThemeProvider>
  );
}
