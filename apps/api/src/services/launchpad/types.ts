/**
 * Launchpad adapter seam.
 *
 * The browser-partial-sign launch route (routes/tokenLaunchPartialSign.ts)
 * is launchpad-agnostic: it handles auth, eligibility, the HMAC prepare
 * token, treasury-PDA derivation, and atomic persistence. The only
 * launchpad-specific work — talking to pump.fun (pumpportal) vs. Bags
 * (Meteora DBC + Bags fee-share) — lives behind this interface.
 *
 * Two adapters conform:
 *   - pumpfun: works on devnet + mainnet. The cheap dev-loop default.
 *   - bags:    MAINNET-ONLY (Bags fee-share programs + global LUT are not
 *              deployed on devnet — see memory/bags-ecosystem-eval). Adds
 *              native fee-sharing to arbitrary wallets, which the treasury
 *              loop sweeps via fee_receive.
 *
 * Selection is env-driven (LAUNCHPAD=pumpfun|bags) so both ship in one
 * codebase — this is the adapter, not a fork.
 *
 * Flow contract (both adapters):
 *   prepareLaunch:  build the create tx, sign any *server-held* slots
 *                   (e.g. pump.fun's ephemeral mint), leave the creator
 *                   slot empty for the browser wallet. Return the partial
 *                   tx + an opaque `context` blob the submit step needs.
 *   broadcastLaunch: accept the fully-signed tx + the same `context`,
 *                   validate it references the expected mint/creator, and
 *                   submit to chain.
 *
 * The route never holds adapter-specific state between the two HTTP
 * requests — `context` round-trips inside the tamper-proof HMAC prepare
 * token (see services/launchpadPrepareToken.ts), so a client cannot forge
 * or mutate it.
 */

export type LaunchpadId = "pumpfun" | "bags";

export interface LaunchTokenMetadata {
  name: string;
  symbol: string;
  /**
   * Raw image URL (e.g. the agent's AgentListing.iconUrl). Each adapter
   * resolves its own on-chain metadata URI from this: pump.fun fetches the
   * bytes and uploads image+metadata to IPFS; Bags hands the URL to its SDK
   * (which uploads internally). May be "" only for adapters that tolerate a
   * missing image — pump.fun does not and will reject an empty value.
   */
  imageUrl: string;
  /**
   * Token description. Goes into the off-chain metadata (pump.fun's IPFS
   * JSON; Bags' metadata) and is persisted to the DB.
   */
  description: string;
  twitter?: string;
  telegram?: string;
  website?: string;
}

export interface PrepareLaunchInput {
  /** The user's browser-wallet pubkey — the on-chain creator of record. */
  creatorPubkey: string;
  metadata: LaunchTokenMetadata;
  /** Creator's optional initial buy in SOL. Defaults to 0 (no buy). */
  initialBuySol?: number;
}

/**
 * Opaque, adapter-specific data the submit step needs. Must be
 * JSON-serializable (it is embedded in the HMAC prepare token).
 *   - pumpfun: {} (mint + creator already travel in the token)
 *   - bags:    { configKey } and any bundle/launch handle
 */
export type LaunchContext = Record<string, unknown>;

export interface PrepareLaunchResult {
  /** Base64 VersionedTransaction with server-held slots signed, creator slot empty. */
  partialSignedTxBase64: string;
  mintAddress: string;
  creatorPubkey: string;
  context: LaunchContext;
}

export interface BroadcastLaunchInput {
  /** Base64 fully-signed VersionedTransaction from the client. */
  signedTxBase64: string;
  /** Tampering check — the mint the server prepared this launch for. */
  expectedMintAddress: string;
  /** Tampering check — the creator the server expects to have signed. */
  expectedCreatorPubkey: string;
  /** The same context prepareLaunch returned, verified via the prepare token. */
  context: LaunchContext;
}

export interface BroadcastLaunchResult {
  mintAddress: string;
  txSignature: string;
}

/**
 * A launchpad implementation. Adapters own all network + signing
 * transport for their launchpad; they are constructed by binding
 * factories (see launchpad/index.ts) and injected into the route.
 */
export interface LaunchpadAdapter {
  readonly id: LaunchpadId;
  prepareLaunch(input: PrepareLaunchInput): Promise<PrepareLaunchResult>;
  broadcastLaunch(input: BroadcastLaunchInput): Promise<BroadcastLaunchResult>;
}
