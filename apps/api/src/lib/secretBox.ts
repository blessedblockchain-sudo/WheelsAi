/**
 * AES-256-GCM sealing for small JSON secrets stored in Postgres.
 *
 * Format: `<iv hex>:<auth tag hex>:<ciphertext hex>`. This is the exact
 * format services/openclaw.ts has always written for channel configs, so
 * that module delegates here and existing rows stay readable.
 *
 * Key: sha256(ENCRYPTION_KEY), falling back to JWT_SECRET only outside
 * production (env.ts refuses to boot production without a distinct
 * ENCRYPTION_KEY).
 */
import * as crypto from "node:crypto";
import { env } from "../config/env.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;

function key(): Buffer {
  const source = env.ENCRYPTION_KEY ?? env.JWT_SECRET;
  return crypto.createHash("sha256").update(source).digest();
}

export function sealJson(data: unknown): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key(), iv);
  let encrypted = cipher.update(JSON.stringify(data), "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted}`;
}

export function openJson<T = unknown>(sealed: string): T {
  const [ivHex, tagHex, encrypted] = sealed.split(":");
  if (!ivHex || !tagHex || !encrypted) throw new Error("Invalid sealed secret format");
  const decipher = crypto.createDecipheriv(ALGORITHM, key(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return JSON.parse(decrypted) as T;
}
