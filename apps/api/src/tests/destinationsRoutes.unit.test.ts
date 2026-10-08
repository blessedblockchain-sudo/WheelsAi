/**
 * routes/destinations.ts and destinationsBindings.ts: the places a schedule
 * can send its results to, over HTTP with stand-in stores and senders.
 *
 * Every answer of these routes is collected as it was serialized, and none
 * may carry a link or an address.
 */
import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import Fastify, { type FastifyInstance, type preHandlerAsyncHookHandler } from "fastify";

import {
  DEFAULT_DESTINATION_NAMES,
  DESTINATION_MESSAGES,
  TEST_MESSAGE,
  createDestinationsRoutes,
  emailPlaceName,
  freeName,
  pastedLink,
  type PlaceConfig,
  type PlaceRow,
} from "../routes/destinations.js";
import { buildDestinationsDeps, isOwnEmailConfig, type DestinationsPrisma } from "../routes/destinationsBindings.js";
import type { ChannelMessage } from "../services/scheduledTasks/reportDelivery.js";

const ORG = "org-owner";
const OTHER_ORG = "org-other";
const USER = "user-verified";
const UNVERIFIED = "user-unverified";
const OUTSIDER = "user-of-another-org";
const TEAMMATE = "user-teammate";
const NAMELESS = "user-without-a-name";
const TEAMMATE_ADDRESS = "teammate@example.com";
const ADDRESS = "owner@example.com";
const SLACK_LINK = "https://hooks.slack.com/services/T000/B000/secret-token";
const DISCORD_LINK = "https://discord.com/api/webhooks/123456789/secret-token_x";
const SECRETS = [
  "hooks.slack.com",
  "discord.com",
  "secret-token",
  "example.com",
  "@",
  "webhookUrl",
  "emails",
  "config",
  "integration-key",
];

interface StoredPlace extends PlaceRow {
  orgId: string;
  config: unknown;
}

let serial = 0;
const id = () => `66666666-6666-4666-8666-${String(++serial).padStart(12, "0")}`;

