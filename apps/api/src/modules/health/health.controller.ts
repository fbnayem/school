/**
 * Health endpoints.
 *
 * Three, because orchestrators need to ask three different questions and answering them all
 * with one endpoint causes real outages:
 *
 *  - `/health/live`  — is the process running? No dependency checks. A liveness probe that
 *    checks the database will restart every API pod during a brief database blip, turning a
 *    30-second degradation into a full outage.
 *  - `/health/ready` — can this instance serve traffic? Checks dependencies. A failing
 *    readiness probe removes the instance from the load balancer without killing it.
 *  - `/health`       — detailed status for humans and dashboards.
 *
 * All three are public and none reveal version numbers, connection strings or error detail to
 * an unauthenticated caller: an unauthenticated health endpoint is a reconnaissance surface.
 */

import { Controller, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../../common/decorators';
import { DatabaseService } from '../database/database.service';
import { RedisService } from './redis.service';
import { StorageService } from '../storage/storage.service';

interface ComponentStatus {
  status: 'up' | 'down' | 'degraded';
  latencyMs?: number;
  detail?: string;
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly storage: StorageService,
  ) {}

  @Public()
  @Get('live')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Liveness probe — process is running' })
  live() {
    return { status: 'ok', uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000) };
  }

  @Public()
  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe — dependencies are reachable' })
  async ready(@Res({ passthrough: true }) response: Response) {
    const [database, cache] = await Promise.all([this.checkDatabase(), this.checkRedis()]);
    const ready = database.status === 'up' && cache.status !== 'down';

    if (!ready) response.status(HttpStatus.SERVICE_UNAVAILABLE);
    // The component names are returned, but not the failure detail — that goes to the logs.
    return {
      status: ready ? 'ready' : 'not_ready',
      components: {
        database: database.status,
        redis: cache.status,
      },
    };
  }

  @Public()
  @Get()
  @ApiOperation({ summary: 'Detailed health of every dependency' })
  async detailed(@Res({ passthrough: true }) response: Response) {
    const [database, cache, storage] = await Promise.all([
      this.checkDatabase(),
      this.checkRedis(),
      this.checkStorage(),
    ]);

    const components = { database, redis: cache, storage };
    const healthy = Object.values(components).every((component) => component.status !== 'down');
    if (!healthy) response.status(HttpStatus.SERVICE_UNAVAILABLE);

    return {
      status: healthy ? 'ok' : 'unhealthy',
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      components,
    };
  }

  private async checkDatabase(): Promise<ComponentStatus> {
    const result = await this.db.health();
    if (!result.healthy) return { status: 'down', latencyMs: result.latencyMs };
    // A saturated pool is not down, but it is about to be. Surfacing it as degraded gives
    // monitoring a chance to alert before requests start queueing.
    if (result.poolWaiting > 0) {
      return {
        status: 'degraded',
        latencyMs: result.latencyMs,
        detail: `${result.poolWaiting} request(s) waiting for a connection`,
      };
    }
    return { status: 'up', latencyMs: result.latencyMs };
  }

  private async checkRedis(): Promise<ComponentStatus> {
    const result = await this.redis.ping();
    return result.healthy
      ? { status: 'up', latencyMs: result.latencyMs }
      : { status: 'down', latencyMs: result.latencyMs };
  }

  private async checkStorage(): Promise<ComponentStatus> {
    const result = await this.storage.health();
    return result.healthy
      ? { status: 'up', latencyMs: result.latencyMs, detail: result.driver }
      : { status: 'down', latencyMs: result.latencyMs, detail: result.driver };
  }
}
