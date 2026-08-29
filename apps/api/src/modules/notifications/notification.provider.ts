/**
 * Notification provider abstraction (docs/09_INTEGRATIONS.md).
 *
 * Invitations and password resets need to *send something*, and the brief is explicit that
 * missing provider credentials must never block work. So the surface is an interface with
 * two adapters behind it:
 *
 *  - **console** (default): records and logs the send with all secret material redacted.
 *    Nothing leaves the machine. This is what test and credential-less environments run.
 *  - **smtp**: a real SMTP delivery, pointed at the Mailpit instance in
 *    `infra/docker-compose.yml` (host port 1025) in development, or at a real relay in
 *    production.
 *
 * SMS is deliberately *not* integrated with a vendor here. The interface still models it,
 * because the encoding question cannot be bolted on later: **Bangla SMS is UCS-2, which
 * caps a message part at 70 characters instead of 160.** A template system that counts
 * characters in the wrong encoding silently triples the bill, so every send result carries
 * the computed encoding and part count, and `smsEncodingOf` is the single place that
 * computation lives. A future vendor adapter consumes it; it cannot ignore it.
 */

export type NotificationChannel = 'email' | 'sms';

/**
 * GSM 03.38 7-bit or UCS-2. Any character outside the GSM basic set — every Bengali
 * character, for a start — forces the whole message to UCS-2.
 */
export type SmsEncoding = 'gsm7' | 'ucs2';

export type NotificationTemplateKey = 'user_invitation' | 'guardian_invitation' | 'password_reset';

export interface NotificationSendResult {
  /** False means the adapter could not hand the message off; the caller decides what that costs. */
  delivered: boolean;
  /** Which adapter handled it: 'console' | 'smtp'. */
  provider: string;
  channel: NotificationChannel;
  /** Only set for SMS: the encoding the message body requires. */
  encoding?: SmsEncoding;
  /** Only set for SMS: how many message parts (and therefore how many billed units). */
  parts?: number;
}

/**
 * The abstraction the rest of the API depends on.
 *
 * `data` is template data — names, links, expiry times. Values under keys that look like
 * secrets (token, url, password) are never written to a log line by any adapter; the token
 * inside an invitation link is a bearer credential until it expires.
 */
export interface NotificationProvider {
  send(
    channel: NotificationChannel,
    to: string,
    template: NotificationTemplateKey,
    data: Record<string, unknown>,
  ): Promise<NotificationSendResult>;
}

/** Nest injection token — the interface has no runtime identity of its own. */
export const NOTIFICATION_PROVIDER = 'NOTIFICATION_PROVIDER';

/**
 * The GSM 03.38 basic character set plus the standard extension table. Anything outside it
 * (Bengali script included — none of it is representable in GSM 7-bit) forces UCS-2.
 */
const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXTENSION = '^{}\\[~]|€';

const GSM7_SET = new Set<string>([...GSM7_BASIC, ...GSM7_EXTENSION]);

export interface SmsEncodingInfo {
  encoding: SmsEncoding;
  /** Characters a single-part message may hold in this encoding. */
  singlePartLimit: number;
  /** Characters per part once the message is concatenated (UDH overhead subtracted). */
  concatenatedPartLimit: number;
  /** Billable message parts for this body. */
  parts: number;
  /** Septets (GSM) or UTF-16 code units (UCS-2) the body occupies. */
  units: number;
}

/**
 * Classify a message body and count its billable parts.
 *
 * GSM 7-bit: 160 characters per single part, 153 per concatenated part; extension-table
 * characters cost two septets each. UCS-2: 70 per single part, 67 per concatenated part —
 * which is why an unchecked Bangla template triples the bill.
 */
export function smsEncodingOf(body: string): SmsEncodingInfo {
  let gsm = true;
  let septets = 0;
  for (const char of body) {
    if (!GSM7_SET.has(char)) {
      gsm = false;
      break;
    }
    septets += GSM7_EXTENSION.includes(char) ? 2 : 1;
  }

  if (gsm) {
    const parts = septets <= 160 ? 1 : Math.ceil(septets / 153);
    return {
      encoding: 'gsm7',
      singlePartLimit: 160,
      concatenatedPartLimit: 153,
      parts,
      units: septets,
    };
  }

  // UCS-2 is billed in UTF-16 code units, which is exactly JavaScript's string length.
  const units = body.length;
  const parts = units <= 70 ? 1 : Math.ceil(units / 67);
  return {
    encoding: 'ucs2',
    singlePartLimit: 70,
    concatenatedPartLimit: 67,
    parts,
    units,
  };
}
