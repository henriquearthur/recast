import { createTransport } from "nodemailer";
import type { Mailer } from "./deps";

/** SMTP over TLS, Gmail with an app password by default. Credentials come from the service environment only. */
export function createSmtpMailer(env: Record<string, string | undefined>): Mailer {
  return {
    async send(message, ctx) {
      const missing = ["RECAST_SMTP_USER", "RECAST_SMTP_PASSWORD"].filter((name) => !env[name]);
      if (missing.length) throw new Error(`Email credentials missing: set ${missing.join(" and ")} in the service environment`);
      const port = Number(env.RECAST_SMTP_PORT || 465);
      const transport = createTransport({
        host: env.RECAST_SMTP_HOST || "smtp.gmail.com",
        port,
        secure: port === 465,
        auth: { user: env.RECAST_SMTP_USER, pass: env.RECAST_SMTP_PASSWORD },
      });
      ctx.log(`sending to ${message.to}`);
      const info = await transport.sendMail({ from: env.RECAST_SMTP_USER, ...message });
      ctx.log(`sent: ${info.messageId}`);
    },
  };
}
