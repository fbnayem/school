/**
 * Guardian service (Phase 4).
 *
 * The brief says to test guardian access aggressively, and the reason is visible in the shape
 * of this file: `student_guardians` is not a convenience join, it is an **authorization
 * table**. A row in it is what makes a parent able to see a child's attendance, marks and
 * fees. So:
 *
 *  - Linking and unlinking are audited, permissioned actions, not incidental writes.
 *  - `canAccessPortal` is checked at read time, not cached in a token, so revoking it takes
 *    effect on the next request rather than at the next login.
 *  - A guardian reading their own record sees only guardians linked to the same children,
 *    which is what `guardians.view.own` means — not "the guardian table filtered by my id",
 *    because a parent legitimately needs to see the other parent's emergency contact.
 */

import { Injectable } from '@nestjs/common';
import { and, asc, eq, exists, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { guardians, studentGuardians, students } from '@shikkha/db';
import {
  buildOffsetPage,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  offsetOf,
  uuidv7,
  type OffsetPage,
  type OffsetPageRequest,
} from '@shikkha/shared';
import { resolveDataScope, SCOPED_RESOURCES, type Principal } from '@shikkha/permissions';
import { DatabaseService } from '../database/database.service';
import { StudentsService } from '../students/students.service';
import { currentContext } from '../../common/context/request-context';

type GuardianRow = typeof guardians.$inferSelect;

export interface ListGuardiansQuery {
  page: number;
  pageSize: number;
  q?: string;
  studentId?: string;
  hasPortalAccess?: boolean;
  includeArchived: boolean;
}

@Injectable()
export class GuardiansService {
  constructor(
    private readonly db: DatabaseService,
    // Guardian visibility is derived from student visibility: you may see a child's guardians
    // exactly when you may see the child. Delegating keeps one definition of that rule.
    private readonly students: StudentsService,
  ) {}

  async list(
    principal: Principal,
    query: ListGuardiansQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<GuardianRow>> {
    const scope = resolveDataScope(principal, SCOPED_RESOURCES.guardians, {
      institutionId: currentContext()?.institutionId ?? null,
    });
    if (scope === 'none') {
      throw new ForbiddenError('guardians.view.all', 'You cannot view guardian records');
    }

    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [this.scopeFilter(principal, scope)];
      if (!query.includeArchived) filters.push(isNull(guardians.archivedAt));

      const institutionId = currentContext()?.institutionId;
      if (institutionId) filters.push(eq(guardians.institutionId, institutionId));

      if (query.q) {
        filters.push(
          or(
            sql`${guardians}.search_vector @@ websearch_to_tsquery('simple', ${query.q})`,
            ilike(guardians.phone, `%${query.q}%`),
          )!,
        );
      }

      if (query.studentId) {
        filters.push(
          exists(
            this.db.raw
              .select({ one: sql`1` })
              .from(studentGuardians)
              .where(
                and(
                  eq(studentGuardians.guardianId, guardians.id),
                  eq(studentGuardians.studentId, query.studentId),
                  isNull(studentGuardians.archivedAt),
                ),
              ),
          ),
        );
      }

      const where = and(...filters);
      const rows = await tx
        .select()
        .from(guardians)
        .where(where)
        .orderBy(asc(guardians.fullNameEn), asc(guardians.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(guardians)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  /**
   * The children a guardian may see.
   *
   * This is the single most security-sensitive read in the parent portal, so it is a distinct
   * method rather than a filter on the student list: there is exactly one query that answers
   * "which children does this guardian have access to", and it is this one.
   */
  async myChildren(principal: Principal) {
    if (!principal.guardianId) {
      throw new ForbiddenError(undefined, 'This account is not linked to a guardian record');
    }
    const guardianId = principal.guardianId;

    return this.db.runInTenant(async (tx) =>
      tx
        .select({
          studentId: students.id,
          fullNameEn: students.fullNameEn,
          fullNameBn: students.fullNameBn,
          studentCode: students.studentCode,
          photoFileId: students.photoFileId,
          status: students.status,
          relation: studentGuardians.relation,
          isPrimary: studentGuardians.isPrimary,
          isBillingContact: studentGuardians.isBillingContact,
        })
        .from(studentGuardians)
        .innerJoin(students, eq(students.id, studentGuardians.studentId))
        .where(
          and(
            eq(studentGuardians.guardianId, guardianId),
            // Both conditions matter: a revoked link and an archived link are different
            // states, and either must exclude the child.
            eq(studentGuardians.canAccessPortal, true),
            isNull(studentGuardians.archivedAt),
            isNull(students.archivedAt),
          ),
        )
        .orderBy(asc(students.fullNameEn)),
    );
  }

  async create(
    principal: Principal,
    institutionId: string,
    input: Record<string, unknown>,
  ): Promise<GuardianRow> {
    return this.db.runInTenant(async (tx) => {
      const phone = input['phone'] as string;

      // The phone number is the deduplication key. Returning the existing record rather than
      // creating a second one is what keeps a family with three children as one guardian.
      const [existing] = await tx
        .select()
        .from(guardians)
        .where(
          and(
            eq(guardians.institutionId, institutionId),
            eq(guardians.phone, phone),
            isNull(guardians.archivedAt),
          ),
        )
        .limit(1);

      if (existing) {
        throw new ConflictError(
          `A guardian with this phone number already exists (${existing.fullNameEn}). Link the student to that record instead of creating a duplicate.`,
          { existingGuardianId: existing.id },
        );
      }

      const [created] = await tx
        .insert(guardians)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          fullNameEn: input['fullNameEn'] as string,
          fullNameBn: (input['fullNameBn'] as string) ?? null,
          phone,
          alternatePhone: (input['alternatePhone'] as string) ?? null,
          email: (input['email'] as string) || null,
          nationalId: (input['nationalId'] as string) ?? null,
          occupation: (input['occupation'] as string) ?? null,
          employer: (input['employer'] as string) ?? null,
          incomeBand: (input['incomeBand'] as string) ?? null,
          educationLevel: (input['educationLevel'] as string) ?? null,
          address: (input['address'] as string) ?? null,
          preferredChannel: (input['preferredChannel'] as string) ?? 'sms',
          preferredLocale: (input['preferredLocale'] as string) ?? 'bn',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();

      return created!;
    });
  }

  /**
   * Link a guardian to a student — effectively granting access to that child's records.
   */
  async link(
    principal: Principal,
    studentId: string,
    input: {
      guardianId: string;
      relation: string;
      relationOther?: string;
      isPrimary: boolean;
      isBillingContact: boolean;
      isEmergencyContact: boolean;
      canAccessPortal: boolean;
      hasCustody: boolean;
      notes?: string;
    },
  ) {
    await this.students.assertVisible(principal, studentId);

    return this.db.runInTenant(async (tx) => {
      // Both sides must exist in the caller's tenant. RLS guarantees the tenant part; these
      // reads confirm they exist at all and belong to the same institution.
      const [student] = await tx
        .select({ id: students.id, institutionId: students.institutionId })
        .from(students)
        .where(and(eq(students.id, studentId), isNull(students.archivedAt)))
        .limit(1);
      if (!student) throw new NotFoundError('Student', studentId);

      const [guardian] = await tx
        .select({ id: guardians.id, institutionId: guardians.institutionId })
        .from(guardians)
        .where(and(eq(guardians.id, input.guardianId), isNull(guardians.archivedAt)))
        .limit(1);
      if (!guardian) throw new NotFoundError('Guardian', input.guardianId);

      if (guardian.institutionId !== student.institutionId) {
        // Same tenant, different school. Linking across them would let a parent at one campus
        // see a child at another, which is a real scenario in a school group.
        throw new ConflictError(
          'The guardian and the student belong to different institutions. Create the guardian in the same institution as the student.',
        );
      }

      // Only one primary and one billing contact per student, enforced by partial unique
      // indexes. Clearing the previous holder in the same transaction turns a constraint
      // violation into the behaviour the user actually intended.
      if (input.isPrimary) {
        await tx
          .update(studentGuardians)
          .set({ isPrimary: false, updatedBy: principal.userId })
          .where(
            and(
              eq(studentGuardians.studentId, studentId),
              eq(studentGuardians.isPrimary, true),
              isNull(studentGuardians.archivedAt),
            ),
          );
      }
      if (input.isBillingContact) {
        await tx
          .update(studentGuardians)
          .set({ isBillingContact: false, updatedBy: principal.userId })
          .where(
            and(
              eq(studentGuardians.studentId, studentId),
              eq(studentGuardians.isBillingContact, true),
              isNull(studentGuardians.archivedAt),
            ),
          );
      }

      const [created] = await tx
        .insert(studentGuardians)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId: student.institutionId,
          studentId,
          guardianId: input.guardianId,
          relation: input.relation as never,
          relationOther: input.relationOther ?? null,
          isPrimary: input.isPrimary,
          isBillingContact: input.isBillingContact,
          isEmergencyContact: input.isEmergencyContact,
          canAccessPortal: input.canAccessPortal,
          hasCustody: input.hasCustody,
          notes: input.notes ?? null,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();

      return created!;
    });
  }

  /**
   * Remove a guardian's access to a student.
   *
   * Archived rather than deleted, because "who had access to this child's records, and when"
   * is a question a school may need to answer years later — during a custody dispute, for
   * example.
   */
  async unlink(principal: Principal, studentId: string, guardianId: string, reason: string) {
    await this.students.assertVisible(principal, studentId);

    return this.db.runInTenant(async (tx) => {
      const [link] = await tx
        .select()
        .from(studentGuardians)
        .where(
          and(
            eq(studentGuardians.studentId, studentId),
            eq(studentGuardians.guardianId, guardianId),
            isNull(studentGuardians.archivedAt),
          ),
        )
        .limit(1);

      if (!link) throw new NotFoundError('Guardian link');

      const [remaining] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(studentGuardians)
        .where(
          and(
            eq(studentGuardians.studentId, studentId),
            isNull(studentGuardians.archivedAt),
            sql`${studentGuardians.guardianId} <> ${guardianId}`,
          ),
        );

      if ((remaining?.total ?? 0) === 0) {
        // A student with no guardian has no emergency contact and no one to receive their
        // fee notices. Refusing here forces the school to add the replacement first.
        throw new ConflictError(
          'This is the student’s only guardian. Add another guardian before removing this one.',
        );
      }

      const [archived] = await tx
        .update(studentGuardians)
        .set({
          archivedAt: new Date(),
          archivedBy: principal.userId,
          canAccessPortal: false,
          isPrimary: false,
          isBillingContact: false,
          updatedBy: principal.userId,
        })
        .where(eq(studentGuardians.id, link.id))
        .returning();

      return { link: archived!, __audit: { previousValue: link, newValue: { reason } } };
    });
  }

  async listForStudent(principal: Principal, studentId: string) {
    // Throws NotFoundError when the student is outside the caller's scope, so a cross-tenant
    // or cross-section id returns 404 rather than an empty list.
    await this.students.assertVisible(principal, studentId);

    return this.db.runInTenant(async (tx) =>
      tx
        .select({
          linkId: studentGuardians.id,
          guardianId: guardians.id,
          fullNameEn: guardians.fullNameEn,
          fullNameBn: guardians.fullNameBn,
          phone: guardians.phone,
          email: guardians.email,
          occupation: guardians.occupation,
          relation: studentGuardians.relation,
          relationOther: studentGuardians.relationOther,
          isPrimary: studentGuardians.isPrimary,
          isBillingContact: studentGuardians.isBillingContact,
          isEmergencyContact: studentGuardians.isEmergencyContact,
          canAccessPortal: studentGuardians.canAccessPortal,
          hasCustody: studentGuardians.hasCustody,
          hasLogin: sql<boolean>`${guardians.userId} is not null`,
        })
        .from(studentGuardians)
        .innerJoin(guardians, eq(guardians.id, studentGuardians.guardianId))
        .where(
          and(
            eq(studentGuardians.studentId, studentId),
            isNull(studentGuardians.archivedAt),
            isNull(guardians.archivedAt),
          ),
        )
        .orderBy(sql`${studentGuardians.isPrimary} desc`, asc(guardians.fullNameEn)),
    );
  }

  /**
   * `own` scope for guardians: the guardians of the children this guardian can see.
   *
   * Not "the row whose id equals mine" — a parent needs the other parent's contact details,
   * and a school that hides them creates a support call every time one parent is unreachable.
   */
  private scopeFilter(principal: Principal, scope: 'all' | 'own' | 'assigned'): SQL {
    if (scope === 'all') return sql`true`;
    if (!principal.guardianId) return sql`false`;
    const guardianId = principal.guardianId;

    return exists(
      this.db.raw
        .select({ one: sql`1` })
        .from(studentGuardians)
        .where(
          and(
            eq(studentGuardians.guardianId, guardians.id),
            inArray(
              studentGuardians.studentId,
              this.db.raw
                .select({ studentId: studentGuardians.studentId })
                .from(studentGuardians)
                .where(
                  and(
                    eq(studentGuardians.guardianId, guardianId),
                    eq(studentGuardians.canAccessPortal, true),
                    isNull(studentGuardians.archivedAt),
                  ),
                ),
            ),
            isNull(studentGuardians.archivedAt),
          ),
        ),
    );
  }
}
