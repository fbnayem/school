/**
 * Pagination contracts shared by every list endpoint.
 *
 * Two strategies, chosen per endpoint rather than globally:
 *
 *  - **Offset** for UI tables that need page numbers and a total count. Bounded by a hard
 *    maximum page size so a client cannot ask for 50,000 students in one response.
 *  - **Cursor** for large exports, mobile sync, and anything ordered by a monotonic key.
 *    Offset pagination degrades badly deep into a large table and can skip or duplicate rows
 *    when the underlying data changes between pages, which matters for attendance sync.
 */

import { base64UrlToString, stringToBase64Url } from './bytes';

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 200;

export interface OffsetPageRequest {
  page: number;
  pageSize: number;
}

export interface CursorPageRequest {
  cursor?: string;
  limit: number;
}

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrevious: boolean;
}

export interface OffsetPage<T> {
  data: T[];
  meta: PageMeta;
}

export interface CursorPage<T> {
  data: T[];
  meta: {
    limit: number;
    nextCursor: string | null;
    hasNext: boolean;
  };
}

/** Clamp untrusted paging input. Never trust a client-supplied page size. */
export function normalizeOffsetPage(input: {
  page?: number | string | undefined;
  pageSize?: number | string | undefined;
}): OffsetPageRequest {
  const page = Math.max(1, Math.floor(Number(input.page ?? 1)) || 1);
  const rawSize = Math.floor(Number(input.pageSize ?? DEFAULT_PAGE_SIZE)) || DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, rawSize));
  return { page, pageSize };
}

export function offsetOf(request: OffsetPageRequest): number {
  return (request.page - 1) * request.pageSize;
}

export function buildOffsetPage<T>(
  data: T[],
  total: number,
  request: OffsetPageRequest,
): OffsetPage<T> {
  const totalPages = request.pageSize > 0 ? Math.ceil(total / request.pageSize) : 0;
  return {
    data,
    meta: {
      page: request.page,
      pageSize: request.pageSize,
      total,
      totalPages,
      hasNext: request.page < totalPages,
      hasPrevious: request.page > 1,
    },
  };
}

/**
 * Cursors are opaque base64url to discourage clients from constructing them by hand, which
 * would couple the client to the sort key. They are *not* a security boundary — a decoded
 * cursor still passes through the same tenant and permission checks as any other request.
 */
export function encodeCursor(value: Record<string, string | number>): string {
  return stringToBase64Url(JSON.stringify(value));
}

export function decodeCursor(cursor: string): Record<string, string | number> | null {
  try {
    const parsed: unknown = JSON.parse(base64UrlToString(cursor));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, string | number>;
  } catch {
    return null;
  }
}

export type SortDirection = 'asc' | 'desc';

export interface SortSpec<TField extends string = string> {
  field: TField;
  direction: SortDirection;
}

/**
 * Parse `?sort=name,-createdAt` against an allow-list.
 *
 * The allow-list is mandatory and not optional-with-default: sorting is the classic place
 * where an unvalidated field name reaches SQL. Unknown fields are dropped, never passed through.
 */
export function parseSort<TField extends string>(
  raw: string | undefined,
  allowed: readonly TField[],
  fallback: SortSpec<TField>,
): SortSpec<TField>[] {
  if (!raw) return [fallback];
  const specs: SortSpec<TField>[] = [];
  for (const token of raw.split(',')) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    const direction: SortDirection = trimmed.startsWith('-') ? 'desc' : 'asc';
    const field = trimmed.replace(/^[-+]/, '') as TField;
    if (allowed.includes(field)) specs.push({ field, direction });
  }
  return specs.length > 0 ? specs : [fallback];
}
