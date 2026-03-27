"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { settingsApi } from "@/lib/api";

interface Branding {
  logo?: string;
  favicon?: string;
  primaryColor?: string;
  accentColor?: string;
  appName?: string;
  supportEmail?: string;
}

interface BrandingContextValue {
  branding: Branding;
  isLoading: boolean;
  refresh: () => Promise<void>;
}

const BrandingContext = createContext<BrandingContextValue>({
  branding: {},
  isLoading: true,
  refresh: async () => {},
});

export function useBranding() {
  return useContext(BrandingContext);
}

export function BrandingProvider({ children }: { children: React.ReactNode }) {
  const [branding, setBranding] = useState<Branding>({});
  const [isLoading, setIsLoading] = useState(true);

  const loadBranding = async () => {
    try {
      const data = await settingsApi.getBranding();
      const b = (data as any).branding ?? {};
      setBranding(b);

      // Apply CSS custom properties for theme overrides
      if (b.primaryColor) {
        document.documentElement.style.setProperty("--color-brand-primary", b.primaryColor);
      }
      if (b.accentColor) {
        document.documentElement.style.setProperty("--color-brand-accent", b.accentColor);
      }
      if (b.favicon) {
        const link = document.querySelector("link[rel='icon']") as HTMLLinkElement;
        if (link) link.href = b.favicon;
      }
      if (b.appName) {
        document.title = b.appName;
      }
    } catch {
      // Branding is optional — use defaults
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadBranding();
  }, []);

  return (
    <BrandingContext.Provider value={{ branding, isLoading, refresh: loadBranding }}>
      {children}
    </BrandingContext.Provider>
  );
}
