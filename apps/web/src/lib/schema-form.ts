/**
 * The pure core of the form a buyer fills in to hire an offering.
 *
 * An offering's input is described by the publisher's JSON Schema. This
 * turns the common shapes (strings, numbers, booleans, enums, lists of
 * strings) into form fields and turns what was typed back into the object
 * the API validates. Anything the form cannot draw as a field becomes a
 * JSON box for that property, so no schema makes an offering unhirable.
 *
 * The server's validator is the authority: this only catches what would be
 * refused anyway (a missing required field, a number that is not one) so
 * the buyer hears about it before anything is sent.
 */

export type FieldKind = "string" | "text" | "number" | "integer" | "boolean" | "enum" | "string-array" | "json";

export interface SchemaField {
  name: string;
  kind: FieldKind;
  title: string;
  description?: string;
  required: boolean;
  /** enum only: the allowed values, as the schema lists them. */
  options?: Array<string | number>;
  default?: unknown;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  format?: "uri" | "email";
}

/** What the form holds per field: text for every input, a boolean for a switch. */
export type FormValues = Record<string, string | boolean>;

/** The key under which the whole input is edited as JSON when a schema has no fields. */
export const FREEFORM_FIELD = "$input";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** "max_results" and "maxResults" both read "Max results". */
export function labelFromName(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : name;
}

function kindOf(prop: JsonObject): FieldKind {
  const scalarEnum =
    Array.isArray(prop.enum) &&
    prop.enum.length > 0 &&
    prop.enum.every((option) => typeof option === "string" || typeof option === "number");
  if (scalarEnum) return "enum";
  switch (prop.type) {
    case "string": {
      const max = num(prop.maxLength);
      // A short, bounded string is one line; anything else gets room.
      return prop.format === "uri" || prop.format === "email" || (max !== undefined && max <= 200) ? "string" : "text";
    }
    case "number":
      return "number";
    case "integer":
      return "integer";
    case "boolean":
      return "boolean";
    case "array":
      return isObject(prop.items) && prop.items.type === "string" && !Array.isArray(prop.items.enum)
        ? "string-array"
        : "json";
    default:
      return "json";
  }
}

/**
 * The fields of an object schema, in the order the publisher wrote them.
 * `freeform` is true when there is nothing to draw (no schema, or one with
 * no properties): the input is then edited as one JSON object.
 */
export function fieldsFromSchema(schema: unknown): { fields: SchemaField[]; freeform: boolean } {
  if (!isObject(schema) || !isObject(schema.properties) || Object.keys(schema.properties).length === 0) {
    return { fields: [], freeform: true };
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((r) => typeof r === "string") : []);
  const fields = Object.entries(schema.properties).map(([name, raw]): SchemaField => {
    const prop = isObject(raw) ? raw : {};
    const kind = kindOf(prop);
    return {
      name,
      kind,
      title: typeof prop.title === "string" && prop.title.trim() ? prop.title : labelFromName(name),
      ...(typeof prop.description === "string" && { description: prop.description }),
      required: required.has(name),
      ...(kind === "enum" && { options: prop.enum as Array<string | number> }),
      ...(prop.default !== undefined && { default: prop.default }),
      ...(num(prop.minimum) !== undefined && { min: num(prop.minimum) }),
      ...(num(prop.maximum) !== undefined && { max: num(prop.maximum) }),
      ...(num(prop.minLength) !== undefined && { minLength: num(prop.minLength) }),
      ...(num(prop.maxLength) !== undefined && { maxLength: num(prop.maxLength) }),
      ...((prop.format === "uri" || prop.format === "email") && { format: prop.format }),
    };
  });
  return { fields, freeform: false };
}

function toText(field: SchemaField, value: unknown): string | boolean {
  if (field.kind === "boolean") return value === true;
  if (value === undefined || value === null) return "";
  if (field.kind === "string-array") {
    return Array.isArray(value) ? value.map(String).join("\n") : String(value);
  }
  if (field.kind === "json") return JSON.stringify(value, null, 2);
  return typeof value === "string" ? value : String(value);
}

