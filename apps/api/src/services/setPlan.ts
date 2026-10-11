/**
 * Putting an organization on a plan by hand (scripts/set-plan.ts).
 *
 * Pure core with injected reads and one write. The organization is named by
 * its id, by its publisher slug, or by the email of one of its owners. A
 * name that matches no organization, or more than one, changes nothing.
 *
 * What is written:
 *   pro | enterprise   plan = that plan, status = "manual" (the status
 *                      services/plans.ts counts as entitled and Stripe never
 *                      sends), so effectivePlan of the row answers the plan.
 *   starter            plan = "starter", status = "none": the grant is
 *                      removed. With no row there is nothing to remove.
 *
 * A row that a Stripe subscription drives (it has a subscription id and its
 * status is one Stripe keeps alive) is refused without `force`: the next
 * webhook would write Stripe's plan and status over it.
 *
 * The write is a compare-and-set on what was read. After it the row is read
 * again and effectivePlan must answer the plan that was set.
 *
 * The organization's marketplace listings carry the plan's priority
 * placement as a stored flag (a Stripe event sets it the same way). It is
 * written in the same transaction as the plan, so the plan and what it
 * gives never disagree.
 */

import { effectivePlan, PLANS, type PlanId } from "./plans.js";

export const SETTABLE_PLANS = ["starter", "pro", "enterprise"] as const;

/** Statuses under which Stripe still holds the subscription and will send events for it. */
export const STRIPE_LIVE_STATUSES = new Set([
  "trialing",
  "active",
  "past_due",
  "unpaid",
  "incomplete",
  "paused",
]);

export interface FoundOrganization {
  id: string;
  name: string;
}

export interface SubscriptionRow {
  plan: string;
  status: string;
  stripeSubscriptionId: string | null;
}

export interface SetPlanDeps {
  /** Null when the text is not an id or no organization has it. */
  findById: (id: string) => Promise<FoundOrganization | null>;
  /** The organization whose publisher profile has this slug. */
  findBySlug: (slug: string) => Promise<FoundOrganization | null>;
  /** Every organization this email owns: its owner, or a member with the role "owner". */
  findByOwnerEmail: (email: string) => Promise<FoundOrganization[]>;
  readSubscription: (orgId: string) => Promise<SubscriptionRow | null>;
  /**
   * Writes plan and status, only if the row is still what `expected` says
   * (null: there is no row, and one is created), and with it the priority
   * placement of the organization's listings. False when the row was not
   * what was read: nothing was written.
   */
  writePlan: (input: {
    orgId: string;
    plan: PlanId;
    status: string;
    expected: SubscriptionRow | null;
  }) => Promise<boolean>;
}

export interface SetPlanInput {
  organization: string;
  plan: string;
  force?: boolean;
  dryRun?: boolean;
}

export interface PlanState {
  /** What the organization gets: effectivePlan of the row. */
  effective: PlanId;
  /** The row as stored, or null when there is none. */
  row: SubscriptionRow | null;
}

export type SetPlanResult =
  | { outcome: "invalid_plan" }
  | { outcome: "not_found" }
  | { outcome: "ambiguous"; matches: FoundOrganization[] }
  | { outcome: "stripe_managed"; organization: FoundOrganization; before: PlanState }
  | { outcome: "unchanged"; organization: FoundOrganization; before: PlanState }
  | {
      outcome: "dry_run";
      organization: FoundOrganization;
      before: PlanState;
      wouldWrite: { plan: PlanId; status: string };
      overStripe: boolean;
    }
  | { outcome: "changed_meanwhile"; organization: FoundOrganization; before: PlanState }
  | {
      outcome: "set";
      organization: FoundOrganization;
      before: PlanState;
      after: PlanState;
      overStripe: boolean;
    }
  | {
      outcome: "did_not_apply";
      organization: FoundOrganization;
      before: PlanState;
      after: PlanState;
    };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSettablePlan(plan: unknown): plan is PlanId {
  return typeof plan === "string" && (SETTABLE_PLANS as readonly string[]).includes(plan);
}

/** Does a Stripe subscription drive this row. */
export function stripeDrives(row: SubscriptionRow | null): boolean {
  return !!row && !!row.stripeSubscriptionId && STRIPE_LIVE_STATUSES.has(row.status);
}

function state(row: SubscriptionRow | null): PlanState {
  return { effective: effectivePlan(row), row };
}

