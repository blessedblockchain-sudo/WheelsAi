import { Sidebar } from "@/components/dashboard/sidebar";
import { SolanaWalletProvider } from "@/components/providers/solana-wallet-provider";
import { ThemeProvider } from "@/components/providers/theme-provider";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ThemeProvider>
      <SolanaWalletProvider>
        <div className="flex h-screen bg-gray-50 dark:bg-gray-950">
          <Sidebar />
          <main className="flex-1 overflow-auto">{children}</main>
        </div>
      </SolanaWalletProvider>
    </ThemeProvider>
  );
}