/**
 * The form's starting state: a sample's values when one is given, else the
 * schema's defaults, else empty.
 */
export function initialValues(schema: unknown, sample?: Record<string, unknown>): FormValues {
  const { fields, freeform } = fieldsFromSchema(schema);
  if (freeform) return { [FREEFORM_FIELD]: sample ? JSON.stringify(sample, null, 2) : "{}" };
  const values: FormValues = {};
  for (const field of fields) {
    const given = sample && Object.prototype.hasOwnProperty.call(sample, field.name) ? sample[field.name] : undefined;
    values[field.name] = toText(field, given !== undefined ? given : field.default);
  }
  return values;
}

export interface BuiltInput {
  input: Record<string, unknown>;
  /** Field name -> problem. Empty when the input can be sent. */
  errors: Record<string, string>;
}

/**
 * What was typed, as the object to send. Empty optional fields are left
 * out rather than sent as "", which a schema with minLength or an enum
 * would refuse.
 */
export function buildInput(schema: unknown, values: FormValues): BuiltInput {
  const { fields, freeform } = fieldsFromSchema(schema);
  const errors: Record<string, string> = {};
  if (freeform) {
    const text = String(values[FREEFORM_FIELD] ?? "").trim();
    if (!text) return { input: {}, errors };
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isObject(parsed)) errors[FREEFORM_FIELD] = "The input must be a JSON object, like {\"key\": \"value\"}";
      return { input: isObject(parsed) ? parsed : {}, errors };
    } catch {
      return { input: {}, errors: { [FREEFORM_FIELD]: "This is not valid JSON" } };
    }
  }

  const input: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = values[field.name];
    if (field.kind === "boolean") {
      // An untouched optional switch is "not said", not "false".
      if (raw === true || field.required || field.default !== undefined) input[field.name] = raw === true;
      continue;
    }
    const text = typeof raw === "string" ? raw : "";
    if (text.trim() === "") {
      if (field.required) errors[field.name] = `${field.title} is required`;
      continue;
    }
    switch (field.kind) {
      case "number":
      case "integer": {
        const value = Number(text);
        if (!Number.isFinite(value) || (field.kind === "integer" && !Number.isInteger(value))) {
          errors[field.name] = field.kind === "integer" ? "Enter a whole number" : "Enter a number";
        } else {
          input[field.name] = value;
        }
        break;
      }
      case "enum": {
        const option = field.options?.find((candidate) => String(candidate) === text);
        if (option === undefined) errors[field.name] = "Choose one of the options";
        else input[field.name] = option;
        break;
      }
      case "string-array":
        input[field.name] = text
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
        break;
      case "json":
        try {
          input[field.name] = JSON.parse(text);
        } catch {
          errors[field.name] = "This is not valid JSON";
        }
        break;
      default:
        input[field.name] = text;
    }
  }
  return { input, errors };
}

/**
 * The server's problems ({ path: "/topic", message }) by field name. A
 * problem with the object itself, or with a field the form does not show,
 * goes under "" for the form to print above the fields.
 */
export function issuesByField(
  schema: unknown,
  issues: Array<{ path: string; message: string }>,
): Record<string, string> {
  const { fields, freeform } = fieldsFromSchema(schema);
  const known = new Set(fields.map((field) => field.name));
  const byField: Record<string, string> = {};
  const add = (key: string, message: string) => {
    byField[key] = byField[key] ? `${byField[key]}; ${message}` : message;
  };
  for (const issue of issues) {
    // JSON pointer: "/a~1b/0" names property "a/b".
    const first = issue.path.split("/")[1]?.replace(/~1/g, "/").replace(/~0/g, "~") ?? "";
    if (freeform) add(FREEFORM_FIELD, first ? `${first}: ${issue.message}` : issue.message);
    else if (first && known.has(first)) add(first, issue.message);
    else {
      // ajv reports a missing property at the parent: "must have required property 'topic'".
      const missing = /required property '([^']+)'/.exec(issue.message)?.[1];
      if (missing && known.has(missing)) add(missing, "This is required");
      else add("", first ? `${first}: ${issue.message}` : issue.message);
    }
  }
  return byField;
}