/** Every organization the text names, each once. */
export async function findOrganizations(
  deps: Pick<SetPlanDeps, "findById" | "findBySlug" | "findByOwnerEmail">,
  text: string,
): Promise<FoundOrganization[]> {
  const name = text.trim();
  if (name.length === 0) return [];
  const found = new Map<string, FoundOrganization>();
  const add = (org: FoundOrganization | null) => {
    if (org && !found.has(org.id)) found.set(org.id, org);
  };
  if (UUID.test(name)) add(await deps.findById(name.toLowerCase()));
  if (name.includes("@")) {
    for (const org of await deps.findByOwnerEmail(name)) add(org);
  } else {
    add(await deps.findBySlug(name));
  }
  return [...found.values()];
}

export async function setPlan(deps: SetPlanDeps, input: SetPlanInput): Promise<SetPlanResult> {
  if (!isSettablePlan(input.plan)) return { outcome: "invalid_plan" };
  const plan = input.plan;

  const matches = await findOrganizations(deps, input.organization);
  const organization = matches[0];
  if (!organization) return { outcome: "not_found" };
  if (matches.length > 1) return { outcome: "ambiguous", matches };

  const row = await deps.readSubscription(organization.id);
  const before = state(row);
  const overStripe = stripeDrives(row);
  if (overStripe && !input.force) return { outcome: "stripe_managed", organization, before };

  const status = plan === "starter" ? "none" : "manual";
  const already =
    plan === "starter"
      ? // No row is already Starter with no grant. A row is left alone only
        // when it grants nothing and says so.
        row === null || (row.plan === "starter" && row.status === "none")
      : row !== null && row.plan === plan && row.status === status;
  if (already) return { outcome: "unchanged", organization, before };

  if (input.dryRun) {
    return { outcome: "dry_run", organization, before, wouldWrite: { plan, status }, overStripe };
  }

  const written = await deps.writePlan({ orgId: organization.id, plan, status, expected: row });
  if (!written) return { outcome: "changed_meanwhile", organization, before };

  const after = state(await deps.readSubscription(organization.id));
  if (after.effective !== plan) return { outcome: "did_not_apply", organization, before, after };
  return { outcome: "set", organization, before, after, overStripe };
}

// ============================================
// Plain words
// ============================================

function describe(s: PlanState): string {
  const name = PLANS[s.effective].name;
  if (!s.row) return `${name} (no subscription row)`;
  const stripe = s.row.stripeSubscriptionId ? ", has a Stripe subscription" : "";
  return `${name} (stored plan "${s.row.plan}", status "${s.row.status}"${stripe})`;
}

/** What the script prints, and its exit code: 0 done or nothing to do, 1 refused or failed. */
export function describeSetPlanResult(
  result: SetPlanResult,
  input: SetPlanInput,
): { lines: string[]; exitCode: number } {
  switch (result.outcome) {
    case "invalid_plan":
      return {
        lines: [`"${input.plan}" is not a plan. Use starter, pro or enterprise. Nothing was changed.`],
        exitCode: 1,
      };
    case "not_found":
      return {
        lines: [
          `No organization matches "${input.organization}". Give its id, its publisher slug, or an owner's email. Nothing was changed.`,
        ],
        exitCode: 1,
      };
    case "ambiguous":
      return {
        lines: [
          `"${input.organization}" matches ${result.matches.length} organizations. Nothing was changed. Run again with one id:`,
          ...result.matches.map((m) => `  ${m.id}  ${m.name}`),
        ],
        exitCode: 1,
      };
    case "stripe_managed":
      return {
        lines: [
          `Organization: ${result.organization.name} (${result.organization.id})`,
          `Plan now: ${describe(result.before)}`,
          "A Stripe subscription drives this plan. The next Stripe event would undo a change made here.",
          "Nothing was changed. Change the subscription in Stripe, or run again with --force.",
        ],
        exitCode: 1,
      };
    case "unchanged":
      return {
        lines: [
          `Organization: ${result.organization.name} (${result.organization.id})`,
          `Plan now: ${describe(result.before)}`,
          "That is already the plan asked for. Nothing was changed.",
        ],
        exitCode: 0,
      };
    case "dry_run":
      return {
        lines: [
          `Organization: ${result.organization.name} (${result.organization.id})`,
          `Plan now: ${describe(result.before)}`,
          `Dry run. Would set plan "${result.wouldWrite.plan}" with status "${result.wouldWrite.status}": ${PLANS[result.wouldWrite.plan].name}.`,
          ...(result.overStripe
            ? ["A Stripe subscription drives this plan. Its next event may undo the change."]
            : []),
          "Nothing was changed.",
        ],
        exitCode: 0,
      };
    case "changed_meanwhile":
      return {
        lines: [
          `Organization: ${result.organization.name} (${result.organization.id})`,
          `Plan when read: ${describe(result.before)}`,
          "The subscription changed while this ran. Nothing was changed. Run it again.",
        ],
        exitCode: 1,
      };
    case "did_not_apply":
      return {
        lines: [
          `Organization: ${result.organization.name} (${result.organization.id})`,
          `Plan before: ${describe(result.before)}`,
          `Plan after:  ${describe(result.after)}`,
          `The row was written but the plan in force is not ${PLANS[input.plan as PlanId].name}. Something else changed it. Run it again.`,
        ],
        exitCode: 1,
      };
    case "set":
      return {
        lines: [
          `Organization: ${result.organization.name} (${result.organization.id})`,
          `Plan before: ${describe(result.before)}`,
          `Plan after:  ${describe(result.after)}`,
          ...(result.overStripe
            ? [
                "A Stripe subscription still exists for this organization. Its next event may undo this. Cancel or change it in Stripe.",
              ]
            : []),
          "Done.",
        ],
        exitCode: 0,
      };
  }
}

