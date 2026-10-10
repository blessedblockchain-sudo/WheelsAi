/**
 * An agent's public link, from its owner's side: the switch that lets anyone
 * with /a/<handle> use the agent, and what the owner sees of it.
 *
 * Two switches decide what a visitor can do, and both are needed
 * (services/publicPageState.ts): `Agent.isPublic` shows the page, and a live
 * page key lets people use it. The page key is an ordinary web chat key
 * (WidgetKey) marked with `pageOfAgentId`; an agent has at most one, which a
 * unique index holds. So:
 *
 *   on      the page is public, it has an address, and its page key is on
 *   paused  the page is public and its page key is off
 *   off     the page is not public, and its page key is off with it
 *
 * An agent that was made public before public use existed, or through
 * PATCH /api/agents/:id, has no page key: it reads `view_only`, and nobody
 * uses it until its owner turns the link on here.
 *
 * The three writes are exported and take a transaction client, because
 * selling use of an agent (a later batch) calls them inside its own
 * transaction:
 *
 *   ensurePublicPage  the page is public and has an address
 *   ensurePageKey     the agent has exactly one live page key
 *   setPageUse        that key is on, or off, by compare-and-set
 *
 * A switch that lost a compare-and-set is never an error: someone else moved
 * it first, and the answer is the state as it now is.
 *
 * While a published listing sells use of the agent, the listing decides the
 * link and this switch gives way to it (services/useListing.ts):
 *
 *   on      409 sold_as_paid while a price is set: free use on the page
 *           would undercut the people who pay
 *   off     409 on_sale_for_use: an agent on sale keeps its page
 *   paused  409 on_sale_for_use for a free listing, whose page must stay
 *           usable; with a price set the key is paused already, so the
 *           answer is the link as it is
 *
 * Each is decided before anything is written. Turning the link on is
 * checked once more after its writes, inside the same transaction, which
 * catches a listing whose publish at a price has already committed. One
 * that commits a moment later is not seen here: the publish pauses the key
 * with a write that waits for this one (applyUsePage, services/marketplace.ts),
 * and whatever the stored switch ends up saying, a page key answers nobody
 * while a published listing sells use at a price, because that is asked
 * again each time the key is used (services/buildPublicChatDeps.ts).
 *
 * Every read and write is scoped by the caller's organization; another
 * organization's agent is "not found", never "forbidden".
 *
 * Pure core: the database surface, the transaction, the counter read, the
 * web address and the tool rule are dependencies
 * (services/buildAgentPublicLinkDeps.ts binds the real ones).
 */

import { z } from "zod";

import { validationFailureFromFields, type ValidationFailureBody } from "../lib/validationFailure.js";
import type { FailClosedLimiter } from "./failClosedLimiter.js";
import { publicChatKeys, utcDay } from "./publicChat.js";
import { HANDLE_MESSAGES, handleCandidates, handleRefusal } from "./publicHandle.js";
import {
  PAGE_DAILY_CAP_DEFAULT,
  PAGE_DAILY_CAP_MAX,
  PAGE_DAILY_CAP_MIN,
  publicPageStateOf,
  type PublicPageState,
} from "./publicPageState.js";
import { isPaidUse, type UseListingRow } from "./useListing.js";
import { generatePublicKey } from "./widgetKeys.js";

// ============================================
// Requests
// ============================================

/** What an owner can set the link to. `view_only` is read, never asked for. */
export const PUBLIC_LINK_SWITCH = ["on", "paused", "off"] as const;
export type PublicLinkSwitch = (typeof PUBLIC_LINK_SWITCH)[number];

export const PUBLIC_LINK_MESSAGES = {
  agentNotFound: "Agent not found",
  dailyCap: `Choose a daily limit from ${PAGE_DAILY_CAP_MIN.toLocaleString("en-US")} to ${PAGE_DAILY_CAP_MAX.toLocaleString("en-US")} uses.`,
  noAddress: "No address could be made for this agent. Choose one yourself.",
  soldAsPaid:
    "This agent is on sale, so free use on its page is off. Choose Free under Who can use it? to let anyone use it.",
  onSaleForUse: "This agent is on sale, so its page stays on. Stop selling it first.",
} as const;

