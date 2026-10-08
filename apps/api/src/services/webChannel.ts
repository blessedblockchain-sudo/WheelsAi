/**
 * The web chat channel, from its owner's side: the publishable keys an
 * organization creates for its agents, the origins each may be used from,
 * its limits and its look.
 *
 * Every function takes the caller's organization and scopes every read and
 * write by it; a key of another organization is "not found", never
 * "forbidden". What a visitor's browser does with a key is
 * services/publicChat.ts.
 *
 * A key is public: it is printed in the snippet an owner pastes into their
 * site. Rotating it is how an owner takes a snippet out of circulation, and
 * revoking is permanent (the row stays, so its conversations keep their
 * source).
 *
 * Pure core: the database surface, the limiter read, the plan lookup and the
 * snippet's two addresses are dependencies (routes/webChannelBindings.ts
 * binds the real ones).
 */

import { z } from "zod";

import { createLogger } from "../utils/logger.js";
import type { FailClosedLimiter } from "./failClosedLimiter.js";
import { publicChatKeys, utcDay } from "./publicChat.js";
import { generatePublicKey, MAX_ALLOWED_ORIGINS, normalizeOrigin } from "./widgetKeys.js";

const logger = createLogger("web-channel");

/** Live (unrevoked) keys one agent may have. */
export const MAX_KEYS_PER_AGENT = 20;

export const WIDGET_POSITIONS = ["bottom-right", "bottom-left"] as const;
export type WidgetPosition = (typeof WIDGET_POSITIONS)[number];

// ============================================
// Requests
// ============================================

const appearanceSchema = z
  .object({
    title: z.string().trim().min(1).max(60).nullable().optional(),
    greeting: z.string().trim().min(1).max(500).nullable().optional(),
    primaryColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, "write the colour as #RRGGBB")
      .nullable()
      .optional(),
    position: z.enum(WIDGET_POSITIONS).optional(),
  })
  .strict();

const originsSchema = z.array(z.string().max(300)).max(MAX_ALLOWED_ORIGINS);

const keyFields = {
  name: z.string().trim().min(1).max(80),
  /** Empty is allowed and means "no site yet": only the dashboard preview works. */
  allowedOrigins: originsSchema,
  /** null = the platform's default. */
  dailyMessageCap: z.number().int().min(1).max(100_000).nullable(),
  perIpPerMinute: z.number().int().min(1).max(60).nullable(),
  appearance: appearanceSchema,
  storeTranscripts: z.boolean(),
  hideBranding: z.boolean(),
};

export const createWebKeySchema = z
  .object({
    agentId: z.string().uuid(),
    name: keyFields.name,
    allowedOrigins: keyFields.allowedOrigins.default([]),
    dailyMessageCap: keyFields.dailyMessageCap.optional(),
    perIpPerMinute: keyFields.perIpPerMinute.optional(),
    appearance: keyFields.appearance.optional(),
    storeTranscripts: keyFields.storeTranscripts.optional(),
    hideBranding: keyFields.hideBranding.optional(),
  })
  .strict();

