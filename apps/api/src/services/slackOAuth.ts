/**
 * Slack OAuth v2 install flow (W2).
 *
 * Pure functions only — URL construction and response parsing. The
 * routes own IO, so this is testable without a network or a Slack app.
 *
 * Where the credentials go matters more than the exchange itself. The
 * chat-channel stack that already runs (channelWebhooks → channelConfig →
 * agent-message queue → channelDispatch) reads exactly two keys out of a
 * decrypted `OpenClawChannel.configEncrypted`: `signingSecret` for
 * inbound verification and `botToken` for outbound replies. A completed
 * install therefore writes THOSE keys into THAT row, and the whole
 * downstream pipeline works unchanged.
 *
 * The `Integration` model has OAuth columns that look like the obvious
 * home for this. Using them would fork Slack credentials across two
 * schemas with two different encryption formats, and the live channel
 * stack does not read them at all.
 */

export const SLACK_AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";
export const SLACK_ACCESS_URL = "https://slack.com/api/oauth.v2.access";

/**
 * Scopes the running channel stack actually needs:
 *   chat:write        — post the agent's reply (channelDispatch)
 *   app_mentions:read — receive @mentions
 *   channels:history / groups:history / im:history — receive messages in
 *     public channels, private channels, and DMs
 * Nothing broader: an install prompt that asks for more than the product
 * uses is both a trust cost and a bigger blast radius if the token leaks.
 */
export const SLACK_BOT_SCOPES = [
  "chat:write",
  "app_mentions:read",
  "channels:history",
  "groups:history",
  "im:history",
];

export interface BuildAuthorizeUrlInput {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes?: string[];
}

export function buildSlackAuthorizeUrl(input: BuildAuthorizeUrlInput): string {
  const url = new URL(SLACK_AUTHORIZE_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("scope", (input.scopes ?? SLACK_BOT_SCOPES).join(","));
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  return url.toString();
}

export interface SlackInstall {
  teamId: string;
  teamName: string;
  botToken: string;
  botUserId: string;
  scopes: string[];
}

export type SlackExchangeResult =
  | { ok: true; install: SlackInstall }
  | { ok: false; error: string };

/**
 * Parses an `oauth.v2.access` response.
 *
 * Slack signals failure with HTTP 200 and `{"ok": false, "error": ...}`,
 * so a status check alone would treat a failed exchange as a successful
 * install. The `ok` flag is the authority here.
 */
export function parseSlackAccessResponse(body: unknown): SlackExchangeResult {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "malformed_response" };
  }
  const b = body as Record<string, unknown>;
  if (b.ok !== true) {
    return {
      ok: false,
      error: typeof b.error === "string" ? b.error : "unknown_error",
    };
  }

  const accessToken = b.access_token;
  const botUserId = b.bot_user_id;
  const team = typeof b.team === "object" && b.team !== null ? (b.team as Record<string, unknown>) : null;
  const teamId = team?.id;
  const teamName = team?.name;

  if (typeof accessToken !== "string" || accessToken.length === 0) {
    return { ok: false, error: "missing_access_token" };
  }
  if (typeof teamId !== "string" || teamId.length === 0) {
    return { ok: false, error: "missing_team_id" };
  }

  return {
    ok: true,
    install: {
      teamId,
      teamName: typeof teamName === "string" ? teamName : teamId,
      botToken: accessToken,
      botUserId: typeof botUserId === "string" ? botUserId : "",
      scopes: typeof b.scope === "string" ? b.scope.split(",") : [],
    },
  };
}

export interface ExchangeDeps {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}

export async function exchangeSlackCode(
  code: string,
  deps: ExchangeDeps,
): Promise<SlackExchangeResult> {
  const doFetch = deps.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    client_id: deps.clientId,
    client_secret: deps.clientSecret,
    code,
    redirect_uri: deps.redirectUri,
  });

  let res: Response;
  try {
    res = await doFetch(SLACK_ACCESS_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch {
    return { ok: false, error: "slack_unreachable" };
  }

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    return { ok: false, error: "malformed_response" };
  }
  return parseSlackAccessResponse(parsed);
}

/**
 * Same-origin path check for the post-install redirect, matching the web
 * middleware's predicate. Validated at MINT time so a forged value can
 * never enter a signed state token in the first place.
 */
export function isSafeReturnPath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.startsWith("/") &&
    !path.startsWith("//")
  );
}
