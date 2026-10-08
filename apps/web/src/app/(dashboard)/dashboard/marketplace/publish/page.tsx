"use client";

import { useEffect, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Bot,
  FileText,
  DollarSign,
  Eye,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";

import { Header } from "@/components/dashboard/header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
} from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import { EmptyState } from "@/components/ui/empty-state";
import { agentsApi, marketplaceApi, type Agent, type CreateListingInput, getErrorMessage } from "@/lib/api";
import { LIST_AGENT_BUTTON, NEW_AGENT_BUTTON } from "@/lib/nav";
import { cn } from "@/lib/utils";

const STEPS = [
  { id: "agent", label: "Select Agent", icon: Bot },
  { id: "details", label: "Listing Details", icon: FileText },
  { id: "pricing", label: "Pricing", icon: DollarSign },
  { id: "preview", label: "Preview", icon: Eye },
];

const CATEGORIES = [
  { value: "customer-support", label: "Customer Support" },
  { value: "coding", label: "Coding & Development" },
  { value: "research", label: "Research & Analysis" },
  { value: "automation", label: "Workflow Automation" },
  { value: "creative", label: "Content & Creative" },
  { value: "other", label: "Other" },
];

/** Placeholder shaped like the agent options in the first step. */
function AgentOptionsSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 rounded-lg border p-4">
          <Skeleton className="h-4 w-4 shrink-0 rounded-full" />
          <Skeleton className="h-10 w-10 shrink-0 rounded-lg" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-5 w-40 max-w-full" />
            <Skeleton className="h-4 w-64 max-w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Placeholder shaped like the progress steps and the first wizard step. */
function WizardSkeleton() {
  return (
    <>
      <div className="mb-8 flex items-center justify-center">
        {STEPS.map((step, index) => (
          <div key={step.id} className="flex min-w-0 items-center">
            <Skeleton className="h-9 w-12 rounded-full sm:w-36" />
            {index < STEPS.length - 1 && (
              <Skeleton className="mx-2 h-0.5 w-8 sm:w-16" />
            )}
          </div>
        ))}
      </div>
      <Card className="mx-auto max-w-2xl">
        <CardContent className="p-6">
          <div className="space-y-6">
            <div className="space-y-2">
              <Skeleton className="h-6 w-40" />
              <Skeleton className="h-4 w-72 max-w-full" />
            </div>
            <AgentOptionsSkeleton />
          </div>
          <div className="mt-8 flex items-center justify-between">
            <Skeleton className="h-10 w-24" />
            <Skeleton className="h-10 w-24" />
          </div>
        </CardContent>
      </Card>
    </>
  );
}

export default function PublishWizardPage() {
  return (
    <Suspense
      fallback={
        <div className="flex flex-col">
          <div className="flex items-center justify-between border-b border-border bg-card px-8 py-4">
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-8 w-64 max-w-full" />
              <Skeleton className="h-4 w-80 max-w-full" />
            </div>
            <Skeleton className="h-9 w-9" />
          </div>
          <div className="p-8">
            <WizardSkeleton />
          </div>
        </div>
      }
    >
      <PublishWizardContent />
    </Suspense>
  );
}

function PublishWizardContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const editId = searchParams.get("edit");

  const [currentStep, setCurrentStep] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [isLoadingAgents, setIsLoadingAgents] = useState(true);
  const [agentsError, setAgentsError] = useState<unknown>(null);
  const [isLoadingListing, setIsLoadingListing] = useState(!!editId);
  const [listingLoadError, setListingLoadError] = useState<unknown>(null);

  // Form state
  const [formData, setFormData] = useState<CreateListingInput>({
    agentId: "",
    title: "",
    shortDescription: "",
    longDescription: "",
    category: "other",
    pricingModel: "free",
    pricePerRequestCents: undefined,
    monthlyPriceCents: undefined,
  });

  // Load agents on mount
  useEffect(() => {
    loadAgents();
  }, []);

  async function loadAgents() {
    setIsLoadingAgents(true);
    setAgentsError(null);
    try {
      const { agents } = await agentsApi.list();
      setAgents(agents);
    } catch (error) {
      setAgentsError(error);
      toast.error(getErrorMessage(error, "Failed to load agents"));
    } finally {
      setIsLoadingAgents(false);
    }
  }

  // Load existing listing if editing
  useEffect(() => {
    if (editId) {
      loadListing(editId);
    }
  }, [editId]);

  async function loadListing(id: string) {
    setIsLoadingListing(true);
    setListingLoadError(null);
    try {
      const { listing } = await marketplaceApi.getListing(id);
      setFormData({
        agentId: listing.agentId,
        title: listing.title,
        shortDescription: listing.shortDescription,
        longDescription: listing.longDescription || "",
        category: listing.category as any,
        pricingModel: listing.pricingModel,
        pricePerRequestCents: listing.pricePerRequestCents || undefined,
        monthlyPriceCents: listing.monthlyPriceCents || undefined,
      });
    } catch (error) {
      setListingLoadError(error);
      toast.error(getErrorMessage(error, "Failed to load listing"));
    } finally {
      setIsLoadingListing(false);
    }
  }

  function retryListing() {
    if (editId) loadListing(editId);
  }

  const updateForm = (updates: Partial<CreateListingInput>) => {
    setFormData((prev) => ({ ...prev, ...updates }));
  };

  const canProceed = () => {
    switch (currentStep) {
      case 0:
        return !!formData.agentId;
      case 1:
        return (
          formData.title.length >= 3 &&
          formData.shortDescription.length >= 10 &&
          formData.category
        );
      case 2:
        if (formData.pricingModel === "per_request") {
          return (formData.pricePerRequestCents ?? 0) > 0;
        }
        if (formData.pricingModel === "monthly") {
          return (formData.monthlyPriceCents ?? 0) > 0;
        }
        return true;
      case 3:
        return true;
      default:
        return false;
    }
  };

  const handleNext = () => {
    if (currentStep < STEPS.length - 1) {
      setCurrentStep((prev) => prev + 1);
    }
  };

  const handleBack = () => {
    if (currentStep > 0) {
      setCurrentStep((prev) => prev - 1);
    }
  };

  const handleSubmit = async (publish: boolean) => {
    setIsLoading(true);
    try {
      if (editId) {
        // Update existing listing
        const { listing } = await marketplaceApi.updateListing(editId, {
          title: formData.title,
          shortDescription: formData.shortDescription,
          longDescription: formData.longDescription,
          category: formData.category,
          pricingModel: formData.pricingModel,
          pricePerRequestCents: formData.pricePerRequestCents,
          monthlyPriceCents: formData.monthlyPriceCents,
        });

        if (publish) {
          await marketplaceApi.publishListing(listing.id);
          toast.success("Listing updated and published!");
        } else {
          toast.success("Listing updated!");
        }
      } else {
        // Create new listing
        const { listing } = await marketplaceApi.createListing(formData);

        if (publish) {
          await marketplaceApi.publishListing(listing.id);
          toast.success("Agent published to marketplace!");
        } else {
          toast.success("Listing saved as draft");
        }
      }

      router.push("/dashboard/marketplace");
    } catch (error: any) {
      toast.error(getErrorMessage(error, "Failed to save listing"));
    } finally {
      setIsLoading(false);
    }
  };

  const selectedAgent = agents.find((a) => a.id === formData.agentId);

  const header = (
    <Header
      title={editId ? "Edit Listing" : LIST_AGENT_BUTTON.label}
      description="Share your agent with the WheelsAI community"
    />
  );

  // When editing, the wizard stays hidden until the listing has loaded, so it
  // never shows blank fields in place of the listing's own.
  if (editId && (listingLoadError !== null || isLoadingListing)) {
    return (
      <div className="flex flex-col">
        {header}

        <div className="p-8">
          {listingLoadError !== null ? (
            <ErrorState
              title="Couldn't load listing"
              error={listingLoadError}
              onRetry={retryListing}
            />
          ) : (
            <WizardSkeleton />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {header}

      <div className="p-8">
        {/* Progress Steps */}
        <div className="mb-8">
          <div className="flex items-center justify-center">
            {STEPS.map((step, index) => (
              <div key={step.id} className="flex items-center">
                <div
                  className={cn(
                    "flex items-center gap-2 rounded-full px-4 py-2",
                    index === currentStep
                      ? "bg-primary/15 text-primary-700"
                      : index < currentStep
                        ? "bg-green-500/10 text-green-500"
                        : "bg-muted text-muted-foreground"
                  )}
                >
                  {index < currentStep ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    <step.icon className="h-4 w-4" />
                  )}
                  <span className="hidden text-sm font-medium sm:inline">
                    {step.label}
                  </span>
                </div>
                {index < STEPS.length - 1 && (
                  <div
                    className={cn(
                      "mx-2 h-0.5 w-8 sm:w-16",
                      index < currentStep ? "bg-green-300" : "bg-muted"
                    )}
                  />
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Step Content */}
        <Card className="mx-auto max-w-2xl">
          <CardContent className="p-6">
            {/* Step 1: Select Agent */}
            {currentStep === 0 && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-lg font-semibold">Select an Agent</h2>
                  <p className="text-sm text-muted-foreground">
                    Choose which agent you want to publish to the marketplace
                  </p>
                </div>

                {isLoadingAgents ? (
                  <AgentOptionsSkeleton />
                ) : agentsError !== null ? (
                  <ErrorState
                    title="Couldn't load agents"
                    error={agentsError}
                    onRetry={loadAgents}
                  />
                ) : agents.length === 0 ? (
                  <EmptyState
                    icon={Bot}
                    title="No agents found"
                    description="Create an agent first before publishing to the marketplace."
                    actionLabel={NEW_AGENT_BUTTON.label}
                    actionHref={NEW_AGENT_BUTTON.href}
                  />
                ) : (
                  <RadioGroup
                    value={formData.agentId}
                    onValueChange={(value) => updateForm({ agentId: value })}
                    className="space-y-3"
                  >
                    {agents.map((agent) => (
                      <div
                        key={agent.id}
                        className={cn(
                          "flex cursor-pointer items-center gap-4 rounded-lg border p-4 transition-colors",
                          formData.agentId === agent.id
                            ? "border-primary-500 bg-primary/10"
                            : "hover:bg-muted"
                        )}
                        onClick={() => updateForm({ agentId: agent.id })}
                      >
                        <RadioGroupItem value={agent.id} id={agent.id} />
                        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                          <Bot className="h-5 w-5 text-muted-foreground" />
                        </div>
                        <div className="flex-1">
                          <label
                            htmlFor={agent.id}
                            className="cursor-pointer font-medium text-foreground"
                          >
                            {agent.name}
                          </label>
                          <p className="text-sm text-muted-foreground">
                            {agent.framework} &middot; {agent.description || "No description"}
                          </p>
                        </div>
                      </div>
                    ))}
                  </RadioGroup>
                )}
              </div>
            )}

            {/* Step 2: Listing Details */}
            {currentStep === 1 && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-lg font-semibold">Listing Details</h2>
                  <p className="text-sm text-muted-foreground">
                    Provide information to help users discover your agent
                  </p>
                </div>

                <div className="space-y-4">
                  <div>
                    <Label htmlFor="title">Title *</Label>
                    <Input
                      id="title"
                      value={formData.title}
                      onChange={(e) => updateForm({ title: e.target.value })}
                      placeholder="e.g., Customer Support Bot"
                      className="mt-1"
                      maxLength={100}
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                      {formData.title.length}/100 characters
                    </p>
                  </div>

                  <div>
                    <Label htmlFor="shortDescription">Short Description *</Label>
                    <Textarea
                      id="shortDescription"
                      value={formData.shortDescription}
                      onChange={(e) =>
                        updateForm({ shortDescription: e.target.value })
                      }
                      placeholder="A brief description of what your agent does"
                      className="mt-1"
                      rows={2}
                      maxLength={280}
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                      {formData.shortDescription.length}/280 characters
                    </p>
                  </div>

                  <div>
                    <Label htmlFor="longDescription">Full Description</Label>
                    <Textarea
                      id="longDescription"
                      value={formData.longDescription}
                      onChange={(e) =>
                        updateForm({ longDescription: e.target.value })
                      }
                      placeholder="Provide a detailed description of your agent's capabilities, use cases, and features"
                      className="mt-1"
                      rows={5}
                    />
                  </div>

                  <div>
                    <Label htmlFor="category">Category *</Label>
                    <Select
                      id="category"
                      value={formData.category}
                      onChange={(e) =>
                        updateForm({ category: e.target.value as CreateListingInput["category"] })
                      }
                      className="mt-1"
                    >
                      {CATEGORIES.map((cat) => (
                        <option key={cat.value} value={cat.value}>
                          {cat.label}
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>
              </div>
            )}

            {/* Step 3: Pricing */}
            {currentStep === 2 && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-lg font-semibold">Pricing</h2>
                  <p className="text-sm text-muted-foreground">
                    Choose how you want to monetize your agent. You'll earn 90%
                    of all revenue.
                  </p>
                </div>

                <RadioGroup
                  value={formData.pricingModel}
                  onValueChange={(value: string) =>
                    updateForm({
                      pricingModel: value as CreateListingInput["pricingModel"],
                      pricePerRequestCents: undefined,
                      monthlyPriceCents: undefined,
                    })
                  }
                  className="space-y-3"
                >
                  <div
                    className={cn(
                      "flex cursor-pointer items-start gap-4 rounded-lg border p-4 transition-colors",
                      formData.pricingModel === "free"
                        ? "border-primary-500 bg-primary/10"
                        : "hover:bg-muted"
                    )}
                    onClick={() =>
                      updateForm({
                        pricingModel: "free",
                        pricePerRequestCents: undefined,
                        monthlyPriceCents: undefined,
                      })
                    }
                  >
                    <RadioGroupItem value="free" id="free" className="mt-1" />
                    <div>
                      <label
                        htmlFor="free"
                        className="cursor-pointer font-medium text-foreground"
                      >
                        Free
                      </label>
                      <p className="text-sm text-muted-foreground">
                        Anyone can use your agent for free. Great for building reputation.
                      </p>
                    </div>
                  </div>

                  <div
                    className={cn(
                      "rounded-lg border p-4 transition-colors",
                      formData.pricingModel === "per_request"
                        ? "border-primary-500 bg-primary/10"
                        : "hover:bg-muted"
                    )}
                  >
                    <div
                      className="flex cursor-pointer items-start gap-4"
                      onClick={() => updateForm({ pricingModel: "per_request" })}
                    >
                      <RadioGroupItem
                        value="per_request"
                        id="per_request"
                        className="mt-1"
                      />
                      <div className="flex-1">
                        <label
                          htmlFor="per_request"
                          className="cursor-pointer font-medium text-foreground"
                        >
                          Pay per Request
                        </label>
                        <p className="text-sm text-muted-foreground">
                          Users pay for each request. Best for usage-based billing.
                        </p>
                      </div>
                    </div>
                    {formData.pricingModel === "per_request" && (
                      <div className="ml-8 mt-4">
                        <Label htmlFor="perRequestPrice">Price per Request</Label>
                        <div className="mt-1 flex items-center gap-2">
                          <span className="text-muted-foreground">$</span>
                          <Input
                            id="perRequestPrice"
                            type="number"
                            step="0.0001"
                            min="0.0001"
                            max="1000"
                            value={
                              formData.pricePerRequestCents
                                ? formData.pricePerRequestCents / 100
                                : ""
                            }
                            onChange={(e) =>
                              updateForm({
                                pricePerRequestCents: Math.round(
                                  parseFloat(e.target.value || "0") * 100
                                ),
                              })
                            }
                            placeholder="0.01"
                            className="w-32"
                          />
                          <span className="text-sm text-muted-foreground">per request</span>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          You'll earn $
                          {(
                            ((formData.pricePerRequestCents || 0) / 100) *
                            0.9
                          ).toFixed(4)}{" "}
                          per request (90%)
                        </p>
                      </div>
                    )}
                  </div>

                  <div
                    className={cn(
                      "rounded-lg border p-4 transition-colors",
                      formData.pricingModel === "monthly"
                        ? "border-primary-500 bg-primary/10"
                        : "hover:bg-muted"
                    )}
                  >
                    <div
                      className="flex cursor-pointer items-start gap-4"
                      onClick={() => updateForm({ pricingModel: "monthly" })}
                    >
                      <RadioGroupItem
                        value="monthly"
                        id="monthly"
                        className="mt-1"
                      />
                      <div className="flex-1">
                        <label
                          htmlFor="monthly"
                          className="cursor-pointer font-medium text-foreground"
                        >
                          Monthly Subscription
                        </label>
                        <p className="text-sm text-muted-foreground">
                          Users pay a fixed monthly fee. Best for predictable revenue.
                        </p>
                      </div>
                    </div>
                    {formData.pricingModel === "monthly" && (
                      <div className="ml-8 mt-4">
                        <Label htmlFor="monthlyPrice">Monthly Price</Label>
                        <div className="mt-1 flex items-center gap-2">
                          <span className="text-muted-foreground">$</span>
                          <Input
                            id="monthlyPrice"
                            type="number"
                            step="1"
                            min="1"
                            max="100000"
                            value={
                              formData.monthlyPriceCents
                                ? formData.monthlyPriceCents / 100
                                : ""
                            }
                            onChange={(e) =>
                              updateForm({
                                monthlyPriceCents: Math.round(
                                  parseFloat(e.target.value || "0") * 100
                                ),
                              })
                            }
                            placeholder="9.99"
                            className="w-32"
                          />
                          <span className="text-sm text-muted-foreground">per month</span>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          You'll earn $
                          {(
                            ((formData.monthlyPriceCents || 0) / 100) *
                            0.9
                          ).toFixed(2)}{" "}
                          per subscriber (90%)
                        </p>
                      </div>
                    )}
                  </div>

                  <div
                    className={cn(
                      "flex cursor-pointer items-start gap-4 rounded-lg border p-4 transition-colors",
                      formData.pricingModel === "tokenized"
                        ? "border-primary-500 bg-primary/10"
                        : "hover:bg-muted"
                    )}
                    onClick={() =>
                      updateForm({
                        pricingModel: "tokenized",
                        pricePerRequestCents: undefined,
                        monthlyPriceCents: undefined,
                      })
                    }
                  >
                    <RadioGroupItem value="tokenized" id="tokenized" className="mt-1" />
                    <div>
                      <label
                        htmlFor="tokenized"
                        className="cursor-pointer font-medium text-foreground"
                      >
                        Token Gated
                      </label>
                      <p className="text-sm text-muted-foreground">
                        Buyers need at least 1 of your agent&apos;s token, held in a
                        wallet linked to their organization. Until you launch the
                        token, the listing is free to install and run.
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        You can launch the token on pump.fun once the agent
                        qualifies: reputation score &ge; 50 and 7 days of uptime.
                      </p>
                    </div>
                  </div>
                </RadioGroup>
              </div>
            )}

            {/* Step 4: Preview */}
            {currentStep === 3 && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-lg font-semibold">Preview & Publish</h2>
                  <p className="text-sm text-muted-foreground">
                    Review your listing before publishing
                  </p>
                </div>

                <div className="rounded-lg border bg-muted p-6">
                  <div className="flex items-start gap-4">
                    <div className="flex h-16 w-16 items-center justify-center rounded-xl bg-gradient-to-br from-primary/15 to-primary/25">
                      <Bot className="h-8 w-8 text-primary-600" />
                    </div>
                    <div>
                      <h3 className="text-xl font-bold text-foreground">
                        {formData.title || "Untitled"}
                      </h3>
                      <p className="text-muted-foreground">
                        by Your Organization &middot;{" "}
                        {selectedAgent?.framework || "custom"}
                      </p>
                    </div>
                  </div>

                  <p className="mt-4 text-foreground">
                    {formData.shortDescription || "No description"}
                  </p>

                  <div className="mt-4 flex flex-wrap gap-2">
                    <span className="rounded-full bg-card px-3 py-1 text-sm text-muted-foreground">
                      {CATEGORIES.find((c) => c.value === formData.category)?.label}
                    </span>
                    <span
                      className={cn(
                        "rounded-full px-3 py-1 text-sm font-medium",
                        formData.pricingModel === "free"
                          ? "bg-green-500/10 text-green-500"
                          : "bg-primary/15 text-primary-700"
                      )}
                    >
                      {formData.pricingModel === "free"
                        ? "Free"
                        : formData.pricingModel === "tokenized"
                          ? "Token Gated"
                          : formData.pricingModel === "per_request"
                            ? `$${((formData.pricePerRequestCents || 0) / 100).toFixed(4)}/req`
                            : `$${((formData.monthlyPriceCents || 0) / 100).toFixed(2)}/mo`}
                    </span>
                  </div>
                </div>

                <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-4">
                  <p className="text-sm text-yellow-500">
                    <strong>Note:</strong> Once published, your agent will be
                    visible to all WheelsAI users. You can always update or
                    archive your listing later.
                  </p>
                </div>
              </div>
            )}

            {/* Navigation */}
            <div className="mt-8 flex items-center justify-between">
              <Button
                variant="outline"
                onClick={handleBack}
                disabled={currentStep === 0}
              >
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back
              </Button>

              <div className="flex gap-3">
                {currentStep === STEPS.length - 1 ? (
                  <>
                    <Button
                      variant="outline"
                      onClick={() => handleSubmit(false)}
                      disabled={isLoading}
                    >
                      {isLoading ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : null}
                      Save as Draft
                    </Button>
                    <Button onClick={() => handleSubmit(true)} disabled={isLoading}>
                      {isLoading ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <Check className="mr-2 h-4 w-4" />
                      )}
                      Publish Now
                    </Button>
                  </>
                ) : (
                  <Button onClick={handleNext} disabled={!canProceed()}>
                    Next
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
