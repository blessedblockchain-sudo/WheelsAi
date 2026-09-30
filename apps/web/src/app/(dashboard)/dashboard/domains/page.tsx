"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  Globe,
  Plus,
  CheckCircle,
  XCircle,
  Clock,
  Shield,
  ShieldCheck,
  ExternalLink,
  Copy,
  RefreshCw,
  Trash2,
  Power,
  PowerOff,
  AlertTriangle,
  Bot,
  Box,
} from "lucide-react";
import {
  domainsApi,
  agentsApi,
  deploymentsApi,
  type CustomDomain,
  type DomainStats,
  type Agent,
  type Deployment,
  getErrorMessage,
} from "@/lib/api";
import { toast } from "sonner";

export default function DomainsPage() {
  const router = useRouter();
  const [stats, setStats] = useState<DomainStats | null>(null);
  const [domains, setDomains] = useState<CustomDomain[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newDomain, setNewDomain] = useState({
    domain: "",
    targetType: "agent" as "agent" | "deployment",
    targetId: "",
  });

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    try {
      setLoading(true);
      const [statsRes, domainsRes, agentsRes, deploymentsRes] = await Promise.all([
        domainsApi.getStats(),
        domainsApi.getDomains({ limit: 50 }),
        agentsApi.list(),
        deploymentsApi.list(),
      ]);

      setStats(statsRes.data);
      setDomains(domainsRes.data.domains);
      setAgents(agentsRes.agents);
      setDeployments(deploymentsRes.deployments);
    } catch (error) {
      console.error("Failed to load data:", error);
    } finally {
      setLoading(false);
    }
  }

  async function createDomain() {
    if (!newDomain.domain || !newDomain.targetId) return;
    try {
      await domainsApi.createDomain(newDomain);
      setShowAddModal(false);
      setNewDomain({ domain: "", targetType: "agent", targetId: "" });
      loadData();
    } catch (error) {
      console.error("Failed to create domain:", error);
      toast.error(getErrorMessage(error));
    }
  }

  async function verifyDomain(domainId: string) {
    try {
      const result = await domainsApi.verifyDomain(domainId);
      if (result.data.verified) {
        toast.success("Domain verified successfully!");
      } else {
        toast.error(result.data.message || "Verification failed. Please check DNS records.");
      }
      loadData();
    } catch (error) {
      console.error("Failed to verify domain:", error);
    }
  }

  async function toggleDomain(domainId: string, isActive: boolean) {
    try {
      await domainsApi.toggleDomain(domainId, isActive);
      loadData();
    } catch (error) {
      console.error("Failed to toggle domain:", error);
      toast.error(getErrorMessage(error));
    }
  }

  async function deleteDomain(domainId: string) {
    if (!confirm("Are you sure you want to delete this domain?")) return;
    try {
      await domainsApi.deleteDomain(domainId);
      loadData();
    } catch (error) {
      console.error("Failed to delete domain:", error);
    }
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
  }

  function getTargetName(domain: CustomDomain): string {
    if (domain.targetType === "agent") {
      const agent = agents.find((a) => a.id === domain.targetId);
      return agent?.name || "Unknown Agent";
    } else {
      const deployment = deployments.find((d) => d.id === domain.targetId);
      return deployment?.name || "Unknown Deployment";
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Custom Domains</h1>
          <p className="text-muted-foreground mt-1">
            Add custom domains to your agents and deployments
          </p>
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          className="flex items-center gap-2 px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors"
        >
          <Plus className="h-4 w-4" />
          Add Domain
        </button>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <StatCard icon={Globe} label="Total Domains" value={stats.total} />
          <StatCard
            icon={CheckCircle}
            label="Verified"
            value={stats.verified}
            color="green"
          />
          <StatCard icon={Power} label="Active" value={stats.active} color="blue" />
          <StatCard icon={Clock} label="Pending" value={stats.pending} color="yellow" />
          <StatCard
            icon={AlertTriangle}
            label="SSL Expiring"
            value={stats.sslExpiringSoon}
            color="red"
          />
        </div>
      )}

      {/* Domains List */}
      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <div className="px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold">Domains</h2>
        </div>

        {domains.length === 0 ? (
          <div className="p-12 text-center">
            <Globe className="h-12 w-12 text-gray-300 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-foreground mb-2">No domains configured</h3>
            <p className="text-muted-foreground mb-4">
              Add a custom domain to access your agents via your own domain
            </p>
            <button
              onClick={() => setShowAddModal(true)}
              className="inline-flex items-center gap-2 px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700"
            >
              <Plus className="h-4 w-4" />
              Add Domain
            </button>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {domains.map((domain) => (
              <DomainRow
                key={domain.id}
                domain={domain}
                targetName={getTargetName(domain)}
                onVerify={() => verifyDomain(domain.id)}
                onToggle={() => toggleDomain(domain.id, !domain.isActive)}
                onDelete={() => deleteDomain(domain.id)}
                onCopy={copyToClipboard}
                onView={() => router.push(`/dashboard/domains/${domain.id}`)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Add Domain Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card rounded-xl p-6 w-full max-w-md">
            <h2 className="text-xl font-bold text-foreground mb-4">Add Custom Domain</h2>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">
                  Domain
                </label>
                <input
                  type="text"
                  value={newDomain.domain}
                  onChange={(e) => setNewDomain({ ...newDomain, domain: e.target.value })}
                  className="w-full px-3 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary-500"
                  placeholder="api.example.com"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-foreground mb-1">
                  Target Type
                </label>
                <select
                  value={newDomain.targetType}
                  onChange={(e) =>
                    setNewDomain({
                      ...newDomain,
                      targetType: e.target.value as "agent" | "deployment",
                      targetId: "",
                    })
                  }
                  className="w-full px-3 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary-500"
                >
                  <option value="agent">Agent</option>
                  <option value="deployment">Deployment</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-foreground mb-1">
                  {newDomain.targetType === "agent" ? "Agent" : "Deployment"}
                </label>
                <select
                  value={newDomain.targetId}
                  onChange={(e) => setNewDomain({ ...newDomain, targetId: e.target.value })}
                  className="w-full px-3 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary-500"
                >
                  <option value="">Select {newDomain.targetType}</option>
                  {newDomain.targetType === "agent"
                    ? agents.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.name}
                        </option>
                      ))
                    : deployments.map((deployment) => (
                        <option key={deployment.id} value={deployment.id}>
                          {deployment.name}
                        </option>
                      ))}
                </select>
              </div>
            </div>

            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => setShowAddModal(false)}
                className="px-4 py-2 text-muted-foreground hover:bg-muted rounded-lg"
              >
                Cancel
              </button>
              <button
                onClick={createDomain}
                disabled={!newDomain.domain || !newDomain.targetId}
                className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50"
              >
                Add Domain
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  color = "gray",
}: {
  icon: React.ElementType;
  label: string;
  value: number;
  color?: "gray" | "green" | "blue" | "yellow" | "red";
}) {
  const colorClasses = {
    gray: "bg-muted text-muted-foreground",
    green: "bg-green-500/10 text-green-600",
    blue: "bg-blue-500/10 text-blue-600",
    yellow: "bg-yellow-500/10 text-yellow-600",
    red: "bg-red-500/10 text-red-600",
  };

  return (
    <div className="bg-card rounded-xl border border-border p-4">
      <div className="flex items-center gap-3">
        <div className={`p-2 rounded-lg ${colorClasses[color]}`}>
          <Icon className="h-4 w-4" />
        </div>
        <div>
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className="text-lg font-semibold text-foreground">{value}</p>
        </div>
      </div>
    </div>
  );
}

