"use client";

import * as React from "react";
import { toast } from "sonner";
import { AlertTriangle } from "lucide-react";

import { cn } from "@/lib/utils";
import { getErrorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/**
 * Confirmation dialog for destructive / irreversible actions.
 *
 * Declarative, with a trigger:
 *
 *   <ConfirmDialog
 *     title="Delete agent?"
 *     description="This stops every deployment and cannot be undone."
 *     confirmLabel="Delete"
 *     destructive
 *     onConfirm={() => agentsApi.delete(id)}
 *   >
 *     <Button variant="destructive">Delete</Button>
 *   </ConfirmDialog>
 *
 * Controlled: pass `open` / `onOpenChange` and omit `children`.
 *
 * Imperative (inside <ConfirmProvider>, mounted by the dashboard layout):
 *
 *   const confirm = useConfirm();
 *   if (await confirm({ title: "Revoke key?", destructive: true })) { … }
 *
 * `onConfirm` may be async: the confirm button shows a spinner and the dialog
 * stays open until it settles. If it throws, the error is toasted and the
 * dialog stays open so the user can retry or cancel.
 */

export interface ConfirmDialogProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void | Promise<void>;
  /** Called when the user dismisses (Cancel, Escape, overlay, close button). */
  onCancel?: () => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Optional trigger element; clicking it opens the dialog. */
  children?: React.ReactElement;
  className?: string;
}

export function ConfirmDialog({
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
  onCancel,
  open: controlledOpen,
  onOpenChange,
  children,
  className,
}: ConfirmDialogProps) {
  const [internalOpen, setInternalOpen] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;
  const titleId = React.useId();
  const descriptionId = React.useId();

  const setOpen = React.useCallback(
    (next: boolean) => {
      if (!isControlled) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [isControlled, onOpenChange]
  );

  // Dismissal paths (Escape, overlay, close button, Cancel) all land here.
  // Ignore them while the action is in flight so it can't be orphaned.
  const handleOpenChange = (next: boolean) => {
    if (!next && isLoading) return;
    if (!next) onCancel?.();
    setOpen(next);
  };

  async function handleConfirm() {
    setIsLoading(true);
    try {
      await onConfirm();
      setOpen(false);
    } catch (err) {
      toast.error(getErrorMessage(err, "Action failed"));
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {children && <DialogTrigger asChild>{children}</DialogTrigger>}
      <DialogContent
        role="alertdialog"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        hideClose={isLoading}
        className={cn("max-w-md", className)}
      >
        <DialogHeader className="pr-6">
          <div className="flex items-start gap-3">
            {destructive && (
              <span
                aria-hidden="true"
                className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive"
              >
                <AlertTriangle className="h-4 w-4" />
              </span>
            )}
            <div className="space-y-1.5">
              <DialogTitle id={titleId}>{title}</DialogTitle>
              {description && (
                <DialogDescription id={descriptionId}>{description}</DialogDescription>
              )}
            </div>
          </div>
        </DialogHeader>
        <DialogFooter className="mt-6 gap-2 sm:space-x-0">
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={isLoading}
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={destructive ? "destructive" : "default"}
            onClick={handleConfirm}
            isLoading={isLoading}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Imperative API
// ---------------------------------------------------------------------------

export interface ConfirmOptions {
  title: React.ReactNode;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = React.createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [options, setOptions] = React.useState<ConfirmOptions | null>(null);
  const resolverRef = React.useRef<((value: boolean) => void) | null>(null);

  // Resolve exactly once per confirm() call.
  const settle = React.useCallback((value: boolean) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    resolve?.(value);
  }, []);

  const confirm = React.useCallback<ConfirmFn>(
    (next) => {
      // A second confirm() while one is open cancels the first.
      settle(false);
      return new Promise<boolean>((resolve) => {
        resolverRef.current = resolve;
        setOptions(next);
      });
    },
    [settle]
  );

  // Never leave a caller awaiting forever if the provider unmounts.
  React.useEffect(() => () => settle(false), [settle]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {options && (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              settle(false);
              setOptions(null);
            }
          }}
          title={options.title}
          description={options.description}
          confirmLabel={options.confirmLabel}
          cancelLabel={options.cancelLabel}
          destructive={options.destructive}
          onConfirm={() => {
            // Resolve before the dialog closes itself (which would
            // otherwise settle as "cancelled").
            settle(true);
          }}
        />
      )}
    </ConfirmContext.Provider>
  );
}

/**
 * `const confirm = useConfirm();` then `await confirm({ title, … })` →
 * `true` if the user confirmed, `false` if they dismissed.
 */
export function useConfirm(): ConfirmFn {
  const ctx = React.useContext(ConfirmContext);
  if (!ctx) {
    throw new Error("useConfirm() must be used inside <ConfirmProvider>");
  }
  return ctx;
}
