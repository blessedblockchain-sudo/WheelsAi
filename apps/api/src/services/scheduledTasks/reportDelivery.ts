/**
 * Sends a report to one of an organization's alert channels.
 *
 * The alert pipeline's own sender (monitoring.ts) is private to alerts
 * and its email branch only logs, so a report is delivered here instead,
 * with the same wire formats for Slack, Discord and signed webhooks, and
 * with email going through the real email service or not at all.
 *
 * Channel URLs are user-supplied: every request goes through the SSRF
 * guard.
 */

import { createHmac } from "node:crypto";

import { safeFetch, SsrfBlockedError, type UrlGuardDeps } from "../../lib/ssrfGuard.js";
import { sanitizeOutboundHeaders } from "../skills/httpLimits.js";
import type { ReportChannel, ReportMessage } from "./report.js";

export interface ReportDeliveryDeps {
  fetchFn?: typeof fetch;
  guardDeps?: UrlGuardDeps;
  sendEmail: (message: { to: string; subject: string; text: string; html: string }) => Promise<void>;
}

/** Slack and Discord both cut long messages; the cut is stated. */
const CHAT_TEXT_MAX = 3500;

const configOf = (channel: ReportChannel): Record<string, unknown> =>
  typeof channel.config === "object" && channel.config !== null
    ? (channel.config as Record<string, unknown>)
    : {};

function clip(text: string): string {
  return text.length > CHAT_TEXT_MAX
    ? `${text.slice(0, CHAT_TEXT_MAX)}\n... (cut; the full report is on the task execution)`
    : text;
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

async function post(
  url: unknown,
  init: { method?: string; headers?: Record<string, string>; body: string },
  what: string,
  deps: ReportDeliveryDeps,
): Promise<void> {
  if (typeof url !== "string" || url === "") {
    throw new Error(`the ${what} channel has no URL configured`);
  }
  let res: Response;
  try {
    res = await safeFetch(url, {
      method: init.method ?? "POST",
      headers: { ...init.headers, "Content-Type": "application/json" },
      body: init.body,
      fetchImpl: deps.fetchFn,
      guardDeps: deps.guardDeps,
    });
  } catch (err) {
    if (err instanceof SsrfBlockedError) throw new Error(`${what} URL refused: ${err.publicMessage}`);
    throw err;
  }
  await res.body?.cancel().catch(() => {});
  if (!res.ok) throw new Error(`${what} responded ${res.status}`);
}

export function buildReportDelivery(deps: ReportDeliveryDeps) {
  return {
    sendToChannel: async (channel: ReportChannel, message: ReportMessage): Promise<void> => {
      const config = configOf(channel);
      if (channel.type === "slack") {
        return post(
          config.webhookUrl,
          {
            body: JSON.stringify({
              username: typeof config.username === "string" ? config.username : "WheelsAI Reports",
              ...(typeof config.channel === "string" ? { channel: config.channel } : {}),
              attachments: [
                { color: "#3b82f6", title: message.title, text: clip(message.text), footer: "WheelsAI" },
              ],
            }),
          },
          "Slack",
          deps,
        );
      }
      if (channel.type === "discord") {
        return post(
          config.webhookUrl,
          {
            body: JSON.stringify({
              embeds: [
                { title: message.title, description: clip(message.text), color: 0x3b82f6, footer: { text: "WheelsAI" } },
              ],
            }),
          },
          "Discord",
          deps,
        );
      }
      if (channel.type === "webhook") {
        const body = JSON.stringify({
          type: "report",
          title: message.title,
          message: message.text,
          timestamp: new Date().toISOString(),
        });
        const headers: Record<string, string> = {
          ...(sanitizeOutboundHeaders(
            typeof config.headers === "object" && config.headers !== null
              ? (config.headers as Record<string, string>)
              : undefined,
          ) ?? {}),
        };
        if (typeof config.secret === "string" && config.secret !== "") {
          // Same scheme as alert notifications to this channel.
          headers["X-Webhook-Signature"] = createHmac("sha256", config.secret)
            .update(body)
            .digest("hex");
        }
        // A report is a body; a channel configured for GET still gets a POST.
        return post(config.url, { headers, body }, "webhook", deps);
      }
      throw new Error(`a ${channel.type} channel cannot carry a report`);
    },

    sendEmail: async (channel: ReportChannel, message: ReportMessage): Promise<void> => {
      const emails = configOf(channel).emails;
      const recipients = Array.isArray(emails)
        ? emails.filter((e): e is string => typeof e === "string" && e.includes("@"))
        : [];
      if (recipients.length === 0) {
        throw new Error("the email channel has no addresses configured");
      }
      for (const to of recipients) {
        await deps.sendEmail({
          to,
          subject: message.title,
          text: message.text,
          html: `<pre style="font-family:ui-monospace,Menlo,monospace;font-size:13px;white-space:pre-wrap">${escapeHtml(
            message.text,
          )}</pre>`,
        });
      }
    },
  };
}
