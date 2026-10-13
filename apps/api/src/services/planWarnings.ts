/**
 * The warning a plan sends by email, at 85% and at 100% of a period's uses.
 *
 * A buyer on a plan reads where they stand in every answer. This is for the
 * people who do not read answers: the owners and admins of the buying
 * organization get ONE email when a use takes the plan to 85% of the
 * period's uses (included plus carried), and ONE when it takes the last.
 *
 *   planWarningWords        what the email says. Pure.
 *   planWarningRecipients   who is told: the verified addresses of owners and admins.
 *   sendPlanWarning         claims the level, reads who is told, sends.
 *
 * The level is claimed on `agent_subscriptions.warned_level` by one
 * compare-and-set: raised only from a lower value, and only on the row still
 * in the period the use was taken in. Of two requests that reach a level at
 * the same moment one changes the row and sends; the other changes nothing
 * and sends nothing. A plan that goes from under 85% straight to 100% claims
 * 100, so the 85% email is never sent after it. A start, a move and a
 * renewal set the level back to 0 and move the period start, so each level
 * can be claimed again in the new period and a claim made for the old one
 * misses.
 *
 * The claim comes before the email and stays when the email fails: a level is
 * told at most once, and a sender that is down costs a warning, never a
 * second email. When email is not set up nothing is claimed, so a level is
 * still there to tell once it is.
 *
 * It is asked after the use is done, outside any transaction, and it never
 * throws: a warning that cannot be claimed or sent is logged and dropped.
 *
 * Pure over what it is given: the sender, the reader of owners and admins and
 * the clock are injected, and this file imports nothing that sends or reads
 * the environment.
 */
import { PLAN_WARNING_PERCENT, warningLevel } from "./planUse.js";

/** The roles of an organization that are told about its plans. */
export const PLAN_WARNING_ROLES = ["owner", "admin"] as const;

/** Where the email's link goes, on the web address the other emails use. */
export const PLAN_WARNING_USAGE_PATH = "/dashboard/usage";

/** One use on a plan, after it was delivered: the count it left and the terms the buyer agreed to. */
export interface PlanWarningAsk {
  /** The buying organization. */
  orgId: string;
  subscriptionId: string;
  /** The period the use was taken in (AgentSubscription.currentPeriodStart). */
  periodStart: Date;
  /** What the creator calls the plan. Null when it is not known. */
  planName: string | null;
  /** The listing's title. */
  agentTitle: string;
  includedUses: number;
  carriedUses: number;
  /** Uses taken in the period, this one among them. */
  usedUses: number;
  /** What each use past the count costs, as agreed. Null = the plan stops until it renews. */
  extraUsePriceCents: bigint | null;
  periodEnd: Date;
  /** Whether the plan will be charged again when the period ends (planWillRenew). */
  renews: boolean;
}

/** What one warning says, before it is laid out as an email. */
export interface PlanWarningWords {
  subject: string;
  /** The body, one line each: the agent's title, the count, then at 100% what happens now. */
  lines: string[];
  link: { label: string; url: string };
}

/** What the claim needs of the database. Prisma's client satisfies it. */
export interface PlanWarningDb {
  agentSubscription: {
    updateMany(args: {
      where: { id: string; currentPeriodStart: Date; warnedLevel: { lt: number } };
      data: { warnedLevel: number };
    }): Promise<{ count: number }>;
  };
}

/** What the reader of who is told needs of the database. Prisma's client satisfies it. */
export interface PlanWarningMembersDb {
  orgMember: {
    findMany(args: {
      where: { orgId: string; role: { in: string[] }; user: { emailVerified: true } };
      select: { user: { select: { email: true; emailVerified: true } } };
    }): Promise<Array<{ user: { email: string | null; emailVerified: boolean } }>>;
  };
}

/**
 * The addresses a plan's warning goes to: the owners and admins of the
 * buying organization whose address is verified, and nobody else's.
 *
 * An address nobody proved is theirs is not written to, as
 * routes/destinations.ts refuses one: anyone can type any address into their
 * settings, and this email carries words a creator wrote (the plan's name,
 * the listing's title). The check is made twice, in the query and on the
 * rows, so a query that loses its filter still writes to no stranger.
 */
export async function planWarningRecipients(db: PlanWarningMembersDb, orgId: string): Promise<string[]> {
  const members = await db.orgMember.findMany({
    where: { orgId, role: { in: [...PLAN_WARNING_ROLES] }, user: { emailVerified: true } },
    select: { user: { select: { email: true, emailVerified: true } } },
  });
  return members
    .filter((member) => member.user.emailVerified === true)
    .map((member) => member.user.email)
    .filter((email): email is string => typeof email === "string" && email.trim().length > 0);
}

