import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import type { Prisma } from "@prisma/client";

import { planWarningEmail, type EmailMessage } from "../services/email/emailService.js";
import {
  PLAN_WARNING_ROLES,
  PLAN_WARNING_USAGE_PATH,
  planWarningRecipients,
  planWarningWords,
  sendPlanWarning,
  type PlanWarningAsk,
  type PlanWarningDb,
  type PlanWarningDeps,
  type PlanWarningMembersDb,
} from "../services/planWarnings.js";

// The warning a plan sends by email. What these pin: a level is claimed once,
// by the database, whoever asks and however many at once; only the request
// that wins the claim sends; a level is claimable again only in another
// period; nothing is claimed when no email can be sent; nothing here throws;
// and the words of both emails.

// Prisma's client is accepted where the claim's narrow one is asked for.
export const acceptsPrisma = (db: Prisma.TransactionClient): PlanWarningDb => db;
export const membersAcceptPrisma = (db: Prisma.TransactionClient): PlanWarningMembersDb => db;

const START = new Date("2026-10-13T00:00:00Z");
const END = new Date("2026-11-12T00:00:00Z");
const NOW = new Date("2026-10-20T12:00:00Z");
const WEB = "https://app.example";

interface Row {
  id: string;
  currentPeriodStart: Date;
  warnedLevel: number;
}

const ask = (over: Partial<PlanWarningAsk> = {}): PlanWarningAsk => ({
  orgId: "org-buyer",
  subscriptionId: "sub-1",
  periodStart: START,
  planName: "Starter",
  agentTitle: "Support Bot",
  includedUses: 500,
  carriedUses: 0,
  usedUses: 425,
  extraUsePriceCents: null,
  periodEnd: END,
  renews: true,
  ...over,
});

interface Options {
  row?: Partial<Row>;
  configured?: boolean;
  addresses?: string[];
  senderThrows?: boolean | ((to: string) => boolean);
  recipientsThrow?: boolean;
  claimThrows?: boolean;
}

function harness(options: Options = {}) {
  const row: Row = { id: "sub-1", currentPeriodStart: START, warnedLevel: 0, ...options.row };
  const sent: EmailMessage[] = [];
  const logged: string[] = [];
  let claims = 0;
  let reads = 0;
  const deps: PlanWarningDeps = {
    emailConfigured: () => options.configured ?? true,
    db: {
      agentSubscription: {
        // One statement that the database decides, as Postgres does: the
        // compare and the write have no await between them.
        updateMany: async ({ where, data }) => {
          claims += 1;
          await Promise.resolve();
          if (options.claimThrows) throw new Error("database is down");
          const matches =
            row.id === where.id &&
            row.currentPeriodStart.getTime() === where.currentPeriodStart.getTime() &&
            row.warnedLevel < where.warnedLevel.lt;
          if (!matches) return { count: 0 };
          row.warnedLevel = data.warnedLevel;
          return { count: 1 };
        },
      },
    },
    recipients: async () => {
      reads += 1;
      if (options.recipientsThrow) throw new Error("database is down");
      return options.addresses ?? ["owner@buyer.example", "admin@buyer.example"];
    },
    buildEmail: planWarningEmail,
    sendEmail: async (message) => {
      const fails =
        typeof options.senderThrows === "function" ? options.senderThrows(message.to) : options.senderThrows === true;
      if (fails) throw new Error("the provider said 500");
      sent.push(message);
    },
    webUrl: WEB,
    now: () => NOW,
    logger: {
      warn: (_obj, msg) => logged.push(`warn:${msg}`),
      error: (_obj, msg) => logged.push(`error:${msg}`),
    },
  };
  return {
    deps,
    row,
    sent,
    logged,
    claims: () => claims,
    reads: () => reads,
    /** What a renewal, a move or a new start does to the row. */
    newPeriod(start: Date) {
      row.currentPeriodStart = start;
      row.warnedLevel = 0;
    },
  };
}

test("who is told, and where the link goes, are named once", () => {
  assert.deepEqual([...PLAN_WARNING_ROLES], ["owner", "admin"]);
  assert.equal(PLAN_WARNING_USAGE_PATH, "/dashboard/usage");
});

