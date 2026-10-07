"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Info, LogIn, MessageSquare, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Turnstile } from "@/components/marketplace/turnstile";
import { useSession } from "@/hooks/use-session";
import { ApiError, tryItApi, type TryItAvailability, type TryItSession } from "@/lib/api";
import { tryItDisabledMessage, tryItNotice, type TryItNotice, type TryItRefusalBody } from "@/lib/try-it";

/** The action the server verifies a Turnstile token against (services/turnstile.ts). */
const TURNSTILE_ACTION = "try_it";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

function noticeOf(error: unknown): TryItNotice {
  if (error instanceof ApiError) {
    const body = typeof error.data === "object" && error.data !== null ? (error.data as TryItRefusalBody) : null;
    return tryItNotice(error.status, body);
  }
  return { message: "The server could not be reached. Check your connection and try again.", action: "none", ended: false };
}

/** The newest turns that fit the server's limits, starting with one of the visitor's. */
function outgoing(messages: ChatMessage[], limits: TryItAvailability["limits"]): ChatMessage[] {
  const picked: ChatMessage[] = [];
  let total = 0;
  for (let i = messages.length - 1; i >= 0 && picked.length < limits.maxMessages; i--) {
    const message = messages[i]!;
    if (total + message.content.length > limits.maxTotalChars) break;
    total += message.content.length;
    picked.unshift(message);
  }
  while (picked.length > 1 && picked[0]!.role !== "user") picked.shift();
  return picked;
}

/**
 * Try it: a free, limited chat with a listing's agent before installing or
 * hiring it.
 *
 * The server decides everything this panel shows: whether the listing can be
 * previewed, who may start (someone signed in, or an anonymous visitor who
 * passed a human check; with no check configured, sign-in only), which model
 * answers, and every limit. Nothing here charges anyone.
 */
