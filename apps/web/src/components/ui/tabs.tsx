"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Accessible tabs (WAI-ARIA "tabs" pattern).
 *
 *   <Tabs defaultValue="overview">            // uncontrolled
 *   <Tabs value={tab} onValueChange={setTab}> // controlled
 *     <TabsList aria-label="Agent sections">
 *       <TabsTrigger value="overview">Overview</TabsTrigger>
 *       <TabsTrigger value="logs">Logs</TabsTrigger>
 *     </TabsList>
 *     <TabsContent value="overview">…</TabsContent>
 *     <TabsContent value="logs">…</TabsContent>
 *   </Tabs>
 *
 * Keyboard: Arrow keys move between tabs (Left/Right, or Up/Down when
 * orientation="vertical"), Home/End jump to the ends. With the default
 * activationMode="automatic" focus also selects; "manual" waits for
 * Enter/Space. Only the selected tab is in the tab order (roving tabindex).
 */

type Orientation = "horizontal" | "vertical";

interface TabsContextValue {
  value: string;
  setValue: (value: string) => void;
  baseId: string;
  orientation: Orientation;
  activationMode: "automatic" | "manual";
}

const TabsContext = React.createContext<TabsContextValue | null>(null);

function useTabsContext(component: string): TabsContextValue {
  const ctx = React.useContext(TabsContext);
  if (!ctx) throw new Error(`<${component}> must be used inside <Tabs>`);
  return ctx;
}

/** DOM-safe id fragment for an arbitrary tab value. */
function idFor(baseId: string, kind: "trigger" | "content", value: string) {
  return `${baseId}-${kind}-${value.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

export interface TabsProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "onChange" | "defaultValue"> {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  orientation?: Orientation;
  activationMode?: "automatic" | "manual";
}

const Tabs = React.forwardRef<HTMLDivElement, TabsProps>(
  (
    {
      value: controlledValue,
      defaultValue = "",
      onValueChange,
      orientation = "horizontal",
      activationMode = "automatic",
      className,
      children,
      ...props
    },
    ref
  ) => {
    const [internalValue, setInternalValue] = React.useState(defaultValue);
    const isControlled = controlledValue !== undefined;
    const value = isControlled ? controlledValue : internalValue;
    const baseId = React.useId();

    const setValue = React.useCallback(
      (next: string) => {
        if (!isControlled) setInternalValue(next);
        onValueChange?.(next);
      },
      [isControlled, onValueChange]
    );

    const ctx = React.useMemo(
      () => ({ value, setValue, baseId, orientation, activationMode }),
      [value, setValue, baseId, orientation, activationMode]
    );

    return (
      <TabsContext.Provider value={ctx}>
        <div
          ref={ref}
          data-orientation={orientation}
          className={cn(orientation === "vertical" && "flex gap-6", className)}
          {...props}
        >
          {children}
        </div>
      </TabsContext.Provider>
    );
  }
);
Tabs.displayName = "Tabs";

const TabsList = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, onKeyDown, ...props }, ref) => {
    const { orientation, activationMode } = useTabsContext("TabsList");
    const listRef = React.useRef<HTMLDivElement | null>(null);

    const setRefs = (node: HTMLDivElement | null) => {
      listRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    };

    function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
      onKeyDown?.(e);
      if (e.defaultPrevented || !listRef.current) return;

      const prevKey = orientation === "vertical" ? "ArrowUp" : "ArrowLeft";
      const nextKey = orientation === "vertical" ? "ArrowDown" : "ArrowRight";
      if (![prevKey, nextKey, "Home", "End"].includes(e.key)) return;

      const tabs = Array.from(
        listRef.current.querySelectorAll<HTMLButtonElement>('[role="tab"]:not([disabled])')
      );
      if (tabs.length === 0) return;
      const current = tabs.indexOf(document.activeElement as HTMLButtonElement);

      let next = current;
      if (e.key === "Home") next = 0;
      else if (e.key === "End") next = tabs.length - 1;
      else if (e.key === nextKey) next = current < 0 ? 0 : (current + 1) % tabs.length;
      else if (e.key === prevKey)
        next = current < 0 ? tabs.length - 1 : (current - 1 + tabs.length) % tabs.length;

      const target = tabs[next];
      if (!target) return;
      e.preventDefault();
      target.focus();
      if (activationMode === "automatic") target.click();
    }

    return (
      <div
        ref={setRefs}
        role="tablist"
        aria-orientation={orientation}
        onKeyDown={handleKeyDown}
        className={cn(
          "flex border-border",
          orientation === "vertical"
            ? "flex-col items-stretch gap-1 border-r pr-2"
            : "items-center gap-1 overflow-x-auto border-b",
          className
        )}
        {...props}
      />
    );
  }
);
TabsList.displayName = "TabsList";

export interface TabsTriggerProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "value"> {
  value: string;
}

const TabsTrigger = React.forwardRef<HTMLButtonElement, TabsTriggerProps>(
  ({ value, className, onClick, disabled, ...props }, ref) => {
    const ctx = useTabsContext("TabsTrigger");
    const selected = ctx.value === value;

    return (
      <button
        ref={ref}
        type="button"
        role="tab"
        id={idFor(ctx.baseId, "trigger", value)}
        aria-selected={selected}
        aria-controls={idFor(ctx.baseId, "content", value)}
        tabIndex={selected ? 0 : -1}
        disabled={disabled}
        data-state={selected ? "active" : "inactive"}
        onClick={(e) => {
          onClick?.(e);
          if (!e.defaultPrevented && !disabled) ctx.setValue(value);
        }}
        className={cn(
          "inline-flex items-center gap-2 whitespace-nowrap px-3 py-2 text-sm font-medium text-muted-foreground transition-colors duration-150",
          "hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          "disabled:pointer-events-none disabled:opacity-50",
          "data-[state=active]:text-foreground",
          ctx.orientation === "vertical"
            ? "justify-start rounded-md data-[state=active]:bg-muted"
            : "-mb-px border-b-2 border-transparent data-[state=active]:border-primary",
          className
        )}
        {...props}
      />
    );
  }
);
TabsTrigger.displayName = "TabsTrigger";

export interface TabsContentProps extends React.HTMLAttributes<HTMLDivElement> {
  value: string;
  /** Keep the panel mounted (hidden) when inactive — preserves its state. */
  forceMount?: boolean;
}

const TabsContent = React.forwardRef<HTMLDivElement, TabsContentProps>(
  ({ value, forceMount = false, className, ...props }, ref) => {
    const ctx = useTabsContext("TabsContent");
    const selected = ctx.value === value;
    if (!selected && !forceMount) return null;

    return (
      <div
        ref={ref}
        role="tabpanel"
        id={idFor(ctx.baseId, "content", value)}
        aria-labelledby={idFor(ctx.baseId, "trigger", value)}
        hidden={!selected}
        tabIndex={0}
        data-state={selected ? "active" : "inactive"}
        className={cn(
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          ctx.orientation === "horizontal" && "mt-4",
          ctx.orientation === "vertical" && "min-w-0 flex-1",
          className
        )}
        {...props}
      />
    );
  }
);
TabsContent.displayName = "TabsContent";

export { Tabs, TabsList, TabsTrigger, TabsContent };
