"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { billingApi, type DepositAddressResponse, type DepositRecord } from "@/lib/api";
import {
  CHECK_NOW,
  COPY_FAILED,
  PANEL_TITLE,
  PREPARE_ADDRESS,
  SHOW_ADDRESS,
  afterCheck,
  afterDepositError,
  afterIssue,
  afterPrepare,
  creditedSince,
  depositRows,
  hidesAddress,
  lineAfterCopied,
  panelView,
  refreshedAddress,
  withUsdcAccountOpen,
} from "@/lib/deposit-address";
import type { StatusLine } from "@/lib/wallet-topup";
import { cn } from "@/lib/utils";

/** Which button a line answers, so it is drawn right after that button. */
type Where = "address" | "prepare" | "check";
type Line = StatusLine & { where: Where };

function LineBox({ line }: { line: StatusLine }) {
  return (
    <p
      className={cn(
        "break-words rounded-lg border px-4 py-3 text-sm text-foreground",
        line.tone === "success" && "border-green-500/30 bg-green-500/10",
        line.tone === "error" && "border-red-500/30 bg-red-500/10",
        line.tone === "progress" && "border-border bg-muted"
      )}
    >
      {line.message}
    </p>
  );
}

/**
 * The organization's own deposit address, in the "Add Credits" card: paid from an exchange or any
 * wallet, with no browser wallet. Every sentence about the address or a transfer is the API's;
 * lib/deposit-address.ts decides what is shown for each state.
 */
