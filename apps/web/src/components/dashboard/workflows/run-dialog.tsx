"use client";

import { useState } from "react";
import { Play } from "lucide-react";
import { toast } from "sonner";

import { getApiErrorBody, getErrorMessage, orchestrationApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

/**
 * Starts a run. The API answers 202 with a queued run, so this dialog
 * closes as soon as the run exists and hands its id to the caller, which
 * shows the live run view.
 */
export function RunDialog({
  workflow,
  onClose,
  onStarted,
}: {
  workflow: { id: string; name: string };
  onClose: () => void;
  onStarted: (executionId: string) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [inputText, setInputText] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  async function start() {
    let input: Record<string, unknown> | undefined;
    if (inputText.trim() !== "") {
      try {
        const parsed: unknown = JSON.parse(inputText);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          setInputError("The input must be a JSON object, for example { \"topic\": \"pricing\" }");
          return;
        }
        input = parsed as Record<string, unknown>;
      } catch {
        setInputError("The input is not valid JSON");
        return;
      }
    }
    setInputError(null);
    setStarting(true);
    try {
      const { execution } = await orchestrationApi.execute(workflow.id, {
        ...(prompt.trim() !== "" ? { prompt } : {}),
        ...(input ? { input } : {}),
      });
      onStarted(execution.id);
    } catch (error) {
      const body = getApiErrorBody(error)?.body;
      // A schema mismatch says which input field is wrong; show it by the field.
      if (body?.error === "input_schema_mismatch") {
        const details = Array.isArray(body.details) ? body.details.join("; ") : "";
        setInputError(details || getErrorMessage(error, "The input does not match this workflow's input schema"));
      } else {
        toast.error(getErrorMessage(error, "Could not start the run"));
      }
    } finally {
      setStarting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent aria-labelledby="run-dialog-title" aria-describedby="run-dialog-description">
        <DialogHeader>
          <DialogTitle id="run-dialog-title">Run {workflow.name}</DialogTitle>
          <DialogDescription id="run-dialog-description">
            The run is queued and executes in the background. Each agent and model step is billed like any other
            call.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-4 space-y-4">
          <div>
            <label htmlFor="run-prompt" className="mb-1 block text-sm font-medium text-foreground">
              Prompt
            </label>
            <Textarea
              id="run-prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={4}
              maxLength={20_000}
              placeholder="What should this run work on?"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Steps read it as <code className="font-mono">{"{{input.prompt}}"}</code>.
            </p>
          </div>
          <details>
            <summary className="cursor-pointer text-sm font-medium text-foreground">More input (JSON)</summary>
            <div className="mt-2">
              <label htmlFor="run-input" className="sr-only">
                Run input as JSON
              </label>
              <Textarea
                id="run-input"
                value={inputText}
                onChange={(event) => setInputText(event.target.value)}
                rows={5}
                placeholder={'{ "topic": "pricing" }'}
                className="font-mono text-xs"
                aria-invalid={inputError !== null}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Each key is available to steps as <code className="font-mono">{"{{input.<key>}}"}</code>.
              </p>
            </div>
          </details>
          {inputError && (
            <p role="alert" className="text-sm text-danger">
              {inputError}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={starting}>
            Cancel
          </Button>
          <Button onClick={start} isLoading={starting}>
            {!starting && <Play className="mr-2 h-4 w-4" aria-hidden="true" />}
            Start run
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
