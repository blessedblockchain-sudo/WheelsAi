"use client";

import { useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Coins, ExternalLink, GraduationCap, Loader2, Wallet } from "lucide-react";
import { toast } from "sonner";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { tokenApi, type TokenCurve } from "@/lib/api";
import {
  GRADUATION_EXPLANATION,
  NO_CURVE_SENTENCE,
  REQUEST_EXPIRED_SENTENCE,
  STILL_NOT_CONFIRMED_SENTENCE,
  WALLET_CANNOT_SIGN_SENTENCE,
  canCheckAgain,
  curveErrorSentence,
  curveStateSentence,
  explorerAddressUrl,
  explorerTxUrl,
  formatDecimal,
  formatLamports,
  formatPriceSol,
  graduationStepLabel,
  graduationStepSentence,
  isSameAddress,
  lockScheduleWords,
  progressLabel,
  progressPercent,
  progressPercentLabel,
  sentTransactionFromError,
  tookTooLongToSign,
  type SentTransaction,
} from "@/lib/token-curve";
import { cn } from "@/lib/utils";

import { signPreparedTransaction } from "./token-curve-sign";
import { SentTransactionNotice } from "./token-sent-notice";

/** What a `submit` of the curve is posted with. Kept so "Check again" posts the same body. */
type SubmitBody = { prepareToken: string; signedTransaction: string };

/** An address on its own line with a link to Solana's explorer. It has no place to break, so it is cut into lines. */
function AddressLine({
  label,
  address,
  network,
}: {
  label: string;
  address: string;
  network: string;
}) {
  return (
    <div>
      <p className="text-muted-foreground">{label}</p>
      <a
        href={explorerAddressUrl(address, network)}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-start gap-1 break-all font-mono text-xs text-primary underline-offset-4 hover:underline"
      >
        {address}
        <ExternalLink className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
      </a>
    </div>
  );
}

function TransactionLink({ signature, network }: { signature: string; network: string }) {
  return (
    <a
      href={explorerTxUrl(signature, network)}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-xs text-primary underline-offset-4 hover:underline"
    >
      View the transaction on Solana&apos;s explorer
      <ExternalLink className="h-3 w-3" aria-hidden />
    </a>
  );
}

/**
 * The curve of a token on Meteora as the chain has it: how far it is from
 * graduation, the price, the fee, and where the pool is. When the curve is
 * full it also carries the button that graduates it.
 */
