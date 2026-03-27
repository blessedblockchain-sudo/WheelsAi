"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  TrendingUp,
  Star,
  Download,
  Sparkles,
  Bot,
  Code,
  MessageSquare,
  Search,
  ArrowRight,
  Coins,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const categories = [
  { id: "all", label: "All Agents", icon: Bot },
  { id: "support", label: "Customer Support", icon: MessageSquare },
  { id: "development", label: "Development", icon: Code },
  { id: "research", label: "Research", icon: Search },
  { id: "trading", label: "Trading", icon: TrendingUp },
  { id: "creative", label: "Creative", icon: Sparkles },
];

// Placeholder data — will be populated from marketplace + token APIs
const featuredAgents = [
  {
    id: "1",
    name: "SupportBot Pro",
    description: "AI-powered customer support with multi-language capabilities",
    framework: "mastra",
    rating: 4.8,
    installs: 1240,
    pricing: "per-request",
    category: "support",
    hasToken: true,
    tokenStatus: "GRADUATED" as const,
    tokenPrice: 0.042,
  },
  {
    id: "2",
    name: "CodeReviewer AI",
    description: "Automated code review with security analysis and best practices",
    framework: "langchain",
    rating: 4.6,
    installs: 890,
    pricing: "subscription",
    category: "development",
    hasToken: true,
    tokenStatus: "BONDING" as const,
    tokenPrice: 0.018,
  },
  {
    id: "3",
    name: "ResearchAssistant",
    description: "Web research, summarization, and report generation",
    framework: "crewai",
    rating: 4.5,
    installs: 567,
    pricing: "free",
    category: "research",
    hasToken: false,
    tokenStatus: null,
    tokenPrice: null,
  },
  {
    id: "4",
    name: "TradingSignals",
    description: "Real-time market analysis with risk-adjusted trade signals",
    framework: "elizaos",
    rating: 4.9,
    installs: 2100,
    pricing: "subscription",
    category: "trading",
    hasToken: true,
    tokenStatus: "GRADUATED" as const,
    tokenPrice: 0.156,
  },
  {
    id: "5",
    name: "ContentCreator AI",
    description: "Blog posts, social media content, and SEO optimization",
    framework: "mastra",
    rating: 4.3,
    installs: 430,
    pricing: "per-request",
    category: "creative",
    hasToken: true,
    tokenStatus: "BONDING" as const,
    tokenPrice: 0.007,
  },
  {
    id: "6",
    name: "DevOps Agent",
    description: "Infrastructure monitoring, incident response, and deployment automation",
    framework: "autogen",
    rating: 4.7,
    installs: 720,
    pricing: "subscription",
    category: "development",
    hasToken: false,
    tokenStatus: null,
    tokenPrice: null,
  },
];

const frameworkBadgeColors: Record<string, string> = {
  mastra: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
  langchain: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
  autogen: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  elizaos: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300",
  crewai: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300",
  custom: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
};

export default function ExplorePage() {
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");

  const filtered = featuredAgents.filter((agent) => {
    if (selectedCategory !== "all" && agent.category !== selectedCategory) return false;
    if (searchQuery && !agent.name.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      {/* Hero */}
      <div className="bg-gradient-to-br from-primary-600 to-purple-700 py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 text-center">
          <h1 className="text-3xl sm:text-5xl font-bold text-white">
            Explore AI Agents
          </h1>
          <p className="mt-4 text-lg text-white/70 max-w-2xl mx-auto">
            Discover, install, and invest in AI agents built by the community.
            Find the perfect agent for your needs.
          </p>
          <div className="mt-8 max-w-md mx-auto">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400" />
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search agents..."
                className="w-full rounded-lg bg-white/10 backdrop-blur border border-white/20 px-10 py-3 text-white placeholder:text-white/50 focus:outline-none focus:ring-2 focus:ring-white/30"
              />
            </div>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
        {/* Category pills */}
        <div className="flex flex-wrap gap-2 mb-8">
          {categories.map((cat) => (
            <button
              key={cat.id}
              onClick={() => setSelectedCategory(cat.id)}
              className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-colors ${
                selectedCategory === cat.id
                  ? "bg-primary-600 text-white"
                  : "bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700"
              }`}
            >
              <cat.icon className="h-4 w-4" />
              {cat.label}
            </button>
          ))}
        </div>

        {/* Trending section */}
        <div className="mb-8">
          <div className="flex items-center gap-2 mb-4">
            <TrendingUp className="h-5 w-5 text-primary-600" />
            <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">Trending Agents</h2>
          </div>
        </div>

        {/* Agent grid */}
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((agent) => (
            <Card key={agent.id} className="transition-shadow hover:shadow-lg">
              <CardContent className="p-6">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary-100 dark:bg-primary-900/30">
                      <Bot className="h-5 w-5 text-primary-600 dark:text-primary-400" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-gray-900 dark:text-gray-100">{agent.name}</h3>
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium mt-1 ${frameworkBadgeColors[agent.framework] || frameworkBadgeColors.custom}`}>
                        {agent.framework}
                      </span>
                    </div>
                  </div>
                  {agent.hasToken && (
                    <div className="flex items-center gap-1">
                      <Coins className="h-4 w-4 text-yellow-500" />
                      <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
                        ${agent.tokenPrice?.toFixed(3)}
                      </span>
                    </div>
                  )}
                </div>

                <p className="text-sm text-gray-600 dark:text-gray-400 mb-4 line-clamp-2">
                  {agent.description}
                </p>

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4 text-sm text-gray-500 dark:text-gray-400">
                    <span className="flex items-center gap-1">
                      <Star className="h-3.5 w-3.5 text-yellow-500 fill-yellow-500" />
                      {agent.rating}
                    </span>
                    <span className="flex items-center gap-1">
                      <Download className="h-3.5 w-3.5" />
                      {agent.installs}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    {agent.hasToken && (
                      <Badge
                        variant={agent.tokenStatus === "GRADUATED" ? "success" : "warning"}
                        className="text-xs"
                      >
                        {agent.tokenStatus}
                      </Badge>
                    )}
                    <Badge variant="secondary" className="text-xs capitalize">
                      {agent.pricing}
                    </Badge>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {filtered.length === 0 && (
          <div className="text-center py-16">
            <Bot className="mx-auto h-12 w-12 text-gray-300 dark:text-gray-600" />
            <h3 className="mt-4 text-lg font-medium text-gray-900 dark:text-gray-100">No agents found</h3>
            <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
              Try adjusting your search or category filter.
            </p>
          </div>
        )}

        {/* CTA */}
        <div className="mt-16 text-center rounded-2xl bg-gradient-to-br from-primary-50 to-purple-50 dark:from-primary-900/20 dark:to-purple-900/20 p-12 border border-primary-100 dark:border-primary-800">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            Build Your Own Agent
          </h2>
          <p className="mt-2 text-gray-600 dark:text-gray-400">
            Import from GitHub, choose a framework, or start from a template.
            Earn 90% revenue on the marketplace.
          </p>
          <div className="mt-6 flex justify-center gap-4">
            <Link href="/register">
              <Button>
                Get Started Free
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
            <Link href="/marketplace">
              <Button variant="outline">Browse Marketplace</Button>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
