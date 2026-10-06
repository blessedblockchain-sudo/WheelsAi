/**
 * Workflow input/output schema checks.
 *
 * A workflow may declare an `inputSchema` and an `outputSchema`. They were
 * stored and never read; a schema nobody enforces tells the author their
 * data is checked when it is not. This module enforces them, and it is
 * strict about its own limits: it implements a named subset of JSON
 * Schema, and `findUnsupportedSchemaKeyword` refuses at save time any
 * schema that uses a keyword outside that subset, so a rule is either
 * enforced or rejected, never silently ignored.
 *
 * Supported: type (string, number, integer, boolean, object, array, null,
 * or a list of those), enum, const, properties, required,
 * additionalProperties (boolean or schema), items (one schema), minItems,
 * maxItems, minLength, maxLength, minimum, maximum. Annotations (title,
 * description, default, examples, $schema, $id) are accepted and ignored.
 *
 * Pure: no IO, and nothing from a schema is ever evaluated as code or
 * compiled into a regular expression.
 */

const ANNOTATIONS = new Set(["title", "description", "default", "examples", "$schema", "$id"]);
const KEYWORDS = new Set([
  "type",
  "enum",
  "const",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
]);
const TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);

const MAX_ERRORS = 20;
const MAX_DEPTH = 32;

type SchemaObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is SchemaObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True for `{}`, null and undefined: a schema that constrains nothing. */
export function isEmptySchema(schema: unknown): boolean {
  return schema === null || schema === undefined || (isPlainObject(schema) && Object.keys(schema).length === 0);
}

/**
 * Returns a message naming the first thing in `schema` this checker
 * cannot enforce, or null when the whole schema is enforceable.
 */
export function findUnsupportedSchemaKeyword(schema: unknown, path = "schema", depth = 0): string | null {
  if (!isPlainObject(schema)) return `${path} must be an object`;
  if (depth > MAX_DEPTH) return `${path} is nested too deeply`;

  for (const [key, value] of Object.entries(schema)) {
    if (ANNOTATIONS.has(key)) continue;
    if (!KEYWORDS.has(key)) {
      return `${path} uses "${key}", which is not supported (supported: ${[...KEYWORDS].join(", ")})`;
    }
    if (key === "type") {
      const types = Array.isArray(value) ? value : [value];
      if (types.length === 0 || types.some((t) => typeof t !== "string" || !TYPES.has(t))) {
        return `${path}.type must be one of ${[...TYPES].join(", ")}`;
      }
    }
    if (key === "enum" && !Array.isArray(value)) return `${path}.enum must be a list`;
    if (key === "required" && (!Array.isArray(value) || value.some((v) => typeof v !== "string"))) {
      return `${path}.required must be a list of property names`;
    }
    if (key === "properties") {
      if (!isPlainObject(value)) return `${path}.properties must be an object`;
      for (const [name, child] of Object.entries(value)) {
        const problem = findUnsupportedSchemaKeyword(child, `${path}.properties.${name}`, depth + 1);
        if (problem) return problem;
      }
    }
    if (key === "items") {
      const problem = findUnsupportedSchemaKeyword(value, `${path}.items`, depth + 1);
      if (problem) return problem;
    }
    if (key === "additionalProperties" && typeof value !== "boolean") {
      const problem = findUnsupportedSchemaKeyword(value, `${path}.additionalProperties`, depth + 1);
      if (problem) return problem;
    }
    if (
      ["minItems", "maxItems", "minLength", "maxLength", "minimum", "maximum"].includes(key) &&
      (typeof value !== "number" || !Number.isFinite(value))
    ) {
      return `${path}.${key} must be a number`;
    }
  }
  return null;
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  const actual = typeOf(value);
  return actual === type || (type === "number" && actual === "integer");
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function check(schema: unknown, value: unknown, path: string, errors: string[], depth: number): void {
  if (errors.length >= MAX_ERRORS || depth > MAX_DEPTH || !isPlainObject(schema)) return;
  const at = path === "" ? "value" : path;

  if (schema.type !== undefined) {
    const types = (Array.isArray(schema.type) ? schema.type : [schema.type]) as string[];
    if (!types.some((t) => matchesType(value, t))) {
      errors.push(`${at} must be ${types.join(" or ")}, got ${typeOf(value)}`);
      return;
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => sameJson(option, value))) {
    errors.push(`${at} must be one of ${JSON.stringify(schema.enum)}`);
  }
  if ("const" in schema && !sameJson(schema.const, value)) {
    errors.push(`${at} must equal ${JSON.stringify(schema.const)}`);
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push(`${at} must be at least ${schema.minLength} characters`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      errors.push(`${at} must be at most ${schema.maxLength} characters`);
    }
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${at} must be at least ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${at} must be at most ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(`${at} must have at least ${schema.minItems} items`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      errors.push(`${at} must have at most ${schema.maxItems} items`);
    }
    if (schema.items !== undefined) {
      value.forEach((item, i) => check(schema.items, item, `${path}[${i}]`, errors, depth + 1));
    }
  }

  if (isPlainObject(value)) {
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    for (const name of Array.isArray(schema.required) ? (schema.required as string[]) : []) {
      if (!Object.prototype.hasOwnProperty.call(value, name)) {
        errors.push(`${path === "" ? name : `${path}.${name}`} is required`);
      }
    }
    for (const [name, child] of Object.entries(value)) {
      const childPath = path === "" ? name : `${path}.${name}`;
      if (Object.prototype.hasOwnProperty.call(properties, name)) {
        check(properties[name], child, childPath, errors, depth + 1);
      } else if (schema.additionalProperties === false) {
        errors.push(`${childPath} is not allowed`);
      } else if (isPlainObject(schema.additionalProperties)) {
        check(schema.additionalProperties, child, childPath, errors, depth + 1);
      }
    }
  }
}

/**
 * Checks `value` against `schema`. Returns the list of problems, empty
 * when the value conforms (an empty schema accepts anything).
 */
export function checkAgainstSchema(schema: unknown, value: unknown): string[] {
  if (isEmptySchema(schema)) return [];
  const errors: string[] = [];
  check(schema, value, "", errors, 0);
  return errors;
}
