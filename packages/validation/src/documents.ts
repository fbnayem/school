/**
 * Document and certificate generation schemas (Phase 23).
 *
 * Two things here are load-bearing rather than decorative:
 *
 *  1. **Template markup is checked before it is stored.** A template is HTML written by a
 *     human with `documents.templates.manage`, printed onto official paper and shown in a
 *     browser. Anything that could execute — a `<script>`, an `<iframe>`, an `on*=` handler,
 *     a `javascript:` URL — is refused at the boundary, so the renderer never has to decide
 *     whether markup it was handed is safe.
 *  2. **Placeholders are syntactically constrained.** `{{student.fullNameEn}}` is a dotted
 *     identifier and nothing else: no spaces inside a segment, no brackets, no `__proto__`,
 *     no call syntax. The renderer resolves each name against a fixed allow-list held in the
 *     service — this schema only guarantees that what reaches it *is* a name.
 *
 * Deliberately absent: any field that would let a client state a derived fact. There is no
 * `serialNumber`, no `verificationCode`, no `renderedHtml`, no `dataSnapshot` and no
 * `status` on any input. Those are produced by the server, and migration 0028 freezes them.
 *
 * Every exported constant carries a `DOCUMENT_`/`ISSUED_DOCUMENT_` prefix because
 * `@shikkha/validation` re-exports flat.
 */

import { z } from 'zod';
import {
  calendarDateSchema,
  paginationSchema,
  reasonSchema,
  searchSchema,
  sortSchema,
  uuidSchema,
} from './common';

// ── Value sets, mirrored from the database enums ─────────────────────────────────────

export const DOCUMENT_KINDS = [
  'transfer_certificate',
  'testimonial',
  'character_certificate',
  'admission_letter',
  'id_card',
  'fee_receipt',
  'marksheet',
  'salary_certificate',
  'experience_letter',
  'notice',
  'custom',
] as const;

export const DOCUMENT_PAGE_SIZES = ['a4', 'a5', 'letter'] as const;

export const DOCUMENT_ORIENTATIONS = ['portrait', 'landscape'] as const;

export const DOCUMENT_SUBJECT_KINDS = ['student', 'employee', 'guardian'] as const;

export const DOCUMENT_REQUEST_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'rejected',
  'issued',
  'revoked',
] as const;

export const DOCUMENT_VERIFICATION_CHANNELS = ['public_web', 'qr_scan', 'staff_portal'] as const;

// ── Sort-field allow-lists ───────────────────────────────────────────────────────────

export const DOCUMENT_TEMPLATE_SORT_FIELDS = ['key', 'name', 'version', 'createdAt'] as const;

export const DOCUMENT_REQUEST_SORT_FIELDS = ['status', 'createdAt'] as const;

export const ISSUED_DOCUMENT_SORT_FIELDS = ['serialNumber', 'issuedOn', 'createdAt'] as const;

// ── Template markup ──────────────────────────────────────────────────────────────────

/**
 * A `{{placeholder}}` name: two or three dotted segments, each starting with a letter and
 * containing only letters and digits.
 *
 * `__proto__` fails on the leading underscore; `constructor.name` is syntactically a name and
 * passes here, and is then refused by the renderer's allow-list, which is a `Map` lookup and
 * therefore has no inherited keys at all. Both defences are deliberate: the shape check keeps
 * obviously hostile input out of the parser, and the allow-list is what actually decides.
 */
const PLACEHOLDER_NAME = /^[a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*){1,2}$/;

