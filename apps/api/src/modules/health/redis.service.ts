/**
 * Redis connection.
 *
 * Used for caching, rate-limit counters and (from Phase 14) the BullMQ job queue. The
 * important configuration decision is `enableOfflineQueue: false`: by default ioredis buffers
 * commands issued while disconnected and replays them on reconnect, which turns a Redis
 * outage into a slowly-growing memory leak and a burst of stale writes when it recovers.
 * Failing fast lets callers degrade gracefully instead.
 */

import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { env } from '../../config/env';
import { getLogger } from '../../common/logger';

export interface RedisHealth {
  /** 'up' — reachable. 'connecting' — transiently unavailable. 'down' — genuinely unreachable. */
  state: 'up' | 'connecting' | 'down';
  latencyMs: number;
}

@Injectable()
export class RedisService implements OnModuleDestroy {
  private client: Redis | null = null;
  private connectionFailures = 0;

  private get redis(): Redis {
    if (!this.client) {
      this.client = new Redis(env().REDIS_URL, {
        maxRetriesPerRequest: 2,
        enableOfflineQueue: false,
        lazyConnect: false,
        retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
      });
      this.client.on('error', (error) => {
        this.connectionFailures += 1;
        // Logged at warn, not error: Redis being briefly unreachable is a degradation, and
        // logging it at error level trains people to ignore error-level logs.
        if (this.connectionFailures <= 3 || this.connectionFailures % 50 === 0) {
          getLogger().warn(
            { err: error, failures: this.connectionFailures },
            'redis connection error',
          );
        }
      });
      this.client.on('ready', () => {
        this.connectionFailures = 0;
      });
    }
    return this.client;
  }

  /**
   * Health probe.
   *
   * Distinguishes "reconnecting" from "down", which matters because `enableOfflineQueue: false`
   * makes a command issued during a reconnect fail *immediately* rather than waiting. That is
   * the behaviour we want for application caching — fail fast and fall back to the source of
   * truth — but reported bluntly as "down" it flaps the readiness probe every time the
   * connection blips, pulling healthy instances out of the load balancer for no reason.
   *
   * ioredis exposes its connection state, so a failure while connecting is reported as
   * transient and a failure while nominally ready is reported as down.
   */
  async ping(): Promise<RedisHealth> {
    const startedAt = Date.now();
    const status = this.redis.status;
    try {
      await this.redis.ping();
      return { state: 'up', latencyMs: Date.now() - startedAt };
    } catch {
      const transient =
        status === 'connecting' || status === 'reconnecting' || status === 'connect';
      return { state: transient ? 'connecting' : 'down', latencyMs: Date.now() - startedAt };
    }
  }

  /**
   * Cache read. Returns null on any failure rather than throwing.
   *
   * A cache is an optimisation. If it is unavailable, the correct behaviour is to fall back to
   * the source of truth, not to fail the user's request.
   */
  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.redis.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch {
      // Same reasoning as `get`: a failed cache write must not fail the request.
    }
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    try {
      await this.redis.del(...keys);
    } catch {
      // Ignored — a stale cache entry expires on its own.
    }
  }

  /**
   * Increment a counter with an expiry, for rate limiting.
   *
   * Unlike the cache helpers this one **propagates failures**, because a rate limiter that
   * silently returns 0 when Redis is down is a rate limiter that is off. The caller decides
   * whether to fail open or closed for its particular endpoint.
   */
  async incrementWithExpiry(key: string, ttlSeconds: number): Promise<number> {
    const results = await this.redis.multi().incr(key).expire(key, ttlSeconds, 'NX').exec();
    const value = results?.[0]?.[1];
    return typeof value === 'number' ? value : 0;
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.quit().catch(() => undefined);
  }
}
