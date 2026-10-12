"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Header } from "@/components/dashboard/header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import { EmptyState } from "@/components/ui/empty-state";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  marketplaceApi,
  tokenApi,
  type LaunchpadInfo,
  type MarketplaceListing,
  getErrorMessage,
} from "@/lib/api";
import { CurvePresetCard } from "@/components/dashboard/curve-preset-card";
import { signPreparedTransaction } from "@/components/dashboard/token-curve-sign";
import {
  GRADUATION_EXPLANATION,
  explorerAddressUrl,
  explorerTxUrl,
  launchpadLabel,
  presetFacts,
} from "@/lib/token-curve";
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
  ExternalLink,
} from "lucide-react";

// The launchpad's name comes from GET /api/tokens/launchpad. This build-time
// setting is only what the page says when that call fails.
const FALLBACK_LAUNCHPAD_LABEL = launchpadLabel(process.env.NEXT_PUBLIC_LAUNCHPAD);

type Step = 1 | 2 | 3 | 4;

interface EligibilityResult {
  eligible: boolean;
  reasons: string[];
  requirements?: {
    minReputation: number;
    minDeploymentAgeDays: number;
    creatorLockupDays: number;
  };
}

export default function CreateTokenPage() {
  const router = useRouter();
  const { publicKey, connected, signTransaction } = useWallet();
  const { setVisible } = useWalletModal();

  const [step, setStep] = useState<Step>(1);
  const [listings, setListings] = useState<MarketplaceListing[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [eligibility, setEligibility] = useState<Record<string, EligibilityResult>>({});
  const [checkingEligibility, setCheckingEligibility] = useState<string | null>(null);

  // Which launchpad is on, its curves and the launch gate. Null until the
  // call answers, and for good when it fails: the page then works as it did
  // before the call existed.
  const [launchpad, setLaunchpad] = useState<LaunchpadInfo | null>(null);
  const [presetId, setPresetId] = useState<string | null>(null);

  // Step 1: Selected listing
  const [selectedListingId, setSelectedListingId] = useState<string | null>(null);

  // Step 2: Token details
  const [tokenName, setTokenName] = useState("");
  const [tokenSymbol, setTokenSymbol] = useState("");
  const [tokenDescription, setTokenDescription] = useState("");
  // Optional creator "dev buy" in SOL (spends the user's own SOL via the
  // wallet-signed tx). Empty string = no initial buy.
  const [initialBuySol, setInitialBuySol] = useState("");

  // Step 4: Creating
  const [isCreating, setIsCreating] = useState(false);

  // Set once the launch is on chain and saved: the page shows where it went.
  const [launched, setLaunched] = useState<{
    tokenId: string;
    mintAddress: string;
    txSignature: string;
  } | null>(null);

  // Recovery: set when the mint broadcast on-chain but persistence failed.
  const [recovery, setRecovery] = useState<{
    mintAddress: string;
    txSignature: string;
    prepareToken: string;
  } | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);

  const selectedListing = listings.find((l) => l.id === selectedListingId);
  const selectedEligibility = selectedListingId
    ? eligibility[selectedListingId]
    : null;
  // pump.fun requires an image; the token's metadata is built from the
  // agent's listing icon. Without one, prepare would fail server-side, so
  // block the flow early with an actionable message.
  const missingIcon = !!selectedListing && !selectedListing.iconUrl;

  const launchpadName = launchpad ? launchpadLabel(launchpad.launchpad) : FALLBACK_LAUNCHPAD_LABEL;
  const isMeteora = launchpad?.launchpad === "meteora";
  const presets = launchpad?.presets ?? [];
  const selectedPreset = presets.find((p) => p.id === presetId) ?? null;
  // The gate's numbers: from the launchpad call, else from the eligibility
  // answer for the agent chosen. Never a number written into this page.
  const gate = launchpad?.gate ?? selectedEligibility?.requirements ?? null;

  useEffect(() => {
    let cancelled = false;
    tokenApi
      .launchpadInfo()
      .then((info) => {
        if (cancelled) return;
        setLaunchpad(info);
        const first =
          info.presets.find((p) => p.id === info.defaultPreset) ?? info.presets[0] ?? null;
        setPresetId(first ? first.id : null);
      })
      .catch(() => {
        // The fallback label and the eligibility answer carry the page.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loadListings = useCallback(async () => {
    try {
      const data = await marketplaceApi.getMyListings();
      const published = (data.listings || []).filter(
        (l) => l.status === "published"
      );
      setListings(published);
      setLoadError(null);
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to load your listings"));
      setLoadError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadListings();
  }, [loadListings]);

  const retryLoadListings = () => {
    setLoadError(null);
    setLoading(true);
    void loadListings();
  };

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
          reasons: ["Could not check whether this agent can launch a token. Try again."],
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
      toast.error("This wallet cannot sign a transaction here. Try a different wallet.");
      return;
    }

    if (!selectedListingId || !selectedListing) return;

    // Browser-partial-sign flow (Phase 1.5):
    //   1. POST /launch/prepare  → server prepares the launchpad's create
    //                              tx, signs its own half (the mint, and on
    //                              Meteora the curve config), returns
    //                              base64 + short-lived HMAC prepareToken.
    //   2. Wallet signs the tx.  → user reviews + approves in their wallet.
    //   3. POST /launch/submit   → server broadcasts the fully-signed
    //                              tx, persists AgentToken + AgentTreasury.
    setIsCreating(true);
    // Hoisted so the catch can hand the recovery flow the same prepare
    // token if persistence fails after the mint is already on-chain.
    let prepareTokenForRecovery: string | null = null;
    try {
      const parsedBuy = Number(initialBuySol);
      const prepared = await tokenApi.prepareLaunch({
        agentId: selectedListing.agentId,
        name: tokenName,
        symbol: tokenSymbol,
        description: tokenDescription || tokenName,
        imageUri: selectedListing.iconUrl ?? undefined,
        // On Meteora the first buy is made on the token's page: the server
        // refuses a launch that carries one.
        initialBuySol:
          !isMeteora && initialBuySol && parsedBuy > 0 ? parsedBuy : undefined,
        preset: selectedPreset?.id,
      });
      prepareTokenForRecovery = prepared.prepareToken;

      // The wallet adds its signature. wallet.signTransaction preserves
      // existing signatures (the slots the server already filled) and only
      // signs the creator slot matching the wallet's pubkey.
      const signedTxBase64 = await signPreparedTransaction(
        signTransaction,
        prepared.partialSignedTxBase64,
      );

      const result = await tokenApi.submitLaunch({
        prepareToken: prepared.prepareToken,
        signedTxBase64,
      });

      toast.success("Token created");
      setLaunched({
        tokenId: result.tokenId,
        mintAddress: result.mintAddress,
        txSignature: result.txSignature,
      });
      setIsCreating(false);
    } catch (err: any) {
      // The mint broadcast but the server couldn't persist it. The token
      // exists on-chain — switch to the recovery panel instead of dropping
      // the user with a toast they can't act on.
      if (
        err?.data?.error === "persistence_failed" &&
        prepareTokenForRecovery &&
        err?.data?.mintAddress &&
        err?.data?.txSignature
      ) {
        setRecovery({
          mintAddress: err.data.mintAddress,
          txSignature: err.data.txSignature,
          prepareToken: prepareTokenForRecovery,
        });
        setIsCreating(false);
        return;
      }
      toast.error(getErrorMessage(err, "Failed to create token"));
      setIsCreating(false);
    }
  };

  const handleRetryReconcile = async () => {
    if (!recovery) return;
    setIsRetrying(true);
    try {
      const result = await tokenApi.reconcileLaunch({
        prepareToken: recovery.prepareToken,
        mintAddress: recovery.mintAddress,
        txSignature: recovery.txSignature,
      });
      toast.success("Token linked");
      router.push(`/dashboard/marketplace/tokens/${result.tokenId}`);
    } catch (err: any) {
      toast.error(
        getErrorMessage(err, "The retry failed. Try again, or contact support.")
      );
      setIsRetrying(false);
    }
  };

  const canProceed = (): boolean => {
    switch (step) {
      case 1:
        return !!selectedListingId && !!selectedEligibility?.eligible;
      case 2:
        return (
          tokenName.length >= 2 &&
          tokenSymbol.length >= 2 &&
          !missingIcon &&
          (presets.length === 0 || selectedPreset !== null)
        );
      case 3:
        return true;
      case 4:
        return connected && !!publicKey;
      default:
        return false;
    }
  };

  // Why "Next" cannot be pressed, in one sentence.
  const nextBlockedReason = (): string | null => {
    if (canProceed()) return null;
    if (step === 1) {
      if (!selectedListingId) return "Choose an agent first.";
      if (checkingEligibility) return "Checking whether this agent can launch a token.";
      return "This agent cannot launch a token yet. The reasons are listed under it.";
    }
    if (step === 2) {
      if (missingIcon) return "This agent needs an icon before it can launch a token.";
      if (tokenName.length < 2) return "Give the token a name of at least 2 characters.";
      if (tokenSymbol.length < 2) return "Give the token a symbol of at least 2 characters.";
      return "Choose a curve first.";
    }
    return null;
  };

  const stepLabels = ["Select Agent", "Token Details", "Review", "Confirm"];

  return (
    <div className="flex flex-col">
      <Header
        title="Create Agent Token"
        description={`Launch a token for your AI agent on the ${launchpadName} bonding curve`}
      />

      <div className="p-8 max-w-3xl mx-auto w-full space-y-6">
        {launched ? (
          <Card data-testid="token-launched">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Check className="h-5 w-5 text-green-600" />
                Token launched
              </CardTitle>
              <CardDescription>
                {tokenName} (${tokenSymbol}) is on {launchpadName}
                {launchpad?.network === "devnet" ? ", on Solana's devnet" : ""}.
                {isMeteora
                  ? " The first buy is made on the token's page."
                  : ""}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-lg border p-4 space-y-3 text-sm">
                <div>
                  <p className="text-muted-foreground">Mint</p>
                  <p className="break-all font-mono text-xs">{launched.mintAddress}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Transaction</p>
                  <p className="break-all font-mono text-xs">{launched.txSignature}</p>
                </div>
              </div>
              <Link
                href={`/dashboard/marketplace/tokens/${launched.tokenId}`}
                className={cn(buttonVariants(), "w-full")}
              >
                <ArrowRight className="mr-2 h-4 w-4" />
                Go to the token&apos;s page
              </Link>
              {/* The explorer needs the network. Without the launchpad call it is not known, so no link is made up. */}
              {launchpad && (
                <a
                  href={explorerTxUrl(launched.txSignature, launchpad.network)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center gap-1 text-sm text-primary underline-offset-4 hover:underline"
                >
                  View the transaction on Solana&apos;s explorer
                  <ExternalLink className="h-3 w-3" aria-hidden />
                </a>
              )}
            </CardContent>
          </Card>
        ) : recovery ? (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Check className="h-5 w-5 text-green-600" />
                Token launched, one step left
              </CardTitle>
              <CardDescription>
                Your token was created on chain, but it could not be linked to
                your dashboard. Nothing is lost. Retry to finish linking.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-lg border p-4 space-y-2 text-sm">
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground shrink-0">Mint</span>
                  <a
                    href={
                      launchpad
                        ? explorerAddressUrl(recovery.mintAddress, launchpad.network)
                        : `https://solscan.io/token/${recovery.mintAddress}`
                    }
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-xs truncate text-primary hover:underline"
                  >
                    {recovery.mintAddress}
                  </a>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground shrink-0">
                    Transaction
                  </span>
                  <a
                    href={
                      launchpad
                        ? explorerTxUrl(recovery.txSignature, launchpad.network)
                        : `https://solscan.io/tx/${recovery.txSignature}`
                    }
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-xs truncate text-primary hover:underline"
                  >
                    {recovery.txSignature}
                  </a>
                </div>
              </div>
              <Button
                className="w-full"
                onClick={handleRetryReconcile}
                disabled={isRetrying}
              >
                {isRetrying ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <ArrowRight className="mr-2 h-4 w-4" />
                )}
                {isRetrying ? "Linking" : "Retry linking"}
              </Button>
              <p className="text-xs text-muted-foreground text-center">
                Still failing? Your token is safe at the mint above. Contact
                support with this address.
              </p>
            </CardContent>
          </Card>
        ) : (
        <>
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
                <div className="space-y-3" aria-busy="true">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="rounded-lg border border-border p-4">
                      <div className="space-y-2">
                        <Skeleton className="h-5 w-1/3" />
                        <Skeleton className="h-4 w-2/3" />
                      </div>
                    </div>
                  ))}
                  {/* Last child, so space-y-3 does not push the first row down. */}
                  <span className="sr-only">Loading your listings</span>
                </div>
              ) : loadError !== null ? (
                <ErrorState
                  title="Couldn't load your listings"
                  error={loadError}
                  onRetry={retryLoadListings}
                />
              ) : listings.length === 0 ? (
                <EmptyState
                  icon={Coins}
                  title="No published listings"
                  description="You need at least one published marketplace listing to create a token."
                  actionLabel="Publish an Agent"
                  actionHref="/dashboard/marketplace/publish"
                />
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
                            : "border-border hover:border-primary/40"
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
              {missingIcon && (
                <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-600">
                  This agent has no icon image. Add an icon to its marketplace
                  listing before launching a token: a token needs a picture.
                </div>
              )}
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
                    setTokenSymbol(e.target.value.toUpperCase().slice(0, 10))
                  }
                  placeholder="TKNS"
                  maxLength={10}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  2-10 uppercase characters
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">
                  Description (optional)
                </label>
                <Textarea
                  value={tokenDescription}
                  onChange={(e) => setTokenDescription(e.target.value)}
                  placeholder="Describe your agent token..."
                  maxLength={500}
                />
              </div>
              {isMeteora ? (
                <p className="text-sm text-muted-foreground">
                  The first buy is made on the token&apos;s page after launch.
                </p>
              ) : (
                <div>
                  <label className="block text-sm font-medium mb-1">
                    Initial buy (optional)
                  </label>
                  <Input
                    type="number"
                    min={0}
                    step="0.01"
                    inputMode="decimal"
                    value={initialBuySol}
                    onChange={(e) => setInitialBuySol(e.target.value)}
                    placeholder="0"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Seed the bonding curve with your own SOL (spent from your
                    connected wallet). Leave blank to skip.
                  </p>
                </div>
              )}
              {presets.length > 0 && (
                <div>
                  <p className="block text-sm font-medium mb-1" id="curve-choice-label">
                    Curve
                  </p>
                  <p className="text-xs text-muted-foreground mb-3">
                    The curve sets how the price rises as people buy, what
                    trading costs and what you earn. It cannot be changed
                    after launch. {GRADUATION_EXPLANATION}
                  </p>
                  <div
                    className="space-y-3"
                    role="radiogroup"
                    aria-labelledby="curve-choice-label"
                  >
                    {presets.map((preset) => (
                      <CurvePresetCard
                        key={preset.id}
                        preset={preset}
                        selected={preset.id === presetId}
                        onSelect={() => setPresetId(preset.id)}
                      />
                    ))}
                  </div>
                </div>
              )}
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

              {selectedPreset ? (
                <div className="space-y-2">
                  <h4 className="text-sm font-medium">
                    Curve: {selectedPreset.name}
                  </h4>
                  <div className="rounded-lg border p-4 space-y-2 text-sm">
                    <p>{selectedPreset.summary}</p>
                    <ul className="space-y-1 text-muted-foreground">
                      {presetFacts(selectedPreset).map((fact) => (
                        <li key={fact}>{fact}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              ) : (
                !isMeteora && (
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
                )
              )}

              {gate && (
                <div className="space-y-2">
                  <h4 className="text-sm font-medium">Anti-Scam Requirements</h4>
                  <div className="rounded-lg border p-4 space-y-2">
                    {[
                      `Creator reputation score >= ${gate.minReputation}`,
                      `Agent uptime >= ${gate.minDeploymentAgeDays} days`,
                      // On Meteora what is locked is the curve's own, named above.
                      ...(isMeteora
                        ? []
                        : [`Creator lockup period: ${gate.creatorLockupDays} days`]),
                    ].map((req) => (
                      <div key={req} className="flex items-center gap-2 text-sm">
                        <Check className="h-4 w-4 text-green-600 shrink-0" />
                        {req}
                      </div>
                    ))}
                  </div>
                </div>
              )}
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
                Connect your wallet and create the token on {launchpadName}
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
                      <span>{launchpadName} bonding curve</span>
                    </div>
                    {selectedPreset && (
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Curve</span>
                        <span>{selectedPreset.name}</span>
                      </div>
                    )}
                  </div>

                  {isMeteora ? (
                    <div className="p-3 bg-muted rounded-lg text-sm text-muted-foreground">
                      Your wallet signs one transaction. It creates the token
                      and its curve, and your wallet pays Solana&apos;s fees
                      for it. WheelsAI never holds your wallet&apos;s key.
                    </div>
                  ) : (
                    gate && (
                      <div className="p-3 bg-yellow-500/10 border border-yellow-500/20 rounded-lg text-sm text-yellow-500">
                        By creating this token, you agree to the{" "}
                        {gate.creatorLockupDays}-day creator lockup period.
                        Your tokens will be locked and cannot be sold for{" "}
                        {gate.creatorLockupDays} days after creation.
                      </div>
                    )
                  )}

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
                    {isCreating ? "Creating the token" : "Create token"}
                  </Button>
                </>
              )}
            </CardContent>
          </Card>
        )}

        {/* Navigation */}
        {step < 4 && nextBlockedReason() && (
          <p className="text-right text-xs text-muted-foreground">{nextBlockedReason()}</p>
        )}
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
        </>
        )}
      </div>
    </div>
  );
}