async function buildApp(options: { emailConfigured?: boolean; linkAllowed?: boolean } = {}) {
  const state = {
    emailConfigured: options.emailConfigured ?? true,
    places: [
      { id: id(), orgId: ORG, name: "Team Slack", type: "slack", isEnabled: true, config: { webhookUrl: SLACK_LINK } },
      { id: id(), orgId: ORG, name: "Ops hook", type: "webhook", isEnabled: true, config: { url: "https://ops.example.com/hook", secret: "secret-token" } },
      { id: id(), orgId: ORG, name: "On call", type: "pagerduty", isEnabled: true, config: { integrationKey: "integration-key" } },
      { id: id(), orgId: ORG, name: "Old Discord", type: "discord", isEnabled: false, config: { webhookUrl: DISCORD_LINK } },
      { id: id(), orgId: OTHER_ORG, name: "Their Slack", type: "slack", isEnabled: true, config: { webhookUrl: SLACK_LINK } },
    ] as StoredPlace[],
    users: [
      { id: USER, orgs: [ORG], email: ADDRESS, emailVerified: true, displayName: "Ada Owner" },
      { id: UNVERIFIED, orgs: [ORG], email: "new@example.com", emailVerified: false, displayName: "Newcomer" },
      { id: OUTSIDER, orgs: [OTHER_ORG], email: "them@example.com", emailVerified: true, displayName: "Outsider" },
      { id: TEAMMATE, orgs: [ORG], email: TEAMMATE_ADDRESS, emailVerified: true, displayName: "Ben" },
      { id: NAMELESS, orgs: [ORG], email: "nameless@example.com", emailVerified: true, displayName: null },
    ] as Array<{ id: string; orgs: string[]; email: string; emailVerified: boolean; displayName: string | null }>,
  };
  const sends: Array<{ via: "channel" | "email"; channelId: string; message: ChannelMessage }> = [];
  const guardAsked: string[] = [];
  const bodies: string[] = [];
  const hooks: { send?: () => Promise<void>; beforeCreate?: () => void } = {};

  const prisma: DestinationsPrisma = {
    alertChannel: {
      findMany: async ({ where, select }) =>
        state.places
          .filter(
            (p) =>
              p.orgId === where.orgId &&
              (where.type === undefined || p.type === where.type) &&
              (where.isEnabled === undefined || p.isEnabled === where.isEnabled),
          )
          .map((p) => ({
            id: p.id,
            name: p.name,
            type: p.type,
            isEnabled: p.isEnabled,
            ...(select.config ? { config: p.config } : {}),
          })),
    },
    user: {
      findFirst: async ({ where }) => {
        const user = state.users.find((u) => u.id === where.id && u.orgs.includes(where.memberships.some.orgId));
        return user ? { email: user.email, emailVerified: user.emailVerified, displayName: user.displayName } : null;
      },
    },
  };

  const auth: preHandlerAsyncHookHandler = async (request, reply) => {
    if (!request.auth) return reply.status(401).send({ error: "Unauthorized", message: "Authentication required" });
  };
  const deps = buildDestinationsDeps({
    prisma,
    auth,
    // Stands in for services/monitoring.ts createAlertChannel: the stored row carries its config.
    createAlertChannel: async (orgId, name, type, config: PlaceConfig) => {
      hooks.beforeCreate?.();
      hooks.beforeCreate = undefined;
      if (state.places.some((p) => p.orgId === orgId && p.name === name)) {
        throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      }
      const row = { id: id(), orgId, name, type, isEnabled: true, config };
      state.places.push(row);
      return row;
    },
    // The address guard, with DNS stood in: every host resolves to a public address or a private one.
    guardDeps: {
      resolveHost: async (hostname) => {
        guardAsked.push(hostname);
        return [options.linkAllowed === false ? "10.0.0.7" : "93.184.216.34"];
      },
    },
    emailConfigured: () => state.emailConfigured,
    delivery: () => ({
      loadAlertChannel: async (channelId, orgId) => {
        const place = state.places.find((p) => p.id === channelId && p.orgId === orgId);
        return place ? { id: place.id, name: place.name, type: place.type, isEnabled: place.isEnabled, config: place.config } : null;
      },
      sendToChannel: async (channel, message) => {
        sends.push({ via: "channel", channelId: channel.id, message });
        await hooks.send?.();
      },
      sendEmail: async (channel, message) => {
        sends.push({ via: "email", channelId: channel.id, message });
        await hooks.send?.();
      },
    }),
  });

  const app = Fastify();
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    const org = request.headers["x-test-org"];
    if (typeof org !== "string") return;
    const user = request.headers["x-test-user"];
    (request as { auth: unknown }).auth =
      typeof user === "string"
        ? { orgId: org, userId: user, type: "jwt" }
        : { orgId: org, userId: null, type: "api_key", apiKeyId: "key_1", scopes: [] };
  });
  // Every answer, as it went out.
  app.addHook("onSend", async (_request, _reply, payload) => {
    bodies.push(typeof payload === "string" ? payload : "");
    return payload;
  });
  await app.register(createDestinationsRoutes(deps), { prefix: "/api/destinations" });
  await app.ready();
  return { app, state, sends, guardAsked, bodies, hooks };
}

const member = (user = USER, org = ORG) => ({ "x-test-org": org, "x-test-user": user });
const apiKey = { "x-test-org": ORG };

