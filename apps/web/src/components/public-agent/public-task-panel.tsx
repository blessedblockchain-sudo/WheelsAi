"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Play, Square } from "lucide-react";

import { SchemaForm } from "@/components/marketplace/schema-form";
import { Button } from "@/components/ui/button";
import { CopyTextButton, ResultView } from "@/components/ui/result-view";
import { PUBLIC_USE_MESSAGES, answersTooLong, publicStreamNotice } from "@/lib/public-use";
import { buildInput, initialValues, type FormValues } from "@/lib/schema-form";
import type { PublicTaskTransport } from "./transport";

export interface PublicTaskPanelProps {
  /** The agent's form as a JSON Schema, its questions in the owner's order. */
  inputSchema: unknown;
  /** The most characters the answers may be together. */
  maxInputChars: number;
  transport: PublicTaskTransport;
  /** Public use stopped while the visitor was here: the page shows its paused sentence. */
  onPaused?: () => void;
}

/**
 * The agent's form and the one result it gives back. The answers stay in the
 * form whatever happens to a run, so a refusal never costs the visitor what
 * they typed.
 */
export function PublicTaskPanel({ inputSchema, maxInputChars, transport, onPaused }: PublicTaskPanelProps) {
  const [values, setValues] = useState<FormValues>(() => initialValues(inputSchema));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const resultRef = useRef<HTMLDivElement | null>(null);

  // The form's questions changed under the page (a reload of its data): start from them.
  const schemaKey = useMemo(() => JSON.stringify(inputSchema ?? null), [inputSchema]);
  const firstSchema = useRef(schemaKey);
  useEffect(() => {
    if (firstSchema.current === schemaKey) return;
    firstSchema.current = schemaKey;
    setValues(initialValues(inputSchema));
    setErrors({});
  }, [schemaKey, inputSchema]);

  // A visitor who leaves stops the run, and what it would have cost.
  useEffect(() => () => abortRef.current?.abort(), []);

  async function run() {
    if (running) return;
    const built = buildInput(inputSchema, values);
    if (Object.keys(built.errors).length > 0) {
      setErrors(built.errors);
      setNotice(PUBLIC_USE_MESSAGES.answersInvalid);
      return;
    }
    if (answersTooLong(built.input, maxInputChars)) {
      setErrors({});
      setNotice(PUBLIC_USE_MESSAGES.answersTooLong);
      return;
    }

    setErrors({});
    setNotice(null);
    setResult(null);
    setFinished(false);
    setRunning(true);
    const abort = new AbortController();
    abortRef.current = abort;
    let text = "";

    try {
      for await (const event of transport.send(built.input, abort.signal)) {
        if (event.type === "delta") {
          text += event.content;
          setResult(text);
        } else if (event.type === "error") {
          // Half a result is not a result.
          setResult(null);
          setNotice(publicStreamNotice(event).message);
          return;
        }
      }
      if (text === "") {
        setNotice(publicStreamNotice().message);
        return;
      }
      setFinished(true);
      resultRef.current?.focus();
    } catch (error) {
      if (abort.signal.aborted) {
        setResult(null);
        return;
      }
      const refusal = transport.explain(error);
      if (refusal.paused) {
        onPaused?.();
        return;
      }
      setResult(null);
      setErrors(refusal.fields);
      setNotice(refusal.message);
    } finally {
      if (abortRef.current === abort) abortRef.current = null;
      setRunning(false);
    }
  }

  return (
    <div className="space-y-5 p-4 sm:p-5">
      <form
        className="space-y-5"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <SchemaForm
          schema={inputSchema}
          values={values}
          onChange={(next) => setValues(next)}
          errors={errors}
          disabled={running}
          idPrefix="public-task"
        />

        {notice && (
          <p role="alert" className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
            {notice}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={running}>
            {running ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Play className="mr-2 h-4 w-4" aria-hidden="true" />
            )}
            {running ? "Working on it" : result !== null ? "Run again" : "Run"}
          </Button>
          {running && (
            <Button type="button" variant="outline" onClick={() => abortRef.current?.abort()}>
              <Square className="mr-2 h-4 w-4" aria-hidden="true" />
              Stop
            </Button>
          )}
        </div>
      </form>

      {result !== null && (
        <div
          ref={resultRef}
          tabIndex={-1}
          aria-live="polite"
          aria-busy={running}
          className="rounded-lg border bg-muted/40 p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="mb-2 flex min-h-7 items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-foreground">Result</h2>
            {finished && <CopyTextButton text={result} />}
          </div>
          <ResultView text={result} />
        </div>
      )}
    </div>
  );
}