export const publicLinkBodySchema = z
  .object({
    state: z.enum(PUBLIC_LINK_SWITCH),
    dailyCap: z
      .number({ invalid_type_error: PUBLIC_LINK_MESSAGES.dailyCap })
      .int(PUBLIC_LINK_MESSAGES.dailyCap)
      .min(PAGE_DAILY_CAP_MIN, PUBLIC_LINK_MESSAGES.dailyCap)
      .max(PAGE_DAILY_CAP_MAX, PUBLIC_LINK_MESSAGES.dailyCap)
      .optional(),
    /** What the owner typed. Judged as typed by handleRefusal, never trimmed or lowered. */
    handle: z.string().optional(),
    showResults: z.boolean().optional(),
  })
  .strict();

export type PublicLinkInput = z.infer<typeof publicLinkBodySchema>;

// ============================================
// Rows and the answer
// ============================================

export const LINK_AGENT_COLUMNS = {
  id: true,
  slug: true,
  isPublic: true,
  publicHandle: true,
  publicResults: true,
  tools: true,
} as const;

export interface LinkAgentRow {
  id: string;
  slug: string;
  isPublic: boolean;
  publicHandle: string | null;
  publicResults: boolean;
  tools: unknown;
}

export const PAGE_KEY_COLUMNS = {
  id: true,
  enabled: true,
  revokedAt: true,
  dailyMessageCap: true,
} as const;

export interface PageKeyRow {
  id: string;
  enabled: boolean;
  revokedAt: Date | null;
  /** null = the platform's default for a web chat key. */
  dailyMessageCap: number | null;
}

/** The page key as it is first written. */
export interface NewPageKey {
  orgId: string;
  agentId: string;
  /** The same agent: the database checks it. */
  pageOfAgentId: string;
  publicKey: string;
  name: string;
  allowedOrigins: string[];
  dailyMessageCap: number;
  storeTranscripts: boolean;
  enabled: boolean;
}

/**
 * The slice of Prisma these writes touch. A transaction client has it, and so
 * does the client itself.
 */
export interface PublicLinkTx {
  agent: {
    findFirst(args: {
      where: { id?: string; orgId?: string; publicHandle?: string };
      select: typeof LINK_AGENT_COLUMNS;
    }): Promise<LinkAgentRow | null>;
    updateMany(args: {
      where: { id: string; orgId?: string; isPublic?: boolean; publicHandle?: null };
      data: { isPublic?: boolean; publicHandle?: string; publicResults?: boolean };
    }): Promise<{ count: number }>;
  };
  widgetKey: {
    findFirst(args: {
      where: { pageOfAgentId: string; orgId: string };
      select: typeof PAGE_KEY_COLUMNS;
    }): Promise<PageKeyRow | null>;
    /** `skipDuplicates`: a second page key for the agent is not written, and is not an error. */
    createMany(args: { data: NewPageKey[]; skipDuplicates: true }): Promise<{ count: number }>;
    updateMany(args: {
      where: { id?: string; pageOfAgentId: string; orgId: string; revokedAt?: null; enabled?: boolean };
      data: { enabled?: boolean; dailyMessageCap?: number; pageOfAgentId?: null };
    }): Promise<{ count: number }>;
  };
}

