/**
 * Can a container on a GPU node reach this address?
 *
 * A training run and a deployed fine-tuned model are handed addresses to
 * call back: the progress address, the dataset and upload links, the adapter
 * download. A node somewhere on the internet cannot reach this machine's
 * loopback, a private network or a name only a local resolver knows, and a
 * GPU rented to find that out costs credits. This check refuses first.
 *
 * Pure: no network, no DNS, no environment read. So a public-looking name
 * that resolves to a private address passes; that is the accepted limit of a
 * check that must not touch the network. The reserved test names (.test,
 * .example) are deliberately not refused.
 */

import { isIP } from "node:net";

import { classifyIp } from "./ssrfGuard.js";

export type GpuFacingVerdict =
  | { reachable: true }
  | { reachable: false; reason: "invalid" | "scheme" | "credentials" | "local_name" | "private_address" };

/** Names only a local resolver answers, as a suffix of the host. */
const LOCAL_NAME_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa"];

export function classifyGpuFacingUrl(url: string): GpuFacingVerdict {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { reachable: false, reason: "invalid" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { reachable: false, reason: "scheme" };
  }
  if (parsed.username || parsed.password) {
    return { reachable: false, reason: "credentials" };
  }

  // The URL parser has already lowered the case and turned every spelling of
  // an IPv4 address (2130706433, 127.1, 0x7f.1) into its dotted form.
  const bare = parsed.hostname.replace(/^\[|\]$/g, "");
  if (bare === "") return { reachable: false, reason: "invalid" };
  if (isIP(bare) !== 0) {
    return classifyIp(bare) === "public"
      ? { reachable: true }
      : { reachable: false, reason: "private_address" };
  }

  const name = bare.toLowerCase().replace(/\.$/, "");
  // An empty label ("localhost..", "a..b") is no name at all, and would
  // otherwise slip past the tests below as a name with a dot in it.
  if (name.split(".").some((label) => label === "")) return { reachable: false, reason: "invalid" };
  if (
    name === "localhost" ||
    !name.includes(".") ||
    LOCAL_NAME_SUFFIXES.some((suffix) => name.endsWith(suffix) || name === suffix.slice(1))
  ) {
    return { reachable: false, reason: "local_name" };
  }
  return { reachable: true };
}

/**
 * What is wrong with an address a GPU node cannot use, as the end of a
 * sentence an operator reads ("it is ..."). An address with another scheme
 * or a user name in it is not on a private network, and is not called one.
 */
export function gpuFacingRefusal(url: string): string {
  const verdict = classifyGpuFacingUrl(url);
  if (verdict.reachable || verdict.reason === "local_name" || verdict.reason === "private_address") {
    return "this machine or a private network";
  }
  return "not a plain http or https address";
}

/**
 * Scheme, host and port of an address, for a sentence an operator reads.
 * Never a path, a query or a user name: a link is a credential.
 */
export function gpuFacingOrigin(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.host) return `${parsed.protocol}//${parsed.host}`;
  } catch {
    // Falls through: nothing of an address that does not parse is repeated.
  }
  return "the configured address";
}
