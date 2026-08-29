/**
 * Library service (Phase 17).
 *
 * The rules this file keeps, in the order they matter:
 *
 *  1. **One live loan per copy is a database property.** The service checks a copy's status
 *     under a row lock (`for update`) so the common case gets a friendly 409, but the actual
 *     guarantee is the partial unique index `library_loans_copy_active_key` — two concurrent
 *     issues collide in Postgres, and the exceptions filter surfaces that as a 409 too.
 *  2. **No floating-point money.** A fine, a cost and the per-day rate are `numeric(14, 2)`,
 *     parsed only by `Money.fromDecimalString`, multiplied only by `Money.times` with an
 *     integer day count, and written only by `Money.toDecimalString` (ADR-004).
 *  3. **A fine is assessed, never computed on read.** The per-day rate in the settings
 *     charges nobody until `assessFines` — explicit, reasoned, audited inside the business
 *     transaction — writes rows. Re-running for the same date is a no-op: the run assesses
 *     only the difference between what has accrued and what is already on record, and the
 *     partial unique index on `(loan_id, assessed_on)` refuses a same-day duplicate even
 *     under concurrency.
 *  4. **Derived facts are derived here.** `library_titles.total_copies` is recomputed from
 *     the copy rows, `library_loans.fine_amount` from the live non-waived fine rows —
 *     recomputed as sums, never incremented, in the same transaction as the change.
 *  5. **Nothing is deleted.** Copies are withdrawn with a reason, members are archived,
 *     fines are paid or waived, reservations are cancelled or expire. Every row stays.
 *  6. **Self-service reads are scoped by identity, not by input.** `myLoans` derives the
 *     member set from the principal's own student, employee or guardian links; there is no
 *     parameter through which a student can name somebody else.
 */

import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  like,
  lt,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from 'drizzle-orm';
import {
  employees,
  files,
  libraryCategories,
  libraryCopies,
  libraryFines,
  libraryLoans,
  libraryMembers,
  libraryReservations,
  librarySettings,
  libraryTitles,
  studentGuardians,
  students,
} from '@shikkha/db';
import {
  addDays,
  buildOffsetPage,
  calendarDate,
  compareCalendarDates,
  ConflictError,
  daysBetween,
  endOfDhakaDay,
  ForbiddenError,
  instantToDhakaDate,
  Money,
  NotFoundError,
  offsetOf,
  parseSort,
  startOfDhakaDay,
  todayInDhaka,
  uuidv7,
  ValidationError,
  type OffsetPage,
  type OffsetPageRequest,
} from '@shikkha/shared';
import { can, type Permission, type Principal } from '@shikkha/permissions';
import {
  LIBRARY_CATEGORY_SORT_FIELDS,
  LIBRARY_COPY_SORT_FIELDS,
  LIBRARY_FINE_SORT_FIELDS,
  LIBRARY_LOAN_SORT_FIELDS,
  LIBRARY_MEMBER_SORT_FIELDS,
  LIBRARY_TITLE_SORT_FIELDS,
  type AssessLibraryFinesInput,
  type CreateLibraryCopiesInput,
  type CreateLibraryMemberInput,
  type CreateLibraryReservationInput,
  type CreateLibraryTitleInput,
  type IssueLibraryLoanInput,
  type LibraryStockTakeInput,
  type MarkLibraryLoanLostInput,
  type PayLibraryFineInput,
  type PutLibrarySettingsInput,
  type RenewLibraryLoanInput,
  type ReturnLibraryLoanInput,
} from '@shikkha/validation';
import { DatabaseService } from '../database/database.service';
import { AuditService } from '../audit/audit.service';
import { StorageService } from '../storage/storage.service';
import { currentContext } from '../../common/context/request-context';

/** The transaction handle `runInTenant` hands to its callback. */
type Tx = Parameters<Parameters<DatabaseService['runInTenant']>[0]>[0];

type SettingsRow = typeof librarySettings.$inferSelect;
type CategoryRow = typeof libraryCategories.$inferSelect;
type TitleRow = typeof libraryTitles.$inferSelect;
type CopyRow = typeof libraryCopies.$inferSelect;
type MemberRow = typeof libraryMembers.$inferSelect;
type LoanRow = typeof libraryLoans.$inferSelect;
type ReservationRow = typeof libraryReservations.$inferSelect;
type FineRow = typeof libraryFines.$inferSelect;

/** The slice of a multipart upload this service needs; matches Multer's file object. */
export interface UploadedFileLike {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

const MAX_COVER_BYTES = 2 * 1024 * 1024;

/** The policy applied when an institution has never saved one. Mirrors the column defaults. */
const DEFAULT_SETTINGS = {
  finePerDay: '2.00',
  maxRenewals: 1,
  reservationHoldDays: 3,
  defaultLoanDays: 14,
  defaultMaxBooks: 3,
} as const;

export interface ListQueryBase {
  page: number;
  pageSize: number;
  sort?: string;
  includeArchived: boolean;
}

export interface ListCategoriesQuery extends ListQueryBase {
  q?: string;
  parentId?: string;
}

export interface ListTitlesQuery extends ListQueryBase {
  q?: string;
  language?: string;
  categoryId?: string;
  status?: string;
}

export interface ListCopiesQuery extends ListQueryBase {
  q?: string;
  titleId?: string;
  status?: string;
  condition?: string;
}

export interface ListMembersQuery extends ListQueryBase {
  q?: string;
  memberType?: string;
  status?: string;
}

export interface ListLoansQuery extends ListQueryBase {
  memberId?: string;
  copyId?: string;
  titleId?: string;
  status?: string;
  overdueOnly: boolean;
}

export interface ListReservationsQuery extends ListQueryBase {
  titleId?: string;
  memberId?: string;
  status?: string;
}

export interface ListFinesQuery extends ListQueryBase {
  memberId?: string;
  loanId?: string;
  status?: string;
}

@Injectable()
export class LibraryService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════════════
  // Settings
  // ══════════════════════════════════════════════════════════════════════════════════

  async getSettings(institutionId: string) {
    return this.db.runInTenant(async (tx) => {
      const settings = await this.effectiveSettings(tx, institutionId);
      return settings;
    });
  }

