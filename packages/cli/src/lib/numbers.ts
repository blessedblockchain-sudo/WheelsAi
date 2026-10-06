import { CliError } from "../errors.js";

/** Parse a whole number flag. Range checks are left to the API, which owns the limits. */
export function parseWholeNumber(flag: string, value: string, minimum = 1): number {
  if (!/^\d+$/.test(value.trim())) {
    throw new CliError(`${flag} must be a whole number, got "${value}".`);
  }
  const parsed = Number.parseInt(value, 10);
  if (parsed < minimum) {
    throw new CliError(`${flag} must be at least ${minimum}, got ${parsed}.`);
  }
  return parsed;
}
