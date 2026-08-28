/**
 * File storage behind a provider interface (ADR-010).
 *
 * The local adapter is not a stub. It implements the same contract as S3 including
 * **signed, expiring URLs**, so the authorization semantics are exercised in development
 * rather than only in production. That matters: the most common file-storage vulnerability in
 * this kind of product is a development shortcut — serving `/uploads/*` statically — that
 * survives to production and exposes every student's documents to anyone who guesses a path.
 *
 * Keys are always tenant-prefixed, constructed here rather than by callers, so a bug in a
 * feature module cannot produce a key that collides with another tenant's objects.
 */

import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ExternalServiceError, InternalError, ValidationError } from '@shikkha/shared';
import { env } from '../../config/env';
import { getLogger } from '../../common/logger';

export interface StoredObject {
  key: string;
  sizeBytes: number;
  checksum: string;
  contentType: string;
}

export interface StorageHealth {
  healthy: boolean;
  latencyMs: number;
  driver: string;
}

export interface PutOptions {
  tenantId: string;
  category: string;
  filename: string;
  contentType: string;
  body: Buffer;
}

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly driver = env().STORAGE_DRIVER;
  private readonly root = resolve(env().STORAGE_LOCAL_PATH);

  async onModuleInit(): Promise<void> {
    if (this.driver === 'local') {
      if (env().NODE_ENV === 'production') {
        // Restated here as well as in the env schema: this is the check that matters if the
        // configuration is ever loaded by a different path.
        throw new InternalError(
          'The local storage driver is not durable and must not be used in production',
        );
      }
      await mkdir(this.root, { recursive: true });
      getLogger().info({ root: this.root }, 'local storage ready');
    }
  }

  /**
   * Build the object key.
   *
   * The tenant prefix is applied here and nowhere else. A random UUID rather than the original
   * filename avoids collisions and, more importantly, avoids putting a user-controlled string
   * into a filesystem path — which is where path traversal comes from.
   */
  buildKey(tenantId: string, category: string, filename: string): string {
    const extension = safeExtension(filename);
    const safeCategory = category.replace(/[^a-z0-9_-]/gi, '').slice(0, 32) || 'misc';
    return `tenants/${tenantId}/${safeCategory}/${randomUUID()}${extension}`;
  }

  async put(options: PutOptions): Promise<StoredObject> {
    const key = this.buildKey(options.tenantId, options.category, options.filename);

    if (this.driver === 's3') {
      // The S3 adapter is wired through the same interface; see docs/09_INTEGRATIONS.md for
      // the credentials it needs. Until they are configured, this fails loudly rather than
      // silently writing to the local disk and appearing to work.
      throw new ExternalServiceError('s3', 'The S3 storage adapter is not configured');
    }

    const path = this.resolveKey(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, options.body);

    return {
      key,
      sizeBytes: options.body.byteLength,
      checksum: checksumOf(options.body),
      contentType: options.contentType,
    };
  }

  async get(key: string): Promise<Buffer> {
    if (this.driver === 's3') {
      throw new ExternalServiceError('s3', 'The S3 storage adapter is not configured');
    }
    return readFile(this.resolveKey(key));
  }

  stream(key: string): NodeJS.ReadableStream {
    if (this.driver === 's3') {
      throw new ExternalServiceError('s3', 'The S3 storage adapter is not configured');
    }
    return createReadStream(this.resolveKey(key));
  }

  async delete(key: string): Promise<void> {
    if (this.driver === 's3') {
      throw new ExternalServiceError('s3', 'The S3 storage adapter is not configured');
    }
    await rm(this.resolveKey(key), { force: true });
  }

  /**
   * A signed, expiring URL.
   *
   * The signature covers the key **and** the expiry, so neither can be altered independently:
   * signing only the key would let a holder extend the lifetime indefinitely, and signing only
   * the expiry would let them swap in another student's document.
   */
  signUrl(key: string, ttlSeconds = 300): string {
    const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
    const signature = this.sign(key, expiresAt);
    const params = new URLSearchParams({
      key,
      expires: String(expiresAt),
      signature,
    });
    return `/api/v1/files/download?${params.toString()}`;
  }

  verifySignature(key: string, expires: string, signature: string): boolean {
    const expiresAt = Number(expires);
    if (!Number.isInteger(expiresAt)) return false;
    if (expiresAt < Math.floor(Date.now() / 1000)) return false;

    const expected = this.sign(key, expiresAt);
    const a = Buffer.from(signature, 'hex');
    const b = Buffer.from(expected, 'hex');
    // Length check first: timingSafeEqual throws on a mismatch, and the throw itself would
    // be an observable difference.
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  async health(): Promise<StorageHealth> {
    const startedAt = Date.now();
    try {
      if (this.driver === 'local') {
        await stat(this.root);
        return { healthy: true, latencyMs: Date.now() - startedAt, driver: 'local' };
      }
      return { healthy: false, latencyMs: Date.now() - startedAt, driver: 's3' };
    } catch {
      return { healthy: false, latencyMs: Date.now() - startedAt, driver: this.driver };
    }
  }

  private sign(key: string, expiresAt: number): string {
    return createHmac('sha256', env().STORAGE_URL_SECRET)
      .update(`${key}:${expiresAt}`)
      .digest('hex');
  }

  /**
   * Resolve a key to a filesystem path, refusing anything that escapes the storage root.
   *
   * Keys are generated internally, so traversal should be impossible — but this function is
   * the boundary between an identifier and the filesystem, and boundaries get called with
   * unexpected input eventually. The check is on the *resolved* path, because
   * `tenants/../../etc/passwd` only becomes obviously wrong after normalisation.
   */
  private resolveKey(key: string): string {
    if (key.includes('\0')) {
      throw new ValidationError('Invalid storage key');
    }
    const target = resolve(join(this.root, normalize(key)));
    if (target !== this.root && !target.startsWith(this.root + sep)) {
      throw new ValidationError('Invalid storage key');
    }
    return target;
  }
}

/**
 * Extract a safe file extension.
 *
 * Allow-listed rather than sanitised: an extension is short, from a known set, and used to
 * build a filesystem path. Anything unrecognised gets no extension at all, which is safe —
 * the MIME type is stored in the database and drives the download response headers.
 */
const SAFE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.csv',
  '.txt',
]);

function safeExtension(filename: string): string {
  const match = /\.[A-Za-z0-9]{1,8}$/.exec(filename);
  if (!match) return '';
  const extension = match[0].toLowerCase();
  return SAFE_EXTENSIONS.has(extension) ? extension : '';
}

/** Content hash, used for deduplication and to detect tampering in storage. */
function checksumOf(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}