/** Anything that could execute in a browser or a PDF renderer. */
const EXECUTABLE_MARKUP: Array<{ pattern: RegExp; what: string }> = [
  { pattern: /<\s*script\b/i, what: 'a <script> element' },
  { pattern: /<\s*iframe\b/i, what: 'an <iframe> element' },
  { pattern: /<\s*object\b/i, what: 'an <object> element' },
  { pattern: /<\s*embed\b/i, what: 'an <embed> element' },
  { pattern: /<\s*link\b/i, what: 'a <link> element' },
  { pattern: /<\s*meta\b/i, what: 'a <meta> element' },
  { pattern: /<\s*base\b/i, what: 'a <base> element' },
  { pattern: /\son[a-z]+\s*=/i, what: 'an inline event handler' },
  { pattern: /javascript\s*:/i, what: 'a javascript: URL' },
  { pattern: /data\s*:\s*text\/html/i, what: 'a data: HTML URL' },
  { pattern: /<!--\s*#/i, what: 'a server-side include' },
];

/**
 * Template markup: bounded, non-executable, and containing only well-formed placeholders.
 *
 * The `{{`/`}}` scan is exhaustive rather than sampling: every opening marker must belong to
 * a complete, well-formed placeholder. A stray `{{` is a typo that would otherwise print
 * literally on a certificate, and a nested one (`{{{{x}}}}`) is an attempt to smuggle a name
 * past the shape check.
 */
function templateMarkup(maxLength: number) {
  return z
    .string()
    .max(maxLength)
    .superRefine((value, ctx) => {
      for (const { pattern, what } of EXECUTABLE_MARKUP) {
        if (pattern.test(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `A template may not contain ${what}. Documents are rendered as inert markup.`,
          });
          return;
        }
      }

      const opens = value.split('{{').length - 1;
      const closes = value.split('}}').length - 1;
      const matched = [...value.matchAll(/\{\{([^{}]*)\}\}/g)];

      if (matched.length !== opens || matched.length !== closes) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'Every {{ must open a complete placeholder and every }} must close one. Check for a stray or nested brace.',
        });
        return;
      }

      for (const match of matched) {
        const name = (match[1] ?? '').trim();
        if (!PLACEHOLDER_NAME.test(name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `"{{${match[1] ?? ''}}}" is not a placeholder name. Use a dotted name such as {{student.fullNameEn}}.`,
          });
          return;
        }
      }
    });
}

/** Page margins in millimetres. Bounded so a template cannot render zero usable area. */
export const documentMarginsSchema = z.object({
  top: z.coerce.number().int().min(0).max(80).default(20),
  right: z.coerce.number().int().min(0).max(80).default(18),
  bottom: z.coerce.number().int().min(0).max(80).default(20),
  left: z.coerce.number().int().min(0).max(80).default(18),
});

// ── Templates ────────────────────────────────────────────────────────────────────────

export const createDocumentTemplateSchema = z.object({
  key: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_-]*$/, 'Use lowercase letters, digits, hyphens and underscores')
    .min(2)
    .max(64),
  name: z.string().trim().min(2).max(128),
  nameBn: z.string().trim().max(128).optional(),
  kind: z.enum(DOCUMENT_KINDS),
  bodyHtml: templateMarkup(64_000),
  headerHtml: templateMarkup(8_000).optional(),
  footerHtml: templateMarkup(8_000).optional(),
  pageSize: z.enum(DOCUMENT_PAGE_SIZES).default('a4'),
  orientation: z.enum(DOCUMENT_ORIENTATIONS).default('portrait'),
  margins: documentMarginsSchema.optional(),
  requiresApproval: z.boolean().default(false),
});

/**
 * Editing a template publishes a new version; it never rewrites the one that is live.
 *
 * `key` is therefore absent: changing it would make the new version a different template
 * wearing the old one's history. The service supersedes the active version with
 * `version + 1`, and migration 0028 refuses any other interpretation.
 */
export const updateDocumentTemplateSchema = createDocumentTemplateSchema
  .omit({ key: true })
  .partial()
  .extend({
    /** The version the editor was looking at. A mismatch is a 409, not a lost edit. */
    expectedVersion: z.coerce.number().int().min(1),
  })
  .refine(
    (value) => Object.keys(value).some((field) => field !== 'expectedVersion'),
    'Change at least one field',
  );

export const listDocumentTemplatesSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema)
  .extend({
    kind: z.enum(DOCUMENT_KINDS).optional(),
    activeOnly: z.coerce.boolean().default(false),
    includeArchived: z.coerce.boolean().default(false),
  });

export const archiveDocumentTemplateSchema = z.object({ reason: reasonSchema });

// ── Preview ──────────────────────────────────────────────────────────────────────────

