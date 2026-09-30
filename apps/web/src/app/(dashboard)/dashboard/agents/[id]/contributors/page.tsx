"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { Users, Plus, Trash2, Check, UserPlus } from "lucide-react";
import { toast } from "sonner";

import { Header } from "@/components/dashboard/header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { agentsApi, getErrorMessage } from "@/lib/api";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

interface Contributor {
  id: string;
  role: string;
  revenueShare: number;
  acceptedAt: string | null;
  createdAt: string;
  user: {
    id: string;
    email: string | null;
    displayName: string | null;
    walletAddress: string | null;
  };
}

async function fetchJson<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    ...opts,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as any).message || res.statusText);
  }
  return res.json();
}

export default function ContributorsPage() {
  const params = useParams();
  const agentId = params.id as string;

  const [agentName, setAgentName] = useState("");
  const [contributors, setContributors] = useState<Contributor[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("contributor");
  const [inviteShare, setInviteShare] = useState("0");
  const [isInviting, setIsInviting] = useState(false);

  const loadContributors = useCallback(async () => {
    try {
      const data = await fetchJson<{ contributors: Contributor[] }>(
        `/api/agents/${agentId}/contributors`
      );
      setContributors(data.contributors);
    } catch {
      // May fail if no contributors yet
    }
  }, [agentId]);

  useEffect(() => {
    agentsApi.get(agentId).then(({ agent }) => setAgentName(agent.name)).catch(() => {});
    loadContributors().finally(() => setIsLoading(false));
  }, [agentId, loadContributors]);

  const totalShare = contributors.reduce((sum, c) => sum + c.revenueShare, 0);
  const remainingShare = Math.max(0, 1 - totalShare);

  const handleInvite = async () => {
    setIsInviting(true);
    try {
      // Note: in a real implementation, you'd look up the user by email
      // For now, this is a placeholder — the API expects userId
      toast.error("User lookup by email not yet implemented. Use user ID directly.");
    } catch (err: any) {
      toast.error(getErrorMessage(err, "Failed to invite contributor"));
    } finally {
      setIsInviting(false);
    }
  };

  const handleRemove = async (contributorId: string) => {
    if (!confirm("Remove this contributor?")) return;
    try {
      await fetchJson(`/api/agents/${agentId}/contributors/${contributorId}`, {
        method: "DELETE",
      });
      toast.success("Contributor removed");
      loadContributors();
    } catch (err: any) {
      toast.error(getErrorMessage(err, "Failed to remove"));
    }
  };

  if (isLoading) {
    return (
      <div className="flex flex-col">
        <Header title="Contributors" />
        <div className="p-8">
          <div className="h-64 animate-pulse rounded-lg bg-muted" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <Header
        title={`Contributors — ${agentName}`}
        description="Manage who contributes to this agent and how revenue is shared"
      />

      <div className="p-8 max-w-3xl">
        {/* Revenue share overview */}
        <Card className="mb-6">
          <CardContent className="py-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-muted-foreground">
                  Revenue Allocated
                </p>
                <p className="text-2xl font-bold text-foreground">
                  {(totalShare * 100).toFixed(0)}%
                </p>
              </div>
              <div className="w-48 h-3 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-primary-500 transition-all"
                  style={{ width: `${totalShare * 100}%` }}
                />
              </div>
              <div className="text-right">
                <p className="text-sm font-medium text-muted-foreground">
                  Available
                </p>
                <p className="text-2xl font-bold text-green-600">
                  {(remainingShare * 100).toFixed(0)}%
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Contributors list */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Users className="h-5 w-5" />
              Contributors ({contributors.length})
            </CardTitle>
            <Button onClick={() => setShowInvite(!showInvite)} variant="outline" size="sm">
              <UserPlus className="mr-2 h-4 w-4" />
              Invite
            </Button>
          </CardHeader>
          <CardContent>
            {/* Invite form */}
            {showInvite && (
              <div className="mb-6 rounded-lg border border-border p-4 space-y-3">
                <div className="grid grid-cols-3 gap-3">
                  <div className="col-span-1">
                    <label className="text-xs font-medium text-muted-foreground">Email</label>
                    <Input
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                      placeholder="user@example.com"
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">Role</label>
                    <Select
                      value={inviteRole}
                      onChange={(e) => setInviteRole(e.target.value)}
                      className="mt-1"
                    >
                      <option value="contributor">Contributor</option>
                      <option value="reviewer">Reviewer</option>
                    </Select>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">
                      Revenue Share (max {(remainingShare * 100).toFixed(0)}%)
                    </label>
                    <Input
                      type="number"
                      value={inviteShare}
                      onChange={(e) => setInviteShare(e.target.value)}
                      min="0"
                      max={String(remainingShare * 100)}
                      step="1"
                      className="mt-1"
                    />
                  </div>
                </div>
                <Button onClick={handleInvite} disabled={isInviting} size="sm">
                  <Plus className="mr-2 h-4 w-4" />
                  {isInviting ? "Inviting..." : "Send Invite"}
                </Button>
              </div>
            )}

            {/* List */}
            {contributors.length === 0 ? (
              <div className="text-center py-8">
                <Users className="mx-auto h-10 w-10 text-gray-300 dark:text-gray-600" />
                <p className="mt-2 text-sm text-muted-foreground">
                  No contributors yet. Invite team members to collaborate.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {contributors.map((c) => (
                  <div
                    key={c.id}
                    className="flex items-center justify-between rounded-lg border border-border p-3"
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/15 text-sm font-medium text-primary-600 dark:text-primary-400">
                        {(c.user.displayName || c.user.email || "?")[0]?.toUpperCase()}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-foreground">
                            {c.user.displayName || c.user.email || c.user.walletAddress?.slice(0, 8) + "..."}
                          </span>
                          <Badge variant={c.role === "owner" ? "default" : "secondary"} className="text-xs">
                            {c.role}
                          </Badge>
                          {!c.acceptedAt && (
                            <Badge variant="warning" className="text-xs">Pending</Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {(c.revenueShare * 100).toFixed(0)}% revenue share
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {c.role !== "owner" && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleRemove(c.id)}
                          className="text-red-500 hover:text-red-500"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