// ============================================
// Binding to Prisma
// ============================================

type Row = Record<string, any>;

/** What the plan write uses inside its transaction. */
export interface SetPlanTx {
  orgSubscription: {
    updateMany(args: any): Promise<{ count: number }>;
    create(args: any): Promise<Row>;
  };
  agentListing: { updateMany(args: any): Promise<{ count: number }> };
}

/** The slice of Prisma set-plan uses. */
export interface SetPlanPrisma {
  organization: {
    findUnique(args: any): Promise<Row | null>;
    findMany(args: any): Promise<Row[]>;
  };
  publisherProfile: { findUnique(args: any): Promise<Row | null> };
  orgSubscription: { findUnique(args: any): Promise<Row | null> };
  $transaction<T>(run: (tx: SetPlanTx) => Promise<T>): Promise<T>;
}

/** Thrown inside the transaction to roll it back when the row is not what was read. */
class RowChanged extends Error {}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

export function buildSetPlanDeps(db: SetPlanPrisma): SetPlanDeps {
  const org = (row: Row | null): FoundOrganization | null =>
    row ? { id: String(row.id), name: String(row.name) } : null;

  return {
    async findById(id) {
      return org(
        await db.organization.findUnique({ where: { id }, select: { id: true, name: true } }),
      );
    },

    async findBySlug(slug) {
      const profile = await db.publisherProfile.findUnique({
        where: { slug },
        select: { org: { select: { id: true, name: true } } },
      });
      return org(profile?.org ?? null);
    },

    async findByOwnerEmail(email) {
      const wanted = email.trim().toLowerCase();
      const user = { email: { equals: email.trim(), mode: "insensitive" } };
      const rows = await db.organization.findMany({
        where: { OR: [{ owner: user }, { members: { some: { role: "owner", user } } }] },
        select: {
          id: true,
          name: true,
          owner: { select: { email: true } },
          members: { where: { role: "owner" }, select: { user: { select: { email: true } } } },
        },
        orderBy: { createdAt: "asc" },
      });
      // The database's match without case is a pattern match: "_" and "%" in
      // an email stand for other characters there. Only an owner whose email
      // is this one, letter for letter, names the organization.
      const is = (found: unknown) => typeof found === "string" && found.toLowerCase() === wanted;
      return rows
        .filter(
          (r) =>
            is(r.owner?.email) ||
            (Array.isArray(r.members) ? r.members : []).some((m: Row) => is(m?.user?.email)),
        )
        .map((r) => ({ id: String(r.id), name: String(r.name) }));
    },

    async readSubscription(orgId) {
      const row = await db.orgSubscription.findUnique({ where: { orgId } });
      if (!row) return null;
      return {
        plan: String(row.plan),
        status: String(row.status),
        stripeSubscriptionId: row.stripeSubscriptionId ?? null,
      };
    },

    async writePlan({ orgId, plan, status, expected }) {
      // What the plan as written gives, by the same rule everything else reads.
      const priorityPlacement = PLANS[effectivePlan({ plan, status })].priorityPlacement;
      try {
        await db.$transaction(async (tx) => {
          if (expected === null) {
            await tx.orgSubscription.create({ data: { orgId, plan, status } });
          } else {
            const updated = await tx.orgSubscription.updateMany({
              where: {
                orgId,
                plan: expected.plan,
                status: expected.status,
                stripeSubscriptionId: expected.stripeSubscriptionId,
              },
              data: { plan, status },
            });
            if (updated.count !== 1) throw new RowChanged();
          }
          await tx.agentListing.updateMany({
            where: { publisherId: orgId },
            data: { priorityPlacement },
          });
        });
        return true;
      } catch (err) {
        // The row is no longer what was read (or somebody made it first: the
        // unique violation ended the transaction, and is read out here).
        if (err instanceof RowChanged || isUniqueViolation(err)) return false;
        throw err;
      }
    },
  };
}