test("who is told: owners and admins of that organization, and only an address that was verified", async () => {
  const asked: unknown[] = [];
  const db: PlanWarningMembersDb = {
    orgMember: {
      // Every row comes back whatever was asked, so the check on the rows is held too.
      findMany: async (args) => {
        asked.push(args);
        return [
          { user: { email: "owner@buyer.example", emailVerified: true } },
          { user: { email: "typed-in@stranger.example", emailVerified: false } },
          { user: { email: null, emailVerified: true } },
          { user: { email: "  ", emailVerified: true } },
          { user: { email: "admin@buyer.example", emailVerified: true } },
        ];
      },
    },
  };
  assert.deepEqual(await planWarningRecipients(db, "org-buyer"), ["owner@buyer.example", "admin@buyer.example"]);
  assert.deepEqual(asked, [
    {
      where: { orgId: "org-buyer", role: { in: ["owner", "admin"] }, user: { emailVerified: true } },
      select: { user: { select: { email: true, emailVerified: true } } },
    },
  ]);
});

test("below 85% nothing is claimed, read or sent", async () => {
  const h = harness();
  const result = await sendPlanWarning(h.deps, ask({ usedUses: 424 }));
  assert.deepEqual(result, { level: 0, claimed: false, sent: 0 });
  assert.deepEqual([h.claims(), h.reads(), h.sent.length, h.row.warnedLevel], [0, 0, 0, 0]);
});

test("the use that reaches 85% sends one email to each owner and admin, and the next use sends none", async () => {
  const h = harness();
  const first = await sendPlanWarning(h.deps, ask({ usedUses: 425 }));
  assert.deepEqual(first, { level: 85, claimed: true, sent: 2 });
  assert.deepEqual(
    h.sent.map((m) => m.to),
    ["owner@buyer.example", "admin@buyer.example"],
  );
  assert.equal(h.row.warnedLevel, 85);

  const second = await sendPlanWarning(h.deps, ask({ usedUses: 426 }));
  assert.deepEqual(second, { level: 85, claimed: false, sent: 0 });
  assert.equal(h.sent.length, 2);
  // The second was decided by the claim and read nobody.
  assert.equal(h.reads(), 1);
});

for (const [name, used, level] of [
  ["85%", 425, 85],
  ["100%", 500, 100],
] as const) {
  test(`two requests that reach ${name} at the same moment: one sends, one does not`, async () => {
    const h = harness({ addresses: ["owner@buyer.example"] });
    const results = await Promise.all([
      sendPlanWarning(h.deps, ask({ usedUses: used })),
      sendPlanWarning(h.deps, ask({ usedUses: used })),
    ]);
    assert.deepEqual(results.map((r) => r.claimed).sort(), [false, true]);
    assert.deepEqual(results.map((r) => r.sent).sort(), [0, 1]);
    assert.equal(h.sent.length, 1);
    assert.equal(h.claims(), 2);
    assert.equal(h.row.warnedLevel, level);
  });
}

test("85% and then 100% are two emails, one for each level", async () => {
  const h = harness({ addresses: ["owner@buyer.example"] });
  await sendPlanWarning(h.deps, ask({ usedUses: 425 }));
  await sendPlanWarning(h.deps, ask({ usedUses: 499 }));
  await sendPlanWarning(h.deps, ask({ usedUses: 500 }));
  assert.deepEqual(
    h.sent.map((m) => m.subject),
    ["You have used 85% of your Starter plan", "You have used all of your Starter plan"],
  );
  assert.equal(h.row.warnedLevel, 100);
});

test("a plan that goes straight to 100% sends the 100% email only, and a later use sends none", async () => {
  const h = harness({ addresses: ["owner@buyer.example"] });
  // A plan of one use: its first use is its last.
  const one = { includedUses: 1, usedUses: 1 };
  assert.deepEqual(await sendPlanWarning(h.deps, ask(one)), { level: 100, claimed: true, sent: 1 });
  assert.deepEqual(
    h.sent.map((m) => m.subject),
    ["You have used all of your Starter plan"],
  );
  // A late request that still reads 85%, and one more at 100%: neither sends.
  assert.equal((await sendPlanWarning(h.deps, ask({ usedUses: 430 }))).claimed, false);
  assert.equal((await sendPlanWarning(h.deps, ask(one))).claimed, false);
  assert.equal(h.sent.length, 1);
  assert.equal(h.row.warnedLevel, 100);
});

test("after a renewal, a move or a new start each level can be claimed again", async () => {
  const h = harness({ addresses: ["owner@buyer.example"] });
  await sendPlanWarning(h.deps, ask({ usedUses: 425 }));
  await sendPlanWarning(h.deps, ask({ usedUses: 500 }));
  assert.equal(h.sent.length, 2);

  const next = new Date("2026-11-12T00:00:00Z");
  h.newPeriod(next);
  const later = { periodStart: next, periodEnd: new Date("2026-12-12T00:00:00Z") };
  assert.equal((await sendPlanWarning(h.deps, ask({ ...later, usedUses: 425 }))).claimed, true);
  assert.equal((await sendPlanWarning(h.deps, ask({ ...later, usedUses: 426 }))).claimed, false);
  assert.equal((await sendPlanWarning(h.deps, ask({ ...later, usedUses: 500 }))).claimed, true);
  assert.equal(h.sent.length, 4);
});

