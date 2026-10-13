import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CliError } from "../src/errors.js";
import {
  checkListingText,
  defaultListingFields,
  describePublishOutcome,
  preflightListing,
  publishAgent,
  publishCommandLine,
} from "../src/lib/listing.js";
import { describePlans } from "../src/lib/pricing.js";
import { AGENT_ID, agent, fakeApi, status } from "./helpers.js";

const LISTING_ID = "44444444-4444-4444-8444-444444444444";
const listing = (overrides: Record<string, unknown> = {}) => ({
  id: LISTING_ID,
  agentId: AGENT_ID,
  title: "My Support Bot",
  slug: "my-support-bot",
  shortDescription: "Answers customer support questions about orders and refunds.",
  category: "other",
  status: "draft",
  pricingModel: "free",
  pricePerRequestCents: null,
  monthlyPriceCents: null,
  ...overrides,
});

describe("defaultListingFields", () => {
  it("takes title and description from the agent", () => {
    assert.deepEqual(defaultListingFields(agent()), {
      title: "My Support Bot",
      shortDescription: "Answers customer support questions about orders and refunds.",
      category: "other",
    });
  });

  it("the fallback line says how a task agent and a scheduled agent are used", () => {
    assert.equal(
      defaultListingFields(agent({ description: null, agentKind: "task" })).shortDescription,
      "My Support Bot: a custom agent that does a task you give it, built on WheelsAI.",
    );
    assert.equal(
      defaultListingFields(agent({ description: null, agentKind: "scheduled" })).shortDescription,
      "My Support Bot: a custom agent that runs on its own, built on WheelsAI.",
    );
  });

  it("truncates a long description to the API's 280 characters", () => {
    const fields = defaultListingFields(agent({ description: "x".repeat(500) }));
    assert.equal(fields.shortDescription.length, 280);
  });

  it("falls back to a line built from the agent's name and framework when the description is missing or too short", () => {
    for (const description of [null, "", "short"]) {
      const fields = defaultListingFields(agent({ description }));
      assert.equal(fields.shortDescription, "My Support Bot: a custom agent built on WheelsAI.");
      assert.ok(fields.shortDescription.length >= 10);
    }
  });

  it("uses a category found in the agent's tags", () => {
    assert.equal(defaultListingFields(agent({ tags: ["demo", "research"] })).category, "research");
  });
});

describe("checkListingText", () => {
  it("accepts text inside the API's limits, and no text at all", () => {
    checkListingText({});
    checkListingText({ title: "abc", description: "x".repeat(10) });
    checkListingText({ title: "x".repeat(100), description: "x".repeat(280) });
  });

  it("refuses a title or description the API would reject, naming the flag and the limits", () => {
    assert.throws(() => checkListingText({ title: "ab" }), /--title must be 3 to 100 characters, got 2/);
    assert.throws(() => checkListingText({ title: "x".repeat(101) }), /--title must be 3 to 100 characters, got 101/);
    assert.throws(() => checkListingText({ title: "" }), CliError);
    assert.throws(() => checkListingText({ description: "too short" }), /--description must be 10 to 280 characters, got 9/);
    assert.throws(() => checkListingText({ description: "x".repeat(281) }), /--description must be 10 to 280 characters, got 281/);
  });
});

describe("preflightListing", () => {
  it("only reads: one lookup, no listing is created", async () => {
    const api = fakeApi({ "GET /api/marketplace/my-listings": { listings: [] } });
    await preflightListing(api.wheels, agent(), { pricing: null });
    assert.deepEqual(api.calls.map((call) => `${call.method} ${call.path}`), ["GET /api/marketplace/my-listings"]);
  });

  it("refuses bad flags before asking the API anything", async () => {
    const api = fakeApi({});
    await assert.rejects(preflightListing(api.wheels, agent(), { pricing: null, title: "ab" }), CliError);
    await assert.rejects(preflightListing(api.wheels, agent(), { pricing: null, category: "finance" }), CliError);
    assert.equal(api.calls.length, 0);
  });

  it("refuses a new listing whose title would be an agent name outside the limits, unless --title replaces it", async () => {
    const routes = { "GET /api/marketplace/my-listings": { listings: [] } };
    await assert.rejects(preflightListing(fakeApi(routes).wheels, agent({ name: "AB" }), { pricing: null }), /"AB" is not 3 to 100 characters/);
    await preflightListing(fakeApi(routes).wheels, agent({ name: "AB" }), { pricing: null, title: "Support Pro" });
  });
});

