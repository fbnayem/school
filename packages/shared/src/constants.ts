/** Cross-cutting constants. Anything a magic string would otherwise become. */

export const APP_NAME = 'ShikkhaOS';
export const API_VERSION = 'v1';

export type Locale = 'en' | 'bn';
export const SUPPORTED_LOCALES: readonly Locale[] = ['en', 'bn'];
export const DEFAULT_LOCALE: Locale = 'en';

/**
 * Institution types. The schema is deliberately not specific to schools — the brief requires
 * extensibility to colleges, madrasahs, coaching centres and training institutions, and
 * retrofitting a type discriminator later would mean migrating every academic table.
 */
export const INSTITUTION_TYPES = [
  'school',
  'college',
  'school_and_college',
  'madrasah',
  'coaching_center',
  'training_institute',
  'university',
] as const;
export type InstitutionType = (typeof INSTITUTION_TYPES)[number];

/**
 * Medium of instruction. In Bangladesh these are three genuinely different products:
 * Bangla-medium follows the NCTB curriculum in Bangla; English-version follows the same
 * NCTB curriculum taught in English; English-medium follows Cambridge/Edexcel. They differ in
 * subjects, assessment and reporting, so this is a first-class field, not a label.
 */
export const INSTRUCTION_MEDIUMS = ['bangla', 'english_version', 'english_medium'] as const;
export type InstructionMedium = (typeof INSTRUCTION_MEDIUMS)[number];

/** Morning/day shifts are near-universal in Bangladeshi schools operating at capacity. */
export const SHIFT_KINDS = ['morning', 'day', 'evening', 'single'] as const;
export type ShiftKind = (typeof SHIFT_KINDS)[number];

export const GENDERS = ['male', 'female', 'other', 'undisclosed'] as const;
export type Gender = (typeof GENDERS)[number];

export const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] as const;
export type BloodGroup = (typeof BLOOD_GROUPS)[number];

export const RELIGIONS = ['islam', 'hinduism', 'buddhism', 'christianity', 'other'] as const;
export type Religion = (typeof RELIGIONS)[number];

export const STUDENT_STATUSES = [
  'active',
  'on_leave',
  'transferred',
  'withdrawn',
  'graduated',
  'alumni',
  'archived',
] as const;
export type StudentStatus = (typeof STUDENT_STATUSES)[number];

export const ATTENDANCE_STATUSES = ['present', 'absent', 'late', 'leave', 'excused'] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

export const GUARDIAN_RELATIONS = [
  'father',
  'mother',
  'brother',
  'sister',
  'uncle',
  'aunt',
  'grandfather',
  'grandmother',
  'legal_guardian',
  'other',
] as const;
export type GuardianRelation = (typeof GUARDIAN_RELATIONS)[number];

export const EMPLOYMENT_STATUSES = [
  'active',
  'probation',
  'on_leave',
  'suspended',
  'resigned',
  'terminated',
  'retired',
] as const;
export type EmploymentStatus = (typeof EMPLOYMENT_STATUSES)[number];

/** Upload limits. Enforced at the storage layer and restated at the HTTP body-size limit. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_IMPORT_BYTES = 25 * 1024 * 1024;

export const ALLOWED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const ALLOWED_DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;
export const ALLOWED_IMPORT_MIME_TYPES = [
  'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const;

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const INVITATION_TTL_SECONDS = 7 * 24 * 60 * 60;
export const PASSWORD_RESET_TTL_SECONDS = 60 * 60;

/** Cookie names. Access and refresh are separate so refresh can be path-scoped. */
export const ACCESS_TOKEN_COOKIE = 'shikkha_at';
export const REFRESH_TOKEN_COOKIE = 'shikkha_rt';