test("a claim made for an older period start misses", async () => {
  const h = harness();
  h.newPeriod(new Date("2026-11-12T00:00:00Z"));
  // A use taken before the renewal, asked after it.
  const result = await sendPlanWarning(h.deps, ask({ usedUses: 500 }));
  assert.deepEqual(result, { level: 100, claimed: false, sent: 0 });
  assert.deepEqual([h.sent.length, h.row.warnedLevel], [0, 0]);
});

test("a claim for another subscription's row misses", async () => {
  const h = harness();
  const result = await sendPlanWarning(h.deps, ask({ subscriptionId: "sub-2" }));
  assert.deepEqual([result.claimed, h.sent.length, h.row.warnedLevel], [false, 0, 0]);
});

test("email not set up: nothing is claimed and nothing is sent, and the level is still there to tell", async () => {
  const off = harness({ configured: false });
  const result = await sendPlanWarning(off.deps, ask({ usedUses: 500 }));
  assert.deepEqual(result, { level: 100, claimed: false, sent: 0 });
  assert.deepEqual([off.claims(), off.reads(), off.sent.length, off.row.warnedLevel], [0, 0, 0, 0]);
});

test("a sender that throws is logged and the claim stays: no second email and no error to the caller", async () => {
  const h = harness({ senderThrows: true });
  const result = await sendPlanWarning(h.deps, ask());
  assert.deepEqual(result, { level: 85, claimed: true, sent: 0 });
  assert.equal(h.row.warnedLevel, 85);
  assert.equal(h.logged.filter((line) => line.startsWith("error:")).length, 2);
  // The next use does not try again.
  const again = await sendPlanWarning(h.deps, ask({ usedUses: 426 }));
  assert.deepEqual([again.claimed, h.sent.length], [false, 0]);
});

test("one address that fails does not stop the others", async () => {
  const h = harness({ senderThrows: (to) => to.startsWith("owner@") });
  const result = await sendPlanWarning(h.deps, ask());
  assert.deepEqual(result, { level: 85, claimed: true, sent: 1 });
  assert.deepEqual(
    h.sent.map((m) => m.to),
    ["admin@buyer.example"],
  );
});

test("an organization with no owner or admin address sends nothing and does not throw", async () => {
  const h = harness({ addresses: [] });
  assert.deepEqual(await sendPlanWarning(h.deps, ask()), { level: 85, claimed: true, sent: 0 });
  assert.equal(h.sent.length, 0);

  const blank = harness({ addresses: ["", "  "] });
  assert.deepEqual(await sendPlanWarning(blank.deps, ask()), { level: 85, claimed: true, sent: 0 });
});

test("the same address held by two members is written to once", async () => {
  const h = harness({ addresses: ["boss@buyer.example", "boss@buyer.example"] });
  assert.equal((await sendPlanWarning(h.deps, ask())).sent, 1);
});

test("a reader of members that throws, and a claim that throws, are logged and never reach the caller", async () => {
  const noReader = harness({ recipientsThrow: true });
  assert.deepEqual(await sendPlanWarning(noReader.deps, ask()), { level: 85, claimed: true, sent: 0 });
  assert.equal(noReader.logged.length, 1);

  const noClaim = harness({ claimThrows: true });
  assert.deepEqual(await sendPlanWarning(noClaim.deps, ask()), { level: 85, claimed: false, sent: 0 });
  assert.deepEqual([noClaim.sent.length, noClaim.reads(), noClaim.logged.length], [0, 0, 1]);
});

test("a row with no uses is not warned about", async () => {
  const h = harness();
  const result = await sendPlanWarning(h.deps, ask({ includedUses: 0, usedUses: 0 }));
  assert.deepEqual([result.level, h.claims()], [0, 0]);
});

// ---- the words ----

const emailOf = (over: Partial<PlanWarningAsk>, level: 85 | 100): EmailMessage =>
  planWarningEmail("owner@buyer.example", planWarningWords(ask(over), level, WEB, NOW));

const LINK = "https://app.example/dashboard/usage";

