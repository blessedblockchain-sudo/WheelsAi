"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Activity, AlertCircle, Clock, Loader2, Square, Zap } from "lucide-react";

interface OpenClawStatusProps {
  status: string;
  healthStatus?: string | null;
  className?: string;
}

const statusConfig: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline"; icon: typeof Activity; color: string }> = {
  PENDING: { label: "Pending", variant: "secondary", icon: Clock, color: "text-gray-500" },
  BUILDING: { label: "Building", variant: "outline", icon: Loader2, color: "text-blue-500" },
  DEPLOYING: { label: "Deploying", variant: "outline", icon: Loader2, color: "text-blue-500" },
  RUNNING: { label: "Running", variant: "default", icon: Activity, color: "text-green-500" },
  STOPPED: { label: "Stopped", variant: "secondary", icon: Square, color: "text-gray-500" },
  FAILED: { label: "Failed", variant: "destructive", icon: AlertCircle, color: "text-red-500" },
};

const healthConfig: Record<string, { label: string; color: string }> = {
  healthy: { label: "Healthy", color: "bg-green-500" },
  degraded: { label: "Degraded", color: "bg-yellow-500" },
  down: { label: "Down", color: "bg-red-500" },
};

export function OpenClawStatus({ status, healthStatus, className }: OpenClawStatusProps) {
  const config = statusConfig[status] || statusConfig.PENDING;
  const Icon = config.icon;
  const isAnimated = status === "BUILDING" || status === "DEPLOYING";

  return (
    <div className={cn("flex items-center gap-2", className)}>
      {healthStatus && status === "RUNNING" && (
        <div className="flex items-center gap-1.5">
          <div className={cn("w-2 h-2 rounded-full", healthConfig[healthStatus]?.color || "bg-gray-400")} />
          <span className="text-xs text-muted-foreground">
            {healthConfig[healthStatus]?.label || healthStatus}
          </span>
        </div>
      )}
      <Badge variant={config.variant} className="flex items-center gap-1">
        <Icon className={cn("h-3 w-3", config.color, isAnimated && "animate-spin")} />
        {config.label}
      </Badge>
    </div>
  );
}