export const updateWebKeySchema = z
  .object({
    name: keyFields.name.optional(),
    allowedOrigins: keyFields.allowedOrigins.optional(),
    dailyMessageCap: keyFields.dailyMessageCap.optional(),
    perIpPerMinute: keyFields.perIpPerMinute.optional(),
    appearance: keyFields.appearance.optional(),
    storeTranscripts: keyFields.storeTranscripts.optional(),
    hideBranding: keyFields.hideBranding.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export type CreateWebKeyInput = z.infer<typeof createWebKeySchema>;
export type UpdateWebKeyInput = z.infer<typeof updateWebKeySchema>;

// ============================================
// Rows and DTOs
// ============================================

export const WEB_KEY_COLUMNS = {
  id: true,
  agentId: true,
  publicKey: true,
  name: true,
  allowedOrigins: true,
  dailyMessageCap: true,
  perIpPerMinute: true,
  title: true,
  greeting: true,
  primaryColor: true,
  position: true,
  storeTranscripts: true,
  hideBranding: true,
  enabled: true,
  revokedAt: true,
  lastUsedAt: true,
  pageOfAgentId: true,
  createdAt: true,
  agent: { select: { name: true } },
} as const;

export interface WebKeyRow {
  id: string;
  agentId: string;
  publicKey: string;
  name: string;
  allowedOrigins: string[];
  dailyMessageCap: number | null;
  perIpPerMinute: number | null;
  title: string | null;
  greeting: string | null;
  primaryColor: string | null;
  position: string;
  storeTranscripts: boolean;
  hideBranding: boolean;
  enabled: boolean;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  /** The agent whose public page this key serves; null on a key made for a website. */
  pageOfAgentId?: string | null;
  createdAt: Date;
  agent: { name: string };
}

export interface WidgetKeyDto {
  id: string;
  agentId: string;
  agentName: string;
  name: string;
  publicKey: string;
  allowedOrigins: string[];
  /** null = the platform default (`defaults.dailyMessageCap` of a listing). */
  dailyMessageCap: number | null;
  perIpPerMinute: number | null;
  appearance: {
    title: string | null;
    greeting: string | null;
    primaryColor: string | null;
    position: WidgetPosition;
  };
  storeTranscripts: boolean;
  hideBranding: boolean;
  enabled: boolean;
  revokedAt: string | null;
  lastUsedAt: string | null;
  /**
   * Set on the one key that serves an agent's public page (/a/<handle>), to
   * that agent's id; null on a key made for a website. Pausing it here pauses
   * public use of the page (services/agentPublicLink.ts).
   */
  pageOfAgentId: string | null;
  createdAt: string;
  /** Messages counted today (UTC); null when the count cannot be read. */
  usageToday: number | null;
  snippet: string | null;
  snippetUnavailableReason: string | null;
}

interface KeyWriteData {
  name?: string;
  allowedOrigins?: string[];
  dailyMessageCap?: number | null;
  perIpPerMinute?: number | null;
  title?: string | null;
  greeting?: string | null;
  primaryColor?: string | null;
  position?: string;
  storeTranscripts?: boolean;
  hideBranding?: boolean;
  enabled?: boolean;
  publicKey?: string;
  revokedAt?: Date;
  /** Only ever cleared here, and only by a revoke. */
  pageOfAgentId?: null;
}

/** The slice of Prisma the owner routes touch. */
export interface WebChannelDb {
  agent: {
    findFirst(args: {
      where: { id: string; orgId: string };
      select: { id: true; name: true };
    }): Promise<{ id: string; name: string } | null>;
  };
  widgetKey: {
    findMany(args: {
      where: { orgId: string; agentId?: string; revokedAt?: null };
      orderBy: { createdAt: "desc" };
      select: typeof WEB_KEY_COLUMNS;
    }): Promise<WebKeyRow[]>;
    findFirst(args: { where: { id: string; orgId: string }; select: typeof WEB_KEY_COLUMNS }): Promise<WebKeyRow | null>;
    count(args: { where: { orgId: string; agentId: string; revokedAt: null } }): Promise<number>;
    create(args: {
      data: KeyWriteData & { orgId: string; agentId: string; publicKey: string; name: string };
      select: typeof WEB_KEY_COLUMNS;
    }): Promise<WebKeyRow>;
    updateMany(args: {
      where: { id: string; orgId: string; revokedAt: null; publicKey?: string };
      data: KeyWriteData;
    }): Promise<{ count: number }>;
  };
}

export interface WebChannelDeps {
  db: WebChannelDb;
  limiter: Pick<FailClosedLimiter, "peek">;
  /** Whether the organization's plan lets it hide "Powered by WheelsAI". */
  whiteLabel(orgId: string): Promise<boolean>;
  /**
   * Where the snippet loads the script from and sends chats to; null when
   * this server was not told (then no snippet is made up).
   */
  snippet: { webUrl: string | null; apiUrl: string | null };
  /** A key's messages a day when its owner set no cap. */
  defaultDailyCap: number;
  generatePublicKey?: () => string;
  now?: () => Date;
}

export class WebChannelError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "WebChannelError";
  }
}

const keyNotFound = () => new WebChannelError(404, "widget_key_not_found", "No such web chat key.");

// ============================================
// Snippet
// ============================================

const attr = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const trimSlash = (url: string) => url.replace(/\/+$/, "");

/**
 * The tag an owner pastes into their site. Built here, from this server's
 * own addresses, so the dashboard never assembles one from where the browser
 * happens to be.
 */
export const EMBED_SNIPPET_UNAVAILABLE = "The embed snippet is temporarily unavailable. Try again later.";

let snippetWarningLogged = false;

export function embedSnippet(
  publicKey: string,
  addresses: WebChannelDeps["snippet"],
): { snippet: string | null; reason: string | null } {
  if (!addresses.webUrl || !addresses.apiUrl) {
    const missing = [!addresses.webUrl && "PUBLIC_WEB_URL", !addresses.apiUrl && "PUBLIC_API_URL"].filter(Boolean);
    // The setting is the operator's; the owner reads one calm sentence.
    if (!snippetWarningLogged) {
      snippetWarningLogged = true;
      logger.warn({ missing }, `Web chat embed snippets are off: ${missing.join(" and ")} not set`);
    }
    return { snippet: null, reason: EMBED_SNIPPET_UNAVAILABLE };
  }
  return {
    snippet: `<script src="${attr(trimSlash(addresses.webUrl))}/widget.js" data-wheelsai-key="${attr(
      publicKey,
    )}" data-api="${attr(trimSlash(addresses.apiUrl))}" async></script>`,
    reason: null,
  };
}

