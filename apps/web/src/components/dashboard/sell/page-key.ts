import { webChannelApi, type WidgetKey } from "@/lib/api";

/**
 * The one key that serves an agent's page, or null while the agent has no
 * page yet. "Keep a copy of what people send" is this key's
 * `storeTranscripts`.
 */
export async function readPageKey(agentId: string): Promise<WidgetKey | null> {
  const { keys } = await webChannelApi.listKeys({ agentId });
  return keys.find((key) => key.pageOfAgentId === agentId && !key.revokedAt) ?? null;
}

/**
 * Sets "keep a copy" on the agent's page. `no_page` when the agent has no
 * page yet: it gets one when it goes on sale, and the setting is saved then.
 */
export async function saveKeepCopy(agentId: string, keepCopy: boolean): Promise<"saved" | "unchanged" | "no_page"> {
  const key = await readPageKey(agentId);
  if (!key) return "no_page";
  if (key.storeTranscripts === keepCopy) return "unchanged";
  await webChannelApi.updateKey(key.id, { storeTranscripts: keepCopy });
  return "saved";
}