const post = (app: FastifyInstance, path: string, payload?: unknown, headers: Record<string, string> = member()) =>
  app.inject({
    method: "POST",
    url: `/api/destinations${path}`,
    headers: payload === undefined ? headers : { "content-type": "application/json", ...headers },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
const list = (app: FastifyInstance, headers: Record<string, string> = member()) =>
  app.inject({ method: "GET", url: "/api/destinations", headers });

/** No answer of these routes may carry a link or an address. */
function assertNoSecrets(bodies: string[]) {
  assert.ok(bodies.length > 0);
  for (const body of bodies) {
    for (const secret of SECRETS) assert.ok(!body.includes(secret), `an answer carries "${secret}": ${body}`);
  }
}

test("the list is the organization's places a result can go to, by id, name and type only", async () => {
  const { app, state, bodies } = await buildApp();
  assert.equal((await app.inject({ method: "GET", url: "/api/destinations" })).statusCode, 401);

  const res = await list(app);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), [
    { channelId: state.places[0]!.id, name: "Team Slack", type: "slack", mine: false },
    { channelId: state.places[1]!.id, name: "Ops hook", type: "webhook", mine: false },
  ]);
  // A key reads it too, and the other organization sees only its own.
  assert.equal((await list(app, apiKey)).json().length, 2);
  assert.deepEqual((await list(app, member(OUTSIDER, OTHER_ORG))).json().map((d: { name: string }) => d.name), ["Their Slack"]);
  assertNoSecrets(bodies.slice(1));
  await app.close();
});

test("a Slack or Discord place is stored by its pasted link, as the Monitoring form stores one", async () => {
  const { app, state, guardAsked, bodies } = await buildApp();

  const slack = await post(app, "", { type: "slack", link: `  ${SLACK_LINK} ` });
  assert.equal(slack.statusCode, 201);
  assert.deepEqual(Object.keys(slack.json()).sort(), ["channelId", "mine", "name", "type"]);
  assert.equal(slack.json().name, "Slack");
  assert.equal(slack.json().type, "slack");
  const stored = state.places.find((p) => p.id === slack.json().channelId)!;
  assert.equal(stored.orgId, ORG);
  assert.deepEqual(stored.config, { webhookUrl: SLACK_LINK });

  // The default name counts up; a key may add a link place too.
  const again = await post(app, "", { type: "slack", link: SLACK_LINK }, apiKey);
  assert.equal(again.statusCode, 201);
  assert.equal(again.json().name, "Slack 2");

  const discord = await post(app, "", { type: "discord", link: DISCORD_LINK, name: "  Announcements " });
  assert.equal(discord.statusCode, 201);
  assert.equal(discord.json().name, "Announcements");
  assert.deepEqual(state.places.find((p) => p.id === discord.json().channelId)!.config, { webhookUrl: DISCORD_LINK });

  const taken = await post(app, "", { type: "discord", link: DISCORD_LINK, name: "Team Slack" });
  assert.equal(taken.statusCode, 409);
  assert.deepEqual(taken.json(), { error: "name_taken", message: DESTINATION_MESSAGES.nameTaken });

  // Every stored link went through the address guard.
  assert.deepEqual(guardAsked, ["hooks.slack.com", "hooks.slack.com", "discord.com", "discord.com"]);
  assert.equal((await list(app)).json().length, 5);
  assertNoSecrets(bodies);
  await app.close();
});

test("a default name another request took meanwhile counts up again", async () => {
  const { app, state, hooks } = await buildApp();
  hooks.beforeCreate = () => {
    state.places.push({ id: id(), orgId: ORG, name: "Discord", type: "discord", isEnabled: true, config: {} });
  };
  const res = await post(app, "", { type: "discord", link: DISCORD_LINK });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().name, "Discord 2");
  await app.close();
});