  /** Replace the circulation policy whole. Creates the row on first save. */
  async putSettings(principal: Principal, institutionId: string, input: PutLibrarySettingsInput) {
    return this.db.runInTenant(async (tx) => {
      const finePerDay = Money.fromDecimalString(input.finePerDay).toDecimalString();
      const [existing] = await tx
        .select()
        .from(librarySettings)
        .where(
          and(eq(librarySettings.institutionId, institutionId), isNull(librarySettings.archivedAt)),
        )
        .limit(1);

      if (existing) {
        const [updated] = await tx
          .update(librarySettings)
          .set({
            finePerDay,
            maxRenewals: input.maxRenewals,
            reservationHoldDays: input.reservationHoldDays,
            defaultLoanDays: input.defaultLoanDays,
            defaultMaxBooks: input.defaultMaxBooks,
            version: existing.version + 1,
            updatedBy: principal.userId,
          })
          .where(eq(librarySettings.id, existing.id))
          .returning();
        return updated!;
      }

      const [created] = await tx
        .insert(librarySettings)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          finePerDay,
          maxRenewals: input.maxRenewals,
          reservationHoldDays: input.reservationHoldDays,
          defaultLoanDays: input.defaultLoanDays,
          defaultMaxBooks: input.defaultMaxBooks,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      return created!;
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Categories
  // ══════════════════════════════════════════════════════════════════════════════════

  async listCategories(
    principal: Principal,
    institutionId: string,
    query: ListCategoriesQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<CategoryRow>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(libraryCategories.institutionId, institutionId)];
      this.applyArchiveFilter(
        principal,
        filters,
        libraryCategories.archivedAt,
        query.includeArchived,
        'library.catalog.manage',
      );
      if (query.parentId) filters.push(eq(libraryCategories.parentId, query.parentId));
      if (query.q) filters.push(ilike(libraryCategories.nameEn, `%${query.q}%`));

      const where = and(...filters);
      const orderBy = parseSort(query.sort, LIBRARY_CATEGORY_SORT_FIELDS, {
        field: 'nameEn',
        direction: 'asc',
      }).map((spec) => {
        const column = CATEGORY_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(libraryCategories)
        .where(where)
        .orderBy(...orderBy, asc(libraryCategories.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(libraryCategories)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  async createCategory(
    principal: Principal,
    institutionId: string,
    input: { nameEn: string; nameBn?: string; parentId?: string },
  ): Promise<CategoryRow> {
    return this.db.runInTenant(async (tx) => {
      if (input.parentId) {
        await this.loadCategory(tx, institutionId, input.parentId);
      }

      const [created] = await tx
        .insert(libraryCategories)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          nameEn: input.nameEn,
          nameBn: input.nameBn ?? null,
          parentId: input.parentId ?? null,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      return created!;
    });
  }

  async updateCategory(
    principal: Principal,
    institutionId: string,
    id: string,
    input: Record<string, unknown>,
  ): Promise<{ category: CategoryRow; previous: Partial<CategoryRow> }> {
    const version = input['version'] as number;
    const { version: _ignored, ...changes } = input;

    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadCategory(tx, institutionId, id);

      const parentId = changes['parentId'] as string | null | undefined;
      if (parentId) {
        if (parentId === id) {
          throw new ValidationError('A category cannot be its own parent', [
            { path: 'parentId', message: 'Choose a different parent category' },
          ]);
        }
        await this.loadCategory(tx, institutionId, parentId);
      }

      const [updated] = await tx
        .update(libraryCategories)
        .set({
          ...(changes as Partial<CategoryRow>),
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(libraryCategories.id, id), eq(libraryCategories.version, version)))
        .returning();

      if (!updated) {
        throw new ConflictError(
          'This category was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: version, currentVersion: existing.version },
        );
      }

      return { category: updated, previous: diffOf(existing, updated, Object.keys(changes)) };
    });
  }

  async archiveCategory(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
  ): Promise<CategoryRow> {
    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadCategory(tx, institutionId, id);

      const [child] = await tx
        .select({ id: libraryCategories.id })
        .from(libraryCategories)
        .where(and(eq(libraryCategories.parentId, id), isNull(libraryCategories.archivedAt)))
        .limit(1);
      if (child) {
        throw new ConflictError(
          'This category still has sub-categories. Archive or move them first.',
        );
      }

      const [titleInUse] = await tx
        .select({ id: libraryTitles.id })
        .from(libraryTitles)
        .where(and(eq(libraryTitles.categoryId, id), isNull(libraryTitles.archivedAt)))
        .limit(1);
      if (titleInUse) {
        throw new ConflictError(
          'Titles are still classified under this category. Re-classify them first.',
        );
      }

      const [archived] = await tx
        .update(libraryCategories)
        .set({
          archivedAt: new Date(),
          archivedBy: principal.userId,
          archiveReason: reason,
          updatedBy: principal.userId,
          version: existing.version + 1,
        })
        .where(eq(libraryCategories.id, id))
        .returning();
      return archived!;
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Titles
  // ══════════════════════════════════════════════════════════════════════════════════

  async listTitles(
    principal: Principal,
    institutionId: string,
    query: ListTitlesQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<TitleRow>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(libraryTitles.institutionId, institutionId)];
      this.applyArchiveFilter(
        principal,
        filters,
        libraryTitles.archivedAt,
        query.includeArchived,
        'library.catalog.manage',
      );
      if (query.language) {
        filters.push(eq(libraryTitles.language, query.language as TitleRow['language']));
      }
      if (query.categoryId) filters.push(eq(libraryTitles.categoryId, query.categoryId));
      if (query.status) filters.push(eq(libraryTitles.status, query.status));
      if (query.q) {
        filters.push(
          or(
            ilike(libraryTitles.title, `%${query.q}%`),
            ilike(libraryTitles.author, `%${query.q}%`),
            ilike(libraryTitles.isbn, `${query.q}%`),
          )!,
        );
      }

      const where = and(...filters);
      const orderBy = parseSort(query.sort, LIBRARY_TITLE_SORT_FIELDS, {
        field: 'title',
        direction: 'asc',
      }).map((spec) => {
        const column = TITLE_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(libraryTitles)
        .where(where)
        .orderBy(...orderBy, asc(libraryTitles.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(libraryTitles)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  /** One title with its copies and the live reservation queue length. */
  async getTitle(institutionId: string, id: string) {
    return this.db.runInTenant(async (tx) => {
      const title = await this.loadTitle(tx, institutionId, id);

      const copies = await tx
        .select()
        .from(libraryCopies)
        .where(and(eq(libraryCopies.titleId, id), isNull(libraryCopies.archivedAt)))
        .orderBy(asc(libraryCopies.accessionNumber));

      const [reservationCount] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(libraryReservations)
        .where(
          and(
            eq(libraryReservations.titleId, id),
            eq(libraryReservations.status, 'active'),
            isNull(libraryReservations.archivedAt),
          ),
        );

      return { ...title, copies, activeReservations: reservationCount?.total ?? 0 };
    });
  }

  async createTitle(
    principal: Principal,
    institutionId: string,
    input: CreateLibraryTitleInput,
  ): Promise<TitleRow> {
    return this.db.runInTenant(async (tx) => {
      if (input.categoryId) {
        await this.loadCategory(tx, institutionId, input.categoryId);
      }

      const [created] = await tx
        .insert(libraryTitles)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          isbn: input.isbn ?? null,
          title: input.title,
          titleBn: input.titleBn ?? null,
          author: input.author ?? null,
          publisher: input.publisher ?? null,
          edition: input.edition ?? null,
          language: input.language,
          categoryId: input.categoryId ?? null,
          deweyCode: input.deweyCode ?? null,
          status: 'active',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      return created!;
    });
  }

  async updateTitle(
    principal: Principal,
    institutionId: string,
    id: string,
    input: Record<string, unknown>,
  ): Promise<{ title: TitleRow; previous: Partial<TitleRow> }> {
    const version = input['version'] as number;
    const { version: _ignored, ...changes } = input;

    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadTitle(tx, institutionId, id);

      const categoryId = changes['categoryId'] as string | null | undefined;
      if (categoryId) {
        await this.loadCategory(tx, institutionId, categoryId);
      }

      const [updated] = await tx
        .update(libraryTitles)
        .set({
          ...(changes as Partial<TitleRow>),
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(libraryTitles.id, id), eq(libraryTitles.version, version)))
        .returning();

      if (!updated) {
        throw new ConflictError(
          'This title was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: version, currentVersion: existing.version },
        );
      }

      return { title: updated, previous: diffOf(existing, updated, Object.keys(changes)) };
    });
  }

  async archiveTitle(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
  ): Promise<TitleRow> {
    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadTitle(tx, institutionId, id);

      const [liveCopy] = await tx
        .select({ id: libraryCopies.id })
        .from(libraryCopies)
        .where(and(eq(libraryCopies.titleId, id), isNull(libraryCopies.archivedAt)))
        .limit(1);
      if (liveCopy) {
        throw new ConflictError(
          'This title still has copies in the register. Withdraw them first.',
        );
      }

      const [liveReservation] = await tx
        .select({ id: libraryReservations.id })
        .from(libraryReservations)
        .where(
          and(
            eq(libraryReservations.titleId, id),
            eq(libraryReservations.status, 'active'),
            isNull(libraryReservations.archivedAt),
          ),
        )
        .limit(1);
      if (liveReservation) {
        throw new ConflictError(
          'This title has an active reservation queue. Cancel the reservations first.',
        );
      }

      const [archived] = await tx
        .update(libraryTitles)
        .set({
          status: 'inactive',
          archivedAt: new Date(),
          archivedBy: principal.userId,
          archiveReason: reason,
          updatedBy: principal.userId,
          version: existing.version + 1,
        })
        .where(eq(libraryTitles.id, id))
        .returning();
      return archived!;
    });
  }

  /**
   * Store a cover image and point the title at it.
   *
   * Bytes go through `StorageService.put` (tenant-prefixed key built there, never here) and
   * are written before the transaction; a failed transaction leaves an orphaned object with
   * no `files` row, invisible and swept by the cleanup job. The MIME type is determined from
   * the bytes, not from the client's claim.
   */
  async uploadCover(
    principal: Principal,
    institutionId: string,
    titleId: string,
    file: UploadedFileLike,
  ) {
    if (!file || !file.buffer || file.size === 0) {
      throw new ValidationError('No file was uploaded', [
        { path: 'file', message: 'Attach the cover image as the "file" field' },
      ]);
    }
    if (file.size > MAX_COVER_BYTES) {
      throw new ValidationError('The file is too large', [
        { path: 'file', message: 'Cover images may be at most 2 MB' },
      ]);
    }
    const mimeType = sniffImageMimeType(file.buffer);
    if (!mimeType) {
      throw new ValidationError('This file type is not accepted', [
        { path: 'file', message: 'Upload a JPEG, PNG or WebP image' },
      ]);
    }

    const tenantId = principal.tenantId!;
    const stored = await this.storage.put({
      tenantId,
      category: 'library_cover',
      filename: file.originalname,
      contentType: mimeType,
      body: file.buffer,
    });

    return this.db.runInTenant(async (tx) => {
      const title = await this.loadTitle(tx, institutionId, titleId);

      const [fileRow] = await tx
        .insert(files)
        .values({
          tenantId,
          institutionId,
          storageKey: stored.key,
          storageDriver: 'local',
          originalFilename: file.originalname.slice(0, 255),
          mimeType,
          sizeBytes: stored.sizeBytes,
          checksum: stored.checksum,
          category: 'library_cover',
          ownerType: 'library_title',
          ownerId: titleId,
          isSensitive: false,
          uploadedAt: new Date(),
          createdBy: principal.userId,
        })
        .returning();

      // A replaced cover's file row is archived so its already-issued URLs die with it.
      if (title.coverFileId) {
        await tx
          .update(files)
          .set({
            archivedAt: new Date(),
            archivedBy: principal.userId,
            archiveReason: 'Replaced by a newer cover image',
            updatedBy: principal.userId,
          })
          .where(eq(files.id, title.coverFileId));
      }

      const [updated] = await tx
        .update(libraryTitles)
        .set({
          coverFileId: fileRow!.id,
          version: title.version + 1,
          updatedBy: principal.userId,
        })
        .where(eq(libraryTitles.id, titleId))
        .returning();

      return {
        titleId,
        coverFileId: fileRow!.id,
        mimeType,
        sizeBytes: stored.sizeBytes,
        version: updated!.version,
      };
    });
  }

  /** A short-lived signed URL for the cover, exactly like a document download. */
  async coverUrl(institutionId: string, titleId: string) {
    return this.db.runInTenant(async (tx) => {
      const title = await this.loadTitle(tx, institutionId, titleId);
      if (!title.coverFileId) throw new NotFoundError('Cover image');

      const [fileRow] = await tx
        .select({ storageKey: files.storageKey, archivedAt: files.archivedAt })
        .from(files)
        .where(eq(files.id, title.coverFileId))
        .limit(1);
      if (!fileRow || fileRow.archivedAt !== null) throw new NotFoundError('Cover image');

      const ttlSeconds = 300;
      return {
        titleId,
        url: this.storage.signUrl(fileRow.storageKey, ttlSeconds),
        expiresInSeconds: ttlSeconds,
      };
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Copies
  // ══════════════════════════════════════════════════════════════════════════════════

  async listCopies(
    principal: Principal,
    institutionId: string,
    query: ListCopiesQuery,
    page: OffsetPageRequest,
  ) {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(libraryCopies.institutionId, institutionId)];
      this.applyArchiveFilter(
        principal,
        filters,
        libraryCopies.archivedAt,
        query.includeArchived,
        'library.catalog.manage',
      );
      if (query.titleId) filters.push(eq(libraryCopies.titleId, query.titleId));
      if (query.status) filters.push(eq(libraryCopies.status, query.status as CopyRow['status']));
      if (query.condition) {
        filters.push(eq(libraryCopies.condition, query.condition as CopyRow['condition']));
      }
      if (query.q) {
        filters.push(
          or(
            ilike(libraryCopies.accessionNumber, `${query.q}%`),
            ilike(libraryCopies.barcode, `${query.q}%`),
          )!,
        );
      }

      const where = and(...filters);
      const orderBy = parseSort(query.sort, LIBRARY_COPY_SORT_FIELDS, {
        field: 'accessionNumber',
        direction: 'asc',
      }).map((spec) => {
        const column = COPY_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select({
          copy: libraryCopies,
          title: libraryTitles.title,
          titleBn: libraryTitles.titleBn,
        })
        .from(libraryCopies)
        .innerJoin(libraryTitles, eq(libraryTitles.id, libraryCopies.titleId))
        .where(where)
        .orderBy(...orderBy, asc(libraryCopies.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(libraryCopies)
        .where(where);

      return buildOffsetPage(
        rows.map((row) => ({ ...row.copy, title: row.title, titleBn: row.titleBn })),
        counted?.total ?? 0,
        page,
      );
    });
  }

  /**
   * Accession one or more copies of a title.
   *
   * Accession numbers are generated as the next entries in the institution's `ACC-` register
   * (`max()` under the prefix); the partial unique index on `(institution_id,
   * accession_number)` is the real guarantee against two clerks accessioning at once.
   */
  async createCopies(
    principal: Principal,
    institutionId: string,
    input: CreateLibraryCopiesInput,
  ): Promise<CopyRow[]> {
    return this.db.runInTenant(async (tx) => {
      const title = await this.loadTitle(tx, institutionId, input.titleId);
      if (title.status !== 'active') {
        throw new ConflictError('This title is inactive; reactivate it before adding copies.');
      }

      const cost = input.cost ? Money.fromDecimalString(input.cost).toDecimalString() : null;
      const created: CopyRow[] = [];
      let sequence = await this.currentAccessionSequence(tx, institutionId);

      for (let index = 0; index < input.count; index += 1) {
        let accessionNumber: string;
        if (input.accessionNumber) {
          accessionNumber = input.accessionNumber;
        } else {
          sequence += 1;
          accessionNumber = `ACC-${String(sequence).padStart(6, '0')}`;
        }

        const [copy] = await tx
          .insert(libraryCopies)
          .values({
            id: uuidv7(),
            tenantId: principal.tenantId!,
            institutionId,
            titleId: input.titleId,
            accessionNumber,
            barcode: input.barcode ?? null,
            acquiredOn: input.acquiredOn ?? null,
            cost,
            condition: input.condition,
            status: 'available',
            shelfLocation: input.shelfLocation ?? null,
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning();
        created.push(copy!);
      }

      await this.recomputeTitleCopies(tx, input.titleId, principal.userId);
      return created;
    });
  }

  async updateCopy(
    principal: Principal,
    institutionId: string,
    id: string,
    input: Record<string, unknown>,
  ): Promise<{ copy: CopyRow; previous: Partial<CopyRow> }> {
    const version = input['version'] as number;
    const { version: _ignored, ...changes } = input;

    if (typeof changes['cost'] === 'string') {
      changes['cost'] = Money.fromDecimalString(changes['cost']).toDecimalString();
    }

    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadCopy(tx, institutionId, id);

      const [updated] = await tx
        .update(libraryCopies)
        .set({
          ...(changes as Partial<CopyRow>),
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(libraryCopies.id, id), eq(libraryCopies.version, version)))
        .returning();

      if (!updated) {
        throw new ConflictError(
          'This copy was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: version, currentVersion: existing.version },
        );
      }

      return { copy: updated, previous: diffOf(existing, updated, Object.keys(changes)) };
    });
  }

  /**
   * Withdraw a copy from the register. Never a delete: the row is archived with a reason and
   * moves to `withdrawn`, keeping the accession history intact.
   */
  async withdrawCopy(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
  ): Promise<CopyRow> {
    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadCopy(tx, institutionId, id);

      const [liveLoan] = await tx
        .select({ id: libraryLoans.id })
        .from(libraryLoans)
        .where(and(eq(libraryLoans.copyId, id), isNull(libraryLoans.returnedAt)))
        .limit(1);
      if (liveLoan) {
        throw new ConflictError(
          'This copy is currently on loan. Take it back (or mark the loan lost) first.',
        );
      }

      const [withdrawn] = await tx
        .update(libraryCopies)
        .set({
          status: 'withdrawn',
          archivedAt: new Date(),
          archivedBy: principal.userId,
          archiveReason: reason,
          updatedBy: principal.userId,
          version: existing.version + 1,
        })
        .where(eq(libraryCopies.id, id))
        .returning();

      await this.recomputeTitleCopies(tx, existing.titleId, principal.userId);
      return withdrawn!;
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Members
  // ══════════════════════════════════════════════════════════════════════════════════

  async listMembers(
    principal: Principal,
    institutionId: string,
    query: ListMembersQuery,
    page: OffsetPageRequest,
  ) {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(libraryMembers.institutionId, institutionId)];
      this.applyArchiveFilter(
        principal,
        filters,
        libraryMembers.archivedAt,
        query.includeArchived,
        'library.circulation.manage',
      );
      if (query.memberType) {
        filters.push(eq(libraryMembers.memberType, query.memberType as MemberRow['memberType']));
      }
      if (query.status) {
        filters.push(eq(libraryMembers.status, query.status as MemberRow['status']));
      }
      if (query.q) filters.push(ilike(libraryMembers.cardNumber, `${query.q}%`));

      const where = and(...filters);
      const orderBy = parseSort(query.sort, LIBRARY_MEMBER_SORT_FIELDS, {
        field: 'cardNumber',
        direction: 'asc',
      }).map((spec) => {
        const column = MEMBER_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select({
          member: libraryMembers,
          personName: sql<string>`coalesce(${students.fullNameEn}, ${employees.fullNameEn})`,
        })
        .from(libraryMembers)
        .leftJoin(students, eq(students.id, libraryMembers.studentId))
        .leftJoin(employees, eq(employees.id, libraryMembers.employeeId))
        .where(where)
        .orderBy(...orderBy, asc(libraryMembers.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(libraryMembers)
        .where(where);

      return buildOffsetPage(
        rows.map((row) => ({ ...row.member, personName: row.personName })),
        counted?.total ?? 0,
        page,
      );
    });
  }

  /** One member with their live loans and unresolved fines. */
  async getMember(institutionId: string, id: string) {
    return this.db.runInTenant(async (tx) => {
      const member = await this.loadMember(tx, institutionId, id);

      const loans = await tx
        .select({
          loan: libraryLoans,
          accessionNumber: libraryCopies.accessionNumber,
          title: libraryTitles.title,
        })
        .from(libraryLoans)
        .innerJoin(libraryCopies, eq(libraryCopies.id, libraryLoans.copyId))
        .innerJoin(libraryTitles, eq(libraryTitles.id, libraryCopies.titleId))
        .where(and(eq(libraryLoans.memberId, id), isNull(libraryLoans.returnedAt)))
        .orderBy(asc(libraryLoans.dueOn));

      const fines = await tx
        .select()
        .from(libraryFines)
        .where(
          and(
            eq(libraryFines.memberId, id),
            eq(libraryFines.status, 'pending'),
            isNull(libraryFines.archivedAt),
          ),
        )
        .orderBy(asc(libraryFines.assessedOn));

      const pendingFineTotal = Money.sum(fines.map((fine) => Money.fromDecimalString(fine.amount)));

      return {
        ...member,
        liveLoans: loans.map((row) => ({
          ...row.loan,
          accessionNumber: row.accessionNumber,
          title: row.title,
        })),
        pendingFines: fines,
        pendingFineTotal: pendingFineTotal.toDecimalString(),
      };
    });
  }

  /**
   * Create a borrowing account from a student or an employee.
   *
   * Limits default from the institution's circulation policy; the card number is the next
   * entry in the `LM-` register unless one is supplied. One live membership per person —
   * pre-checked here for a friendly message, guaranteed by the partial unique indexes.
   */
  async createMember(
    principal: Principal,
    institutionId: string,
    input: CreateLibraryMemberInput,
  ): Promise<MemberRow> {
    return this.db.runInTenant(async (tx) => {
      if (input.memberType === 'student') {
        const [student] = await tx
          .select({ id: students.id })
          .from(students)
          .where(
            and(
              eq(students.id, input.studentId!),
              eq(students.institutionId, institutionId),
              isNull(students.archivedAt),
            ),
          )
          .limit(1);
        if (!student) throw new NotFoundError('Student', input.studentId);

        const [existing] = await tx
          .select({ id: libraryMembers.id })
          .from(libraryMembers)
          .where(
            and(eq(libraryMembers.studentId, input.studentId!), isNull(libraryMembers.archivedAt)),
          )
          .limit(1);
        if (existing) {
          throw new ConflictError('This student already has a library membership.', {
            existingMemberId: existing.id,
          });
        }
      } else {
        const [employee] = await tx
          .select({ id: employees.id })
          .from(employees)
          .where(
            and(
              eq(employees.id, input.employeeId!),
              eq(employees.institutionId, institutionId),
              isNull(employees.archivedAt),
            ),
          )
          .limit(1);
        if (!employee) throw new NotFoundError('Employee', input.employeeId);

        const [existing] = await tx
          .select({ id: libraryMembers.id })
          .from(libraryMembers)
          .where(
            and(
              eq(libraryMembers.employeeId, input.employeeId!),
              isNull(libraryMembers.archivedAt),
            ),
          )
          .limit(1);
        if (existing) {
          throw new ConflictError('This employee already has a library membership.', {
            existingMemberId: existing.id,
          });
        }
      }

      const settings = await this.effectiveSettings(tx, institutionId);

      let cardNumber = input.cardNumber;
      if (!cardNumber) {
        const sequence = (await this.currentCardSequence(tx, institutionId)) + 1;
        cardNumber = `LM-${String(sequence).padStart(6, '0')}`;
      }

      const [created] = await tx
        .insert(libraryMembers)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          memberType: input.memberType,
          studentId: input.memberType === 'student' ? input.studentId! : null,
          employeeId: input.memberType === 'employee' ? input.employeeId! : null,
          cardNumber,
          maxBooks: input.maxBooks ?? settings.defaultMaxBooks,
          loanDays: input.loanDays ?? settings.defaultLoanDays,
          status: 'active',
          validUntil: input.validUntil ?? null,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      return created!;
    });
  }

  async updateMember(
    principal: Principal,
    institutionId: string,
    id: string,
    input: Record<string, unknown>,
  ): Promise<{ member: MemberRow; previous: Partial<MemberRow> }> {
    const version = input['version'] as number;
    const { version: _ignored, ...changes } = input;

    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadMember(tx, institutionId, id);

      const [updated] = await tx
        .update(libraryMembers)
        .set({
          ...(changes as Partial<MemberRow>),
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(libraryMembers.id, id), eq(libraryMembers.version, version)))
        .returning();

      if (!updated) {
        throw new ConflictError(
          'This member was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: version, currentVersion: existing.version },
        );
      }

      return { member: updated, previous: diffOf(existing, updated, Object.keys(changes)) };
    });
  }

  async archiveMember(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
  ): Promise<MemberRow> {
    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadMember(tx, institutionId, id);

      const [liveLoan] = await tx
        .select({ id: libraryLoans.id })
        .from(libraryLoans)
        .where(and(eq(libraryLoans.memberId, id), isNull(libraryLoans.returnedAt)))
        .limit(1);
      if (liveLoan) {
        throw new ConflictError(
          'This member still has books out. Take them back (or mark them lost) first.',
        );
      }

      // Their place in any queue is vacated so the queue does not wait on a closed account.
      const reservations = await tx
        .select()
        .from(libraryReservations)
        .where(
          and(
            eq(libraryReservations.memberId, id),
            eq(libraryReservations.status, 'active'),
            isNull(libraryReservations.archivedAt),
          ),
        );
      for (const reservation of reservations) {
        await tx
          .update(libraryReservations)
          .set({
            status: 'cancelled',
            updatedBy: principal.userId,
            version: reservation.version + 1,
          })
          .where(eq(libraryReservations.id, reservation.id));
        await this.advanceQueue(tx, reservation.titleId, reservation.queuePosition);
      }

      const [archived] = await tx
        .update(libraryMembers)
        .set({
          archivedAt: new Date(),
          archivedBy: principal.userId,
          archiveReason: reason,
          updatedBy: principal.userId,
          version: existing.version + 1,
        })
        .where(eq(libraryMembers.id, id))
        .returning();
      return archived!;
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Circulation: issue, return, renew, lost
  // ══════════════════════════════════════════════════════════════════════════════════

  async listLoans(
    principal: Principal,
    institutionId: string,
    query: ListLoansQuery,
    page: OffsetPageRequest,
  ) {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(libraryLoans.institutionId, institutionId)];
      this.applyArchiveFilter(
        principal,
        filters,
        libraryLoans.archivedAt,
        query.includeArchived,
        'library.circulation.manage',
      );
      if (query.memberId) filters.push(eq(libraryLoans.memberId, query.memberId));
      if (query.copyId) filters.push(eq(libraryLoans.copyId, query.copyId));
      if (query.titleId) filters.push(eq(libraryCopies.titleId, query.titleId));
      if (query.status) filters.push(eq(libraryLoans.status, query.status as LoanRow['status']));
      if (query.overdueOnly) {
        filters.push(isNull(libraryLoans.returnedAt));
        filters.push(lt(libraryLoans.dueOn, todayInDhaka() as string));
      }

      const where = and(...filters);
      const orderBy = parseSort(query.sort, LIBRARY_LOAN_SORT_FIELDS, {
        field: 'issuedAt',
        direction: 'desc',
      }).map((spec) => {
        const column = LOAN_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select({
          loan: libraryLoans,
          accessionNumber: libraryCopies.accessionNumber,
          title: libraryTitles.title,
          cardNumber: libraryMembers.cardNumber,
        })
        .from(libraryLoans)
        .innerJoin(libraryCopies, eq(libraryCopies.id, libraryLoans.copyId))
        .innerJoin(libraryTitles, eq(libraryTitles.id, libraryCopies.titleId))
        .innerJoin(libraryMembers, eq(libraryMembers.id, libraryLoans.memberId))
        .where(where)
        .orderBy(...orderBy, asc(libraryLoans.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(libraryLoans)
        .innerJoin(libraryCopies, eq(libraryCopies.id, libraryLoans.copyId))
        .where(where);

      return buildOffsetPage(
        rows.map((row) => ({
          ...row.loan,
          accessionNumber: row.accessionNumber,
          title: row.title,
          cardNumber: row.cardNumber,
        })),
        counted?.total ?? 0,
        page,
      );
    });
  }

  /**
   * Issue a copy to a member.
   *
   * The copy row is locked (`for update`) so concurrent issues of the same book serialize on
   * the status check; the partial unique index on live loans is the guarantee behind it. A
   * copy on reservation hold may only be issued to the head of the queue, and fulfilling
   * that reservation advances the rest of the queue in this same transaction.
   */
  async issueLoan(principal: Principal, institutionId: string, input: IssueLibraryLoanInput) {
    const today = todayInDhaka();

    return this.db.runInTenant(async (tx) => {
      const copyFilters: SQL[] = [
        eq(libraryCopies.institutionId, institutionId),
        isNull(libraryCopies.archivedAt),
      ];
      if (input.copyId) copyFilters.push(eq(libraryCopies.id, input.copyId));
      if (input.accessionNumber) {
        copyFilters.push(eq(libraryCopies.accessionNumber, input.accessionNumber));
      }

      const [copy] = await tx
        .select()
        .from(libraryCopies)
        .where(and(...copyFilters))
        .limit(1)
        .for('update');
      if (!copy) throw new NotFoundError('Library copy', input.copyId ?? input.accessionNumber);

      if (copy.status === 'issued') {
        throw new ConflictError('This copy is already on loan.');
      }
      if (copy.status === 'lost' || copy.status === 'withdrawn') {
        throw new ConflictError(`This copy is recorded as ${copy.status} and cannot be issued.`);
      }

      const member = await this.loadMember(tx, institutionId, input.memberId);
      if (member.status !== 'active') {
        throw new ConflictError(
          `This membership is ${member.status}; a ${member.status} member cannot borrow.`,
          { memberStatus: member.status },
        );
      }
      if (member.validUntil && compareCalendarDates(calendarDate(member.validUntil), today) < 0) {
        throw new ConflictError('This membership has passed its validity date.', {
          validUntil: member.validUntil,
        });
      }

      // The reservation queue: a held copy goes to the head of the queue and nobody else.
      if (copy.status === 'reserved') {
        const head = await this.expireStaleHolds(tx, principal, copy.titleId);
        if (head && head.memberId !== member.id) {
          throw new ConflictError(
            'This copy is being held for the next member in the reservation queue.',
          );
        }
        if (head) {
          await tx
            .update(libraryReservations)
            .set({
              status: 'fulfilled',
              updatedBy: principal.userId,
              version: head.version + 1,
            })
            .where(eq(libraryReservations.id, head.id));
          await this.advanceQueue(tx, copy.titleId, head.queuePosition);
        }
      }

      // The borrowing limit: concurrent live loans, counted as a fact, not tracked.
      const [liveCount] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(libraryLoans)
        .where(and(eq(libraryLoans.memberId, member.id), isNull(libraryLoans.returnedAt)));
      if ((liveCount?.total ?? 0) >= member.maxBooks) {
        throw new ConflictError(
          `This member already has ${liveCount!.total} of ${member.maxBooks} allowed books out.`,
          { maxBooks: member.maxBooks },
        );
      }

      const dueOn = input.dueOn ?? (addDays(today, member.loanDays) as string);
      if (compareCalendarDates(calendarDate(dueOn), today) < 0) {
        throw new ValidationError('The due date cannot be in the past', [
          { path: 'dueOn', message: 'Choose today or a later date' },
        ]);
      }

      // The insert the partial unique index guards. A concurrent double-issue that slipped
      // past the row lock is refused here by Postgres and surfaces as a 409.
      const [loan] = await tx
        .insert(libraryLoans)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          copyId: copy.id,
          memberId: member.id,
          issuedBy: principal.userId,
          issuedAt: new Date(),
          dueOn,
          status: 'issued',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();

      await tx
        .update(libraryCopies)
        .set({ status: 'issued', updatedBy: principal.userId, version: copy.version + 1 })
        .where(eq(libraryCopies.id, copy.id));

      return { ...loan!, accessionNumber: copy.accessionNumber };
    });
  }

  /**
   * Take a copy back. If the title has an active reservation queue, the copy goes on hold
   * for the queue head — with an expiry from the institution's policy — instead of back to
   * the open shelf.
   */
  async returnLoan(
    principal: Principal,
    institutionId: string,
    loanId: string,
    input: ReturnLibraryLoanInput,
  ) {
    return this.db.runInTenant(async (tx) => {
      const loan = await this.loadLiveLoan(tx, institutionId, loanId);

      const [copy] = await tx
        .select()
        .from(libraryCopies)
        .where(eq(libraryCopies.id, loan.copyId))
        .limit(1)
        .for('update');
      if (!copy) throw new NotFoundError('Library copy', loan.copyId);

      const now = new Date();
      const [returned] = await tx
        .update(libraryLoans)
        .set({
          returnedAt: now,
          returnedTo: principal.userId,
          status: 'returned',
          updatedBy: principal.userId,
          version: loan.version + 1,
        })
        .where(eq(libraryLoans.id, loanId))
        .returning();

      const head = await this.expireStaleHolds(tx, principal, copy.titleId);
      let nextStatus: CopyRow['status'] = 'available';
      if (head) {
        nextStatus = 'reserved';
        if (!head.expiresAt) {
          const settings = await this.effectiveSettings(tx, institutionId);
          await tx
            .update(libraryReservations)
            .set({
              expiresAt: new Date(now.getTime() + settings.reservationHoldDays * 86_400_000),
              updatedBy: principal.userId,
              version: head.version + 1,
            })
            .where(eq(libraryReservations.id, head.id));
        }
      }

      await tx
        .update(libraryCopies)
        .set({
          status: nextStatus,
          condition: input.condition ?? copy.condition,
          updatedBy: principal.userId,
          version: copy.version + 1,
        })
        .where(eq(libraryCopies.id, copy.id));

      return { ...returned!, copyStatus: nextStatus, heldForMemberId: head?.memberId ?? null };
    });
  }

  /**
   * Renew a loan. Refused when the title has an active reservation queue — the next borrower
   * is already waiting — and when the institution's renewal cap is exhausted.
   */
  async renewLoan(
    principal: Principal,
    institutionId: string,
    loanId: string,
    input: RenewLibraryLoanInput,
  ) {
    const today = todayInDhaka();

    return this.db.runInTenant(async (tx) => {
      const loan = await this.loadLiveLoan(tx, institutionId, loanId);
      if (loan.status === 'lost') {
        throw new ConflictError('A loan marked lost cannot be renewed.');
      }

      const [copy] = await tx
        .select({ titleId: libraryCopies.titleId })
        .from(libraryCopies)
        .where(eq(libraryCopies.id, loan.copyId))
        .limit(1);
      if (!copy) throw new NotFoundError('Library copy', loan.copyId);

      const [reservation] = await tx
        .select({ id: libraryReservations.id })
        .from(libraryReservations)
        .where(
          and(
            eq(libraryReservations.titleId, copy.titleId),
            eq(libraryReservations.status, 'active'),
            isNull(libraryReservations.archivedAt),
          ),
        )
        .limit(1);
      if (reservation) {
        throw new ConflictError(
          'This title has an active reservation queue, so the loan cannot be renewed.',
        );
      }

      const member = await this.loadMember(tx, institutionId, loan.memberId);
      if (member.status !== 'active') {
        throw new ConflictError(`This membership is ${member.status}; it cannot renew.`);
      }

      const settings = await this.effectiveSettings(tx, institutionId);
      if (loan.renewalCount >= settings.maxRenewals) {
        throw new ConflictError(
          `This loan has already been renewed ${loan.renewalCount} time(s); the limit is ${settings.maxRenewals}.`,
        );
      }

      // Extend from the due date, or from today when the book is already overdue — a renewal
      // must never produce a due date in the past.
      const base =
        compareCalendarDates(calendarDate(loan.dueOn), today) > 0
          ? calendarDate(loan.dueOn)
          : today;
      const dueOn = addDays(base, input.days ?? member.loanDays) as string;

      const [renewed] = await tx
        .update(libraryLoans)
        .set({
          dueOn,
          renewalCount: loan.renewalCount + 1,
          status: 'issued',
          updatedBy: principal.userId,
          version: loan.version + 1,
        })
        .where(eq(libraryLoans.id, loanId))
        .returning();

      return renewed!;
    });
  }

  /**
   * Mark a loaned copy lost.
   *
   * The copy moves to `lost` and the replacement cost is assessed as a fine — a financial
   * fact with a named assessor and a reason, written with its audit record inside this
   * transaction. The loan row is never deleted; a later "found" return still works.
   */
  async markLoanLost(
    principal: Principal,
    institutionId: string,
    loanId: string,
    input: MarkLibraryLoanLostInput,
  ) {
    const context = currentContext();
    const today = todayInDhaka() as string;

    return this.db.runInTenant(async (tx) => {
      const loan = await this.loadLiveLoan(tx, institutionId, loanId);
      if (loan.status === 'lost') {
        throw new ConflictError('This loan is already marked lost.');
      }

      const [copy] = await tx
        .select()
        .from(libraryCopies)
        .where(eq(libraryCopies.id, loan.copyId))
        .limit(1)
        .for('update');
      if (!copy) throw new NotFoundError('Library copy', loan.copyId);

      const replacementSource = input.replacementAmount ?? copy.cost;
      if (!replacementSource) {
        throw new ValidationError('A replacement amount is required', [
          {
            path: 'replacementAmount',
            message:
              'This copy has no recorded cost, so the replacement amount must be given explicitly',
          },
        ]);
      }
      const replacement = Money.fromDecimalString(replacementSource);
      if (!replacement.isPositive()) {
        throw new ValidationError('The replacement amount must be positive', [
          { path: 'replacementAmount', message: 'Enter an amount greater than zero' },
        ]);
      }

      const [updatedLoan] = await tx
        .update(libraryLoans)
        .set({ status: 'lost', updatedBy: principal.userId, version: loan.version + 1 })
        .where(eq(libraryLoans.id, loanId))
        .returning();

      await tx
        .update(libraryCopies)
        .set({
          status: 'lost',
          condition: 'lost',
          updatedBy: principal.userId,
          version: copy.version + 1,
        })
        .where(eq(libraryCopies.id, copy.id));

      const fineId = uuidv7();
      await tx.insert(libraryFines).values({
        id: fineId,
        tenantId: principal.tenantId!,
        institutionId,
        loanId,
        memberId: loan.memberId,
        amount: replacement.toDecimalString(),
        reason: `Replacement cost for lost copy ${copy.accessionNumber}: ${input.reason}`.slice(
          0,
          1000,
        ),
        assessedOn: today,
        isReplacement: true,
        status: 'pending',
        createdBy: principal.userId,
        updatedBy: principal.userId,
      });

      await this.recomputeLoanFineTotal(tx, loanId, principal.userId);

      await this.audit.recordInTransaction(tx, {
        tenantId: principal.tenantId,
        institutionId,
        actorUserId: principal.userId,
        actorRoles: principal.roles.map((role) => role.roleKey),
        action: 'update',
        module: 'library',
        resourceType: 'library_loan',
        resourceId: loanId,
        resourceLabel: copy.accessionNumber,
        previousValue: { status: loan.status, copyStatus: copy.status },
        newValue: {
          status: 'lost',
          copyStatus: 'lost',
          replacementFineId: fineId,
          // Money as a string, never a number, in the audit trail too.
          replacementAmount: replacement.toDecimalString(),
        },
        reason: input.reason,
        requestId: context?.requestId ?? null,
        ipAddress: context?.ipAddress ?? null,
        userAgent: context?.userAgent ?? null,
      });

      return {
        ...updatedLoan!,
        replacementFineId: fineId,
        replacementAmount: replacement.toDecimalString(),
      };
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Reservations
  // ══════════════════════════════════════════════════════════════════════════════════

  async listReservations(
    principal: Principal,
    institutionId: string,
    query: ListReservationsQuery,
    page: OffsetPageRequest,
  ) {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(libraryReservations.institutionId, institutionId)];
      this.applyArchiveFilter(
        principal,
        filters,
        libraryReservations.archivedAt,
        query.includeArchived,
        'library.circulation.manage',
      );
      if (query.titleId) filters.push(eq(libraryReservations.titleId, query.titleId));
      if (query.memberId) filters.push(eq(libraryReservations.memberId, query.memberId));
      if (query.status) {
        filters.push(eq(libraryReservations.status, query.status as ReservationRow['status']));
      }

      const where = and(...filters);

      const rows = await tx
        .select({
          reservation: libraryReservations,
          title: libraryTitles.title,
          cardNumber: libraryMembers.cardNumber,
        })
        .from(libraryReservations)
        .innerJoin(libraryTitles, eq(libraryTitles.id, libraryReservations.titleId))
        .innerJoin(libraryMembers, eq(libraryMembers.id, libraryReservations.memberId))
        .where(where)
        .orderBy(asc(libraryReservations.queuePosition), asc(libraryReservations.reservedAt))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(libraryReservations)
        .where(where);

      return buildOffsetPage(
        rows.map((row) => ({
          ...row.reservation,
          title: row.title,
          cardNumber: row.cardNumber,
        })),
        counted?.total ?? 0,
        page,
      );
    });
  }

  /**
   * Join the queue for a title. The queue position is assigned under a row lock on the title
   * so two simultaneous reservations cannot claim the same place.
   */
  async createReservation(
    principal: Principal,
    institutionId: string,
    input: CreateLibraryReservationInput,
  ): Promise<ReservationRow> {
    return this.db.runInTenant(async (tx) => {
      const [title] = await tx
        .select()
        .from(libraryTitles)
        .where(
          and(
            eq(libraryTitles.id, input.titleId),
            eq(libraryTitles.institutionId, institutionId),
            isNull(libraryTitles.archivedAt),
          ),
        )
        .limit(1)
        .for('update');
      if (!title) throw new NotFoundError('Library title', input.titleId);
      if (title.status !== 'active') {
        throw new ConflictError('This title is inactive and cannot be reserved.');
      }

      const member = await this.loadMember(tx, institutionId, input.memberId);
      if (member.status !== 'active') {
        throw new ConflictError(`This membership is ${member.status}; it cannot reserve.`);
      }

      const [existing] = await tx
        .select({ id: libraryReservations.id })
        .from(libraryReservations)
        .where(
          and(
            eq(libraryReservations.titleId, input.titleId),
            eq(libraryReservations.memberId, input.memberId),
            eq(libraryReservations.status, 'active'),
            isNull(libraryReservations.archivedAt),
          ),
        )
        .limit(1);
      if (existing) {
        throw new ConflictError('This member already holds a place in the queue for this title.', {
          existingReservationId: existing.id,
        });
      }

      const [tail] = await tx
        .select({
          maxPosition: sql<number | null>`max(${libraryReservations.queuePosition})`,
        })
        .from(libraryReservations)
        .where(
          and(
            eq(libraryReservations.titleId, input.titleId),
            eq(libraryReservations.status, 'active'),
            isNull(libraryReservations.archivedAt),
          ),
        );

      const [created] = await tx
        .insert(libraryReservations)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          titleId: input.titleId,
          memberId: input.memberId,
          reservedAt: new Date(),
          status: 'active',
          queuePosition: (tail?.maxPosition ?? 0) + 1,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      return created!;
    });
  }

  /** Cancel a reservation and close the gap in the queue, in one transaction. */
  async cancelReservation(principal: Principal, institutionId: string, id: string) {
    return this.db.runInTenant(async (tx) => {
      const [reservation] = await tx
        .select()
        .from(libraryReservations)
        .where(
          and(
            eq(libraryReservations.id, id),
            eq(libraryReservations.institutionId, institutionId),
            isNull(libraryReservations.archivedAt),
          ),
        )
        .limit(1);
      if (!reservation) throw new NotFoundError('Library reservation', id);
      if (reservation.status !== 'active') {
        throw new ConflictError(`This reservation is already ${reservation.status}.`);
      }

      const [cancelled] = await tx
        .update(libraryReservations)
        .set({
          status: 'cancelled',
          updatedBy: principal.userId,
          version: reservation.version + 1,
        })
        .where(eq(libraryReservations.id, id))
        .returning();

      await this.advanceQueue(tx, reservation.titleId, reservation.queuePosition);

      // If the cancelled head had a copy on hold and nobody is left waiting, release it.
      const [nextHead] = await tx
        .select({ id: libraryReservations.id })
        .from(libraryReservations)
        .where(
          and(
            eq(libraryReservations.titleId, reservation.titleId),
            eq(libraryReservations.status, 'active'),
            isNull(libraryReservations.archivedAt),
          ),
        )
        .limit(1);
      if (!nextHead) {
        await tx
          .update(libraryCopies)
          .set({ status: 'available', updatedBy: principal.userId })
          .where(
            and(
              eq(libraryCopies.titleId, reservation.titleId),
              eq(libraryCopies.status, 'reserved'),
            ),
          );
      }

      return cancelled!;
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Fines
  // ══════════════════════════════════════════════════════════════════════════════════

  async listFines(
    principal: Principal,
    institutionId: string,
    query: ListFinesQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<FineRow>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(libraryFines.institutionId, institutionId)];
      this.applyArchiveFilter(
        principal,
        filters,
        libraryFines.archivedAt,
        query.includeArchived,
        'library.fines.manage',
      );
      if (query.memberId) filters.push(eq(libraryFines.memberId, query.memberId));
      if (query.loanId) filters.push(eq(libraryFines.loanId, query.loanId));
      if (query.status) filters.push(eq(libraryFines.status, query.status as FineRow['status']));

      const where = and(...filters);
      const orderBy = parseSort(query.sort, LIBRARY_FINE_SORT_FIELDS, {
        field: 'assessedOn',
        direction: 'desc',
      }).map((spec) => {
        const column = FINE_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(libraryFines)
        .where(where)
        .orderBy(...orderBy, asc(libraryFines.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(libraryFines)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  /**
   * The explicit fine assessment run.
   *
   * For each overdue loan, the fine that has *accrued* is the per-day rate times the whole
   * days past due (frozen at the return date for returned books); what is *assessed* is the
   * difference between that and what is already on record for the loan. Re-running for the
   * same date therefore assesses nothing, and the partial unique index on
   * `(loan_id, assessed_on)` refuses a same-day duplicate even if two runs race.
   *
   * Deliberately an endpoint rather than something computed on read: a fine shown to a
   * guardian must be a fact somebody with `library.fines.manage` is accountable for. This
   * mirrors the fees module's late-fine rule exactly.
   */
  async assessFines(
    principal: Principal,
    institutionId: string,
    input: AssessLibraryFinesInput,
  ): Promise<{
    asOfDate: string;
    assessed: Array<{ fineId: string; loanId: string; memberId: string; amount: string }>;
    skipped: Array<{ loanId: string; reason: string }>;
    totalAssessed: string;
  }> {
    const context = currentContext();
    const asOf = input.asOfDate ?? (todayInDhaka() as string);

    return this.db.runInTenant(async (tx) => {
      const settings = await this.effectiveSettings(tx, institutionId);
      const rate = Money.fromDecimalString(settings.finePerDay);

      const filters: SQL[] = [
        eq(libraryLoans.institutionId, institutionId),
        isNull(libraryLoans.archivedAt),
        // Lost loans carry a replacement fine instead; the per-day meter stops.
        ne(libraryLoans.status, 'lost'),
        lt(libraryLoans.dueOn, asOf),
      ];
      if (input.memberId) filters.push(eq(libraryLoans.memberId, input.memberId));
      if (input.loanIds && input.loanIds.length > 0) {
        filters.push(inArray(libraryLoans.id, input.loanIds));
      }

      const candidates = await tx
        .select()
        .from(libraryLoans)
        .where(and(...filters))
        .orderBy(asc(libraryLoans.dueOn), asc(libraryLoans.id));

      const assessed: Array<{
        fineId: string;
        loanId: string;
        memberId: string;
        amount: string;
      }> = [];
      const skipped: Array<{ loanId: string; reason: string }> = [];
      let totalAssessed = Money.zero();

      if (!rate.isPositive()) {
        // A zero rate is a policy, not an error: the run reports that it charged nobody.
        return {
          asOfDate: asOf,
          assessed,
          skipped: candidates.map((loan) => ({
            loanId: loan.id,
            reason: 'The institution fine rate is zero',
          })),
          totalAssessed: totalAssessed.toDecimalString(),
        };
      }

      for (const loan of candidates) {
        // The overdue meter runs to the return date for a returned book, and never past the
        // assessment date.
        let until = calendarDate(asOf);
        if (loan.returnedAt) {
          const returnedOn = instantToDhakaDate(loan.returnedAt);
          if (compareCalendarDates(returnedOn, until) < 0) until = returnedOn;
        }

        const overdueDays = daysBetween(calendarDate(loan.dueOn), until);
        if (overdueDays <= 0) {
          skipped.push({ loanId: loan.id, reason: 'Not overdue for the assessed period' });
          continue;
        }

        const accrued = rate.times(overdueDays);

        // What is already on record: every live overdue fine on this loan, whatever its
        // status. A waived fine stays counted — waiving forgives it, it does not re-accrue.
        const [already] = await tx
          .select({
            total: sql<string>`coalesce(sum(${libraryFines.amount}), 0)::numeric(14,2)`,
          })
          .from(libraryFines)
          .where(
            and(
              eq(libraryFines.loanId, loan.id),
              eq(libraryFines.isReplacement, false),
              isNull(libraryFines.archivedAt),
            ),
          );

        const delta = accrued.minus(Money.fromDecimalString(already?.total ?? '0.00'));
        if (!delta.isPositive()) {
          skipped.push({ loanId: loan.id, reason: 'Already assessed up to this date' });
          continue;
        }

        const fineId = uuidv7();
        await tx.insert(libraryFines).values({
          id: fineId,
          tenantId: principal.tenantId!,
          institutionId,
          loanId: loan.id,
          memberId: loan.memberId,
          amount: delta.toDecimalString(),
          reason: input.reason,
          assessedOn: asOf,
          isReplacement: false,
          status: 'pending',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        });

        await this.recomputeLoanFineTotal(tx, loan.id, principal.userId, {
          markOverdue: loan.returnedAt === null,
        });

        totalAssessed = totalAssessed.plus(delta);
        assessed.push({
          fineId,
          loanId: loan.id,
          memberId: loan.memberId,
          amount: delta.toDecimalString(),
        });
      }

      await this.audit.recordInTransaction(tx, {
        tenantId: principal.tenantId,
        institutionId,
        actorUserId: principal.userId,
        actorRoles: principal.roles.map((role) => role.roleKey),
        action: 'update',
        module: 'library',
        resourceType: 'library_fine_run',
        resourceId: institutionId,
        resourceLabel: `Library fines as of ${asOf}`,
        newValue: {
          asOfDate: asOf,
          finePerDay: rate.toDecimalString(),
          assessedCount: assessed.length,
          totalAssessed: totalAssessed.toDecimalString(),
          fineIds: assessed.map((one) => one.fineId),
        },
        reason: input.reason,
        requestId: context?.requestId ?? null,
        ipAddress: context?.ipAddress ?? null,
        userAgent: context?.userAgent ?? null,
      });

      return { asOfDate: asOf, assessed, skipped, totalAssessed: totalAssessed.toDecimalString() };
    });
  }

  /** Record a fine as paid. The row keeps its history; the audit record rolls back with it. */
  async payFine(
    principal: Principal,
    institutionId: string,
    id: string,
    input: PayLibraryFineInput,
  ): Promise<FineRow> {
    const context = currentContext();

    return this.db.runInTenant(async (tx) => {
      const fine = await this.loadFine(tx, institutionId, id);
      if (fine.status !== 'pending') {
        throw new ConflictError(`This fine has already been ${fine.status}.`, {
          currentStatus: fine.status,
        });
      }

      const [paid] = await tx
        .update(libraryFines)
        .set({
          status: 'paid',
          paidAt: new Date(),
          paymentMethod: input.method,
          paymentReference: input.reference ?? null,
          updatedBy: principal.userId,
          version: fine.version + 1,
        })
        .where(eq(libraryFines.id, id))
        .returning();

      await this.audit.recordInTransaction(tx, {
        tenantId: principal.tenantId,
        institutionId,
        actorUserId: principal.userId,
        actorRoles: principal.roles.map((role) => role.roleKey),
        action: 'payment',
        module: 'library',
        resourceType: 'library_fine',
        resourceId: id,
        previousValue: { status: 'pending' },
        newValue: {
          status: 'paid',
          amount: fine.amount,
          method: input.method,
          reference: input.reference ?? null,
          loanId: fine.loanId,
          memberId: fine.memberId,
        },
        requestId: context?.requestId ?? null,
        ipAddress: context?.ipAddress ?? null,
        userAgent: context?.userAgent ?? null,
      });

      return paid!;
    });
  }

  /**
   * Waive a fine.
   *
   * A distinct permission guards the route, the reason is mandatory, the row records who and
   * why, and the person who assessed the fine cannot be the one who forgives it — the same
   * separation of duties the fees module applies to concessions.
   */
  async waiveFine(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
  ): Promise<FineRow> {
    const context = currentContext();

    return this.db.runInTenant(async (tx) => {
      const fine = await this.loadFine(tx, institutionId, id);
      if (fine.status !== 'pending') {
        throw new ConflictError(`This fine has already been ${fine.status}.`, {
          currentStatus: fine.status,
        });
      }
      if (fine.createdBy && fine.createdBy === principal.userId) {
        throw new ConflictError(
          'A fine must be waived by someone other than the person who assessed it.',
        );
      }

      const [waived] = await tx
        .update(libraryFines)
        .set({
          status: 'waived',
          waivedBy: principal.userId,
          waivedAt: new Date(),
          waivedReason: reason,
          updatedBy: principal.userId,
          version: fine.version + 1,
        })
        .where(eq(libraryFines.id, id))
        .returning();

      await this.recomputeLoanFineTotal(tx, fine.loanId, principal.userId);
      await tx
        .update(libraryLoans)
        .set({ fineWaivedBy: principal.userId })
        .where(eq(libraryLoans.id, fine.loanId));

      await this.audit.recordInTransaction(tx, {
        tenantId: principal.tenantId,
        institutionId,
        actorUserId: principal.userId,
        actorRoles: principal.roles.map((role) => role.roleKey),
        action: 'update',
        module: 'library',
        resourceType: 'library_fine',
        resourceId: id,
        previousValue: { status: 'pending', amount: fine.amount },
        newValue: {
          status: 'waived',
          amount: fine.amount,
          loanId: fine.loanId,
          memberId: fine.memberId,
        },
        reason,
        requestId: context?.requestId ?? null,
        ipAddress: context?.ipAddress ?? null,
        userAgent: context?.userAgent ?? null,
      });

      return waived!;
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Self-service
  // ══════════════════════════════════════════════════════════════════════════════════

  /**
   * The caller's own loans and fines — a student's, an employee's, or a guardian's children.
   *
   * The member set is derived from the principal's identity; there is no parameter through
   * which anybody can name somebody else, and a caller with none of the three identities
   * receives an empty result rather than an error. Failing closed is the only safe reading.
   */
  async myLoans(principal: Principal, institutionId: string) {
    return this.db.runInTenant(async (tx) => {
      const memberConditions: SQL[] = [];
      if (principal.studentId) {
        memberConditions.push(eq(libraryMembers.studentId, principal.studentId));
      }
      if (principal.employeeId) {
        memberConditions.push(eq(libraryMembers.employeeId, principal.employeeId));
      }
      if (principal.guardianId) {
        const guardianId = principal.guardianId;
        memberConditions.push(
          inArray(
            libraryMembers.studentId,
            this.db.raw
              .select({ studentId: studentGuardians.studentId })
              .from(studentGuardians)
              .where(
                and(
                  eq(studentGuardians.guardianId, guardianId),
                  // Revoking portal access takes effect on the next request.
                  eq(studentGuardians.canAccessPortal, true),
                  isNull(studentGuardians.archivedAt),
                ),
              ),
          ),
        );
      }

      if (memberConditions.length === 0) {
        return { members: [], loans: [], fines: [] };
      }

      const memberFilter =
        memberConditions.length === 1 ? memberConditions[0]! : or(...memberConditions)!;

      const members = await tx
        .select()
        .from(libraryMembers)
        .where(
          and(
            eq(libraryMembers.institutionId, institutionId),
            isNull(libraryMembers.archivedAt),
            memberFilter,
          ),
        );

      if (members.length === 0) {
        return { members: [], loans: [], fines: [] };
      }
      const memberIds = members.map((member) => member.id);

      const loans = await tx
        .select({
          loan: libraryLoans,
          accessionNumber: libraryCopies.accessionNumber,
          title: libraryTitles.title,
          titleBn: libraryTitles.titleBn,
          author: libraryTitles.author,
        })
        .from(libraryLoans)
        .innerJoin(libraryCopies, eq(libraryCopies.id, libraryLoans.copyId))
        .innerJoin(libraryTitles, eq(libraryTitles.id, libraryCopies.titleId))
        .where(and(inArray(libraryLoans.memberId, memberIds), isNull(libraryLoans.archivedAt)))
        .orderBy(desc(libraryLoans.issuedAt));

      const fines = await tx
        .select()
        .from(libraryFines)
        .where(and(inArray(libraryFines.memberId, memberIds), isNull(libraryFines.archivedAt)))
        .orderBy(desc(libraryFines.assessedOn));

      return {
        members,
        loans: loans.map((row) => ({
          ...row.loan,
          accessionNumber: row.accessionNumber,
          title: row.title,
          titleBn: row.titleBn,
          author: row.author,
        })),
        fines,
      };
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Reports and stock-take — aggregated in SQL
  // ══════════════════════════════════════════════════════════════════════════════════

  /** Every book still out past its due date, with whole days overdue computed in SQL. */
  async overdueReport(institutionId: string, asOfDate?: string) {
    const asOf = asOfDate ?? (todayInDhaka() as string);

    return this.db.runInTenant(async (tx) => {
      const rows = await tx
        .select({
          loanId: libraryLoans.id,
          issuedAt: libraryLoans.issuedAt,
          dueOn: libraryLoans.dueOn,
          renewalCount: libraryLoans.renewalCount,
          fineAmount: libraryLoans.fineAmount,
          daysOverdue: sql<number>`(${asOf}::date - ${libraryLoans.dueOn})::int`,
          memberId: libraryMembers.id,
          cardNumber: libraryMembers.cardNumber,
          memberType: libraryMembers.memberType,
          borrowerName: sql<string>`coalesce(${students.fullNameEn}, ${employees.fullNameEn})`,
          accessionNumber: libraryCopies.accessionNumber,
          title: libraryTitles.title,
          author: libraryTitles.author,
        })
        .from(libraryLoans)
        .innerJoin(libraryMembers, eq(libraryMembers.id, libraryLoans.memberId))
        .leftJoin(students, eq(students.id, libraryMembers.studentId))
        .leftJoin(employees, eq(employees.id, libraryMembers.employeeId))
        .innerJoin(libraryCopies, eq(libraryCopies.id, libraryLoans.copyId))
        .innerJoin(libraryTitles, eq(libraryTitles.id, libraryCopies.titleId))
        .where(
          and(
            eq(libraryLoans.institutionId, institutionId),
            isNull(libraryLoans.returnedAt),
            isNull(libraryLoans.archivedAt),
            ne(libraryLoans.status, 'lost'),
            lt(libraryLoans.dueOn, asOf),
          ),
        )
        .orderBy(asc(libraryLoans.dueOn), asc(libraryTitles.title));

      const totalFinesOnRecord = Money.sum(
        rows.map((row) => Money.fromDecimalString(row.fineAmount)),
      );

      return {
        asOfDate: asOf,
        loanCount: rows.length,
        totalFinesOnRecord: totalFinesOnRecord.toDecimalString(),
        rows,
      };
    });
  }

  /** Which titles circulate most, counted by Postgres over the requested period. */
  async mostBorrowedReport(
    institutionId: string,
    query: { from?: string; to?: string; categoryId?: string; limit: number },
  ) {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [
        eq(libraryLoans.institutionId, institutionId),
        isNull(libraryLoans.archivedAt),
      ];
      if (query.from) {
        filters.push(sql`${libraryLoans.issuedAt} >= ${startOfDhakaDay(calendarDate(query.from))}`);
      }
      if (query.to) {
        filters.push(sql`${libraryLoans.issuedAt} < ${endOfDhakaDay(calendarDate(query.to))}`);
      }
      if (query.categoryId) filters.push(eq(libraryTitles.categoryId, query.categoryId));

      const rows = await tx
        .select({
          titleId: libraryTitles.id,
          title: libraryTitles.title,
          titleBn: libraryTitles.titleBn,
          author: libraryTitles.author,
          categoryId: libraryTitles.categoryId,
          borrowCount: sql<number>`count(*)::int`,
          distinctBorrowers: sql<number>`count(distinct ${libraryLoans.memberId})::int`,
        })
        .from(libraryLoans)
        .innerJoin(libraryCopies, eq(libraryCopies.id, libraryLoans.copyId))
        .innerJoin(libraryTitles, eq(libraryTitles.id, libraryCopies.titleId))
        .where(and(...filters))
        .groupBy(
          libraryTitles.id,
          libraryTitles.title,
          libraryTitles.titleBn,
          libraryTitles.author,
          libraryTitles.categoryId,
        )
        .orderBy(desc(sql`count(*)`), asc(libraryTitles.title))
        .limit(query.limit);

      return { from: query.from ?? null, to: query.to ?? null, rows };
    });
  }

  /**
   * Reconcile a physical stock-take against the register.
   *
   * The scanned accession numbers are compared in SQL with what the register says should be
   * on the shelf: copies recorded as on-shelf but not scanned are reported missing; copies
   * scanned but recorded as issued, lost or withdrawn are reported for investigation;
   * scanned numbers unknown to the register are listed separately. Nothing is mutated —
   * every correction (return, mark lost, withdraw) is its own accountable action.
   */
  async stockTake(institutionId: string, input: LibraryStockTakeInput) {
    const scanned = [...new Set(input.accessionNumbers.map((number) => number.trim()))];

    return this.db.runInTenant(async (tx) => {
      const matched = await tx
        .select({
          copyId: libraryCopies.id,
          accessionNumber: libraryCopies.accessionNumber,
          status: libraryCopies.status,
          title: libraryTitles.title,
        })
        .from(libraryCopies)
        .innerJoin(libraryTitles, eq(libraryTitles.id, libraryCopies.titleId))
        .where(
          and(
            eq(libraryCopies.institutionId, institutionId),
            isNull(libraryCopies.archivedAt),
            inArray(libraryCopies.accessionNumber, scanned),
          ),
        );

      const missing = await tx
        .select({
          copyId: libraryCopies.id,
          accessionNumber: libraryCopies.accessionNumber,
          status: libraryCopies.status,
          shelfLocation: libraryCopies.shelfLocation,
          title: libraryTitles.title,
        })
        .from(libraryCopies)
        .innerJoin(libraryTitles, eq(libraryTitles.id, libraryCopies.titleId))
        .where(
          and(
            eq(libraryCopies.institutionId, institutionId),
            isNull(libraryCopies.archivedAt),
            inArray(libraryCopies.status, ['available', 'reserved']),
            notInArray(libraryCopies.accessionNumber, scanned),
          ),
        )
        .orderBy(asc(libraryCopies.accessionNumber));

      const matchedNumbers = new Set(matched.map((row) => row.accessionNumber));
      const unknownAccessionNumbers = scanned.filter((number) => !matchedNumbers.has(number));

      const unexpected = matched.filter(
        (row) => row.status === 'issued' || row.status === 'lost' || row.status === 'withdrawn',
      );
      const confirmed = matched.filter(
        (row) => row.status === 'available' || row.status === 'reserved',
      );

      return {
        scannedCount: scanned.length,
        confirmedOnShelf: confirmed.length,
        missing,
        /** Scanned on the shelf, but the register says issued, lost or withdrawn. */
        unexpected,
        unknownAccessionNumbers,
      };
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Internals
  // ══════════════════════════════════════════════════════════════════════════════════

  /** The circulation policy in force: the saved row, or the documented defaults. */
  private async effectiveSettings(
    tx: Tx,
    institutionId: string,
  ): Promise<
    {
      finePerDay: string;
      maxRenewals: number;
      reservationHoldDays: number;
      defaultLoanDays: number;
      defaultMaxBooks: number;
      isDefault: boolean;
    } & Partial<Pick<SettingsRow, 'id' | 'version'>>
  > {
    const [row] = await tx
      .select()
      .from(librarySettings)
      .where(
        and(eq(librarySettings.institutionId, institutionId), isNull(librarySettings.archivedAt)),
      )
      .limit(1);

    if (!row) return { ...DEFAULT_SETTINGS, isDefault: true };
    return {
      id: row.id,
      finePerDay: row.finePerDay,
      maxRenewals: row.maxRenewals,
      reservationHoldDays: row.reservationHoldDays,
      defaultLoanDays: row.defaultLoanDays,
      defaultMaxBooks: row.defaultMaxBooks,
      version: row.version,
      isDefault: false,
    };
  }

  private applyArchiveFilter(
    principal: Principal,
    filters: SQL[],
    archivedAtColumn: SQLWrapper,
    includeArchived: boolean,
    permission: Permission,
  ): void {
    if (!includeArchived) {
      filters.push(isNull(archivedAtColumn));
      return;
    }
    if (!can(principal, permission)) {
      throw new ForbiddenError(permission, 'You cannot view archived library records');
    }
  }

  private async loadCategory(tx: Tx, institutionId: string, id: string): Promise<CategoryRow> {
    const [row] = await tx
      .select()
      .from(libraryCategories)
      .where(
        and(
          eq(libraryCategories.id, id),
          eq(libraryCategories.institutionId, institutionId),
          isNull(libraryCategories.archivedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundError('Library category', id);
    return row;
  }

  private async loadTitle(tx: Tx, institutionId: string, id: string): Promise<TitleRow> {
    const [row] = await tx
      .select()
      .from(libraryTitles)
      .where(
        and(
          eq(libraryTitles.id, id),
          eq(libraryTitles.institutionId, institutionId),
          isNull(libraryTitles.archivedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundError('Library title', id);
    return row;
  }

  private async loadCopy(tx: Tx, institutionId: string, id: string): Promise<CopyRow> {
    const [row] = await tx
      .select()
      .from(libraryCopies)
      .where(
        and(
          eq(libraryCopies.id, id),
          eq(libraryCopies.institutionId, institutionId),
          isNull(libraryCopies.archivedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundError('Library copy', id);
    return row;
  }

  private async loadMember(tx: Tx, institutionId: string, id: string): Promise<MemberRow> {
    const [row] = await tx
      .select()
      .from(libraryMembers)
      .where(
        and(
          eq(libraryMembers.id, id),
          eq(libraryMembers.institutionId, institutionId),
          isNull(libraryMembers.archivedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundError('Library member', id);
    return row;
  }

  /** A loan that is still out: `returned_at is null`, in this institution. */
  private async loadLiveLoan(tx: Tx, institutionId: string, id: string): Promise<LoanRow> {
    const [row] = await tx
      .select()
      .from(libraryLoans)
      .where(
        and(
          eq(libraryLoans.id, id),
          eq(libraryLoans.institutionId, institutionId),
          isNull(libraryLoans.archivedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundError('Library loan', id);
    if (row.returnedAt !== null) {
      throw new ConflictError('This loan has already been returned.');
    }
    return row;
  }

  private async loadFine(tx: Tx, institutionId: string, id: string): Promise<FineRow> {
    const [row] = await tx
      .select()
      .from(libraryFines)
      .where(
        and(
          eq(libraryFines.id, id),
          eq(libraryFines.institutionId, institutionId),
          isNull(libraryFines.archivedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundError('Library fine', id);
    return row;
  }

  /**
   * The head of a title's queue after expiring stale holds, or null when the queue is empty.
   * Expired holds vacate their position, and the queue closes the gap in this transaction.
   */
  private async expireStaleHolds(
    tx: Tx,
    principal: Principal,
    titleId: string,
  ): Promise<ReservationRow | null> {
    const now = new Date();

    for (;;) {
      const [head] = await tx
        .select()
        .from(libraryReservations)
        .where(
          and(
            eq(libraryReservations.titleId, titleId),
            eq(libraryReservations.status, 'active'),
            isNull(libraryReservations.archivedAt),
          ),
        )
        .orderBy(asc(libraryReservations.queuePosition), asc(libraryReservations.reservedAt))
        .limit(1);

      if (!head) return null;
      if (!head.expiresAt || head.expiresAt.getTime() >= now.getTime()) return head;

      await tx
        .update(libraryReservations)
        .set({ status: 'expired', updatedBy: principal.userId, version: head.version + 1 })
        .where(eq(libraryReservations.id, head.id));
      await this.advanceQueue(tx, titleId, head.queuePosition);
    }
  }

  /** Close the gap left at `abovePosition` — one UPDATE, atomic within the transaction. */
  private async advanceQueue(tx: Tx, titleId: string, abovePosition: number): Promise<void> {
    await tx
      .update(libraryReservations)
      .set({ queuePosition: sql`${libraryReservations.queuePosition} - 1` })
      .where(
        and(
          eq(libraryReservations.titleId, titleId),
          eq(libraryReservations.status, 'active'),
          isNull(libraryReservations.archivedAt),
          sql`${libraryReservations.queuePosition} > ${abovePosition}`,
        ),
      );
  }

  /**
   * Recompute a title's copy count from the copy rows — a sum is a fact, an increment is a
   * running total that can drift.
   */
  private async recomputeTitleCopies(
    tx: Tx,
    titleId: string,
    actorUserId: string | null,
  ): Promise<void> {
    const [counted] = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(libraryCopies)
      .where(
        and(
          eq(libraryCopies.titleId, titleId),
          isNull(libraryCopies.archivedAt),
          ne(libraryCopies.status, 'withdrawn'),
        ),
      );

    await tx
      .update(libraryTitles)
      .set({ totalCopies: counted?.total ?? 0, updatedBy: actorUserId })
      .where(eq(libraryTitles.id, titleId));
  }

  /**
   * Recompute a loan's fine total from its live, non-waived fine rows, and keep the loan's
   * status honest about being overdue while it is still out.
   */
  private async recomputeLoanFineTotal(
    tx: Tx,
    loanId: string,
    actorUserId: string | null,
    options: { markOverdue?: boolean } = {},
  ): Promise<void> {
    const [aggregate] = await tx
      .select({
        total: sql<string>`coalesce(sum(${libraryFines.amount}), 0)::numeric(14,2)`,
      })
      .from(libraryFines)
      .where(
        and(
          eq(libraryFines.loanId, loanId),
          ne(libraryFines.status, 'waived'),
          isNull(libraryFines.archivedAt),
        ),
      );

    const total = Money.fromDecimalString(aggregate?.total ?? '0.00');
    const changes: Partial<LoanRow> = {
      fineAmount: total.toDecimalString(),
      updatedBy: actorUserId,
    };
    if (options.markOverdue) changes.status = 'overdue';

    await tx.update(libraryLoans).set(changes).where(eq(libraryLoans.id, loanId));
  }

  /**
   * The highest accession number already in the register under the `ACC-` prefix. The
   * partial unique index on `(institution_id, accession_number)` is the real guarantee; two
   * racing accessions collide there rather than silently sharing a number.
   */
  private async currentAccessionSequence(tx: Tx, institutionId: string): Promise<number> {
    const [row] = await tx
      .select({ maxNumber: sql<string | null>`max(${libraryCopies.accessionNumber})` })
      .from(libraryCopies)
      .where(
        and(
          eq(libraryCopies.institutionId, institutionId),
          like(libraryCopies.accessionNumber, 'ACC-%'),
        ),
      );
    return sequenceAfter(row?.maxNumber ?? null, 'ACC-');
  }

  private async currentCardSequence(tx: Tx, institutionId: string): Promise<number> {
    const [row] = await tx
      .select({ maxNumber: sql<string | null>`max(${libraryMembers.cardNumber})` })
      .from(libraryMembers)
      .where(
        and(
          eq(libraryMembers.institutionId, institutionId),
          like(libraryMembers.cardNumber, 'LM-%'),
        ),
      );
    return sequenceAfter(row?.maxNumber ?? null, 'LM-');
  }
}

// ────────────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────────────────────────

/** Next number after the highest one already issued under a prefix. */
function sequenceAfter(highest: string | null, prefix: string): number {
  if (!highest) return 0;
  const parsed = Number.parseInt(highest.slice(prefix.length), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function diffOf<T extends Record<string, unknown>>(
  before: T,
  after: T,
  keys: string[],
): Partial<T> {
  const previous: Partial<T> = {};
  for (const key of keys) {
    const typedKey = key as keyof T;
    if (before[typedKey] !== after[typedKey]) {
      (previous as Record<string, unknown>)[key] = before[typedKey];
    }
  }
  return previous;
}

/**
 * Determine an image MIME type from the first bytes. Covers exactly the accepted cover
 * types; an unrecognised signature is refused outright — a book cover has no reason to be
 * anything else.
 */
function sniffImageMimeType(buffer: Buffer): string | null {
  if (buffer.length >= 4) {
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
      return 'image/png';
    }
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buffer.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

// ── Sort-column maps ─────────────────────────────────────────────────────────────────

const CATEGORY_COLUMNS = {
  nameEn: libraryCategories.nameEn,
  createdAt: libraryCategories.createdAt,
} as const;

const TITLE_COLUMNS = {
  title: libraryTitles.title,
  author: libraryTitles.author,
  publisher: libraryTitles.publisher,
  language: libraryTitles.language,
  totalCopies: libraryTitles.totalCopies,
  createdAt: libraryTitles.createdAt,
} as const;

const COPY_COLUMNS = {
  accessionNumber: libraryCopies.accessionNumber,
  status: libraryCopies.status,
  condition: libraryCopies.condition,
  acquiredOn: libraryCopies.acquiredOn,
  createdAt: libraryCopies.createdAt,
} as const;

const MEMBER_COLUMNS = {
  cardNumber: libraryMembers.cardNumber,
  status: libraryMembers.status,
  createdAt: libraryMembers.createdAt,
} as const;

const LOAN_COLUMNS = {
  issuedAt: libraryLoans.issuedAt,
  dueOn: libraryLoans.dueOn,
  status: libraryLoans.status,
  createdAt: libraryLoans.createdAt,
} as const;

const FINE_COLUMNS = {
  assessedOn: libraryFines.assessedOn,
  amount: libraryFines.amount,
  status: libraryFines.status,
  createdAt: libraryFines.createdAt,
} as const;
