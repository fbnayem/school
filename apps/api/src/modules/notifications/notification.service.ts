/**
 * The concrete `NotificationProvider`.
 *
 * Transport selection is environment-driven so that a machine with no SMTP credentials
 * still works — the brief's rule is that missing provider credentials must never block
 * development or a deployment:
 *
 *  - `NOTIFICATIONS_EMAIL_DRIVER=console` (default) — the message is recorded in a small
 *    in-memory ring buffer and a **redacted** line is logged. Nothing leaves the process.
 *  - `NOTIFICATIONS_EMAIL_DRIVER=smtp` — delivered over SMTP. Configuration:
 *      SMTP_HOST      (default `localhost` — the Mailpit container in infra/docker-compose.yml)
 *      SMTP_PORT      (default `1025`)
 *      SMTP_FROM      (default `no-reply@shikkha.local`)
 *      SMTP_USER / SMTP_PASSWORD (optional; Mailpit needs none)
 *
 * SMS always uses the console transport — no vendor is integrated by design
 * (docs/09_INTEGRATIONS.md). The abstraction still computes and reports the encoding and
 * part count for every SMS so a future vendor adapter inherits correct billing arithmetic
 * rather than discovering UCS-2 in an invoice.
 *
 * Security invariants this class owns:
 *  - **No token in a log line.** Invitation and reset links are bearer credentials; log
 *    lines carry the template key, channel, and recipient only. The full rendered message
 *    exists only in memory (the ring buffer, for dev/test inspection) or in the SMTP
 *    stream to the configured host.
 *  - **Sending never throws.** A failed delivery is an operational problem, not a reason
 *    to fail the request that triggered it; callers get `delivered: false`.
 */

import { Injectable } from '@nestjs/common';
import {
  smsEncodingOf,
  type NotificationChannel,
  type NotificationProvider,
  type NotificationSendResult,
  type NotificationTemplateKey,
} from './notification.provider';
import { renderNotification, type RenderedNotification } from './templates';
import { sendSmtpMail } from './smtp.client';
import { getLogger } from '../../common/logger';

export interface RecordedNotification {
  channel: NotificationChannel;
  to: string;
  template: NotificationTemplateKey;
  /** Full template data, including secret links. In memory only; never logged. */
  data: Record<string, unknown>;
  rendered: RenderedNotification;
  result: NotificationSendResult;
  sentAt: Date;
}

const OUTBOX_LIMIT = 100;

@Injectable()
export class NotificationService implements NotificationProvider {
  /** Ring buffer of recent sends, newest last. Test and dev inspection only. */
  private readonly outbox: RecordedNotification[] = [];

  async send(
    channel: NotificationChannel,
    to: string,
    template: NotificationTemplateKey,
    data: Record<string, unknown>,
  ): Promise<NotificationSendResult> {
    const locale = typeof data['locale'] === 'string' ? (data['locale'] as string) : 'en';
    const rendered = renderNotification(template, locale, data);

    let result: NotificationSendResult;
    if (channel === 'sms') {
      result = this.sendSms(to, rendered);
    } else {
      result = await this.sendEmail(to, rendered);
    }

    this.record({ channel, to, template, data, rendered, result, sentAt: new Date() });

    // Redacted by construction: template key and recipient, never the body or the link.
    getLogger().info(
      {
        channel,
        template,
        to,
        provider: result.provider,
        delivered: result.delivered,
        encoding: result.encoding,
        parts: result.parts,
      },
      'notification dispatched',
    );

    return result;
  }

  /**
   * Recent sends, for development inspection and integration tests. The messages contain
   * live single-use links, which is exactly why they are exposed here rather than logged.
   */
  recent(): readonly RecordedNotification[] {
    return this.outbox;
  }

  private sendSms(to: string, rendered: RenderedNotification): NotificationSendResult {
    // No SMS vendor is integrated. The console transport still computes what a vendor
    // send would cost, so templates are honest about their encoding from day one.
    const info = smsEncodingOf(rendered.smsText);
    return {
      delivered: true,
      provider: 'console',
      channel: 'sms',
      encoding: info.encoding,
      parts: info.parts,
    };
  }

  private async sendEmail(
    to: string,
    rendered: RenderedNotification,
  ): Promise<NotificationSendResult> {
    const driver = (process.env['NOTIFICATIONS_EMAIL_DRIVER'] ?? 'console').toLowerCase();
    if (driver !== 'smtp') {
      return { delivered: true, provider: 'console', channel: 'email' };
    }

    try {
      await sendSmtpMail(
        {
          host: process.env['SMTP_HOST'] ?? 'localhost',
          port: Number(process.env['SMTP_PORT'] ?? '1025'),
          user: process.env['SMTP_USER'],
          password: process.env['SMTP_PASSWORD'],
        },
        {
          from: process.env['SMTP_FROM'] ?? 'no-reply@shikkha.local',
          to,
          subject: rendered.subject,
          text: rendered.emailText,
        },
      );
      return { delivered: true, provider: 'smtp', channel: 'email' };
    } catch (error) {
      // The message body (and its embedded link) is deliberately absent from this log.
      getLogger().error({ err: error, to }, 'smtp delivery failed');
      return { delivered: false, provider: 'smtp', channel: 'email' };
    }
  }

  private record(entry: RecordedNotification): void {
    this.outbox.push(entry);
    if (this.outbox.length > OUTBOX_LIMIT) this.outbox.shift();
  }
}