/** What both routes answer. */
export interface PublicLink {
  /** off, view_only, on or paused (services/publicPageState.ts). */
  state: PublicPageState;
  /** The agent's address, kept while the link is off. null until it has one. */
  handle: string | null;
  /** `<web>/a/<handle>`; null without a handle, or when this server does not know its web address. */
  url: string | null;
  /** Uses a day the page allows. Before the link is first turned on: what it will start with. */
  dailyCap: number;
  /** Uses counted today (UTC); null when the count cannot be read. */
  usedToday: number | null;
  /** Whether a self-running agent's latest results show on its page. */
  showResults: boolean;
  /** The agent has a tool that visitors do not get. */
  toolsOffForVisitors: boolean;
  /**
   * Only while a published listing sells use of the agent: its slug, and
   * whether a price is set (free use on the page is then off, and `state`
   * reads "paused").
   */
  sale?: { paid: boolean; listingSlug: string };
}

export interface AgentPublicLinkDeps {
  /** Reads, outside any transaction. */
  db: PublicLinkTx;
  transaction<T>(fn: (tx: PublicLinkTx) => Promise<T>): Promise<T>;
  /** The counter the public chat and run keep for a key's daily cap. Read, never written. */
  limiter: Pick<FailClosedLimiter, "peek">;
  /** `<web>/a/<handle>`, or null when this server was not told its web address. */
  pageUrl(handle: string): string | null;
  /** Whether the `public` tool mode withholds the tool of this name. */
  toolOffForVisitors(toolName: string): boolean;
  /**
   * The published listing that sells use of the agent, or null
   * (findUseListing), read on the client or transaction it is handed. A
   * read that fails is thrown on: the link is not moved on a guess.
   */
  useListing(db: PublicLinkTx, agentId: string): Promise<UseListingRow | null>;
  /** A key's uses a day when its cap is unset (it can be cleared on the Channels page). */
  keyDefaultDailyCap: number;
  generatePublicKey?: () => string;
  now?: () => Date;
}

export class PublicLinkError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: string,
    message: string,
    /** The whole answer, when it is not just the code and the message. */
    readonly body?: ValidationFailureBody,
  ) {
    super(message);
    this.name = "PublicLinkError";
  }
}

const agentNotFound = () => new PublicLinkError(404, "agent_not_found", PUBLIC_LINK_MESSAGES.agentNotFound);
const handleTaken = () => new PublicLinkError(409, "handle_taken", HANDLE_MESSAGES.taken);
const soldAsPaid = () => new PublicLinkError(409, "sold_as_paid", PUBLIC_LINK_MESSAGES.soldAsPaid);
const onSaleForUse = () => new PublicLinkError(409, "on_sale_for_use", PUBLIC_LINK_MESSAGES.onSaleForUse);

/** What a listing that sells use lets this switch do. Throws the refusal. */
function assertSaleAllows(state: PublicLinkSwitch, listing: UseListingRow | null): void {
  if (!listing) return;
  const paid = isPaidUse(listing);
  if (state === "on") {
    if (paid) throw soldAsPaid();
    return;
  }
  // Off closes the page of an agent on sale. Paused does the same to a free
  // listing; with a price set the key is paused already.
  if (state === "off" || !paid) throw onSaleForUse();
}

/** The name a page key shows under on the Channels page. */
export const PAGE_KEY_NAME = "Public page";

/** Two agents reaching for one address at once: the loser looks again. */
const HANDLE_ATTEMPTS = 3;

/**
 * Whether a failed write lost a race for an address (the unique index on
 * agents.public_handle). Duck-typed, so this file imports no database client.
 */
export function isHandleConflict(err: unknown): boolean {
  const known = err as { code?: unknown; meta?: { target?: unknown } } | null;
  if (known?.code !== "P2002") return false;
  const target = known.meta?.target;
  if (target === undefined || target === null) return true;
  const text = Array.isArray(target) ? target.join(",") : String(target);
  return text.includes("public_handle") || text.includes("publicHandle");
}

// ============================================
// The address
// ============================================

/** Refuses a handle an owner may not have, in the shape of the other validation failures. */
function assertHandleAllowed(handle: unknown): asserts handle is string {
  const refusal = handleRefusal(handle);
  if (!refusal) return;
  throw new PublicLinkError(
    400,
    "validation_failed",
    refusal.message,
    validationFailureFromFields({ handle: refusal.message }),
  );
}

