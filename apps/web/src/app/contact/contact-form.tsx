"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { CheckCircle2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { contactApi, getErrorMessage } from "@/lib/api";

interface ContactFormValues {
  name: string;
  email: string;
  company: string;
  topic: "enterprise" | "support" | "other";
  message: string;
}

export function ContactForm() {
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<ContactFormValues>({ defaultValues: { topic: "enterprise" } });

  useEffect(() => {
    const topic = new URLSearchParams(window.location.search).get("topic");
    if (topic === "support" || topic === "other" || topic === "enterprise") setValue("topic", topic);
  }, [setValue]);

  async function onSubmit(values: ContactFormValues) {
    setError(null);
    try {
      await contactApi.submit({ ...values, company: values.company || undefined });
      setDone(true);
    } catch (err) {
      setError(getErrorMessage(err, "Could not send your message. Please try again."));
    }
  }

  if (done) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
          <CheckCircle2 className="h-10 w-10 text-success" aria-hidden />
          <p className="text-lg font-semibold">Thanks, we have your message.</p>
          <p className="text-sm text-muted-foreground">We will reply to the email you gave us.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="pt-6">
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input id="name" autoComplete="name" {...register("name", { required: "Name is required" })} error={errors.name?.message} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Work email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                {...register("email", { required: "Email is required" })}
                error={errors.email?.message}
              />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="company">Company</Label>
              <Input id="company" autoComplete="organization" {...register("company")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="topic">Topic</Label>
              <Select id="topic" {...register("topic")}>
                <option value="enterprise">Enterprise plan</option>
                <option value="support">Support</option>
                <option value="other">Something else</option>
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="message">What are you building?</Label>
            <Textarea
              id="message"
              rows={6}
              {...register("message", {
                required: "Tell us a little about what you need",
                minLength: { value: 10, message: "A little more detail, please" },
              })}
              error={errors.message?.message}
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <Button type="submit" className="w-full" isLoading={isSubmitting}>
            Send message
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
