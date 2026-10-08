/**
 * /api/destinations: the places a schedule can send its results to.
 *
 *   GET  /            the organization's places, by id, name and type, and
 *                     whether each is the caller's own email
 *   POST /            add one: a Slack or Discord channel by its pasted
 *                     link, or the signed-in member's own email
 *   POST /:id/test    send a short test message to one
 *
 * A place is one of the organization's alert channels, the model the
 * Monitoring page and the report task already use. This is a small front
 * door to it, not a second store, and a safe one:
 *
 *   no answer here carries a link or an address, ever. A place is its id,
 *   its name and its type;
 *
 *   a Slack or Discord link must be an https link of that service's webhook
 *   host, passes the address guard every outbound request passes, and is
 *   stored as the Monitoring form stores a channel of that kind;
 *
 *   an email place takes NO address from the request. It is the signed-in
 *   member's own address, and only once that address is verified. An API
 *   key has no member behind it, so it cannot choose email. Typed outside
 *   addresses stay on the Monitoring channel form. The place is named for
 *   that member ("Email to Ada"), because everyone in the organization sees
 *   it in the list, and `mine` says whether a listed place goes to exactly
 *   the caller's own address.
 *
 * Everything is scoped to the caller's organization: another organization's
 * place is 404.
 *
 * Pure core with injected reads and senders; production wiring is in
 * destinationsBindings.ts.
 */

import type { FastifyPluginAsync, FastifyReply, preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";

import { validationFailure } from "../lib/validationFailure.js";
import type { ChannelMessage } from "../services/scheduledTasks/reportDelivery.js";
import type { ResultDeliveryDeps } from "../services/scheduledTasks/resultDelivery.js";

// ============================================
// Words and rules
// ============================================

export const DESTINATION_MESSAGES = {
  slackLink: "Paste the link Slack gave you for this channel. It starts with https://hooks.slack.com/services/.",
  discordLink: "Paste the webhook link Discord gave you for this channel. It starts with https://discord.com/api/webhooks/.",
  emailTakesNoLink: "Email goes to your own verified address. Leave the link out.",
  emailNeedsSignIn:
    "Email goes to the address of the person signed in, so an API key cannot choose it. Choose Email in the dashboard.",
  emailOff: "Email delivery is temporarily unavailable. Results are still saved here.",
  emailNotVerified: "Verify your email address first, then choose Email.",
  nameTaken: "A place with this name already exists. Choose another name.",
  notFound: "That place was not found.",
  unsupported: "That place cannot receive results. Choose Slack, Discord or email.",
  turnedOff: "That place is turned off. Turn it on in Monitoring, then try again.",
  testFailed: "The test could not be sent. Check the link and try again.",
  testEmailFailed: "The test email could not be sent. Try again in a moment.",
} as const;

/** The kinds of alert channel a result can go to (a PagerDuty channel opens incidents). */
export const DESTINATION_TYPES: readonly string[] = ["slack", "discord", "webhook", "email"];

/** `email` is the name of an email place whose member has no display name. */
export const DEFAULT_DESTINATION_NAMES = { slack: "Slack", discord: "Discord", email: "Email to a teammate" } as const;

/** The longest name a place may be given here. */
export const DESTINATION_NAME_MAX = 80;

const EMAIL_NAME_PREFIX = "Email to ";

/**
 * The name of the email place a member makes with "Email me": "Email to
 * <display name>". The list is the whole organization's, so "me" would be
 * untrue for everyone but one. Never an address: a member with no display
 * name, or one that holds an "@", is "a teammate".
 */
export function emailPlaceName(displayName: string | null | undefined): string {
  const name = typeof displayName === "string" ? displayName.trim() : "";
  if (name === "" || name.includes("@")) return DEFAULT_DESTINATION_NAMES.email;
  return `${EMAIL_NAME_PREFIX}${name.slice(0, DESTINATION_NAME_MAX - EMAIL_NAME_PREFIX.length).trimEnd()}`;
}
const LINK_MAX = 2048;

/** What a test sends. */
export const TEST_MESSAGE: ChannelMessage = {
  kind: "result",
  title: "Test from WheelsAI",
  text: "This is a test. Your agent's results will arrive here.",
};

const SLACK_HOSTS = new Set(["hooks.slack.com", "hooks.slack-gov.com"]);
const DISCORD_HOSTS = new Set(["discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com"]);
const DISCORD_PATH = /^\/api(\/v\d+)?\/webhooks\/\d+\/[\w-]+\/?$/;

/**
 * Whether a pasted link is that service's webhook link: https, its host, its
 * path, no credentials and no port. Pure; the address guard is asked after.
 * Returns the link as it is stored, or null.
 */
export function pastedLink(type: "slack" | "discord", link: unknown): string | null {
  if (typeof link !== "string" || link.length > LINK_MAX) return null;
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  if (type === "slack") {
    return SLACK_HOSTS.has(host) && /^\/services\/.+/.test(url.pathname) ? url.toString() : null;
  }
  return DISCORD_HOSTS.has(host) && DISCORD_PATH.test(url.pathname) ? url.toString() : null;
}

/** "Slack", then "Slack 2", "Slack 3": the first that no channel of the organization has. */
export function freeName(base: string, taken: Iterable<string>): string {
  const names = new Set(taken);
  for (let counter = 1; ; counter++) {
    const name = counter === 1 ? base : `${base} ${counter}`;
    if (!names.has(name)) return name;
  }
}

// ============================================
// Types
// ============================================

/** A place, as every answer here carries it. */
export interface Destination {
  channelId: string;
  name: string;
  type: string;
  /**
   * True only for an email place that goes to exactly the caller's own
   * address. Always false for an API key and for every other kind of place.
   */
  mine: boolean;
}

/** A stored place, without its config. */
export interface PlaceRow {
  id: string;
  name: string;
  type: string;
  isEnabled: boolean;
}

/** What is stored as the channel's config, as the Monitoring form stores it. */
export type PlaceConfig = { webhookUrl: string } | { emails: string[] };

export interface DestinationsRouteDeps {
  guards: { auth: preHandlerAsyncHookHandler };
  places: {
    /** Every alert channel of the organization, of any kind. MUST scope by orgId. */
    list(orgId: string): Promise<PlaceRow[]>;
    /** Throws a unique violation (P2002) when the name is taken in the organization. */
    create(orgId: string, place: { name: string; type: "slack" | "discord" | "email"; config: PlaceConfig }): Promise<PlaceRow>;
    /** An enabled email place of the organization that goes to exactly this address. */
    findEmailPlace(orgId: string, address: string): Promise<PlaceRow | null>;
    /** The ids of every email place of the organization that goes to exactly this address. */
    ownEmailPlaceIds(orgId: string, address: string): Promise<string[]>;
  };
  /** The signed-in member, in this organization. Null when there is none. */
  loadMember(
    userId: string,
    orgId: string,
  ): Promise<{ email: string | null; emailVerified: boolean; displayName?: string | null } | null>;
  /** The address guard every outbound request passes (lib/ssrfGuard.ts). */
  linkAllowed(link: string): Promise<boolean>;
  emailConfigured(): boolean;
  /** The loader and senders a result is delivered with. Built on first use. */
  delivery(): Pick<ResultDeliveryDeps, "loadAlertChannel" | "sendToChannel" | "sendEmail">;
}

const createBody = z
  .object({
    type: z.enum(["slack", "discord", "email"]),
    link: z.string().optional(),
    name: z.string().trim().min(1).max(DESTINATION_NAME_MAX).optional(),
  })
  .strict();

const placeParams = z.object({ id: z.string().uuid() });

class Refusal extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 501 | 502,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const isUniqueViolation = (err: unknown): boolean =>
  typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";

const toDestination = (row: { id: string; name: string; type: string }, mine: boolean): Destination => ({
  channelId: row.id,
  name: row.name,
  type: row.type,
  mine,
});

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof Refusal) return reply.status(err.status).send({ error: err.code, message: err.message });
  if (err instanceof z.ZodError) return reply.status(400).send(validationFailure(err));
  throw err;
}

