"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import {
  AlertTriangle,
  Coins,
  Loader2,
  Shield,
  X,
} from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

interface TokenizeModalProps {
  agentListingId: string;
  agentName: string;
  onClose: () => void;
  onSuccess: (token: { id: string; mintAddress: string; pumpfunUrl?: string }) => void;
}

export function TokenizeModal({
  agentListingId,
  agentName,
  onClose,
  onSuccess,
}: TokenizeModalProps) {
  const [step, setStep] = useState<"form" | "confirm" | "creating">("form");
  const [name, setName] = useState(`${agentName} Token`);
  const [symbol, setSymbol] = useState(
    agentName
      .replace(/[^a-zA-Z]/g, "")
      .toUpperCase()
      .slice(0, 5) || "AGENT"
  );
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    setStep("creating");
    setError(null);

    try {
      const response = await fetch(`${API_URL}/api/tokens/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          agentListingId,
          name,
          symbol,
          description,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || data.error || "Failed to create token");
      }

      toast.success("Token created successfully!");
      onSuccess(data.token);
    } catch (err: any) {
      setError(err.message);
      setStep("confirm");
      toast.error(err.message);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />

      {/* Modal */}
      <div className="relative w-full max-w-lg mx-4 bg-background border rounded-xl shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
              <Coins className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h2 className="font-semibold text-lg">Tokenize Agent</h2>
              <p className="text-sm text-muted-foreground">Create a token on pump.fun</p>
            </div>
          </div>
          <Button size="icon" variant="ghost" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-4">
          {step === "form" && (
            <>
              <div className="space-y-2">
                <Label htmlFor="tokenName">Token Name</Label>
                <Input
                  id="tokenName"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="My Agent Token"
                  maxLength={50}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="tokenSymbol">Symbol / Ticker</Label>
                <Input
                  id="tokenSymbol"
                  value={symbol}
                  onChange={(e) => setSymbol(e.target.value.toUpperCase().replace(/[^A-Z]/g, ""))}
                  placeholder="AGNT"
                  maxLength={10}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="tokenDesc">Description (optional)</Label>
                <Input
                  id="tokenDesc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="A brief description of this agent token"
                  maxLength={280}
                />
              </div>

              {/* Info box */}
              <div className="p-4 bg-muted rounded-lg space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Total Supply:</span>
                  <span className="font-mono">1,000,000,000</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Bonding Curve:</span>
                  <span className="font-mono">800,000,000 (80%)</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Reserved:</span>
                  <span className="font-mono">200,000,000 (20%)</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Graduation:</span>
                  <span>~$69K market cap → Raydium</span>
                </div>
              </div>

              <Button
                className="w-full"
                onClick={() => setStep("confirm")}
                disabled={!name.trim() || !symbol.trim()}
              >
                Continue
              </Button>
            </>
          )}

          {step === "confirm" && (
            <>
              {/* Requirements check */}
              <div className="space-y-3">
                <div className="flex items-start gap-3 p-3 border rounded-lg">
                  <Shield className="h-5 w-5 text-green-500 mt-0.5" />
                  <div>
                    <div className="font-medium text-sm">Anti-Scam Checks</div>
                    <ul className="text-xs text-muted-foreground mt-1 space-y-1">
                      <li>Agent reputation score &ge; 50</li>
                      <li>Agent uptime &ge; 7 days</li>
                      <li>Creator tokens locked 30 days post-graduation</li>
                    </ul>
                  </div>
                </div>

                <div className="flex items-start gap-3 p-3 border rounded-lg border-yellow-500/30 bg-yellow-500/5">
                  <AlertTriangle className="h-5 w-5 text-yellow-500 mt-0.5" />
                  <div>
                    <div className="font-medium text-sm">Important</div>
                    <p className="text-xs text-muted-foreground mt-1">
                      This action creates a real token on Solana via pump.fun. The bonding
                      curve is public and anyone can buy/sell. Make sure your agent is
                      production-ready.
                    </p>
                  </div>
                </div>
              </div>

              {/* Summary */}
              <div className="p-4 bg-muted rounded-lg space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Token:</span>
                  <span className="font-semibold">
                    {name} (${symbol})
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Agent:</span>
                  <span>{agentName}</span>
                </div>
              </div>

              {error && (
                <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-600">
                  {error}
                </div>
              )}

              <div className="flex gap-3">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => {
                    setStep("form");
                    setError(null);
                  }}
                >
                  Back
                </Button>
                <Button className="flex-1" onClick={handleCreate}>
                  <Coins className="mr-2 h-4 w-4" />
                  Create Token
                </Button>
              </div>
            </>
          )}

          {step === "creating" && (
            <div className="flex flex-col items-center justify-center py-8 space-y-4">
              <Loader2 className="h-12 w-12 animate-spin text-primary" />
              <div className="text-center">
                <h3 className="font-semibold">Creating Token...</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  Submitting to pump.fun and creating the bonding curve. This may take a moment.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
