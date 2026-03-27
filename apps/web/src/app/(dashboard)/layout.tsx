"use client";

import { useState } from "react";
import { Menu, X } from "lucide-react";
import { Sidebar } from "@/components/dashboard/sidebar";
import { SolanaWalletProvider } from "@/components/providers/solana-wallet-provider";
import { ThemeProvider } from "@/components/providers/theme-provider";
import { BrandingProvider } from "@/components/providers/branding-provider";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <ThemeProvider>
      <BrandingProvider>
        <SolanaWalletProvider>
          <div className="flex h-screen bg-gray-50 dark:bg-gray-950">
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
              <div className="flex items-center gap-3 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-4 py-3 md:hidden">
                <button
                  onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                  className="rounded-lg p-2 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
                  aria-label="Toggle menu"
                >
                  {mobileMenuOpen ? (
                    <X className="h-5 w-5" />
                  ) : (
                    <Menu className="h-5 w-5" />
                  )}
                </button>
                <span className="text-lg font-bold text-gray-900 dark:text-gray-100">WheelsAI</span>
              </div>

              <main className="flex-1 overflow-auto">{children}</main>
            </div>
          </div>
        </SolanaWalletProvider>
      </BrandingProvider>
    </ThemeProvider>
  );
}
