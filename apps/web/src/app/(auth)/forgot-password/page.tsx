"use client";

import { useState } from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { MailCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authApi, getErrorMessage } from "@/lib/api";

export default function ForgotPasswordPage() {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<{ email: string }>();

  async function onSubmit({ email }: { email: string }) {
    setError(null);
    try {
      await authApi.forgotPassword(email);
      setSentTo(email);
    } catch (err) {
      setError(getErrorMessage(err, "We could not send the reset email. Please try again."));
    }
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl">Reset your password</CardTitle>
        <CardDescription>We will email you a link to choose a new one</CardDescription>
      </CardHeader>
      <CardContent>
        {sentTo ? (
          <div className="flex flex-col items-center gap-3 text-center">
            <MailCheck className="h-10 w-10 text-primary" aria-hidden />
            <p className="text-sm text-foreground">
              If an account uses <span className="font-medium">{sentTo}</span>, a reset link is on its
              way. It expires in 30 minutes.
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                {...register("email", { required: "Email is required" })}
                error={errors.email?.message}
              />
            </div>
            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}
            <Button type="submit" className="w-full" isLoading={isSubmitting}>
              Send reset link
            </Button>
          </form>
        )}
        <p className="mt-6 text-center text-sm text-muted-foreground">
          Remembered it?{" "}
          <Link href="/login" className="font-medium text-primary-600 hover:underline">
            Sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