export function TokenCurveCard({
  tokenId,
  curve,
  loading,
  stale = false,
  missing = false,
  onChanged,
}: {
  tokenId: string;
  /** Null while the first read is on its way, and when the curve could not be read. */
  curve: TokenCurve | null;
  loading: boolean;
  /** The latest read failed and `curve` is the one before it. */
  stale?: boolean;
  /** The curve call answered 404: this token has no curve, and the page has stopped asking. */
  missing?: boolean;
  /** Called after graduation moves, so the page reads the curve again. */
  onChanged: () => void;
}) {
  // Once a walk has begun here its section stays, also after the curve
  // reads "graduated": what was sent is still there to follow.
  const [walkBegun, setWalkBegun] = useState(false);

  return (
    <Card data-testid="token-curve-card">
      <CardHeader>
        <CardTitle>Curve</CardTitle>
        {curve && <CardDescription>{curveStateSentence(curve.state)}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {curve ? (
          <>
            {stale && (
              <p className="text-xs text-yellow-600" role="status">
                The curve could not be read from Solana just now. These figures were read at{" "}
                {new Date(curve.readAt).toLocaleTimeString()}. This page tries again every 10
                seconds.
              </p>
            )}
            <div>
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="font-medium">{progressLabel(curve)}</span>
                <span className="text-muted-foreground">{progressPercentLabel(curve.progress)}</span>
              </div>
              <div
                className="h-3 w-full overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-label="SOL raised toward graduation"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.floor(progressPercent(curve.progress))}
              >
                <div
                  className={cn(
                    "h-full rounded-full transition-all duration-500",
                    curve.state === "trading" ? "bg-primary" : "bg-green-500"
                  )}
                  style={{ width: `${progressPercent(curve.progress)}%` }}
                />
              </div>
              <p className="mt-2 text-xs text-muted-foreground">{GRADUATION_EXPLANATION}</p>
            </div>

            <dl className="grid gap-3 sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">Price</dt>
                <dd className="break-all font-mono">{formatPriceSol(curve.priceSol)} SOL</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Trading fee right now</dt>
                <dd className="font-mono">{formatDecimal(curve.feePercentNow)}%</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Graduates at</dt>
                <dd className="font-mono">{formatDecimal(curve.graduationSol)} SOL raised</dd>
              </div>
              {/* Absent from an API older than the member: then the line is left out, never shown empty. */}
              {typeof curve.tradingFeesSol === "string" && (
                <div>
                  <dt className="text-muted-foreground">Trading fees since launch</dt>
                  <dd className="break-all font-mono">{formatDecimal(curve.tradingFeesSol)} SOL</dd>
                </div>
              )}
            </dl>

            {curve.creatorLocked && (
              <p className="text-xs text-muted-foreground">
                The creator&apos;s locked tokens are released like this:{" "}
                {lockScheduleWords(curve.creatorLocked)}.
              </p>
            )}

            <AddressLine label="Pool" address={curve.poolAddress} network={curve.network} />

            {curve.state === "graduated" && curve.graduatedPoolAddress && (
              <AddressLine
                label="Meteora pool after graduation (DAMM v2)"
                address={curve.graduatedPoolAddress}
                network={curve.network}
              />
            )}

            {(curve.state === "full" || walkBegun) && (
              <GraduateSection
                tokenId={tokenId}
                network={curve.network}
                open={curve.state === "full"}
                onBegun={() => setWalkBegun(true)}
                onChanged={onChanged}
              />
            )}
          </>
        ) : missing ? (
          <p className="text-muted-foreground">{NO_CURVE_SENTENCE}</p>
        ) : loading ? (
          <div className="space-y-3" aria-busy="true">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-3 w-full rounded-full" />
            <Skeleton className="h-4 w-2/3" />
            <span className="sr-only">Reading the curve</span>
          </div>
        ) : (
          <p className="text-muted-foreground">
            The curve could not be read from Solana just now. This page tries again every 10
            seconds.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Graduation, for any connected wallet, once the curve is full. It is one or
 * two transactions; each is named before the wallet is asked to sign it.
 */
function GraduateSection({
  tokenId,
  network,
  open,
  onBegun,
  onChanged,
}: {
  tokenId: string;
  network: string;
  /** The curve is full and has not graduated: the button is offered. */
  open: boolean;
  /** Called when a walk starts, so the card keeps this section after it. */
  onBegun: () => void;
  onChanged: () => void;
}) {
  const { publicKey, connected, signTransaction } = useWallet();
  const { setVisible } = useWalletModal();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signatures, setSignatures] = useState<string[]>([]);
  // Signing took too long: the button offers to prepare the step again.
  const [expired, setExpired] = useState(false);
  // A step that was sent and that the server could not vouch for, with the
  // body it was posted with, so "Check again" posts the same one.
  const [sent, setSent] = useState<SentTransaction | null>(null);
  const sentBody = useRef<SubmitBody | null>(null);
  const [checking, setChecking] = useState(false);

  // Only the move into the pool is graduation. A lock that went through is
  // not, whatever count came with it.
  const stepLanded = (step: string, signature: string): boolean => {
    setSignatures((prev) => (prev.includes(signature) ? prev : [...prev, signature]));
    return step === "migrate";
  };

  const failed = (err: unknown) => {
    const wasSent = sentTransactionFromError(err);
    setSent(wasSent);
    if (!canCheckAgain(wasSent)) sentBody.current = null;
    setExpired(tookTooLongToSign(err));
    setNote(null);
    setError(
      wasSent
        ? null
        : curveErrorSentence(err, "Graduation did not go through. Try again.", REQUEST_EXPIRED_SENTENCE)
    );
  };

  const graduate = async () => {
    if (!connected || !publicKey) {
      setVisible(true);
      return;
    }
    if (!signTransaction) {
      setError(WALLET_CANNOT_SIGN_SENTENCE);
      return;
    }
    setBusy(true);
    setError(null);
    setExpired(false);
    setSent(null);
    sentBody.current = null;
    onBegun();
    let graduated = false;
    try {
      // At most two steps (the lock, then the move). The server says which
      // one is next each time, so a walk that stopped half way picks up
      // where it stopped.
      for (let done = 0; done < 2; done++) {
        const prepared = await tokenApi.prepareGraduation(tokenId, {
          wallet: publicKey.toBase58(),
        });
        setNote(
          `${graduationStepLabel(done, prepared.stepsLeftAfterThis)}. ${graduationStepSentence(prepared.step)} Approve it in your wallet.`
        );
        const signedTransaction = await signPreparedTransaction(signTransaction, prepared.transaction);
        const body = { prepareToken: prepared.prepareToken, signedTransaction };
        sentBody.current = body;
        const result = await tokenApi.submitGraduation(tokenId, body);
        sentBody.current = null;
        if (stepLanded(prepared.step === "migrate" ? "migrate" : result.step, result.signature)) {
          graduated = true;
          break;
        }
      }
      setNote(graduated ? "The token has graduated." : null);
      if (graduated) toast.success("The token has graduated");
    } catch (err) {
      failed(err);
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  // The same body once more. The server sends nothing a second time: it
  // records the step if the transaction has landed.
  const checkAgain = async () => {
    const body = sentBody.current;
    if (!body || checking) return;
    setChecking(true);
    setError(null);
    try {
      const result = await tokenApi.submitGraduation(tokenId, body);
      setSent(null);
      sentBody.current = null;
      if (stepLanded(result.step, result.signature)) {
        setNote("The token has graduated.");
        toast.success("The token has graduated");
      } else {
        setNote("That step went through. Press Graduate for the next one.");
      }
    } catch (err) {
      const wasSent = sentTransactionFromError(err);
      if (wasSent) {
        setSent(wasSent);
        if (wasSent.kind === "failed") sentBody.current = null;
      } else {
        // The signature stays on the page: it is all there is to follow.
        setError(STILL_NOT_CONFIRMED_SENTENCE);
      }
    } finally {
      setChecking(false);
      onChanged();
    }
  };

  return (
    <div className="space-y-3 rounded-lg border p-4" data-testid="token-curve-graduate">
      {open && (
        <>
          <p className="text-muted-foreground">
            Graduating takes one or two transactions, each signed by your wallet. If the creator
            has locked tokens, the first puts them into a lock that releases them on the
            schedule. The last moves the SOL raised and the remaining tokens into a Meteora pool
            and locks that liquidity for good. Any wallet can do this, and that wallet pays
            Solana&apos;s fees for it.
          </p>
          <Button className="w-full" onClick={() => void graduate()} disabled={busy}>
            {busy ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : connected ? (
              <GraduationCap className="mr-2 h-4 w-4" />
            ) : (
              <Wallet className="mr-2 h-4 w-4" />
            )}
            {busy
              ? "Graduating"
              : !connected
                ? "Connect a wallet to graduate"
                : expired
                  ? "Prepare again"
                  : "Graduate"}
          </Button>
        </>
      )}
      {note && (
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {note}
        </p>
      )}
      {error && (
        <p className="text-xs text-red-600" role="alert">
          {error}
        </p>
      )}
      {sent && (
        <SentTransactionNotice
          sent={sent}
          network={network}
          checking={checking}
          onCheckAgain={() => void checkAgain()}
        />
      )}
      {signatures.map((signature) => (
        <div key={signature}>
          <TransactionLink signature={signature} network={network} />
        </div>
      ))}
    </div>
  );
}

/**
 * The creator's share of the trading fees and the button that claims it.
 * Renders nothing unless the connected wallet is the pool's creator as the
 * chain has it.
 */
export function TokenCreatorFeesCard({
  tokenId,
  curve,
  onChanged,
}: {
  tokenId: string;
  curve: TokenCurve | null;
  onChanged: () => void;
}) {
  const { publicKey, signTransaction } = useWallet();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claimed, setClaimed] = useState<{ signature: string; lamports: string } | null>(null);
  // As in the trade panel: signing that took too long, and a claim that was
  // sent and not seen confirmed, with the body "Check again" posts once more.
  const [expired, setExpired] = useState(false);
  const [sent, setSent] = useState<SentTransaction | null>(null);
  const sentBody = useRef<SubmitBody | null>(null);
  const [checking, setChecking] = useState(false);

  if (!curve || !publicKey || !isSameAddress(publicKey.toBase58(), curve.creatorAddress)) {
    return null;
  }

  const nothingToClaim = !/[1-9]/.test(curve.creatorClaimableLamports);

  const claimDone = (result: { signature: string; claimedLamports: string }) => {
    setSent(null);
    sentBody.current = null;
    setClaimed({ signature: result.signature, lamports: result.claimedLamports });
    toast.success("Fees claimed");
  };

  const claim = async () => {
    if (!signTransaction) {
      setError(WALLET_CANNOT_SIGN_SENTENCE);
      return;
    }
    setBusy(true);
    setError(null);
    setExpired(false);
    setSent(null);
    sentBody.current = null;
    try {
      const prepared = await tokenApi.prepareFeeClaim(tokenId, { wallet: publicKey.toBase58() });
      const signedTransaction = await signPreparedTransaction(signTransaction, prepared.transaction);
      const body = { prepareToken: prepared.prepareToken, signedTransaction };
      sentBody.current = body;
      claimDone(await tokenApi.submitFeeClaim(tokenId, body));
    } catch (err) {
      const wasSent = sentTransactionFromError(err);
      setSent(wasSent);
      if (!canCheckAgain(wasSent)) sentBody.current = null;
      setExpired(tookTooLongToSign(err));
      setError(
        wasSent
          ? null
          : curveErrorSentence(err, "The claim did not go through. Try again.", REQUEST_EXPIRED_SENTENCE)
      );
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  // The same body once more. The server sends nothing a second time.
  const checkAgain = async () => {
    const body = sentBody.current;
    if (!body || checking) return;
    setChecking(true);
    setError(null);
    try {
      claimDone(await tokenApi.submitFeeClaim(tokenId, body));
    } catch (err) {
      const wasSent = sentTransactionFromError(err);
      if (wasSent) {
        setSent(wasSent);
        if (wasSent.kind === "failed") sentBody.current = null;
      } else {
        setError(STILL_NOT_CONFIRMED_SENTENCE);
      }
    } finally {
      setChecking(false);
      onChanged();
    }
  };

  return (
    <Card data-testid="token-creator-fees">
      <CardHeader>
        <CardTitle className="text-sm">Your trading fees</CardTitle>
        <CardDescription>
          You launched this token. You earn {curve.creatorFeeSharePercent}% of the trading fees on
          its curve.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <span className="text-muted-foreground">Ready to claim</span>
          <span className="break-all font-mono">{formatDecimal(curve.creatorClaimableSol)} SOL</span>
        </div>
        <Button
          className="w-full"
          onClick={() => void claim()}
          disabled={busy || nothingToClaim}
        >
          {busy ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Coins className="mr-2 h-4 w-4" />
          )}
          {busy ? "Claiming" : expired ? "Prepare again" : "Claim"}
        </Button>
        {nothingToClaim && !busy && (
          <p className="text-xs text-muted-foreground">There are no fees to claim yet.</p>
        )}
        {error && (
          <p className="text-xs text-red-600" role="alert">
            {error}
          </p>
        )}
        {sent && (
          <SentTransactionNotice
            sent={sent}
            network={curve.network}
            checking={checking}
            onCheckAgain={() => void checkAgain()}
          />
        )}
        {claimed && (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">
              Claimed {formatLamports(claimed.lamports)} SOL.
            </p>
            <TransactionLink signature={claimed.signature} network={curve.network} />
          </div>
        )}
        {curve.state === "graduated" && (
          <p className="text-xs text-muted-foreground">
            Fees from the Meteora pool after graduation cannot be claimed in WheelsAI.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
