import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { normalizeOffsetPage } from '@shikkha/shared';
import { paginationSchema, uuidSchema } from '@shikkha/validation';
import { AuditService } from './audit.service';
import { RequirePermissions } from '../../common/decorators';
import { zodQuery } from '../../common/pipes/zod-validation.pipe';

const auditQuerySchema = paginationSchema.extend({
  module: z.string().trim().max(64).optional(),
  resourceType: z.string().trim().max(64).optional(),
  resourceId: uuidSchema.optional(),
  actorUserId: uuidSchema.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

@ApiTags('audit')
@Controller('audit-logs')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  /**
   * Reads run through the tenant context, so an auditor sees their own tenant's trail and
   * nothing else — the privileged write path does not make the read path privileged.
   */
  @Get()
  @RequirePermissions('audit.view')
  @ApiOperation({ summary: 'Search the audit trail' })
  async list(@Query(zodQuery(auditQuerySchema)) query: z.infer<typeof auditQuerySchema>) {
    return this.audit.list(query, normalizeOffsetPage(query));
  }
}
