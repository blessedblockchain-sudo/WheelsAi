"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { authApi, ApiError, isTwoFactorChallenge } from "@/lib/api";
import { WalletAuthButton } from "@/components/auth/wallet-auth-button";

interface LoginForm {
  email: string;
  password: string;
}

/**
 * Post-login destination. Honors ?next= from the dashboard middleware /
 * install CTAs, but only same-origin paths: must start with "/" and not
 * "//" (protocol-relative would be an open redirect).
 */
function safeNextPath(): string {
  if (typeof window === "undefined") return "/dashboard";
  const next = new URLSearchParams(window.location.search).get("next");
  if (next && next.startsWith("/") && !next.startsWith("//")) return next;
  return "/dashboard";
}

export default function LoginPage() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  // 2FA challenge state (B5): set when the first factor checks out but
  // the account needs a second one. No session exists until it clears.
  // Seeded from ?challenge= so the wallet flow can hand off here rather
  // than duplicating this step.
  const [challengeToken, setChallengeToken] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("challenge");
  });
  const [otp, setOtp] = useState("");

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginForm>();

  async function onSubmit(data: LoginForm) {
    setIsLoading(true);
    try {
      const res = await authApi.login(data.email, data.password);
      if (isTwoFactorChallenge(res)) {
        setChallengeToken(res.challengeToken);
        setOtp("");
        toast.info("Enter your authentication code to finish signing in.");
        return;
      }
      toast.success("Welcome back!");
      router.push(safeNextPath());
    } catch (error) {
      if (error instanceof ApiError) {
        const message =
          typeof error.data === "object" &&
          error.data !== null &&
          "message" in error.data &&
          typeof (error.data as { message?: unknown }).message === "string"
            ? (error.data as { message: string }).message
            : "Invalid email or password";
        toast.error(message);
      } else {
        toast.error("Something went wrong. Please try again.");
      }
    } finally {
      setIsLoading(false);
    }
  }

  async function onVerifyOtp(e: React.FormEvent) {
    e.preventDefault();
    if (!challengeToken || otp.trim().length < 6) return;
    setIsLoading(true);
    try {
      await authApi.completeTwoFactorLogin(challengeToken, otp.trim());
      toast.success("Welcome back!");
      router.push(safeNextPath());
    } catch (error) {
      // The challenge is single-use: a wrong code burns nothing, but an
      // expired or already-redeemed one must send the user back to the
      // password step rather than looping on a dead token.
      const status =
        error instanceof ApiError ? error.status : null;
      toast.error("Invalid or expired code. Please try again.");
      if (status === 401) setOtp("");
    } finally {
      setIsLoading(false);
    }
  }

  if (challengeToken) {
    return (
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Two-factor authentication</CardTitle>
          <CardDescription>
            Enter the 6-digit code from your authenticator app, or a backup
            code.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onVerifyOtp} className="space-y-4">
            <Input
              autoFocus
              inputMode="text"
              autoComplete="one-time-code"
              placeholder="123456"
              value={otp}
              onChange={(e) => setOtp(e.target.value)}
              className="text-center text-lg tracking-widest"
            />
            <Button
              type="submit"
              className="w-full"
              isLoading={isLoading}
              disabled={otp.trim().length < 6}
            >
              Verify and sign in
            </Button>
            <button
              type="button"
              onClick={() => {
                setChallengeToken(null);
                setOtp("");
              }}
              className="w-full text-sm text-gray-500 hover:text-gray-700"
            >
              Back to sign in
            </button>
          </form>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl">Welcome back</CardTitle>
        <CardDescription>
          Sign in to your account to continue
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-gray-700">
              Email
            </label>
            <Input
              id="email"
              type="email"
              placeholder="you@example.com"
              {...register("email", {
                required: "Email is required",
                pattern: {
                  value: /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i,
                  message: "Invalid email address",
                },
              })}
              error={errors.email?.message}
              className="mt-1"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-gray-700">
              Password
            </label>
            <Input
              id="password"
              type="password"
              placeholder="Enter your password"
              {...register("password", {
                required: "Password is required",
              })}
              error={errors.password?.message}
              className="mt-1"
            />
          </div>

          <Button type="submit" className="w-full" isLoading={isLoading}>
            Sign in
          </Button>
        </form>

        <div className="mt-6">
          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-gray-300" />
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="bg-card px-2 text-muted-foreground">Or continue with</span>
            </div>
          </div>

          <WalletAuthButton />
        </div>

        <p className="mt-6 text-center text-sm text-gray-500">
          Don&apos;t have an account?{" "}
          <Link href="/register" className="font-medium text-primary-600 hover:underline">
            Sign up
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
