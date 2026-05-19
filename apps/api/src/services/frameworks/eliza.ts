/**
 * ElizaOS character file parser (plan A10).
 *
 * Pure: takes a character.json (object or string) and returns the
 * deployment-relevant facts the launch wizard + OpenClaw job builder need
 * to provision a working agent. Validates required fields, normalizes
 * client aliases, infers clients from plugins, and lists every env var the
 * container will need before it boots.
 *
 * No IO. No dependence on Prisma, the Nosana SDK, or OpenClaw secrets —
 * those are layered on top in the deploy route.
 */

const SUPPORTED_CLIENTS = ["discord", "telegram", "slack", "twitter"] as const;
type SupportedClient = (typeof SUPPORTED_CLIENTS)[number];

const INBOUND_PLATFORMS: ReadonlySet<SupportedClient> = new Set([
  "discord",
  "telegram",
  "slack",
]);

const CLIENT_ALIASES: Record<string, SupportedClient> = {
  x: "twitter",
};

const PLUGIN_TO_CLIENT: Record<string, SupportedClient> = {
  "@elizaos/plugin-discord": "discord",
  "@elizaos/plugin-telegram": "telegram",
  "@elizaos/plugin-slack": "slack",
  "@elizaos/plugin-twitter": "twitter",
};

const MODEL_PROVIDER_ENV: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  groq: "GROQ_API_KEY",
  google: "GOOGLE_GEMINI_API_KEY",
  together: "TOGETHER_API_KEY",
};

const CLIENT_REQUIRED_ENV_VARS: Record<SupportedClient, readonly string[]> = {
  discord: ["DISCORD_API_TOKEN", "DISCORD_APPLICATION_ID"],
  telegram: ["TELEGRAM_BOT_TOKEN"],
  slack: ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"],
  twitter: ["TWITTER_USERNAME", "TWITTER_PASSWORD"],
};

export interface ChannelBinding {
  platform: SupportedClient;
  envKeys: readonly string[];
}

export interface ParsedCharacter {
  name: string;
  username: string | null;
  slug: string;
  clients: SupportedClient[];
  plugins: string[];
  modelProvider: string;
  requiredEnvVars: string[];
  channelBindings: ChannelBinding[];
  warnings: string[];
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseElizaCharacter(input: unknown): ParsedCharacter {
  let raw: unknown = input;
  if (typeof input === "string") {
    raw = JSON.parse(input);
  }
  if (!isPlainObject(raw)) {
    throw new Error("Eliza character must be a JSON object");
  }

  const name = raw.name;
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("Eliza character is missing a name");
  }

  const modelProvider = raw.modelProvider;
  if (typeof modelProvider !== "string" || !MODEL_PROVIDER_ENV[modelProvider]) {
    throw new Error(
      `Eliza character has unsupported modelProvider: ${String(modelProvider)}`,
    );
  }

  const username =
    typeof raw.username === "string" && raw.username.length > 0
      ? raw.username
      : null;

  const rawClientsValue = Array.isArray(raw.clients) ? raw.clients : [];
  const rawPluginsValue = Array.isArray(raw.plugins) ? raw.plugins : [];

  const plugins = rawPluginsValue.filter(
    (p): p is string => typeof p === "string",
  );

  const warnings: string[] = [];
  const clientSet = new Set<SupportedClient>();

  for (const c of rawClientsValue) {
    if (typeof c !== "string") continue;
    const normalized = c.toLowerCase();
    const aliased = CLIENT_ALIASES[normalized] ?? normalized;
    if ((SUPPORTED_CLIENTS as readonly string[]).includes(aliased)) {
      clientSet.add(aliased as SupportedClient);
    } else {
      warnings.push(`unsupported_client:${normalized}`);
    }
  }

  for (const plugin of plugins) {
    const inferred = PLUGIN_TO_CLIENT[plugin];
    if (inferred) clientSet.add(inferred);
  }

  const clients = Array.from(clientSet).sort();

  const envSet = new Set<string>();
  envSet.add(MODEL_PROVIDER_ENV[modelProvider]!);
  for (const c of clients) {
    for (const v of CLIENT_REQUIRED_ENV_VARS[c]) envSet.add(v);
  }

  const channelBindings: ChannelBinding[] = clients
    .filter((c): c is SupportedClient => INBOUND_PLATFORMS.has(c))
    .map((platform) => ({
      platform,
      envKeys: CLIENT_REQUIRED_ENV_VARS[platform],
    }));

  return {
    name,
    username,
    slug: slugify(username ?? name),
    clients,
    plugins: plugins.slice().sort(),
    modelProvider,
    requiredEnvVars: Array.from(envSet).sort(),
    channelBindings,
    warnings: warnings.sort(),
  };
}
