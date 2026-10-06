"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { useConfirm } from "@/components/ui/confirm-dialog";
import { ErrorState } from "@/components/ui/error-state";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkflowResources } from "@/components/dashboard/workflows/use-workflow-resources";
import { WorkflowEditor } from "@/components/dashboard/workflows/workflow-editor";

const LIST = "/dashboard/orchestrations";

export default function NewWorkflowPage() {
  const router = useRouter();
  const confirmAction = useConfirm();
  const { resources, error, reload } = useWorkflowResources();
  const [dirty, setDirty] = useState(false);

  async function leave() {
    if (
      dirty &&
      !(await confirmAction({
        title: "Leave without creating this workflow?",
        description: "The steps you have added are not saved yet.",
        confirmLabel: "Leave",
        cancelLabel: "Keep editing",
        destructive: true,
      }))
    ) {
      return;
    }
    router.push(LIST);
  }

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="New workflow"
        description="Add steps, drag from one step's handle onto another to make it wait, and select a step to choose what it runs."
        breadcrumbs={[
          {
            label: (
              <button type="button" onClick={leave} className="hover:text-foreground">
                Workflows
              </button>
            ),
          },
          { label: "New workflow" },
        ]}
      />

      {error !== null ? (
        <ErrorState title="Couldn't load your agents, deployments and knowledge bases" error={error} onRetry={reload} />
      ) : resources === null ? (
        <div className="space-y-4" aria-busy="true">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-[34rem] w-full" />
          <span className="sr-only">Loading the editor</span>
        </div>
      ) : (
        <WorkflowEditor
          workflow={null}
          resources={resources}
          onDirtyChange={setDirty}
          onSaved={(saved) => router.replace(`${LIST}/${saved.id}`)}
        />
      )}
    </div>
  );
}
