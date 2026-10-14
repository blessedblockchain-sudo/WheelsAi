"use client";

import { useCallback, useEffect, useRef, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Bot,
  FileText,
  DollarSign,
  Eye,
} from "lucide-react";
import { toast } from "sonner";

import { Header } from "@/components/dashboard/header";
import { readPageKey, saveKeepCopy } from "@/components/dashboard/sell/page-key";
import { WhoCanUse } from "@/components/dashboard/sell/who-can-use";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
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
import {
  agentsApi,
  capabilitiesApi,
  marketplaceApi,
  type Agent,
  type AgentDetail,
  type Capabilities,
  type AgentListingOf,
  type OwnedMarketplaceListing,
  getErrorMessage,
  isAgentListing,
  getValidationError,
} from "@/lib/api";
import { LIST_AGENT_BUTTON, NEW_AGENT_BUTTON } from "@/lib/nav";
import { workflowEditHref } from "@/lib/workflow-sell";
import { LIST_AGENT_PARAM, agentToListFirst, codeOf, listingStatus } from "@/lib/agent-page";
import {
  LISTED_AGENT_BADGE,
  LISTED_AGENT_NOTE,
  WIZARD_STEPS,
  agentRows,
  createListingBody,
  detailsOfListing,
  editListingHref,
  emptyDetails,
  pickAgent,
  previewSellsLine,
  stepProblem,
  submitButtons,
  updateListingBody,
  type ListingCategory,
  type ListingDetails,
  type SubmitButton,
} from "@/lib/listing-draft";
import {
  asksForPayment,
  buildSellSave,
  earningsLine,
  emptySellForm,
  formOfListing,
  salePriceText,
  sellChoices,
  sellFieldErrors,
  sellLimitsOf,
  type SellErrors,
  type SellForm,
} from "@/lib/sell-choice";
import {
  PLANS_RELOAD_WORDS,
  emptyPlansForm,
  hasPlanErrors,
  noPlanErrors,
  planFieldErrors,
  planLimitsOf,
  plansFormOf,
  plansRefusedLine,
  plansReloadOffered,
  plansSaveOf,
  savedPlansOf,
  type PlanErrors,
  type PlansForm,
  type SavedPlan,
} from "@/lib/sell-plans";
import { cn } from "@/lib/utils";

