/**
 * The order of a form's questions, kept beside its JSON Schema.
 *
 * A form is a JSON Schema whose top-level `properties` are its questions.
 * The schema checker refuses any ordering keyword, and the database stores
 * the schema as JSONB, which does not keep the order of an object's keys.
 * So the order is read from the schema as it arrives (schemaOrderOf), stored
 * beside it, and put back on every read (withSchemaOrder).
 *
 * Pure: no database, no imports.
 *
 * One limit comes from JavaScript itself: an object always lists keys that
 * are whole numbers ("0", "7", "12") first, in number order, whatever order
 * they were written in. Such keys cannot be reordered here or anywhere else
 * a schema is held as an object.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The keys of a schema's top-level `properties`, in the order they appear in
 * the object as received. Empty when the schema is missing, is not an
 * object, or has no `properties` object.
 */
export function schemaOrderOf(schema: unknown): string[] {
  if (!isPlainObject(schema)) return [];
  const properties = schema.properties;
  if (!isPlainObject(properties)) return [];
  return Object.keys(properties);
}

/**
 * The same schema with its top-level `properties` rebuilt in `order`.
 *
 * Keys the order does not name are kept after it, in the order they already
 * had. Keys the order names that the schema does not have are ignored, and
 * so is a key named twice after its first place. Anything that is not an
 * object schema with a `properties` object is returned untouched. Only the
 * order of `properties` changes: `required` and every other keyword, and
 * every question's own schema, are the same values in the same places. The
 * schema passed in is never modified.
 */
export function withSchemaOrder<T>(schema: T, order: readonly string[]): T {
  if (!isPlainObject(schema)) return schema;
  const properties = schema.properties;
  if (!isPlainObject(properties)) return schema;

  const seen = new Set<string>();
  const entries: Array<[string, unknown]> = [];
  for (const key of order) {
    if (typeof key !== "string" || seen.has(key)) continue;
    if (!Object.prototype.hasOwnProperty.call(properties, key)) continue;
    seen.add(key);
    entries.push([key, properties[key]]);
  }
  for (const key of Object.keys(properties)) {
    if (seen.has(key)) continue;
    entries.push([key, properties[key]]);
  }

  // Object.fromEntries defines each key as its own data property, so a
  // question keyed "__proto__" stays a question.
  const rebuilt = Object.fromEntries(
    Object.keys(schema).map((keyword): [string, unknown] => [
      keyword,
      keyword === "properties" ? Object.fromEntries(entries) : schema[keyword],
    ]),
  );
  return rebuilt as T;
}
