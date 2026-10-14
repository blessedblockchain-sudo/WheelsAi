"use client";

import type { ConfirmOptions } from "@/components/ui/confirm-dialog";
import { deploymentsApi, type DeploymentDependents } from "@/lib/api";
import { stopWarning, type StopWarning } from "@/lib/listing-pause";

/**
 * The body of the dialog at Stop. The dialog draws it inside one paragraph,
 * which is also what a screen reader reads as the dialog's description, so
 * each line is a span of its own.
 */
function StopWarningBody({ warning }: { warning: StopWarning }) {
  return (
    <>
      <span className="block">{warning.lead}</span>
      {warning.names.length > 0 && (
        <span className="mt-2 block break-words font-medium text-foreground">{warning.names.join(", ")}</span>
      )}
      {warning.onSale && <span className="mt-2 block break-words">{warning.onSale}</span>}
      {/* The workflows on sale that need the deployment, after everything about agents. */}
      {warning.workflows && <span className="mt-2 block break-words">{warning.workflows}</span>}
    </>
  );
}

/**
 * Asked before a deployment is stopped: reads the agents that answer from it
 * and the workflows on sale that need it and, when there are some, asks in
 * the app's own dialog. Resolves true when the stop should go ahead. With
 * neither nothing is asked. When they cannot be read the dialog still opens
 * and says so. Never throws.
 */
export async function confirmStopDeployment(
  deploymentId: string,
  confirm: (options: ConfirmOptions) => Promise<boolean>,
): Promise<boolean> {
  let dependents: DeploymentDependents | null;
  try {
    dependents = await deploymentsApi.dependents(deploymentId);
  } catch {
    dependents = null;
  }
  const warning = stopWarning(dependents);
  if (!warning) return true;
  return confirm({
    title: warning.title,
    description: <StopWarningBody warning={warning} />,
    confirmLabel: warning.confirmLabel,
    cancelLabel: warning.cancelLabel,
    destructive: true,
  });
}
