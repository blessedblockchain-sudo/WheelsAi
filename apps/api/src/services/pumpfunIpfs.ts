/**
 * pump.fun IPFS metadata upload (plan A1).
 *
 *   buildPumpfunIpfsFields(input)         → pure: structured fields ready
 *                                            for multipart serialization
 *   uploadPumpfunMetadata(input, deps)    → orchestrator: POSTs multipart
 *                                            to pumpportal /api/ipfs and
 *                                            returns the metadataUri
 *
 * pumpportal's /api/ipfs endpoint takes a multipart form (image file +
 * text fields) and returns { metadata, metadataUri }. The metadataUri is
 * what we feed into buildPumpfunCreateRequest's `uri` parameter.
 *
 * Validation throws BEFORE constructing FormData so a caller bug surfaces
 * locally instead of as a confusing pumpportal 400 ten seconds later.
 */

const PUMPFUN_IPFS_ENDPOINT = "https://pump.fun/api/ipfs";

const SUPPORTED_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

// ============================================
// Types
// ============================================

export interface PumpfunIpfsImage {
  bytes: Uint8Array;
  mime: string;
  filename: string;
}

export interface PumpfunIpfsInput {
  name: string;
  symbol: string;
  description: string;
  image: PumpfunIpfsImage;
  twitter?: string;
  telegram?: string;
  website?: string;
}

export interface IpfsUploadFields {
  textFields: Record<string, string>;
  image: PumpfunIpfsImage;
}

export interface UploadDeps {
  fetchFn: typeof fetch;
}

// ============================================
// buildPumpfunIpfsFields
// ============================================

export function buildPumpfunIpfsFields(
  input: PumpfunIpfsInput,
): IpfsUploadFields {
  if (!input.name || input.name.trim().length === 0) {
    throw new Error("buildPumpfunIpfsFields: name is required");
  }
  if (!input.symbol || input.symbol.trim().length === 0) {
    throw new Error("buildPumpfunIpfsFields: symbol is required");
  }
  if (!input.description || input.description.trim().length === 0) {
    throw new Error("buildPumpfunIpfsFields: description is required");
  }
  if (!input.image || input.image.bytes.length === 0) {
    throw new Error("buildPumpfunIpfsFields: image bytes are required (pumpfun requires an image)");
  }
  if (!SUPPORTED_IMAGE_MIMES.has(input.image.mime)) {
    throw new Error(
      `buildPumpfunIpfsFields: unsupported image mime '${input.image.mime}' (need one of ${[
        ...SUPPORTED_IMAGE_MIMES,
      ].join(", ")})`,
    );
  }

  const textFields: Record<string, string> = {
    name: input.name,
    symbol: input.symbol,
    description: input.description,
    showName: "true",
  };
  if (input.twitter) textFields.twitter = input.twitter;
  if (input.telegram) textFields.telegram = input.telegram;
  if (input.website) textFields.website = input.website;

  return { textFields, image: input.image };
}

// ============================================
// uploadPumpfunMetadata
// ============================================

function toFormData(fields: IpfsUploadFields): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields.textFields)) fd.append(k, v);
  // Use a Blob to ensure the right Content-Type on the file part.
  const blob = new Blob([fields.image.bytes], { type: fields.image.mime });
  fd.append("file", blob, fields.image.filename);
  return fd;
}

export async function uploadPumpfunMetadata(
  input: PumpfunIpfsInput,
  deps: UploadDeps,
): Promise<string> {
  const fields = buildPumpfunIpfsFields(input);
  const body = toFormData(fields);

  const res = await deps.fetchFn(PUMPFUN_IPFS_ENDPOINT, {
    method: "POST",
    body,
  });

  if (!res.ok) {
    const snippet = await res.text().catch(() => "");
    throw new Error(
      `pumpfun_ipfs: upload returned ${res.status} (${snippet.slice(0, 200)})`,
    );
  }

  const json = (await res.json().catch(() => null)) as
    | { metadataUri?: string }
    | null;
  if (!json || typeof json.metadataUri !== "string" || json.metadataUri.length === 0) {
    throw new Error("pumpfun_ipfs: response missing metadataUri");
  }
  return json.metadataUri;
}