/**
 * Gives an agent that has no handle the first free one of handleCandidates,
 * and answers the handle it has afterwards. An agent that already has one
 * keeps it: this never changes an address.
 *
 * "Free" is asked first and then decided by the unique index. Outside a
 * transaction a write that loses to another agent moves on to the next
 * candidate. Inside one (`inTransaction`) the lost write has ended the
 * transaction and nothing more can be asked of it, so the error leaves here
 * (isHandleConflict says it is that) and the caller runs its transaction
 * again; the handle is then seen as taken.
 */
export async function assignPublicHandle(
  db: Pick<PublicLinkTx, "agent">,
  agent: { id: string; slug: string },
  options: { inTransaction?: boolean } = {},
): Promise<string> {
  for (const candidate of handleCandidates(agent.slug, agent.id)) {
    const holder = await db.agent.findFirst({ where: { publicHandle: candidate }, select: LINK_AGENT_COLUMNS });
    if (holder) {
      if (holder.id === agent.id) return candidate;
      continue;
    }
    let written: { count: number };
    try {
      written = await db.agent.updateMany({
        where: { id: agent.id, publicHandle: null },
        data: { publicHandle: candidate },
      });
    } catch (err) {
      if (isHandleConflict(err) && !options.inTransaction) continue;
      throw err;
    }
    if (written.count > 0) return candidate;
    // Nothing was written: the agent has a handle by now, or is gone.
    const current = await db.agent.findFirst({ where: { id: agent.id }, select: LINK_AGENT_COLUMNS });
    if (!current) throw agentNotFound();
    if (current.publicHandle) return current.publicHandle;
  }
  throw new PublicLinkError(409, "handle_taken", PUBLIC_LINK_MESSAGES.noAddress);
}

/** The address its owner typed. Refused when it breaks the rules or another agent has it. */
async function setPublicHandle(
  tx: PublicLinkTx,
  orgId: string,
  agent: Pick<LinkAgentRow, "id" | "publicHandle">,
  handle: string,
): Promise<string> {
  assertHandleAllowed(handle);
  if (agent.publicHandle === handle) return handle;
  const holder = await tx.agent.findFirst({ where: { publicHandle: handle }, select: LINK_AGENT_COLUMNS });
  if (holder && holder.id !== agent.id) throw handleTaken();
  const written = await tx.agent.updateMany({ where: { id: agent.id, orgId }, data: { publicHandle: handle } });
  if (written.count === 0) throw agentNotFound();
  return handle;
}

// ============================================
// The three writes
// ============================================

/**
 * The agent's page is public and has an address: `isPublic` becomes true,
 * and the agent gets `handle` when one is given, else keeps the handle it
 * has, else is given the first free candidate made from its slug.
 *
 * Throws PublicLinkError: 404 when the agent is not in this organization,
 * 400 for a handle that breaks the rules, 409 `handle_taken`. A write that
 * loses the unique index to another agent at the same moment throws the
 * database's own error (isHandleConflict), which ends the transaction: run
 * it again.
 */
export async function ensurePublicPage(
  tx: PublicLinkTx,
  args: { orgId: string; agentId: string; handle?: string },
): Promise<{ handle: string }> {
  const { orgId, agentId } = args;
  if (args.handle !== undefined) assertHandleAllowed(args.handle);
  const agent = await tx.agent.findFirst({ where: { id: agentId, orgId }, select: LINK_AGENT_COLUMNS });
  if (!agent) throw agentNotFound();

  // Compare-and-set; a write that changes nothing means it is public already.
  if (!agent.isPublic) {
    await tx.agent.updateMany({ where: { id: agentId, orgId, isPublic: false }, data: { isPublic: true } });
  }
  if (args.handle !== undefined) return { handle: await setPublicHandle(tx, orgId, agent, args.handle) };
  return { handle: agent.publicHandle ?? (await assignPublicHandle(tx, agent, { inTransaction: true })) };
}

