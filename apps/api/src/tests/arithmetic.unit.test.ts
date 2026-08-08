import assert from "node:assert/strict";
import test from "node:test";

import { ArithmeticError, evaluateArithmetic } from "../lib/arithmetic.js";

// Drives apps/api/src/lib/arithmetic.ts — the parser that replaced the
// calculator tool's `new Function()`. The point of the replacement is
// that no input can reach a code path that EXECUTES; these pin both the
// arithmetic and that property.

test("basic arithmetic with correct precedence", () => {
  assert.equal(evaluateArithmetic("2 + 3 * 4"), 14);
  assert.equal(evaluateArithmetic("(2 + 3) * 4"), 20);
  assert.equal(evaluateArithmetic("10 / 4"), 2.5);
  assert.equal(evaluateArithmetic("10 % 3"), 1);
  assert.equal(evaluateArithmetic("1.5 + 2.25"), 3.75);
});

test("unary minus and nesting", () => {
  assert.equal(evaluateArithmetic("-5"), -5);
  assert.equal(evaluateArithmetic("-(3 + 2)"), -5);
  assert.equal(evaluateArithmetic("3 - -2"), 5);
  assert.equal(evaluateArithmetic("--4"), 4);
});

test("exponentiation is right-associative, matching JS", () => {
  assert.equal(evaluateArithmetic("2 ** 3"), 8);
  assert.equal(evaluateArithmetic("2 ** 3 ** 2"), 512, "2**(3**2), not (2**3)**2");
  assert.equal(evaluateArithmetic("-2 ** 2"), -4, "unary binds looser than **");
});

test("identifiers are rejected — there is no name to reach a global by", () => {
  for (const expr of [
    "process.exit(1)",
    "require('fs')",
    "globalThis",
    "constructor",
    "this",
    "fetch('http://x')",
  ]) {
    assert.throws(
      () => evaluateArithmetic(expr),
      ArithmeticError,
      `must reject: ${expr}`,
    );
  }
});

test("string and template syntax is rejected", () => {
  for (const expr of ['"a"+"b"', "`${1}`", "'x'"]) {
    assert.throws(() => evaluateArithmetic(expr), ArithmeticError, expr);
  }
});

test("division and modulo by zero are errors, not Infinity or NaN", () => {
  assert.throws(() => evaluateArithmetic("1/0"), /division by zero/);
  assert.throws(() => evaluateArithmetic("1%0"), /modulo by zero/);
});

test("malformed expressions are rejected rather than silently coerced", () => {
  for (const expr of ["", "   ", "1 +", "(1", "1)", "1 2", "1.2.3", "*5"]) {
    assert.throws(
      () => evaluateArithmetic(expr),
      ArithmeticError,
      `must reject: ${JSON.stringify(expr)}`,
    );
  }
});

test("a non-finite result is an error rather than 'Infinity'", () => {
  assert.throws(() => evaluateArithmetic("9 ** 9 ** 9"), /not a finite number/);
});

test("absurdly long input is refused before parsing", () => {
  const long = "1+".repeat(400) + "1";
  assert.throws(() => evaluateArithmetic(long), /too long/);
});

test("whitespace is insignificant", () => {
  assert.equal(evaluateArithmetic("  2   *  ( 3 + 4 ) "), 14);
});