describe("publishCommandLine", () => {
  it("repeats every listing option, quoted for a shell", () => {
    assert.equal(publishCommandLine("my-bot", { pricing: null }), "wheelsai publish --agent my-bot");
    assert.equal(publishCommandLine("my-bot", { pricing: { pricingModel: "free" } }), "wheelsai publish --agent my-bot --free");
    assert.equal(
      publishCommandLine("my-bot", { pricing: { pricingModel: "tokenized" }, copies: true }),
      "wheelsai publish --agent my-bot --copies --tokenized",
    );
    assert.equal(
      publishCommandLine("my-bot", { pricing: { pricingModel: "monthly", monthlyPriceCents: 900 }, title: "It's $HOME", description: "Ten chars!", category: "coding" }),
      `wheelsai publish --agent my-bot --monthly 900 --title 'It'\\''s $HOME' --description 'Ten chars!' --category coding`,
    );
  });
});

describe("publishAgent", () => {
  it("sends --tokenized as the tokenized pricing model", async () => {
    const api = fakeApi({
      "GET /api/marketplace/my-listings": { listings: [] },
      "POST /api/marketplace/listings": status(201, { listing: listing({ pricingModel: "tokenized" }) }),
      [`POST /api/marketplace/listings/${LISTING_ID}/publish`]: { listing: listing({ status: "published", pricingModel: "tokenized" }), message: "ok" },
    });
    const result = await publishAgent(api.wheels, agent(), "http://localhost:3000", { pricing: { pricingModel: "tokenized" } });
    assert.equal((api.requested("POST", "/api/marketplace/listings")[0]?.body as { pricingModel: string }).pricingModel, "tokenized");
    assert.equal(result.listing.pricingModel, "tokenized");
  });

  it("a new listing leaves what it sells to the API (use), and --copies sends sells: copies", async () => {
    const routes = {
      "GET /api/marketplace/my-listings": { listings: [] },
      "POST /api/marketplace/listings": status(201, { listing: listing() }),
      [`POST /api/marketplace/listings/${LISTING_ID}/publish`]: { listing: listing({ status: "published" }), message: "ok" },
    };
    const use = fakeApi(routes);
    await publishAgent(use.wheels, agent(), "http://localhost:3000", { pricing: { pricingModel: "per_request", pricePerRequestCents: 5 } });
    assert.ok(!("sells" in (use.requested("POST", "/api/marketplace/listings")[0]?.body as object)));

    const copies = fakeApi(routes);
    await publishAgent(copies.wheels, agent(), "http://localhost:3000", {
      pricing: { pricingModel: "per_request", pricePerRequestCents: 1 },
      copies: true,
    });
    assert.deepEqual(copies.requested("POST", "/api/marketplace/listings")[0]?.body, {
      agentId: AGENT_ID,
      title: "My Support Bot",
      shortDescription: "Answers customer support questions about orders and refunds.",
      category: "other",
      sells: "copies",
      pricingModel: "per_request",
      pricePerRequestCents: 1,
    });
  });

  it("--copies on an existing listing is an edit; without it what the listing sells is not touched", async () => {
    const api = fakeApi({
      "GET /api/marketplace/my-listings": { listings: [listing({ status: "published" })] },
      [`PATCH /api/marketplace/listings/${LISTING_ID}`]: { listing: listing({ status: "published", sells: "copies" }) },
    });
    await publishAgent(api.wheels, agent(), "http://localhost:3000", { pricing: null, copies: true });
    assert.deepEqual(api.requested("PATCH", `/api/marketplace/listings/${LISTING_ID}`)[0]?.body, { sells: "copies" });

    const plain = fakeApi({
      "GET /api/marketplace/my-listings": { listings: [listing({ status: "published" })] },
      [`PATCH /api/marketplace/listings/${LISTING_ID}`]: { listing: listing({ status: "published" }) },
    });
    await publishAgent(plain.wheels, agent(), "http://localhost:3000", { pricing: { pricingModel: "free" } });
    assert.deepEqual(plain.requested("PATCH", `/api/marketplace/listings/${LISTING_ID}`)[0]?.body, { pricingModel: "free" });
  });

  it("keeps the plans read with the listing when an edit or a publish answers without them", async () => {
    const plans = [{ id: "p1", kind: "paid", name: "Starter", priceCents: 900, includedUses: 500, extraUsePriceCents: null, status: "active", subscribers: 2 }];
    const onSale = { sells: "use", pricingModel: "per_request", pricePerRequestCents: 5 };
    // An edit: the answer of the update carries no plans, and the edit changed none.
    const edited = fakeApi({
      "GET /api/marketplace/my-listings": { listings: [listing({ ...onSale, status: "published", plans })] },
      [`PATCH /api/marketplace/listings/${LISTING_ID}`]: { listing: listing({ ...onSale, status: "published", title: "Renamed" }) },
    });
    const afterEdit = await publishAgent(edited.wheels, agent(), "http://localhost:3000", { pricing: null, title: "Renamed" });
    assert.equal(afterEdit.listing.title, "Renamed");
    assert.deepEqual(afterEdit.listing.plans, plans);
    assert.deepEqual(describePlans(afterEdit.listing), ["Starter: $9.00 for 30 days, 500 uses, then it stops until it renews"]);

    // A draft that is published: the same.
    const published = fakeApi({
      "GET /api/marketplace/my-listings": { listings: [listing({ ...onSale, plans })] },
      [`POST /api/marketplace/listings/${LISTING_ID}/publish`]: { listing: listing({ ...onSale, status: "published" }), message: "ok" },
    });
    const afterPublish = await publishAgent(published.wheels, agent(), "http://localhost:3000", { pricing: null });
    assert.deepEqual([afterPublish.listing.status, afterPublish.listing.plans], ["published", plans]);

    // An answer that does carry plans is believed over the ones read before.
    const answered = fakeApi({
      "GET /api/marketplace/my-listings": { listings: [listing({ ...onSale, status: "published", plans })] },
      [`PATCH /api/marketplace/listings/${LISTING_ID}`]: { listing: listing({ ...onSale, status: "published", plans: [] }) },
    });
    const afterAnswer = await publishAgent(answered.wheels, agent(), "http://localhost:3000", { pricing: null, title: "Renamed" });
    assert.deepEqual(afterAnswer.listing.plans, []);
  });

  it("creates a free draft by default, publishes it and builds the URL from the returned slug", async () => {
    const api = fakeApi({
      "GET /api/marketplace/my-listings": { listings: [] },
      "POST /api/marketplace/listings": status(201, { listing: listing() }),
      [`POST /api/marketplace/listings/${LISTING_ID}/publish`]: { listing: listing({ status: "published" }), message: "ok" },
    });
    const steps: string[] = [];
    const result = await publishAgent(api.wheels, agent(), "http://localhost:3000/", { pricing: null }, (step) => steps.push(step));

    assert.deepEqual(api.requested("POST", "/api/marketplace/listings")[0]?.body, {
      agentId: AGENT_ID,
      title: "My Support Bot",
      shortDescription: "Answers customer support questions about orders and refunds.",
      category: "other",
      pricingModel: "free",
    });
    assert.equal(result.url, "http://localhost:3000/marketplace/my-support-bot");
    assert.equal(result.listing.status, "published");
    assert.deepEqual([result.created, result.updated, result.alreadyPublished], [true, false, false]);
    assert.deepEqual(steps, ["Creating marketplace listing", "Publishing to marketplace"]);
    assert.equal(describePublishOutcome(result), "Listed on the marketplace");
  });

  it("applies flags over the defaults", async () => {
    const api = fakeApi({
      "GET /api/marketplace/my-listings": { listings: [] },
      "POST /api/marketplace/listings": status(201, { listing: listing() }),
      [`POST /api/marketplace/listings/${LISTING_ID}/publish`]: { listing: listing({ status: "published" }), message: "ok" },
    });
    await publishAgent(api.wheels, agent(), "http://localhost:3000", {
      pricing: { pricingModel: "monthly", monthlyPriceCents: 900 },
      title: "Support Pro",
      description: "A paid support agent for busy teams.",
      category: "customer-support",
    });
    assert.deepEqual(api.requested("POST", "/api/marketplace/listings")[0]?.body, {
      agentId: AGENT_ID,
      title: "Support Pro",
      shortDescription: "A paid support agent for busy teams.",
      category: "customer-support",
      pricingModel: "monthly",
      monthlyPriceCents: 900,
    });
  });

  it("rejects an unknown category before calling the API", async () => {
    const api = fakeApi({});
    await assert.rejects(publishAgent(api.wheels, agent(), "http://x", { pricing: null, category: "finance" }), CliError);
    assert.equal(api.calls.length, 0);
  });

  it("reuses an existing published listing without changing it", async () => {
    const api = fakeApi({ "GET /api/marketplace/my-listings": { listings: [listing({ status: "published" })] } });
    const result = await publishAgent(api.wheels, agent(), "http://localhost:3000", { pricing: null });
    assert.equal(result.alreadyPublished, true);
    assert.equal(api.calls.length, 1, "only the lookup: no create, update or publish");
    assert.equal(describePublishOutcome(result), "Already listed on the marketplace");
  });

  it("edits an existing listing only when flags ask for it", async () => {
    const api = fakeApi({
      "GET /api/marketplace/my-listings": { listings: [listing({ status: "published" })] },
      [`PATCH /api/marketplace/listings/${LISTING_ID}`]: { listing: listing({ status: "published", pricingModel: "per_request", pricePerRequestCents: 5 }) },
    });
    const result = await publishAgent(api.wheels, agent(), "http://localhost:3000", {
      pricing: { pricingModel: "per_request", pricePerRequestCents: 5 },
    });
    assert.deepEqual(api.requested("PATCH", `/api/marketplace/listings/${LISTING_ID}`)[0]?.body, {
      pricingModel: "per_request",
      pricePerRequestCents: 5,
    });
    assert.equal(result.updated, true);
    assert.equal(describePublishOutcome(result), "Updated the listing (already on the marketplace)");
  });

  it("publishes an existing draft", async () => {
    const api = fakeApi({
      "GET /api/marketplace/my-listings": { listings: [listing({ status: "draft" })] },
      [`POST /api/marketplace/listings/${LISTING_ID}/publish`]: { listing: listing({ status: "published" }), message: "ok" },
    });
    const result = await publishAgent(api.wheels, agent(), "http://localhost:3000", { pricing: null });
    assert.equal(result.listing.status, "published");
    assert.equal(describePublishOutcome(result), "Published the existing listing");
  });

  it("ignores listings that belong to other agents", async () => {
    const api = fakeApi({
      "GET /api/marketplace/my-listings": { listings: [listing({ agentId: "99999999-9999-4999-8999-999999999999", status: "published" })] },
      "POST /api/marketplace/listings": status(201, { listing: listing() }),
      [`POST /api/marketplace/listings/${LISTING_ID}/publish`]: { listing: listing({ status: "published" }), message: "ok" },
    });
    const result = await publishAgent(api.wheels, agent(), "http://localhost:3000", { pricing: null });
    assert.equal(result.created, true);
  });

  it("passes the API's error through", async () => {
    const api = fakeApi({
      "GET /api/marketplace/my-listings": { listings: [] },
      "POST /api/marketplace/listings": status(400, { error: "validation_failed", details: { formErrors: [], fieldErrors: { title: ["String must contain at least 3 character(s)"] } } }),
    });
    await assert.rejects(publishAgent(api.wheels, agent(), "http://x", { pricing: null, title: "ab" }), {
      status: 400,
      message: "validation_failed: title: String must contain at least 3 character(s)",
    });
  });
});
