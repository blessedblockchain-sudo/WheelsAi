"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { playgroundApi, type PlaygroundModelsResponse } from "@/lib/api";
import { chosenModel, offeredModelIds } from "@/lib/model-choice";
import { Select } from "@/components/ui/select";

interface ModelSelectorProps {
  agentId: string;
  value: string;
  onChange: (modelId: string) => void;
  /** Ties the select to a `<Label htmlFor>`. */
  id?: string;
  /** The select's name when no label points at it. */
  ariaLabel?: string;
  /**
   * The words of an entry for "no model of its own" (value ""), such as
   * "WheelsAI's default model". With it the picker never changes the value by
   * itself: a model that is not offered now stays chosen and is shown as such.
   */
  defaultLabel?: string;
  /** Called once the list of models has been read (or could not be), when what is shown is what is held. */
  onReady?: () => void;
}

export function ModelSelector({ agentId, value, onChange, id, ariaLabel = "Model", defaultLabel, onReady }: ModelSelectorProps) {
  const [models, setModels] = useState<PlaygroundModelsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    playgroundApi
      .models(agentId)
      .then(setModels)
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, [agentId]);

  const offered = useMemo(() => offeredModelIds(models), [models]);
  const keepsValue = defaultLabel !== undefined;

  // What is shown is what is held: a model this server does not offer gives
  // way to the first one it does (lib/model-choice).
  const handlers = useRef({ onChange, onReady });
  useEffect(() => {
    handlers.current = { onChange, onReady };
  });
  useEffect(() => {
    if (isLoading) return;
    if (models && !keepsValue) {
      const next = chosenModel(value, offered);
      if (next !== "" && next !== value) {
        // The page is told first; it is ready on the render that holds the new value.
        handlers.current.onChange(next);
        return;
      }
    }
    handlers.current.onReady?.();
  }, [isLoading, models, offered, value, keepsValue]);

  if (isLoading) {
    return (
      <Select id={id} aria-label={id ? undefined : ariaLabel} disabled className="w-full">
        <option>Loading models...</option>
      </Select>
    );
  }

  const availableFree = models?.freeModels?.filter((m) => m.available) ?? [];
  const notOffered = keepsValue && value !== "" && !offered.includes(value);

  return (
    <Select
      id={id}
      aria-label={id ? undefined : ariaLabel}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full"
    >
      {keepsValue && <option value="">{defaultLabel}</option>}
      {notOffered && <option value={value}>{value} (not available right now)</option>}
      <optgroup label="Free Models (No API Key)">
        {availableFree.map((m) => (
          <option key={m.id} value={m.id}>
            {m.displayName} (Free)
          </option>
        ))}
        {availableFree.length === 0 && <option disabled>No free models available</option>}
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