/**
 * The agent has exactly one live page key, and this answers it. It is made
 * once: for the agent alone, with no allowed origins (the platform's own
 * origins always count), the default daily cap, no kept transcripts, and on.
 * A key that exists is answered as it is, on or paused; setPageUse moves
 * that switch.
 *
 * Two calls at the same moment leave one key. The unique index on
 * page_of_agent_id decides, the second insert writes nothing and raises
 * nothing, and both read the key that won.
 *
 * The caller has loaded the agent in `orgId`.
 */
export async function ensurePageKey(
  tx: PublicLinkTx,
  args: { orgId: string; agentId: string; generatePublicKey?: () => string },
): Promise<PageKeyRow> {
  const { orgId, agentId } = args;
  const where = { pageOfAgentId: agentId, orgId };

  const existing = await tx.widgetKey.findFirst({ where, select: PAGE_KEY_COLUMNS });
  if (existing && !existing.revokedAt) return existing;
  // A revoked key counts as no key. Revoking clears the mark itself
  // (services/webChannel.ts); a row that still carries it is let go here, so
  // the new key can take its place.
  if (existing) {
    await tx.widgetKey.updateMany({ where: { ...where, id: existing.id }, data: { pageOfAgentId: null } });
  }

  await tx.widgetKey.createMany({
    data: [
      {
        orgId,
        agentId,
        pageOfAgentId: agentId,
        publicKey: (args.generatePublicKey ?? generatePublicKey)(),
        name: PAGE_KEY_NAME,
        allowedOrigins: [],
        dailyMessageCap: PAGE_DAILY_CAP_DEFAULT,
        storeTranscripts: false,
        enabled: true,
      },
    ],
    skipDuplicates: true,
  });
  const key = await tx.widgetKey.findFirst({ where, select: PAGE_KEY_COLUMNS });
  if (!key || key.revokedAt) throw new Error("the agent's page key could not be made");
  return key;
}

/**
 * Turns public use of the page on or off: the page key's `enabled`, by
 * compare-and-set. `changed: false` means there was nothing to move: the key
 * is already that way, someone else moved it first, or the agent has no live
 * page key. None of those is an error.
 */
export async function setPageUse(
  tx: PublicLinkTx,
  args: { orgId: string; agentId: string; enabled: boolean },
): Promise<{ changed: boolean }> {
  const moved = await tx.widgetKey.updateMany({
    where: { pageOfAgentId: args.agentId, orgId: args.orgId, revokedAt: null, enabled: !args.enabled },
    data: { enabled: args.enabled },
  });
  return { changed: moved.count > 0 };
}

/**
 * The page is not public, and its key is off with it, so the key cannot be
 * used while the page is off. The handle is kept: the address is the same
 * when the link is turned on again.
 */
export async function closePublicPage(tx: PublicLinkTx, args: { orgId: string; agentId: string }): Promise<void> {
  await tx.agent.updateMany({ where: { id: args.agentId, orgId: args.orgId, isPublic: true }, data: { isPublic: false } });
  await setPageUse(tx, { ...args, enabled: false });
}

// ============================================
// Operations
// ============================================

function toolNames(tools: unknown): string[] {
  if (!Array.isArray(tools)) return [];
  return tools
    .map((tool: unknown) => (typeof tool === "object" && tool !== null ? (tool as { name?: unknown }).name : null))
    .filter((name): name is string => typeof name === "string");
}

