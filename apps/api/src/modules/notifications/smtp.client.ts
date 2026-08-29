/**
 * A minimal SMTP client.
 *
 * Written by hand rather than pulling in a mail library because the target is the Mailpit
 * container in `infra/docker-compose.yml` (SMTP on host port 1025, web UI on 8025) and, in
 * production, a plain relay on a trusted network. The protocol subset needed is tiny:
 * EHLO, optional AUTH PLAIN, MAIL FROM, RCPT TO, DATA, QUIT.
 *
 * Deliberate limitations, stated so nobody discovers them in an incident:
 *  - **No STARTTLS.** Mailpit does not need it; an internet-facing relay does. If the
 *    deployment's relay requires TLS, put a local forwarder (or a future TLS-capable
 *    adapter) in front rather than pointing this at port 587 on the open internet.
 *  - Plain-text bodies only. Authentication mail does not need HTML.
 *
 * The client never logs message content or credentials; failures surface as thrown errors
 * carrying only the SMTP reply code and command name.
 */

import { createConnection, type Socket } from 'node:net';

export interface SmtpOptions {
  host: string;
  port: number;
  /** Optional AUTH PLAIN credentials; Mailpit needs none. */
  user?: string;
  password?: string;
  /** Per-command timeout. The whole conversation is bounded by commands × timeout. */
  timeoutMs?: number;
}

export interface SmtpMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export async function sendSmtpMail(options: SmtpOptions, message: SmtpMessage): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const socket = await connect(options.host, options.port, timeoutMs);
  const conversation = new SmtpConversation(socket, timeoutMs);
  try {
    await conversation.expect(220, 'greeting');
    await conversation.command(`EHLO shikkha-api`, 250);

    if (options.user && options.password) {
      const credentials = Buffer.from(
        `\u0000${options.user}\u0000${options.password}`,
        'utf8',
      ).toString('base64');
      await conversation.command(`AUTH PLAIN ${credentials}`, 235);
    }

    await conversation.command(`MAIL FROM:<${sanitizeAddress(message.from)}>`, 250);
    await conversation.command(`RCPT TO:<${sanitizeAddress(message.to)}>`, [250, 251]);
    await conversation.command('DATA', 354);
    await conversation.command(buildData(message), 250);
    await conversation.command('QUIT', 221);
  } finally {
    socket.destroy();
  }
}

/** CR/LF or angle brackets in an address would let a caller smuggle SMTP commands. */
function sanitizeAddress(address: string): string {
  const cleaned = address.replace(/[\r\n<>]/g, '').trim();
  if (!cleaned.includes('@')) {
    throw new Error('smtp: recipient is not an email address');
  }
  return cleaned;
}

function buildData(message: SmtpMessage): string {
  const headers = [
    `From: ${sanitizeAddress(message.from)}`,
    `To: ${sanitizeAddress(message.to)}`,
    `Subject: ${encodeHeader(message.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
  ];

  // Dot-stuffing (RFC 5321 §4.5.2): a body line starting with '.' would otherwise
  // terminate DATA early.
  const body = message.text
    .split(/\r?\n/)
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join('\r\n');

  return `${headers.join('\r\n')}\r\n\r\n${body}\r\n.`;
}

/** RFC 2047 encoded-word for non-ASCII subjects — Bengali subjects are the common case. */
function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value.replace(/[\r\n]/g, ' ');
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function connect(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`smtp: connection to ${host}:${port} timed out`));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/**
 * Serialises request/response over the socket. SMTP replies can span multiple lines
 * (`250-…` continuation, `250 …` final), so the reader accumulates until the final line.
 */
class SmtpConversation {
  private buffer = '';

  constructor(
    private readonly socket: Socket,
    private readonly timeoutMs: number,
  ) {}

  async command(line: string, expected: number | number[]): Promise<void> {
    await this.write(`${line}\r\n`);
    await this.expect(expected, firstWord(line));
  }

  async expect(expected: number | number[], label: string): Promise<void> {
    const reply = await this.readReply();
    const codes = Array.isArray(expected) ? expected : [expected];
    if (!codes.includes(reply.code)) {
      throw new Error(`smtp: ${label} failed with reply code ${reply.code}`);
    }
  }

  private write(data: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.write(data, (error) => (error ? reject(error) : resolve()));
    });
  }

  private readReply(): Promise<{ code: number }> {
    return new Promise((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        this.buffer += chunk.toString('utf8');
        const lines = this.buffer.split('\r\n').filter((line) => line.length > 0);
        const last = lines.at(-1);
        // The final line of a reply is `NNN<space>text`; continuations are `NNN-text`.
        if (last && /^\d{3}(?: |$)/.test(last) && this.buffer.endsWith('\r\n')) {
          cleanup();
          this.buffer = '';
          resolve({ code: Number(last.slice(0, 3)) });
        }
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onTimeout = () => {
        cleanup();
        reject(new Error('smtp: timed out waiting for server reply'));
      };
      const timer = setTimeout(onTimeout, this.timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.socket.off('data', onData);
        this.socket.off('error', onError);
      };
      this.socket.on('data', onData);
      this.socket.once('error', onError);
    });
  }
}

function firstWord(line: string): string {
  return line.split(/[\s:]/, 1)[0] ?? 'command';
}