test("slack and discord links are held to their hosts", async () => {
  const { app, state, bodies } = await buildApp();
  const before = state.places.length;
  const bad: Array<["slack" | "discord", unknown]> = [
    ["slack", undefined],
    ["slack", ""],
    ["slack", "hooks.slack.com/services/T/B/x"],
    ["slack", "http://hooks.slack.com/services/T/B/x"],
    ["slack", "https://hooks.slack.com.evil.test/services/T/B/x"],
    ["slack", "https://evil.test/services/T/B/x?u=hooks.slack.com"],
    ["slack", "https://user:pass@hooks.slack.com/services/T/B/x"],
    ["slack", "https://hooks.slack.com:8443/services/T/B/x"],
    ["slack", "https://hooks.slack.com/"],
    ["slack", DISCORD_LINK],
    ["slack", "https://169.254.169.254/services/T/B/x"],
    ["discord", SLACK_LINK],
    ["discord", "https://discord.com/api/users/@me"],
    ["discord", "https://discord.com.evil.test/api/webhooks/1/x"],
    ["discord", "https://discord.com/api/webhooks/not-a-number/x"],
    ["discord", "http://discord.com/api/webhooks/1/x"],
    ["discord", `https://discord.com/api/webhooks/1/${"x".repeat(2100)}`],
  ];
  for (const [type, link] of bad) {
    const res = await post(app, "", { type, ...(link === undefined ? {} : { link }) });
    assert.equal(res.statusCode, 400, `${type} ${String(link)}`);
    assert.deepEqual(res.json(), {
      error: "invalid_link",
      message: type === "slack" ? DESTINATION_MESSAGES.slackLink : DESTINATION_MESSAGES.discordLink,
    });
    assert.equal(pastedLink(type, link), null);
  }
  for (const body of bodies) assert.ok(!body.includes("evil.test") && !body.includes("user:pass"));
  assert.equal(state.places.length, before);

  assert.equal(pastedLink("slack", SLACK_LINK), SLACK_LINK);
  assert.equal(pastedLink("discord", "https://discordapp.com/api/v10/webhooks/42/tok-en_1"), "https://discordapp.com/api/v10/webhooks/42/tok-en_1");

  // A right-looking link whose host points inside is refused by the address guard.
  const inside = await buildApp({ linkAllowed: false });
  const refused = await post(inside.app, "", { type: "slack", link: SLACK_LINK });
  assert.equal(refused.statusCode, 400);
  assert.equal(refused.json().error, "invalid_link");
  assert.deepEqual(inside.guardAsked, ["hooks.slack.com"]);
  assert.equal(inside.state.places.length, before);
  await inside.app.close();
  await app.close();
});

test("email uses only the caller's own verified address, and refuses a key", async () => {
  const { app, state, bodies } = await buildApp();

  // The body carries no address: anything that tries to is refused.
  for (const body of [
    { type: "email", address: "victim@elsewhere.test" },
    { type: "email", emails: ["victim@elsewhere.test"] },
    { type: "email", config: { emails: ["victim@elsewhere.test"] } },
    { type: "email", email: "victim@elsewhere.test" },
    { type: "pagerduty" },
    { type: "webhook", link: "https://ops.example.com/hook" },
    {},
  ]) {
    const res = await post(app, "", body);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.equal(res.json().error, "validation_failed");
  }
  const linked = await post(app, "", { type: "email", link: "mailto:victim@elsewhere.test" });
  assert.equal(linked.statusCode, 400);
  assert.deepEqual(linked.json(), { error: "invalid_link", message: DESTINATION_MESSAGES.emailTakesNoLink });

  const byKey = await post(app, "", { type: "email" }, apiKey);
  assert.equal(byKey.statusCode, 400);
  assert.deepEqual(byKey.json(), { error: "email_needs_sign_in", message: DESTINATION_MESSAGES.emailNeedsSignIn });

  const unverified = await post(app, "", { type: "email" }, member(UNVERIFIED));
  assert.equal(unverified.statusCode, 400);
  assert.deepEqual(unverified.json(), {
    error: "email_not_verified",
    message: "Verify your email address first, then choose Email.",
  });
  // A verified user who is not a member of this organization has no address here.
  assert.equal((await post(app, "", { type: "email" }, member(OUTSIDER))).json().error, "email_not_verified");
  assert.ok(!state.places.some((p) => p.type === "email"));

  const made = await post(app, "", { type: "email" });
  assert.equal(made.statusCode, 201);
  // Named for the person, so a teammate who sees it in the list knows whose it is.
  assert.equal(made.json().name, "Email to Ada Owner");
  assert.equal(made.json().type, "email");
  assert.equal(made.json().mine, true);
  const stored = state.places.find((p) => p.id === made.json().channelId)!;
  assert.deepEqual(stored.config, { emails: [ADDRESS] });
  assert.equal(stored.orgId, ORG);

  // Choosing it again is the same place.
  const again = await post(app, "", { type: "email", name: "Another name" });
  assert.equal(again.statusCode, 200);
  assert.deepEqual(again.json(), made.json());
  assert.equal(state.places.filter((p) => p.type === "email").length, 1);

  assertNoSecrets(bodies.filter((body) => !body.includes("validation_failed")));
  for (const body of bodies) assert.ok(!body.includes("elsewhere.test") && !body.includes(ADDRESS));
  await app.close();
});