test("85% of a plan that renews", () => {
  const email = emailOf({ usedUses: 425 }, 85);
  assert.equal(email.subject, "You have used 85% of your Starter plan");
  assert.equal(email.text, `Support Bot\n425 of 500 uses used. 75 left until 12 Nov.\n\n${LINK}`);
  assert.ok(email.html.includes("Support Bot<br>425 of 500 uses used. 75 left until 12 Nov."));
  assert.ok(email.html.includes(`href="${LINK}"`));
  assert.ok(email.html.includes("See your usage"));
});

test("85% of a plan that will not renew says when it ends", () => {
  const email = emailOf({ usedUses: 425, renews: false }, 85);
  assert.equal(email.text, `Support Bot\n425 of 500 uses used. Your plan ends on 12 Nov.\n\n${LINK}`);
});

test("100% of a plan that stops says when it starts again", () => {
  const email = emailOf({ usedUses: 500 }, 100);
  assert.equal(email.subject, "You have used all of your Starter plan");
  assert.equal(email.text, `Support Bot\n500 of 500 uses used.\nIt starts again on 12 Nov.\n\n${LINK}`);
});

test("100% of a plan with a price for an extra use says the price", () => {
  const email = emailOf({ usedUses: 500, extraUsePriceCents: 4n }, 100);
  assert.equal(email.text, `Support Bot\n500 of 500 uses used.\nEach use is now $0.04 from your credits.\n\n${LINK}`);
});

test("100% of a plan that will not renew promises no new count", () => {
  const stops = emailOf({ usedUses: 500, renews: false }, 100);
  assert.equal(stops.text, `Support Bot\n500 of 500 uses used. Your plan ends on 12 Nov.\n\n${LINK}`);
  const extra = emailOf({ usedUses: 500, renews: false, extraUsePriceCents: 125n }, 100);
  assert.equal(
    extra.text,
    `Support Bot\n500 of 500 uses used. Your plan ends on 12 Nov.\nEach use is now $1.25 from your credits.\n\n${LINK}`,
  );
});

test("carried uses are part of the period's uses, and a plan with no name is 'your plan'", () => {
  const email = emailOf({ carriedUses: 100, usedUses: 510, planName: null }, 85);
  assert.equal(email.subject, "You have used 85% of your plan");
  assert.equal(email.text, `Support Bot\n510 of 600 uses used. 90 left until 12 Nov.\n\n${LINK}`);
});

test("a plan of one use reads right, and a period whose end has passed names no day", () => {
  assert.equal(
    emailOf({ includedUses: 1, usedUses: 1 }, 100).text,
    `Support Bot\n1 of 1 use used.\nIt starts again on 12 Nov.\n\n${LINK}`,
  );
  const late = { periodEnd: new Date("2026-10-19T00:00:00Z") };
  assert.equal(emailOf({ ...late, usedUses: 425 }, 85).text, `Support Bot\n425 of 500 uses used. 75 left.\n\n${LINK}`);
  assert.equal(
    emailOf({ ...late, usedUses: 500 }, 100).text,
    `Support Bot\n500 of 500 uses used.\nIt starts again when your plan renews.\n\n${LINK}`,
  );
  assert.equal(emailOf({ ...late, usedUses: 500, renews: false }, 100).text, `Support Bot\n500 of 500 uses used.\n\n${LINK}`);
});

test("a title is escaped in the HTML and left as written in the text", () => {
  const email = emailOf({ agentTitle: "Bots & <Co>", planName: "A&B" }, 85);
  assert.ok(email.text.startsWith("Bots & <Co>\n"));
  assert.ok(email.html.includes("Bots &amp; &lt;Co&gt;<br>"));
  assert.ok(email.html.includes("You have used 85% of your A&amp;B plan"));
  assert.ok(!email.html.includes("<Co>"));
});

test("no email has an em dash, or a word about tokens, a model, the creator or anything unlimited", () => {
  const cases: Array<[Partial<PlanWarningAsk>, 85 | 100]> = [
    [{ usedUses: 425 }, 85],
    [{ usedUses: 425, renews: false }, 85],
    [{ usedUses: 500 }, 100],
    [{ usedUses: 500, extraUsePriceCents: 4n }, 100],
    [{ usedUses: 500, renews: false }, 100],
  ];
  for (const [over, level] of cases) {
    const email = emailOf(over, level);
    // The layout's own markup aside, what was written is the subject and the text.
    const written = `${email.subject}\n${email.text}`;
    assert.ok(!/[\u2014\u2013]/.test(`${written}${email.html}`), written);
    assert.ok(!/token|model|creator|organi[sz]ation|unlimited|org-buyer|sub-1/i.test(written), written);
  }
});
