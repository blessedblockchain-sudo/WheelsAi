/**
 * An organization's name: the rename, and the sentences the API answers with.
 *
 * The name is what teammates see (the switcher, the invitation email) and
 * what buyers see on everything the organization sells. It is copied to
 * publisher_profiles.display_name and to agent_listings.publisher_name, so a
 * rename writes all three, in one transaction, with an audit row that is
 * also what the limit of changes is counted from.
 *
 * The rule a name must pass is in the package the API and the web share
 * (@wheelsai/shared/organization-name), so the field in the dashboard and
 * this route cannot disagree.
 *
 * Nothing here reads the database itself: the rename runs over a store the
 * caller hands in (routes/organizationNameBindings.ts binds it to Prisma).
 */

import {
  ORGANIZATION_NAME_CHANGES,
  ORGANIZATION_NAME_CHANGE_DAYS,
  ORGANIZATION_NAME_MAX,
  ORGANIZATION_NAME_MIN,
  ORGANIZATION_NAME_SENTENCES,
  checkOrganizationName,
  cleanOrganizationName,
  readsAsThePlatform,
  type OrganizationNameCheck,
  type OrganizationNameRefusal,
} from "@wheelsai/shared/organization-name";

export { checkOrganizationName, cleanOrganizationName, readsAsThePlatform };
export type NameCheck = OrganizationNameCheck;
export type NameRefusalCode = OrganizationNameRefusal;

export const NAME_MIN_LENGTH = ORGANIZATION_NAME_MIN;
export const NAME_MAX_LENGTH = ORGANIZATION_NAME_MAX;
export const NAME_CHANGE_LIMIT = ORGANIZATION_NAME_CHANGES;
export const NAME_CHANGE_WINDOW_DAYS = ORGANIZATION_NAME_CHANGE_DAYS;
const WINDOW_MS = NAME_CHANGE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** What the audit row of a rename is filed under; the limit counts these. */
export const RENAME_AUDIT_ACTION = "rename";
export const RENAME_AUDIT_RESOURCE = "organization";

export const NAME_SENTENCES = {
  markup: ORGANIZATION_NAME_SENTENCES.markup,
  invisible: ORGANIZATION_NAME_SENTENCES.invisible,
  length: ORGANIZATION_NAME_SENTENCES.length,
  empty: ORGANIZATION_NAME_SENTENCES.noLetterOrNumber,
  reserved: ORGANIZATION_NAME_SENTENCES.reserved,
  taken: "Another seller already uses that name. Choose another.",
} as const;

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const two = (n: number) => String(n).padStart(2, "0");

/** "08:30 UTC on 14 November 2026". */
export function formatUtcMoment(date: Date): string {
  return `${two(date.getUTCHours())}:${two(date.getUTCMinutes())} UTC on ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/**
 * The limit, with the moment it lifts. A client that knows the reader's time
 * zone says that moment in it, from `retryAt`.
 */
export function nameChangeLimitSentence(retryAt: Date): string {
  return `An organization's name can be changed ${NAME_CHANGE_LIMIT} times in ${NAME_CHANGE_WINDOW_DAYS} days. It can be changed again after ${formatUtcMoment(retryAt)}.`;
}

export interface RenameAuditEntry {
  orgId: string;
  userId: string;
  from: string;
  to: string;
  ipAddress: string | null;
  userAgent: string | null;
  at: Date;
}

/**
 * What the rename reads and writes. Inside `transaction` every call runs in
 * that one transaction.
 */
export interface OrganizationNameStore {
  /** Plain read, no lock. Null when the organization is gone. */
  findOrganization(orgId: string): Promise<{ id: string; name: string } | null>;
  /** Lock the organization's row until the transaction ends. */
  lockOrganization(orgId: string): Promise<{ id: string; name: string } | null>;
  /** Whether the organization has a publisher profile. */
  sells(orgId: string): Promise<boolean>;
  /** When the organization's latest renames after `since` happened, newest first, at most `take`. */
  recentRenames(orgId: string, since: Date, take: number): Promise<Date[]>;
  /** Another organization that sells shows this name, ignoring capitals. */
  takenByAnotherSeller(orgId: string, name: string): Promise<boolean>;
  setOrganizationName(orgId: string, name: string): Promise<void>;
  /**
   * Writes the name on the organization's profile and answers whether there
   * is one. Does nothing when there is none. The slug is not touched.
   */
  setSellerName(orgId: string, name: string): Promise<boolean>;
  /** Every listing the organization published, whatever its status. Answers how many. */
  setListingsPublisherName(orgId: string, name: string): Promise<number>;
  recordRename(entry: RenameAuditEntry): Promise<void>;
}

export interface RenameOrganizationDeps {
  transaction<T>(fn: (store: OrganizationNameStore) => Promise<T>): Promise<T>;
  now(): Date;
}

export interface RenameOrganizationInput {
  orgId: string;
  userId: string;
  /** A name that passed checkOrganizationName: the cleaned one. */
  name: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export type RenameOutcome =
  | {
      outcome: "renamed" | "unchanged";
      organization: { id: string; name: string; sells: boolean };
      listingsUpdated: number;
    }
  | { outcome: "limit"; retryAt: Date }
  | { outcome: "taken" }
  | { outcome: "missing" };

/**
 * Rename in one transaction: lock the row, stop when the name is the one it
 * has, then the limit, then the name another seller uses, then the three
 * writes and the audit row.
 */
export function renameOrganization(
  deps: RenameOrganizationDeps,
  input: RenameOrganizationInput,
): Promise<RenameOutcome> {
  const { orgId, name } = input;
  return deps.transaction<RenameOutcome>(async (store) => {
    const organization = await store.lockOrganization(orgId);
    if (!organization) return { outcome: "missing" };

    if (organization.name === name) {
      const sells = await store.sells(orgId);
      return { outcome: "unchanged", organization: { id: organization.id, name, sells }, listingsUpdated: 0 };
    }

    const now = deps.now();
    const recent = await store.recentRenames(orgId, new Date(now.getTime() - WINDOW_MS), NAME_CHANGE_LIMIT);
    if (recent.length >= NAME_CHANGE_LIMIT) {
      // The earliest of the latest three: when it is 30 days old, one change is free again.
      const earliest = Math.min(...recent.map((at) => at.getTime()));
      return { outcome: "limit", retryAt: new Date(earliest + WINDOW_MS) };
    }

    if (await store.takenByAnotherSeller(orgId, name)) return { outcome: "taken" };

    await store.setOrganizationName(orgId, name);
    // Not "read whether it sells, then write": a profile made between the
    // two would keep the old name. The write itself says whether one is there.
    const sells = await store.setSellerName(orgId, name);
    const listingsUpdated = await store.setListingsPublisherName(orgId, name);
    await store.recordRename({
      orgId,
      userId: input.userId,
      from: organization.name,
      to: name,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      at: now,
    });

    return { outcome: "renamed", organization: { id: organization.id, name, sells }, listingsUpdated };
  });
}
