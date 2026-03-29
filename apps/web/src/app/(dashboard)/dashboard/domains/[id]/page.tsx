"use client";

import { useState, useEffect, use } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Globe,
  CheckCircle,
  XCircle,
  Clock,
  Shield,
  ShieldCheck,
  RefreshCw,
  Copy,
  Power,
  PowerOff,
  AlertTriangle,
  Bot,
  Box,
  AlertCircle,
  Trash2,
  ExternalLink,
} from "lucide-react";
import {
  domainsApi,
  type CustomDomainWithDns,
  type DomainEvent,
} from "@/lib/api";
import { toast } from "sonner";

export default function DomainDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const resolvedParams = use(params);
  const router = useRouter();
  const [domain, setDomain] = useState<CustomDomainWithDns | null>(null);
  const [events, setEvents] = useState<DomainEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [verifying, setVerifying] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    loadDomain();
  }, [resolvedParams.id]);

  async function loadDomain() {
    try {
      setLoading(true);
      const [domainRes, eventsRes] = await Promise.all([
        domainsApi.getDomain(resolvedParams.id),
        domainsApi.getDomainEvents(resolvedParams.id, { limit: 20 }),
      ]);

      setDomain(domainRes.data);
      setEvents(eventsRes.data.events);
    } catch (error) {
      console.error("Failed to load domain:", error);
    } finally {
      setLoading(false);
    }
  }

  async function verifyDomain() {
    if (!domain) return;
    try {
      setVerifying(true);
      const result = await domainsApi.verifyDomain(domain.id);
      if (result.data.verified) {
        toast.success("Domain verified successfully! SSL provisioning has started.");
      } else {
        toast.error(result.data.message || "Verification failed. Please check DNS records.");
      }
      loadDomain();
    } catch (error) {
      console.error("Failed to verify domain:", error);
    } finally {
      setVerifying(false);
    }
  }

  async function toggleDomain() {
    if (!domain) return;
    try {
      await domainsApi.toggleDomain(domain.id, !domain.isActive);
      loadDomain();
    } catch (error) {
      console.error("Failed to toggle domain:", error);
      toast.error((error as Error).message);
    }
  }

  async function deleteDomain() {
    if (!domain) return;
    if (!confirm("Are you sure you want to delete this domain?")) return;
    try {
      await domainsApi.deleteDomain(domain.id);
      router.push("/dashboard/domains");
    } catch (error) {
      console.error("Failed to delete domain:", error);
    }
  }

  async function reverifyDomain() {
    if (!domain) return;
    try {
      await domainsApi.reverifyDomain(domain.id);
      toast.success("New verification token generated. Please update your DNS records.");
      loadDomain();
    } catch (error) {
      console.error("Failed to reverify domain:", error);
    }
  }

  function copyToClipboard(text: string, key: string) {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  if (!domain) {
    return (
      <div className="text-center py-12">
        <AlertCircle className="h-12 w-12 text-gray-300 mx-auto mb-4" />
        <h2 className="text-lg font-medium text-gray-900">Domain not found</h2>
        <button
          onClick={() => router.push("/dashboard/domains")}
          className="mt-4 text-primary-600 hover:underline"
        >
          Go back to Domains
        </button>
      </div>
    );
  }

  const verificationStatusConfig = {
    pending: { icon: Clock, color: "text-yellow-600", bg: "bg-yellow-100", label: "Pending Verification" },
    verified: { icon: CheckCircle, color: "text-green-600", bg: "bg-green-100", label: "Verified" },
    failed: { icon: XCircle, color: "text-red-600", bg: "bg-red-100", label: "Verification Failed" },
    expired: { icon: AlertTriangle, color: "text-orange-600", bg: "bg-orange-100", label: "Verification Expired" },
  };

  const sslStatusConfig = {
    pending: { icon: Shield, color: "text-gray-400", bg: "bg-gray-100", label: "SSL Pending" },
    provisioning: { icon: RefreshCw, color: "text-blue-600", bg: "bg-blue-100", label: "SSL Provisioning" },
    active: { icon: ShieldCheck, color: "text-green-600", bg: "bg-green-100", label: "SSL Active" },
    failed: { icon: Shield, color: "text-red-600", bg: "bg-red-100", label: "SSL Failed" },
    expired: { icon: AlertTriangle, color: "text-orange-600", bg: "bg-orange-100", label: "SSL Expired" },
  };

  const vConfig = verificationStatusConfig[domain.verificationStatus];
  const sConfig = sslStatusConfig[domain.sslStatus];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <button
            onClick={() => router.push("/dashboard/domains")}
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-gray-900">{domain.domain}</h1>
              {domain.isPrimary && (
                <span className="text-xs bg-primary-100 text-primary-700 px-2 py-0.5 rounded">
                  Primary
                </span>
              )}
            </div>
            <p className="text-gray-500 mt-1">
              {domain.targetType === "agent" ? "Agent" : "Deployment"} ID: {domain.targetId.slice(0, 8)}...
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {domain.verificationStatus === "verified" && domain.sslStatus === "active" && (
            <button
              onClick={toggleDomain}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg ${
                domain.isActive
                  ? "bg-green-100 text-green-700"
                  : "bg-gray-100 text-gray-600"
              }`}
            >
              {domain.isActive ? (
                <>
                  <Power className="h-4 w-4" />
                  Active
                </>
              ) : (
                <>
                  <PowerOff className="h-4 w-4" />
                  Inactive
                </>
              )}
            </button>
          )}

          <button
            onClick={deleteDomain}
            className="flex items-center gap-2 px-4 py-2 text-red-600 bg-red-50 rounded-lg hover:bg-red-100"
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </button>
        </div>
      </div>

      {/* Status Cards */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-gray-900">Verification Status</h3>
            <span className={`flex items-center gap-1 px-2 py-1 rounded text-sm ${vConfig.bg} ${vConfig.color}`}>
              <vConfig.icon className="h-4 w-4" />
              {vConfig.label}
            </span>
          </div>

          {domain.verificationStatus === "pending" && (
            <div className="space-y-3">
              <p className="text-sm text-gray-600">
                Add the following DNS records to verify ownership of this domain:
              </p>
              <button
                onClick={verifyDomain}
                disabled={verifying}
                className="w-full py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50"
              >
                {verifying ? "Verifying..." : "Verify Domain"}
              </button>
            </div>
          )}

          {domain.verificationStatus === "verified" && domain.verifiedAt && (
            <p className="text-sm text-gray-600">
              Verified on {new Date(domain.verifiedAt).toLocaleDateString()}
            </p>
          )}

          {(domain.verificationStatus === "failed" || domain.verificationStatus === "expired") && (
            <div className="space-y-3">
              {domain.verificationError && (
                <p className="text-sm text-red-600">{domain.verificationError}</p>
              )}
              <button
                onClick={reverifyDomain}
                className="w-full py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700"
              >
                Generate New Token
              </button>
            </div>
          )}
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-gray-900">SSL Certificate</h3>
            <span className={`flex items-center gap-1 px-2 py-1 rounded text-sm ${sConfig.bg} ${sConfig.color}`}>
              <sConfig.icon className="h-4 w-4" />
              {sConfig.label}
            </span>
          </div>

          {domain.sslStatus === "active" && domain.sslExpiresAt && (
            <div className="text-sm text-gray-600">
              <p>Provider: {domain.sslProvider || "Let's Encrypt"}</p>
              <p>Expires: {new Date(domain.sslExpiresAt).toLocaleDateString()}</p>
            </div>
          )}

          {domain.sslStatus === "provisioning" && (
            <p className="text-sm text-gray-600">
              SSL certificate is being provisioned. This may take a few minutes.
            </p>
          )}

          {domain.sslStatus === "failed" && domain.sslError && (
            <p className="text-sm text-red-600">{domain.sslError}</p>
          )}
        </div>
      </div>

      {/* DNS Records */}
      {domain.verificationStatus !== "verified" && domain.dnsRecords && (
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h3 className="font-semibold text-gray-900 mb-4">DNS Configuration</h3>
          <p className="text-sm text-gray-600 mb-4">
            Add these DNS records to your domain to verify ownership and enable SSL:
          </p>

          <div className="space-y-4">
            {/* TXT Record */}
            <div className="bg-gray-50 rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-gray-700">TXT Record (Verification)</span>
                <button
                  onClick={() => copyToClipboard(domain.dnsRecords.txtRecord.value, "txt")}
                  className="text-xs text-primary-600 hover:underline flex items-center gap-1"
                >
                  <Copy className="h-3 w-3" />
                  {copied === "txt" ? "Copied!" : "Copy"}
                </button>
              </div>
              <div className="space-y-1 text-sm">
                <div className="flex">
                  <span className="w-16 text-gray-500">Name:</span>
                  <code className="text-gray-900">{domain.dnsRecords.txtRecord.name}</code>
                </div>
                <div className="flex">
                  <span className="w-16 text-gray-500">Type:</span>
                  <code className="text-gray-900">{domain.dnsRecords.txtRecord.type}</code>
                </div>
                <div className="flex">
                  <span className="w-16 text-gray-500">Value:</span>
                  <code className="text-gray-900 break-all">{domain.dnsRecords.txtRecord.value}</code>
                </div>
              </div>
            </div>

            {/* CNAME Record */}
            <div className="bg-gray-50 rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-gray-700">CNAME Record (Routing)</span>
                <button
                  onClick={() => copyToClipboard(domain.dnsRecords.cnameRecord.value, "cname")}
                  className="text-xs text-primary-600 hover:underline flex items-center gap-1"
                >
                  <Copy className="h-3 w-3" />
                  {copied === "cname" ? "Copied!" : "Copy"}
                </button>
              </div>
              <div className="space-y-1 text-sm">
                <div className="flex">
                  <span className="w-16 text-gray-500">Name:</span>
                  <code className="text-gray-900">{domain.dnsRecords.cnameRecord.name}</code>
                </div>
                <div className="flex">
                  <span className="w-16 text-gray-500">Type:</span>
                  <code className="text-gray-900">{domain.dnsRecords.cnameRecord.type}</code>
                </div>
                <div className="flex">
                  <span className="w-16 text-gray-500">Value:</span>
                  <code className="text-gray-900">{domain.dnsRecords.cnameRecord.value}</code>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Configuration */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <h3 className="font-semibold text-gray-900 mb-4">Configuration</h3>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <span className="text-gray-500">Force HTTPS:</span>
            <span className="ml-2 text-gray-900">{domain.forceHttps ? "Yes" : "No"}</span>
          </div>
          <div>
            <span className="text-gray-500">Routing Mode:</span>
            <span className="ml-2 text-gray-900 capitalize">{domain.routingMode}</span>
          </div>
          <div>
            <span className="text-gray-500">Target Type:</span>
            <span className="ml-2 text-gray-900 capitalize">{domain.targetType}</span>
          </div>
          <div>
            <span className="text-gray-500">Total Requests:</span>
            <span className="ml-2 text-gray-900">{domain.totalRequests.toLocaleString()}</span>
          </div>
        </div>
      </div>

      {/* Event History */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200">
          <h3 className="font-semibold text-gray-900">Event History</h3>
        </div>

        {events.length === 0 ? (
          <div className="p-8 text-center text-gray-500">No events recorded</div>
        ) : (
          <div className="divide-y divide-gray-100">
            {events.map((event) => (
              <div key={event.id} className="px-6 py-3 flex items-center justify-between">
                <div>
                  <span className="font-medium text-gray-900 capitalize">
                    {event.eventType.replace(/_/g, " ")}
                  </span>
                  {event.message && (
                    <p className="text-sm text-gray-500">{event.message}</p>
                  )}
                </div>
                <span className="text-sm text-gray-400">
                  {new Date(event.createdAt).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
