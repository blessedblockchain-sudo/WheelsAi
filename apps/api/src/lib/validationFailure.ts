/**
 * What a 400 `validation_failed` answer carries. Pure.
 *
 *   error    "validation_failed", as before
 *   message  one plain sentence: the first problem
 *   fields   field name to a plain sentence, one per field
 *   details  zod's flattened errors, as before, for clients that read them
 *
 * A message a route wrote itself (z.string().min(3, "Give your agent a name
 * of at least 3 characters.")) is passed through. Zod's own wording ("String
 * must contain at least 3 character(s)") is replaced with a sentence made
 * from the kind of problem.
 */

import { ZodIssueCode, defaultErrorMap, type ZodError, type ZodIssue } from "zod";

export interface ValidationFailureBody {
  error: "validation_failed";
  message: string;
  fields: Record<string, string>;
  details: { formErrors: string[]; fieldErrors: Record<string, string[] | undefined> };
}

/** The key of a problem with the request as a whole, not one field of it. */
export const WHOLE_REQUEST_FIELD = "body";

const GENERIC_MESSAGE = "Some of what was sent could not be accepted. Check it and try again.";

/** ["tools", 0, "name"] reads "tools[0].name". */
export function fieldPath(path: ReadonlyArray<string | number>): string {
  let out = "";
  for (const part of path) {
    if (typeof part === "number") out += `[${part}]`;
    else out += out ? `.${part}` : part;
  }
  return out;
}

const KIND_OF_VALUE: Record<string, string> = {
  string: "text",
  number: "a number",
  integer: "a whole number",
  boolean: "true or false",
  array: "a list",
  object: "an object",
  date: "a date",
};

const FORMATS: Record<string, string> = {
  email: "a valid email address",
  url: "a valid link",
  uuid: "a valid id",
  datetime: "a valid date and time",
  date: "a valid date",
};

function count(n: number | bigint, one: string, many: string): string {
  return `${n} ${Number(n) === 1 ? one : many}`;
}

function wroteItsOwnMessage(issue: ZodIssue): boolean {
  if (issue.code === ZodIssueCode.custom) return issue.message !== "Invalid input";
  try {
    return defaultErrorMap(issue, { data: undefined, defaultError: "Invalid input" }).message !== issue.message;
  } catch {
    return false;
  }
}

/** One problem as a plain sentence. */
export function plainIssue(issue: ZodIssue): string {
  if (wroteItsOwnMessage(issue)) return issue.message;

  const whole = issue.path.length === 0;
  const name = whole ? "The request" : `"${fieldPath(issue.path)}"`;

  switch (issue.code) {
    case ZodIssueCode.invalid_type: {
      if (whole) return "Send the request as a JSON object.";
      // Only a field that was left out is "required". A null sent for an
      // optional field is the wrong kind of value, and is told so.
      if (issue.received === "undefined") return `${name} is required.`;
      const kind = KIND_OF_VALUE[issue.expected];
      return kind ? `${name} must be ${kind}.` : `${name} has the wrong kind of value.`;
    }
    case ZodIssueCode.too_small: {
      const least = issue.exact ? "exactly" : issue.inclusive ? "at least" : "more than";
      if (issue.type === "string") {
        if (issue.minimum === 1 && issue.inclusive && !issue.exact) return `${name} cannot be empty.`;
        return `${name} must be ${least} ${count(issue.minimum, "character", "characters")}.`;
      }
      if (issue.type === "array" || issue.type === "set") {
        return `${name} needs ${least} ${count(issue.minimum, "item", "items")}.`;
      }
      if (issue.exact) return `${name} must be ${issue.minimum}.`;
      return issue.inclusive ? `${name} must be ${issue.minimum} or more.` : `${name} must be more than ${issue.minimum}.`;
    }
    case ZodIssueCode.too_big: {
      const most = issue.exact ? "exactly" : issue.inclusive ? "at most" : "fewer than";
      if (issue.type === "string") {
        return `${name} must be ${most} ${count(issue.maximum, "character", "characters")}.`;
      }
      if (issue.type === "array" || issue.type === "set") {
        return `${name} can have ${most} ${count(issue.maximum, "item", "items")}.`;
      }
      if (issue.exact) return `${name} must be ${issue.maximum}.`;
      return issue.inclusive ? `${name} must be ${issue.maximum} or less.` : `${name} must be less than ${issue.maximum}.`;
    }
    case ZodIssueCode.invalid_enum_value:
      return `${name} must be one of: ${issue.options.join(", ")}.`;
    case ZodIssueCode.invalid_string: {
      const format = typeof issue.validation === "string" ? FORMATS[issue.validation] : undefined;
      return format ? `${name} must be ${format}.` : `${name} is not in the right format.`;
    }
    case ZodIssueCode.unrecognized_keys:
      return `${issue.keys.map((key) => `"${key}"`).join(", ")} ${issue.keys.length === 1 ? "is" : "are"} not accepted here.`;
    case ZodIssueCode.not_multiple_of:
      return `${name} must be a multiple of ${issue.multipleOf}.`;
    case ZodIssueCode.invalid_date:
      return `${name} must be a valid date.`;
    default:
      return `${name} is not valid.`;
  }
}

/** "kindConfig.task.fields[0].label" is under "kindConfig", as zod's flatten() files it. */
export function topLevelField(field: string): string {
  return field.split(/[.[]/)[0] || field;
}

/**
 * The answer made from field problems a route found itself. The first field
 * gives the message. `details` has the shape of zod's flatten(): sentences
 * filed under the top-level field.
 */
export function validationFailureFromFields(
  fields: Record<string, string>,
  message?: string,
): ValidationFailureBody {
  const fieldErrors: Record<string, string[] | undefined> = {};
  const formErrors: string[] = [];
  for (const [field, sentence] of Object.entries(fields)) {
    if (field === WHOLE_REQUEST_FIELD) formErrors.push(sentence);
    else (fieldErrors[topLevelField(field)] ??= []).push(sentence);
  }
  return {
    error: "validation_failed",
    message: message ?? Object.values(fields)[0] ?? GENERIC_MESSAGE,
    fields,
    details: { formErrors, fieldErrors },
  };
}

/** The answer for a ZodError. `details` is zod's own flatten(), unchanged. */
export function validationFailure(error: ZodError): ValidationFailureBody {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = fieldPath(issue.path) || WHOLE_REQUEST_FIELD;
    if (!(field in fields)) fields[field] = plainIssue(issue);
  }
  return {
    error: "validation_failed",
    message: Object.values(fields)[0] ?? GENERIC_MESSAGE,
    fields,
    details: error.flatten(),
  };
}
