import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { Toaster } from "sonner";

import { Providers } from "@/components/providers";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: {
    default: "WheelsAI — Build, Deploy & Monetize AI Agents",
    template: "%s | WheelsAI",
  },
  description:
    "Solve AI agent fragmentation. Build with any framework, import from GitHub, deploy to 10+ channels, and earn 90% revenue on the marketplace.",
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
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || "https://wheelsai.io"),
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
    <html lang="en" className={`${inter.variable} dark`}>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <Providers>
          {children}
          <Toaster position="top-right" richColors />
        </Providers>
      </body>
    </html>
  );
}
