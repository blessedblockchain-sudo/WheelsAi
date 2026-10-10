import Link from "next/link";

import { cn } from "@/lib/utils";
import type { PanelAction, PanelNotice } from "./transport";

const ACTION_CLASS =
  "rounded font-medium text-foreground underline underline-offset-4 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** The one thing to do about a refusal: a link to follow, or a button to press. */
export function PanelActionLink({ action, className }: { action: PanelAction; className?: string }) {
  if (action.href) {
    return (
      <Link href={action.href} className={cn(ACTION_CLASS, className)}>
        {action.label}
      </Link>
    );
  }
  return (
    <button type="button" onClick={action.run} className={cn(ACTION_CLASS, className)}>
      {action.label}
    </button>
  );
}

/** A refusal where it happened: the sentence and, when there is one, what the visitor can do about it. */
export function PanelNoticeView({ notice, className }: { notice: PanelNotice; className?: string }) {
  return (
    <p role="alert" className={cn("rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger", className)}>
      {notice.message}
      {notice.action && (
        <>
          {" "}
          <PanelActionLink action={notice.action} />
        </>
      )}
    </p>
  );
}
