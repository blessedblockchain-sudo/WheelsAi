"use client";

import { useEffect, useState } from "react";
import { Check, ChevronsUpDown, Building2 } from "lucide-react";
import { toast } from "sonner";

import { authApi, getErrorMessage } from "@/lib/api";

type Org = { id: string; name: string; role: string; current: boolean };

/**
 * Current organization, and a switcher when the user belongs to more than
 * one (their own plus any team they accepted an invite to).
 */
export function OrgSwitcher() {
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);

  useEffect(() => {
    authApi
      .listOrgs()
      .then((res) => setOrgs(res.organizations))
      .catch(() => undefined);
  }, []);

  const current = orgs.find((o) => o.current);
  if (!current) return null;

  async function switchTo(org: Org) {
    if (org.current) {
      setOpen(false);
      return;
    }
    setSwitching(org.id);
    try {
      await authApi.switchOrg(org.id);
      // Every page's data is org-scoped: reload into the new organization.
      window.location.assign("/dashboard");
    } catch (err) {
      toast.error(getErrorMessage(err, "Could not switch organization"));
      setSwitching(null);
    }
  }

  const multiple = orgs.length > 1;

  return (
    <div className="relative border-b border-border px-3 py-3">
      <button
        type="button"
        onClick={() => multiple && setOpen((v) => !v)}
        aria-haspopup={multiple ? "listbox" : undefined}
        aria-expanded={multiple ? open : undefined}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted disabled:cursor-default"
        disabled={!multiple}
      >
        <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-foreground">{current.name}</span>
          <span className="block text-xs capitalize text-muted-foreground">{current.role}</span>
        </span>
        {multiple && <ChevronsUpDown className="h-4 w-4 text-muted-foreground" aria-hidden />}
      </button>
      {open && (
        <ul
          role="listbox"
          aria-label="Organizations"
          className="absolute left-3 right-3 z-20 mt-1 rounded-md border border-border bg-popover p-1 shadow-lg"
        >
          {orgs.map((org) => (
            <li key={org.id}>
              <button
                type="button"
                role="option"
                aria-selected={org.current}
                onClick={() => switchTo(org)}
                disabled={switching !== null}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
              >
                <span className="min-w-0 flex-1 truncate text-foreground">{org.name}</span>
                <span className="text-xs capitalize text-muted-foreground">{org.role}</span>
                {org.current && <Check className="h-4 w-4 text-primary" aria-hidden />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
