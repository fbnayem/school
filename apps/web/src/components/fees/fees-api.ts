/**
 * Typed client for the `/fees` module (plus the two academic lookups fee screens need).
 *
 * Every route in the fees controller is `@InstitutionScoped()`, so every function here takes
 * the institution id and passes it through `RequestOptions.institutionId` — `apiRequest` turns
 * that into the `x-institution-id` header. Money fields are typed `string` on purpose: they
 * are decimal strings end to end (ADR-004) and nothing in the browser may parse them.
 */

import { apiRequest, type Paged } from '@/lib/api';
import type {
  FEE_CONCESSION_STATUSES,
  FEE_CONCESSION_TYPES,
  FEE_FREQUENCIES,
  FEE_HEAD_TYPES,
  FEE_PAYMENT_METHODS,
  FEE_PAYMENT_STATUSES,
  FEE_STRUCTURE_STATUSES,
  INVOICE_STATUSES,
  LATE_FINE_KINDS,
} from '@shikkha/validation';

export type FeeHeadType = (typeof FEE_HEAD_TYPES)[number];
export type FeeFrequency = (typeof FEE_FREQUENCIES)[number];
export type FeeStructureStatus = (typeof FEE_STRUCTURE_STATUSES)[number];
export type FeeConcessionType = (typeof FEE_CONCESSION_TYPES)[number];
export type FeeConcessionStatus = (typeof FEE_CONCESSION_STATUSES)[number];
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
export type PaymentMethod = (typeof FEE_PAYMENT_METHODS)[number];
export type PaymentStatus = (typeof FEE_PAYMENT_STATUSES)[number];
export type LateFineKind = (typeof LATE_FINE_KINDS)[number];

export interface FeeHead {
  id: string;
  code: string;
  nameEn: string;
  nameBn: string | null;
  type: FeeHeadType;
  isRecurring: boolean;
  isRefundable: boolean;
  ledgerAccountCode: string | null;
  description: string | null;
  sortOrder: number;
  version: number;
  archivedAt: string | null;
}

export interface FeeStructure {
  id: string;
  campusId: string;
  academicYearId: string;
  classLevelId: string | null;
  academicGroupId: string | null;
  nameEn: string;
  nameBn: string | null;
  status: FeeStructureStatus;
  effectiveFrom: string;
  lateFineKind: LateFineKind;
  lateFineValue: string;
  lateFineGraceDays: number;
  lateFineMaxAmount: string | null;
  version: number;
  archivedAt: string | null;
}

export interface FeeStructureItem {
  id: string;
  feeHeadId: string;
  amount: string;
  frequency: FeeFrequency;
  dueDayOfMonth: number | null;
  isOptional: boolean;
  sortOrder: number;
}

export interface FeeConcession {
  id: string;
  studentId: string;
  feeHeadId: string | null;
  type: FeeConcessionType;
  value: string;
  reason: string;
  status: FeeConcessionStatus;
  decisionNote: string | null;
  approvedAt: string | null;
  validFrom: string;
  validTo: string | null;
  version: number;
  createdAt: string;
}

export interface Invoice {
  id: string;
  studentId: string;
  academicYearId: string;
  invoiceNumber: string;
  billingPeriodStart: string;
  billingPeriodEnd: string;
  issueDate: string;
  dueDate: string;
  subtotal: string;
  discountTotal: string;
  fineTotal: string;
  total: string;
  paidTotal: string;
  balance: string;
  currency: string;
  status: InvoiceStatus;
  notes: string | null;
  voidedReason: string | null;
  version: number;
}

export interface InvoiceLine {
  id: string;
  feeHeadId: string;
  description: string;
  amount: string;
  discountAmount: string;
  netAmount: string;
  isFine: boolean;
  sortOrder: number;
}

export interface InvoiceAllocation {
  allocationId: string;
  amount: string;
  paymentId: string;
  receiptNumber: string;
  method: PaymentMethod;
  receivedAt: string;
  paymentStatus: PaymentStatus;
}

export interface InvoiceDetail extends Invoice {
  lines: InvoiceLine[];
  payments: InvoiceAllocation[];
}

export interface Payment {
  id: string;
  studentId: string;
  receiptNumber: string;
  amount: string;
  method: PaymentMethod;
  reference: string | null;
  receivedAt: string;
  status: PaymentStatus;
  notes: string | null;
  reversalReason: string | null;
  version: number;
}

