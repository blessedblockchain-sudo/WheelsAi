"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Cpu, Menu, X } from "lucide-react";

export function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener("scroll", onScroll);
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const navLinks = [
    { href: "#features", label: "Features" },
    { href: "#how-it-works", label: "How It Works" },
    { href: "#frameworks", label: "Frameworks" },
    { href: "#pricing", label: "Pricing" },
    { href: "/explore", label: "Explore" },
    { href: "/marketplace", label: "Marketplace" },
  ];

  return (
    <nav
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
        scrolled
          ? "bg-navy-900/95 backdrop-blur-md border-b border-navy-600/50"
          : "bg-transparent"
      }`}
    >
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        {/* Logo */}
        <Link href="/" className="flex items-center gap-2 group">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-navy-400 transition-shadow group-hover:shadow-glow-navy">
            <Cpu className="h-5 w-5 text-white" />
          </div>
          <span className="text-xl font-bold text-white">WheelsAI</span>
        </Link>

        {/* Desktop Nav */}
        <div className="hidden md:flex items-center gap-8">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              prefetch={false}
              className="text-sm font-medium text-navy-200/70 hover:text-white transition-colors"
            >
              {link.label}
            </Link>
          ))}
        </div>

        {/* Desktop CTA */}
        <div className="hidden md:flex items-center gap-4">
          <Link
            href="/login"
            prefetch={false}
            className="text-sm font-medium text-navy-200/70 hover:text-white transition-colors"
          >
            Sign In
          </Link>
          <Link
            href="/waitlist"
            prefetch={false}
            className="btn-glow-navy text-sm h-9 px-5 py-2"
          >
            Get Started
          </Link>
        </div>

        {/* Mobile hamburger */}
        <button
          className="md:hidden text-white p-2"
          onClick={() => setMobileOpen(!mobileOpen)}
          aria-label="Toggle menu"
        >
          {mobileOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
        </button>
      </div>

      {/* Mobile Menu */}
      {mobileOpen && (
        <div className="md:hidden bg-navy-900/98 backdrop-blur-md border-t border-navy-600/50 px-4 py-6 space-y-4">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              prefetch={false}
              className="block text-sm font-medium text-navy-200/70 hover:text-white transition-colors py-2"
              onClick={() => setMobileOpen(false)}
            >
              {link.label}
            </Link>
          ))}
          <div className="pt-4 border-t border-navy-600/50 space-y-3">
            <Link
              href="/login"
              prefetch={false}
              className="block text-sm font-medium text-navy-200/70 hover:text-white"
            >
              Sign In
            </Link>
            <Link
              href="/waitlist"
              prefetch={false}
              className="btn-glow-navy text-sm h-9 px-5 py-2 w-full text-center"
            >
              Get Started
            </Link>
          </div>
        </div>
      )}
    </nav>
  );
}
