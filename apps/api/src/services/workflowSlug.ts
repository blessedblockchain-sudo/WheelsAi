/**
 * A workflow's slug: its address under /v1 (`workflow/<slug>` as `model`,
 * and /v1/workflows/<slug>/chat/completions).
 *
 * Derived from the name by the rule agents use, and unique inside the
 * organization. It is chosen once, on create: renaming a workflow does not
 * move its endpoint. The backfill for existing rows applies the same
 * derivation in SQL (migration 20261008100000).
 *
 * Pure.
 */

export const MAX_WORKFLOW_SLUG_ROOT = 100;

/** "" when the name has no ASCII letter or digit to build a slug from. */
export function workflowSlugRoot(name: string): string {
  const dashed = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return dashed.slice(0, MAX_WORKFLOW_SLUG_ROOT).replace(/-+$/g, "");
}

/** `root`, or the first of root-2, root-3, ... that is not taken. */
export function pickWorkflowSlug(root: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(root)) return root;
  for (let n = 2; ; n++) {
    const candidate = `${root}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** The root for a name that derives none: `workflow-<hex>`. */
export function generatedWorkflowSlugRoot(randomHex: string): string {
  return `workflow-${randomHex}`;
}
