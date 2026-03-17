import { Navbar } from "@/components/landing/navbar";
import { Hero } from "@/components/landing/hero";
import { SocialProof } from "@/components/landing/social-proof";
import { AgentAnimation } from "@/components/landing/agent-animation";
import { HowItWorks } from "@/components/landing/how-it-works";
import { FeaturesGrid } from "@/components/landing/features-grid";
import { CodePreview } from "@/components/landing/code-preview";
import { Frameworks } from "@/components/landing/frameworks";
import { Pricing } from "@/components/landing/pricing";
import { StatsSection } from "@/components/landing/stats-section";
import { FinalCTA } from "@/components/landing/final-cta";
import { Footer } from "@/components/landing/footer";

export default function HomePage() {
  return (
    <div className="min-h-screen bg-navy-950 text-white">
      <Navbar />
      <Hero />
      <SocialProof />
      <AgentAnimation />
      <HowItWorks />
      <FeaturesGrid />
      <CodePreview />
      <Frameworks />
      <StatsSection />
      <Pricing />
      <FinalCTA />
      <Footer />
    </div>
  );
}
