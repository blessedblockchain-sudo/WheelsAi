"use client";

import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/api";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex h-screen items-center justify-center bg-background">
      <div className="text-center">
        <AlertTriangle className="mx-auto h-12 w-12 text-red-500" />
        <h2 className="mt-4 text-xl font-semibold text-foreground">
          Something went wrong
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {getErrorMessage(error, "An unexpected error occurred.")}
        </p>
        <Button onClick={reset} className="mt-6">
          Try Again
        </Button>
      </div>
    </div>
  );
}
