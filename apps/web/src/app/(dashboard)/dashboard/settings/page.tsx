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
import bs58 from "bs58";

import { Header } from "@/components/dashboard/header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { settingsApi, authApi, type UserProfile, type UserSettings, getErrorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { apiRefusal, isWalletDecline } from "@/lib/wallet-topup";

type Tab = "profile" | "security" | "notifications" | "wallets";

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<Tab>("profile");
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Form state
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [emailPassword, setEmailPassword] = useState("");
  const [sendingVerification, setSendingVerification] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

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
      setLoadError(null);
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to load settings"));
      setLoadError(error);
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadSettings();
  }, []);

  function retryLoad() {
    setLoadError(null);
    setIsLoading(true);
    loadSettings();
  }

  async function handleSaveProfile() {
    setIsSaving(true);
    try {
      const emailChanged = email.trim().toLowerCase() !== (profile?.email ?? "").toLowerCase();
      const res = await settingsApi.updateProfile({
        displayName,
        ...(emailChanged ? { email, currentPassword: emailPassword || undefined } : {}),
      });
      setProfile(res.profile);
      setEmailPassword("");
      toast.success(
        emailChanged && res.verificationSent
          ? `Profile updated. We sent a verification link to ${res.profile.email}.`
          : "Profile updated"
      );
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to update profile"));
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
      toast.error(getErrorMessage(error, "Failed to change password"));
    } finally {
      setIsSaving(false);
    }
  }

  async function handleLogout() {
    try {
      await authApi.logout();
      window.location.href = "/login";
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to log out"));
    }
  }

  const tabs = [
    { id: "profile" as Tab, label: "Profile", icon: User },
    { id: "security" as Tab, label: "Password", icon: Shield },
    { id: "notifications" as Tab, label: "Notifications", icon: Bell },
    { id: "wallets" as Tab, label: "Wallets", icon: Wallet },
  ];

  if (isLoading) {
    return (
      <div className="flex flex-col">
        <Header title="Account" description="Manage your account and preferences" />
        <div className="p-8" aria-busy="true">
          <span className="sr-only">Loading settings</span>
          <div className="flex gap-8">
            {/* Sidebar skeleton: four tabs, then Log out */}
            <div className="w-48 shrink-0 space-y-1">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-9 w-full" />
              ))}
              <div className="pt-4">
                <Skeleton className="h-9 w-full" />
              </div>
            </div>
            {/* Profile card skeleton: four fields and the save button */}
            <div className="flex-1">
              <Card>
                <CardHeader>
                  <Skeleton className="h-6 w-48" />
                  <Skeleton className="h-4 w-72 max-w-full" />
                </CardHeader>
                <CardContent className="space-y-6">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="space-y-2">
                      <Skeleton className="h-4 w-28" />
                      <Skeleton className="h-10 w-full" />
                    </div>
                  ))}
                  <div className="flex justify-end">
                    <Skeleton className="h-10 w-36" />
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Profile and Wallets show the loaded profile, so a failed load replaces
  // them with the error. Security and Notifications don't read it, so they
  // (and the sidebar with Log out) stay usable.
  const showLoadError =
    loadError !== null && (activeTab === "profile" || activeTab === "wallets");

  return (
    <div className="flex flex-col">
      <Header
        title="Account"
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
                      ? "bg-primary/10 text-primary-700"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  )}
                >
                  <tab.icon className="h-4 w-4" />
                  {tab.label}
                </button>
              ))}

              <div className="pt-4">
                <button
                  onClick={handleLogout}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-500/10"
                >
                  <LogOut className="h-4 w-4" />
                  Log out
                </button>
              </div>
            </nav>
          </div>

          {/* Content */}
          <div className="flex-1">
            {showLoadError && (
              <ErrorState
                title="Couldn't load your profile"
                error={loadError}
                onRetry={retryLoad}
              />
            )}

            {/* Profile tab */}
            {activeTab === "profile" && !showLoadError && (
              <Card>
                <CardHeader>
                  <CardTitle>Profile Information</CardTitle>
                  <CardDescription>
                    Update your account details and public profile
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div>
                    <label className="block text-sm font-medium text-foreground">
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
                    <label className="block text-sm font-medium text-foreground">
                      Email Address
                    </label>
                    <Input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="mt-1"
                    />
                    {email.trim().toLowerCase() !== (profile?.email ?? "").toLowerCase() ? (
                      <div className="mt-3">
                        <label className="block text-sm font-medium text-foreground" htmlFor="email-current-password">
                          Current password
                        </label>
                        <Input
                          id="email-current-password"
                          type="password"
                          autoComplete="current-password"
                          value={emailPassword}
                          onChange={(e) => setEmailPassword(e.target.value)}
                          className="mt-1"
                        />
                        <p className="mt-1 text-xs text-muted-foreground">
                          Required to change the email on an account with a password.
                        </p>
                      </div>
                    ) : profile?.emailVerified ? (
                      <p className="mt-1 text-sm text-green-500">Verified</p>
                    ) : profile?.email ? (
                      <p className="mt-1 text-sm text-yellow-500">
                        Not verified.{" "}
                        <button
                          type="button"
                          className="underline disabled:opacity-60"
                          disabled={sendingVerification}
                          onClick={async () => {
                            setSendingVerification(true);
                            try {
                              await authApi.requestEmailVerification();
                              toast.success(`Verification link sent to ${profile.email}`);
                            } catch (err) {
                              toast.error(getErrorMessage(err, "Could not send the verification email"));
                            } finally {
                              setSendingVerification(false);
                            }
                          }}
                        >
                          Send verification email
                        </button>
                      </p>
                    ) : null}
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-foreground">
                      Account ID
                    </label>
                    <code className="mt-1 block rounded bg-muted px-3 py-2 text-sm">
                      {profile?.id}
                    </code>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-foreground">
                      Member Since
                    </label>
                    <p className="mt-1 text-muted-foreground">
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

            {/* Password tab (two-factor sign-in is the Security page) */}
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
                      <label className="block text-sm font-medium text-foreground">
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
                      <label className="block text-sm font-medium text-foreground">
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
                      <label className="block text-sm font-medium text-foreground">
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
                        <p className="text-sm text-muted-foreground">
                          Use an authenticator app to generate one-time codes
                        </p>
                      </div>
                      <a href="/dashboard/settings/security">
                        <Button variant="outline">Configure 2FA</Button>
                      </a>
                    </div>
                  </CardContent>
                </Card>

                <Card className="border-red-500/30">
                  <CardHeader>
                    <CardTitle className="text-red-600">Danger Zone</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-medium">Delete Account</p>
                        <p className="text-sm text-muted-foreground">
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
                        <p className="text-sm text-muted-foreground">
                          {notification.description}
                        </p>
                      </div>
                      <label className="relative inline-flex cursor-pointer items-center">
                        <input
                          type="checkbox"
                          className="peer sr-only"
                          defaultChecked={notification.id !== "product_updates"}
                        />
                        <div className="peer h-6 w-11 rounded-full bg-input after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-border after:bg-white after:transition-all after:content-[''] peer-checked:bg-primary-600 peer-checked:after:translate-x-full peer-checked:after:border-white peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-primary/40"></div>
                      </label>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {/* Wallets tab */}
            {activeTab === "wallets" && !showLoadError && (
              <WalletsTab profile={profile} onProfileUpdate={setProfile} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// What the Wallets tab says itself, for what the API cannot see.
const LINK_DECLINED = "You cancelled the request in your wallet. Nothing was linked.";
const LINK_NOT_SIGNED = "Your wallet did not sign the request. Nothing was linked. Try again.";
const LINK_CANNOT_SIGN = "This wallet cannot sign a message. Connect a different wallet.";
const LINK_NO_ANSWER = "The wallet could not be linked. Try again.";

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
  const [linkLine, setLinkLine] = useState<{ message: string; ok: boolean } | null>(null);

  const connectedAddress = connected && publicKey ? publicKey.toBase58() : null;

  // Linking happens only when this button is pressed. The wallet signs the
  // one-time text the API hands out, the same way it does to sign in.
  const handleLink = async () => {
    if (!publicKey || isLinking) return;
    if (!signMessage) {
      setLinkLine({ message: LINK_CANNOT_SIGN, ok: false });
      return;
    }

    const address = publicKey.toBase58();
    setIsLinking(true);
    setLinkLine(null);
    try {
      let nonce: string;
      try {
        ({ nonce } = await settingsApi.linkWalletNonce(address));
      } catch (err) {
        setLinkLine({ message: apiRefusal(err)?.message ?? LINK_NO_ANSWER, ok: false });
        return;
      }

      let signature: string;
      try {
        signature = bs58.encode(await signMessage(new TextEncoder().encode(nonce)));
      } catch (err) {
        // The wallet's own error text is not shown.
        setLinkLine({ message: isWalletDecline(err) ? LINK_DECLINED : LINK_NOT_SIGNED, ok: false });
        return;
      }

      try {
        const result = await settingsApi.linkWallet(address, signature, nonce);
        setLinkLine({ message: result.message || "Wallet linked.", ok: true });
        if (profile) {
          onProfileUpdate({ ...profile, walletAddress: result.walletAddress || address });
        }
      } catch (err) {
        setLinkLine({ message: apiRefusal(err)?.message ?? LINK_NO_ANSWER, ok: false });
      }
    } finally {
      setIsLinking(false);
    }
  };

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
            <div className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-r from-green-400 to-purple-500">
                  <Wallet className="h-5 w-5 text-white" />
                </div>
                <div className="min-w-0">
                  <p className="font-medium">Solana Wallet</p>
                  <code className="text-sm text-muted-foreground">
                    {profile.walletAddress.slice(0, 8)}...
                    {profile.walletAddress.slice(-8)}
                  </code>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="success">Linked</Badge>
                {connected && (
                  <button
                    onClick={() => disconnect()}
                    className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    title="Disconnect wallet"
                    aria-label="Disconnect wallet"
                  >
                    <Unlink className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
          ) : connectedAddress ? (
            <div className="rounded-lg border p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted">
                    <Wallet className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <div className="min-w-0">
                    <p className="font-medium">Connected in this browser</p>
                    <code className="text-sm text-muted-foreground">
                      {connectedAddress.slice(0, 8)}...
                      {connectedAddress.slice(-8)}
                    </code>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button onClick={handleLink} disabled={isLinking}>
                    {isLinking ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Wallet className="mr-2 h-4 w-4" />
                    )}
                    {isLinking ? "Linking..." : "Link this wallet"}
                  </Button>
                  <Button variant="ghost" onClick={() => disconnect()} disabled={isLinking}>
                    Disconnect
                  </Button>
                </div>
              </div>
              <p className="mt-3 text-sm text-muted-foreground">
                Linking lets this wallet sign in to this account. Your wallet signs a short
                message to show it is yours. No transfer is made.
              </p>
            </div>
          ) : (
            <div className="py-8 text-center">
              <Wallet className="mx-auto h-12 w-12 text-muted-foreground" />
              <p className="mt-4 text-muted-foreground">No wallet linked</p>
              <Button className="mt-4" onClick={() => setVisible(true)}>
                <Wallet className="mr-2 h-4 w-4" />
                Connect Solana Wallet
              </Button>
            </div>
          )}

          <div role="status" aria-live="polite">
            {linkLine && (
              <p
                className={cn(
                  "mt-4 break-words rounded-lg border px-4 py-3 text-sm text-foreground",
                  linkLine.ok ? "border-green-500/30 bg-green-500/10" : "border-red-500/30 bg-red-500/10"
                )}
              >
                {linkLine.message}
              </p>
            )}
          </div>
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
          <div className="rounded-lg border border-dashed border-border bg-muted p-8 text-center">
            <AlertTriangle className="mx-auto h-8 w-8 text-gray-400" />
            <p className="mt-2 text-sm text-muted-foreground">
              Agent wallets will be available in a future update
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
