"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

interface RadioGroupProps {
  children: React.ReactNode;
  value?: string;
  onValueChange?: (value: string) => void;
  className?: string;
}

interface RadioGroupContextValue {
  value?: string;
  onValueChange?: (value: string) => void;
}

const RadioGroupContext = React.createContext<RadioGroupContextValue>({});

function RadioGroup({ children, value, onValueChange, className }: RadioGroupProps) {
  return (
    <RadioGroupContext.Provider value={{ value, onValueChange }}>
      <div role="radiogroup" className={cn("grid gap-2", className)}>
        {children}
      </div>
    </RadioGroupContext.Provider>
  );
}

interface RadioGroupItemProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "value"> {
  value: string;
}

const RadioGroupItem = React.forwardRef<HTMLButtonElement, RadioGroupItemProps>(
  ({ className, value, ...props }, ref) => {
    const ctx = React.useContext(RadioGroupContext);
    const checked = ctx.value === value;
    return (
      <button
        ref={ref}
        type="button"
        role="radio"
        aria-checked={checked}
        className={cn(
          "aspect-square h-4 w-4 rounded-full border border-gray-300 text-primary ring-offset-background focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
          checked && "border-primary",
          className
        )}
        onClick={() => ctx.onValueChange?.(value)}
        {...props}
      >
        {checked && (
          <span className="flex items-center justify-center">
            <span className="h-2.5 w-2.5 rounded-full bg-primary" />
          </span>
        )}
      </button>
    );
  }
);
RadioGroupItem.displayName = "RadioGroupItem";

export { RadioGroup, RadioGroupItem };
