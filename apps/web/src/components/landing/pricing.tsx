import Link from "next/link";
import { Check, ArrowRight } from "lucide-react";

const tiers = [
  {
    name: "Starter",
    price: "Free",
    period: "",
    description: "Perfect for experimenting and prototyping.",
    features: [
      "Up to 3 agents",
      "1,000 API calls/month",
      "Free model access (Groq, Gemini)",
      "Community support",
      "Marketplace listing included",
    ],
    cta: "Get Started Free",
    href: "/register",
    popular: false,
  },
  {
    name: "Pro",
    price: "$49",
    period: "/mo",
    description: "For teams shipping production AI agents.",
    features: [
      "Unlimited agents",
      "100,000 API calls/month",
      "Priority model access",
      "Custom domains",
      "Advanced analytics",
      "Priority marketplace placement",
    ],
    cta: "Start Pro Trial",
    // Sign up, then land on billing, which starts Pro checkout (14-day trial).
    href: "/register?next=%2Fdashboard%2Fbilling%3Fupgrade%3Dpro",
    popular: true,
  },
  {
    name: "Enterprise",
    price: "Custom",
    period: "",
    description: "Everything in Pro, built for scale.",
    features: [
      "Everything in Pro",
      "Custom model hosting",
      "White-label marketplace",
      "Dedicated support & SLA",
      "SSO & audit logging",
      "Volume discounts",
    ],
    cta: "Contact Sales",
    href: "/contact",
    popular: false,
  },
];

export function Pricing() {
  return (
    <section id="pricing" className="relative bg-navy-950 py-24">
      <div className="absolute inset-0 grid-bg-navy pointer-events-none" />
      <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-16">
          <h2 className="text-3xl sm:text-4xl font-bold text-white">
            Simple, Transparent{" "}
            <span className="gradient-text-navy">Pricing</span>
          </h2>
          <p className="mt-4 text-lg text-navy-200/60 max-w-2xl mx-auto">
            Start free. Scale as you grow. No surprises.
          </p>
        </div>

        <div className="grid gap-8 lg:grid-cols-3 items-start">
          {tiers.map((tier) => (
            <div
              key={tier.name}
              className={
                tier.popular
                  ? "pricing-popular"
                  : "glow-card-navy p-8"
              }
            >
              {tier.popular && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-navy-400 px-4 py-1 text-xs font-bold text-white uppercase tracking-wider">
                  Most Popular
                </div>
              )}

              <h3 className="text-lg font-semibold text-white">{tier.name}</h3>
              <div className="mt-4 flex items-baseline gap-1">
                <span className="text-4xl font-bold text-white">{tier.price}</span>
                {tier.period && (
                  <span className="text-navy-200/50">{tier.period}</span>
                )}
              </div>
              <p className="mt-2 text-sm text-navy-200/50">{tier.description}</p>

              <ul className="mt-8 space-y-3">
                {tier.features.map((feature) => (
                  <li key={feature} className="flex items-center gap-3">
                    <Check className="h-4 w-4 text-navy-400 shrink-0" />
                    <span className="text-sm text-navy-200/70">{feature}</span>
                  </li>
                ))}
              </ul>

              <Link
                href={tier.href}
                prefetch={false}
                className={`mt-8 w-full flex items-center justify-center gap-2 rounded-lg px-6 py-3 text-sm font-semibold transition-all duration-300 ${
                  tier.popular
                    ? "btn-glow-navy"
                    : "bg-navy-700 text-white hover:bg-navy-600 border border-navy-600"
                }`}
              >
                {tier.cta}
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
