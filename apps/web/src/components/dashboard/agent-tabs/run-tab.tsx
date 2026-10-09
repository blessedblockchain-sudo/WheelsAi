"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Play } from "lucide-react";
import { taskFieldsOf, taskInputSchema } from "@wheelsai/shared/agent-kind";

import { SchemaForm } from "@/components/marketplace/schema-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CopyTextButton, ResultView } from "@/components/ui/result-view";
import { agentsApi, type AgentDetail, type AgentRunResult } from "@/lib/api";
import { RUN_MESSAGES, runCostLine, runRefusal, runTookLine } from "@/lib/agent-page";
import { buildInput, initialValues, issuesByField, type FormValues } from "@/lib/schema-form";

export interface RunTabProps {
  agent: AgentDetail;
  /** Opens Settings, where the questions are edited. */
  onEditQuestions?: () => void;
}

/**
 * A task agent's front door: its own questions as a form, a Run button, and
 * the one result of the run just made. The answers stay in the form after a
 * run and after a refusal.
 */
export function RunTab({ agent, onEditQuestions }: RunTabProps) {
  const fields = useMemo(() => taskFieldsOf(agent.kindConfig), [agent.kindConfig]);
  const schema = useMemo(() => taskInputSchema(fields), [fields]);

  const [values, setValues] = useState<FormValues>(() => initialValues(schema));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [result, setResult] = useState<AgentRunResult | null>(null);
  const [running, setRunning] = useState(false);
  const resultRef = useRef<HTMLDivElement | null>(null);

  // The questions were edited in Settings: keep the answers whose question is
  // still there and start the new ones empty.
  const schemaKey = useMemo(() => JSON.stringify(schema), [schema]);
  const shownSchema = useRef(schemaKey);
  useEffect(() => {
    if (shownSchema.current === schemaKey) return;
    shownSchema.current = schemaKey;
    setValues((current) => {
      const fresh = initialValues(schema);
      for (const name of Object.keys(fresh)) {
        if (Object.prototype.hasOwnProperty.call(current, name)) fresh[name] = current[name]!;
      }
      return fresh;
    });
    setErrors({});
  }, [schemaKey, schema]);

  async function run() {
    if (running) return;
    const built = buildInput(schema, values);
    if (Object.keys(built.errors).length > 0) {
      setErrors(built.errors);
      setNotice(RUN_MESSAGES.invalid);
      return;
    }
    setErrors({});
    setNotice(null);
    setRunning(true);
    try {
      const answer = await agentsApi.run(agent.id, { input: built.input });
      setResult(answer);
      // After the result is on the page, so a keyboard or screen-reader user lands on it.
      requestAnimationFrame(() => resultRef.current?.focus());
    } catch (error) {
      const refusal = runRefusal(error);
      setErrors(refusal.details.length > 0 ? issuesByField(schema, refusal.details) : {});
      setNotice(refusal.message);
    } finally {
      setRunning(false);
    }
  }

  const took = result ? runTookLine(result.durationMs) : null;
  const cost = result ? runCostLine(result.billing) : null;

  return (
    <div className="grid min-w-0 gap-6 lg:grid-cols-2">
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle className="text-base">Give it a task</CardTitle>
          <CardDescription>Fill in the form and run it. You get one result back.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-5"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void run();
            }}
          >
            <SchemaForm
              schema={schema}
              values={values}
              onChange={setValues}
              errors={errors}
              disabled={running}
              idPrefix="agent-run"
            />

            {notice && (
              <p role="alert" className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
                {notice}
              </p>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3">
              <Button type="submit" disabled={running}>
                {running ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Play className="mr-2 h-4 w-4" aria-hidden="true" />
                )}
                {running ? "Working on it" : result ? "Run again" : "Run"}
              </Button>
              {onEditQuestions && (
                <button
                  type="button"
                  onClick={onEditQuestions}
                  className="rounded text-sm text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Edit the questions
                </button>
              )}
            </div>
          </form>
        </CardContent>
      </Card>

      <Card className="min-w-0">
        <CardHeader>
          <div className="flex min-h-7 items-center justify-between gap-2">
            <CardTitle className="text-base">Result</CardTitle>
            {result && <CopyTextButton text={result.output.text} />}
          </div>
          {result && (took || cost) && (
            <CardDescription>{[took, cost].filter(Boolean).join(" ")}</CardDescription>
          )}
        </CardHeader>
        <CardContent>
          <div
            ref={resultRef}
            tabIndex={-1}
            aria-live="polite"
            aria-busy={running}
            className="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {result ? (
              <ResultView text={result.output.text} />
            ) : (
              <p className="text-sm text-muted-foreground">
                {running ? "Working on it. The result shows here when it is done." : "The result of your run shows here."}
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
