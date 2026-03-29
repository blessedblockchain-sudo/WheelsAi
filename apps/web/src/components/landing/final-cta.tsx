import Link from "next/link";
import { ArrowRight } from "lucide-react";

export function FinalCTA() {
  return (
    <section className="relative bg-navy-950 py-24 overflow-hidden">
      {/* Decorative blur orbs */}
      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-navy-400/10 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-1/4 right-1/4 w-72 h-72 bg-[#a855f7]/10 rounded-full blur-[100px] pointer-events-none" />

      <div className="relative mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 text-center">
        <h2 className="text-3xl sm:text-5xl font-bold text-white leading-tight">
          Ready to Build Your First{" "}
          <span className="gradient-text-navy">AI Agent</span>?
        </h2>
        <p className="mt-6 text-lg text-navy-200/60 max-w-2xl mx-auto">
          Turn your AI agent idea into a business. Pick a framework or import
          from GitHub, deploy everywhere, and start earning. No credit card required.
        </p>
        <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4">
          <Link
            href="/waitlist"
            prefetch={false}
            className="btn-glow-navy text-base px-10 py-4 h-auto"
          >
            Join the Beta
            <ArrowRight className="ml-2 h-5 w-5" />
          </Link>
          <Link
            href="/marketplace"
            prefetch={false}
            className="inline-flex items-center justify-center px-8 py-4 font-semibold text-navy-200 bg-transparent border border-navy-600 rounded-lg transition-all duration-300 hover:bg-navy-800 hover:border-navy-400"
          >
            Explore Marketplace
          </Link>
        </div>
      </div>
    </section>
  );
}
