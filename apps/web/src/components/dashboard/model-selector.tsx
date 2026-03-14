"use client";

import { useEffect, useState } from "react";
import { playgroundApi, type PlaygroundModelsResponse } from "@/lib/api";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";

interface ModelSelectorProps {
  agentId: string;
  value: string;
  onChange: (modelId: string) => void;
}

export function ModelSelector({ agentId, value, onChange }: ModelSelectorProps) {
  const [models, setModels] = useState<PlaygroundModelsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    playgroundApi
      .models(agentId)
      .then(setModels)
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, [agentId]);

  if (isLoading) {
    return (
      <Select disabled className="w-full">
        <option>Loading models...</option>
      </Select>
    );
  }

  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} className="w-full">
      <optgroup label="Free Models (No API Key)">
        {models?.freeModels
          ?.filter((m) => m.available)
          .map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName} (Free)
            </option>
          ))}
        {(!models?.freeModels || models.freeModels.filter((m) => m.available).length === 0) && (
          <option disabled>No free models available</option>
        )}
      </optgroup>
      <optgroup label="External (Bring Your Key)">
        {models?.externalModels?.map((m) => (
          <option key={m.id} value={m.id}>
            {m.displayName} (requires {m.envKey})
          </option>
        ))}
      </optgroup>
    </Select>
  );
}
