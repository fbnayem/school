import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { SecurityEventService } from './security-event.service';
import { AuditController } from './audit.controller';

/** Global: the guards and the audit interceptor both depend on these services. */
@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService, SecurityEventService],
  exports: [AuditService, SecurityEventService],
})
export class AuditModule {}
