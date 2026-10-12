"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Save } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { settingsApi, type OrganizationSettings } from "@/lib/api";
import {
  ORGANIZATION_CARD_ID,
  ORGANIZATION_RENAMED_EVENT,
  ORGANIZATION_WORDS,
  nameChangeLimitLine,
  organizationNameField,
  organizationRenamedToast,
  retryAtOf,
  type OrganizationRenamed,
} from "@/lib/organization-name";
import { cn } from "@/lib/utils";
import { apiRefusal } from "@/lib/wallet-topup";

/**
 * The organization's name on the Account page. An owner or admin can change
 * it; everyone else reads it. It loads by itself, so a failure here leaves
 * the rest of the page as it is.
 */
export function OrganizationCard({ className }: { className?: string }) {
  const id = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const [organization, setOrganization] = useState<OrganizationSettings | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [typed, setTyped] = useState("");
  const [used, setUsed] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await settingsApi.organization();
      if (!mounted.current) return;
      setOrganization(res.organization);
      setTyped(res.organization.name);
      setUsed(false);
    } catch (err) {
      if (mounted.current) setLoadError(err);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  // A link to #organization arrives before this card is drawn: bring it into view now.
  useEffect(() => {
    if (window.location.hash === `#${ORGANIZATION_CARD_ID}`) cardRef.current?.scrollIntoView({ block: "start" });
  }, []);

  const field = organizationNameField(typed, organization?.name ?? "", used);
  const canRename = organization?.canRename === true;
  const problem = refusal ?? field.error;

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!organization || !canRename || saving || !field.canSave) return;
    setSaving(true);
    setRefusal(null);
    try {
      const res = await settingsApi.renameOrganization(field.name);
      if (!mounted.current) return;
      setOrganization(res.organization);
      setTyped(res.organization.name);
      setUsed(false);
      // Sent whether or not this save changed it: the name may have been changed elsewhere, and the
      // sidebar keeps its list when the name is the one it already shows.
      const detail: OrganizationRenamed = { id: res.organization.id, name: res.organization.name };
      window.dispatchEvent(new CustomEvent(ORGANIZATION_RENAMED_EVENT, { detail }));
      if (res.changed) toast.success(organizationRenamedToast(res.organization.name, res.organization.sells));
    } catch (err) {
      if (!mounted.current) return;
      // The API's own sentence, as it came. The limit of changes is said with this reader's clock.
      const refused = apiRefusal(err);
      const limit = refused?.code === "name_change_limit" ? nameChangeLimitLine(retryAtOf(err)) : null;
      setRefusal(limit ?? refused?.message ?? ORGANIZATION_WORDS.saveFailed);
      // No longer an owner or admin: read the card again, so the field stops offering a change.
      if (refused?.status === 403) void load();
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  return (
    <Card ref={cardRef} id={ORGANIZATION_CARD_ID} className={cn("min-w-0 scroll-mt-6", className)}>
      <CardHeader>
        <CardTitle>{ORGANIZATION_WORDS.title}</CardTitle>
      </CardHeader>
      <CardContent>
        {loadError !== null && !organization ? (
          <ErrorState title={ORGANIZATION_WORDS.loadFailed} error={loadError} onRetry={() => void load()} />
        ) : !organization ? (
          <div className="space-y-6" aria-busy="true">
            <span className="sr-only">Loading your organization</span>
            <div className="space-y-2">
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-4 w-80 max-w-full" />
            </div>
            <div className="flex justify-end">
              <Skeleton className="h-10 w-32" />
            </div>
          </div>
        ) : (
          <form onSubmit={save} className="space-y-6" noValidate>
            <div className="min-w-0">
              <label className="block text-sm font-medium text-foreground" htmlFor={`${id}-name`}>
                {ORGANIZATION_WORDS.label}
              </label>
              <Input
                id={`${id}-name`}
                value={typed}
                onChange={(event) => {
                  setTyped(event.target.value);
                  setUsed(true);
                  setRefusal(null);
                }}
                readOnly={!canRename || saving}
                autoComplete="organization"
                aria-describedby={`${id}-name-hint`}
                aria-invalid={problem ? true : undefined}
                className="mt-1"
              />
              <p
                id={`${id}-name-hint`}
                role={problem ? "alert" : undefined}
                className={cn("mt-1 break-words text-sm", problem ? "text-danger" : "text-muted-foreground")}
              >
                {problem ?? (canRename ? ORGANIZATION_WORDS.hint : ORGANIZATION_WORDS.readOnly)}
              </p>
            </div>

            {canRename && (
              <div className="flex justify-end">
                <Button type="submit" isLoading={saving} disabled={!field.canSave}>
                  {!saving && <Save className="mr-2 h-4 w-4" aria-hidden="true" />}
                  {saving ? ORGANIZATION_WORDS.saving : ORGANIZATION_WORDS.save}
                </Button>
              </div>
            )}
          </form>
        )}
      </CardContent>
    </Card>
  );
}
