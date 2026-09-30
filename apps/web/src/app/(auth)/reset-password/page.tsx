"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authApi, getErrorMessage } from "@/lib/api";

interface ResetForm {
  password: string;
  confirmPassword: string;
}

function ResetPassword() {
  const router = useRouter();
  const token = useSearchParams().get("token");
  const [error, setError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<ResetForm>();

  async function onSubmit({ password }: ResetForm) {
    if (!token) return;
    setError(null);
    try {
      await authApi.resetPassword(token, password);
      toast.success("Password updated. Sign in with your new password.");
      router.push("/login");
    } catch (err) {
      setError(getErrorMessage(err, "We could not reset your password."));
    }
  }

  if (!token) {
    return (
      <p className="text-sm text-muted-foreground">
        This link is missing its token.{" "}
        <Link href="/forgot-password" className="text-primary-600 hover:underline">
          Request a new one
        </Link>
        .
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
      <div className="space-y-2">
        <Label htmlFor="password">New password</Label>
        <Input
          id="password"
          type="password"
          autoComplete="new-password"
          {...register("password", {
            required: "Password is required",
            minLength: { value: 8, message: "Password must be at least 8 characters" },
          })}
          error={errors.password?.message}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="confirmPassword">Confirm new password</Label>
        <Input
          id="confirmPassword"
          type="password"
          autoComplete="new-password"
          {...register("confirmPassword", {
            validate: (v) => v === watch("password") || "Passwords do not match",
          })}
          error={errors.confirmPassword?.message}
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}{" "}
          <Link href="/forgot-password" className="text-primary-600 hover:underline">
            Request a new link
          </Link>
        </p>
      )}
      <Button type="submit" className="w-full" isLoading={isSubmitting}>
        Set new password
      </Button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <Card className="w-full max-w-md">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl">Choose a new password</CardTitle>
        <CardDescription>The link from your email is valid for 30 minutes</CardDescription>
      </CardHeader>
      <CardContent>
        <Suspense fallback={null}>
          <ResetPassword />
        </Suspense>
      </CardContent>
    </Card>
  );
}
