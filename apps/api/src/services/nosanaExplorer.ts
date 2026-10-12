/**
 * What Nosana itself knows a run by, as an answer shows it: the id of the
 * deployment in Nosana's deployment manager, the address of the run's job (an
 * account on Solana anyone can look up), and Nosana's own page for that job.
 *
 * The page's address is the one Nosana documents: the `Job:` line that
 * `nosana job post` prints (learn.nosana.com, "Quick start"). Only the
 * mainnet form is documented, so a devnet job gets no link.
 */

import {
  NOSANA_BACKEND_URLS,
  getNosanaAccessConfig,
  rowAccessMode,
  type NosanaAccessConfig,
  type NosanaAccessMode,
  type NosanaAccessNetwork,
} from "../config/nosanaAccess.js";
import { isMockNosanaId } from "./nosanaIds.js";

const NOSANA_EXPLORER_JOBS = "https://explore.nosana.com/jobs";

// A Solana address by its form: base58 (no 0, O, I or l), 32 to 44 characters.
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Nosana's page for one job, or null when there is none to show. */
export function nosanaJobUrl(
  address: string | null | undefined,
  network: NosanaAccessNetwork,
): string | null {
  if (typeof address !== "string" || !SOLANA_ADDRESS.test(address)) return null;
  if (network !== "mainnet") return null;
  return `${NOSANA_EXPLORER_JOBS}/${address}`;
}

/**
 * The network a credential's jobs are on, or null when they are not on
 * Nosana at all: NOSANA_API_URL points somewhere other than Nosana's own
 * backend (the development stand-in), whose jobs Nosana's pages do not know.
 */
export type NosanaNetworkReader = (credential: NosanaAccessMode) => NosanaAccessNetwork | null;

/** Production wiring of NosanaNetworkReader, from the Nosana access config. */
export function nosanaNetworkOfCredential(
  credential: NosanaAccessMode,
  config: Pick<NosanaAccessConfig, "apiNetwork" | "walletNetwork" | "apiUrl"> = getNosanaAccessConfig(),
): NosanaAccessNetwork | null {
  const network = credential === "api_key" ? config.apiNetwork : config.walletNetwork;
  if (config.apiUrl && config.apiUrl !== NOSANA_BACKEND_URLS[network]) return null;
  return network;
}

/** A run's record on Nosana. Every member is null for a row that never reached Nosana. */
export interface NosanaRecord {
  deploymentId: string | null;
  jobAddress: string | null;
  jobUrl: string | null;
}

const NO_RECORD: NosanaRecord = { deploymentId: null, jobAddress: null, jobUrl: null };

/**
 * The record of a row that stores a Nosana id, an address and the credential
 * that created them. Nothing at all for a run Nosana has no record of: one
 * the development mock made up an id for, or one whose credential is not on
 * Nosana's own network (the stand-in). A page says "this run is a job on the
 * Nosana network" under this record, so it is never given for those.
 */
export function nosanaRecord(
  row: {
    nosanaJobId?: string | null;
    nosanaJobAddress?: string | null;
    nosanaAccessMode?: string | null;
  },
  networkOf: NosanaNetworkReader,
): NosanaRecord {
  const deploymentId = row.nosanaJobId ?? null;
  const jobAddress = row.nosanaJobAddress ?? null;
  if (deploymentId === null && jobAddress === null) return { ...NO_RECORD };
  if (deploymentId !== null && isMockNosanaId(deploymentId)) return { ...NO_RECORD };
  const network = networkOf(rowAccessMode(row.nosanaAccessMode));
  if (network === null) return { ...NO_RECORD };
  return { deploymentId, jobAddress, jobUrl: nosanaJobUrl(jobAddress, network) };
}