// ============================================
// Helpers
// ============================================

/** Canonical, de-duplicated origins; the first one that is not an origin is the error. */
export function normalizeOrigins(origins: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const entry of origins) {
    const normalized = normalizeOrigin(entry);
    if (!normalized.ok) {
      throw new WebChannelError(400, "invalid_origin", `"${entry}": ${normalized.message}`, {
        origin: entry,
        reason: normalized.reason,
      });
    }
    seen.add(normalized.origin);
  }
  return [...seen];
}

async function toDto(deps: WebChannelDeps, row: WebKeyRow, day: string): Promise<WidgetKeyDto> {
  const revoked = row.revokedAt !== null;
  const { snippet, reason } = revoked
    ? { snippet: null, reason: "This key was revoked." }
    : embedSnippet(row.publicKey, deps.snippet);
  return {
    id: row.id,
    agentId: row.agentId,
    agentName: row.agent.name,
    name: row.name,
    publicKey: row.publicKey,
    allowedOrigins: row.allowedOrigins,
    dailyMessageCap: row.dailyMessageCap,
    perIpPerMinute: row.perIpPerMinute,
    appearance: {
      title: row.title,
      greeting: row.greeting,
      primaryColor: row.primaryColor,
      position: row.position === "bottom-left" ? "bottom-left" : "bottom-right",
    },
    storeTranscripts: row.storeTranscripts,
    hideBranding: row.hideBranding,
    enabled: row.enabled,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    pageOfAgentId: row.pageOfAgentId ?? null,
    createdAt: row.createdAt.toISOString(),
    // The same key the chat counts on (publicChat.ts). Unreadable is null.
    usageToday: await deps.limiter.peek(publicChatKeys.widgetKeyDay(row.id, day)),
    snippet,
    snippetUnavailableReason: reason,
  };
}

const today = (deps: WebChannelDeps) => utcDay((deps.now ?? (() => new Date()))());

async function assertMayHideBranding(deps: WebChannelDeps, orgId: string): Promise<void> {
  if (await deps.whiteLabel(orgId)) return;
  throw new WebChannelError(
    403,
    "plan_limit_reached",
    'Hiding "Powered by WheelsAI" is part of white-labelling, which the Enterprise plan includes.',
    { feature: "whiteLabel" },
  );
}

function appearanceData(appearance: UpdateWebKeyInput["appearance"]): KeyWriteData {
  if (!appearance) return {};
  return {
    ...(appearance.title !== undefined && { title: appearance.title }),
    ...(appearance.greeting !== undefined && { greeting: appearance.greeting }),
    ...(appearance.primaryColor !== undefined && {
      primaryColor: appearance.primaryColor === null ? null : appearance.primaryColor.toLowerCase(),
    }),
    ...(appearance.position !== undefined && { position: appearance.position }),
  };
}

// ============================================
// Operations
// ============================================

export interface WebKeyList {
  keys: WidgetKeyDto[];
  defaults: { dailyMessageCap: number };
  /** Whether this organization's plan may hide "Powered by WheelsAI". */
  whiteLabel: boolean;
}

export async function listWebKeys(
  deps: WebChannelDeps,
  orgId: string,
  filter: { agentId?: string; includeRevoked?: boolean } = {},
): Promise<WebKeyList> {
  const [rows, whiteLabel] = await Promise.all([
    deps.db.widgetKey.findMany({
      where: {
        orgId,
        ...(filter.agentId && { agentId: filter.agentId }),
        ...(!filter.includeRevoked && { revokedAt: null }),
      },
      orderBy: { createdAt: "desc" },
      select: WEB_KEY_COLUMNS,
    }),
    deps.whiteLabel(orgId),
  ]);
  const day = today(deps);
  return {
    keys: await Promise.all(rows.map((row) => toDto(deps, row, day))),
    defaults: { dailyMessageCap: deps.defaultDailyCap },
    whiteLabel,
  };
}

export async function getWebKey(deps: WebChannelDeps, orgId: string, id: string): Promise<WidgetKeyDto> {
  const row = await deps.db.widgetKey.findFirst({ where: { id, orgId }, select: WEB_KEY_COLUMNS });
  if (!row) throw keyNotFound();
  return toDto(deps, row, today(deps));
}

