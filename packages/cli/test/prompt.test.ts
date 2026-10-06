import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";

import { CliError } from "../src/errors.js";
import { promptLine, readSecret } from "../src/lib/prompt.js";
import { clean } from "../src/lib/terminal.js";

function terminal() {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = "";
  output.on("data", (chunk) => (written += String(chunk)));
  return { io: { input, output }, input, written: () => written };
}

describe("promptLine", () => {
  it("returns the typed line, trimmed, and shows the question", async () => {
    const term = terminal();
    const answer = promptLine("Two-factor code: ", "n/a", { io: term.io });
    term.input.write(" 123456 \n");
    assert.equal(await answer, "123456");
    assert.match(term.written(), /Two-factor code: /);
  });

  it("does not echo a hidden answer, and takes it exactly as typed", async () => {
    const term = terminal();
    const answer = promptLine("API key: ", "n/a", { hidden: true, io: term.io });
    term.input.write("wheels_live_SECRET \n");
    assert.equal(await answer, "wheels_live_SECRET ");
    assert.equal(term.written(), "API key: \n", "only the question and a line break reach the terminal");
  });

  it("cancels with exit code 130 when the prompt is closed without an answer (Ctrl-C, Ctrl-D)", async () => {
    for (const hidden of [true, false]) {
      const term = terminal();
      const answer = promptLine("Password: ", "n/a", { hidden, io: term.io });
      term.input.end();
      await assert.rejects(answer, (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.message, "Cancelled.");
        assert.equal(err.exitCode, 130);
        return true;
      });
    }
  });

  it("fails with what to pass instead when there is no terminal", async () => {
    const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    try {
      await assert.rejects(promptLine("API key: ", "Pipe the key in with --api-key-stdin.", { hidden: true }), /Pipe the key in with --api-key-stdin\./);
    } finally {
      if (original) Object.defineProperty(process.stdin, "isTTY", original);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
  });
});

describe("readSecret", () => {
  const piped = (text: string) => {
    const input = new PassThrough();
    input.end(text);
    return input;
  };

  it("takes the first line, without its line ending", async () => {
    assert.equal(await readSecret("--api-key-stdin", piped("wheels_live_abc\n")), "wheels_live_abc");
    assert.equal(await readSecret("--api-key-stdin", piped("wheels_live_abc\r\nsecond line\n")), "wheels_live_abc");
    assert.equal(await readSecret("--password-stdin", piped(" pass word ")), " pass word ");
  });

  it("refuses an empty stdin, naming the flag", async () => {
    await assert.rejects(readSecret("--password-stdin", piped("")), /--password-stdin was given, but nothing arrived on stdin/);
    await assert.rejects(readSecret("--password-stdin", piped("\n")), CliError);
  });
});

describe("clean", () => {
  it("removes escape sequences' control characters and keeps newlines, tabs and ordinary text", () => {
    assert.equal(clean("ok\tthen\nnext"), "ok\tthen\nnext");
    assert.equal(clean("a\u001b[1A\u001b[2Kb"), "a[1A[2Kb");
    assert.equal(clean("\u001b]52;c;ZXZpbA==\u0007"), "]52;c;ZXZpbA==");
    assert.equal(clean("x\u009b31my\u0000z\r"), "x31myz");
    assert.equal(clean("héllo ✓ 日本"), "héllo ✓ 日本");
    assert.equal(clean(null), null);
    assert.equal(clean(undefined), undefined);
  });
});
