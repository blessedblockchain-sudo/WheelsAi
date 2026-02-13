import { Navbar } from "@/components/landing/navbar";
import { Hero } from "@/components/landing/hero";
import { SocialProof } from "@/components/landing/social-proof";
import { FeaturesGrid } from "@/components/landing/features-grid";
import { HowItWorks } from "@/components/landing/how-it-works";
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
      <FeaturesGrid />
      <HowItWorks />
      <CodePreview />
      <Frameworks />
      <StatsSection />
      <Pricing />
      <FinalCTA />
      <Footer />
    </div>
  );
}
