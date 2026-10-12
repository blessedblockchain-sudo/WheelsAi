"use client";

import { ExternalLink, Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  canCheckAgain,
  explorerTxUrl,
  sentTransactionSentence,
  type SentTransaction,
} from "@/lib/token-curve";

/**
 * A transaction the server sent and then could not vouch for: sent and not
 * confirmed yet, or gone through and not saved (each with a button that asks
 * the server again), or refused by the chain. Whichever it is, the signature
 * and its link stay on the page.
 */
export function SentTransactionNotice({
  sent,
  network,
  checking,
  onCheckAgain,
}: {
  sent: SentTransaction;
  /** Null when the network is not known: then no link is made up. */
  network: string | null | undefined;
  checking: boolean;
  /** Posts the same request once more. The server records the transaction if it has landed. */
  onCheckAgain: () => void;
}) {
  return (
    <div
      className="space-y-2 rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3 text-xs"
      role="status"
      data-testid="token-sent-notice"
    >
      <p>{sentTransactionSentence(sent)}</p>
      <p className="break-all font-mono text-muted-foreground">{sent.signature}</p>
      {network && (
        <a
          href={explorerTxUrl(sent.signature, network)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
        >
          View the transaction on Solana&apos;s explorer
          <ExternalLink className="h-3 w-3" aria-hidden />
        </a>
      )}
      {canCheckAgain(sent) && (
        <Button
          size="sm"
          variant="outline"
          className="w-full"
          onClick={onCheckAgain}
          disabled={checking}
        >
          {checking ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-2 h-4 w-4" />
          )}
          {checking ? "Checking" : "Check again"}
        </Button>
      )}
    </div>
  );
}
