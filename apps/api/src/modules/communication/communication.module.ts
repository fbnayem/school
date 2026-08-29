import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { CommunicationController } from './communication.controller';
import { CommunicationService } from './communication.service';

/**
 * `DatabaseModule`, `AuditModule` and `StorageModule` are all `@Global()`, so
 * `DatabaseService`, `AuditService` and `StorageService` inject directly (the fees, library
 * and hr modules document the same choice). Students, guardians, enrollments and employees
 * are read through the schema rather than through another module's service, because audience
 * resolution needs the caller's *data scope* applied in SQL — not another module's notion of
 * a visible subset.
 *
 * `NotificationsModule` is imported explicitly: the notification provider abstraction is the
 * single place send mechanics and the SMS encoding arithmetic (`smsEncodingOf` — GSM 7-bit
 * 160/153 versus UCS-2 70/67) live. This module consumes that abstraction; it must never
 * grow a second one.
 *
 * `CommunicationService` is exported for later phases (e.g. automation rules that need to
 * enqueue a notification through the same approval-gated path rather than around it).
 */
@Module({
  imports: [NotificationsModule],
  controllers: [CommunicationController],
  providers: [CommunicationService],
  exports: [CommunicationService],
})
export class CommunicationModule {}
