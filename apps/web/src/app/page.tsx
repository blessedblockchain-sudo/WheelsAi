import type { Metadata } from "next";
import { Navbar } from "@/components/landing/navbar";
import { Hero } from "@/components/landing/hero";
import { SocialProof } from "@/components/landing/social-proof";
import { ProductTypes } from "@/components/landing/product-types";
import { AgentAnimation } from "@/components/landing/agent-animation";
import { HowItWorks } from "@/components/landing/how-it-works";
import { FeaturesGrid } from "@/components/landing/features-grid";
import { CodePreview } from "@/components/landing/code-preview";
import { Frameworks } from "@/components/landing/frameworks";
import { Pricing } from "@/components/landing/pricing";
import { StatsSection } from "@/components/landing/stats-section";
import { FinalCTA } from "@/components/landing/final-cta";
import { Footer } from "@/components/landing/footer";

export const metadata: Metadata = {
  title: "WheelsAI — Build, Deploy & Monetize AI Agents, Workflows and Models",
  description:
    "One platform for AI agents, workflows, small language models and fine-tuning. Build in any framework, deploy on decentralized per-second GPU, and monetize each product with verifiable on-chain receipts.",
};

export default function HomePage() {
  return (
    <div className="min-h-screen bg-navy-950 text-white">
      <Navbar />
      <main>
        <Hero />
        <SocialProof />
        <ProductTypes />
        <div className="hidden md:block">
          <AgentAnimation />
        </div>
        <HowItWorks />
        <FeaturesGrid />
        <CodePreview />
        <Frameworks />
        <StatsSection />
        <Pricing />
        <FinalCTA />
      </main>
      <Footer />
    </div>
  );
}
