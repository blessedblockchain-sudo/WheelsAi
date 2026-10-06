"use client";

import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { VariableChips } from "./template-field";
import {
  CONDITION_OPS,
  type ConditionDraft,
  type RightType,
  type VariableChip,
} from "./workflow-model";

/**
 * One comparison: a value to test, an operator, and what to compare it
 * with. Not an expression language; the engine only substitutes
 * references and compares, by design.
 */
export function ConditionBuilder({
  idPrefix,
  value,
  onChange,
  variables,
}: {
  idPrefix: string;
  value: ConditionDraft;
  onChange: (value: ConditionDraft) => void;
  variables: VariableChip[];
}) {
  const unary = CONDITION_OPS.find((o) => o.value === value.op)?.unary ?? false;

  return (
    <div className="space-y-2">
      <div>
        <label htmlFor={`${idPrefix}-left`} className="sr-only">
          Value to test
        </label>
        <Input
          id={`${idPrefix}-left`}
          value={value.left}
          onChange={(event) => onChange({ ...value, left: event.target.value })}
          placeholder="$.steps.classify.output.category"
          className="font-mono text-xs"
        />
      </div>
      <VariableChips
        variables={variables}
        label="Test"
        onPick={(chip) => onChange({ ...value, left: chip.reference })}
      />
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label htmlFor={`${idPrefix}-op`} className="sr-only">
            Comparison
          </label>
          <Select
            id={`${idPrefix}-op`}
            value={value.op}
            onChange={(event) => onChange({ ...value, op: event.target.value as ConditionDraft["op"] })}
          >
            {CONDITION_OPS.map((op) => (
              <option key={op.value} value={op.value}>
                {op.label}
              </option>
            ))}
          </Select>
        </div>
        {!unary && (
          <div>
            <label htmlFor={`${idPrefix}-type`} className="sr-only">
              Compare as
            </label>
            <Select
              id={`${idPrefix}-type`}
              value={value.rightType}
              onChange={(event) => onChange({ ...value, rightType: event.target.value as RightType })}
            >
              <option value="text">as text</option>
              <option value="number">as a number</option>
              <option value="boolean">as true / false</option>
            </Select>
          </div>
        )}
      </div>
      {!unary &&
        (value.rightType === "boolean" ? (
          <Select
            aria-label="Compare with"
            value={value.right.trim().toLowerCase() === "true" ? "true" : "false"}
            onChange={(event) => onChange({ ...value, right: event.target.value })}
          >
            <option value="true">true</option>
            <option value="false">false</option>
          </Select>
        ) : (
          <Input
            aria-label="Compare with"
            value={value.right}
            onChange={(event) => onChange({ ...value, right: event.target.value })}
            placeholder={value.rightType === "number" ? "0.8" : "billing"}
            inputMode={value.rightType === "number" ? "decimal" : undefined}
          />
        ))}
      <p className="text-xs text-muted-foreground">
        To read a field such as <code className="font-mono">.category</code>, set the tested step&apos;s output
        format to JSON. Text starting with <code className="font-mono">$.</code> is read as a reference.
      </p>
    </div>
  );
}