export interface PlanWarningDeps {
  /** isEmailConfigured of services/email/emailService.ts. False: nothing is claimed and nothing is sent. */
  emailConfigured(): boolean;
  db: PlanWarningDb;
  /** The verified email addresses of the organization's owners and admins (planWarningRecipients). */
  recipients(orgId: string): Promise<string[]>;
  /** Lays the words out as the other emails are (planWarningEmail of services/email/emailService.ts). */
  buildEmail(to: string, words: PlanWarningWords): { to: string; subject: string; text: string; html: string };
  sendEmail(message: { to: string; subject: string; text: string; html: string }): Promise<void>;
  /** The web address the other emails link to, with no slash at its end. */
  webUrl: string;
  now?: () => Date;
  logger?: {
    warn(obj: unknown, msg: string): void;
    error(obj: unknown, msg: string): void;
  };
}

export interface PlanWarningResult {
  /** The level the count is at. */
  level: 0 | 85 | 100;
  /** Whether this request won the level. */
  claimed: boolean;
  /** How many emails went out. */
  sent: number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const dollars = (cents: bigint) => `$${(Number(cents) / 100).toFixed(2)}`;

/**
 * The words of one warning. The day is written as the API writes it in its
 * used-up sentence ("12 Nov", UTC), and left out when the period's end has
 * passed: the renewal is being retried then, and no day is promised.
 * Uses and cents only.
 */
export function planWarningWords(ask: PlanWarningAsk, level: 85 | 100, webUrl: string, now: Date): PlanWarningWords {
  const limit = ask.includedUses + ask.carriedUses;
  const left = Math.max(0, limit - ask.usedUses);
  const plan = ask.planName ? `your ${ask.planName} plan` : "your plan";
  const day =
    ask.periodEnd.getTime() > now.getTime()
      ? `${ask.periodEnd.getUTCDate()} ${MONTHS[ask.periodEnd.getUTCMonth()]}`
      : null;
  const used = `${Math.min(ask.usedUses, limit)} of ${limit} ${limit === 1 ? "use" : "uses"} used.`;
  // A plan that will not renew has no count that starts again: it is told when it ends.
  const ends = day === null ? null : `Your plan ends on ${day}.`;

  const lines = [ask.agentTitle];
  if (level === 85) {
    if (!ask.renews) lines.push([used, ends].filter(Boolean).join(" "));
    else lines.push(`${used} ${left} left${day === null ? "" : ` until ${day}`}.`);
  } else {
    lines.push(ask.renews ? used : [used, ends].filter(Boolean).join(" "));
    if (ask.extraUsePriceCents !== null && ask.extraUsePriceCents > 0n) {
      lines.push(`Each use is now ${dollars(ask.extraUsePriceCents)} from your credits.`);
    } else if (ask.renews) {
      lines.push(day === null ? "It starts again when your plan renews." : `It starts again on ${day}.`);
    }
  }
  return {
    subject:
      level === 85 ? `You have used ${PLAN_WARNING_PERCENT}% of ${plan}` : `You have used all of ${plan}`,
    lines,
    link: { label: "See your usage", url: `${webUrl}${PLAN_WARNING_USAGE_PATH}` },
  };
}

/**
 * Tell the buyer's owners and admins that a plan reached 85% or 100%, once.
 * Call it after an included use was delivered, with the count that use left.
 * Never throws.
 */
export async function sendPlanWarning(deps: PlanWarningDeps, ask: PlanWarningAsk): Promise<PlanWarningResult> {
  const limit = ask.includedUses + ask.carriedUses;
  // A row with no uses is not a plan with every use gone.
  const level = limit > 0 ? warningLevel(ask.usedUses, ask.includedUses, ask.carriedUses) : 0;
  const none: PlanWarningResult = { level, claimed: false, sent: 0 };
  if (level === 0) return none;
  try {
    // Nothing is claimed for an email nobody can send.
    if (!deps.emailConfigured()) return none;

    const claimed = await deps.db.agentSubscription.updateMany({
      where: { id: ask.subscriptionId, currentPeriodStart: ask.periodStart, warnedLevel: { lt: level } },
      data: { warnedLevel: level },
    });
    if (claimed.count !== 1) return none;
  } catch (err) {
    deps.logger?.warn({ err, subscriptionId: ask.subscriptionId, level }, "a plan's warning could not be claimed; none was sent");
    return none;
  }

  // From here the level is this request's, and it stays claimed whatever happens.
  let sent = 0;
  try {
    const addresses = [...new Set((await deps.recipients(ask.orgId)).map((to) => to.trim()).filter(Boolean))];
    if (addresses.length === 0) {
      deps.logger?.warn({ orgId: ask.orgId, level }, "a plan's warning had nobody to go to: no owner or admin has a verified email address");
    }
    const words = planWarningWords(ask, level, deps.webUrl, deps.now?.() ?? new Date());
    for (const to of addresses) {
      try {
        await deps.sendEmail(deps.buildEmail(to, words));
        sent += 1;
      } catch (err) {
        // One address that fails does not stop the others.
        deps.logger?.error({ err, orgId: ask.orgId, level }, "a plan's warning could not be sent to one address");
      }
    }
  } catch (err) {
    deps.logger?.error({ err, orgId: ask.orgId, level }, "a plan's warning was claimed and could not be sent");
  }
  return { level, claimed: true, sent };
}