export interface PreparedInvoiceLine {
  feeHeadId: string;
  description: string;
  amount: string;
  discountAmount: string;
  netAmount: string;
}

export interface PreparedInvoice {
  studentId: string;
  studentName: string;
  subtotal: string;
  discountTotal: string;
  total: string;
  lines: PreparedInvoiceLine[];
  id?: string;
  invoiceNumber?: string;
}

export interface SkippedStudent {
  studentId: string;
  studentName: string;
  reason: string;
  existingInvoiceId?: string;
}

export interface GenerationResult {
  committed: boolean;
  invoices: PreparedInvoice[];
  skipped: SkippedStudent[];
  totals: { invoiceCount: number; subtotal: string; discountTotal: string; total: string };
}

export interface LedgerEntry {
  date: string;
  type: 'invoice' | 'payment';
  reference: string;
  description: string;
  charge: string;
  credit: string;
  status: string;
  balance: string;
}

export interface StudentLedger {
  student: { id: string; fullNameEn: string; studentCode: string };
  currency: string;
  totalCharged: string;
  totalPaid: string;
  closingBalance: string;
  entries: LedgerEntry[];
}

export interface OutstandingDuesRow {
  classLevelId: string;
  classLevelName: string;
  classOrdinal: number;
  sectionId: string | null;
  sectionName: string | null;
  studentCount: number;
  invoiceCount: number;
  billed: string;
  collected: string;
  outstanding: string;
}

export interface OutstandingDuesReport {
  groupBy: 'class' | 'section';
  currency: string;
  rows: OutstandingDuesRow[];
  totals: { billed: string; collected: string; outstanding: string };
}

export interface CollectionSummary {
  from: string;
  to: string;
  currency: string;
  byMethod: Array<{ method: PaymentMethod; count: number; amount: string }>;
  totalCount: number;
  totalAmount: string;
}

/**
 * The result of a late-fine run.
 *
 * `applied` names every invoice that was actually charged and `skipped` says why the rest were
 * not, because a fine is money a family owes and "we charged 47 invoices" is not a reviewable
 * statement on its own.
 */
export interface LateFineRunResult {
  asOfDate: string;
  applied: Array<{ invoiceId: string; invoiceNumber: string; fine: string; total: string }>;
  skipped: Array<{ invoiceId: string; reason: string }>;
  totalFined: string;
}

export interface AssignResult {
  assigned: number;
  updated: number;
  skipped: SkippedStudent[];
}

export interface RecordPaymentResult {
  payment: Payment;
  allocations: Array<{ invoiceId: string; invoiceNumber: string; amount: string }>;
  unallocated: string;
}

export interface ClassLevel {
  id: string;
  code: string;
  nameEn: string;
  nameBn: string | null;
  ordinal: number;
  hasGroups: boolean;
}

/** The full section row `/academic/sections` returns — `api.sections` types a subset. */
export interface SectionOption {
  id: string;
  nameEn: string;
  nameBn: string | null;
  capacity: number | null;
  classLevelId: string;
  classLevelName: string;
  classLevelOrdinal: number;
  academicYearId: string;
  campusId: string;
  enrolledCount: number;
}

type Query = Record<string, string | number | boolean | undefined | null>;

