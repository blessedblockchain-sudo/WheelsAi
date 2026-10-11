"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Play, Square } from "lucide-react";

import { SchemaForm } from "@/components/marketplace/schema-form";
import { Button } from "@/components/ui/button";
import { CopyTextButton, ResultView } from "@/components/ui/result-view";
import { packTaskDraft, unpackTaskDraft } from "@/lib/paid-use";
import { PUBLIC_USE_MESSAGES, answersTooLong, publicStreamNotice } from "@/lib/public-use";
import { buildInput, initialValues, type FormValues } from "@/lib/schema-form";
import { PanelNoticeView } from "./panel-notice";
import type { PanelNotice, PublicTaskTransport } from "./transport";

/** A sentence the panel says by itself, with nothing to press. */
const plain = (message: string): PanelNotice => ({ message, fields: {}, retryAfterSeconds: null, paused: false });

export interface PublicTaskPanelProps {
  /** The agent's form as a JSON Schema, its questions in the owner's order. */
  inputSchema: unknown;
  /** The most characters the answers may be together. */
  maxInputChars: number;
  transport: PublicTaskTransport;
  /** Public use stopped while the visitor was here: the page shows its paused sentence. */
  onPaused?: () => void;
  /** Changes when the visitor's standing with the agent does: a refusal shown here is then out of date and leaves. */
  noticeKey?: string;
  /** The agent cannot answer right now (its page says why): the answers stay, running waits. */
  sendDisabled?: boolean;
  /**
   * Answers kept on this device while the visitor signs in: restored once
   * from sessionStorage under `key`, and written there on every change while
   * `keep` is true. Once restored for someone who is signed in, they are removed.
   */
  draft?: { key: string; keep: boolean };
}

/**
 * The agent's form and the one result it gives back. The answers stay in the
 * form whatever happens to a run, so a refusal never costs the visitor what
 * they typed.
 */
export function PublicTaskPanel({
  inputSchema,
  maxInputChars,
  transport,
  onPaused,
  noticeKey,
  sendDisabled = false,
  draft,
}: PublicTaskPanelProps) {
  const [values, setValues] = useState<FormValues>(() => initialValues(inputSchema));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<PanelNotice | null>(null);
  const [result, setResult] = useState<string | null>(null);
  // What the result cost, after a use that was paid for.
  const [cost, setCost] = useState<string | null>(null);
  // An answer that arrives whole cannot be stopped once the run has gone.
  const whole = transport.waitingLabel !== undefined;
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

  const firstNoticeKey = useRef(noticeKey);
  useEffect(() => {
    if (firstNoticeKey.current === noticeKey) return;
    firstNoticeKey.current = noticeKey;
    setNotice(null);
  }, [noticeKey]);

  // Answers typed before signing in come back once. Storage can be closed to the page: then nothing is kept.
  const draftKey = draft?.key;
  const keepDraft = draft?.keep === true;
  const restored = useRef(false);
  useEffect(() => {
    if (!draftKey || restored.current) return;
    restored.current = true;
    try {
      const kept = unpackTaskDraft(window.sessionStorage.getItem(draftKey), schemaKey, initialValues(inputSchema));
      if (kept) setValues(kept);
      if (!keepDraft) window.sessionStorage.removeItem(draftKey);
    } catch {
      // Nothing to restore.
    }
  }, [draftKey, keepDraft, schemaKey, inputSchema]);

  // The session ended while the form was filled in: the answers are kept from that moment, not from the next keystroke.
  const wasKeeping = useRef(keepDraft);
  useEffect(() => {
    if (wasKeeping.current === keepDraft) return;
    wasKeeping.current = keepDraft;
    if (!draftKey || !keepDraft) return;
    try {
      window.sessionStorage.setItem(draftKey, packTaskDraft(schemaKey, values));
    } catch {
      // The answers stay in the form.
    }
  }, [draftKey, keepDraft, schemaKey, values]);

  function changeValues(next: FormValues) {
    setValues(next);
    if (!draftKey || !keepDraft) return;
    try {
      window.sessionStorage.setItem(draftKey, packTaskDraft(schemaKey, next));
    } catch {
      // The answers stay in the form.
    }
  }

  // A visitor who leaves stops the run, and what it would have cost.
  useEffect(() => () => abortRef.current?.abort(), []);

  async function run() {
    if (running || sendDisabled) return;
    const built = buildInput(inputSchema, values);
    if (Object.keys(built.errors).length > 0) {
      setErrors(built.errors);
      setNotice(plain(PUBLIC_USE_MESSAGES.answersInvalid));
      return;
    }
    if (answersTooLong(built.input, maxInputChars)) {
      setErrors({});
      setNotice(plain(PUBLIC_USE_MESSAGES.answersTooLong));
      return;
    }

    setErrors({});
    setNotice(null);
    setResult(null);
    setCost(null);
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
        } else if (event.type === "charged") {
          setCost(event.line);
        } else if (event.type === "error") {
          // Half a result is not a result.
          setResult(null);
          setNotice(publicStreamNotice(event));
          return;
        }
      }
      if (text === "") {
        setNotice(publicStreamNotice());
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
      setNotice(refusal);
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
          onChange={changeValues}
          errors={errors}
          disabled={running}
          idPrefix="public-task"
        />

        {notice && <PanelNoticeView notice={notice} />}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={running || sendDisabled}>
            {running ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Play className="mr-2 h-4 w-4" aria-hidden="true" />
            )}
            {running ? "Working on it" : result !== null ? "Run again" : "Run"}
          </Button>
          {running && !whole && (
            <Button type="button" variant="outline" onClick={() => abortRef.current?.abort()}>
              <Square className="mr-2 h-4 w-4" aria-hidden="true" />
              Stop
            </Button>
          )}
        </div>
      </form>

      {running && whole && result === null && (
        <p role="status" className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {transport.waitingLabel}
        </p>
      )}

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
          {cost && <p className="mt-3 text-xs text-muted-foreground">{cost}</p>}
        </div>
      )}
    </div>
  );
}
