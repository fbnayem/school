/**
 * API client.
 *
 * Two rules shape this file:
 *
 *  1. **The browser never holds a token in JavaScript.** Authentication rides on the httpOnly
 *     cookies the API sets, so `credentials: 'include'` is on every request and there is no
 *     token store, no localStorage, and nothing for an XSS bug to steal.
 *  2. **A 401 triggers one refresh attempt, and concurrent 401s share it.** Without the
 *     sharing, a dashboard that fires six queries on load would send six refresh requests, five
 *     of which present an already-rotated token — which the API correctly treats as token reuse
 *     and responds to by revoking the whole session. The user would be logged out by their own
 *     dashboard.
 */

import type { ErrorResponseBody, FieldIssue } from '@shikkha/shared';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly issues: FieldIssue[] = [],
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** True when the user could fix this by editing the form. */
  get isValidation(): boolean {
    return this.code === 'VALIDATION_FAILED';
  }

  /** Field errors keyed by path, ready to hand to React Hook Form's `setError`. */
  fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const issue of this.issues) {
      out[issue.path] ??= issue.message;
    }
    return out;
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Institution scope; the API requires it on institution-scoped endpoints. */
  institutionId?: string | null;
  signal?: AbortSignal;
  /** Skip the automatic refresh-and-retry. Used by the auth calls themselves. */
  skipRefresh?: boolean;
}

/** In-flight refresh, shared by every 401 that arrives while it is running. */
let refreshInFlight: Promise<boolean> | null = null;

async function refreshSession(): Promise<boolean> {
  refreshInFlight ??= (async () => {
    try {
      const response = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      // Cleared in a microtask so every caller awaiting this promise sees the same result
      // before a new refresh can start.
      queueMicrotask(() => {
        refreshInFlight = null;
      });
    }
  })();
  return refreshInFlight;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = new URL(`${API_BASE}${path.startsWith('/') ? path : `/${path}`}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function toApiError(response: Response): Promise<ApiError> {
  let body: ErrorResponseBody | null = null;
  try {
    body = (await response.json()) as ErrorResponseBody;
  } catch {
    // A non-JSON error body means something upstream failed — a proxy, a gateway timeout.
  }
  return new ApiError(
    response.status,
    body?.error.code ?? 'INTERNAL_ERROR',
    body?.error.message ?? 'Something went wrong. Please try again.',
    body?.error.issues ?? [],
    body?.error.requestId,
  );
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const send = async (): Promise<Response> =>
    fetch(buildUrl(path, options.query), {
      method: options.method ?? 'GET',
      credentials: 'include',
      headers: {
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(options.institutionId ? { 'x-institution-id': options.institutionId } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
    });

  let response = await send();

  if (response.status === 401 && !options.skipRefresh) {
    const refreshed = await refreshSession();
    if (refreshed) {
      response = await send();
    }
  }

  if (!response.ok) throw await toApiError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

// ── Typed endpoints ───────────────────────────────────────────────────────────────────

export interface CurrentUser {
  user: {
    id: string;
    email: string;
    fullNameEn: string;
    locale: 'en' | 'bn';
    tenantId: string | null;
    isPlatformAdmin: boolean;
    mustChangePassword: boolean;
    employeeId: string | null;
    guardianId: string | null;
    studentId: string | null;
  };
  roles: Array<{ key: string; institutionIds: string[] | null; campusIds: string[] | null }>;
  permissions: string[];
}

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrevious: boolean;
}

export interface Paged<T> {
  data: T[];
  meta: PageMeta;
}

export interface StudentSummary {
  id: string;
  studentCode: string;
  admissionNumber: string;
  fullNameEn: string;
  fullNameBn: string | null;
  dateOfBirth: string;
  gender: string;
  phone: string | null;
  status: string;
  photoFileId: string | null;
  admissionDate: string;
}

export interface ChildSummary {
  studentId: string;
  fullNameEn: string;
  fullNameBn: string | null;
  studentCode: string;
  status: string;
  relation: string;
  isPrimary: boolean;
  isBillingContact: boolean;
}

export const api = {
  login: (identifier: string, password: string) =>
    apiRequest<{ user: CurrentUser['user']; expiresIn: number }>('/auth/login', {
      method: 'POST',
      body: { identifier, password },
      skipRefresh: true,
    }),

  logout: () => apiRequest<void>('/auth/logout', { method: 'POST', skipRefresh: true }),

  me: (options: { signal?: AbortSignal } = {}) =>
    apiRequest<CurrentUser>('/auth/me', { signal: options.signal }),

  students: (params: {
    page?: number;
    pageSize?: number;
    q?: string;
    status?: string;
    sort?: string;
    institutionId?: string | null;
  }) =>
    apiRequest<Paged<StudentSummary>>('/students', {
      query: {
        page: params.page,
        pageSize: params.pageSize,
        q: params.q,
        status: params.status,
        sort: params.sort,
      },
      institutionId: params.institutionId,
    }),

  student: (id: string) => apiRequest<StudentSummary & Record<string, unknown>>(`/students/${id}`),

  myChildren: () => apiRequest<ChildSummary[]>('/guardians/my-children'),

  academicYears: (institutionId: string) =>
    apiRequest<Array<{ id: string; name: string; isCurrent: boolean; status: string }>>(
      '/academic/years',
      { institutionId },
    ),

  sections: (institutionId: string, academicYearId?: string) =>
    apiRequest<
      Array<{
        id: string;
        nameEn: string;
        classLevelName: string;
        classLevelOrdinal: number;
        capacity: number | null;
        enrolledCount: number;
      }>
    >('/academic/sections', { institutionId, query: { academicYearId } }),

  health: () =>
    apiRequest<{ status: string; components: Record<string, { status: string }> }>('/health', {
      skipRefresh: true,
    }),
};
