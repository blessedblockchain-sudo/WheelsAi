"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Lightweight tooltip — no positioning library. Shows on hover and on
 * keyboard focus, hides on blur / mouse leave / Escape. The trigger gets
 * `aria-describedby` pointing at the tooltip, which stays in the DOM (just
 * visually hidden) so assistive tech can read it at any time.
 *
 *   <Tooltip content="Copy address">
 *     <button aria-label="Copy"><Copy className="h-4 w-4" /></button>
 *   </Tooltip>
 *
 * The child must be a single element that accepts ref-less event props
 * (a DOM element or a component that forwards them, e.g. <Button>).
 * For supplementary text only — never put essential content in a tooltip.
 */

type Side = "top" | "bottom" | "left" | "right";

export interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactElement;
  side?: Side;
  /** Hover delay before showing, in ms. Focus shows immediately. */
  delay?: number;
  className?: string;
  /** Wrapper element classes (it is `relative inline-flex`). */
  wrapperClassName?: string;
}

const sideClasses: Record<Side, string> = {
  top: "bottom-full left-1/2 mb-2 -translate-x-1/2",
  bottom: "top-full left-1/2 mt-2 -translate-x-1/2",
  left: "right-full top-1/2 mr-2 -translate-y-1/2",
  right: "left-full top-1/2 ml-2 -translate-y-1/2",
};

type TriggerProps = {
  "aria-describedby"?: string;
  onMouseEnter?: React.MouseEventHandler;
  onMouseLeave?: React.MouseEventHandler;
  onFocus?: React.FocusEventHandler;
  onBlur?: React.FocusEventHandler;
  onKeyDown?: React.KeyboardEventHandler;
};

export function Tooltip({
  content,
  children,
  side = "top",
  delay = 100,
  className,
  wrapperClassName,
}: TooltipProps) {
  const [open, setOpen] = React.useState(false);
  const id = React.useId();
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const show = (immediate = false) => {
    clear();
    if (immediate || delay <= 0) setOpen(true);
    else timer.current = setTimeout(() => setOpen(true), delay);
  };
  const hide = () => {
    clear();
    setOpen(false);
  };

  React.useEffect(() => clear, []);

  const child = React.Children.only(children) as React.ReactElement<TriggerProps>;
  const childProps = child.props;
  const describedBy = [childProps["aria-describedby"], id].filter(Boolean).join(" ");

  const trigger = React.cloneElement(child, {
    "aria-describedby": describedBy,
    onMouseEnter: (e: React.MouseEvent) => {
      childProps.onMouseEnter?.(e);
      show();
    },
    onMouseLeave: (e: React.MouseEvent) => {
      childProps.onMouseLeave?.(e);
      hide();
    },
    onFocus: (e: React.FocusEvent) => {
      childProps.onFocus?.(e);
      show(true);
    },
    onBlur: (e: React.FocusEvent) => {
      childProps.onBlur?.(e);
      hide();
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      childProps.onKeyDown?.(e);
      if (e.key === "Escape") hide();
    },
  });

  return (
    <span className={cn("relative inline-flex", wrapperClassName)}>
      {trigger}
      <span
        role="tooltip"
        id={id}
        className={cn(
          "pointer-events-none absolute z-50 w-max max-w-xs rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md",
          "transition-opacity duration-100",
          sideClasses[side],
          open ? "visible opacity-100" : "invisible opacity-0",
          className
        )}
      >
        {content}
      </span>
    </span>
  );
}