const STEPS = [
  { id: "agent", label: "Select Agent", icon: Bot },
  { id: "details", label: "Listing Details", icon: FileText },
  { id: "pricing", label: "Who can use it?", icon: DollarSign },
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


interface WizardData {
  agents: Agent[];
  /**
   * The organization's own listings of an agent, with who holds what: they mark the agents that are
   * listed. A workflow's listing is not one of them: this wizard lists agents.
   */
  listings: AgentListingOf<OwnedMarketplaceListing>[];
  /**
   * Every listing of the organization, a workflow's too: only to know where an edit of a workflow's
   * listing goes (its workflow's API tab), never to fill the wizard.
   */
  ownListings: OwnedMarketplaceListing[];
  /** null when it could not be read: the step then names no limit it does not know. */
  capabilities: Capabilities | null;
}

function PublishWizardContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const editId = searchParams.get("edit");
  // "List this agent" on an agent's page: the wizard starts with that agent chosen.
  const agentParam = searchParams.get(LIST_AGENT_PARAM);

  const [currentStep, setCurrentStep] = useState(0);
  const [isSaving, setIsSaving] = useState<SubmitButton["id"] | null>(null);
  const [data, setData] = useState<WizardData | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);

  // Form state
  const [details, setDetails] = useState<ListingDetails>(() => emptyDetails());
  const [sell, setSell] = useState<SellForm>(() => emptySellForm());
  const [sellErrors, setSellErrors] = useState<SellErrors>({});
  const [keepCopy, setKeepCopy] = useState(false);
  // The plans under "Pay per use", as typed, and what the API said of them when it refused.
  const [plans, setPlans] = useState<PlansForm>(() => emptyPlansForm());
  // The plans those rows were made from; a new listing has none. A save ends only a plan that is among them,
  // so a plan that a later read brought, and that has no row here, is never named as ended.
  const [plansRead, setPlansRead] = useState<SavedPlan[] | null>([]);
  const [planErrors, setPlanErrors] = useState<PlanErrors>(noPlanErrors);
  const [plansProblem, setPlansProblem] = useState<string | null>(null);
  // The listing whose plans were refused because they changed somewhere else: a way to read them again is offered beside the sentence.
  const [plansStaleFor, setPlansStaleFor] = useState<string | null>(null);
  const [isReloadingPlans, setIsReloadingPlans] = useState(false);

  // The chosen agent with its tools, which the list of agents does not carry.
  const [agentDetail, setAgentDetail] = useState<AgentDetail | null>(null);
  const [agentDetailError, setAgentDetailError] = useState<unknown>(null);
  const [agentDetailAttempt, setAgentDetailAttempt] = useState(0);

  /** Which listing, or new listing, the form was last filled for. */
  const filledFor = useRef<string | null>(null);
  /** A new listing that was saved here while its plans were refused: the wizard is turning into an edit of it. */
  const adopted = useRef<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [{ agents }, { listings }, capabilities] = await Promise.all([
        agentsApi.list(),
        marketplaceApi.getMyListings(),
        capabilitiesApi.get().catch(() => null),
      ]);
      setData({ agents, listings: listings.filter(isAgentListing), ownListings: listings, capabilities });
    } catch (error) {
      setLoadError(error);
      toast.error(getErrorMessage(error, "Failed to load agents"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const agents = data?.agents ?? [];
  const listings = data?.listings ?? [];
  const editing = editId && data ? (listings.find((listing) => listing.id === editId) ?? null) : null;
  // A workflow's listing is edited on its workflow's API tab: the wizard opened on one goes there and loads no agent.
  const ownListing = editId && data ? (data.ownListings.find((listing) => listing.id === editId) ?? null) : null;
  const workflowEdit = ownListing ? workflowEditHref(ownListing) : null;
  const editMissing = Boolean(editId) && data !== null && editing === null && workflowEdit === null;

  useEffect(() => {
    if (workflowEdit) router.replace(workflowEdit);
  }, [workflowEdit, router]);

  // Fill the form once for each listing that is opened, and empty it when an edit is left for a new listing.
  useEffect(() => {
    if (!data) return;
    const key = editId ? `edit:${editId}` : "new";
    if (adopted.current) {
      // The form is already this listing's, with the plans as they were typed: it is not filled again.
      if (editId !== adopted.current) return;
      adopted.current = null;
      filledFor.current = key;
      return;
    }
    if (filledFor.current === key) return;
    if (editId) {
      if (!editing) return;
      const kind = editing.agent?.agentKind ?? data.agents.find((agent) => agent.id === editing.agentId)?.agentKind;
      setDetails(detailsOfListing(editing));
      setSell(formOfListing(editing, kind));
      setPlans(plansFormOf(editing));
      setPlansRead(savedPlansOf(editing));
    } else if (filledFor.current !== null) {
      setDetails(emptyDetails());
      setSell(emptySellForm());
      setPlans(emptyPlansForm());
      setPlansRead([]);
    }
    setSellErrors({});
    setPlanErrors(noPlanErrors());
    setPlansProblem(null);
    setPlansStaleFor(null);
    setCurrentStep(0);
    filledFor.current = key;
  }, [data, editId, editing]);

  // `?agent=`: once the person's agents are known, and only while none is chosen yet. An agent that
  // already has a listing opens that listing instead: an agent has one.
  useEffect(() => {
    if (!data || editId) return;
    const first = agentToListFirst(agentParam, data.agents, false);
    if (!first) return;
    const pick = pickAgent(first, data.listings, null);
    if (pick.kind === "go") {
      router.replace(pick.href);
      return;
    }
    setDetails((prev) => (prev.agentId ? prev : { ...prev, agentId: first }));
  }, [agentParam, data, editId, router]);

  // The chosen agent's tools and whether its page keeps a copy of what people send.
  const agentId = details.agentId;
  useEffect(() => {
    if (!agentId) return;
    let current = true;
    setAgentDetailError(null);
    Promise.all([agentsApi.get(agentId), readPageKey(agentId).catch(() => null)])
      .then(([{ agent }, pageKey]) => {
        if (!current) return;
        setAgentDetail(agent);
        setKeepCopy(pageKey?.storeTranscripts ?? false);
        // A choice this kind of agent does not have falls back to Free.
        setSell((prev) =>
          prev.sells === "use" && !sellChoices(agent.agentKind).some((choice) => choice.id === prev.choice && choice.selectable)
            ? { ...prev, choice: "free" }
            : prev,
        );
      })
      .catch((error) => {
        if (current) setAgentDetailError(error);
      });
    return () => {
      current = false;
    };
  }, [agentId, agentDetailAttempt]);

  const chosenAgent = agentDetail && agentDetail.id === agentId ? agentDetail : null;
  const limits = sellLimitsOf(data?.capabilities);
  const planLimits = planLimitsOf(data?.capabilities);
  // The plans of the listing being edited, as they were last read; a new listing has none. The block shows
  // these. What a save is measured against is `plansRead`, the plans the rows were made from.
  const savedPlans = savedPlansOf(editId ? (editing ?? {}) : null);
  const selectedAgent = agents.find((a) => a.id === agentId);
  const agentKind = chosenAgent?.agentKind ?? selectedAgent?.agentKind;

  const updateForm = (updates: Partial<ListingDetails>) => {
    setDetails((prev) => ({ ...prev, ...updates }));
  };

  function chooseAgent(id: string) {
    const pick = pickAgent(id, listings, editId);
    if (pick.kind === "go") router.replace(pick.href);
    else updateForm({ agentId: id });
  }

  const step = WIZARD_STEPS[currentStep] ?? "agent";
  const problem = stepProblem(step, {
    details,
    sell,
    agent: chosenAgent,
    limits,
    plans: { form: plans, saved: plansRead, limits: planLimits },
  });

  const handleNext = () => {
    if (!problem && currentStep < STEPS.length - 1) {
      setCurrentStep((prev) => prev + 1);
    }
  };

  const handleBack = () => {
    if (currentStep > 0) {
      setCurrentStep((prev) => prev - 1);
    }
  };

  const built = chosenAgent ? buildSellSave(sell, chosenAgent, limits) : null;

  const handleSubmit = async (button: SubmitButton) => {
    if (!chosenAgent || !built) return;
    if (!built.ok) {
      setSellErrors(built.errors);
      setCurrentStep(2);
      return;
    }
    // The plans are checked before anything is saved, so a row that cannot be sent holds the listing back too.
    const plansSave = plansSaveOf({ sell, form: plans, saved: plansRead, limits: planLimits });
    if (plansSave.kind === "invalid") {
      setPlanErrors(plansSave.errors);
      setCurrentStep(2);
      return;
    }
    setPlansProblem(null);
    setPlansStaleFor(null);
    setIsSaving(button.id);
    let listingId: string;
    try {
      const saved = editId
        ? await marketplaceApi.updateListing(editId, updateListingBody(details, built.save, button.publish))
        : // What the listing sells is named: use of the agent, unless copies were chosen under More options.
          await marketplaceApi.createListing(createListingBody(details, built.save, button.publish));
      listingId = saved.listing.id;
    } catch (error) {
      const fields = getValidationError(error)?.fields;
      const fieldErrors = fields ? sellFieldErrors(fields) : {};
      if (Object.keys(fieldErrors).length > 0) {
        setSellErrors(fieldErrors);
        setCurrentStep(2);
      }
      toast.error(getErrorMessage(error, "Failed to save listing"));
      setIsSaving(null);
      return;
    }

    // The listing is saved. Its plans go second and always as the whole set, with the ids of the plans that were ended here.
    if (plansSave.kind === "send") {
      try {
        await marketplaceApi.setListingPlans(listingId, plansSave.plans, plansSave.ended);
      } catch (error) {
        const fields = getValidationError(error)?.fields;
        const fieldErrors = fields ? planFieldErrors(fields) : noPlanErrors();
        setPlanErrors(fieldErrors);
        // Each sentence is under its field; a refusal with none is said whole, as the API sent it.
        setPlansProblem(plansRefusedLine(hasPlanErrors(fieldErrors) ? null : getErrorMessage(error, "Try again.")));
        setPlansStaleFor(plansReloadOffered(codeOf(error)) ? listingId : null);
        // The listing exists now, so the wizard goes on as an edit of it, with the rows as they were typed.
        if (!editId) adopted.current = listingId;
        await load();
        if (!editId) router.replace(editListingHref(listingId));
        setCurrentStep(2);
        setIsSaving(null);
        return;
      }
    }

    toast.success(button.done);
    // The copy setting lives on the agent's page, which the agent has once it is on sale.
    if (asksForPayment(sell)) {
      try {
        const kept = await saveKeepCopy(agentId, keepCopy);
        if (kept === "no_page" && keepCopy) {
          toast.message("Keeping a copy is set once the agent is on sale. Turn it on from the agent's Sell tab then.");
        }
      } catch (error) {
        toast.error(`The setting to keep a copy was not saved: ${getErrorMessage(error, "Try again from the agent's Sell tab.")}`);
      }
    }
    router.push("/dashboard/marketplace");
  };

  // After a save refused because the plans changed somewhere else: the listing is read again and the rows
  // are filled from it, so the next save is measured against the plans as they are.
  const reloadPlans = async () => {
    if (!plansStaleFor || isReloadingPlans) return;
    setIsReloadingPlans(true);
    try {
      const own = (await marketplaceApi.getMyListings()).listings;
      const read = own.filter(isAgentListing);
      const fresh = read.find((listing) => listing.id === plansStaleFor) ?? null;
      setData((prev) => prev && { ...prev, listings: read, ownListings: own });
      setPlans(plansFormOf(fresh));
      setPlansRead(savedPlansOf(fresh));
      setPlanErrors(noPlanErrors());
      setPlansProblem(null);
      setPlansStaleFor(null);
    } catch {
      // Nothing was read: the rows are as they were, and the button stays to try again.
      setPlansProblem(PLANS_RELOAD_WORDS.failed);
    } finally {
      setIsReloadingPlans(false);
    }
  };

  const header = (
    <Header
      title={editId ? "Edit Listing" : LIST_AGENT_BUTTON.label}
      description="Share your agent with the WheelsAI community"
    />
  );

  // When editing, the wizard stays hidden until the listing has loaded, so it
  // never shows blank fields in place of the listing's own. A workflow's listing
  // shows the placeholder while the page moves to the workflow's API tab.
  if (editId && (loadError !== null || data === null || editMissing || workflowEdit !== null)) {
    return (
      <div className="flex flex-col">
        {header}

        <div className="p-8">
          {loadError !== null ? (
            <ErrorState
              title="Couldn't load listing"
              error={loadError}
              onRetry={() => void load()}
            />
          ) : editMissing ? (
            <ErrorState
              title="Couldn't load listing"
              description="This listing was not found among your organization's listings."
              actionLabel={LIST_AGENT_BUTTON.label}
              actionHref={LIST_AGENT_BUTTON.href}
            />
          ) : (
            <WizardSkeleton />
          )}
        </div>
      </div>
    );
  }

  const buttons = submitButtons(editing);
  const price = built?.ok
    ? salePriceText(built.save, agentKind)
    : null;
  const earnings = earningsLine(sell, agentKind, limits);

  return (
    <div className="flex flex-col">
      {header}

      <div className="p-8">
        {/* Progress Steps */}
        <div className="mb-8">
          <ol className="flex items-center justify-center">
            {STEPS.map((step, index) => (
              <li
                key={step.id}
                className="flex items-center"
                aria-current={index === currentStep ? "step" : undefined}
              >
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
                    <Check className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <step.icon className="h-4 w-4" aria-hidden="true" />
                  )}
                  <span className="sr-only sm:not-sr-only sm:text-sm sm:font-medium">
                    {step.label}
                  </span>
                </div>
                {index < STEPS.length - 1 && (
                  <div
                    aria-hidden="true"
                    className={cn(
                      "mx-2 h-0.5 w-8 sm:w-16",
                      index < currentStep ? "bg-green-300" : "bg-muted"
                    )}
                  />
                )}
              </li>
            ))}
          </ol>
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

                {loadError !== null ? (
                  <ErrorState
                    title="Couldn't load agents"
                    error={loadError}
                    onRetry={() => void load()}
                  />
                ) : data === null ? (
                  <AgentOptionsSkeleton />
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
                    value={agentId}
                    onValueChange={chooseAgent}
                    className="space-y-3"
                  >
                    {agentRows(agents, listings).map(({ agent, listing }) => (
                      <div
                        key={agent.id}
                        className={cn(
                          "flex cursor-pointer items-center gap-4 rounded-lg border p-4 transition-colors",
                          agentId === agent.id
                            ? "border-primary-500 bg-primary/10"
                            : "hover:bg-muted"
                        )}
                        onClick={() => chooseAgent(agent.id)}
                      >
                        <RadioGroupItem
                          value={agent.id}
                          id={agent.id}
                          className="shrink-0"
                          aria-describedby={listing ? `${agent.id}-listed` : undefined}
                          onClick={(event) => {
                            // The row's own click chooses; without this the agent would be chosen twice.
                            event.stopPropagation();
                            chooseAgent(agent.id);
                          }}
                        />
                        <div className="hidden h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted sm:flex">
                          <Bot className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <label
                              htmlFor={agent.id}
                              className="min-w-0 cursor-pointer break-words font-medium text-foreground"
                            >
                              {agent.name}
                            </label>
                            {listing && <Badge variant="secondary">{LISTED_AGENT_BADGE}</Badge>}
                          </div>
                          <p className="break-words text-sm text-muted-foreground">
                            {agent.framework} &middot; {agent.description || "No description"}
                          </p>
                          {listing && (
                            <p id={`${agent.id}-listed`} className="mt-1 text-sm text-muted-foreground">
                              {listingStatus(listing.status).label}. {LISTED_AGENT_NOTE}
                            </p>
                          )}
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
                      value={details.title}
                      onChange={(e) => updateForm({ title: e.target.value })}
                      placeholder="e.g., Customer Support Bot"
                      className="mt-1"
                      maxLength={100}
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                      {details.title.length}/100 characters
                    </p>
                  </div>

                  <div>
                    <Label htmlFor="shortDescription">Short Description *</Label>
                    <Textarea
                      id="shortDescription"
                      value={details.shortDescription}
                      onChange={(e) =>
                        updateForm({ shortDescription: e.target.value })
                      }
                      placeholder="A brief description of what your agent does"
                      className="mt-1"
                      rows={2}
                      maxLength={280}
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                      {details.shortDescription.length}/280 characters
                    </p>
                  </div>

                  <div>
                    <Label htmlFor="longDescription">Full Description</Label>
                    <Textarea
                      id="longDescription"
                      value={details.longDescription}
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
                      value={details.category}
                      onChange={(e) =>
                        updateForm({ category: e.target.value as ListingCategory })
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

            {/* Step 3: Who can use it? The same question as on the agent's Sell tab. */}
            {currentStep === 2 &&
              (chosenAgent ? (
                <div className="space-y-5">
                  {/* The listing was saved and its plans were not: said first, above the rows it is about. */}
                  {plansProblem && (
                    <div className="space-y-2">
                      <p role="alert" className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
                        {plansProblem}
                      </p>
                      {plansStaleFor && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => void reloadPlans()}
                          isLoading={isReloadingPlans}
                          disabled={isSaving !== null}
                        >
                          {PLANS_RELOAD_WORDS.button}
                        </Button>
                      )}
                    </div>
                  )}
                  <WhoCanUse
                    agent={chosenAgent}
                    form={sell}
                    onChange={(next) => {
                      setSell(next);
                      setSellErrors({});
                    }}
                    errors={sellErrors}
                    plans={{
                      form: plans,
                      onChange: (next) => {
                        setPlans(next);
                        setPlanErrors(noPlanErrors());
                        setPlansProblem(null);
                      },
                      errors: planErrors,
                      limits: planLimits,
                      saved: savedPlans,
                    }}
                    limits={limits}
                    capacity={data?.capabilities?.paidUse.freeModelDailyAllowance ?? null}
                    keepCopy={{ checked: keepCopy, onChange: setKeepCopy }}
                    listing={editing}
                    disabled={isSaving !== null}
                  />
                </div>
              ) : agentDetailError !== null ? (
                <ErrorState
                  title="Couldn't load this agent"
                  error={agentDetailError}
                  onRetry={() => setAgentDetailAttempt((attempt) => attempt + 1)}
                />
              ) : (
                <div className="space-y-3" aria-busy="true">
                  <span className="sr-only">Loading</span>
                  <Skeleton className="h-6 w-48 max-w-full" />
                  <Skeleton className="h-4 w-full max-w-lg" />
                  <Skeleton className="h-20 w-full" />
                  <Skeleton className="h-20 w-full" />
                  <Skeleton className="h-20 w-full" />
                </div>
              ))}

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
                    <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary/15 to-primary/25">
                      <Bot className="h-8 w-8 text-primary-600" aria-hidden="true" />
                    </div>
                    <div className="min-w-0">
                      <h3 className="break-words text-xl font-bold text-foreground">
                        {details.title || "Untitled"}
                      </h3>
                      <p className="text-muted-foreground">
                        by Your Organization &middot;{" "}
                        {selectedAgent?.framework || "custom"}
                      </p>
                    </div>
                  </div>

                  <p className="mt-4 break-words text-foreground">
                    {details.shortDescription || "No description"}
                  </p>

                  <div className="mt-4 flex flex-wrap gap-2">
                    <span className="rounded-full bg-card px-3 py-1 text-sm text-muted-foreground">
                      {CATEGORIES.find((c) => c.value === details.category)?.label}
                    </span>
                    {price && (
                      <span
                        className={cn(
                          "rounded-full px-3 py-1 text-sm font-medium",
                          price === "Free"
                            ? "bg-green-500/10 text-green-500"
                            : "bg-primary/15 text-primary-700"
                        )}
                      >
                        {price}
                      </span>
                    )}
                  </div>

                  <p className="mt-4 text-sm text-muted-foreground">{previewSellsLine(sell)}</p>
                  {earnings && <p className="mt-1 text-sm text-muted-foreground">{earnings}</p>}
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
            <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
              <Button
                variant="outline"
                onClick={handleBack}
                disabled={currentStep === 0 || isSaving !== null}
              >
                <ArrowLeft className="mr-2 h-4 w-4" aria-hidden="true" />
                Back
              </Button>

              <div className="flex flex-wrap gap-3">
                {currentStep === STEPS.length - 1 ? (
                  buttons.map((button) => (
                    <Button
                      key={button.id}
                      variant={button.primary ? "default" : "outline"}
                      onClick={() => void handleSubmit(button)}
                      isLoading={isSaving === button.id}
                      disabled={isSaving !== null || !built}
                    >
                      {button.primary && isSaving !== button.id && (
                        <Check className="mr-2 h-4 w-4" aria-hidden="true" />
                      )}
                      {button.label}
                    </Button>
                  ))
                ) : (
                  <Button
                    onClick={handleNext}
                    disabled={problem !== null}
                    aria-describedby={problem ? "wizard-next-why" : undefined}
                  >
                    Next
                    <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
                  </Button>
                )}
              </div>
            </div>
            {/* A disabled Next says why. */}
            <p
              id="wizard-next-why"
              role="status"
              className="mt-2 min-h-5 text-right text-sm text-muted-foreground"
            >
              {currentStep < STEPS.length - 1 ? problem : null}
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
