/**
 * POST /api/contact — "Contact sales" and general enquiries from the
 * website. Always stored; also emailed to SALES_EMAIL when email is
 * configured. Public and rate-limited.
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { env } from "../config/env.js";
import { isEmailConfigured, sendEmail } from "../services/email/emailService.js";

const contactSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(254),
  company: z.string().trim().max(160).optional(),
  topic: z.enum(["enterprise", "support", "other"]).default("enterprise"),
  message: z.string().trim().min(10).max(5000),
});

export const contactRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/contact",
    { config: { rateLimit: { max: 3, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = contactSchema.parse(request.body);
      const row = await prisma.contactRequest.create({ data: body });

      let emailed = false;
      if (env.SALES_EMAIL && isEmailConfigured()) {
        const lines = [
          `From: ${body.name} <${body.email}>`,
          body.company ? `Company: ${body.company}` : null,
          `Topic: ${body.topic}`,
          "",
          body.message,
          "",
          `Request id: ${row.id}`,
        ].filter((l): l is string => l !== null);
        try {
          await sendEmail({
            to: env.SALES_EMAIL,
            subject: `[WheelsAI ${body.topic}] ${body.company ?? body.name}`,
            text: lines.join("\n"),
            html: `<pre style="font-family:Inter,Arial,sans-serif;white-space:pre-wrap">${lines
              .join("\n")
              .replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!)}</pre>`,
          });
          emailed = true;
        } catch (err) {
          request.log.error({ err, contactId: row.id }, "Failed to email contact request");
        }
      }
      return reply.status(201).send({ received: true, id: row.id, emailed });
    },
  );
};
