import { evaluateArithmetic } from "../../lib/arithmetic.js";
import { z } from "zod";

import type { SkillDefinition } from "./types.js";

const inputSchema = z.object({ expression: z.string().min(1).max(512) });

/**
 * Arithmetic via a PARSER (lib/arithmetic.ts), never `eval` / `new Function`.
 */
export function createCalculatorSkill(): SkillDefinition {
  return {
    key: "calculator",
    version: "1.0.0",
    name: "Calculator",
    description:
      "Evaluate an arithmetic expression (+ - * / % ** and parentheses) and return the exact result.",
    inputSchema: {
      type: "object",
      properties: {
        expression: { type: "string", description: "Mathematical expression to evaluate" },
      },
      required: ["expression"],
    },
    moneyMoving: false,
    async execute(input) {
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) {
        return { status: "error", message: "expression must be a non-empty string" };
      }
      try {
        return { status: "ok", output: String(evaluateArithmetic(parsed.data.expression)) };
      } catch (err) {
        return {
          status: "error",
          message: err instanceof Error ? err.message : "could not evaluate expression",
        };
      }
    },
  };
}
