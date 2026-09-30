import type { Metadata } from "next";

import { PageBody, PageHero } from "@/components/marketing/page-hero";
import { StatusBoard } from "@/components/marketing/status-board";

export const metadata: Metadata = {
  title: "Status",
  description:
    "Live health of the WheelsAI platform: database, queues, background workers and public uptime monitors.",
};

export default function StatusPage() {
  return (
    <>
      <PageHero
        width="4xl"
        eyebrow="Status"
        title="Platform status"
        description="Live checks of the services behind WheelsAI. Every figure on this page comes from the API's own probes; if something has not been measured, it says so."
      />
      <PageBody width="4xl">
        <StatusBoard />
      </PageBody>
    </>
  );
}
