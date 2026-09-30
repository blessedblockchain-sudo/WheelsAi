import type { ReactNode } from "react";
import { AlertTriangle, Info } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Long-form typography for docs, legal pages and blog posts, without the
 * typography plugin: plain semantic HTML inside <Prose> is styled through
 * descendant selectors, using the theme tokens so it reads in both themes.
 */
export function Prose({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "text-[15px] leading-7 text-foreground/80 sm:text-base",
        "[&_h2]:mt-12 [&_h2]:scroll-mt-24 [&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2]:text-foreground",
        "[&_h3]:mt-8 [&_h3]:scroll-mt-24 [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:text-foreground",
        "[&_h4]:mt-6 [&_h4]:font-semibold [&_h4]:text-foreground",
        "[&>h2:first-child]:mt-0 [&>h3:first-child]:mt-0",
        "[&_p]:mt-4",
        "[&_ul]:mt-4 [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-6",
        "[&_ol]:mt-4 [&_ol]:list-decimal [&_ol]:space-y-2 [&_ol]:pl-6",
        "[&_li]:pl-1 [&_li_p]:mt-2",
        "[&_a:not([data-plain])]:font-medium [&_a:not([data-plain])]:text-primary [&_a:not([data-plain])]:underline-offset-4 [&_a:not([data-plain]):hover]:underline",
        "[&_strong]:font-semibold [&_strong]:text-foreground",
        "[&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-muted [&_:not(pre)>code]:px-1.5 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:text-[0.85em] [&_:not(pre)>code]:text-foreground [&_:not(pre)>code]:[overflow-wrap:anywhere]",
        "[&_hr]:my-10 [&_hr]:border-border",
        "[&_blockquote]:mt-4 [&_blockquote]:border-l-2 [&_blockquote]:border-primary/50 [&_blockquote]:pl-4 [&_blockquote]:italic",
        className,
      )}
    >
      {children}
    </div>
  );
}

interface CalloutProps {
  variant?: "note" | "warning";
  title?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** A boxed aside inside prose. `role="note"` so it is announced as such. */
export function Callout({ variant = "note", title, children, className }: CalloutProps) {
  const Icon = variant === "warning" ? AlertTriangle : Info;
  return (
    <div
      role="note"
      className={cn(
        "mt-6 flex gap-3 rounded-lg border px-4 py-3 text-sm leading-6",
        variant === "warning"
          ? "border-yellow-500/30 bg-yellow-500/10"
          : "border-primary/30 bg-primary/5",
        className,
      )}
    >
      <Icon
        className={cn(
          "mt-0.5 h-4 w-4 shrink-0",
          variant === "warning" ? "text-yellow-600 dark:text-yellow-400" : "text-primary",
        )}
        aria-hidden="true"
      />
      <div className="min-w-0 text-foreground/85 [&>p:first-child]:mt-0 [&_p]:mt-2">
        {title && <p className="font-semibold text-foreground">{title}</p>}
        {children}
      </div>
    </div>
  );
}

/**
 * A value only the founder can supply (legal entity, jurisdiction, contact
 * address, team bios, social handles). Rendered as a visible
 * `[FOUNDER: ...]` token so it cannot ship unnoticed.
 */
export function Founder({ children }: { children: ReactNode }) {
  return (
    <mark className="rounded bg-yellow-400/25 px-1 py-0.5 font-mono text-[0.85em] font-medium text-yellow-800 dark:bg-yellow-400/15 dark:text-yellow-300">
      [FOUNDER: {children}]
    </mark>
  );
}

export interface TableColumn {
  key: string;
  label: ReactNode;
  className?: string;
}

/** A responsive, scrollable data table for docs content. */
export function DocTable({
  caption,
  columns,
  rows,
}: {
  caption?: string;
  columns: TableColumn[];
  rows: Array<Record<string, ReactNode>>;
}) {
  return (
    <div className="mt-4 overflow-x-auto rounded-lg border border-border" tabIndex={0} role="region" aria-label={caption ?? "Table"}>
      <table className="w-full min-w-[32rem] border-collapse text-left text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead className="bg-muted/60">
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={cn("px-4 py-2.5 font-semibold text-foreground", c.className)}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-t border-border align-top">
              {columns.map((c) => (
                <td key={c.key} className={cn("px-4 py-2.5 text-foreground/80", c.className)}>
                  {row[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
