"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { PublicKey } from "@solana/web3.js";
import { ArrowRightLeft, ExternalLink, Loader2, Settings2, Wallet } from "lucide-react";
import { toast } from "sonner";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { tokenApi, type TokenCurve, type TokenTradeQuote, type TokenTradeSide } from "@/lib/api";
import { getTokenBalance } from "@/lib/pumpfun-trade";
import {
  NOT_ENOUGH_SOL_SENTENCE,
  NOT_ENOUGH_TOKENS_SENTENCE,
  SOL_DECIMALS,
  TOKEN_DECIMALS,
  WALLET_CANNOT_SIGN_SENTENCE,
  curveErrorSentence,
  explorerAddressUrl,
  explorerTxUrl,
  formatDecimal,
  formatLamports,
  formatTokenUnits,
  parseTypedAmount,
  rawExceeds,
  sentSignatureFromError,
  shareOfRaw,
  tradingClosedSentence,
  typedAmountProblem,
} from "@/lib/token-curve";
import { cn } from "@/lib/utils";

import { signPreparedTransaction } from "./token-curve-sign";

/** How long the field must be still before a quote is asked for. */
const QUOTE_DELAY_MS = 400;

const SLIPPAGE_CHOICES_BPS = [50, 100, 200, 500];

type Stage = "idle" | "preparing" | "signing" | "sending";

const STAGE_LABELS: Record<Exclude<Stage, "idle">, string> = {
  preparing: "Building the transaction",
  signing: "Approve it in your wallet",
  sending: "Sending it to Solana",
};

interface TokenCurveTradePanelProps {
  tokenId: string;
  symbol: string;
  mintAddress: string;
  /** Null while the curve is being read, and when it could not be read. */
  curve: TokenCurve | null;
  curveLoading: boolean;
  /** Called after a trade is sent, so the page reads the curve again. */
  onTraded: () => void;
}

/**
 * Buying and selling a token on its Meteora curve, inside the app. The
 * server quotes and builds the transaction, the connected wallet signs it,
 * the server checks it is the same transaction and sends it. Nothing here
 * builds an instruction or works out a price.
 */
