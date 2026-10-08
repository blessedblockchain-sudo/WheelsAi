"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  Shield,
  ShieldCheck,
  ShieldOff,
  KeyRound,
  QrCode,
  Copy,
  Check,
  AlertTriangle,
  RefreshCw,
  Mail,
  Eye,
  EyeOff,
  ChevronRight,
  Lock,
  Loader2,
  ArrowLeft,
} from "lucide-react";
import {
  twoFactorApi,
  type TwoFactorStatus,
  type TwoFactorSetup,
} from "@/lib/api";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";

// ---------------------------------------------------------------------------
// OTP Input Component
// ---------------------------------------------------------------------------

function OtpInput({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (val: string) => void;
  disabled?: boolean;
}) {
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const digits = value.padEnd(6, "").split("").slice(0, 6);

  const focusInput = useCallback((index: number) => {
    inputRefs.current[index]?.focus();
  }, []);

  function handleChange(index: number, char: string) {
    if (!/^\d?$/.test(char)) return;
    const next = digits.slice();
    next[index] = char;
    const joined = next.join("").replace(/ /g, "");
    onChange(joined);
    if (char && index < 5) {
      focusInput(index + 1);
    }
  }

  function handleKeyDown(index: number, e: React.KeyboardEvent) {
    if (e.key === "Backspace" && !digits[index] && index > 0) {
      focusInput(index - 1);
    }
    if (e.key === "ArrowLeft" && index > 0) {
      focusInput(index - 1);
    }
    if (e.key === "ArrowRight" && index < 5) {
      focusInput(index + 1);
    }
  }

  function handlePaste(e: React.ClipboardEvent) {
    e.preventDefault();
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    onChange(pasted);
    const target = Math.min(pasted.length, 5);
    focusInput(target);
  }

  return (
    <div className="flex items-center gap-2">
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => { inputRefs.current[i] = el; }}
          type="text"
          inputMode="numeric"
          maxLength={1}
          value={d.trim()}
          disabled={disabled}
          onChange={(e) => handleChange(i, e.target.value)}
          onKeyDown={(e) => handleKeyDown(i, e)}
          onPaste={i === 0 ? handlePaste : undefined}
          className="h-12 w-12 rounded-lg border border-border bg-background text-center text-xl font-mono text-primary
                     focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/50
                     disabled:opacity-40 transition-colors"
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

type SetupStep = "idle" | "qr" | "verify" | "backup";
type ModalMode = "disable" | "regenerate" | null;

export default function SecuritySettingsPage() {
  // Status
  const [status, setStatus] = useState<TwoFactorStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);

  // Setup flow
  const [setupStep, setSetupStep] = useState<SetupStep>("idle");
  const [setupData, setSetupData] = useState<TwoFactorSetup | null>(null);
  const [setupLoading, setSetupLoading] = useState(false);

  // Verification / disable / regenerate
  const [otpCode, setOtpCode] = useState("");
  const [verifying, setVerifying] = useState(false);

  // Backup codes
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [copiedCodes, setCopiedCodes] = useState(false);

  // Secret visibility
  const [showSecret, setShowSecret] = useState(false);
  const [copiedSecret, setCopiedSecret] = useState(false);

  // Modal for disable / regenerate
  const [modalMode, setModalMode] = useState<ModalMode>(null);
  const [modalOtp, setModalOtp] = useState("");
  const [modalLoading, setModalLoading] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  // Recovery email
  const [recoveryEmail, setRecoveryEmail] = useState("");
  const [savingEmail, setSavingEmail] = useState(false);
  const [emailSaved, setEmailSaved] = useState(false);

  // -----------------------------------------------------------------------
  // Load status
  // -----------------------------------------------------------------------

  useEffect(() => {
    loadStatus();
  }, []);

  async function loadStatus() {
    try {
      setLoading(true);
      setError(null);
      setLoadError(null);
      const data = await twoFactorApi.getStatus();
      setStatus(data);
      setRecoveryEmail(data.recoveryEmail || "");
    } catch (err) {
      // Shown by the <ErrorState> in place of the status cards.
      setLoadError(err);
    } finally {
      setLoading(false);
    }
  }

  // -----------------------------------------------------------------------
  // Setup flow
  // -----------------------------------------------------------------------

  async function startSetup() {
    try {
      setSetupLoading(true);
      setError(null);
      const data = await twoFactorApi.setup();
      setSetupData(data);
      setBackupCodes(data.backupCodes);
      setSetupStep("qr");
    } catch (err) {
      setError("Failed to initialize two-factor setup.");
    } finally {
      setSetupLoading(false);
    }
  }

  async function verifySetup() {
    if (otpCode.length !== 6) return;
    try {
      setVerifying(true);
      setError(null);
      await twoFactorApi.verifySetup(otpCode);
      setSetupStep("backup");
    } catch (err) {
      setError("Invalid verification code. Please try again.");
    } finally {
      setVerifying(false);
    }
  }

  function finishSetup() {
    setSetupStep("idle");
    setSetupData(null);
    setOtpCode("");
    setShowSecret(false);
    setCopiedSecret(false);
    setCopiedCodes(false);
    loadStatus();
  }

  function cancelSetup() {
    setSetupStep("idle");
    setSetupData(null);
    setOtpCode("");
    setError(null);
    setShowSecret(false);
    setCopiedSecret(false);
  }

  // -----------------------------------------------------------------------
  // Disable 2FA
  // -----------------------------------------------------------------------

  async function handleDisable() {
    if (modalOtp.length !== 6) return;
    try {
      setModalLoading(true);
      setModalError(null);
      await twoFactorApi.disable(modalOtp);
      setModalMode(null);
      setModalOtp("");
      loadStatus();
    } catch (err) {
      setModalError("Invalid code. Please try again.");
    } finally {
      setModalLoading(false);
    }
  }

  // -----------------------------------------------------------------------
  // Regenerate backup codes
  // -----------------------------------------------------------------------

  async function handleRegenerate() {
    if (modalOtp.length !== 6) return;
    try {
      setModalLoading(true);
      setModalError(null);
      const data = await twoFactorApi.regenerateBackupCodes(modalOtp);
      setBackupCodes(data.backupCodes);
      setModalMode(null);
      setModalOtp("");
      setCopiedCodes(false);
      loadStatus();
    } catch (err) {
      setModalError("Invalid code. Please try again.");
    } finally {
      setModalLoading(false);
    }
  }

  // -----------------------------------------------------------------------
  // Recovery email
  // -----------------------------------------------------------------------

  async function handleSaveRecoveryEmail() {
    if (!recoveryEmail) return;
    try {
      setSavingEmail(true);
      setError(null);
      await twoFactorApi.setRecoveryEmail(recoveryEmail);
      setEmailSaved(true);
      setTimeout(() => setEmailSaved(false), 3000);
    } catch (err) {
      setError("Failed to update recovery email.");
    } finally {
      setSavingEmail(false);
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
  }

  function copyAllBackupCodes() {
    const text = backupCodes.join("\n");
    navigator.clipboard.writeText(text);
    setCopiedCodes(true);
    setTimeout(() => setCopiedCodes(false), 3000);
  }

  function copySecret() {
    if (setupData?.secret) {
      navigator.clipboard.writeText(setupData.secret);
      setCopiedSecret(true);
      setTimeout(() => setCopiedSecret(false), 3000);
    }
  }

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  // Regenerating invalidates the old codes on the server, so the new ones must
  // stay on screen whatever the status refresh that follows does: while it is
  // loading, and next to the <ErrorState> when it fails.
  const backupCodesCard =
    setupStep === "idle" &&
    backupCodes.length > 0 &&
    (status === null || status.isEnabled) ? (
      <div className="rounded-xl border border-border bg-card p-6 space-y-4">
        <div className="flex items-center gap-3">
          <KeyRound className="h-5 w-5 text-primary" />
          <h3 className="text-lg font-semibold text-gray-100">Backup Codes</h3>
        </div>

        <div className="flex items-start gap-3 rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-4 py-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-yellow-400" />
          <p className="text-sm text-yellow-200">
            Save these codes in a secure location. They will not be shown again.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2">
          {backupCodes.map((code, i) => (
            <div
              key={i}
              className="rounded-md border border-border bg-background px-3 py-2 text-center font-mono text-sm text-gray-300"
            >
              {code}
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between">
          <button
            onClick={copyAllBackupCodes}
            className="flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm text-gray-300
                       hover:border-primary/40 hover:text-primary transition-colors"
          >
            {copiedCodes ? (
              <Check className="h-4 w-4 text-primary" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
            {copiedCodes ? "Copied" : "Copy All"}
          </button>
          <button
            onClick={() => { setBackupCodes([]); setCopiedCodes(false); }}
            className="rounded-lg px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors"
          >
            Dismiss
          </button>
        </div>
      </div>
    ) : null;

  if (loading) {
    return (
      <div className="min-h-full bg-background p-6 md:p-8">
        <div className="mx-auto max-w-3xl space-y-8" aria-busy="true">
          {/* Breadcrumb */}
          <Skeleton className="h-4 w-32" />

          {/* Header */}
          <div className="flex items-center gap-4">
            <Skeleton className="h-12 w-12 shrink-0 rounded-xl" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-7 w-52 max-w-full" />
              <Skeleton className="h-4 w-80 max-w-full" />
            </div>
          </div>

          {/* Two-factor status card */}
          <div className="rounded-xl border border-border bg-card p-6 space-y-6">
            <div className="flex items-center justify-between gap-4">
              <div className="flex min-w-0 flex-1 items-center gap-4">
                <Skeleton className="h-10 w-10 shrink-0 rounded-lg" />
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-5 w-56 max-w-full" />
                  <Skeleton className="h-4 w-72 max-w-full" />
                </div>
              </div>
              <Skeleton className="h-6 w-20 shrink-0 rounded-full" />
            </div>
            <Skeleton className="h-36 w-full rounded-lg" />
            <Skeleton className="h-10 w-64 max-w-full" />
          </div>

          {backupCodesCard}

          {/* Recovery email card */}
          <div className="rounded-xl border border-border bg-card p-6 space-y-4">
            <div className="flex items-center gap-3">
              <Skeleton className="h-5 w-5 shrink-0" />
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-5 w-36" />
                <Skeleton className="h-4 w-96 max-w-full" />
              </div>
            </div>
            <div className="flex flex-col sm:flex-row gap-3">
              <Skeleton className="h-10 w-full sm:flex-1" />
              <Skeleton className="h-10 w-full sm:w-20" />
            </div>
          </div>
          {/* Last, so the breadcrumb is the first spaced child as on the real page */}
          <span className="sr-only">Loading security settings</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full bg-background p-6 md:p-8">
      <div className="mx-auto max-w-3xl space-y-8">
        {/* Breadcrumb */}
        <nav className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="hover:text-primary transition-colors cursor-pointer">
            Settings
          </span>
          <ChevronRight className="h-3.5 w-3.5" />
          <span className="text-primary">Security</span>
        </nav>

        {/* Header */}
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 border border-primary/20">
            <Shield className="h-6 w-6 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-100">Security</h1>
            <p className="text-sm text-muted-foreground">
              Manage two-factor authentication and account recovery
            </p>
          </div>
        </div>

        {/* Global error */}
        {error && (
          <div className="flex items-center gap-3 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3">
            <AlertTriangle className="h-5 w-5 shrink-0 text-red-400" />
            <p className="text-sm text-red-300">{error}</p>
          </div>
        )}

        {/* Status failed to load: replaces the status and recovery cards */}
        {setupStep === "idle" && loadError !== null && (
          <ErrorState
            title="Couldn't load two-factor authentication status"
            error={loadError}
            onRetry={loadStatus}
          />
        )}

        {/* ----------------------------------------------------------------- */}
        {/* Setup flow overlay */}
        {/* ----------------------------------------------------------------- */}
        {setupStep !== "idle" && setupData && (
          <div className="rounded-xl border border-border bg-card p-6 space-y-6">
            {/* Step indicator */}
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                {[1, 2, 3].map((step) => {
                  const stepMap: Record<number, SetupStep> = { 1: "qr", 2: "verify", 3: "backup" };
                  const currentIdx = setupStep === "qr" ? 1 : setupStep === "verify" ? 2 : 3;
                  const isActive = step === currentIdx;
                  const isComplete = step < currentIdx;
                  return (
                    <div key={step} className="flex items-center gap-2">
                      <div
                        className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold transition-colors ${
                          isComplete
                            ? "bg-primary text-primary-foreground"
                            : isActive
                              ? "border-2 border-primary text-primary"
                              : "border border-border text-muted-foreground"
                        }`}
                      >
                        {isComplete ? <Check className="h-4 w-4" /> : step}
                      </div>
                      {step < 3 && (
                        <div
                          className={`h-px w-8 ${
                            isComplete ? "bg-primary" : "bg-border"
                          }`}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
              <span className="ml-2 text-sm text-gray-400">
                {setupStep === "qr" && "Scan QR Code"}
                {setupStep === "verify" && "Verify Code"}
                {setupStep === "backup" && "Save Backup Codes"}
              </span>
            </div>

            {/* Step 1: QR Code */}
            {setupStep === "qr" && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-lg font-semibold text-gray-100">
                    Scan QR Code
                  </h3>
                  <p className="mt-1 text-sm text-gray-400">
                    Open your authenticator app (Google Authenticator, Authy, 1Password, etc.)
                    and scan the QR code below.
                  </p>
                </div>

                {/* QR Code */}
                <div className="flex flex-col items-center gap-4">
                  <div className="rounded-xl border border-border bg-white p-4">
                    {/* eslint-disable-next-line @next/next/no-img-element -- URL comes from the API at runtime; next/image would need its host allowlisted */}
                    <img
                      src={setupData.qrCodeUrl}
                      alt="Two-factor authentication QR code"
                      className="h-48 w-48"
                    />
                  </div>
                </div>

                {/* Manual entry */}
                <div className="rounded-lg border border-border bg-background p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <KeyRound className="h-4 w-4 text-gray-400" />
                    <span className="text-sm font-medium text-gray-300">
                      Manual entry key
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 rounded-md bg-card px-3 py-2 font-mono text-sm text-primary break-all">
                      {showSecret ? setupData.secret : setupData.secret.replace(/./g, "\u2022")}
                    </code>
                    <button
                      onClick={() => setShowSecret(!showSecret)}
                      className="rounded-md p-2 text-gray-400 hover:bg-border hover:text-gray-200 transition-colors"
                      title={showSecret ? "Hide secret" : "Show secret"}
                    >
                      {showSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                    <button
                      onClick={copySecret}
                      className="rounded-md p-2 text-gray-400 hover:bg-border hover:text-gray-200 transition-colors"
                      title="Copy secret"
                    >
                      {copiedSecret ? (
                        <Check className="h-4 w-4 text-primary" />
                      ) : (
                        <Copy className="h-4 w-4" />
                      )}
                    </button>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center justify-between">
                  <button
                    onClick={cancelSetup}
                    className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors"
                  >
                    <ArrowLeft className="h-4 w-4" />
                    Cancel
                  </button>
                  <button
                    onClick={() => { setSetupStep("verify"); setOtpCode(""); }}
                    className="rounded-lg bg-primary px-6 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors"
                  >
                    Continue
                  </button>
                </div>
              </div>
            )}

            {/* Step 2: Verify */}
            {setupStep === "verify" && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-lg font-semibold text-gray-100">
                    Verify Setup
                  </h3>
                  <p className="mt-1 text-sm text-gray-400">
                    Enter the 6-digit code from your authenticator app to confirm setup.
                  </p>
                </div>

                <div className="flex flex-col items-center gap-4">
                  <OtpInput value={otpCode} onChange={setOtpCode} disabled={verifying} />
                </div>

                <div className="flex items-center justify-between">
                  <button
                    onClick={() => { setSetupStep("qr"); setOtpCode(""); setError(null); }}
                    className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors"
                  >
                    <ArrowLeft className="h-4 w-4" />
                    Back
                  </button>
                  <button
                    onClick={verifySetup}
                    disabled={otpCode.length !== 6 || verifying}
                    className="flex items-center gap-2 rounded-lg bg-primary px-6 py-2 text-sm font-semibold text-primary-foreground
                               hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    {verifying && <Loader2 className="h-4 w-4 animate-spin" />}
                    Verify
                  </button>
                </div>
              </div>
            )}

            {/* Step 3: Backup Codes */}
            {setupStep === "backup" && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-lg font-semibold text-gray-100">
                    Save Your Backup Codes
                  </h3>
                  <p className="mt-1 text-sm text-gray-400">
                    Store these codes in a safe place. Each code can only be used once.
                    If you lose access to your authenticator app, you can use a backup code to sign in.
                  </p>
                </div>

                <div className="flex items-start gap-3 rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-4 py-3">
                  <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-yellow-400" />
                  <p className="text-sm text-yellow-200">
                    These codes will only be shown once. Make sure to save them now.
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  {backupCodes.map((code, i) => (
                    <div
                      key={i}
                      className="rounded-md border border-border bg-background px-3 py-2 text-center font-mono text-sm text-gray-300"
                    >
                      {code}
                    </div>
                  ))}
                </div>

                <div className="flex items-center justify-between">
                  <button
                    onClick={copyAllBackupCodes}
                    className="flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm text-gray-300
                               hover:border-primary/40 hover:text-primary transition-colors"
                  >
                    {copiedCodes ? (
                      <Check className="h-4 w-4 text-primary" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                    {copiedCodes ? "Copied" : "Copy All"}
                  </button>
                  <button
                    onClick={finishSetup}
                    className="rounded-lg bg-primary px-6 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors"
                  >
                    Done
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ----------------------------------------------------------------- */}
        {/* 2FA Status (shown when not in setup flow) */}
        {/* ----------------------------------------------------------------- */}
        {setupStep === "idle" && status && loadError === null && (
            <div className="rounded-xl border border-border bg-card p-6 space-y-6">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div
                    className={`flex h-10 w-10 items-center justify-center rounded-lg ${
                      status.isEnabled
                        ? "bg-primary/10 text-primary"
                        : "bg-gray-800 text-muted-foreground"
                    }`}
                  >
                    {status.isEnabled ? (
                      <ShieldCheck className="h-5 w-5" />
                    ) : (
                      <ShieldOff className="h-5 w-5" />
                    )}
                  </div>
                  <div>
                    <h2 className="text-lg font-semibold text-gray-100">
                      Two-Factor Authentication
                    </h2>
                    <p className="text-sm text-gray-400">
                      {status.isEnabled
                        ? "Your account is protected with 2FA"
                        : "Add an extra layer of security to your account"}
                    </p>
                  </div>
                </div>
                <span
                  className={`rounded-full px-3 py-1 text-xs font-medium ${
                    status.isEnabled
                      ? "bg-primary/10 text-primary border border-primary/20"
                      : "bg-gray-800 text-gray-400 border border-border"
                  }`}
                >
                  {status.isEnabled ? "Enabled" : "Disabled"}
                </span>
              </div>

              {/* If NOT enabled */}
              {!status.isEnabled && (
                <div className="space-y-4">
                  <div className="rounded-lg border border-border bg-background p-4 space-y-3">
                    <p className="text-sm text-gray-300">
                      Two-factor authentication adds a second layer of security to your
                      account by requiring a time-based one-time password (TOTP) in addition to
                      your regular password.
                    </p>
                    <ul className="space-y-2 text-sm text-gray-400">
                      <li className="flex items-center gap-2">
                        <Lock className="h-3.5 w-3.5 text-primary" />
                        Protect against unauthorized access even if your password is compromised
                      </li>
                      <li className="flex items-center gap-2">
                        <KeyRound className="h-3.5 w-3.5 text-primary" />
                        Works with standard authenticator apps (Google Authenticator, Authy, etc.)
                      </li>
                      <li className="flex items-center gap-2">
                        <QrCode className="h-3.5 w-3.5 text-primary" />
                        Quick setup with QR code scanning
                      </li>
                    </ul>
                  </div>

                  <button
                    onClick={startSetup}
                    disabled={setupLoading}
                    className="flex items-center gap-2 rounded-lg bg-primary px-6 py-2.5 text-sm font-semibold text-primary-foreground
                               hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    {setupLoading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <ShieldCheck className="h-4 w-4" />
                    )}
                    Enable Two-Factor Authentication
                  </button>
                </div>
              )}

              {/* If enabled: details */}
              {status.isEnabled && (
                <div className="space-y-4">
                  {/* Status details */}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <div className="rounded-lg border border-border bg-background p-4">
                      <p className="text-xs text-muted-foreground uppercase tracking-wider">Method</p>
                      <p className="mt-1 text-sm font-medium text-gray-200">
                        {status.lastMethod || "TOTP"}
                      </p>
                    </div>
                    <div className="rounded-lg border border-border bg-background p-4">
                      <p className="text-xs text-muted-foreground uppercase tracking-wider">Last Used</p>
                      <p className="mt-1 text-sm font-medium text-gray-200">
                        {status.lastUsedAt
                          ? new Date(status.lastUsedAt).toLocaleDateString(undefined, {
                              month: "short",
                              day: "numeric",
                              year: "numeric",
                            })
                          : "Never"}
                      </p>
                    </div>
                    <div className="rounded-lg border border-border bg-background p-4">
                      <p className="text-xs text-muted-foreground uppercase tracking-wider">Backup Codes</p>
                      <p className="mt-1 text-sm font-medium text-gray-200">
                        {status.backupCodesRemaining ?? 0} remaining
                      </p>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex flex-wrap gap-3">
                    <button
                      onClick={() => { setModalMode("regenerate"); setModalOtp(""); setModalError(null); }}
                      className="flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm text-gray-300
                                 hover:border-primary/40 hover:text-primary transition-colors"
                    >
                      <RefreshCw className="h-4 w-4" />
                      Regenerate Backup Codes
                    </button>
                    <button
                      onClick={() => { setModalMode("disable"); setModalOtp(""); setModalError(null); }}
                      className="flex items-center gap-2 rounded-lg border border-red-500/30 px-4 py-2 text-sm text-red-400
                                 hover:border-red-500/60 hover:bg-red-500/10 transition-colors"
                    >
                      <ShieldOff className="h-4 w-4" />
                      Disable 2FA
                    </button>
                  </div>
                </div>
              )}
            </div>
        )}

        {/* Backup codes display (after regeneration) */}
        {backupCodesCard}

        {/* Recovery Email */}
        {setupStep === "idle" && status && loadError === null && (
            <div className="rounded-xl border border-border bg-card p-6 space-y-4">
              <div className="flex items-center gap-3">
                <Mail className="h-5 w-5 text-primary" />
                <div>
                  <h3 className="text-lg font-semibold text-gray-100">Recovery Email</h3>
                  <p className="text-sm text-gray-400">
                    Set a recovery email to regain access if you lose your authenticator device.
                  </p>
                </div>
              </div>

              <div className="flex flex-col sm:flex-row gap-3">
                <input
                  type="email"
                  value={recoveryEmail}
                  onChange={(e) => { setRecoveryEmail(e.target.value); setEmailSaved(false); }}
                  placeholder="recovery@example.com"
                  className="flex-1 rounded-lg border border-border bg-background px-4 py-2.5 text-sm text-gray-200
                             placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/50
                             transition-colors"
                />
                <button
                  onClick={handleSaveRecoveryEmail}
                  disabled={savingEmail || !recoveryEmail}
                  className="flex items-center justify-center gap-2 rounded-lg bg-primary/10 border border-primary/20 px-5 py-2.5
                             text-sm font-medium text-primary hover:bg-primary/20
                             disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {savingEmail ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : emailSaved ? (
                    <Check className="h-4 w-4" />
                  ) : null}
                  {emailSaved ? "Saved" : "Save"}
                </button>
              </div>
            </div>
        )}

        {/* ----------------------------------------------------------------- */}
        {/* Modal: Disable / Regenerate */}
        {/* ----------------------------------------------------------------- */}
        {modalMode && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-2xl space-y-5">
              <div className="flex items-center gap-3">
                {modalMode === "disable" ? (
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-red-500/10">
                    <ShieldOff className="h-5 w-5 text-red-400" />
                  </div>
                ) : (
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                    <RefreshCw className="h-5 w-5 text-primary" />
                  </div>
                )}
                <div>
                  <h3 className="text-lg font-semibold text-gray-100">
                    {modalMode === "disable" ? "Disable Two-Factor Authentication" : "Regenerate Backup Codes"}
                  </h3>
                  <p className="text-sm text-gray-400">
                    Enter your current TOTP code to confirm.
                  </p>
                </div>
              </div>

              {modalMode === "disable" && (
                <div className="flex items-start gap-3 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3">
                  <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-400" />
                  <p className="text-sm text-red-300">
                    This will remove the extra security layer from your account.
                    You can re-enable it at any time.
                  </p>
                </div>
              )}

              {modalMode === "regenerate" && (
                <div className="flex items-start gap-3 rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-4 py-3">
                  <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-yellow-400" />
                  <p className="text-sm text-yellow-200">
                    This will invalidate all existing backup codes and generate new ones.
                  </p>
                </div>
              )}

              {modalError && (
                <div className="flex items-center gap-3 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3">
                  <AlertTriangle className="h-4 w-4 shrink-0 text-red-400" />
                  <p className="text-sm text-red-300">{modalError}</p>
                </div>
              )}

              <div className="flex justify-center">
                <OtpInput value={modalOtp} onChange={setModalOtp} disabled={modalLoading} />
              </div>

              <div className="flex items-center justify-end gap-3">
                <button
                  onClick={() => { setModalMode(null); setModalOtp(""); setModalError(null); }}
                  className="rounded-lg px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={modalMode === "disable" ? handleDisable : handleRegenerate}
                  disabled={modalOtp.length !== 6 || modalLoading}
                  className={`flex items-center gap-2 rounded-lg px-5 py-2 text-sm font-semibold
                             disabled:opacity-40 disabled:cursor-not-allowed transition-colors ${
                               modalMode === "disable"
                                 ? "bg-red-600 text-white hover:bg-red-700"
                                 : "bg-primary text-primary-foreground hover:bg-primary/90"
                             }`}
                >
                  {modalLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                  {modalMode === "disable" ? "Disable 2FA" : "Regenerate"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
