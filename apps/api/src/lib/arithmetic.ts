/**
 * A real arithmetic evaluator — replacing the calculator tool's
 * `new Function()`.
 *
 * The previous implementation stripped every character outside a small
 * class (digits, the four arithmetic operators, parentheses, percent,
 * dot, whitespace) and then handed the survivors to `new Function`.
 * That sanitizer is genuinely tight — with no identifiers or quotes there
 * is no way to name `process` or build a string — so this was NOT the
 * same class of hole as the test runner's arbitrary-script assertion,
 * which Wave 1 closed.
 *
 * It is replaced anyway for one reason: it is one regex edit away from
 * being that hole. Somebody adding `_` or `$` or a letter to the allowed
 * set (to support `pi`, say, or `2e10`) reopens remote code execution
 * without touching anything that looks dangerous. A parser cannot degrade
 * that way — the worst a bad edit does here is compute the wrong number.
 *
 * Grammar (recursive descent, standard precedence):
 *   expr   := term (('+' | '-') term)*
 *   term   := unary (('*' | '/' | '%') unary)*
 *   unary  := ('+' | '-') unary | power
 *   power  := primary ('**' unary)?          // right-associative
 *   primary:= number | '(' expr ')'
 */

const MAX_EXPRESSION_LENGTH = 512;

export class ArithmeticError extends Error {}

type Token =
  | { kind: "number"; value: number }
  | { kind: "op"; value: string };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const char = input[i]!;

    if (/\s/.test(char)) {
      i += 1;
      continue;
    }

    if (/[0-9.]/.test(char)) {
      let literal = "";
      while (i < input.length && /[0-9.]/.test(input[i]!)) {
        literal += input[i]!;
        i += 1;
      }
      // "1.2.3" parses as NaN under Number(); reject it explicitly so the
      // caller gets "invalid number" instead of a silent NaN result.
      const value = Number(literal);
      if (!Number.isFinite(value)) {
        throw new ArithmeticError(`invalid number "${literal}"`);
      }
      tokens.push({ kind: "number", value });
      continue;
    }

    if (char === "*" && input[i + 1] === "*") {
      tokens.push({ kind: "op", value: "**" });
      i += 2;
      continue;
    }

    if ("+-*/%()".includes(char)) {
      tokens.push({ kind: "op", value: char });
      i += 1;
      continue;
    }

    throw new ArithmeticError(`unexpected character "${char}"`);
  }

  return tokens;
}

export function evaluateArithmetic(expression: string): number {
  if (expression.length > MAX_EXPRESSION_LENGTH) {
    throw new ArithmeticError(
      `expression too long (max ${MAX_EXPRESSION_LENGTH} characters)`,
    );
  }

  const tokens = tokenize(expression);
  if (tokens.length === 0) {
    throw new ArithmeticError("empty expression");
  }

  let pos = 0;
  const peek = (): Token | undefined => tokens[pos];
  const eat = (value: string): boolean => {
    const token = peek();
    if (token && token.kind === "op" && token.value === value) {
      pos += 1;
      return true;
    }
    return false;
  };

  function parseExpr(): number {
    let left = parseTerm();
    for (;;) {
      if (eat("+")) left += parseTerm();
      else if (eat("-")) left -= parseTerm();
      else return left;
    }
  }

  function parseTerm(): number {
    let left = parseUnary();
    for (;;) {
      if (eat("*")) left *= parseUnary();
      else if (eat("/")) {
        const right = parseUnary();
        if (right === 0) throw new ArithmeticError("division by zero");
        left /= right;
      } else if (eat("%")) {
        const right = parseUnary();
        if (right === 0) throw new ArithmeticError("modulo by zero");
        left %= right;
      } else return left;
    }
  }

  function parseUnary(): number {
    if (eat("-")) return -parseUnary();
    if (eat("+")) return parseUnary();
    return parsePower();
  }

  function parsePower(): number {
    const base = parsePrimary();
    // Right-associative: 2**3**2 === 2**9.
    if (eat("**")) return base ** parseUnary();
    return base;
  }

  function parsePrimary(): number {
    const token = peek();
    if (!token) throw new ArithmeticError("unexpected end of expression");

    if (token.kind === "number") {
      pos += 1;
      return token.value;
    }
    if (eat("(")) {
      const value = parseExpr();
      if (!eat(")")) throw new ArithmeticError("missing closing parenthesis");
      return value;
    }
    throw new ArithmeticError(`unexpected token "${token.value}"`);
  }

  const result = parseExpr();
  if (pos !== tokens.length) {
    const token = tokens[pos]!;
    throw new ArithmeticError(
      `unexpected trailing token "${token.kind === "number" ? token.value : token.value}"`,
    );
  }
  if (!Number.isFinite(result)) {
    throw new ArithmeticError("result is not a finite number");
  }
  return result;
}
