/**
 * Guardian schemas (Phase 4).
 *
 * The link between a guardian and a student is the authorization fact behind every parent
 * portal read, so `linkGuardianSchema` is effectively a permission grant. It is validated
 * strictly and its endpoint is audited.
 */

import { z } from 'zod';
import { GUARDIAN_RELATIONS } from '@shikkha/shared';
import {
  bdPhoneSchema,
  nidSchema,
  optionalBdPhoneSchema,
  paginationSchema,
  reasonSchema,
  searchSchema,
  sortSchema,
  uuidSchema,
} from './common';

export const createGuardianSchema = z.object({
  fullNameEn: z.string().trim().min(2).max(255),
  fullNameBn: z.string().trim().max(255).optional(),
  /** Required and normalised: this is the deduplication key for guardian records. */
  phone: bdPhoneSchema,
  alternatePhone: optionalBdPhoneSchema,
  email: z.string().trim().toLowerCase().email().max(320).optional().or(z.literal('')),
  nationalId: nidSchema.optional(),
  occupation: z.string().trim().max(128).optional(),
  employer: z.string().trim().max(255).optional(),
  /** A band rather than an exact figure — enough for scholarship assessment, less intrusive. */
  incomeBand: z
    .enum(['under_15k', '15k_30k', '30k_60k', '60k_100k', 'over_100k', 'undisclosed'])
    .optional(),
  educationLevel: z.string().trim().max(64).optional(),
  address: z.string().trim().max(1000).optional(),
  preferredChannel: z.enum(['sms', 'email', 'push', 'app']).default('sms'),
  preferredLocale: z.enum(['en', 'bn']).default('bn'),
});

export const updateGuardianSchema = createGuardianSchema
  .partial()
  .extend({ version: z.number().int().min(1) });

/**
 * Link a guardian to a student.
 *
 * `canAccessPortal` defaults to true because the overwhelmingly common case is a parent who
 * should see their child. `hasCustody` defaults to true for the same reason — but both are
 * present and settable, because the cases where they are false (a non-custodial parent, a
 * relative listed only for emergencies) are exactly the cases where getting it wrong causes
 * real harm.
 */
export const linkGuardianSchema = z
  .object({
    guardianId: uuidSchema,
    relation: z.enum(GUARDIAN_RELATIONS),
    relationOther: z.string().trim().max(64).optional(),
    isPrimary: z.boolean().default(false),
    isBillingContact: z.boolean().default(false),
    isEmergencyContact: z.boolean().default(true),
    canAccessPortal: z.boolean().default(true),
    hasCustody: z.boolean().default(true),
    notes: z.string().trim().max(500).optional(),
  })
  .refine((data) => data.relation !== 'other' || Boolean(data.relationOther), {
    message: 'Describe the relationship when choosing "other"',
    path: ['relationOther'],
  })
  .refine((data) => !data.isBillingContact || data.canAccessPortal, {
    // A billing contact who cannot see the portal cannot see the invoice they are being
    // chased for, which produces support calls rather than payments.
    message: 'A billing contact must have portal access',
    path: ['canAccessPortal'],
  });

export const updateGuardianLinkSchema = z.object({
  relation: z.enum(GUARDIAN_RELATIONS).optional(),
  relationOther: z.string().trim().max(64).nullable().optional(),
  isPrimary: z.boolean().optional(),
  isBillingContact: z.boolean().optional(),
  isEmergencyContact: z.boolean().optional(),
  canAccessPortal: z.boolean().optional(),
  hasCustody: z.boolean().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
});

/** Revoking access is a security-relevant action, so it carries a mandatory reason. */
export const unlinkGuardianSchema = z.object({
  reason: reasonSchema,
});

export const listGuardiansSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema)
  .extend({
    studentId: uuidSchema.optional(),
    hasPortalAccess: z.coerce.boolean().optional(),
    includeArchived: z.coerce.boolean().default(false),
  });

export const GUARDIAN_SORT_FIELDS = ['fullNameEn', 'phone', 'createdAt'] as const;

/**
 * Invite a guardian to the parent portal.
 *
 * Creates a user account bound to the guardian record and grants the `guardian` role. It is
 * separate from guardian creation because a school records hundreds of guardians who will
 * never log in, and creating dormant accounts for all of them is both wasteful and a larger
 * credential surface than necessary.
 */
export const inviteGuardianSchema = z.object({
  guardianId: uuidSchema,
  /** At least one channel is needed to deliver the invitation. */
  email: z.string().trim().toLowerCase().email().max(320).optional(),
  sendSms: z.boolean().default(true),
  locale: z.enum(['en', 'bn']).default('bn'),
});
