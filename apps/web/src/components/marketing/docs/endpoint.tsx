import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const methodClass: Record<Method, string> = {
  GET: "bg-success/10 text-success",
  POST: "bg-primary/15 text-primary",
  PUT: "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400",
  PATCH: "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400",
  DELETE: "bg-danger/10 text-danger",
};

export function MethodBadge({ method }: { method: Method }) {
  return (
    <span className={cn("inline-flex w-16 shrink-0 justify-center rounded px-1.5 py-0.5 font-mono text-xs font-semibold", methodClass[method])}>
      {method}
    </span>
  );
}

interface EndpointProps {
  id: string;
  method: Method;
  path: string;
  /** "Public", "API key or session", "Session only (owner/admin)", ... */
  auth: string;
  title?: string;
  /** Heading level; h3 under a section h2 (default), h2 when it starts a page section. */
  as?: "h2" | "h3";
  children?: ReactNode;
}

/**
 * One API operation. The heading carries the anchor id, so the "On this
 * page" list and deep links land on it.
 */
export function Endpoint({ id, method, path, auth, title, as: Heading = "h3", children }: EndpointProps) {
  return (
    <section aria-labelledby={id} className="mt-10 scroll-mt-24 rounded-lg border border-border bg-card/50 p-4 sm:p-5">
      <Heading id={id} className="!mt-0 flex scroll-mt-24 flex-wrap items-center gap-2 !text-base !font-semibold !tracking-normal">
        <MethodBadge method={method} />
        <code className="break-all !bg-transparent !p-0 font-mono !text-[0.95em] text-foreground">{path}</code>
      </Heading>
      {title && <p className="!mt-2 font-medium text-foreground">{title}</p>}
      <p className="!mt-2 text-xs text-muted-foreground">
        Auth: <span className="font-medium text-foreground/80">{auth}</span>
      </p>
      <div className="[&>*:first-child]:mt-3">{children}</div>
    </section>
  );
}

export interface Field {
  name: string;
  type: string;
  required?: boolean;
  description: ReactNode;
}

/** Request/response field table. */
export function Fields({ title = "Body", fields }: { title?: string; fields: Field[] }) {
  return (
    <div className="mt-4">
      <p className="text-sm font-semibold text-foreground">{title}</p>
      <div className="mt-2 overflow-x-auto rounded-md border border-border" role="region" aria-label={`${title} fields`} tabIndex={0}>
        <table className="w-full min-w-[30rem] border-collapse text-left text-sm">
          <thead className="bg-muted/60">
            <tr>
              <th scope="col" className="px-3 py-2 font-semibold text-foreground">Field</th>
              <th scope="col" className="px-3 py-2 font-semibold text-foreground">Type</th>
              <th scope="col" className="px-3 py-2 font-semibold text-foreground">Description</th>
            </tr>
          </thead>
          <tbody>
            {fields.map((f) => (
              <tr key={f.name} className="border-t border-border align-top">
                <td className="whitespace-nowrap px-3 py-2">
                  <code className="font-mono text-[0.85em] text-foreground">{f.name}</code>
                  {f.required && <span className="ml-1.5 text-xs font-medium text-danger">required</span>}
                </td>
                <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-muted-foreground">{f.type}</td>
                <td className="px-3 py-2 text-foreground/80">{f.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