export const feesApi = {
  // ── Fee heads ──────────────────────────────────────────────────────────────────────
  listFeeHeads: (institutionId: string, query: Query) =>
    apiRequest<Paged<FeeHead>>('/fees/heads', { query, institutionId }),
  createFeeHead: (institutionId: string, body: unknown) =>
    apiRequest<FeeHead>('/fees/heads', { method: 'POST', body, institutionId }),
  updateFeeHead: (institutionId: string, id: string, body: unknown) =>
    apiRequest<FeeHead>(`/fees/heads/${id}`, { method: 'PATCH', body, institutionId }),
  archiveFeeHead: (institutionId: string, id: string, reason: string) =>
    apiRequest<FeeHead>(`/fees/heads/${id}/archive`, {
      method: 'POST',
      body: { reason },
      institutionId,
    }),

  // ── Fee structures ─────────────────────────────────────────────────────────────────
  listFeeStructures: (institutionId: string, query: Query) =>
    apiRequest<Paged<FeeStructure>>('/fees/structures', { query, institutionId }),
  getFeeStructure: (institutionId: string, id: string) =>
    apiRequest<FeeStructure & { items: FeeStructureItem[] }>(`/fees/structures/${id}`, {
      institutionId,
    }),
  createFeeStructure: (institutionId: string, body: unknown) =>
    apiRequest<FeeStructure>('/fees/structures', { method: 'POST', body, institutionId }),
  updateFeeStructure: (institutionId: string, id: string, body: unknown) =>
    apiRequest<FeeStructure>(`/fees/structures/${id}`, {
      method: 'PATCH',
      body,
      institutionId,
    }),
  replaceFeeStructureItems: (institutionId: string, id: string, body: unknown) =>
    apiRequest<{ structure: FeeStructure; items: FeeStructureItem[] }>(
      `/fees/structures/${id}/items`,
      { method: 'PUT', body, institutionId },
    ),
  archiveFeeStructure: (institutionId: string, id: string, reason: string) =>
    apiRequest<FeeStructure>(`/fees/structures/${id}/archive`, {
      method: 'POST',
      body: { reason },
      institutionId,
    }),
  assignFeeStructure: (institutionId: string, body: unknown) =>
    apiRequest<AssignResult>('/fees/structures/assign', {
      method: 'POST',
      body,
      institutionId,
    }),

  // ── Concessions ────────────────────────────────────────────────────────────────────
  listConcessions: (institutionId: string, query: Query) =>
    apiRequest<Paged<FeeConcession>>('/fees/concessions', { query, institutionId }),
  createConcession: (institutionId: string, body: unknown) =>
    apiRequest<FeeConcession>('/fees/concessions', { method: 'POST', body, institutionId }),
  decideConcession: (
    institutionId: string,
    id: string,
    decision: 'approved' | 'rejected',
    reason: string,
  ) =>
    apiRequest<FeeConcession>(`/fees/concessions/${id}/decision`, {
      method: 'POST',
      body: { decision, reason },
      institutionId,
    }),

  // ── Invoices ───────────────────────────────────────────────────────────────────────
  previewInvoices: (institutionId: string, body: unknown) =>
    apiRequest<GenerationResult>('/fees/invoices/preview', {
      method: 'POST',
      body,
      institutionId,
    }),
  generateInvoices: (institutionId: string, body: unknown) =>
    apiRequest<GenerationResult>('/fees/invoices/generate', {
      method: 'POST',
      body,
      institutionId,
    }),
  applyLateFines: (institutionId: string, body: unknown) =>
    apiRequest<LateFineRunResult>('/fees/invoices/late-fines', {
      method: 'POST',
      body,
      institutionId,
    }),
  listInvoices: (institutionId: string, query: Query) =>
    apiRequest<Paged<Invoice>>('/fees/invoices', { query, institutionId }),
  getInvoice: (institutionId: string, id: string) =>
    apiRequest<InvoiceDetail>(`/fees/invoices/${id}`, { institutionId }),
  voidInvoice: (institutionId: string, id: string, reason: string) =>
    apiRequest<Invoice>(`/fees/invoices/${id}/void`, {
      method: 'POST',
      body: { reason },
      institutionId,
    }),

  // ── Payments ───────────────────────────────────────────────────────────────────────
  listPayments: (institutionId: string, query: Query) =>
    apiRequest<Paged<Payment>>('/fees/payments', { query, institutionId }),
  recordPayment: (institutionId: string, body: unknown) =>
    apiRequest<RecordPaymentResult>('/fees/payments', { method: 'POST', body, institutionId }),
  reversePayment: (institutionId: string, id: string, reason: string, version: number) =>
    apiRequest<{ payment: Payment; recomputedInvoiceIds: string[] }>(
      `/fees/payments/${id}/reverse`,
      { method: 'POST', body: { reason, version }, institutionId },
    ),

  // ── Ledger and reports ─────────────────────────────────────────────────────────────
  studentLedger: (institutionId: string, studentId: string, query: Query) =>
    apiRequest<StudentLedger>(`/fees/students/${studentId}/ledger`, { query, institutionId }),
  outstandingDues: (institutionId: string, query: Query) =>
    apiRequest<OutstandingDuesReport>('/fees/reports/outstanding', { query, institutionId }),
  collectionSummary: (institutionId: string, query: Query) =>
    apiRequest<CollectionSummary>('/fees/reports/collections', { query, institutionId }),

  // ── Academic lookups fee screens need ──────────────────────────────────────────────
  classLevels: (institutionId: string) =>
    apiRequest<ClassLevel[]>('/academic/class-levels', { institutionId }),
  sections: (institutionId: string, academicYearId?: string) =>
    apiRequest<SectionOption[]>('/academic/sections', {
      institutionId,
      query: { academicYearId },
    }),
};
