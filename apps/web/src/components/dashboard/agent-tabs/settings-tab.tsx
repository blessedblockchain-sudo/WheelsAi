"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { agentsApi, getErrorMessage } from "@/lib/api";
import type { AgentTabProps } from "./types";

export function SettingsTab({ agentId }: AgentTabProps) {
  const router = useRouter();
  const [isDeleting, setIsDeleting] = useState(false);

  async function handleDelete() {
    if (!confirm("Are you sure you want to delete this agent? This action cannot be undone.")) {
      return;
    }

    setIsDeleting(true);
    try {
      await agentsApi.delete(agentId);
      toast.success("Agent deleted");
      router.push("/dashboard/agents");
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to delete agent"));
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Agent Settings</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">Settings editing coming soon...</p>
        </CardContent>
      </Card>

      <Card className="border-red-500/30">
        <CardHeader>
          <CardTitle className="text-base text-red-600">Danger Zone</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">Delete Agent</p>
              <p className="text-sm text-muted-foreground">
                Permanently delete this agent and all its deployments
              </p>
            </div>
            <Button
              variant="destructive"
              onClick={handleDelete}
              isLoading={isDeleting}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete Agent
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