export function DepositAddressPanel({ onCredited }: { onCredited: () => void }) {
  const [answer, setAnswer] = useState<DepositAddressResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [busy, setBusy] = useState<"issue" | "prepare" | "check" | null>(null);
  const [line, setLine] = useState<Line | null>(null);
  const [deposits, setDeposits] = useState<DepositRecord[]>([]);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  // The list as it was last read; null until it has been read once.
  const listed = useRef<DepositRecord[] | null>(null);
  // The page's reload, kept current without making the first read depend on it.
  const reloadBalance = useRef(onCredited);
  useEffect(() => {
    reloadBalance.current = onCredited;
  }, [onCredited]);

  /**
   * Reads the list. A deposit credited since it was last read (the background scan credits
   * transfers) means the balance on the page is behind: it is read again, unless the caller
   * is already doing that.
   */
  function loadDeposits(balanceReadAgain = false) {
    billingApi
      .listDeposits()
      .then((res) => {
        if (!mounted.current) return;
        const next = Array.isArray(res.deposits) ? res.deposits : [];
        const behind = listed.current !== null && creditedSince(listed.current, next);
        listed.current = next;
        setDeposits(next);
        if (behind && !balanceReadAgain) reloadBalance.current();
      })
      // The list is a convenience: the buttons above still say what happened.
      .catch(() => undefined);
  }

  useEffect(() => {
    mounted.current = true;
    billingApi
      .getDepositAddress()
      .then((res) => {
        if (!mounted.current) return;
        setAnswer(res);
        if (panelView(res).kind === "address") loadDeposits();
      })
      .catch((error) => {
        if (mounted.current) setLine({ ...afterDepositError(error), where: "address" });
      })
      .finally(() => {
        if (mounted.current) setIsLoading(false);
      });
    return () => {
      mounted.current = false;
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    };
  }, []);

  /** A refusal: its sentence beside the button pressed, and no address when it says there is none. */
  function refused(error: unknown, where: Where) {
    if (!mounted.current) return;
    if (hidesAddress(error)) {
      setAnswer(null);
      setLine({ ...afterDepositError(error), where: "address" });
      return;
    }
    setLine({ ...afterDepositError(error), where });
  }

  async function showAddress() {
    if (busy) return;
    setBusy("issue");
    try {
      const res = await billingApi.issueDepositAddress();
      if (!mounted.current) return;
      setAnswer(res);
      const said = afterIssue(res);
      setLine(said ? { ...said, where: "address" } : null);
      if (!said) loadDeposits();
    } catch (error) {
      refused(error, "address");
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  async function prepareAddress() {
    if (busy) return;
    setBusy("prepare");
    try {
      const res = await billingApi.prepareDepositUsdcAccount();
      if (!mounted.current) return;
      setAnswer((current) => (current ? withUsdcAccountOpen(current) : current));
      setLine({ ...afterPrepare(res), where: "prepare" });
    } catch (error) {
      refused(error, "prepare");
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  async function checkNow() {
    if (busy) return;
    setBusy("check");
    try {
      const next = afterCheck(await billingApi.checkDeposits());
      if (!mounted.current) return;
      setLine({ ...next.line, where: "check" });
      loadDeposits(next.reloadBalance);
      // A transfer of USDC can open the USDC account: read again whether it is open.
      billingApi
        .getDepositAddress()
        .then((res) => {
          if (mounted.current) setAnswer((current) => refreshedAddress(current, res));
        })
        .catch(() => undefined);
      if (next.reloadBalance) onCredited();
    } catch (error) {
      refused(error, "check");
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  async function copyAddress(address: string) {
    try {
      await navigator.clipboard.writeText(address);
      if (!mounted.current) return;
      setCopied(true);
      setLine(lineAfterCopied);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => {
        if (mounted.current) setCopied(false);
      }, 2_000);
    } catch {
      if (!mounted.current) return;
      setLine({ message: COPY_FAILED, tone: "error", where: "address" });
    }
  }

  const view = panelView(answer);
  const rows = depositRows(deposits);
  const lineAt = (where: Where) => (line?.where === where ? line : null);
  const addressLine = lineAt("address");
  const prepareLine = lineAt("prepare");
  const checkLine = lineAt("check");

  return (
    <section
      aria-labelledby="deposit-address-title"
      className="mt-6 min-w-0 border-t border-border pt-6"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="deposit-address-title" className="text-sm font-semibold text-foreground">
          {PANEL_TITLE}
        </h3>
        {view.kind === "address" && answer?.network === "devnet" && (
          <Badge variant="outline">Devnet</Badge>
        )}
      </div>

      {isLoading ? (
        <div className="mt-4 space-y-2" aria-hidden="true">
          <Skeleton className="h-10 w-full max-w-md" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>
      ) : view.kind === "none" ? (
        <div className="mt-4">
          <Button variant="outline" onClick={showAddress} isLoading={busy === "issue"}>
            {SHOW_ADDRESS}
          </Button>
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <span className="sr-only">Your deposit address</span>
            <code
              className="block min-w-0 flex-1 select-all break-all rounded-lg border border-border bg-muted px-3 py-2 font-mono text-sm text-foreground"
            >
              {view.address}
            </code>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 self-start sm:self-auto"
              onClick={() => copyAddress(view.address)}
              aria-label={copied ? "Deposit address copied" : "Copy deposit address"}
            >
              {copied ? (
                <Check className="mr-2 h-4 w-4" aria-hidden="true" />
              ) : (
                <Copy className="mr-2 h-4 w-4" aria-hidden="true" />
              )}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>

          <p className="break-words text-sm text-foreground">{view.message}</p>
          <div className="space-y-1">
            {view.notes.map((note) => (
              <p key={note} className="break-words text-sm text-muted-foreground">
                {note}
              </p>
            ))}
          </div>
        </div>
      )}

      {/* Always in the page so a change is announced. */}
      <div role="status" aria-live="polite" className={cn(addressLine && "mt-4")}>
        {addressLine && <LineBox line={addressLine} />}
      </div>

      {!isLoading && view.kind === "address" && (
        <>
          {(view.prepareHint || prepareLine) && (
            <div className="mt-4 space-y-3">
              {view.prepareHint && (
                <>
                  <p className="break-words text-sm text-muted-foreground">{view.prepareHint}</p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={prepareAddress}
                    isLoading={busy === "prepare"}
                    disabled={busy !== null}
                  >
                    {PREPARE_ADDRESS}
                  </Button>
                </>
              )}
              <div role="status" aria-live="polite">
                {prepareLine && <LineBox line={prepareLine} />}
              </div>
            </div>
          )}

          <div className="mt-4 space-y-3">
            <Button
              variant="outline"
              size="sm"
              onClick={checkNow}
              isLoading={busy === "check"}
              disabled={busy !== null}
            >
              {CHECK_NOW}
            </Button>
            <div role="status" aria-live="polite">
              {checkLine && <LineBox line={checkLine} />}
            </div>
          </div>

          {rows.length > 0 && (
            <div className="mt-6">
              <h4 className="text-sm font-medium text-foreground">Recent deposits</h4>
              <ul className="mt-3 space-y-2">
                {rows.map((row) => (
                  <li
                    key={row.id}
                    className="flex flex-col gap-1 rounded-lg border border-border p-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
                  >
                    <div className="min-w-0">
                      <p className="break-words text-sm text-foreground">{row.message}</p>
                      <p className="break-words text-xs text-muted-foreground">{row.sent}</p>
                    </div>
                    {row.arrivedAt && (
                      <time
                        dateTime={row.arrivedAt}
                        className="shrink-0 text-xs text-muted-foreground"
                      >
                        {new Date(row.arrivedAt).toLocaleString()}
                      </time>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}