function DomainRow({
  domain,
  targetName,
  onVerify,
  onToggle,
  onDelete,
  onCopy,
  onView,
}: {
  domain: CustomDomain;
  targetName: string;
  onVerify: () => void;
  onToggle: () => void;
  onDelete: () => void;
  onCopy: (text: string) => void;
  onView: () => void;
}) {
  const verificationStatusConfig = {
    pending: { icon: Clock, color: "text-yellow-600", bg: "bg-yellow-500/10" },
    verified: { icon: CheckCircle, color: "text-green-600", bg: "bg-green-500/10" },
    failed: { icon: XCircle, color: "text-red-600", bg: "bg-red-500/10" },
    expired: { icon: AlertTriangle, color: "text-orange-600", bg: "bg-orange-500/10" },
  };

  const sslStatusConfig = {
    pending: { icon: Shield, color: "text-gray-400", label: "SSL Pending" },
    provisioning: { icon: RefreshCw, color: "text-blue-600", label: "Provisioning" },
    active: { icon: ShieldCheck, color: "text-green-600", label: "SSL Active" },
    failed: { icon: Shield, color: "text-red-600", label: "SSL Failed" },
    expired: { icon: AlertTriangle, color: "text-orange-600", label: "SSL Expired" },
  };

  const vConfig = verificationStatusConfig[domain.verificationStatus];
  const sConfig = sslStatusConfig[domain.sslStatus];
  const VerifyIcon = vConfig.icon;
  const SslIcon = sConfig.icon;

  return (
    <div className="px-6 py-4 hover:bg-muted transition-colors">
      <div className="flex items-center justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3">
            <button
              onClick={onView}
              className="font-medium text-foreground hover:text-primary-600 flex items-center gap-2"
            >
              {domain.domain}
              <ExternalLink className="h-3 w-3" />
            </button>

            {domain.isPrimary && (
              <span className="text-xs bg-primary/15 text-primary-700 px-2 py-0.5 rounded">
                Primary
              </span>
            )}

            <span className={`flex items-center gap-1 px-2 py-0.5 rounded text-xs ${vConfig.bg} ${vConfig.color}`}>
              <VerifyIcon className="h-3 w-3" />
              {domain.verificationStatus}
            </span>

            <span className={`flex items-center gap-1 text-xs ${sConfig.color}`}>
              <SslIcon className="h-3 w-3" />
              {sConfig.label}
            </span>
          </div>

          <div className="flex items-center gap-4 mt-1 text-sm text-muted-foreground">
            <span className="flex items-center gap-1">
              {domain.targetType === "agent" ? (
                <Bot className="h-3.5 w-3.5" />
              ) : (
                <Box className="h-3.5 w-3.5" />
              )}
              {targetName}
            </span>
            <span>
              {domain.isActive ? (
                <span className="text-green-600">Active</span>
              ) : (
                <span className="text-gray-400">Inactive</span>
              )}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {domain.verificationStatus === "pending" && (
            <button
              onClick={onVerify}
              className="px-3 py-1.5 text-sm bg-blue-500/10 text-blue-500 rounded-lg hover:bg-blue-500/20"
            >
              Verify
            </button>
          )}

          <button
            onClick={() => onCopy(domain.domain)}
            className="p-2 text-gray-400 hover:text-foreground hover:bg-muted rounded-lg"
            title="Copy domain"
          >
            <Copy className="h-4 w-4" />
          </button>

          {domain.verificationStatus === "verified" && domain.sslStatus === "active" && (
            <button
              onClick={onToggle}
              className={`p-2 rounded-lg ${
                domain.isActive
                  ? "text-green-600 hover:bg-green-500/10"
                  : "text-gray-400 hover:bg-muted"
              }`}
              title={domain.isActive ? "Deactivate" : "Activate"}
            >
              {domain.isActive ? (
                <Power className="h-4 w-4" />
              ) : (
                <PowerOff className="h-4 w-4" />
              )}
            </button>
          )}

          <button
            onClick={onDelete}
            className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-500/10 rounded-lg"
            title="Delete domain"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
