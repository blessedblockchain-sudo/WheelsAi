"use client";

import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import {
  User,
  Mail,
  Lock,
  Bell,
  Globe,
  Shield,
  Wallet,
  LogOut,
  Save,
  AlertTriangle,
  Unlink,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";

import { Header } from "@/components/dashboard/header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton, SkeletonCard } from "@/components/ui/skeleton";
import { settingsApi, authApi, type UserProfile, type UserSettings } from "@/lib/api";
import { cn } from "@/lib/utils";

type Tab = "profile" | "security" | "notifications" | "wallets";

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<Tab>("profile");
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  // Form state
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  useEffect(() => {
    async function loadSettings() {
      try {
        const [profileData, settingsData] = await Promise.all([
          settingsApi.getProfile(),
          settingsApi.getSettings(),
        ]);
        setProfile(profileData.profile);
        setSettings(settingsData.settings);
        setDisplayName(profileData.profile.displayName || "");
        setEmail(profileData.profile.email);
      } catch (error) {
        toast.error("Failed to load settings");
      } finally {
        setIsLoading(false);
      }
    }
    loadSettings();
  }, []);

  async function handleSaveProfile() {
    setIsSaving(true);
    try {
      await settingsApi.updateProfile({ displayName, email });
      toast.success("Profile updated");
    } catch (error) {
      toast.error("Failed to update profile");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleChangePassword() {
    if (newPassword !== confirmPassword) {
      toast.error("Passwords do not match");
      return;
    }

    if (newPassword.length < 8) {
      toast.error("Password must be at least 8 characters");
      return;
    }

    setIsSaving(true);
    try {
      await settingsApi.changePassword(currentPassword, newPassword);
      toast.success("Password changed successfully");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (error) {
      toast.error("Failed to change password");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleLogout() {
    try {
      await authApi.logout();
      window.location.href = "/login";
    } catch (error) {
      toast.error("Failed to log out");
    }
  }

  const tabs = [
    { id: "profile" as Tab, label: "Profile", icon: User },
    { id: "security" as Tab, label: "Security", icon: Shield },
    { id: "notifications" as Tab, label: "Notifications", icon: Bell },
    { id: "wallets" as Tab, label: "Wallets", icon: Wallet },
  ];

  if (isLoading) {
    return (
      <div className="flex flex-col">
        <Header title="Settings" />
        <div className="p-8">
          <div className="flex gap-8">
            {/* Sidebar skeleton */}
            <div className="w-48 shrink-0 space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-9 w-full" />
              ))}
            </div>
            {/* Content skeleton */}
            <div className="flex-1">
              <SkeletonCard />
              <div className="mt-6 space-y-4">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-4 w-1/4" />
                <Skeleton className="h-10 w-full" />
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <Header
        title="Settings"
        description="Manage your account and preferences"
      />

      <div className="p-8">
        <div className="flex gap-8">
          {/* Sidebar */}
          <div className="w-48 shrink-0">
            <nav className="space-y-1">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                    activeTab === tab.id
                      ? "bg-primary-50 text-primary-700"
                      : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                  )}
                >
                  <tab.icon className="h-4 w-4" />
                  {tab.label}
                </button>
              ))}

              <div className="pt-4">
                <button
                  onClick={handleLogout}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50"
                >
                  <LogOut className="h-4 w-4" />
                  Log out
                </button>
              </div>
            </nav>
          </div>

          {/* Content */}
          <div className="flex-1">
            {/* Profile tab */}
            {activeTab === "profile" && (
              <Card>
                <CardHeader>
                  <CardTitle>Profile Information</CardTitle>
                  <CardDescription>
                    Update your account details and public profile
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      Display Name
                    </label>
                    <Input
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      placeholder="Your name"
                      className="mt-1"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      Email Address
                    </label>
                    <Input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="mt-1"
                    />
                    {profile?.emailVerified ? (
                      <p className="mt-1 text-sm text-green-600">Verified</p>
                    ) : (
                      <p className="mt-1 text-sm text-yellow-600">
                        Not verified.{" "}
                        <button className="underline">Send verification email</button>
                      </p>
                    )}
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      Account ID
                    </label>
                    <code className="mt-1 block rounded bg-gray-100 px-3 py-2 text-sm">
                      {profile?.id}
                    </code>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      Member Since
                    </label>
                    <p className="mt-1 text-gray-600">
                      {profile?.createdAt && new Date(profile.createdAt).toLocaleDateString()}
                    </p>
                  </div>

                  <div className="flex justify-end">
                    <Button onClick={handleSaveProfile} isLoading={isSaving}>
                      <Save className="mr-2 h-4 w-4" />
                      Save Changes
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Security tab */}
            {activeTab === "security" && (
              <div className="space-y-6">
                <Card>
                  <CardHeader>
                    <CardTitle>Change Password</CardTitle>
                    <CardDescription>
                      Update your password to keep your account secure
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700">
                        Current Password
                      </label>
                      <Input
                        type="password"
                        value={currentPassword}
                        onChange={(e) => setCurrentPassword(e.target.value)}
                        className="mt-1"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700">
                        New Password
                      </label>
                      <Input
                        type="password"
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        placeholder="At least 8 characters"
                        className="mt-1"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700">
                        Confirm New Password
                      </label>
                      <Input
                        type="password"
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        className="mt-1"
                      />
                    </div>

                    <div className="flex justify-end">
                      <Button
                        onClick={handleChangePassword}
                        isLoading={isSaving}
                        disabled={!currentPassword || !newPassword || !confirmPassword}
                      >
                        Update Password
                      </Button>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Two-Factor Authentication</CardTitle>
                    <CardDescription>
                      Add an extra layer of security to your account
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-medium">Authenticator App</p>
                        <p className="text-sm text-gray-500">
                          Use an authenticator app to generate one-time codes
                        </p>
                      </div>
                      <a href="/dashboard/settings/security">
                        <Button variant="outline">Configure 2FA</Button>
                      </a>
                    </div>
                  </CardContent>
                </Card>

                <Card className="border-red-200">
                  <CardHeader>
                    <CardTitle className="text-red-600">Danger Zone</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-medium">Delete Account</p>
                        <p className="text-sm text-gray-500">
                          Permanently delete your account and all associated data
                        </p>
                      </div>
                      <Button variant="destructive">Delete Account</Button>
                    </div>
                  </CardContent>
                </Card>
              </div>
            )}

            {/* Notifications tab */}
            {activeTab === "notifications" && (
              <Card>
                <CardHeader>
                  <CardTitle>Notification Preferences</CardTitle>
                  <CardDescription>
                    Choose what notifications you want to receive
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  {[
                    {
                      id: "deployment_status",
                      label: "Deployment Status",
                      description: "Get notified when your deployments start, stop, or fail",
                    },
                    {
                      id: "usage_alerts",
                      label: "Usage Alerts",
                      description: "Receive alerts when you're running low on credits",
                    },
                    {
                      id: "billing",
                      label: "Billing",
                      description: "Get receipts and billing notifications",
                    },
                    {
                      id: "product_updates",
                      label: "Product Updates",
                      description: "Learn about new features and improvements",
                    },
                  ].map((notification) => (
                    <div
                      key={notification.id}
                      className="flex items-center justify-between"
                    >
                      <div>
                        <p className="font-medium">{notification.label}</p>
                        <p className="text-sm text-gray-500">
                          {notification.description}
                        </p>
                      </div>
                      <label className="relative inline-flex cursor-pointer items-center">
                        <input
                          type="checkbox"
                          className="peer sr-only"
                          defaultChecked={notification.id !== "product_updates"}
                        />
                        <div className="peer h-6 w-11 rounded-full bg-gray-200 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-gray-300 after:bg-white after:transition-all after:content-[''] peer-checked:bg-primary-600 peer-checked:after:translate-x-full peer-checked:after:border-white peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-primary-300"></div>
                      </label>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {/* Wallets tab */}
            {activeTab === "wallets" && (
              <WalletsTab profile={profile} onProfileUpdate={setProfile} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function WalletsTab({
  profile,
  onProfileUpdate,
}: {
  profile: UserProfile | null;
  onProfileUpdate: (p: UserProfile) => void;
}) {
  const { publicKey, connected, signMessage, disconnect } = useWallet();
  const { setVisible } = useWalletModal();
  const [isLinking, setIsLinking] = useState(false);

  const handleConnectAndLink = async () => {
    if (!connected) {
      setVisible(true);
      return;
    }

    if (!publicKey || !signMessage) return;

    setIsLinking(true);
    try {
      const address = publicKey.toBase58();
      const message = `Link wallet ${address} to WheelsAI account at ${Date.now()}`;
      const encoded = new TextEncoder().encode(message);
      const signature = await signMessage(encoded);
      const sigBase64 = Buffer.from(signature).toString("base64");
      const result = await settingsApi.linkWallet(address, sigBase64, message);
      toast.success("Wallet linked successfully");
      if (profile) {
        onProfileUpdate({ ...profile, walletAddress: address });
      }
    } catch (err: any) {
      if (err?.message?.includes("User rejected")) {
        toast.error("Signature rejected");
      } else {
        toast.error("Failed to link wallet");
      }
    } finally {
      setIsLinking(false);
    }
  };

  // Auto-link when wallet connects and not yet linked
  useEffect(() => {
    if (connected && publicKey && !profile?.walletAddress && signMessage) {
      handleConnectAndLink();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, publicKey, profile?.walletAddress]);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Connected Wallets</CardTitle>
          <CardDescription>
            Manage your connected Solana wallets for authentication and payments
          </CardDescription>
        </CardHeader>
        <CardContent>
          {profile?.walletAddress ? (
            <div className="flex items-center justify-between rounded-lg border p-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-r from-green-400 to-purple-500">
                  <Wallet className="h-5 w-5 text-white" />
                </div>
                <div>
                  <p className="font-medium">Solana Wallet</p>
                  <code className="text-sm text-gray-500">
                    {profile.walletAddress.slice(0, 8)}...
                    {profile.walletAddress.slice(-8)}
                  </code>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="success">Connected</Badge>
                {connected && (
                  <button
                    onClick={() => disconnect()}
                    className="p-1.5 rounded-md hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
                    title="Disconnect wallet"
                  >
                    <Unlink className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="text-center py-8">
              <Wallet className="mx-auto h-12 w-12 text-gray-300" />
              <p className="mt-4 text-gray-500">No wallets connected</p>
              <Button
                className="mt-4"
                onClick={handleConnectAndLink}
                disabled={isLinking}
              >
                {isLinking ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Wallet className="mr-2 h-4 w-4" />
                )}
                {isLinking ? "Linking..." : "Connect Solana Wallet"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Agent Wallets</CardTitle>
          <CardDescription>
            Managed wallets for autonomous agent transactions (coming soon)
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-8 text-center">
            <AlertTriangle className="mx-auto h-8 w-8 text-gray-400" />
            <p className="mt-2 text-sm text-gray-500">
              Agent wallets will be available in a future update
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
