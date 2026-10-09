"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Loader2, RotateCcw, Send, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ResultView } from "@/components/ui/result-view";
import { chatWindow, publicStreamNotice, type ChatTurn, type PublicChatLimits } from "@/lib/public-use";
import type { PublicChatTransport } from "./transport";

export interface PublicChatPanelProps {
  agentName: string;
  /** The limits the page was given: how long a message and a conversation may be. */
  limits: PublicChatLimits;
  transport: PublicChatTransport;
  /** Public use stopped while the visitor was here: the page shows its paused sentence. */
  onPaused?: () => void;
}

/**
 * A chat with the agent on its public page. It sends the end of the
 * conversation that fits the page's limits, draws each answer as it streams,
 * and says in one sentence why a message was refused.
 */
export function PublicChatPanel({ agentName, limits, transport, onPaused }: PublicChatPanelProps) {
  const inputId = useId();
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  // Counts the chats begun here: a send that belongs to an earlier chat changes nothing in this one.
  const chatRef = useRef(0);

  // A visitor who leaves stops the answer, and what it would have cost.
  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [turns, notice]);

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    const history = turns.filter((turn) => turn.content.length > 0);
    const outgoing = chatWindow([...history, { role: "user", content: text }], limits);

    setNotice(null);
    setDraft("");
    setSending(true);
    setTurns([...history, { role: "user", content: text }, { role: "assistant", content: "" }]);

    const abort = new AbortController();
    abortRef.current = abort;
    const chat = chatRef.current;
    const sameChat = () => chatRef.current === chat;
    let answer = "";
    const showAnswer = () =>
      setTurns((current) => {
        if (!sameChat() || current.length === 0) return current;
        const next = current.slice();
        next[next.length - 1] = { role: "assistant", content: answer };
        return next;
      });
    // The message did not go through: it returns to the box, and the empty answer leaves.
    const takeBack = () => {
      // "Start a new chat" was pressed meanwhile: the old conversation stays gone.
      if (!sameChat()) return;
      setTurns(history);
      setDraft(text);
    };

    try {
      for await (const event of transport.send(outgoing, abort.signal)) {
        if (event.type === "delta") {
          answer += event.content;
          showAnswer();
        } else if (event.type === "error") {
          if (sameChat()) setNotice(publicStreamNotice(event).message);
          if (answer === "") takeBack();
          return;
        }
      }
      if (answer === "" && sameChat()) {
        setNotice(publicStreamNotice().message);
        takeBack();
      }
    } catch (error) {
      if (abort.signal.aborted) {
        // Stopped by the visitor: what arrived stays, an empty answer leaves.
        if (answer === "") takeBack();
        return;
      }
      const refusal = transport.explain(error);
      if (refusal.paused) {
        onPaused?.();
        return;
      }
      setNotice(refusal.message);
      if (answer === "") takeBack();
    } finally {
      if (abortRef.current === abort) abortRef.current = null;
      setSending(false);
    }
  }

  function startOver() {
    chatRef.current += 1;
    abortRef.current?.abort();
    setTurns([]);
    setNotice(null);
  }

  return (
    <div className="flex flex-col">
      <div
        ref={listRef}
        className="max-h-[60vh] min-h-[12rem] space-y-4 overflow-y-auto p-4 sm:p-5"
        aria-live="polite"
        aria-label={`Chat with ${agentName}`}
        role="log"
      >
        {turns.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">Ask {agentName} anything to get started.</p>
        ) : (
          turns.map((turn, index) =>
            turn.role === "user" ? (
              <div key={index} className="flex justify-end">
                <div className="min-w-0 max-w-[85%] whitespace-pre-wrap break-words rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground">
                  <span className="sr-only">You: </span>
                  {turn.content}
                </div>
              </div>
            ) : (
              <div key={index} className="flex justify-start">
                <div className="min-w-0 max-w-[85%] rounded-lg bg-muted px-4 py-2 text-foreground">
                  <span className="sr-only">{agentName}: </span>
                  {turn.content === "" ? (
                    <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                      Thinking
                    </span>
                  ) : (
                    <ResultView text={turn.content} />
                  )}
                </div>
              </div>
            ),
          )
        )}
      </div>

      {notice && (
        <p role="alert" className="mx-4 mb-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger sm:mx-5">
          {notice}
        </p>
      )}

      <form
        className="border-t p-4 sm:p-5"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <label htmlFor={inputId} className="sr-only">
          Your message
        </label>
        <div className="flex items-end gap-2">
          <textarea
            id={inputId}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send();
              }
            }}
            rows={2}
            maxLength={limits.maxMessageChars}
            placeholder="Type your message"
            className="min-w-0 flex-1 resize-none rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          {sending ? (
            <Button type="button" variant="outline" onClick={() => abortRef.current?.abort()}>
              <Square className="h-4 w-4 sm:mr-2" aria-hidden="true" />
              <span className="sr-only sm:not-sr-only">Stop</span>
            </Button>
          ) : (
            <Button type="submit" disabled={draft.trim() === ""}>
              <Send className="h-4 w-4 sm:mr-2" aria-hidden="true" />
              <span className="sr-only sm:not-sr-only">Send</span>
            </Button>
          )}
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>
            {draft.length.toLocaleString("en-US")} of {limits.maxMessageChars.toLocaleString("en-US")} characters
          </span>
          {turns.length > 0 && (
            <button
              type="button"
              onClick={startOver}
              className="inline-flex items-center gap-1 rounded underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <RotateCcw className="h-3 w-3" aria-hidden="true" />
              Start a new chat
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