test("an email place is named for its member, and only that member's list says it is theirs", async () => {
  const { app, state, bodies } = await buildApp();

  const made = await post(app, "", { type: "email" });
  assert.equal(made.statusCode, 201);
  assert.deepEqual(made.json(), { channelId: made.json().channelId, name: "Email to Ada Owner", type: "email", mine: true });
  const placeId = made.json().channelId;
  const entry = async (headers: Record<string, string>) =>
    (await list(app, headers)).json().find((d: { channelId: string }) => d.channelId === placeId);

  // Its owner sees it as theirs; a teammate sees whose it is, and that it is not theirs.
  assert.deepEqual(await entry(member()), { channelId: placeId, name: "Email to Ada Owner", type: "email", mine: true });
  assert.deepEqual(await entry(member(TEAMMATE)), { channelId: placeId, name: "Email to Ada Owner", type: "email", mine: false });
  assert.ok(!(await list(app, member(TEAMMATE))).json().some((d: { name: string }) => d.name === "Email to me"));
  // A key has no member behind it: nothing is its own.
  const byKey = (await list(app, apiKey)).json() as Array<{ mine: boolean }>;
  assert.equal(byKey.length, 3);
  assert.ok(byKey.every((d) => d.mine === false));
  // Only an email place can be anyone's own.
  assert.ok((await list(app, member())).json().every((d: { type: string; mine: boolean }) => d.mine === (d.type === "email")));

  // The teammate's own "Email me" is a second place, under their name, to their address.
  const theirs = await post(app, "", { type: "email" }, member(TEAMMATE));
  assert.equal(theirs.statusCode, 201);
  assert.deepEqual(theirs.json(), { channelId: theirs.json().channelId, name: "Email to Ben", type: "email", mine: true });
  assert.deepEqual(state.places.find((p) => p.id === theirs.json().channelId)!.config, { emails: [TEAMMATE_ADDRESS] });
  assert.deepEqual(
    (await list(app, member(TEAMMATE))).json().filter((d: { type: string }) => d.type === "email"),
    [
      { channelId: placeId, name: "Email to Ada Owner", type: "email", mine: false },
      { channelId: theirs.json().channelId, name: "Email to Ben", type: "email", mine: true },
    ],
  );

  // A member with no display name, and the count on a clash of names.
  const nameless = await post(app, "", { type: "email" }, member(NAMELESS));
  assert.equal(nameless.json().name, "Email to a teammate");
  assert.equal(nameless.json().mine, true);
  state.users.push({ id: "user-ben-2", orgs: [ORG], email: "ben2@example.com", emailVerified: true, displayName: "Ben" });
  assert.equal((await post(app, "", { type: "email" }, member("user-ben-2"))).json().name, "Email to Ben 2");

  // A typed address in a Monitoring channel that happens to be the member's own counts as theirs;
  // one with a second address does not.
  state.places.push({ id: id(), orgId: ORG, name: "Shared inbox", type: "email", isEnabled: true, config: { emails: [ADDRESS, "ops@example.com"] } });
  assert.equal((await entry(member()))!.mine, true);
  assert.equal((await list(app, member())).json().find((d: { name: string }) => d.name === "Shared inbox").mine, false);
  // A slack or discord place made here is nobody's own.
  assert.equal((await post(app, "", { type: "slack", link: SLACK_LINK })).json().mine, false);

  assertNoSecrets(bodies);
  await app.close();
});

