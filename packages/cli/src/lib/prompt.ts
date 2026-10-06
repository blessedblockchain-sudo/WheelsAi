import { createInterface } from "node:readline";
import { Writable } from "node:stream";

import { CliError } from "../errors.js";

export interface PromptOptions {
  /** Do not show what is typed (an API key, a password). */
  hidden?: boolean;
  /** Test seam: the streams to use instead of the terminal. */
  io?: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream };
}

/**
 * Ask one question on the terminal. In a non-interactive shell this fails with
 * `whenNotInteractive` (what to pass instead) rather than hanging on stdin.
 * Ctrl-C or Ctrl-D at the prompt cancels the command (exit code 130).
 */
export async function promptLine(question: string, whenNotInteractive: string, options: PromptOptions = {}): Promise<string> {
  if (!options.io && !process.stdin.isTTY) {
    throw new CliError(whenNotInteractive);
  }
  const input = options.io?.input ?? process.stdin;
  const output = options.io?.output ?? process.stderr;

  // readline echoes every key to its output. For a secret, give it a sink and print the question ourselves.
  const sink = new Writable({ write: (_chunk, _encoding, done) => done() });
  // The interface comes first: creating it puts the terminal in raw mode, and until then the
  // terminal itself would echo anything typed.
  const rl = createInterface({ input, output: options.hidden ? sink : output, terminal: true });
  if (options.hidden) output.write(question);

  return new Promise<string>((resolve, reject) => {
    let answered = false;
    // Without these, closing the prompt leaves the question unanswered forever and Node
    // exits with an "unsettled top-level await" warning instead of a clean cancel.
    rl.on("SIGINT", () => rl.close());
    rl.on("close", () => {
      if (answered) return;
      output.write("\n");
      reject(new CliError("Cancelled.", { exitCode: 130 }));
    });
    rl.question(options.hidden ? "" : question, (answer) => {
      answered = true;
      rl.close();
      if (options.hidden) output.write("\n");
      // A secret is taken as typed: a password may begin or end with a space.
      resolve(options.hidden ? answer : answer.trim());
    });
  });
}

/**
 * Read a secret piped on stdin (`--api-key-stdin`, `--password-stdin`): the first line,
 * without its line ending. Keeps the secret out of the command line, where shell history
 * and the process list would show it.
 */
export async function readSecret(flag: string, input: NodeJS.ReadableStream = process.stdin): Promise<string> {
  let text = "";
  input.setEncoding("utf8");
  for await (const chunk of input) text += chunk;
  const line = (text.split("\n")[0] ?? "").replace(/\r$/, "");
  if (!line) throw new CliError(`${flag} was given, but nothing arrived on stdin.`);
  return line;
}
