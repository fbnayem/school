import { Module } from '@nestjs/common';
import { NOTIFICATION_PROVIDER } from './notification.provider';
import { NotificationService } from './notification.service';

/**
 * Exposes the notification abstraction under both its concrete class and the
 * `NOTIFICATION_PROVIDER` token. Services inject the token, so swapping in a queue-backed
 * or vendor-backed provider later is a module change, not a call-site change.
 */
@Module({
  providers: [
    NotificationService,
    { provide: NOTIFICATION_PROVIDER, useExisting: NotificationService },
  ],
  exports: [NotificationService, NOTIFICATION_PROVIDER],
})
export class NotificationsModule {}
