"use client";

import { Header } from "@/components/dashboard/header";
import { OfferingEditor } from "@/components/marketplace/offering-editor";

export default function NewOfferingPage() {
  return (
    <div className="flex flex-col">
      <Header
        title="New offering"
        description="A fixed task one of your products runs for a buyer, at a price you set"
      />
      <div className="max-w-3xl p-8">
        <OfferingEditor offering={null} />
      </div>
    </div>
  );
}