test("501 email_not_configured while the email provider is not set up", async () => {
  const { app, state, sends } = await buildApp({ emailConfigured: false });
  const res = await post(app, "", { type: "email" });
  assert.equal(res.statusCode, 501);
  assert.deepEqual(res.json(), {
    error: "email_not_configured",
    message: "Email delivery is temporarily unavailable. Results are still saved here.",
  });
  assert.ok(!state.places.some((p) => p.type === "email"));
  // A key is told about itself first: it could not choose email either way.
  assert.equal((await post(app, "", { type: "email" }, apiKey)).json().error, "email_needs_sign_in");

  state.places.push({ id: id(), orgId: ORG, name: "Email to me", type: "email", isEnabled: true, config: { emails: [ADDRESS] } });
  const test = await post(app, `/${state.places.at(-1)!.id}/test`);
  assert.equal(test.statusCode, 501);
  assert.equal(test.json().error, "email_not_configured");
  assert.equal(sends.length, 0);
  await app.close();
});

test("a test goes through the senders a result uses; another organization's place is 404", async () => {
  const { app, state, sends, bodies, hooks } = await buildApp();
  const [slack, , pagerduty, disabled, foreign] = state.places;

  const sent = await post(app, `/${slack!.id}/test`);
  assert.equal(sent.statusCode, 200);
  assert.deepEqual(sent.json(), { sent: true });
  assert.deepEqual(sends, [{ via: "channel", channelId: slack!.id, message: TEST_MESSAGE }]);
  assert.equal(TEST_MESSAGE.kind, "result");

  const email = await post(app, "", { type: "email" });
  assert.equal((await post(app, `/${email.json().channelId}/test`, undefined, apiKey)).statusCode, 200);
  assert.equal(sends[1]!.via, "email");

  for (const path of [`/${foreign!.id}/test`, "/66666666-6666-4666-8666-ffffffffffff/test", "/not-an-id/test"]) {
    const res = await post(app, path);
    assert.equal(res.statusCode, 404, path);
    assert.deepEqual(res.json(), { error: "not_found", message: DESTINATION_MESSAGES.notFound });
  }
  assert.equal((await post(app, `/${pagerduty!.id}/test`)).json().error, "unsupported_place");
  assert.equal((await post(app, `/${disabled!.id}/test`)).json().error, "place_turned_off");
  assert.equal(sends.length, 2);

  hooks.send = async () => {
    throw new Error(`Slack responded 404 for ${SLACK_LINK}`);
  };
  const failed = await post(app, `/${slack!.id}/test`);
  assert.equal(failed.statusCode, 502);
  assert.deepEqual(failed.json(), {
    error: "delivery_failed",
    message: "The test could not be sent. Check the link and try again.",
  });
  const mail = await post(app, `/${email.json().channelId}/test`);
  assert.equal(mail.statusCode, 502);
  assert.deepEqual(mail.json(), { error: "delivery_failed", message: DESTINATION_MESSAGES.testEmailFailed });
  assert.equal((await post(app, `/${slack!.id}/test`, undefined, {})).statusCode, 401);

  assertNoSecrets(bodies);
  await app.close();
});

test("the helpers: a free name, an own-address config, the default names", () => {
  assert.equal(freeName("Slack", []), "Slack");
  assert.equal(freeName("Slack", ["Slack", "Slack 2", "Discord"]), "Slack 3");
  assert.deepEqual(DEFAULT_DESTINATION_NAMES, { slack: "Slack", discord: "Discord", email: "Email to a teammate" });
  assert.equal(emailPlaceName("Ada Owner"), "Email to Ada Owner");
  assert.equal(emailPlaceName("  Ada  "), "Email to Ada");
  assert.equal(emailPlaceName(null), "Email to a teammate");
  assert.equal(emailPlaceName("   "), "Email to a teammate");
  // A display name is free text: an address typed there does not become a place's name.
  assert.equal(emailPlaceName("ada@example.com"), "Email to a teammate");
  assert.equal(emailPlaceName("x".repeat(200)).length, 80);
  assert.equal(isOwnEmailConfig({ emails: ["Owner@Example.com"] }, ADDRESS), true);
  assert.equal(isOwnEmailConfig({ emails: [ADDRESS, "other@example.com"] }, ADDRESS), false);
  assert.equal(isOwnEmailConfig({ emails: [] }, ADDRESS), false);
  assert.equal(isOwnEmailConfig(null, ADDRESS), false);
});
