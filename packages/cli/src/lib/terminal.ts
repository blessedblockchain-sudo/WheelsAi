/**
 * Text from the API (model output, logs, error messages, names) is not ours, so it must not
 * drive the terminal: an escape sequence in it could rewrite earlier lines or, with OSC 52,
 * the clipboard. Drop C0 and C1 control characters, keeping newlines and tabs.
 */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

export function clean(text: string): string;
export function clean(text: string | null | undefined): string | null | undefined;
export function clean(text: string | null | undefined): string | null | undefined {
  return typeof text === "string" ? text.replace(CONTROL, "") : text;
}
