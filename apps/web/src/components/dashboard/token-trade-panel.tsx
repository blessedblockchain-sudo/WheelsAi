"use client";

import { useState, useEffect, useCallback } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  Wallet,
  ArrowRightLeft,
  ExternalLink,
  Settings2,
  Loader2,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import {
  buildBuyTransaction,
  buildSellTransaction,
  getTokenBalance,
} from "@/lib/pumpfun-trade";
import { featureFlags } from "@/lib/feature-flags";
import { getErrorMessage } from "@/lib/api";

interface TokenTradePanelProps {
  tokenId: string;
  tokenName: string;
  symbol: string;
  priceUsd: number;
  status: string;
  pumpfunUrl?: string | null;
  mintAddress: string;
}

type TradeState =
  | "idle"
  | "building"
  | "signing"
  | "confirming"
  | "confirmed"
  | "failed";

/**
 * In-app trading is gated off until the server-prepared trade flow lands
 * (the previous client-built instructions were unsafe — see
 * lib/pumpfun-trade.ts). Until then we link out to the venue itself.
 */
export function TokenTradePanel(props: TokenTradePanelProps) {
  if (!featureFlags.trading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ArrowRightLeft className="h-5 w-5" />
            Trade {props.symbol}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            In-app trading is coming soon.
          </p>
          {props.pumpfunUrl ? (
            <a
              href={props.pumpfunUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex w-full items-center justify-center gap-2 rounded-md border border-input bg-background px-4 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              Trade on pump.fun
              <ExternalLink className="h-4 w-4" />
            </a>
          ) : null}
        </CardContent>
      </Card>
    );
  }
  return <TokenTradePanelInner {...props} />;
}

