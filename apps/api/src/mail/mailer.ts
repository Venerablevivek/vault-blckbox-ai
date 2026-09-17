import nodemailer, { type Transporter } from 'nodemailer';
import type { Logger } from 'pino';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * The email boundary. Business logic depends on this interface only, the same way it depends
 * on FileStorage rather than the AWS SDK: SMTP in development (Mailpit) and in production,
 * a logging fallback when no SMTP server is configured, and an in-memory outbox in tests.
 */
export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;

  constructor(
    smtpUrl: string,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport(smtpUrl);
  }

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.from, ...message });
  }
}

/**
 * Used when SMTP_URL is not set. It records that an email would have been sent, with its
 * recipient and subject only: the body carries single-use links, and logs are not a place
 * for bearer tokens.
 */
export class LogMailer implements Mailer {
  constructor(private readonly logger: Logger) {}

  async send(message: MailMessage): Promise<void> {
    this.logger.info({ to: message.to, subject: message.subject }, 'email not sent: SMTP_URL is not configured');
  }
}

/** Test double: keeps every message so tests can read the links out of them. */
export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  failNext = false;

  async send(message: MailMessage): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('simulated SMTP failure');
    }
    this.sent.push(message);
  }

  /** Waits for a message matching `predicate`; mail is often sent after the response. */
  async waitFor(predicate: (message: MailMessage) => boolean, timeoutMs = 3000): Promise<MailMessage> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.sent.find(predicate);
      if (found) return found;
      if (Date.now() > deadline) throw new Error('expected email was not sent');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  clear(): void {
    this.sent.length = 0;
    this.failNext = false;
  }
}