export function TokenCurveTradePanel({
  tokenId,
  symbol,
  mintAddress,
  curve,
  curveLoading,
  onTraded,
}: TokenCurveTradePanelProps) {
  const { publicKey, connected, signTransaction } = useWallet();
  const { connection } = useConnection();
  const { setVisible } = useWalletModal();

  const [side, setSide] = useState<TokenTradeSide>("buy");
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState(100); // 1%
  const [showSlippage, setShowSlippage] = useState(false);
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [lastSignature, setLastSignature] = useState<string | null>(null);

  const [quote, setQuote] = useState<TokenTradeQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  // Only the answer to the latest question is shown: an older quote that
  // arrives late is dropped.
  const quoteRequest = useRef(0);
  const [quoteNonce, setQuoteNonce] = useState(0);

  // What the wallet holds, as raw strings. Null when it has not been read:
  // then nothing is said about it.
  const [solLamports, setSolLamports] = useState<string | null>(null);
  const [tokenRaw, setTokenRaw] = useState<string | null>(null);

  const decimals = side === "buy" ? SOL_DECIMALS : TOKEN_DECIMALS;
  const typed = parseTypedAmount(amount, decimals);
  const amountProblem = typedAmountProblem(typed, decimals);
  const typedAmount = typed.ok ? typed.amount : null;
  const busy = stage !== "idle";
  const closed = curve ? tradingClosedSentence(curve.state) : null;
  const network = curve?.network;

  // Read once when a wallet connects and again after a trade. Not on a
  // timer: a public RPC limits requests.
  const refreshBalances = useCallback(async () => {
    if (!publicKey || !connected) {
      setSolLamports(null);
      setTokenRaw(null);
      return;
    }
    try {
      const [lamports, token] = await Promise.all([
        connection.getBalance(publicKey),
        getTokenBalance(connection, publicKey, new PublicKey(mintAddress)),
      ]);
      setSolLamports(String(lamports));
      setTokenRaw(token.amount.toString());
    } catch {
      // A balance that cannot be read is not shown; trading does not wait on it.
      setSolLamports(null);
      setTokenRaw(null);
    }
  }, [publicKey, connected, connection, mintAddress]);

  useEffect(() => {
    void refreshBalances();
  }, [refreshBalances]);

  // A quote, 400 ms after the last key.
  useEffect(() => {
    const request = ++quoteRequest.current;
    setQuote(null);
    setQuoteError(null);
    if (typedAmount === null || closed !== null) {
      setQuoting(false);
      return;
    }
    setQuoting(true);
    const timer = setTimeout(() => {
      tokenApi
        .quoteTrade(tokenId, { side, amount: typedAmount, slippageBps })
        .then((answer) => {
          if (quoteRequest.current !== request) return;
          setQuote(answer);
        })
        .catch((err: unknown) => {
          if (quoteRequest.current !== request) return;
          setQuoteError(curveErrorSentence(err, "The quote could not be read. Try again."));
        })
        .finally(() => {
          if (quoteRequest.current === request) setQuoting(false);
        });
    }, QUOTE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [tokenId, side, typedAmount, slippageBps, closed, quoteNonce]);

  // The wallet may not hold what was typed. This is said, and does not block:
  // the balance is read from the browser's own connection, which can lag.
  const shortOf =
    typed.ok && side === "buy" && rawExceeds(typed.raw, solLamports)
      ? NOT_ENOUGH_SOL_SENTENCE
      : typed.ok && side === "sell" && rawExceeds(typed.raw, tokenRaw)
        ? NOT_ENOUGH_TOKENS_SENTENCE
        : null;

  const trade = async () => {
    if (!connected || !publicKey) {
      setVisible(true);
      return;
    }
    if (!signTransaction) {
      setError(WALLET_CANNOT_SIGN_SENTENCE);
      return;
    }
    if (typedAmount === null) return;

    setError(null);
    setLastSignature(null);
    setStage("preparing");
    try {
      const prepared = await tokenApi.prepareTrade(tokenId, {
        side,
        amount: typedAmount,
        slippageBps,
        wallet: publicKey.toBase58(),
      });
      // The transaction was built on this quote, so this is the one shown
      // while the wallet asks.
      setQuote(prepared.quote);
      setStage("signing");
      const signedTransaction = await signPreparedTransaction(signTransaction, prepared.transaction);
      setStage("sending");
      const result = await tokenApi.submitTrade(tokenId, {
        prepareToken: prepared.prepareToken,
        signedTransaction,
      });
      setLastSignature(result.signature);
      toast.success(
        result.trade.side === "buy"
          ? `Bought ${formatTokenUnits(result.trade.tokenAmountRaw)} ${symbol}`
          : `Sold ${formatTokenUnits(result.trade.tokenAmountRaw)} ${symbol}`
      );
      setAmount("");
    } catch (err) {
      setError(curveErrorSentence(err, "The trade did not go through. Try again."));
      // Sent but not seen confirmed: the signature is shown, so the person
      // can look before trading again.
      setLastSignature(sentSignatureFromError(err));
      // Whatever went wrong, the quote on screen is no longer the one to trust.
      setQuoteNonce((n) => n + 1);
    } finally {
      setStage("idle");
      onTraded();
      void refreshBalances();
    }
  };

  // One sentence under a button that cannot be pressed.
  const disabledReason = closed
    ? closed
    : !curve
      ? curveLoading
        ? "Reading the curve."
        : "The curve could not be read from Solana just now, so trading is paused."
      : !connected
        ? null
        : amountProblem
          ? amountProblem
          : typedAmount === null
            ? "Type an amount first."
            : null;
  const canPress = !busy && disabledReason === null;

  const unitIn = side === "buy" ? "SOL" : symbol;
  const unitOut = side === "buy" ? symbol : "SOL";

  return (
    <Card data-testid="token-curve-trade-panel">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2">
            <ArrowRightLeft className="h-5 w-5" />
            Trade ${symbol}
          </CardTitle>
          <button
            onClick={() => setShowSlippage(!showSlippage)}
            className="p-1.5 rounded-md hover:bg-muted transition-colors"
            title="Slippage settings"
            aria-label="Slippage settings"
          >
            <Settings2 className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {showSlippage && (
          <div className="p-3 bg-muted rounded-lg space-y-2">
            <span className="text-xs font-medium text-muted-foreground">
              How far the price may move against you before the trade is refused
            </span>
            <div className="flex gap-2">
              {SLIPPAGE_CHOICES_BPS.map((bps) => (
                <button
                  key={bps}
                  className={cn(
                    "flex-1 px-2 py-1 rounded text-xs font-medium transition-colors",
                    slippageBps === bps
                      ? "bg-primary text-primary-foreground"
                      : "bg-background hover:bg-accent"
                  )}
                  onClick={() => setSlippageBps(bps)}
                >
                  {bps / 100}%
                </button>
              ))}
            </div>
          </div>
        )}

        {connected && (solLamports !== null || tokenRaw !== null) && (
          <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 px-1 text-xs text-muted-foreground">
            <span>SOL: {formatLamports(solLamports, 4)}</span>
            <span>
              {symbol}: {formatTokenUnits(tokenRaw)}
            </span>
          </div>
        )}

        <div className="grid grid-cols-2 gap-1 p-1 bg-muted rounded-lg">
          {(["buy", "sell"] as const).map((choice) => (
            <button
              key={choice}
              className={cn(
                "px-4 py-2 rounded-md text-sm font-medium transition-colors",
                side === choice
                  ? choice === "buy"
                    ? "bg-green-600 text-white"
                    : "bg-red-600 text-white"
                  : "text-muted-foreground hover:text-foreground"
              )}
              onClick={() => {
                setSide(choice);
                setAmount("");
                setError(null);
              }}
              disabled={busy}
            >
              {choice === "buy" ? "Buy" : "Sell"}
            </button>
          ))}
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="curve-trade-amount">
            Amount ({unitIn})
          </label>
          <Input
            id="curve-trade-amount"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              setError(null);
            }}
            disabled={busy || closed !== null}
          />
        </div>

        <div className="flex gap-2">
          {side === "buy"
            ? ["0.1", "0.5", "1", "5"].map((val) => (
                <Button
                  key={val}
                  size="sm"
                  variant="outline"
                  className="flex-1 px-1 text-xs"
                  onClick={() => setAmount(val)}
                  disabled={busy || closed !== null}
                >
                  {val} SOL
                </Button>
              ))
            : [25, 50, 75, 100].map((pct) => (
                <Button
                  key={pct}
                  size="sm"
                  variant="outline"
                  className="flex-1 px-1 text-xs"
                  onClick={() => tokenRaw && setAmount(shareOfRaw(tokenRaw, pct, TOKEN_DECIMALS))}
                  disabled={busy || closed !== null || !tokenRaw || !/[1-9]/.test(tokenRaw)}
                >
                  {pct}%
                </Button>
              ))}
        </div>

        {shortOf && <p className="text-xs text-yellow-600">{shortOf}</p>}

        {(quote || quoting || quoteError) && (
          <div className="p-3 bg-muted rounded-lg text-sm space-y-1" aria-live="polite">
            {quote ? (
              <>
                <div className="flex flex-wrap justify-between gap-x-4">
                  <span className="text-muted-foreground">You get</span>
                  <span className="break-all font-mono">
                    {formatDecimal(quote.amountOut)} {unitOut}
                  </span>
                </div>
                <div className="flex flex-wrap justify-between gap-x-4">
                  <span className="text-muted-foreground">The least you will accept</span>
                  <span className="break-all font-mono">
                    {formatDecimal(quote.minimumOut)} {unitOut}
                  </span>
                </div>
                <div className="flex flex-wrap justify-between gap-x-4">
                  <span className="text-muted-foreground">Trading fee</span>
                  <span className="break-all font-mono">{formatDecimal(quote.feeSol)} SOL</span>
                </div>
              </>
            ) : quoteError ? (
              <p className="text-red-600">{quoteError}</p>
            ) : (
              <p className="text-muted-foreground">Asking for a quote.</p>
            )}
          </div>
        )}

        <Button
          className={cn(
            "w-full",
            side === "buy" ? "bg-green-600 hover:bg-green-700" : "bg-red-600 hover:bg-red-700"
          )}
          onClick={() => void trade()}
          disabled={!canPress}
        >
          {busy ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Wallet className="mr-2 h-4 w-4" />
          )}
          {busy
            ? STAGE_LABELS[stage as Exclude<Stage, "idle">]
            : !connected
              ? "Connect a wallet to trade"
              : side === "buy"
                ? `Buy ${symbol}`
                : `Sell ${symbol}`}
        </Button>
        {disabledReason && !busy && (
          <p className="text-xs text-muted-foreground">{disabledReason}</p>
        )}

        {error && (
          <p className="text-xs text-red-600" role="alert">
            {error}
          </p>
        )}

        {lastSignature && (
          <div className="space-y-1 text-xs">
            <p className="text-muted-foreground">
              Sent. Signature <span className="break-all font-mono">{lastSignature}</span>
            </p>
            <a
              href={explorerTxUrl(lastSignature, network)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              <ExternalLink className="h-3 w-3" aria-hidden />
              View the transaction on Solana&apos;s explorer
            </a>
          </div>
        )}

        {curve && (
          <div className="flex flex-col gap-2 pt-2 border-t text-xs">
            <a
              href={explorerAddressUrl(mintAddress, network)}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-primary hover:underline"
            >
              <ExternalLink className="h-3 w-3" aria-hidden />
              View the token on Solana&apos;s explorer
            </a>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