export function TryItPanel({ slug, listingId, listingTitle }: { slug: string; listingId: string; listingTitle: string }) {
  const { authed } = useSession();
  const [availability, setAvailability] = useState<TryItAvailability | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [session, setSession] = useState<TryItSession | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [toolNotes, setToolNotes] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<TryItNotice | null>(null);
  const abort = useRef<AbortController | null>(null);
  const logEnd = useRef<HTMLDivElement>(null);
  const signInHref = `/login?next=${encodeURIComponent(`/marketplace/${slug}#try`)}`;

  const load = useCallback(async () => {
    setLoadError(null);
    setAvailability(null);
    try {
      setAvailability(await tryItApi.availability(slug));
    } catch (error) {
      setLoadError(error);
    }
  }, [slug]);

  // The gate depends on who is asking, so it is read once the session probe
  // has answered (and again if that answer changes).
  useEffect(() => {
    if (authed === null) return;
    void load();
  }, [authed, load]);

  useEffect(() => () => abort.current?.abort(), []);

  useEffect(() => {
    logEnd.current?.scrollIntoView({ block: "nearest" });
  }, [messages, streaming]);

  const startSession = useCallback(
    async (turnstileToken?: string): Promise<TryItSession | null> => {
      try {
        const started = await tryItApi.startSession(slug, turnstileToken);
        setSession(started);
        setRemaining(started.messagesRemaining);
        setNotice(null);
        return started;
      } catch (error) {
        setSession(null);
        setNotice(noticeOf(error));
        return null;
      }
    },
    [slug],
  );

  async function send(history: ChatMessage[], opened?: TryItSession) {
    if (!availability) return;
    setBusy(true);
    setNotice(null);
    setToolNotes([]);
    try {
      // A session is opened when it is first needed, and again when the one
      // in hand has run out (it lasts minutes, not the life of the tab).
      let current = opened ?? session;
      if (!current || new Date(current.expiresAt).getTime() <= Date.now()) {
        if (availability.gate !== "session") {
          setSession(null);
          setNotice({ message: "Complete the check to start chatting.", action: "none", ended: false });
          return;
        }
        current = await startSession();
        if (!current) return;
      }

      const controller = new AbortController();
      abort.current = controller;
      let text = "";
      let finished = false;
      setStreaming("");
      for await (const event of tryItApi.streamChat(
        slug,
        { sessionToken: current.sessionToken, messages: outgoing(history, availability.limits) },
        controller.signal,
      )) {
        if (event.type === "delta") {
          text += event.content;
          setStreaming(text);
        } else if (event.type === "toolCalls") {
          const names = event.toolCalls
            .map((call) => (call as { name?: unknown } | null)?.name)
            .filter((name): name is string => typeof name === "string");
          if (names.length > 0) setToolNotes((notes) => [...notes, ...names]);
        } else if (event.type === "error") {
          // A failure inside the stream: the half answer is not kept.
          throw new Error("stream_failed");
        } else if (event.type === "done") {
          finished = true;
        }
      }
      if (!finished || text === "") throw new Error("stream_failed");
      setMessages([...history, { role: "assistant", content: text }]);
      setRemaining((left) => (left === null ? left : Math.max(0, left - 1)));
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (error instanceof ApiError) {
        const said = noticeOf(error);
        if (said.action === "session") setSession(null);
        setNotice(said);
      } else if (error instanceof Error && error.message === "stream_failed") {
        setNotice({
          message: "The agent could not finish its answer, so it is not shown. Send your message again.",
          action: "none",
          ended: false,
        });
      } else {
        setNotice(noticeOf(error));
      }
    } finally {
      setStreaming(null);
      abort.current = null;
      setBusy(false);
    }
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || busy || !availability) return;
    const history: ChatMessage[] = [...messages, { role: "user", content: text }];
    setMessages(history);
    setDraft("");
    void send(history);
  }

  if (authed === null || (availability === null && loadError === null)) {
    return (
      <div className="space-y-4 rounded-lg border bg-card p-6" aria-busy="true">
        <span className="sr-only">Loading the preview</span>
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-4 w-full max-w-md" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  if (loadError !== null || availability === null) {
    return <ErrorState title="Couldn't load the preview" error={loadError} onRetry={() => void load()} />;
  }

  if (!availability.enabled) {
    return (
      <EmptyState
        icon={MessageSquare}
        title="No preview for this agent"
        description={tryItDisabledMessage(availability.disabledReason)}
      />
    );
  }

  const { limits, model, gate } = availability;
  const lastIsUser = messages.length > 0 && messages[messages.length - 1]!.role === "user";
  const outOfMessages = remaining !== null && remaining <= 0;
  const ended = Boolean(notice?.ended) || outOfMessages;
  const needsCheck = gate === "turnstile" && session === null;
  const canType = gate !== "signin" && !needsCheck && !ended;

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-card p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold text-foreground">Try {listingTitle}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              A free preview: {limits.messagesPerSession} messages a session, and you are never charged.
            </p>
          </div>
          {remaining !== null && (
            <span className="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground" data-testid="try-it-remaining">
              {remaining} of {limits.messagesPerSession} messages left
            </span>
          )}
        </div>

        <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
          {model && (
            <li className="flex gap-2">
              <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>
                Answering model: <span className="text-foreground">{model.label}</span>.{model.note ? ` ${model.note}` : ""}
              </span>
            </li>
          )}
          <li className="flex gap-2">
            <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              Tools that move money, save or read files, or send requests out are switched off in previews.
              {availability.disabledTools.length > 0 && (
                <>
                  {" "}
                  For this agent that is: <span className="font-mono text-xs">{availability.disabledTools.join(", ")}</span>.
                </>
              )}
            </span>
          </li>
        </ul>

        {gate === "signin" ? (
          <div className="mt-6 rounded-lg border border-dashed p-6 text-center" data-testid="try-it-signin">
            <p className="text-sm text-foreground">Sign in to try this agent.</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Previews without an account need a human check, and that check is not configured on this server.
            </p>
            <Link
              href={signInHref}
              className="mt-4 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <LogIn className="h-4 w-4" />
              Sign in
            </Link>
          </div>
        ) : (
          <>
            <div
              className="mt-6 max-h-96 min-h-[10rem] space-y-3 overflow-y-auto rounded-lg border bg-background p-4"
              role="log"
              aria-label="Preview conversation"
            >
              {messages.length === 0 && streaming === null && (
                <p className="text-sm text-muted-foreground">Ask the agent something to see how it answers.</p>
              )}
              {messages.map((message, index) => (
                <div key={index} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
                  <p
                    className={`max-w-[85%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm ${
                      message.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"
                    }`}
                  >
                    <span className="sr-only">{message.role === "user" ? "You: " : "Agent: "}</span>
                    {message.content}
                  </p>
                </div>
              ))}
              {toolNotes.length > 0 && (
                <p className="text-center text-xs text-muted-foreground">Used: {toolNotes.join(", ")}</p>
              )}
              {streaming !== null && (
                <div className="flex justify-start">
                  <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-lg bg-muted px-3 py-2 text-sm text-foreground">
                    {streaming === "" ? <span className="italic text-muted-foreground">Thinking...</span> : streaming}
                  </p>
                </div>
              )}
              <div ref={logEnd} />
            </div>

            {needsCheck && availability.turnstileSiteKey && (
              <div className="mt-4">
                <p className="mb-2 text-sm text-muted-foreground">
                  Complete this check to start chatting, or{" "}
                  <Link href={signInHref} className="text-primary underline-offset-4 hover:underline">
                    sign in
                  </Link>{" "}
                  to skip it.
                </p>
                <Turnstile
                  siteKey={availability.turnstileSiteKey}
                  action={TURNSTILE_ACTION}
                  cData={listingId}
                  onToken={(token) =>
                    void startSession(token).then((started) => {
                      // A message typed before the check (or cut off by an
                      // expired session) goes out once the check passes.
                      if (started && lastIsUser && !busy) void send(messages, started);
                    })
                  }
                />
              </div>
            )}

            {notice && (
              <div
                role="alert"
                data-testid="try-it-notice"
                className="mt-4 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-foreground"
              >
                <p>{notice.message}</p>
                <div className="mt-2 flex flex-wrap gap-3">
                  {notice.action === "signin" && (
                    <Link href={signInHref} className="font-medium text-primary underline-offset-4 hover:underline">
                      Sign in
                    </Link>
                  )}
                  {!notice.ended && lastIsUser && !busy && !needsCheck && (
                    <button
                      type="button"
                      className="font-medium text-primary underline-offset-4 hover:underline"
                      onClick={() => void send(messages)}
                    >
                      Send again
                    </button>
                  )}
                </div>
              </div>
            )}
            {outOfMessages && !notice && (
              <p role="status" className="mt-4 rounded-lg border px-4 py-3 text-sm text-muted-foreground">
                You have used every message in this preview. Install or hire the agent to keep going.
              </p>
            )}

            <form onSubmit={submit} className="mt-4 flex items-end gap-2">
              <label htmlFor="try-it-input" className="sr-only">
                Your message
              </label>
              <Textarea
                id="try-it-input"
                rows={2}
                className="min-h-[2.5rem] flex-1 resize-none"
                value={draft}
                maxLength={limits.maxMessageChars}
                disabled={!canType || busy}
                placeholder={needsCheck ? "Complete the check above first" : "Type a message"}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
              />
              <Button type="submit" disabled={!canType || busy || draft.trim() === ""} aria-label="Send message">
                <Send className="h-4 w-4" />
              </Button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