/** How often a create is tried again after another request took the default name. */
const NAME_RACE_ATTEMPTS = 3;

// ============================================
// Core
// ============================================

/**
 * The places a result can go to: the right kinds, turned on. `mine` marks
 * the email places that go to exactly the signed-in member's own address;
 * an API key has no member, so nothing is its own.
 */
export async function listDestinations(
  deps: Pick<DestinationsRouteDeps, "places" | "loadMember">,
  caller: { orgId: string; userId: string | null },
): Promise<Destination[]> {
  const rows = await deps.places.list(caller.orgId);
  const member = caller.userId ? await deps.loadMember(caller.userId, caller.orgId) : null;
  const own = new Set(member?.email ? await deps.places.ownEmailPlaceIds(caller.orgId, member.email) : []);
  return rows
    .filter((row) => row.isEnabled && DESTINATION_TYPES.includes(row.type))
    .map((row) => toDestination(row, row.type === "email" && own.has(row.id)));
}

async function storePlace(
  deps: Pick<DestinationsRouteDeps, "places">,
  orgId: string,
  place: {
    type: "slack" | "discord" | "email";
    name: string | undefined;
    config: PlaceConfig;
    /** What it is called when no name was chosen; counted up on a clash. */
    defaultName?: string;
    mine?: boolean;
  },
): Promise<Destination> {
  for (let attempt = 1; ; attempt++) {
    const name =
      place.name ??
      freeName(
        place.defaultName ?? DEFAULT_DESTINATION_NAMES[place.type],
        (await deps.places.list(orgId)).map((row) => row.name),
      );
    try {
      return toDestination(
        await deps.places.create(orgId, { name, type: place.type, config: place.config }),
        place.mine === true,
      );
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // A name the person chose is theirs to change; a default one counts up.
      if (place.name !== undefined) throw new Refusal(409, "name_taken", DESTINATION_MESSAGES.nameTaken);
      if (attempt >= NAME_RACE_ATTEMPTS) throw err;
    }
  }
}

