import type { Metadata } from "next";
import { Navbar } from "@/components/landing/navbar";
import { Footer } from "@/components/landing/footer";
import { ContactForm } from "./contact-form";

export const metadata: Metadata = {
  title: "Contact sales — WheelsAI",
  description:
    "Talk to the WheelsAI team about Enterprise: custom model hosting, white-label marketplace, SSO and audit logging, dedicated support and SLA, and volume pricing.",
};

export default function ContactPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <Navbar />
      <main className="mx-auto grid max-w-6xl gap-12 px-4 pb-24 pt-32 sm:px-6 lg:grid-cols-2 lg:px-8">
        <section>
          <h1 className="text-4xl font-semibold tracking-tight">Talk to us about Enterprise</h1>
          <p className="mt-4 text-lg text-muted-foreground">
            Everything in Pro, built for scale. Tell us what you are building and we will get back to you.
          </p>
          <ul className="mt-8 space-y-3 text-sm text-muted-foreground">
            {[
              "Custom model hosting on dedicated Nosana capacity",
              "White-label marketplace on your own domain",
              "SSO and audit logging",
              "Dedicated support and an uptime SLA",
              "Volume pricing on GPU time and API calls",
            ].map((item) => (
              <li key={item} className="flex gap-3">
                <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
                <span className="text-foreground">{item}</span>
              </li>
            ))}
          </ul>
        </section>
        <section>
          <ContactForm />
        </section>
      </main>
      <Footer />
    </div>
  );
}