/** The link as its owner sees it. Reads only: nothing is made or switched by looking. */
export async function getPublicLink(deps: AgentPublicLinkDeps, orgId: string, agentId: string): Promise<PublicLink> {
  const agent = await deps.db.agent.findFirst({ where: { id: agentId, orgId }, select: LINK_AGENT_COLUMNS });
  if (!agent) throw agentNotFound();
  const stored = await deps.db.widgetKey.findFirst({ where: { pageOfAgentId: agentId, orgId }, select: PAGE_KEY_COLUMNS });
  const key = stored && !stored.revokedAt ? stored : null;
  const listing = await deps.useListing(deps.db, agentId);

  let usedToday: number | null = 0;
  if (key) {
    // The same key the chat and the run count on (publicChat.ts). Unreadable is null.
    try {
      usedToday = await deps.limiter.peek(publicChatKeys.widgetKeyDay(key.id, utcDay((deps.now ?? (() => new Date()))())));
    } catch {
      usedToday = null;
    }
  }

  return {
    state: publicPageStateOf(agent.isPublic, key),
    handle: agent.publicHandle,
    url: agent.publicHandle ? deps.pageUrl(agent.publicHandle) : null,
    dailyCap: key ? (key.dailyMessageCap ?? deps.keyDefaultDailyCap) : PAGE_DAILY_CAP_DEFAULT,
    usedToday,
    showResults: agent.publicResults,
    toolsOffForVisitors: toolNames(agent.tools).some((name) => deps.toolOffForVisitors(name)),
    ...(listing ? { sale: { paid: isPaidUse(listing), listingSlug: listing.slug } } : {}),
  };
}

/**
 * Sets the link and answers it as it then is.
 *
 *   on      ensurePublicPage, ensurePageKey, then the key on
 *   paused  the key off. The page stays as it is: pausing never publishes a
 *           page, and with no page key there is nothing to pause
 *   off     closePublicPage
 *
 * `handle` is set in every state; `dailyCap` is the page key's, so it is
 * stored once the agent has one; `showResults` is the agent's.
 */
export async function setPublicLink(
  deps: AgentPublicLinkDeps,
  orgId: string,
  agentId: string,
  input: PublicLinkInput,
): Promise<PublicLink> {
  // Before anything is written.
  if (input.handle !== undefined) assertHandleAllowed(input.handle);

  const apply = async (tx: PublicLinkTx): Promise<void> => {
    const agent = await tx.agent.findFirst({ where: { id: agentId, orgId }, select: LINK_AGENT_COLUMNS });
    if (!agent) throw agentNotFound();
    // Before any write: what the listing that sells use of it allows.
    assertSaleAllows(input.state, await deps.useListing(tx, agentId));

    if (input.state === "on") {
      await ensurePublicPage(tx, { orgId, agentId, handle: input.handle });
      await ensurePageKey(tx, { orgId, agentId, generatePublicKey: deps.generatePublicKey });
      await setPageUse(tx, { orgId, agentId, enabled: true });
      // Once more, after the key was moved: a listing published at a price
      // meanwhile pauses this same key in its own transaction, and whichever
      // of the two wrote it second has now seen the other. Throwing undoes
      // the writes above.
      assertSaleAllows(input.state, await deps.useListing(tx, agentId));
    } else {
      if (input.handle !== undefined) await setPublicHandle(tx, orgId, agent, input.handle);
      if (input.state === "paused") await setPageUse(tx, { orgId, agentId, enabled: false });
      else await closePublicPage(tx, { orgId, agentId });
    }

    if (input.dailyCap !== undefined) {
      await tx.widgetKey.updateMany({
        where: { pageOfAgentId: agentId, orgId, revokedAt: null },
        data: { dailyMessageCap: input.dailyCap },
      });
    }
    if (input.showResults !== undefined) {
      await tx.agent.updateMany({ where: { id: agentId, orgId }, data: { publicResults: input.showResults } });
    }
  };

  for (let attempt = 1; ; attempt += 1) {
    try {
      await deps.transaction(apply);
      break;
    } catch (err) {
      if (!isHandleConflict(err)) throw err;
      // Another agent took the address between the look and the write.
      if (input.handle !== undefined) throw handleTaken();
      if (attempt >= HANDLE_ATTEMPTS) throw err;
    }
  }
  return getPublicLink(deps, orgId, agentId);
}
