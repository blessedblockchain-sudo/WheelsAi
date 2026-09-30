/**
 * Agent environment variables (provider API keys, bot tokens, flags) are
 * secrets. They are stored sealed in `Agent.env`:
 *
 *   { "__sealed": "<iv:tag:ciphertext>", "keys": ["OPENAI_API_KEY", ...] }
 *
 * Key names stay readable so the UI can show which variables are set
 * without decrypting; values never leave the API process in plaintext.
 * Because the stored value is ciphertext, any code path that returns a raw
 * agent row returns nothing usable, and version snapshots copy the sealed
 * blob as-is.
 *
 * Rows written before sealing hold a plain `Record<string, string>`;
 * openAgentEnv reads both shapes, and scripts/seal-agent-env.ts converts the
 * old rows in place.
 */
import { openJson, sealJson } from "../lib/secretBox.js";

export type AgentEnv = Record<string, string>;
export type SealedAgentEnv = { __sealed: string; keys: string[] };

export function isSealedAgentEnv(value: unknown): value is SealedAgentEnv {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { __sealed?: unknown }).__sealed === "string"
  );
}

function onlyStrings(record: Record<string, unknown>): AgentEnv {
  const out: AgentEnv = {};
  for (const [k, v] of Object.entries(record)) {
    if (typeof v === "string") out[k] = v;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
  }
  return out;
}

export function sealAgentEnv(plain: AgentEnv): SealedAgentEnv {
  const clean = onlyStrings(plain);
  return { __sealed: sealJson(clean), keys: Object.keys(clean).sort() };
}

/** Plaintext env for the few places that must call a provider. */
export function openAgentEnv(stored: unknown): AgentEnv {
  if (stored === null || stored === undefined) return {};
  if (isSealedAgentEnv(stored)) {
    return onlyStrings(openJson<Record<string, unknown>>(stored.__sealed));
  }
  if (typeof stored === "object" && !Array.isArray(stored)) {
    return onlyStrings(stored as Record<string, unknown>);
  }
  return {};
}

/** Names of the variables that are set; safe to return to clients. */
export function agentEnvKeys(stored: unknown): string[] {
  if (isSealedAgentEnv(stored)) return [...stored.keys];
  return Object.keys(openAgentEnv(stored)).sort();
}

/**
 * Apply a PATCH: a string sets or replaces a variable, null deletes it,
 * and variables not mentioned are kept (clients never see values, so they
 * cannot round-trip them).
 */
export function mergeAgentEnv(
  stored: unknown,
  patch: Record<string, string | null>,
): SealedAgentEnv {
  const next = openAgentEnv(stored);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete next[k];
    else next[k] = v;
  }
  return sealAgentEnv(next);
}

/** Client-facing shape: which variables exist, never their values. */
export function redactAgentEnv(stored: unknown): { keys: string[] } {
  return { keys: agentEnvKeys(stored) };
}
