"use client";

import { useEffect, useState } from "react";
import { Palette, Save } from "lucide-react";
import { toast } from "sonner";

import { Header } from "@/components/dashboard/header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { settingsApi, getErrorMessage } from "@/lib/api";
import { useBranding } from "@/components/providers/branding-provider";

interface BrandingForm {
  appName: string;
  logo: string;
  favicon: string;
  primaryColor: string;
  accentColor: string;
  supportEmail: string;
}

export default function BrandingSettingsPage() {
  const { branding, refresh } = useBranding();
  const [form, setForm] = useState<BrandingForm>({
    appName: "",
    logo: "",
    favicon: "",
    primaryColor: "",
    accentColor: "",
    supportEmail: "",
  });
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setForm({
      appName: (branding as any).appName ?? "",
      logo: (branding as any).logo ?? "",
      favicon: (branding as any).favicon ?? "",
      primaryColor: (branding as any).primaryColor ?? "",
      accentColor: (branding as any).accentColor ?? "",
      supportEmail: (branding as any).supportEmail ?? "",
    });
  }, [branding]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const data: Record<string, string> = {};
      if (form.appName) data.appName = form.appName;
      if (form.logo) data.logo = form.logo;
      if (form.favicon) data.favicon = form.favicon;
      if (form.primaryColor) data.primaryColor = form.primaryColor;
      if (form.accentColor) data.accentColor = form.accentColor;
      if (form.supportEmail) data.supportEmail = form.supportEmail;

      await settingsApi.updateBranding(data);
      await refresh();
      toast.success("Branding updated");
    } catch (err: any) {
      toast.error(getErrorMessage(err, "Failed to update branding"));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="flex flex-col">
      <Header title="Branding" description="Customize your organization's appearance" />

      <div className="p-8 max-w-2xl">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Palette className="h-5 w-5" />
              White-label Settings
            </CardTitle>
            <CardDescription>
              Customize the look and feel for your organization
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div>
              <label className="text-sm font-medium text-foreground">
                App Name
              </label>
              <Input
                value={form.appName}
                onChange={(e) => setForm({ ...form, appName: e.target.value })}
                placeholder="WheelsAI"
                className="mt-1"
              />
            </div>

            <div>
              <label className="text-sm font-medium text-foreground">
                Logo URL
              </label>
              <Input
                value={form.logo}
                onChange={(e) => setForm({ ...form, logo: e.target.value })}
                placeholder="https://example.com/logo.svg"
                className="mt-1"
              />
            </div>

            <div>
              <label className="text-sm font-medium text-foreground">
                Favicon URL
              </label>
              <Input
                value={form.favicon}
                onChange={(e) => setForm({ ...form, favicon: e.target.value })}
                placeholder="https://example.com/favicon.ico"
                className="mt-1"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium text-foreground">
                  Primary Color
                </label>
                <div className="mt-1 flex gap-2">
                  <Input
                    value={form.primaryColor}
                    onChange={(e) => setForm({ ...form, primaryColor: e.target.value })}
                    placeholder="#3b82f6"
                  />
                  {form.primaryColor && (
                    <div
                      className="h-10 w-10 shrink-0 rounded-md border"
                      style={{ backgroundColor: form.primaryColor }}
                    />
                  )}
                </div>
              </div>

              <div>
                <label className="text-sm font-medium text-foreground">
                  Accent Color
                </label>
                <div className="mt-1 flex gap-2">
                  <Input
                    value={form.accentColor}
                    onChange={(e) => setForm({ ...form, accentColor: e.target.value })}
                    placeholder="#a855f7"
                  />
                  {form.accentColor && (
                    <div
                      className="h-10 w-10 shrink-0 rounded-md border"
                      style={{ backgroundColor: form.accentColor }}
                    />
                  )}
                </div>
              </div>
            </div>

            <div>
              <label className="text-sm font-medium text-foreground">
                Support Email
              </label>
              <Input
                type="email"
                value={form.supportEmail}
                onChange={(e) => setForm({ ...form, supportEmail: e.target.value })}
                placeholder="support@example.com"
                className="mt-1"
              />
            </div>

            <Button onClick={handleSave} disabled={isSaving}>
              <Save className="mr-2 h-4 w-4" />
              {isSaving ? "Saving..." : "Save Branding"}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
