"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

import { CodeImport } from "@/components/dashboard/agent-create/code-import";
import { CreateForm } from "@/components/dashboard/agent-create/create-form";
import { Skeleton } from "@/components/ui/skeleton";
import { kindFromParam } from "@/lib/agent-draft";

/**
 * New agent. By default one screen (CreateForm); `?mode=code` is the six
 * steps for an agent that carries code (CodeImport). `?kind=` preselects how
 * people will use it and `?template=` starts from a template.
 */
export default function NewAgentPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto w-full max-w-4xl space-y-4 p-4 sm:p-8">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-96 w-full" />
        </div>
      }
    >
      <NewAgentContent />
    </Suspense>
  );
}

function NewAgentContent() {
  const searchParams = useSearchParams();
  if (searchParams.get("mode") === "code") return <CodeImport />;

  const kind = kindFromParam(searchParams.get("kind"));
  const template = searchParams.get("template");
  // A new key starts the form afresh when the address asks for another starting point.
  return <CreateForm key={`${kind ?? ""}:${template ?? ""}`} initialKind={kind} templateId={template} />;
}
