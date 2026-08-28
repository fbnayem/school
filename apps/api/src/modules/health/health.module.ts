import { Global, Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { RedisService } from './redis.service';

@Global()
@Module({
  controllers: [HealthController],
  providers: [RedisService],
  exports: [RedisService],
})
export class HealthModule {}
