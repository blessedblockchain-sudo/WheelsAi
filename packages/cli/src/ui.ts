import chalk from "chalk";
import ora, { type Ora } from "ora";

import { CliError, describeError, type ErrorContext } from "./errors.js";
import { clean } from "./lib/terminal.js";

/** The spinner currently on screen, so a fatal error can close it before printing. */
let activeSpinner: Ora | undefined;

/**
 * ora counts the lines a spinner occupies by dividing by the terminal width, so a TTY that
 * reports zero columns (some containers and CI pseudo-terminals) sends it into an endless
 * loop. There, fall back to plain status lines instead of an animation.
 */
export function spinnerOptions(text: string): { text: string; isEnabled?: boolean } {
  const zeroWidthTty = Boolean(process.stderr.isTTY) && !((process.stderr.columns ?? 0) > 0);
  return zeroWidthTty ? { text, isEnabled: false } : { text };
}

/**
 * Progress output. Spinners and step lines go to stderr, so stdout carries only
 * results (and stays parseable with `--json`). A silent reporter prints nothing.
 */
export class Reporter {
  constructor(private readonly silent = false) {}

  /** Begin a spinner step. Any previous spinner is stopped first. */
  start(text: string): void {
    this.stop();
    if (this.silent) return;
    activeSpinner = ora(spinnerOptions(text)).start();
  }

  update(text: string): void {
    if (activeSpinner) activeSpinner.text = text;
  }

  /** Finish the current step (or print a standalone line) as a success. */
  succeed(text: string): void {
    this.finish("succeed", text, chalk.green("✔"));
  }

  warn(text: string): void {
    this.finish("warn", text, chalk.yellow("⚠"));
  }

  fail(text: string): void {
    this.finish("fail", text, chalk.red("✖"));
  }

  /** A plain line on stderr. */
  info(text: string): void {
    this.stop();
    if (!this.silent) console.error(text);
  }

  stop(): void {
    activeSpinner?.stop();
    activeSpinner = undefined;
  }

  private finish(method: "succeed" | "warn" | "fail", text: string, symbol: string): void {
    if (activeSpinner) {
      activeSpinner[method](text);
      activeSpinner = undefined;
    } else if (!this.silent) {
      console.error(`${symbol} ${text}`);
    }
  }
}

/** Print a fatal error (closing any live spinner first) and set a non-zero exit code. */
export function reportFatal(err: unknown, context: ErrorContext = {}): number {
  const described = describeError(err, context);
  // The text may come from a server (or a wrong host answering for one): no control characters.
  const message = clean(described.message);
  const indented = (text: string) => clean(text).split("\n").map((line) => `  ${line}`).join("\n");
  if (activeSpinner) {
    activeSpinner.fail(chalk.red(message));
    activeSpinner = undefined;
  } else {
    console.error(`${chalk.red("✖")} ${chalk.red(message)}`);
  }
  if (described.detail) console.error(chalk.dim(indented(described.detail)));
  if (described.hint) console.error(chalk.dim(indented(described.hint)));
  return err instanceof CliError ? err.exitCode : 1;
}

/** Fixed-width label/value line for detail views. */
export function field(label: string, value: string | number | null | undefined): string {
  return `  ${chalk.dim(label.padEnd(14))}${value === null || value === undefined || value === "" ? chalk.dim("none") : value}`;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function colorStatus(rawStatus: string): string {
  const status = clean(rawStatus);
  if (status === "running" || status === "published") return chalk.green(status);
  if (status === "failed") return chalk.red(status);
  if (status === "stopped" || status === "archived") return chalk.gray(status);
  return chalk.yellow(status);
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