function TokenTradePanelInner({
  tokenId,
  tokenName,
  symbol,
  priceUsd,
  status,
  pumpfunUrl,
  mintAddress,
}: TokenTradePanelProps) {
  const { publicKey, connected, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const { setVisible } = useWalletModal();

  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState(100); // 1%
  const [showSlippage, setShowSlippage] = useState(false);
  const [tradeState, setTradeState] = useState<TradeState>("idle");
  const [txSignature, setTxSignature] = useState<string | null>(null);

  // Balances
  const [solBalance, setSolBalance] = useState<number | null>(null);
  const [tokenBalance, setTokenBalance] = useState<{
    amount: bigint;
    uiAmount: number;
    decimals: number;
  } | null>(null);

  const mint = new PublicKey(mintAddress);
  const solAmount = parseFloat(amount) || 0;
  const estimatedTokens = priceUsd > 0 ? (solAmount * 150) / priceUsd : 0;

  // Fetch balances
  const refreshBalances = useCallback(async () => {
    if (!publicKey || !connected) {
      setSolBalance(null);
      setTokenBalance(null);
      return;
    }

    try {
      const tokenMint = new PublicKey(mintAddress);
      const [lamports, tokenBal] = await Promise.all([
        connection.getBalance(publicKey),
        getTokenBalance(connection, publicKey, tokenMint),
      ]);
      setSolBalance(lamports / LAMPORTS_PER_SOL);
      setTokenBalance(tokenBal);
    } catch {
      // Ignore balance fetch errors
    }
  }, [publicKey, connected, connection, mintAddress]);

  useEffect(() => {
    refreshBalances();
    if (connected) {
      const interval = setInterval(refreshBalances, 15_000);
      return () => clearInterval(interval);
    }
  }, [refreshBalances, connected]);

  const handleTrade = async () => {
    if (!connected || !publicKey) {
      setVisible(true);
      return;
    }

    if (!amount || solAmount <= 0) {
      toast.error("Enter a valid amount");
      return;
    }

    setTradeState("building");
    setTxSignature(null);

    try {
      let tx;
      if (side === "buy") {
        tx = await buildBuyTransaction(
          connection,
          publicKey,
          mint,
          solAmount,
          slippageBps
        );
      } else {
        // For sell, amount is in tokens
        const tokenAmt = parseFloat(amount);
        if (!tokenBalance || tokenAmt <= 0) {
          toast.error("Invalid sell amount");
          setTradeState("idle");
          return;
        }
        const rawAmount = BigInt(
          Math.floor(tokenAmt * 10 ** tokenBalance.decimals)
        );
        tx = await buildSellTransaction(
          connection,
          publicKey,
          mint,
          rawAmount,
          slippageBps
        );
      }

      setTradeState("signing");
      const signature = await sendTransaction(tx, connection);

      setTradeState("confirming");
      setTxSignature(signature);

      await connection.confirmTransaction(signature, "confirmed");

      setTradeState("confirmed");
      toast.success(
        `${side === "buy" ? "Bought" : "Sold"} ${symbol} successfully!`
      );
      setAmount("");
      refreshBalances();

      // Reset after a few seconds
      setTimeout(() => setTradeState("idle"), 4000);
    } catch (err: any) {
      setTradeState("failed");
      const msg = getErrorMessage(err, "Transaction failed");
      if (msg.includes("User rejected")) {
        toast.error("Transaction cancelled");
      } else {
        toast.error(msg);
      }
      setTimeout(() => setTradeState("idle"), 3000);
    }
  };

  const handlePercentageSell = (pct: number) => {
    if (!tokenBalance) return;
    const val = (tokenBalance.uiAmount * pct) / 100;
    setAmount(val.toString());
  };

  const isTrading =
    tradeState === "building" ||
    tradeState === "signing" ||
    tradeState === "confirming";

  const stateLabel: Record<TradeState, string> = {
    idle: side === "buy" ? `Buy ${symbol}` : `Sell ${symbol}`,
    building: "Building transaction...",
    signing: "Approve in wallet...",
    confirming: "Confirming on chain...",
    confirmed: "Transaction confirmed!",
    failed: "Transaction failed",
  };

  return (
    <Card>
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
          >
            <Settings2 className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Slippage setting */}
        {showSlippage && (
          <div className="p-3 bg-muted rounded-lg space-y-2">
            <span className="text-xs font-medium text-muted-foreground">
              Slippage Tolerance
            </span>
            <div className="flex gap-2">
              {[50, 100, 200, 500].map((bps) => (
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

        {/* Wallet balances */}
        {connected && (
          <div className="flex justify-between text-xs text-muted-foreground px-1">
            <span>
              SOL: {solBalance !== null ? solBalance.toFixed(4) : "..."}
            </span>
            <span>
              {symbol}:{" "}
              {tokenBalance
                ? tokenBalance.uiAmount.toLocaleString(undefined, {
                    maximumFractionDigits: 2,
                  })
                : "0"}
            </span>
          </div>
        )}

        {/* Buy/Sell Toggle */}
        <div className="grid grid-cols-2 gap-1 p-1 bg-muted rounded-lg">
          <button
            className={cn(
              "px-4 py-2 rounded-md text-sm font-medium transition-colors",
              side === "buy"
                ? "bg-green-600 text-white"
                : "text-muted-foreground hover:text-foreground"
            )}
            onClick={() => setSide("buy")}
          >
            Buy
          </button>
          <button
            className={cn(
              "px-4 py-2 rounded-md text-sm font-medium transition-colors",
              side === "sell"
                ? "bg-red-600 text-white"
                : "text-muted-foreground hover:text-foreground"
            )}
            onClick={() => setSide("sell")}
          >
            Sell
          </button>
        </div>

        {/* Amount Input */}
        <div className="space-y-2">
          <label className="text-sm font-medium">
            {side === "buy" ? "Amount (SOL)" : `Amount (${symbol})`}
          </label>
          <Input
            type="number"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            min="0"
            step="0.01"
            disabled={isTrading}
          />
        </div>

        {/* Quick amounts */}
        <div className="flex gap-2">
          {side === "buy"
            ? [0.1, 0.5, 1, 5].map((val) => (
                <Button
                  key={val}
                  size="sm"
                  variant="outline"
                  className="flex-1 text-xs"
                  onClick={() => setAmount(val.toString())}
                  disabled={isTrading}
                >
                  {val} SOL
                </Button>
              ))
            : [25, 50, 75, 100].map((pct) => (
                <Button
                  key={pct}
                  size="sm"
                  variant="outline"
                  className="flex-1 text-xs"
                  onClick={() => handlePercentageSell(pct)}
                  disabled={isTrading || !tokenBalance}
                >
                  {pct}%
                </Button>
              ))}
        </div>

        {/* Estimate */}
        {solAmount > 0 && side === "buy" && (
          <div className="p-3 bg-muted rounded-lg text-sm space-y-1">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Estimated tokens:</span>
              <span className="font-mono">
                ~
                {estimatedTokens.toLocaleString(undefined, {
                  maximumFractionDigits: 0,
                })}{" "}
                {symbol}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Price per token:</span>
              <span className="font-mono">
                ${priceUsd < 0.01 ? priceUsd.toFixed(8) : priceUsd.toFixed(4)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Max slippage:</span>
              <span className="font-mono">{slippageBps / 100}%</span>
            </div>
          </div>
        )}

        {/* Trade Button */}
        <Button
          className={cn(
            "w-full",
            side === "buy"
              ? "bg-green-600 hover:bg-green-700"
              : "bg-red-600 hover:bg-red-700",
            tradeState === "confirmed" &&
              "bg-green-600 hover:bg-green-600",
            tradeState === "failed" && "bg-red-600 hover:bg-red-600"
          )}
          onClick={connected ? handleTrade : () => setVisible(true)}
          disabled={isTrading || status === "FAILED"}
        >
          {isTrading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {tradeState === "confirmed" && (
            <CheckCircle2 className="mr-2 h-4 w-4" />
          )}
          {tradeState === "failed" && <XCircle className="mr-2 h-4 w-4" />}
          {!isTrading &&
            tradeState !== "confirmed" &&
            tradeState !== "failed" && <Wallet className="mr-2 h-4 w-4" />}
          {!connected
            ? "Connect Wallet"
            : status === "FAILED"
              ? "Token Failed"
              : stateLabel[tradeState]}
        </Button>

        {/* Tx link */}
        {txSignature && (
          <div className="text-center">
            <a
              href={`https://solscan.io/tx/${txSignature}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-primary hover:underline inline-flex items-center gap-1"
            >
              <ExternalLink className="h-3 w-3" />
              View transaction on Solscan
            </a>
          </div>
        )}

        {/* Links */}
        <div className="flex flex-col gap-2 pt-2 border-t text-xs">
          {pumpfunUrl && (
            <a
              href={pumpfunUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-primary hover:underline"
            >
              <ExternalLink className="h-3 w-3" />
              View on pump.fun
            </a>
          )}
          <a
            href={`https://solscan.io/token/${mintAddress}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-primary hover:underline"
          >
            <ExternalLink className="h-3 w-3" />
            View on Solscan
          </a>
        </div>

        {/* Status */}
        {status === "BONDING" && (
          <div className="p-3 bg-yellow-500/10 border border-yellow-500/20 rounded-lg text-xs text-yellow-600">
            This token is on the bonding curve. It will graduate to Raydium DEX
            at ~$69K market cap.
          </div>
        )}
        {status === "GRADUATED" && (
          <div className="p-3 bg-green-500/10 border border-green-500/20 rounded-lg text-xs text-green-600">
            This token has graduated to Raydium DEX and is fully tradeable.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
