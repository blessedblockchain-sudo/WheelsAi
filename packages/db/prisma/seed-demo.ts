import { PrismaClient } from "@prisma/client";
import * as crypto from "crypto";

const prisma = new PrismaClient();

// Simple encryption helper (mirrors openclaw.ts)
function encryptConfig(data: Record<string, unknown>): string {
  const jwtSecret = process.env.JWT_SECRET || "dev-secret-key-change-in-production";
  const key = crypto.createHash("sha256").update(jwtSecret).digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  let encrypted = cipher.update(JSON.stringify(data), "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag();
  return iv.toString("hex") + ":" + tag.toString("hex") + ":" + encrypted;
}

async function main() {
  console.log("Seeding demo data for OpenClaw + Token Marketplace...\n");

  // 1. Create demo user + org
  const user = await prisma.user.upsert({
    where: { email: "demo@wheelsai.com" },
    update: {},
    create: {
      email: "demo@wheelsai.com",
      displayName: "Demo User",
      passwordHash: "$2b$10$placeholder", // not a real hash
      emailVerified: true,
      walletAddress: "DemoWa11etXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    },
  });
  console.log(`  User: ${user.email} (${user.id})`);

  const org = await prisma.organization.upsert({
    where: { id: user.id }, // use user id as org id for simplicity
    update: {},
    create: {
      id: user.id,
      name: "Demo Organization",
      ownerId: user.id,
    },
  });

  // Ensure org member exists
  await prisma.orgMember.upsert({
    where: { orgId_userId: { orgId: org.id, userId: user.id } },
    update: {},
    create: { orgId: org.id, userId: user.id, role: "owner" },
  });

  console.log(`  Org: ${org.name} (${org.id})\n`);

  // 2. Create demo agents for OpenClaw
  const openclawAgents = [
    {
      name: "Support Bot Alpha",
      slug: "support-bot-alpha",
      description: "Multi-channel customer support agent powered by Llama 3.1",
      systemPrompt: "You are a helpful customer support agent for a SaaS company.",
      framework: "openclaw",
      channels: ["discord", "telegram", "web"],
      status: "RUNNING" as const,
      healthStatus: "healthy",
    },
    {
      name: "Trading Signals Bot",
      slug: "trading-signals-bot",
      description: "Real-time crypto trading signals across Discord and Telegram",
      systemPrompt: "You analyze crypto markets and provide trading signals.",
      framework: "openclaw",
      channels: ["discord", "telegram"],
      status: "RUNNING" as const,
      healthStatus: "healthy",
    },
    {
      name: "Content Creator AI",
      slug: "content-creator-ai",
      description: "Generates social media content and schedules posts",
      systemPrompt: "You are a creative content assistant specializing in social media.",
      framework: "openclaw",
      channels: ["twitter", "slack"],
      status: "DEPLOYING" as const,
      healthStatus: null,
    },
    {
      name: "Research Assistant",
      slug: "research-assistant",
      description: "Deep research agent with web browsing and summarization",
      systemPrompt: "You are a thorough research assistant.",
      framework: "openclaw",
      channels: ["web", "api", "email"],
      status: "STOPPED" as const,
      healthStatus: null,
    },
  ];

  console.log("  Creating OpenClaw deployments...");
  for (const agentData of openclawAgents) {
    // Create Agent
    const agent = await prisma.agent.upsert({
      where: { orgId_slug: { orgId: org.id, slug: agentData.slug } },
      update: {},
      create: {
        orgId: org.id,
        name: agentData.name,
        slug: agentData.slug,
        description: agentData.description,
        systemPrompt: agentData.systemPrompt,
        framework: agentData.framework,
        sourceType: "inline",
        modelConfig: { model: "llama-3.1-8b", temperature: 0.7 },
      },
    });

    // Create OpenClaw deployment
    const deployment = await prisma.openClawDeployment.upsert({
      where: { agentId: agent.id },
      update: {
        status: agentData.status,
        healthStatus: agentData.healthStatus,
      },
      create: {
        agentId: agent.id,
        envEncrypted: encryptConfig({ OPENAI_API_KEY: "sk-demo-xxx", NODE_ENV: "production" }),
        status: agentData.status,
        publicUrl: agentData.status === "RUNNING" ? `${agentData.slug}.openclaw.wheelsai.com` : null,
        healthStatus: agentData.healthStatus,
        healthLastCheck: agentData.healthStatus ? new Date() : null,
      },
    });

    // Create channels
    for (const platform of agentData.channels) {
      const existing = await prisma.openClawChannel.findFirst({
        where: { deploymentId: deployment.id, platform },
      });
      if (!existing) {
        await prisma.openClawChannel.create({
          data: {
            deploymentId: deployment.id,
            platform,
            configEncrypted: encryptConfig({ token: `demo-${platform}-token`, enabled: true }),
            enabled: true,
          },
        });
      }
    }

    console.log(`    ${agentData.status.padEnd(10)} ${agentData.name} (${agentData.channels.join(", ")})`);
  }

  // 3. Create demo agents for Token Marketplace
  console.log("\n  Creating Token Marketplace listings...");

  const tokenAgents = [
    {
      name: "DeFi Oracle Agent",
      slug: "defi-oracle-agent",
      description: "Autonomous DeFi agent that monitors and reports on-chain data across 50+ protocols",
      category: "automation",
      token: {
        name: "DeFi Oracle",
        symbol: "DORC",
        status: "BONDING" as const,
        priceUsd: 0.000042,
        marketCapUsd: 33600,
        volume24h: 12500,
        holders: 847,
        mintAddress: "DorcXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      },
    },
    {
      name: "MEV Hunter Pro",
      slug: "mev-hunter-pro",
      description: "Advanced MEV detection and arbitrage agent with proven track record",
      category: "automation",
      token: {
        name: "MEV Hunter",
        symbol: "MEVH",
        status: "GRADUATED" as const,
        priceUsd: 0.0089,
        marketCapUsd: 890000,
        volume24h: 156000,
        holders: 3241,
        mintAddress: "MevhXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
        graduatedAt: new Date("2026-01-28"),
        raydiumPoolId: "RayPoolMevhXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      },
    },
    {
      name: "Social Sentiment AI",
      slug: "social-sentiment-ai",
      description: "Analyzes social media sentiment across Twitter, Discord, and Telegram for trading alpha",
      category: "research",
      token: {
        name: "Sentiment AI",
        symbol: "SENT",
        status: "BONDING" as const,
        priceUsd: 0.000018,
        marketCapUsd: 14400,
        volume24h: 4200,
        holders: 312,
        mintAddress: "SentXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      },
    },
    {
      name: "NFT Appraiser Bot",
      slug: "nft-appraiser-bot",
      description: "AI-powered NFT valuation engine using on-chain data and rarity analysis",
      category: "creative",
      token: {
        name: "NFT Appraiser",
        symbol: "NFTA",
        status: "BONDING" as const,
        priceUsd: 0.000067,
        marketCapUsd: 53600,
        volume24h: 28900,
        holders: 1523,
        mintAddress: "NftaXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      },
    },
    {
      name: "Code Auditor AI",
      slug: "code-auditor-ai",
      description: "Automated smart contract auditing agent with vulnerability detection",
      category: "coding",
      token: {
        name: "Code Auditor",
        symbol: "CAUD",
        status: "GRADUATED" as const,
        priceUsd: 0.0234,
        marketCapUsd: 2340000,
        volume24h: 445000,
        holders: 5872,
        mintAddress: "CaudXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
        graduatedAt: new Date("2026-02-05"),
        raydiumPoolId: "RayPoolCaudXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      },
    },
    {
      name: "Yield Optimizer",
      slug: "yield-optimizer",
      description: "Auto-compounds and rebalances DeFi yield strategies across Solana protocols",
      category: "automation",
      token: {
        name: "Yield Agent",
        symbol: "YELD",
        status: "FAILED" as const,
        priceUsd: 0.0000003,
        marketCapUsd: 240,
        volume24h: 12,
        holders: 43,
        mintAddress: "YeldXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      },
    },
  ];

  for (const agentData of tokenAgents) {
    // Create Agent
    const agent = await prisma.agent.upsert({
      where: { orgId_slug: { orgId: org.id, slug: agentData.slug } },
      update: {},
      create: {
        orgId: org.id,
        name: agentData.name,
        slug: agentData.slug,
        description: agentData.description,
        framework: "custom",
        sourceType: "inline",
        modelConfig: { model: "llama-3.1-8b" },
        isPublic: true,
      },
    });

    // Create AgentListing
    const listing = await prisma.agentListing.upsert({
      where: { agentId: agent.id },
      update: {},
      create: {
        agentId: agent.id,
        title: agentData.name,
        slug: agentData.slug,
        shortDescription: agentData.description.slice(0, 280),
        longDescription: agentData.description,
        category: agentData.category,
        // What these listings have always sold: a copy for the buyer.
        sells: "copies",
        pricingModel: "tokenized",
        publisherId: org.id,
        publisherName: org.name,
        status: "published",
        publishedAt: new Date("2026-01-15"),
        totalInstalls: Math.floor(Math.random() * 500) + 50,
        activeInstalls: Math.floor(Math.random() * 200) + 10,
        avgRating: 3.5 + Math.random() * 1.5,
        reviewCount: Math.floor(Math.random() * 50) + 5,
      },
    });

    // Create AgentToken
    const tokenData = agentData.token;
    const token = await prisma.agentToken.upsert({
      where: { agentListingId: listing.id },
      update: {
        priceUsd: tokenData.priceUsd,
        marketCapUsd: tokenData.marketCapUsd,
        volume24h: tokenData.volume24h,
        holders: tokenData.holders,
      },
      create: {
        agentListingId: listing.id,
        mintAddress: tokenData.mintAddress,
        pumpfunUrl: `https://pump.fun/coin/${tokenData.mintAddress}`,
        bondingCurveAddress: `BondCurve${tokenData.mintAddress.slice(0, 36)}`,
        creatorAddress: user.walletAddress!,
        name: tokenData.name,
        symbol: tokenData.symbol,
        imageUri: null,
        status: tokenData.status,
        priceUsd: tokenData.priceUsd,
        marketCapUsd: tokenData.marketCapUsd,
        volume24h: tokenData.volume24h,
        holders: tokenData.holders,
        graduatedAt: "graduatedAt" in tokenData ? (tokenData as any).graduatedAt : null,
        raydiumPoolId: "raydiumPoolId" in tokenData ? (tokenData as any).raydiumPoolId : null,
        creatorLockupEnd: "graduatedAt" in tokenData
          ? new Date(new Date((tokenData as any).graduatedAt).getTime() + 30 * 24 * 60 * 60 * 1000)
          : null,
      },
    });

    // Create sample trades
    const now = Date.now();
    const trades = [];
    for (let i = 0; i < 20; i++) {
      const isBuy = Math.random() > 0.4;
      const solAmount = Math.random() * 5 + 0.1;
      trades.push({
        tokenId: token.id,
        txSignature: `${tokenData.symbol}Tx${crypto.randomBytes(16).toString("hex")}`,
        traderAddress: `Trader${crypto.randomBytes(20).toString("hex").slice(0, 40)}`,
        side: isBuy ? "buy" : "sell",
        solAmount,
        tokenAmount: solAmount / (tokenData.priceUsd || 0.00001) * 0.01,
        priceUsd: tokenData.priceUsd * (0.8 + Math.random() * 0.4),
        timestamp: new Date(now - i * 3600000 - Math.random() * 3600000),
      });
    }
    await prisma.agentTokenTrade.createMany({ data: trades, skipDuplicates: true });

    // Create sample holders
    const holders = [];
    for (let i = 0; i < Math.min(tokenData.holders, 10); i++) {
      const balance = Math.random() * 10000000 + 100000;
      holders.push({
        tokenId: token.id,
        walletAddress: `Holder${crypto.randomBytes(20).toString("hex").slice(0, 40)}${i}`,
        balance,
        percentage: (balance / 1000000000) * 100,
      });
    }
    await prisma.agentTokenHolder.createMany({ data: holders, skipDuplicates: true });

    // Create price snapshots (24 hours of hourly data)
    const snapshots = [];
    let price = tokenData.priceUsd * 0.7;
    for (let i = 24; i >= 0; i--) {
      price = price * (0.95 + Math.random() * 0.12);
      snapshots.push({
        tokenId: token.id,
        priceUsd: price,
        marketCapUsd: price * 800000000,
        volume24h: tokenData.volume24h * (0.5 + Math.random()),
        holders: tokenData.holders - Math.floor(Math.random() * 50),
        timestamp: new Date(now - i * 3600000),
      });
    }
    await prisma.agentTokenSnapshot.createMany({ data: snapshots, skipDuplicates: true });

    const statusEmoji = tokenData.status === "GRADUATED" ? "🎓" : tokenData.status === "FAILED" ? "❌" : "📈";
    console.log(`    ${statusEmoji} $${tokenData.symbol.padEnd(5)} ${agentData.name.padEnd(25)} MCap: $${tokenData.marketCapUsd.toLocaleString()}`);
  }

  console.log("\n  Demo data seeded successfully!");
  console.log("\n  Summary:");
  console.log(`    OpenClaw deployments: ${openclawAgents.length}`);
  console.log(`    Token listings:       ${tokenAgents.length}`);
  console.log(`    Trades per token:     20`);
  console.log(`    Price snapshots:      25 per token (hourly)`);
  console.log("\n  Visit:");
  console.log("    http://localhost:3000/dashboard/openclaw");
  console.log("    http://localhost:3000/dashboard/marketplace/tokens");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
