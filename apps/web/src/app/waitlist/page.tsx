"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, Rocket, Zap, Shield, Users, Send } from "lucide-react";

const freeTierFeatures = [
  "Up to 3 agents",
  "1,000 API calls/month",
  "Free model access (Groq, Gemini)",
  "Agent playground for testing",
  "Marketplace listing included",
  "Community support",
];

const platformFees = [
  { label: "Marketplace Revenue", value: "10% platform fee", detail: "You keep 90% of all earnings" },
  { label: "Token Trading", value: "1% swap fee", detail: "Applied on bonding curve trades" },
  { label: "Compute", value: "Usage-based", detail: "Pay only for what you use, starting at $0.15/hr" },
];

const useCaseOptions = [
  "Customer Support Agents",
  "Code Review / Development Tools",
  "Research & Analysis",
  "Content Generation",
  "Trading / DeFi Agents",
  "Multi-Agent Orchestration",
  "Enterprise Internal Tools",
  "Other",
];

export default function WaitlistPage() {
  const [formData, setFormData] = useState({
    email: "",
    name: "",
    company: "",
    useCase: "",
    otherUseCase: "",
    teamSize: "",
    agentCount: "",
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.email || !formData.useCase) return;

    setIsSubmitting(true);

    // Store in localStorage as fallback (will be replaced with API endpoint)
    try {
      const existing = JSON.parse(localStorage.getItem("wheelsai_waitlist") || "[]");
      existing.push({ ...formData, submittedAt: new Date().toISOString() });
      localStorage.setItem("wheelsai_waitlist", JSON.stringify(existing));
    } catch {
      // ignore storage errors
    }

    // Simulate API call delay
    await new Promise((r) => setTimeout(r, 800));
    setIsSubmitting(false);
    setIsSubmitted(true);
  };

  if (isSubmitted) {
    return (
      <div className="min-h-screen bg-navy-950 flex items-center justify-center px-4">
        <div className="max-w-md text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-500/20 mb-6">
            <Check className="h-8 w-8 text-green-400" />
          </div>
          <h1 className="text-3xl font-bold text-white">You&apos;re on the list!</h1>
          <p className="mt-4 text-lg text-navy-200/60">
            We&apos;ll reach out to <span className="text-white font-medium">{formData.email}</span> when
            your beta access is ready. Early testers get extended free tier limits.
          </p>
          <div className="mt-8 flex flex-col gap-3">
            <Link
              href="/"
              className="inline-flex items-center justify-center px-6 py-3 font-semibold text-navy-200 border border-navy-600 rounded-lg hover:bg-navy-800 transition-colors"
            >
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Home
            </Link>
            <Link
              href="/explore"
              className="text-sm text-navy-400 hover:text-navy-300 transition-colors"
            >
              Explore agents while you wait
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-navy-950">
      {/* Header */}
      <div className="border-b border-navy-600/30 bg-navy-900/50 backdrop-blur">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-4 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2 text-white font-bold text-xl">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-600">
              <Zap className="h-5 w-5 text-white" />
            </div>
            WheelsAI
          </Link>
          <Link
            href="/"
            className="text-sm text-navy-200/60 hover:text-white transition-colors"
          >
            <ArrowLeft className="inline mr-1 h-4 w-4" />
            Back
          </Link>
        </div>
      </div>

      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8 py-16">
        <div className="grid gap-12 lg:grid-cols-2">
          {/* Left: Info */}
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-navy-600 bg-navy-900/80 px-4 py-1.5 text-sm text-navy-200/80 mb-6">
              <Rocket className="h-4 w-4 text-navy-400" />
              Beta Access
            </div>

            <h1 className="text-3xl sm:text-4xl font-bold text-white leading-tight">
              Join the WheelsAI{" "}
              <span className="gradient-text-navy">Beta Waitlist</span>
            </h1>

            <p className="mt-4 text-lg text-navy-200/60">
              Be among the first to build, deploy, and monetize AI agents on our platform.
              Early testers get extended free tier limits and priority support.
            </p>

            {/* Free Tier */}
            <div className="mt-10">
              <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                <Shield className="h-5 w-5 text-navy-400" />
                Free Tier Includes
              </h2>
              <ul className="mt-4 space-y-3">
                {freeTierFeatures.map((feature) => (
                  <li key={feature} className="flex items-center gap-3">
                    <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-navy-400/10 border border-navy-400/30">
                      <Check className="h-3 w-3 text-navy-400" />
                    </div>
                    <span className="text-sm text-navy-200/70">{feature}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Platform Fees */}
            <div className="mt-10">
              <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                <Users className="h-5 w-5 text-navy-400" />
                Platform Fees
              </h2>
              <div className="mt-4 space-y-3">
                {platformFees.map((fee) => (
                  <div
                    key={fee.label}
                    className="flex items-center justify-between rounded-lg border border-navy-600/30 bg-navy-900/50 px-4 py-3"
                  >
                    <div>
                      <div className="text-sm font-medium text-white">{fee.label}</div>
                      <div className="text-xs text-navy-200/50">{fee.detail}</div>
                    </div>
                    <span className="text-sm font-semibold text-navy-400">{fee.value}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Right: Form */}
          <div>
            <div className="rounded-2xl border border-navy-600/30 bg-navy-900/50 p-8">
              <h2 className="text-xl font-bold text-white mb-6">
                Request Beta Access
              </h2>

              <form onSubmit={handleSubmit} className="space-y-5">
                <div>
                  <label className="block text-sm font-medium text-navy-200/80 mb-1">
                    Email *
                  </label>
                  <input
                    type="email"
                    required
                    value={formData.email}
                    onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                    placeholder="you@company.com"
                    className="w-full rounded-lg border border-navy-600/50 bg-navy-800/50 px-4 py-2.5 text-white placeholder:text-navy-200/30 focus:border-navy-400 focus:outline-none focus:ring-1 focus:ring-navy-400"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-navy-200/80 mb-1">
                    Full Name
                  </label>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    placeholder="Jane Smith"
                    className="w-full rounded-lg border border-navy-600/50 bg-navy-800/50 px-4 py-2.5 text-white placeholder:text-navy-200/30 focus:border-navy-400 focus:outline-none focus:ring-1 focus:ring-navy-400"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-navy-200/80 mb-1">
                    Company / Project
                  </label>
                  <input
                    type="text"
                    value={formData.company}
                    onChange={(e) => setFormData({ ...formData, company: e.target.value })}
                    placeholder="Acme Inc. or My AI Project"
                    className="w-full rounded-lg border border-navy-600/50 bg-navy-800/50 px-4 py-2.5 text-white placeholder:text-navy-200/30 focus:border-navy-400 focus:outline-none focus:ring-1 focus:ring-navy-400"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-navy-200/80 mb-1">
                    What will you build? *
                  </label>
                  <select
                    required
                    value={formData.useCase}
                    onChange={(e) => setFormData({ ...formData, useCase: e.target.value })}
                    className="w-full rounded-lg border border-navy-600/50 bg-navy-800/50 px-4 py-2.5 text-white focus:border-navy-400 focus:outline-none focus:ring-1 focus:ring-navy-400 appearance-none"
                  >
                    <option value="" disabled>Select your primary use case</option>
                    {useCaseOptions.map((opt) => (
                      <option key={opt} value={opt} className="bg-navy-800">{opt}</option>
                    ))}
                  </select>
                </div>

                {formData.useCase === "Other" && (
                  <div>
                    <label className="block text-sm font-medium text-navy-200/80 mb-1">
                      Describe your use case
                    </label>
                    <textarea
                      value={formData.otherUseCase}
                      onChange={(e) => setFormData({ ...formData, otherUseCase: e.target.value })}
                      placeholder="Tell us what you're building..."
                      rows={3}
                      className="w-full rounded-lg border border-navy-600/50 bg-navy-800/50 px-4 py-2.5 text-white placeholder:text-navy-200/30 focus:border-navy-400 focus:outline-none focus:ring-1 focus:ring-navy-400"
                    />
                  </div>
                )}

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-navy-200/80 mb-1">
                      Team Size
                    </label>
                    <select
                      value={formData.teamSize}
                      onChange={(e) => setFormData({ ...formData, teamSize: e.target.value })}
                      className="w-full rounded-lg border border-navy-600/50 bg-navy-800/50 px-4 py-2.5 text-white focus:border-navy-400 focus:outline-none focus:ring-1 focus:ring-navy-400 appearance-none"
                    >
                      <option value="" className="bg-navy-800">Select</option>
                      <option value="solo" className="bg-navy-800">Solo / Indie</option>
                      <option value="2-5" className="bg-navy-800">2-5</option>
                      <option value="6-20" className="bg-navy-800">6-20</option>
                      <option value="20+" className="bg-navy-800">20+</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-navy-200/80 mb-1">
                      Agents to Deploy
                    </label>
                    <select
                      value={formData.agentCount}
                      onChange={(e) => setFormData({ ...formData, agentCount: e.target.value })}
                      className="w-full rounded-lg border border-navy-600/50 bg-navy-800/50 px-4 py-2.5 text-white focus:border-navy-400 focus:outline-none focus:ring-1 focus:ring-navy-400 appearance-none"
                    >
                      <option value="" className="bg-navy-800">Select</option>
                      <option value="1-3" className="bg-navy-800">1-3</option>
                      <option value="4-10" className="bg-navy-800">4-10</option>
                      <option value="10+" className="bg-navy-800">10+</option>
                    </select>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={isSubmitting || !formData.email || !formData.useCase}
                  className="btn-glow-navy w-full text-base py-3 h-auto disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isSubmitting ? (
                    <span className="flex items-center justify-center gap-2">
                      <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                      Submitting...
                    </span>
                  ) : (
                    <span className="flex items-center justify-center gap-2">
                      <Send className="h-4 w-4" />
                      Join the Waitlist
                    </span>
                  )}
                </button>

                <p className="text-xs text-navy-200/40 text-center">
                  No spam. We&apos;ll only email you about your beta access.
                </p>
              </form>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
