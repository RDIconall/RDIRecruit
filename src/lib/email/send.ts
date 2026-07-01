import "server-only";
import nodemailer, { type Transporter } from "nodemailer";
import { env, hasEmail } from "../env";

export interface SendEmailInput {
  to: string[];
  subject: string;
  html: string;
  text?: string;
  /** Overrides the configured from address (defaults to SUMMARY_EMAIL_FROM / SMTP_USER). */
  from?: string;
}

export type SendEmailResult =
  | { sent: true; id: string | null }
  | { sent: false; reason: string };

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) return null;
  if (!transporter) {
    const port = Number(env.SMTP_PORT ?? 465);
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port,
      // 465 = implicit TLS; 587/25 = STARTTLS (secure:false, upgraded in-band).
      secure: port === 465,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    });
  }
  return transporter;
}

/**
 * Send a transactional email over SMTP (defaults tuned for Google Workspace /
 * Gmail with an app password). The message comes *from your own address* to
 * whoever is in SUMMARY_EMAIL_TO — no third-party service, no domain to verify.
 *
 * Mirrors the rest of the codebase: when SMTP is not configured, or the
 * recipient list is empty, we skip gracefully (logged, no throw) so callers —
 * notably the daily-summary cron — never fail just because email is unset.
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const tx = getTransporter();
  const from = input.from ?? env.SUMMARY_EMAIL_FROM ?? env.SMTP_USER;

  if (!tx || !from) {
    return { sent: false, reason: "Email not configured (SMTP_HOST / SMTP_USER / SMTP_PASS)" };
  }
  const to = input.to.map((address) => address.trim()).filter(Boolean);
  if (!to.length) {
    return { sent: false, reason: "No recipients" };
  }

  try {
    const info = await tx.sendMail({
      from,
      to,
      subject: input.subject,
      html: input.html,
      ...(input.text ? { text: input.text } : {}),
    });
    return { sent: true, id: info.messageId ?? null };
  } catch (error) {
    return { sent: false, reason: error instanceof Error ? error.message : "Send failed" };
  }
}

export { hasEmail };
