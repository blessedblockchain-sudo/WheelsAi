/**
 * The two ways a launch stops that the browser must be able to tell apart
 * from "something went wrong".
 *
 * LaunchRefusal: the launch was turned down at prepare for a reason the
 * creator can fix (another curve, a shorter name, a picture). It carries a
 * code the screens map to a sentence and the status the route answers
 * with. Nothing was uploaded to the chain and nothing was signed.
 *
 * LaunchNotConfirmed: the signed launch WAS sent and its confirmation was
 * not seen. It carries the transaction's signature, so the launch can
 * still be found and saved (POST /launch/reconcile) if it landed.
 *
 * Any adapter may throw them; routes/tokenLaunchPartialSign.ts maps them.
 * Every other error stays what it was: a 502 with the adapter's sentence.
 */

export type LaunchRefusalCode =
  | "invalid_preset"
  | "first_buy_not_supported"
  | "picture_required"
  | "name_too_long"
  | "symbol_too_long"
  | "metadata_link_too_long"
  | "picture_link_refused"
  | "picture_upload_failed";

/**
 * 400 for what the creator typed or picked. The one 502 is the picture's
 * upload: the creator did nothing wrong and may simply try again.
 */
const REFUSAL_STATUS: Record<LaunchRefusalCode, 400 | 502> = {
  invalid_preset: 400,
  first_buy_not_supported: 400,
  picture_required: 400,
  name_too_long: 400,
  symbol_too_long: 400,
  metadata_link_too_long: 400,
  picture_link_refused: 400,
  picture_upload_failed: 502,
};

export class LaunchRefusal extends Error {
  readonly code: LaunchRefusalCode;
  readonly status: 400 | 502;
  /** `message` is one plain sentence a person can read; the code is not in it. */
  constructor(code: LaunchRefusalCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LaunchRefusal";
    this.code = code;
    this.status = REFUSAL_STATUS[code];
  }
}

export class LaunchNotConfirmed extends Error {
  /** The sent transaction's signature, base58. */
  readonly signature: string;
  constructor(signature: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LaunchNotConfirmed";
    this.signature = signature;
  }
}
