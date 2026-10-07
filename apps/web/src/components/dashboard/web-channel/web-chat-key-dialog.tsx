"use client";

import { useEffect, useId, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { apiErrorCode, getErrorMessage, webChannelApi, type Agent, type WidgetKey } from "@/lib/api";
import { EMPTY_WEB_KEY_FORM, formFromKey, inputFromForm, type WebKeyForm } from "@/lib/web-channel";
import { formatNumber } from "@/lib/utils";

interface WebChatKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = a new key. */
  editing: WidgetKey | null;
  agents: Agent[];
  defaultDailyCap: number;
  /** Whether the plan may hide "Powered by WheelsAI". */
  whiteLabel: boolean;
  onSaved: (key: WidgetKey) => void;
}

/**
 * Create or edit one web chat key: the agent it talks to, the sites that may
 * embed it, its limits and its look. What is and is not an origin is the
 * server's call; its refusal names the entry and is shown under the box.
 */
export function WebChatKeyDialog({
  open,
  onOpenChange,
  editing,
  agents,
  defaultDailyCap,
  whiteLabel,
  onSaved,
}: WebChatKeyDialogProps) {
  const id = useId();
  const [form, setForm] = useState<WebKeyForm>(EMPTY_WEB_KEY_FORM);
  const [error, setError] = useState<{ field: keyof WebKeyForm | null; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setForm(editing ? formFromKey(editing) : { ...EMPTY_WEB_KEY_FORM, agentId: agents[0]?.id ?? "" });
  }, [open, editing, agents]);

  const set = <K extends keyof WebKeyForm>(field: K, value: WebKeyForm[K]) =>
    setForm((current) => ({ ...current, [field]: value }));
  const fieldError = (field: keyof WebKeyForm) =>
    error?.field === field ? <p className="mt-1 text-sm text-destructive">{error.message}</p> : null;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const result = inputFromForm(form);
    if (!result.ok) {
      setError({ field: result.field, message: result.message });
      return;
    }
    if (!editing && !form.agentId) {
      setError({ field: "agentId", message: "Choose the agent this chat talks to." });
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const { key } = editing
        ? await webChannelApi.updateKey(editing.id, result.input)
        : await webChannelApi.createKey({ ...result.input, agentId: form.agentId });
      onSaved(key);
      onOpenChange(false);
      toast.success(editing ? "Web chat key saved" : "Web chat key created");
    } catch (err) {
      const code = apiErrorCode(err);
      const message = getErrorMessage(err, "The key could not be saved.");
      if (code === "invalid_origin") setError({ field: "origins", message });
      else if (code === "plan_limit_reached") setError({ field: "hideBranding", message });
      else setError({ field: null, message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent
        className="max-h-[90vh] max-w-2xl overflow-y-auto"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
      >
        <DialogHeader>
          <DialogTitle id={`${id}-title`}>{editing ? "Edit web chat key" : "New web chat key"}</DialogTitle>
          <DialogDescription id={`${id}-description`}>
            A key puts one agent on your site as a chat widget. The key itself is public: it is printed in the snippet.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={save} className="mt-4 space-y-5" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor={`${id}-agent`}>Agent</Label>
              {editing ? (
                <Input id={`${id}-agent`} value={editing.agentName} disabled readOnly className="mt-1" />
              ) : (
                <Select
                  id={`${id}-agent`}
                  className="mt-1"
                  value={form.agentId}
                  onChange={(event) => set("agentId", event.target.value)}
                >
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))}
                </Select>
              )}
              {fieldError("agentId")}
            </div>
            <div>
              <Label htmlFor={`${id}-name`}>Name</Label>
              <Input
                id={`${id}-name`}
                className="mt-1"
                value={form.name}
                maxLength={80}
                placeholder="Main website"
                onChange={(event) => set("name", event.target.value)}
              />
              {fieldError("name")}
            </div>
          </div>

          <div>
            <Label htmlFor={`${id}-origins`}>Allowed sites</Label>
            <Textarea
              id={`${id}-origins`}
              className="mt-1 font-mono text-sm"
              rows={3}
              value={form.origins}
              placeholder={"https://www.example.com\nhttps://*.example.com"}
              onChange={(event) => set("origins", event.target.value)}
              aria-describedby={`${id}-origins-help`}
            />
            {fieldError("origins")}
            <p id={`${id}-origins-help`} className="mt-1 text-xs text-muted-foreground">
              One origin a line: scheme and host, no path. <code>https://*.example.com</code> covers subdomains but not
              the bare domain. Leave it empty and only the preview on this dashboard works. Browsers enforce this list;
              a script can send any origin, so the limits below are what bound usage.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor={`${id}-cap`}>Messages a day</Label>
              <Input
                id={`${id}-cap`}
                className="mt-1"
                inputMode="numeric"
                value={form.dailyMessageCap}
                placeholder={`Default: ${formatNumber(defaultDailyCap)}`}
                onChange={(event) => set("dailyMessageCap", event.target.value)}
              />
              {fieldError("dailyMessageCap")}
              <p className="mt-1 text-xs text-muted-foreground">
                Across all visitors, counted in UTC days. Each message also counts toward your plan's API calls.
              </p>
            </div>
            <div>
              <Label htmlFor={`${id}-ip`}>Messages a minute, per visitor</Label>
              <Input
                id={`${id}-ip`}
                className="mt-1"
                inputMode="numeric"
                value={form.perIpPerMinute}
                placeholder="Default"
                onChange={(event) => set("perIpPerMinute", event.target.value)}
              />
              {fieldError("perIpPerMinute")}
              <p className="mt-1 text-xs text-muted-foreground">
                Counted per network address, 1 to 60. The platform's own per-visitor limit applies as well, so this
                only matters when it is the lower of the two.
              </p>
            </div>
          </div>

          <fieldset className="space-y-4 rounded-lg border p-4">
            <legend className="px-1 text-sm font-medium">Appearance</legend>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor={`${id}-title-field`}>Title</Label>
                <Input
                  id={`${id}-title-field`}
                  className="mt-1"
                  value={form.title}
                  maxLength={60}
                  placeholder="The agent's name"
                  onChange={(event) => set("title", event.target.value)}
                />
                {fieldError("title")}
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor={`${id}-color`}>Colour</Label>
                  <Input
                    id={`${id}-color`}
                    className="mt-1 font-mono"
                    value={form.primaryColor}
                    maxLength={7}
                    placeholder="#2563eb"
                    onChange={(event) => set("primaryColor", event.target.value)}
                  />
                </div>
                <div>
                  <Label htmlFor={`${id}-position`}>Corner</Label>
                  <Select
                    id={`${id}-position`}
                    className="mt-1"
                    value={form.position}
                    onChange={(event) => set("position", event.target.value === "bottom-left" ? "bottom-left" : "bottom-right")}
                  >
                    <option value="bottom-right">Right</option>
                    <option value="bottom-left">Left</option>
                  </Select>
                </div>
                <div className="col-span-2">{fieldError("primaryColor")}</div>
              </div>
            </div>
            <div>
              <Label htmlFor={`${id}-greeting`}>Greeting</Label>
              <Textarea
                id={`${id}-greeting`}
                className="mt-1"
                rows={2}
                value={form.greeting}
                maxLength={500}
                placeholder="Hi! Ask me anything about our product."
                onChange={(event) => set("greeting", event.target.value)}
              />
              {fieldError("greeting")}
            </div>
          </fieldset>

          <div className="space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <Label htmlFor={`${id}-transcripts`}>Save conversations</Label>
                <p className="mt-1 text-xs text-muted-foreground">
                  Off by default. When on, visitors' messages and the agent's answers are stored in your organization,
                  and the widget tells the visitor so. You are responsible for telling your visitors in your own
                  privacy notice.
                </p>
              </div>
              <Switch
                id={`${id}-transcripts`}
                checked={form.storeTranscripts}
                onCheckedChange={(checked) => set("storeTranscripts", checked)}
              />
            </div>
            <div className="flex items-start justify-between gap-4">
              <div>
                <Label htmlFor={`${id}-branding`}>Hide "Powered by WheelsAI"</Label>
                <p className="mt-1 text-xs text-muted-foreground">
                  {whiteLabel
                    ? "Your plan includes white-labelling."
                    : "Part of white-labelling, which the Enterprise plan includes. The line is shown on your current plan."}
                </p>
                {fieldError("hideBranding")}
              </div>
              <Switch
                id={`${id}-branding`}
                checked={form.hideBranding}
                disabled={!whiteLabel && !form.hideBranding}
                onCheckedChange={(checked) => set("hideBranding", checked)}
              />
            </div>
          </div>

          {error && error.field === null && (
            <p role="alert" className="text-sm text-destructive">
              {error.message}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || (!editing && agents.length === 0)}>
              {saving ? "Saving..." : editing ? "Save changes" : "Create key"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
