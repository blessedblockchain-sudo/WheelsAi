import { Cpu } from "lucide-react";
import Link from "next/link";

import { SolanaWalletProvider } from "@/components/providers/solana-wallet-provider";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <SolanaWalletProvider>
      <div className="flex min-h-screen flex-col items-center justify-center bg-gray-50 px-4">
        <Link href="/" className="mb-8 flex items-center gap-2">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary-600">
            <Cpu className="h-6 w-6 text-white" />
          </div>
          <span className="text-2xl font-bold">WheelsAI</span>
        </Link>
        {children}
      </div>
    </SolanaWalletProvider>
  );
}
