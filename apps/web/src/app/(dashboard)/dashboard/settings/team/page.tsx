"use client";

import { useState, useEffect } from "react";
import {
  Users,
  UserPlus,
  Mail,
  Shield,
  Crown,
  Trash2,
  Clock,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { enterpriseApi, getErrorMessage, type TeamMember, type TeamInvite } from "@/lib/api";
import { useConfirm } from "@/components/ui/confirm-dialog";

export default function TeamSettingsPage() {
  const confirmAction = useConfirm();
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [invites, setInvites] = useState<TeamInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInviteForm, setShowInviteForm] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  const [inviting, setInviting] = useState(false);

  useEffect(() => {
    loadTeam();
  }, []);

  async function loadTeam() {
    try {
      const [membersRes, invitesRes] = await Promise.all([
        enterpriseApi.getTeamMembers(),
        enterpriseApi.getPendingInvites(),
      ]);
      setMembers(membersRes.data);
      setInvites(invitesRes.data);
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to load team"));
    } finally {
      setLoading(false);
    }
  }

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!inviteEmail) return;

    setInviting(true);
    try {
      const res = await enterpriseApi.createTeamInvite(inviteEmail, inviteRole);
      setInviteEmail("");
      setShowInviteForm(false);
      if (res.emailSent) {
        toast.success(res.message);
      } else {
        // Email is not configured: the inviter shares the link directly.
        await navigator.clipboard?.writeText(res.inviteUrl).catch(() => undefined);
        toast.success("Invite created. The invite link is copied to your clipboard.", {
          description: res.inviteUrl,
          duration: 15000,
        });
      }
      loadTeam();
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to send invite"));
    } finally {
      setInviting(false);
    }
  }

  async function handleRevokeInvite(inviteId: string) {
    try {
      await enterpriseApi.revokeInvite(inviteId);
      toast.success("Invite revoked");
      loadTeam();
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to revoke invite"));
    }
  }

  async function handleUpdateRole(memberId: string, role: string) {
    try {
      await enterpriseApi.updateMemberRole(memberId, role);
      toast.success("Role updated");
      loadTeam();
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to update role"));
    }
  }

  async function handleRemoveMember(memberId: string) {
    if (!(await confirmAction({ title: "Remove this team member?", destructive: true }))) return;

    try {
      await enterpriseApi.removeMember(memberId);
      loadTeam();
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to remove member"));
    }
  }

  const getRoleIcon = (role: string) => {
    switch (role) {
      case "owner":
        return <Crown className="h-4 w-4 text-yellow-500" />;
      case "admin":
        return <Shield className="h-4 w-4 text-blue-500" />;
      default:
        return <Users className="h-4 w-4 text-muted-foreground" />;
    }
  };

  if (loading) {
    return (
      <div className="p-6 space-y-6">
        <div className="h-8 w-48 bg-muted animate-pulse rounded" />
        <div className="space-y-4">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-16 bg-card border rounded-lg animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Team</h1>
          <p className="text-muted-foreground">
            Manage your organization members and invites
          </p>
        </div>
        <button
          onClick={() => setShowInviteForm(true)}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
        >
          <UserPlus className="h-4 w-4" />
          Invite Member
        </button>
      </div>

      {/* Invite Form Modal */}
      {showInviteForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card border rounded-lg p-6 w-full max-w-md">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Invite Team Member</h2>
              <button
                onClick={() => setShowInviteForm(false)}
                className="p-1 hover:bg-accent rounded"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <form onSubmit={handleInvite} className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Email</label>
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="colleague@example.com"
                  className="w-full px-3 py-2 bg-background border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Role</label>
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value)}
                  className="w-full px-3 py-2 bg-background border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select>
                <p className="text-xs text-muted-foreground mt-1">
                  Admins can manage team members and organization settings
                </p>
              </div>
              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowInviteForm(false)}
                  className="flex-1 px-4 py-2 border rounded-lg hover:bg-accent transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={inviting}
                  className="flex-1 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
                >
                  {inviting ? "Sending..." : "Send Invite"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Pending Invites */}
      {invites.length > 0 && (
        <div className="bg-card border rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Clock className="h-5 w-5 text-muted-foreground" />
            Pending Invites
          </h2>
          <div className="space-y-3">
            {invites.map((invite) => (
              <div
                key={invite.id}
                className="flex items-center justify-between py-3 border-b last:border-0"
              >
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-muted rounded-full">
                    <Mail className="h-4 w-4" />
                  </div>
                  <div>
                    <div className="font-medium">{invite.email}</div>
                    <div className="text-sm text-muted-foreground">
                      Invited as {invite.role} - Expires{" "}
                      {new Date(invite.expiresAt).toLocaleDateString()}
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => handleRevokeInvite(invite.id)}
                  className="p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg transition-colors"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Team Members */}
      <div className="bg-card border rounded-lg p-6">
        <h2 className="text-lg font-semibold mb-4">
          Team Members ({members.length})
        </h2>
        <div className="space-y-3">
          {members.map((member) => (
            <div
              key={member.userId}
              className="flex items-center justify-between py-3 border-b last:border-0"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center text-lg font-bold">
                  {(member.displayName || member.email || "?").charAt(0).toUpperCase()}
                </div>
                <div>
                  <div className="font-medium flex items-center gap-2">
                    {member.displayName || member.email || "Unknown"}
                    {getRoleIcon(member.role)}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {member.email || member.walletAddress?.slice(0, 8) + "..."}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {member.role !== "owner" && (
                  <>
                    <select
                      value={member.role}
                      onChange={(e) => handleUpdateRole(member.userId, e.target.value)}
                      className="px-2 py-1 bg-background border rounded text-sm"
                    >
                      <option value="member">Member</option>
                      <option value="admin">Admin</option>
                    </select>
                    <button
                      onClick={() => handleRemoveMember(member.userId)}
                      className="p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg transition-colors"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </>
                )}
                {member.role === "owner" && (
                  <span className="text-sm text-muted-foreground px-3 py-1 bg-muted rounded">
                    Owner
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Role Descriptions */}
      <div className="bg-card border rounded-lg p-6">
        <h2 className="text-lg font-semibold mb-4">Roles</h2>
        <div className="space-y-4">
          <div className="flex gap-3">
            <Crown className="h-5 w-5 text-yellow-500 mt-0.5" />
            <div>
              <div className="font-medium">Owner</div>
              <div className="text-sm text-muted-foreground">
                Full access to all organization settings, billing, and can transfer ownership
              </div>
            </div>
          </div>
          <div className="flex gap-3">
            <Shield className="h-5 w-5 text-blue-500 mt-0.5" />
            <div>
              <div className="font-medium">Admin</div>
              <div className="text-sm text-muted-foreground">
                Can manage team members, deployments, and most organization settings
              </div>
            </div>
          </div>
          <div className="flex gap-3">
            <Users className="h-5 w-5 text-muted-foreground mt-0.5" />
            <div>
              <div className="font-medium">Member</div>
              <div className="text-sm text-muted-foreground">
                Can create and manage their own deployments and agents
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
