"use client";

import { Header } from "@/components/dashboard/header";
import { OpenClawWizard } from "@/components/dashboard/openclaw-wizard";

export default function NewOpenClawDeploymentPage() {
  return (
    <div className="flex flex-col">
      <Header
        title="New OpenClaw Deployment"
        description="Deploy an AI agent with multi-channel support"
      />
      <div className="p-8">
        <OpenClawWizard />
      </div>
    </div>
  );
}