/**
 * Render without issuing.
 *
 * The subject is real and scope-checked exactly as it would be at issue time — a preview that
 * skipped the check would be a read of a record the caller cannot see, which is why this
 * route is audited as an export.
 */
export const previewDocumentSchema = z.object({
  templateId: uuidSchema,
  subjectKind: z.enum(DOCUMENT_SUBJECT_KINDS),
  subjectId: uuidSchema,
});

// ── Requests ─────────────────────────────────────────────────────────────────────────

export const createDocumentRequestSchema = z.object({
  templateId: uuidSchema,
  /**
   * Whose record the document is about. Checked against the template: a body that reads
   * `{{employee.*}}` cannot be pointed at a student, and the mismatch is an error at request
   * time rather than a blank line on a printed certificate.
   */
  subjectKind: z.enum(DOCUMENT_SUBJECT_KINDS),
  subjectId: uuidSchema,
  purpose: z.string().trim().min(3, 'Say what the document is for').max(500),
});

export const listDocumentRequestsSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema)
  .extend({
    status: z.enum(DOCUMENT_REQUEST_STATUSES).optional(),
    subjectKind: z.enum(DOCUMENT_SUBJECT_KINDS).optional(),
    subjectId: uuidSchema.optional(),
    templateId: uuidSchema.optional(),
    mine: z.coerce.boolean().default(false),
    includeArchived: z.coerce.boolean().default(false),
  });

export const approveDocumentRequestSchema = z.object({
  note: z.string().trim().max(1000).optional(),
});

export const rejectDocumentRequestSchema = z.object({ reason: reasonSchema });

// ── Issuance ─────────────────────────────────────────────────────────────────────────

/** Issue the document an approved request asked for. Nothing about the content is a field. */
export const issueDocumentSchema = z.object({
  /** Defaults to today in Dhaka. Never in the future — a certificate cannot pre-date itself. */
  issuedOn: calendarDateSchema.optional(),
});

/**
 * Issue one document per student in a section.
 *
 * Refused for a template that requires approval: bulk issuance has no requester to approve
 * against, and migration 0028 refuses the insert regardless of what the service decides.
 */
export const bulkIssueDocumentsSchema = z.object({
  templateId: uuidSchema,
  sectionId: uuidSchema,
  purpose: z.string().trim().min(3).max(500),
  issuedOn: calendarDateSchema.optional(),
});

export const revokeIssuedDocumentSchema = z.object({ reason: reasonSchema });

export const listIssuedDocumentsSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema)
  .extend({
    templateId: uuidSchema.optional(),
    kind: z.enum(DOCUMENT_KINDS).optional(),
    subjectKind: z.enum(DOCUMENT_SUBJECT_KINDS).optional(),
    subjectId: uuidSchema.optional(),
    issuedFrom: calendarDateSchema.optional(),
    issuedTo: calendarDateSchema.optional(),
    revokedOnly: z.coerce.boolean().default(false),
  });

// ── Verification ─────────────────────────────────────────────────────────────────────

/**
 * The public check. A code and nothing else: no institution, no subject id, no token.
 *
 * The response says whether the document is valid, what kind it is, the subject's name and
 * the issue date — and nothing further. See `DocumentsService.verifyPublicly`.
 */
export const verifyDocumentSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[A-Z0-9-]{10,32}$/i, 'A verification code is 10 to 32 letters and digits'),
  /**
   * How the check reached us, recorded on the verification row. A QR code printed on the
   * certificate links to the same endpoint with `qr_scan`, which is worth distinguishing from
   * somebody typing the code — one is the holder, the other may not be.
   */
  channel: z.enum(['public_web', 'qr_scan']).default('public_web'),
});

// ── Register report ──────────────────────────────────────────────────────────────────

/** The issuance register: what was issued, to whom, by whom, over a date range. */
export const documentRegisterQuerySchema = z.object({
  from: calendarDateSchema,
  to: calendarDateSchema,
  kind: z.enum(DOCUMENT_KINDS).optional(),
  templateId: uuidSchema.optional(),
  includeRevoked: z.coerce.boolean().default(true),
});
