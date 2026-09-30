import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** Content width, shared by PageHero and PageBody so their edges line up. */
export type PageWidth = "3xl" | "4xl" | "5xl" | "6xl";

const widthClass: Record<PageWidth, string> = {
  "3xl": "max-w-3xl",
  "4xl": "max-w-4xl",
  "5xl": "max-w-5xl",
  "6xl": "max-w-6xl",
};

interface PageHeroProps {
  width?: PageWidth;
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
}

/**
 * Top band of every marketing page. It is always navy, in both themes: the
 * landing navbar is transparent white-on-navy until scrolled, so the band
 * keeps it legible, and the page body below uses the semantic tokens.
 */
export function PageHero({ width = "5xl", eyebrow, title, description, children, className }: PageHeroProps) {
  return (
    <section
      className={cn("relative overflow-hidden bg-navy-950 pb-14 pt-32 sm:pb-16 sm:pt-36", className)}
    >
      <div className="grid-bg-navy pointer-events-none absolute inset-0" aria-hidden="true" />
      <div
        className="pointer-events-none absolute -top-40 left-1/2 h-80 w-[48rem] -translate-x-1/2 rounded-full bg-navy-400/10 blur-3xl"
        aria-hidden="true"
      />
      <div className={cn("relative mx-auto px-4 sm:px-6 lg:px-8", widthClass[width])}>
        {eyebrow && <p className="text-sm font-medium uppercase tracking-wider text-navy-300">{eyebrow}</p>}
        <h1 className="mt-3 text-4xl font-semibold tracking-tight text-white sm:text-5xl">{title}</h1>
        {description && (
          <p className="mt-4 max-w-2xl text-lg leading-relaxed text-navy-200/80">{description}</p>
        )}
        {children}
      </div>
    </section>
  );
}

/** Standard width + padding for the body of a marketing page. */
export function PageBody({
  width = "5xl",
  children,
  className,
}: {
  width?: PageWidth;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mx-auto px-4 py-12 sm:px-6 sm:py-16 lg:px-8", widthClass[width], className)}>
      {children}
    </div>
  );
}