export async function createWebKey(deps: WebChannelDeps, orgId: string, input: CreateWebKeyInput): Promise<WidgetKeyDto> {
  // The agent is looked up in the caller's organization: a key can only
  // ever be made for an agent of the organization that makes it.
  const agent = await deps.db.agent.findFirst({ where: { id: input.agentId, orgId }, select: { id: true, name: true } });
  if (!agent) throw new WebChannelError(404, "agent_not_found", "No such agent.");

  const allowedOrigins = normalizeOrigins(input.allowedOrigins);
  if (input.hideBranding) await assertMayHideBranding(deps, orgId);

  // Not atomic with the insert: two requests at once can leave an agent one
  // key over. The number bounds a list, it guards nothing.
  const live = await deps.db.widgetKey.count({ where: { orgId, agentId: agent.id, revokedAt: null } });
  if (live >= MAX_KEYS_PER_AGENT) {
    throw new WebChannelError(
      409,
      "too_many_keys",
      `An agent can have up to ${MAX_KEYS_PER_AGENT} web chat keys. Revoke one you no longer use.`,
      { limit: MAX_KEYS_PER_AGENT },
    );
  }

  const row = await deps.db.widgetKey.create({
    data: {
      orgId,
      agentId: agent.id,
      publicKey: (deps.generatePublicKey ?? generatePublicKey)(),
      name: input.name,
      allowedOrigins,
      ...(input.dailyMessageCap !== undefined && { dailyMessageCap: input.dailyMessageCap }),
      ...(input.perIpPerMinute !== undefined && { perIpPerMinute: input.perIpPerMinute }),
      ...appearanceData(input.appearance),
      ...(input.storeTranscripts !== undefined && { storeTranscripts: input.storeTranscripts }),
      ...(input.hideBranding !== undefined && { hideBranding: input.hideBranding }),
    },
    select: WEB_KEY_COLUMNS,
  });
  return toDto(deps, row, today(deps));
}

export async function updateWebKey(
  deps: WebChannelDeps,
  orgId: string,
  id: string,
  input: UpdateWebKeyInput,
): Promise<WidgetKeyDto> {
  const data: KeyWriteData = {
    ...(input.name !== undefined && { name: input.name }),
    ...(input.allowedOrigins !== undefined && { allowedOrigins: normalizeOrigins(input.allowedOrigins) }),
    ...(input.dailyMessageCap !== undefined && { dailyMessageCap: input.dailyMessageCap }),
    ...(input.perIpPerMinute !== undefined && { perIpPerMinute: input.perIpPerMinute }),
    ...appearanceData(input.appearance),
    ...(input.storeTranscripts !== undefined && { storeTranscripts: input.storeTranscripts }),
    ...(input.hideBranding !== undefined && { hideBranding: input.hideBranding }),
    ...(input.enabled !== undefined && { enabled: input.enabled }),
  };
  if (input.hideBranding) await assertMayHideBranding(deps, orgId);

  if (Object.keys(data).length > 0) {
    // A revoked key stays as it was revoked.
    const changed = await deps.db.widgetKey.updateMany({ where: { id, orgId, revokedAt: null }, data });
    if (changed.count === 0) throw keyNotFound();
  }
  return getWebKey(deps, orgId, id);
}

/**
 * Gives the key a new public value. The old one, and every snippet that
 * carries it, stops working with this write.
 */
export async function rotateWebKey(deps: WebChannelDeps, orgId: string, id: string): Promise<WidgetKeyDto> {
  const row = await deps.db.widgetKey.findFirst({ where: { id, orgId }, select: WEB_KEY_COLUMNS });
  if (!row || row.revokedAt !== null) throw keyNotFound();
  // Compare-and-set on the value that was read: of two rotations at once,
  // one wins and the other is told, instead of both handing out a snippet.
  const rotated = await deps.db.widgetKey.updateMany({
    where: { id, orgId, revokedAt: null, publicKey: row.publicKey },
    data: { publicKey: (deps.generatePublicKey ?? generatePublicKey)() },
  });
  if (rotated.count === 0) {
    throw new WebChannelError(409, "widget_key_changed", "This key was rotated or revoked a moment ago. Reload it.");
  }
  return getWebKey(deps, orgId, id);
}

/**
 * Permanent. Revoking a key that is already revoked changes nothing.
 *
 * A page key stops being its agent's page key in the same write: an agent
 * has at most one (a unique index), and the revoked row stays, so without
 * this the agent could never be given a new one.
 */
export async function revokeWebKey(deps: WebChannelDeps, orgId: string, id: string): Promise<void> {
  const revoked = await deps.db.widgetKey.updateMany({
    where: { id, orgId, revokedAt: null },
    data: { revokedAt: (deps.now ?? (() => new Date()))(), enabled: false, pageOfAgentId: null },
  });
  if (revoked.count > 0) return;
  const row = await deps.db.widgetKey.findFirst({ where: { id, orgId }, select: WEB_KEY_COLUMNS });
  if (!row) throw keyNotFound();
}
