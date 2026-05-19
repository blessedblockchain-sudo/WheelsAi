import { notFound } from "next/navigation";
import { featureFlags } from "@/lib/feature-flags";

export default function TokenUiLayout({ children }: { children: React.ReactNode }) {
  if (!featureFlags.tokenUi) notFound();
  return <>{children}</>;
}
