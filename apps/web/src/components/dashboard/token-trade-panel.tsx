"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Wallet, ArrowRightLeft, ExternalLink } from "lucide-react";

interface TokenTradePanelProps {
  tokenId: string;
  tokenName: string;
  symbol: string;
  priceUsd: number;
  status: string;
  pumpfunUrl?: string | null;
  mintAddress: string;
}

export function TokenTradePanel({
  tokenId,
  tokenName,
  symbol,
  priceUsd,
  status,
  pumpfunUrl,
  mintAddress,
}: TokenTradePanelProps) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");

  const solAmount = parseFloat(amount) || 0;
  const estimatedTokens = priceUsd > 0 ? (solAmount * 150) / priceUsd : 0; // rough SOL->USD->tokens

  const handleTrade = () => {
    if (!amount || solAmount <= 0) {
      toast.error("Enter a valid amount");
      return;
    }

    // For now, redirect to pump.fun for actual trading
    if (pumpfunUrl) {
      window.open(pumpfunUrl, "_blank");
    } else {
      toast.info("Trading will be available when the token is live on pump.fun");
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <ArrowRightLeft className="h-5 w-5" />
          Trade ${symbol}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
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
          <Label>{side === "buy" ? "Amount (SOL)" : `Amount (${symbol})`}</Label>
          <Input
            type="number"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            min="0"
            step="0.01"
          />
        </div>

        {/* Quick amounts */}
        <div className="flex gap-2">
          {(side === "buy" ? [0.1, 0.5, 1, 5] : [25, 50, 75, 100]).map((val) => (
            <Button
              key={val}
              size="sm"
              variant="outline"
              className="flex-1 text-xs"
              onClick={() => setAmount(val.toString())}
            >
              {side === "buy" ? `${val} SOL` : `${val}%`}
            </Button>
          ))}
        </div>

        {/* Estimate */}
        {solAmount > 0 && side === "buy" && (
          <div className="p-3 bg-muted rounded-lg text-sm space-y-1">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Estimated tokens:</span>
              <span className="font-mono">
                ~{estimatedTokens.toLocaleString(undefined, { maximumFractionDigits: 0 })} {symbol}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Price per token:</span>
              <span className="font-mono">
                ${priceUsd < 0.01 ? priceUsd.toFixed(8) : priceUsd.toFixed(4)}
              </span>
            </div>
          </div>
        )}

        {/* Trade Button */}
        <Button
          className={cn(
            "w-full",
            side === "buy"
              ? "bg-green-600 hover:bg-green-700"
              : "bg-red-600 hover:bg-red-700"
          )}
          onClick={handleTrade}
          disabled={status === "FAILED"}
        >
          <Wallet className="mr-2 h-4 w-4" />
          {status === "FAILED"
            ? "Token Failed"
            : pumpfunUrl
            ? `${side === "buy" ? "Buy" : "Sell"} on pump.fun`
            : "Connect Wallet"}
        </Button>

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
            This token is on the bonding curve. It will graduate to Raydium DEX at ~$69K market cap.
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
