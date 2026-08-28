import { Global, Module } from '@nestjs/common';
import { createDatabase } from '@shikkha/db';
import { env } from '../../config/env';
import { DATABASE_HANDLE, DatabaseService } from './database.service';

/**
 * Global because nearly every module needs it, and the alternative — importing
 * DatabaseModule into twenty feature modules — adds noise without adding isolation.
 */
@Global()
@Module({
  providers: [
    {
      provide: DATABASE_HANDLE,
      useFactory: () => {
        const config = env();
        return createDatabase({
          connectionString: config.DATABASE_URL,
          maxConnections: config.DATABASE_POOL_MAX,
          statementTimeoutMillis: config.DATABASE_STATEMENT_TIMEOUT_MS,
          logQueries: config.DATABASE_LOG_QUERIES,
        });
      },
    },
    DatabaseService,
  ],
  exports: [DatabaseService],
})
export class DatabaseModule {}
