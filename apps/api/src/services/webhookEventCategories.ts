/**
 * Groups outbound webhook event types for GET /api/webhooks/events.
 *
 * The route used to filter the event list once per hard-coded prefix, so an
 * event whose prefix nobody had added (workflow.*, scheduled_task.failed,
 * report.generated) was subscribable but appeared in no category. The
 * category is the part of the name before its first dot, derived here from
 * the list itself: a new event type cannot be left out.
 *
 * Pure.
 */

/** The categories that existed first keep their place; new ones follow. */
const CATEGORY_ORDER = [
  "agent",
  "deployment",
  "training",
  "alert",
  "billing",
  "workflow",
  "scheduled_task",
  "report",
];

export function webhookEventCategory(eventType: string): string {
  const dot = eventType.indexOf(".");
  return dot > 0 ? eventType.slice(0, dot) : eventType;
}

export function webhookEventCategories<T extends string>(events: readonly T[]): Record<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const event of events) {
    const category = webhookEventCategory(event);
    grouped.set(category, [...(grouped.get(category) ?? []), event]);
  }
  const rank = (category: string) => {
    const index = CATEGORY_ORDER.indexOf(category);
    return index === -1 ? CATEGORY_ORDER.length : index;
  };
  return Object.fromEntries(
    [...grouped.entries()].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b)),
  );
}
