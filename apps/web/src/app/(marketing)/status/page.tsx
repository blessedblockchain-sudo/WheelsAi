import type { Metadata } from "next";

import { PageBody, PageHero } from "@/components/marketing/page-hero";
import { StatusBoard } from "@/components/marketing/status-board";

export const metadata: Metadata = {
  title: "Status",
  description:
    "Live health of the WheelsAI platform: API, database, queues and background workers, with response times and the uptime history of each listed monitor.",
};

export default function StatusPage() {
  return (
    <>
      <PageHero
        width="4xl"
        eyebrow="Status"
        title="Platform status"
        description="Live health of the WheelsAI API, database, queues and background workers, with response times and the uptime history of each listed monitor. Refreshes every 30 seconds."
      />
      <PageBody width="4xl">
        <StatusBoard />
      </PageBody>
    </>
  );
}
