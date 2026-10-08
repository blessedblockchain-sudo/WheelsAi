/**
 * An agent's slug: the name in its /v1 address, unique inside an
 * organization. Lifted from POST /api/agents so that every way of creating an
 * agent (the route, a template) names it by the same rule.
 *
 * The database is behind `taken`, so this file reads nothing itself.
 */

import { randomBytes } from "node:crypto";

/** Lower case, with every run of other characters as one hyphen. "" when nothing is left. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export interface UniqueAgentSlugArgs {
  /** What the slug is made from: the agent's name, or a slug the caller asked for. */
  from: string;
  /** Whether the organization already has an agent with this slug. */
  taken: (slug: string) => Promise<boolean>;
  /** Six hex characters for a name with nothing to make a slug from. */
  randomSuffix?: () => string;
}

/**
 * The first free slug for a name: `support-bot`, then `support-bot-1`,
 * `support-bot-2`, and so on.
 */
export async function uniqueAgentSlug(args: UniqueAgentSlugArgs): Promise<string> {
  const baseSlug = slugify(args.from);

  // A name with no ASCII letters or digits slugifies to "", which gave the
  // agent an empty (then "-1") slug and so no addressable /v1 path.
  const randomSuffix = args.randomSuffix ?? (() => randomBytes(3).toString("hex"));
  const rootSlug = baseSlug.length > 0 ? baseSlug : `agent-${randomSuffix()}`;

  let slug = rootSlug;
  let counter = 0;
  while (await args.taken(slug)) {
    counter++;
    slug = `${rootSlug}-${counter}`;
  }
  return slug;
}
