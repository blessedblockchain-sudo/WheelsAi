"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { VersionedTransaction } from "@solana/web3.js";
import { Header } from "@/components/dashboard/header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  marketplaceApi,
  tokenApi,
  type MarketplaceListing,
} from "@/lib/api";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  X,
  Loader2,
  Coins,
  Wallet,
  Shield,
  Sparkles,
} from "lucide-react";

type Step = 1 | 2 | 3 | 4;

interface EligibilityResult {
  eligible: boolean;
  reasons: string[];
  listing: { id: string; title: string; agentName: string };
}

export default function CreateTokenPage() {
  const router = useRouter();
  const { publicKey, connected, signTransaction } = useWallet();
  const { setVisible } = useWalletModal();

  const [step, setStep] = useState<Step>(1);
  const [listings, setListings] = useState<MarketplaceListing[]>([]);
  const [loading, setLoading] = useState(true);
  const [eligibility, setEligibility] = useState<Record<string, EligibilityResult>>({});
  const [checkingEligibility, setCheckingEligibility] = useState<string | null>(null);

  // Step 1: Selected listing
  const [selectedListingId, setSelectedListingId] = useState<string | null>(null);

  // Step 2: Token details
  const [tokenName, setTokenName] = useState("");
  const [tokenSymbol, setTokenSymbol] = useState("");
  const [tokenDescription, setTokenDescription] = useState("");

  // Step 4: Creating
  const [isCreating, setIsCreating] = useState(false);

  const selectedListing = listings.find((l) => l.id === selectedListingId);
  const selectedEligibility = selectedListingId
    ? eligibility[selectedListingId]
    : null;

  useEffect(() => {
    async function loadListings() {
      try {
        const data = await marketplaceApi.getMyListings();
        const published = (data.listings || []).filter(
          (l) => l.status === "published"
        );
        setListings(published);
      } catch {
        toast.error("Failed to load your listings");
      } finally {
        setLoading(false);
      }
    }
    loadListings();
  }, []);

  const checkEligibility = async (listingId: string) => {
    if (eligibility[listingId]) return;
    setCheckingEligibility(listingId);
    try {
      const result = await tokenApi.checkEligibility(listingId);
      setEligibility((prev) => ({ ...prev, [listingId]: result }));
    } catch {
      setEligibility((prev) => ({
        ...prev,
        [listingId]: {
          eligible: false,
          reasons: ["Failed to check eligibility"],
          listing: { id: listingId, title: "", agentName: "" },
        },
      }));
    } finally {
      setCheckingEligibility(null);
    }
  };

  const handleSelectListing = async (listing: MarketplaceListing) => {
    setSelectedListingId(listing.id);
    await checkEligibility(listing.id);

    // Auto-fill token details
    const name = listing.title;
    setTokenName(`${name} Token`);
    setTokenSymbol(
      name
        .replace(/[^a-zA-Z]/g, "")
        .slice(0, 4)
        .toUpperCase()
    );
    setTokenDescription(listing.shortDescription || "");
  };

  const handleCreate = async () => {
    if (!connected || !publicKey) {
      setVisible(true);
      return;
    }
    if (!signTransaction) {
      toast.error(
        "This wallet doesn't support transaction signing — try a different wallet.",
      );
      return;
    }

    if (!selectedListingId || !selectedListing) return;

    // Browser-partial-sign flow (Phase 1.5):
    //   1. POST /launch/prepare  → server prepares pump.fun create tx,
    //                              signs mint half, returns base64 +
    //                              short-lived HMAC prepareToken.
    //   2. Wallet signs the tx.  → user reviews + approves in their wallet.
    //   3. POST /launch/submit   → server broadcasts the fully-signed
    //                              tx, persists AgentToken + AgentTreasury.
    setIsCreating(true);
    try {
      const prepared = await tokenApi.prepareLaunch({
        agentId: selectedListing.agentId,
        symbol: tokenSymbol,
        description: tokenDescription || tokenName,
        imageUri: selectedListing.iconUrl ?? undefined,
      });

      // Deserialize the partial-signed tx and let the wallet add its
      // signature. wallet.signTransaction preserves existing signatures
      // (the mint slot the server already filled) and only signs the
      // creator slot matching the wallet's pubkey.
      const partialBytes = Uint8Array.from(
        atob(prepared.partialSignedTxBase64),
        (c) => c.charCodeAt(0),
      );
      const tx = VersionedTransaction.deserialize(partialBytes);
      const signedTx = await signTransaction(tx);

      const signedBytes = signedTx.serialize();
      // Base64-encode without going through Node's Buffer (browser
      // bundle stays small).
      let binary = "";
      for (let i = 0; i < signedBytes.length; i++) {
        binary += String.fromCharCode(signedBytes[i]!);
      }
      const signedTxBase64 = btoa(binary);

      const result = await tokenApi.submitLaunch({
        prepareToken: prepared.prepareToken,
        signedTxBase64,
      });

      toast.success("Token created successfully!");
      router.push(`/dashboard/marketplace/tokens/${result.tokenId}`);
    } catch (err: any) {
      const msg =
        err?.data?.message ??
        err?.data?.error ??
        err?.message ??
        "Failed to create token";
      toast.error(msg);
      setIsCreating(false);
    }
  };

  const canProceed = (): boolean => {
    switch (step) {
      case 1:
        return !!selectedListingId && !!selectedEligibility?.eligible;
      case 2:
        return tokenName.length >= 2 && tokenSymbol.length >= 2;
      case 3:
        return true;
      case 4:
        return connected && !!publicKey;
      default:
        return false;
    }
  };

  const stepLabels = ["Select Agent", "Token Details", "Review", "Confirm"];

  return (
    <div className="flex flex-col">
      <Header
        title="Create Agent Token"
        description="Launch a token for your AI agent on the pump.fun bonding curve"
      />

      <div className="p-8 max-w-3xl mx-auto w-full space-y-6">
        {/* Progress bar */}
        <div className="flex items-center gap-2">
          {stepLabels.map((label, i) => (
            <div key={label} className="flex items-center gap-2 flex-1">
              <div
                className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-full text-sm font-medium shrink-0",
                  step > i + 1
                    ? "bg-green-600 text-white"
                    : step === i + 1
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground"
                )}
              >
                {step > i + 1 ? <Check className="h-4 w-4" /> : i + 1}
              </div>
              <span
                className={cn(
                  "text-xs font-medium hidden sm:block",
                  step === i + 1 ? "text-foreground" : "text-muted-foreground"
                )}
              >
                {label}
              </span>
              {i < stepLabels.length - 1 && (
                <div
                  className={cn(
                    "flex-1 h-px",
                    step > i + 1 ? "bg-green-600" : "bg-muted"
                  )}
                />
              )}
            </div>
          ))}
        </div>

        {/* Step 1: Select Agent */}
        {step === 1 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Sparkles className="h-5 w-5" />
                Select Agent
              </CardTitle>
              <CardDescription>
                Choose one of your published marketplace listings to tokenize
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="flex justify-center py-12">
                  <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                </div>
              ) : listings.length === 0 ? (
                <div className="text-center py-12">
                  <Coins className="mx-auto h-12 w-12 text-muted-foreground" />
                  <p className="mt-4 text-muted-foreground">
                    You need at least one published marketplace listing to create
                    a token.
                  </p>
                  <Button
                    variant="outline"
                    className="mt-4"
                    onClick={() =>
                      router.push("/dashboard/marketplace/publish")
                    }
                  >
                    Publish an Agent
                  </Button>
                </div>
              ) : (
                <div className="space-y-3">
                  {listings.map((listing) => {
                    const elig = eligibility[listing.id];
                    const isSelected = selectedListingId === listing.id;
                    const isChecking = checkingEligibility === listing.id;

                    return (
                      <button
                        key={listing.id}
                        onClick={() => handleSelectListing(listing)}
                        className={cn(
                          "w-full rounded-lg border p-4 text-left transition-colors",
                          isSelected
                            ? "border-primary bg-primary/5"
                            : "border-gray-200 hover:border-gray-300"
                        )}
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="font-medium">{listing.title}</p>
                            <p className="text-sm text-muted-foreground mt-1">
                              {listing.shortDescription}
                            </p>
                          </div>
                          <div className="shrink-0 ml-4">
                            {isChecking ? (
                              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                            ) : elig ? (
                              elig.eligible ? (
                                <Badge variant="success">Eligible</Badge>
                              ) : (
                                <Badge variant="destructive">Ineligible</Badge>
                              )
                            ) : null}
                          </div>
                        </div>
                        {elig && !elig.eligible && (
                          <div className="mt-3 space-y-1">
                            {elig.reasons.map((reason, i) => (
                              <div
                                key={i}
                                className="flex items-center gap-2 text-xs text-red-600"
                              >
                                <X className="h-3 w-3 shrink-0" />
                                {reason}
                              </div>
                            ))}
                          </div>
                        )}
                        {elig?.eligible && (
                          <div className="mt-3">
                            <div className="flex items-center gap-2 text-xs text-green-600">
                              <Check className="h-3 w-3 shrink-0" />
                              Meets all requirements for tokenization
                            </div>
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Step 2: Token Details */}
        {step === 2 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Coins className="h-5 w-5" />
                Token Details
              </CardTitle>
              <CardDescription>
                Configure your token name, symbol, and description
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">
                  Token Name
                </label>
                <Input
                  value={tokenName}
                  onChange={(e) => setTokenName(e.target.value)}
                  placeholder="My Agent Token"
                  maxLength={32}
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">
                  Symbol
                </label>
                <Input
                  value={tokenSymbol}
                  onChange={(e) =>
                    setTokenSymbol(e.target.value.toUpperCase().slice(0, 8))
                  }
                  placeholder="TKNS"
                  maxLength={8}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  2-8 uppercase characters
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">
                  Description (optional)
                </label>
                <textarea
                  className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring min-h-[80px]"
                  value={tokenDescription}
                  onChange={(e) => setTokenDescription(e.target.value)}
                  placeholder="Describe your agent token..."
                  maxLength={500}
                />
              </div>
            </CardContent>
          </Card>
        )}

        {/* Step 3: Review */}
        {step === 3 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Shield className="h-5 w-5" />
                Review
              </CardTitle>
              <CardDescription>
                Confirm your token details before creation
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="rounded-lg border p-4 space-y-3">
                <div className="flex justify-between">
                  <span className="text-sm text-muted-foreground">Agent</span>
                  <span className="text-sm font-medium">
                    {selectedListing?.title}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm text-muted-foreground">
                    Token Name
                  </span>
                  <span className="text-sm font-medium">{tokenName}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm text-muted-foreground">Symbol</span>
                  <span className="text-sm font-mono font-medium">
                    ${tokenSymbol}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm text-muted-foreground">
                    Total Supply
                  </span>
                  <span className="text-sm font-mono font-medium">
                    1,000,000,000
                  </span>
                </div>
              </div>

              <div className="space-y-2">
                <h4 className="text-sm font-medium">Supply Breakdown</h4>
                <div className="rounded-lg border p-4 space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">
                      Bonding Curve (80%)
                    </span>
                    <span className="font-mono">800,000,000</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">
                      Reserved (20%)
                    </span>
                    <span className="font-mono">200,000,000</span>
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <h4 className="text-sm font-medium">Anti-Scam Requirements</h4>
                <div className="rounded-lg border p-4 space-y-2">
                  {[
                    "Creator reputation score >= 50",
                    "Agent uptime >= 7 days",
                    "Creator lockup period: 30 days",
                  ].map((req) => (
                    <div key={req} className="flex items-center gap-2 text-sm">
                      <Check className="h-4 w-4 text-green-600 shrink-0" />
                      {req}
                    </div>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Step 4: Confirm */}
        {step === 4 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Wallet className="h-5 w-5" />
                Confirm & Create
              </CardTitle>
              <CardDescription>
                Connect your wallet and create the token on pump.fun
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {!connected ? (
                <div className="text-center py-8">
                  <Wallet className="mx-auto h-12 w-12 text-muted-foreground" />
                  <p className="mt-4 text-muted-foreground">
                    Connect your Solana wallet to create the token
                  </p>
                  <Button className="mt-4" onClick={() => setVisible(true)}>
                    <Wallet className="mr-2 h-4 w-4" />
                    Connect Wallet
                  </Button>
                </div>
              ) : (
                <>
                  <div className="rounded-lg border p-4 space-y-2">
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">
                        Creator Address
                      </span>
                      <code className="font-mono text-xs">
                        {publicKey?.toBase58().slice(0, 8)}...
                        {publicKey?.toBase58().slice(-8)}
                      </code>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Token</span>
                      <span className="font-medium">
                        {tokenName} (${tokenSymbol})
                      </span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Platform</span>
                      <span>pump.fun bonding curve</span>
                    </div>
                  </div>

                  <div className="p-3 bg-yellow-500/10 border border-yellow-500/20 rounded-lg text-sm text-yellow-700">
                    By creating this token, you agree to the 30-day creator
                    lockup period. Your tokens will be locked and cannot be sold
                    for 30 days after creation.
                  </div>

                  <Button
                    className="w-full"
                    onClick={handleCreate}
                    disabled={isCreating}
                  >
                    {isCreating ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Coins className="mr-2 h-4 w-4" />
                    )}
                    {isCreating ? "Creating Token..." : "Create Token"}
                  </Button>
                </>
              )}
            </CardContent>
          </Card>
        )}

        {/* Navigation */}
        <div className="flex justify-between">
          <Button
            variant="outline"
            onClick={() => (step === 1 ? router.back() : setStep((step - 1) as Step))}
            disabled={isCreating}
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            {step === 1 ? "Cancel" : "Back"}
          </Button>

          {step < 4 && (
            <Button
              onClick={() => setStep((step + 1) as Step)}
              disabled={!canProceed()}
            >
              Next
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
