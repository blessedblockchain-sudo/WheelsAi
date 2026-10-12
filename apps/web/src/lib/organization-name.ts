/**
 * An organization's name in the dashboard: the field's answers and the words
 * about it. Pure.
 *
 * The rule a name must pass is the API's own, from the package the two share,
 * so the field can answer before anything is sent. Whatever the API refuses
 * beyond the rule (a name another seller uses, the limit of changes) is shown
 * in the API's own words.
 */

import {
  ORGANIZATION_NAME_CHANGES,
  ORGANIZATION_NAME_CHANGE_DAYS,
  checkOrganizationName,
  cleanOrganizationName,
} from "@wheelsai/shared/organization-name";

export {
  ORGANIZATION_NAME_MAX,
  ORGANIZATION_NAME_MIN,
  ORGANIZATION_NAME_SENTENCES,
  checkOrganizationName,
  cleanOrganizationName,
  type OrganizationNameCheck,
} from "@wheelsai/shared/organization-name";

/** What the Organization card on the Account page says. */
export const ORGANIZATION_WORDS = {
  title: "Organization",
  label: "Organization name",
  hint: "Teammates see this name. Buyers see it on anything this organization sells.",
  readOnly: "Only an owner or admin can change the name.",
  save: "Save name",
  saving: "Saving...",
  loadFailed: "Couldn't load your organization",
  saveFailed: "The name could not be saved. Try again.",
} as const;

/** Where a link to the card points. */
export const ORGANIZATION_SETTINGS_HREF = "/dashboard/settings#organization";
export const ORGANIZATION_CARD_ID = "organization";

export interface OrganizationNameField {
  /** The cleaned name that would be sent. */
  name: string;
  /** The field holds a name other than the stored one. */
  differs: boolean;
  /** The rule's sentence, once the field was used and the name does not pass. */
  error: string | null;
  /** Save is offered: the name differs from the stored one and passes the rule. */
  canSave: boolean;
}

/** What the field shows for what was typed, against the stored name. */
export function organizationNameField(typed: string, stored: string, used: boolean): OrganizationNameField {
  const check = checkOrganizationName(typed);
  const name = check.ok ? check.name : cleanOrganizationName(typed);
  const differs = name !== stored;
  return {
    name,
    differs,
    error: used && differs && !check.ok ? check.message : null,
    canSave: differs && check.ok,
  };
}

/** The toast after a rename. A seller is told what buyers now see. */
export function organizationRenamedToast(name: string, sells: boolean): string {
  return sells ? `Organization renamed. Buyers now see ${name}.` : "Organization renamed.";
}

/** `retryAt` of a refusal's body, when it has one. */
export function retryAtOf(err: unknown): unknown {
  if (typeof err !== "object" || err === null || !("data" in err)) return undefined;
  const data = (err as { data?: unknown }).data;
  return typeof data === "object" && data !== null ? (data as { retryAt?: unknown }).retryAt : undefined;
}

/**
 * The limit of changes, with the moment it lifts on the reader's own clock.
 * The API's sentence says the same moment in UTC. null when `retryAt` is not
 * a time: the API's sentence is shown then.
 */
export function nameChangeLimitLine(retryAt: unknown, timeZone?: string): string | null {
  if (typeof retryAt !== "string") return null;
  const at = new Date(retryAt);
  if (Number.isNaN(at.getTime())) return null;
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone }).format(at);
  const day = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone }).format(at);
  return `An organization's name can be changed ${ORGANIZATION_NAME_CHANGES} times in ${ORGANIZATION_NAME_CHANGE_DAYS} days. You can change it again after ${time} on ${day}.`;
}

/**
 * The Sell tab's line about the seller's name. The link to change it is for
 * someone who can: an owner or admin.
 */
export function soldByLine(
  name: string,
  canRename: boolean,
): { sentence: string; action: { label: string; href: string } | null } {
  return {
    sentence: `Buyers see this as sold by ${name}.`,
    action: canRename ? { label: "Change the name", href: ORGANIZATION_SETTINGS_HREF } : null,
  };
}

// ============================================
// Telling the rest of the dashboard
// ============================================

/** The window event the Organization card sends after a rename; the sidebar listens for it. */
export const ORGANIZATION_RENAMED_EVENT = "wheelsai:organization-renamed";

export interface OrganizationRenamed {
  id: string;
  name: string;
}

/** The event's detail, when it is what the card sends; else null. */
export function organizationRenamedOf(detail: unknown): OrganizationRenamed | null {
  if (typeof detail !== "object" || detail === null) return null;
  const { id, name } = detail as { id?: unknown; name?: unknown };
  return typeof id === "string" && id && typeof name === "string" && name ? { id, name } : null;
}

/** A list of organizations with one of them renamed. The same list when none has that id or the name is the same. */
export function withOrganizationRenamed<T extends { id: string; name: string }>(
  organizations: T[],
  renamed: OrganizationRenamed,
): T[] {
  if (!organizations.some((org) => org.id === renamed.id && org.name !== renamed.name)) return organizations;
  return organizations.map((org) => (org.id === renamed.id ? { ...org, name: renamed.name } : org));
}