export async function createDestination(
  deps: Pick<DestinationsRouteDeps, "places" | "loadMember" | "linkAllowed" | "emailConfigured">,
  caller: { orgId: string; userId: string | null },
  body: z.infer<typeof createBody>,
): Promise<{ created: boolean; destination: Destination }> {
  if (body.type === "email") {
    if (body.link !== undefined) throw new Refusal(400, "invalid_link", DESTINATION_MESSAGES.emailTakesNoLink);
    // An API key has no member, so there is no "own address" to send to.
    if (!caller.userId) throw new Refusal(400, "email_needs_sign_in", DESTINATION_MESSAGES.emailNeedsSignIn);
    if (deps.emailConfigured() !== true) throw new Refusal(501, "email_not_configured", DESTINATION_MESSAGES.emailOff);
    const member = await deps.loadMember(caller.userId, caller.orgId);
    if (!member || member.emailVerified !== true || !member.email || !member.email.includes("@")) {
      throw new Refusal(400, "email_not_verified", DESTINATION_MESSAGES.emailNotVerified);
    }
    // Choosing "Email me" twice is one place, not two.
    const existing = await deps.places.findEmailPlace(caller.orgId, member.email);
    if (existing) return { created: false, destination: toDestination(existing, true) };
    return {
      created: true,
      destination: await storePlace(deps, caller.orgId, {
        type: "email",
        name: body.name,
        config: { emails: [member.email] },
        defaultName: emailPlaceName(member.displayName),
        mine: true,
      }),
    };
  }

  const message = body.type === "slack" ? DESTINATION_MESSAGES.slackLink : DESTINATION_MESSAGES.discordLink;
  const link = pastedLink(body.type, body.link);
  if (!link || !(await deps.linkAllowed(link))) throw new Refusal(400, "invalid_link", message);
  return {
    created: true,
    destination: await storePlace(deps, caller.orgId, {
      type: body.type,
      name: body.name,
      config: { webhookUrl: link },
    }),
  };
}

/** Sends the test message through the senders a result uses. Throws the refusal. */
export async function testDestination(
  deps: Pick<DestinationsRouteDeps, "emailConfigured" | "delivery">,
  orgId: string,
  channelId: string,
): Promise<{ sent: true }> {
  const delivery = deps.delivery();
  const place = await delivery.loadAlertChannel(channelId, orgId);
  if (!place) throw new Refusal(404, "not_found", DESTINATION_MESSAGES.notFound);
  if (!DESTINATION_TYPES.includes(place.type)) throw new Refusal(400, "unsupported_place", DESTINATION_MESSAGES.unsupported);
  if (!place.isEnabled) throw new Refusal(400, "place_turned_off", DESTINATION_MESSAGES.turnedOff);
  const email = place.type === "email";
  if (email && deps.emailConfigured() !== true) {
    throw new Refusal(501, "email_not_configured", DESTINATION_MESSAGES.emailOff);
  }
  try {
    if (email) await delivery.sendEmail(place, TEST_MESSAGE);
    else await delivery.sendToChannel(place, TEST_MESSAGE);
  } catch {
    // Nothing of the sender's error is passed on: it can name the link.
    throw new Refusal(
      502,
      "delivery_failed",
      email ? DESTINATION_MESSAGES.testEmailFailed : DESTINATION_MESSAGES.testFailed,
    );
  }
  return { sent: true };
}

// ============================================
// Routes
// ============================================

export function createDestinationsRoutes(deps: DestinationsRouteDeps): FastifyPluginAsync {
  return async (app) => {
    const schema = { tags: ["Agents"] };
    app.addHook("preHandler", deps.guards.auth);

    app.get("/", { schema: { ...schema, description: "The places a schedule can send its results to" } }, async (request, reply) => {
      try {
        return await listDestinations(deps, {
          orgId: request.auth!.orgId,
          userId: request.auth!.type === "jwt" ? request.auth!.userId : null,
        });
      } catch (err) {
        return sendError(reply, err);
      }
    });

    app.post("/", { schema: { ...schema, description: "Add a place results can be sent to" } }, async (request, reply) => {
      try {
        const body = createBody.parse(request.body);
        const { created, destination } = await createDestination(
          deps,
          { orgId: request.auth!.orgId, userId: request.auth!.type === "jwt" ? request.auth!.userId : null },
          body,
        );
        return reply.status(created ? 201 : 200).send(destination);
      } catch (err) {
        return sendError(reply, err);
      }
    });

    app.post("/:id/test", { schema: { ...schema, description: "Send a test message to a place" } }, async (request, reply) => {
      try {
        const params = placeParams.safeParse(request.params);
        // A malformed id cannot name a place in this organization.
        if (!params.success) throw new Refusal(404, "not_found", DESTINATION_MESSAGES.notFound);
        return await testDestination(deps, request.auth!.orgId, params.data.id);
      } catch (err) {
        return sendError(reply, err);
      }
    });
  };
}
