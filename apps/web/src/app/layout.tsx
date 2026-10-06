import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { Toaster } from "sonner";

import { Providers } from "@/components/providers";
import { siteMetadataBase } from "@/lib/public-urls";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

// Monospace for numbers, addresses and code (Tailwind `font-mono`).
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: {
    default: "WheelsAI — Build, Deploy & Monetize AI Agents",
    template: "%s | WheelsAI",
  },
  description:
    "Solve AI agent fragmentation. Build with any framework, import from GitHub, deploy on decentralized GPU, and monetize with on-chain receipts.",
  keywords: [
    "AI agents",
    "agent marketplace",
    "Mastra",
    "ElizaOS",
    "LangChain",
    "Solana",
    "bonding curve",
    "deploy AI",
    "monetize AI",
  ],
  metadataBase: siteMetadataBase(process.env.NEXT_PUBLIC_APP_URL),
  openGraph: {
    type: "website",
    siteName: "WheelsAI",
    title: "WheelsAI — Build, Deploy & Monetize AI Agents",
    description:
      "One platform to build, deploy, and monetize AI agents. No fragmentation.",
    images: ["/api/og"],
  },
  twitter: {
    card: "summary_large_image",
    title: "WheelsAI — Build, Deploy & Monetize AI Agents",
    description:
      "One platform to build, deploy, and monetize AI agents. No fragmentation.",
    images: ["/api/og"],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable} dark`}>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <Providers>
          {children}
          <Toaster position="top-right" richColors theme="dark" />
        </Providers>
      </body>
    </html>
  );
}
