/**
 * The report source registry.
 *
 * Eight sources over entities that exist and are committed today. Each one is a hand-written
 * allow-list: a base table, the columns that may be selected (each with a type, a label and
 * the permission needed to see it), the operators each column accepts, the relations that
 * may be joined, and the data-scope rule that narrows rows to what the caller could already
 * read through the normal endpoint.
 *
 * **Adding a source needs no migration.** Nothing about a source is stored in the database —
 * `report_definitions.source_key` is just a key that must resolve here at run time. That is
 * why the lms, communication, inventory, asset, leave, document and automation sources are
 * absent rather than stubbed: they belong to other modules that are not committed, and a
 * source that names a table which may not exist would be a report that fails at query time
 * instead of a feature that is honestly missing.
 *
 * The scope rules are **reused, not re-derived**. Every student-centred source resolves the
 * caller's data scope over the same `SCOPED_RESOURCES` triple its own module uses and then
 * applies `StudentsService.scopeFilterSql` — so a class teacher's attendance report contains
 * exactly the students their attendance register does, and cannot be widened by asking for
 * the same rows through a different source.
 */

import { sql } from 'drizzle-orm';
import { SCOPED_RESOURCES, type ScopedResourcePermissions } from '@shikkha/permissions';
import {
  BOOLEAN_OPERATORS,
  COUNT_ONLY,
  ENUM_OPERATORS,
  ID_OPERATORS,
  NUMERIC_AGGREGATES,
  NUMERIC_OPERATORS,
  ref,
  TEMPORAL_OPERATORS,
  TEXT_OPERATORS,
  type ReportColumnDef,
  type ReportRelationDef,
  type ReportSourceDef,
} from './types';

/**
 * Fees and payments use the same two-permission scope the fees module uses: the whole
 * institution's finances, or a guardian's own children. There is no `assigned` — a class
 * teacher has no business reading a family's bill.
 */
const FINANCE_SCOPE: ScopedResourcePermissions = {
  all: 'finance.invoices.view',
  own: 'finance.own.view',
};

const GENDERS = ['male', 'female', 'other', 'undisclosed'] as const;
const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] as const;
const RELIGIONS = ['islam', 'hinduism', 'buddhism', 'christianity', 'other'] as const;
const STUDENT_STATUSES = [
  'active',
  'on_leave',
  'transferred',
  'withdrawn',
  'graduated',
  'alumni',
  'archived',
] as const;
const ENROLLMENT_STATUSES = [
  'active',
  'completed',
  'promoted',
  'repeated',
  'transferred_out',
  'withdrawn',
  'cancelled',
] as const;
const ATTENDANCE_STATUSES = ['present', 'absent', 'late', 'excused', 'half_day'] as const;
const INVOICE_STATUSES = [
  'draft',
  'issued',
  'partially_paid',
  'paid',
  'overdue',
  'void',
] as const;
const PAYMENT_METHODS = [
  'cash',
  'bank_transfer',
  'cheque',
  'bkash',
  'nagad',
  'rocket',
  'card',
  'online',
] as const;
const PAYMENT_STATUSES = ['pending', 'completed', 'failed', 'reversed'] as const;
const EMPLOYMENT_STATUSES = [
  'active',
  'probation',
  'on_leave',
  'suspended',
  'resigned',
  'terminated',
  'retired',
] as const;
const AUDIT_ACTIONS = [
  'create',
  'update',
  'archive',
  'restore',
  'approve',
  'reject',
  'publish',
  'unpublish',
  'login',
  'logout',
  'login_failed',
  'password_reset',
  'permission_change',
  'export',
  'import',
  'payment',
  'refund',
  'ai_action',
  'impersonate',
] as const;

/**
 * The `student` relation, shared by every source that keys on `student_id`.
 *
 * The alias is fixed and prefixed so it cannot collide with a base table name, and the ON
 * predicate is assembled from `sql.identifier` at module load — there is no code path that
 * builds a join clause from a request.
 */
function studentRelation(baseTable: string): ReportRelationDef {
  const alias = 'rpt_student';
  return {
    table: 'students',
    alias,
    label: 'Student',
    on: sql`${ref(alias, 'id')} = ${ref(baseTable, 'student_id')} and ${ref(alias, 'archived_at')} is null`,
  };
}

const STUDENT_RELATION_COLUMNS: Record<string, ReportColumnDef> = {
  studentName: {
    column: 'full_name_en',
    relation: 'student',
    type: 'text',
    label: 'Student name',
    labelBn: 'শিক্ষার্থীর নাম',
    operators: TEXT_OPERATORS,
    sortable: true,
    groupable: true,
    aggregates: COUNT_ONLY,
  },
  studentCode: {
    column: 'student_code',
    relation: 'student',
    type: 'text',
    label: 'Student code',
    operators: TEXT_OPERATORS,
    sortable: true,
    groupable: true,
    aggregates: COUNT_ONLY,
  },
};

// ─────────────────────────────────────────────────────────────────────────────────────
// Students
// ─────────────────────────────────────────────────────────────────────────────────────

const studentsSource: ReportSourceDef = {
  key: 'students',
  label: 'Students',
  labelBn: 'শিক্ষার্থী',
  table: 'students',
  permissions: ['students.view.all', 'students.view.assigned', 'students.view.own'],
  scope: { kind: 'student', resource: SCOPED_RESOURCES.students, studentColumn: null },
  institutionColumn: 'institution_id',
  archivedColumn: 'archived_at',
  relations: {},
  columns: {
    // Countable, so "how many per class / per status" needs no other column selected.
    id: {
      column: 'id',
      type: 'uuid',
      label: 'Id',
      operators: ID_OPERATORS,
      aggregates: COUNT_ONLY,
    },
    studentCode: {
      column: 'student_code',
      type: 'text',
      label: 'Student code',
      labelBn: 'শিক্ষার্থী কোড',
      operators: TEXT_OPERATORS,
      sortable: true,
      groupable: true,
      aggregates: COUNT_ONLY,
    },
    admissionNumber: {
      column: 'admission_number',
      type: 'text',
      label: 'Admission number',
      operators: TEXT_OPERATORS,
      sortable: true,
    },
    admissionDate: {
      column: 'admission_date',
      type: 'date',
      label: 'Admission date',
      operators: TEMPORAL_OPERATORS,
      sortable: true,
      groupable: true,
    },
    fullNameEn: {
      column: 'full_name_en',
      type: 'text',
      label: 'Full name',
      labelBn: 'পূর্ণ নাম',
      operators: TEXT_OPERATORS,
      sortable: true,
      groupable: true,
      aggregates: COUNT_ONLY,
    },
    fullNameBn: {
      column: 'full_name_bn',
      type: 'text',
      label: 'Full name (Bangla)',
      operators: TEXT_OPERATORS,
      sortable: true,
    },
    dateOfBirth: {
      column: 'date_of_birth',
      type: 'date',
      label: 'Date of birth',
      operators: TEMPORAL_OPERATORS,
      sortable: true,
    },
    gender: {
      column: 'gender',
      type: 'enum',
      label: 'Gender',
      labelBn: 'লিঙ্গ',
      operators: ENUM_OPERATORS,
      sortable: true,
      groupable: true,
      aggregates: COUNT_ONLY,
      enumValues: GENDERS,
    },
    bloodGroup: {
      column: 'blood_group',
      type: 'enum',
      label: 'Blood group',
      operators: ENUM_OPERATORS,
      groupable: true,
      aggregates: COUNT_ONLY,
      enumValues: BLOOD_GROUPS,
    },
    religion: {
      column: 'religion',
      type: 'enum',
      label: 'Religion',
      operators: ENUM_OPERATORS,
      groupable: true,
      aggregates: COUNT_ONLY,
      enumValues: RELIGIONS,
    },
    nationality: {
      column: 'nationality',
      type: 'text',
      label: 'Nationality',
      operators: TEXT_OPERATORS,
      groupable: true,
    },
    phone: { column: 'phone', type: 'text', label: 'Phone', operators: TEXT_OPERATORS },
    email: { column: 'email', type: 'text', label: 'Email', operators: TEXT_OPERATORS },
    district: {
      column: 'district',
      type: 'text',
      label: 'District',
      labelBn: 'জেলা',
      operators: TEXT_OPERATORS,
      sortable: true,
      groupable: true,
      aggregates: COUNT_ONLY,
    },
    division: {
      column: 'division',
      type: 'text',
      label: 'Division',
      operators: TEXT_OPERATORS,
      groupable: true,
      aggregates: COUNT_ONLY,
    },
    status: {
      column: 'status',
      type: 'enum',
      label: 'Status',
      operators: ENUM_OPERATORS,
      sortable: true,
      groupable: true,
      aggregates: COUNT_ONLY,
      enumValues: STUDENT_STATUSES,
    },
    createdAt: {
      column: 'created_at',
      type: 'timestamp',
      label: 'Created at',
      operators: TEMPORAL_OPERATORS,
      sortable: true,
    },

    // The four columns this whole permission mechanism exists for. Without
    // `students.medical.view` they are absent from the picker, absent from the projection,
    // and unusable as a filter — a filter on an invisible column is still a disclosure.
    medicalConditions: {
      column: 'medical_conditions',
      type: 'text',
      label: 'Medical conditions',
      permission: 'students.medical.view',
      operators: TEXT_OPERATORS,
    },
    allergies: {
      column: 'allergies',
      type: 'text',
      label: 'Allergies',
      permission: 'students.medical.view',
      operators: TEXT_OPERATORS,
    },
    specialNeeds: {
      column: 'special_needs',
      type: 'text',
      label: 'Special needs',
      permission: 'students.medical.view',
      operators: TEXT_OPERATORS,
    },
    emergencyMedicalNote: {
      column: 'emergency_medical_note',
      type: 'text',
      label: 'Emergency medical note',
      permission: 'students.medical.view',
      operators: TEXT_OPERATORS,
    },
  },
  defaultSort: { field: 'studentCode', direction: 'asc' },
};

// ─────────────────────────────────────────────────────────────────────────────────────
// Enrolments
// ─────────────────────────────────────────────────────────────────────────────────────

const enrollmentsSource: ReportSourceDef = {
  key: 'enrollments',
  label: 'Enrolments',
  labelBn: 'ভর্তি',
  table: 'enrollments',
  permissions: ['students.view.all', 'students.view.assigned', 'students.view.own'],
  scope: { kind: 'student', resource: SCOPED_RESOURCES.students, studentColumn: 'student_id' },
  institutionColumn: 'institution_id',
  archivedColumn: 'archived_at',
  relations: { student: studentRelation('enrollments') },
  columns: {
    // Countable, so "how many per class / per status" needs no other column selected.
    id: {
      column: 'id',
      type: 'uuid',
      label: 'Id',
      operators: ID_OPERATORS,
      aggregates: COUNT_ONLY,
    },
    studentId: { column: 'student_id', type: 'uuid', label: 'Student id', operators: ID_OPERATORS },
    ...STUDENT_RELATION_COLUMNS,
    academicYearId: {
      column: 'academic_year_id',
      type: 'uuid',
      label: 'Academic year id',
      operators: ID_OPERATORS,
      groupable: true,
      aggregates: COUNT_ONLY,
    },
    classLevelId: {
      column: 'class_level_id',
      type: 'uuid',
      label: 'Class id',
      operators: ID_OPERATORS,
      groupable: true,
      aggregates: COUNT_ONLY,
    },
    sectionId: {
      column: 'section_id',
      type: 'uuid',
      label: 'Section id',
      operators: ID_OPERATORS,
      groupable: true,
      aggregates: COUNT_ONLY,
    },
    rollNumber: {
      column: 'roll_number',
      type: 'text',
      label: 'Roll number',
      operators: TEXT_OPERATORS,
      sortable: true,
    },
    boardRegistrationNumber: {
      column: 'board_registration_number',
      type: 'text',
      label: 'Board registration number',
      operators: TEXT_OPERATORS,
    },
    status: {
      column: 'status',
      type: 'enum',
      label: 'Status',
      operators: ENUM_OPERATORS,
      sortable: true,
      groupable: true,
      aggregates: COUNT_ONLY,
      enumValues: ENROLLMENT_STATUSES,
    },
    enrolledOn: {
      column: 'enrolled_on',
      type: 'date',
      label: 'Enrolled on',
      operators: TEMPORAL_OPERATORS,
      sortable: true,
    },
    endedOn: {
      column: 'ended_on',
      type: 'date',
      label: 'Ended on',
      operators: TEMPORAL_OPERATORS,
      sortable: true,
    },
    createdAt: {
      column: 'created_at',
      type: 'timestamp',
      label: 'Created at',
      operators: TEMPORAL_OPERATORS,
      sortable: true,
    },
  },
  defaultSort: { field: 'enrolledOn', direction: 'desc' },
};

// ─────────────────────────────────────────────────────────────────────────────────────
// Attendance
// ─────────────────────────────────────────────────────────────────────────────────────

const attendanceSource: ReportSourceDef = {
  key: 'attendance',
  label: 'Student attendance',
  labelBn: 'শিক্ষার্থী উপস্থিতি',
  table: 'student_attendance',
  permissions: ['attendance.view.all', 'attendance.view.assigned', 'attendance.view.own'],
  scope: { kind: 'student', resource: SCOPED_RESOURCES.attendance, studentColumn: 'student_id' },
  institutionColumn: 'institution_id',
  archivedColumn: 'archived_at',
  relations: { student: studentRelation('student_attendance') },
  columns: {
    // Countable, so "how many per class / per status" needs no other column selected.
    id: {
      column: 'id',
      type: 'uuid',
      label: 'Id',
      operators: ID_OPERATORS,
      aggregates: COUNT_ONLY,
    },
    studentId: { column: 'student_id', type: 'uuid', label: 'Student id', operators: ID_OPERATORS },
    ...STUDENT_RELATION_COLUMNS,
    sessionId: {
      column: 'session_id',
      type: 'uuid',
      label: 'Session id',
      operators: ID_OPERATORS,
      groupable: true,
      aggregates: COUNT_ONLY,
    },
    status: {
      column: 'status',
      type: 'enum',
      label: 'Status',
      labelBn: 'অবস্থা',
      operators: ENUM_OPERATORS,
      sortable: true,
      groupable: true,
      aggregates: COUNT_ONLY,
      enumValues: ATTENDANCE_STATUSES,
    },
    minutesLate: {
      column: 'minutes_late',
      type: 'number',
      label: 'Minutes late',
      operators: NUMERIC_OPERATORS,
      sortable: true,
      aggregates: NUMERIC_AGGREGATES,
    },
    remarks: { column: 'remarks', type: 'text', label: 'Remarks', operators: TEXT_OPERATORS },
    markedAt: {
      column: 'marked_at',
      type: 'timestamp',
      label: 'Marked at',
      operators: TEMPORAL_OPERATORS,
      sortable: true,
    },
    lastCorrectedAt: {
      column: 'last_corrected_at',
      type: 'timestamp',
      label: 'Last corrected at',
      operators: TEMPORAL_OPERATORS,
      sortable: true,
    },
    createdAt: {
      column: 'created_at',
      type: 'timestamp',
      label: 'Created at',
      operators: TEMPORAL_OPERATORS,
      sortable: true,
    },
  },
  defaultSort: { field: 'createdAt', direction: 'desc' },
};

// ─────────────────────────────────────────────────────────────────────────────────────
// Exam results
// ─────────────────────────────────────────────────────────────────────────────────────

const examResultsSource: ReportSourceDef = {
  key: 'exam_results',
  label: 'Exam results',
  labelBn: 'পরীক্ষার ফলাফল',
  table: 'results',
  permissions: ['results.view.all', 'results.view.assigned', 'results.view.own'],
  scope: { kind: 'student', resource: SCOPED_RESOURCES.results, studentColumn: 'student_id' },
  institutionColumn: 'institution_id',
  archivedColumn: 'archived_at',
  // The publication rule, carried over from the exams module verbatim: a family reads a
  // result the school has stood behind, never a computed draft. Without this the reporting
  // surface would be the way around a rule the results endpoint enforces.
  ownOnly: sql`${ref('results', 'published_at')} is not null`,
  relations: { student: studentRelation('results') },
  columns: {
    // Countable, so "how many per class / per status" needs no other column selected.
    id: {
      column: 'id',
      type: 'uuid',
      label: 'Id',
      operators: ID_OPERATORS,
      aggregates: COUNT_ONLY,
    },
    examId: {
      column: 'exam_id',
      type: 'uuid',
      label: 'Exam id',
      operators: ID_OPERATORS,
      groupable: true,
      aggregates: COUNT_ONLY,
    },
    studentId: { column: 'student_id', type: 'uuid', label: 'Student id', operators: ID_OPERATORS },
    ...STUDENT_RELATION_COLUMNS,
    academicYearId: {
      column: 'academic_year_id',
      type: 'uuid',
      label: 'Academic year id',
      operators: ID_OPERATORS,
      groupable: true,
    },
    classLevelId: {
      column: 'class_level_id',
      type: 'uuid',
      label: 'Class id',
      operators: ID_OPERATORS,
      groupable: true,
      aggregates: COUNT_ONLY,
    },
    sectionId: {
      column: 'section_id',
      type: 'uuid',
      label: 'Section id',
      operators: ID_OPERATORS,
      groupable: true,
      aggregates: COUNT_ONLY,
    },
    obtainedMarks: {
      column: 'obtained_marks',
      type: 'number',
      label: 'Obtained marks',
      operators: NUMERIC_OPERATORS,
      sortable: true,
      aggregates: NUMERIC_AGGREGATES,
    },
    totalMarks: {
      column: 'total_marks',
      type: 'number',
      label: 'Total marks',
      operators: NUMERIC_OPERATORS,
      sortable: true,
      aggregates: NUMERIC_AGGREGATES,
    },
    percentage: {
      column: 'percentage',
      type: 'number',
      label: 'Percentage',
      operators: NUMERIC_OPERATORS,
      sortable: true,
      aggregates: NUMERIC_AGGREGATES,
    },
    gpa: {
      column: 'gpa',
      type: 'number',
      label: 'GPA',
      labelBn: 'জিপিএ',
      operators: NUMERIC_OPERATORS,
      sortable: true,
      aggregates: NUMERIC_AGGREGATES,
    },
    grade: {
      column: 'grade',
      type: 'text',
      label: 'Grade',
      operators: TEXT_OPERATORS,
      sortable: true,
      groupable: true,
      aggregates: COUNT_ONLY,
    },
    isPassed: {
      column: 'is_passed',
      type: 'boolean',
      label: 'Passed',
      operators: BOOLEAN_OPERATORS,
      sortable: true,
      groupable: true,
      aggregates: COUNT_ONLY,
    },
    positionInSection: {
      column: 'position_in_section',
      type: 'number',
      label: 'Position in section',
      operators: NUMERIC_OPERATORS,
      sortable: true,
      aggregates: NUMERIC_AGGREGATES,
    },
    positionInClass: {
      column: 'position_in_class',
      type: 'number',
      label: 'Position in class',
      operators: NUMERIC_OPERATORS,
      sortable: true,
      aggregates: NUMERIC_AGGREGATES,
    },
    publishedAt: {
      column: 'published_at',
      type: 'timestamp',
      label: 'Published at',
      operators: TEMPORAL_OPERATORS,
      sortable: true,
    },
  },
  defaultSort: { field: 'gpa', direction: 'desc' },
};

// ─────────────────────────────────────────────────────────────────────────────────────
// Invoices and payments
// ─────────────────────────────────────────────────────────────────────────────────────

const invoicesSource: ReportSourceDef = {
  key: 'invoices',
  label: 'Invoices',
  labelBn: 'চালান',
  table: 'invoices',
  permissions: ['finance.invoices.view', 'finance.own.view'],
  scope: { kind: 'student', resource: FINANCE_SCOPE, studentColumn: 'student_id' },
  institutionColumn: 'institution_id',
  archivedColumn: 'archived_at',
  relations: { student: studentRelation('invoices') },
  columns: {
    // Countable, so "how many per class / per status" needs no other column selected.
    id: {
      column: 'id',
      type: 'uuid',
      label: 'Id',
      operators: ID_OPERATORS,
      aggregates: COUNT_ONLY,
    },
    invoiceNumber: {
      column: 'invoice_number',
      type: 'text',
      label: 'Invoice number',
      operators: TEXT_OPERATORS,
      sortable: true,
    },
    studentId: { column: 'student_id', type: 'uuid', label: 'Student id', operators: ID_OPERATORS },
    ...STUDENT_RELATION_COLUMNS,
    academicYearId: {
      column: 'academic_year_id',
      type: 'uuid',
      label: 'Academic year id',
      operators: ID_OPERATORS,
      groupable: true,
    },
    issueDate: {
      column: 'issue_date',
      type: 'date',
      label: 'Issue date',
      operators: TEMPORAL_OPERATORS,
      sortable: true,
      groupable: true,
    },
    dueDate: {
      column: 'due_date',
      type: 'date',
      label: 'Due date',
      operators: TEMPORAL_OPERATORS,
      sortable: true,
      groupable: true,
    },
    subtotal: {
      column: 'subtotal',
      type: 'money',
      label: 'Subtotal',
      operators: NUMERIC_OPERATORS,
      sortable: true,
      aggregates: NUMERIC_AGGREGATES,
    },
    discountTotal: {
      column: 'discount_total',
      type: 'money',
      label: 'Discount total',
      operators: NUMERIC_OPERATORS,
      sortable: true,
      aggregates: NUMERIC_AGGREGATES,
    },
    fineTotal: {
      column: 'fine_total',
      type: 'money',
      label: 'Fine total',
      operators: NUMERIC_OPERATORS,
      sortable: true,
      aggregates: NUMERIC_AGGREGATES,
    },
    total: {
      column: 'total',
      type: 'money',
      label: 'Total',
      labelBn: 'মোট',
      operators: NUMERIC_OPERATORS,
      sortable: true,
      aggregates: NUMERIC_AGGREGATES,
    },
    paidTotal: {
      column: 'paid_total',
      type: 'money',
      label: 'Paid total',
      operators: NUMERIC_OPERATORS,
      sortable: true,
      aggregates: NUMERIC_AGGREGATES,
    },
    balance: {
      column: 'balance',
      type: 'money',
      label: 'Balance',
      labelBn: 'বকেয়া',
      operators: NUMERIC_OPERATORS,
      sortable: true,
      aggregates: NUMERIC_AGGREGATES,
    },
    status: {
      column: 'status',
      type: 'enum',
      label: 'Status',
      operators: ENUM_OPERATORS,
      sortable: true,
      groupable: true,
      aggregates: COUNT_ONLY,
      enumValues: INVOICE_STATUSES,
    },
    createdAt: {
      column: 'created_at',
      type: 'timestamp',
      label: 'Created at',
      operators: TEMPORAL_OPERATORS,
      sortable: true,
    },
  },
  defaultSort: { field: 'dueDate', direction: 'asc' },
};

const paymentsSource: ReportSourceDef = {
  key: 'payments',
  label: 'Payments',
  labelBn: 'পরিশোধ',
  table: 'payments',
  permissions: ['finance.invoices.view', 'finance.own.view'],
  scope: { kind: 'student', resource: FINANCE_SCOPE, studentColumn: 'student_id' },
  institutionColumn: 'institution_id',
  archivedColumn: 'archived_at',
  relations: { student: studentRelation('payments') },
  columns: {
    // Countable, so "how many per class / per status" needs no other column selected.
    id: {
      column: 'id',
      type: 'uuid',
      label: 'Id',
      operators: ID_OPERATORS,
      aggregates: COUNT_ONLY,
    },
    receiptNumber: {
      column: 'receipt_number',
      type: 'text',
      label: 'Receipt number',
      operators: TEXT_OPERATORS,
      sortable: true,
    },
    studentId: { column: 'student_id', type: 'uuid', label: 'Student id', operators: ID_OPERATORS },
    ...STUDENT_RELATION_COLUMNS,
    amount: {
      column: 'amount',
      type: 'money',
      label: 'Amount',
      labelBn: 'পরিমাণ',
      operators: NUMERIC_OPERATORS,
      sortable: true,
      aggregates: NUMERIC_AGGREGATES,
    },
    currency: {
      column: 'currency',
      type: 'text',
      label: 'Currency',
      operators: TEXT_OPERATORS,
      groupable: true,
    },
    method: {
      column: 'method',
      type: 'enum',
      label: 'Method',
      labelBn: 'মাধ্যম',
      operators: ENUM_OPERATORS,
      sortable: true,
      groupable: true,
      aggregates: COUNT_ONLY,
      enumValues: PAYMENT_METHODS,
    },
    reference: {
      column: 'reference',
      type: 'text',
      label: 'Reference',
      operators: TEXT_OPERATORS,
    },
    status: {
      column: 'status',
      type: 'enum',
      label: 'Status',
      operators: ENUM_OPERATORS,
      sortable: true,
      groupable: true,
      aggregates: COUNT_ONLY,
      enumValues: PAYMENT_STATUSES,
    },
    receivedAt: {
      column: 'received_at',
      type: 'timestamp',
      label: 'Received at',
      operators: TEMPORAL_OPERATORS,
      sortable: true,
      groupable: true,
    },
    createdAt: {
      column: 'created_at',
      type: 'timestamp',
      label: 'Created at',
      operators: TEMPORAL_OPERATORS,
      sortable: true,
    },
  },
  defaultSort: { field: 'receivedAt', direction: 'desc' },
};

// ─────────────────────────────────────────────────────────────────────────────────────
// Employees
// ─────────────────────────────────────────────────────────────────────────────────────

const SALARY_ALIAS = 'rpt_salary';

/**
 * The employee's *current* salary assignment: the one with no end date. The predicate is a
 * constant, so a caller cannot ask for a different point in history through this relation —
 * that is a payroll question, and payroll owns it.
 */
const salaryRelation: ReportRelationDef = {
  table: 'employee_salary_assignments',
  alias: SALARY_ALIAS,
  label: 'Current salary',
  on: sql`${ref(SALARY_ALIAS, 'employee_id')} = ${ref('employees', 'id')}
      and ${ref(SALARY_ALIAS, 'effective_to')} is null
      and ${ref(SALARY_ALIAS, 'archived_at')} is null`,
};

const employeesSource: ReportSourceDef = {
  key: 'employees',
  label: 'Employees',
  labelBn: 'কর্মচারী',
  table: 'employees',
  permissions: ['hr.employees.view'],
  scope: { kind: 'institution' },
  institutionColumn: 'institution_id',
  archivedColumn: 'archived_at',
  relations: { salary: salaryRelation },
  columns: {
    // Countable, so "how many per class / per status" needs no other column selected.
    id: {
      column: 'id',
      type: 'uuid',
      label: 'Id',
      operators: ID_OPERATORS,
      aggregates: COUNT_ONLY,
    },
    employeeCode: {
      column: 'employee_code',
      type: 'text',
      label: 'Employee code',
      operators: TEXT_OPERATORS,
      sortable: true,
    },
    fullNameEn: {
      column: 'full_name_en',
      type: 'text',
      label: 'Full name',
      operators: TEXT_OPERATORS,
      sortable: true,
      groupable: true,
      aggregates: COUNT_ONLY,
    },
    fullNameBn: {
      column: 'full_name_bn',
      type: 'text',
      label: 'Full name (Bangla)',
      operators: TEXT_OPERATORS,
    },
    gender: {
      column: 'gender',
      type: 'enum',
      label: 'Gender',
      operators: ENUM_OPERATORS,
      groupable: true,
      aggregates: COUNT_ONLY,
      enumValues: GENDERS,
    },
    employmentType: {
      column: 'employment_type',
      type: 'text',
      label: 'Employment type',
      operators: TEXT_OPERATORS,
      sortable: true,
      groupable: true,
      aggregates: COUNT_ONLY,
    },
    employmentStatus: {
      column: 'employment_status',
      type: 'enum',
      label: 'Employment status',
      operators: ENUM_OPERATORS,
      sortable: true,
      groupable: true,
      aggregates: COUNT_ONLY,
      enumValues: EMPLOYMENT_STATUSES,
    },
    joiningDate: {
      column: 'joining_date',
      type: 'date',
      label: 'Joining date',
      operators: TEMPORAL_OPERATORS,
      sortable: true,
      groupable: true,
    },
    departmentId: {
      column: 'department_id',
      type: 'uuid',
      label: 'Department id',
      operators: ID_OPERATORS,
      groupable: true,
      aggregates: COUNT_ONLY,
    },
    designationId: {
      column: 'designation_id',
      type: 'uuid',
      label: 'Designation id',
      operators: ID_OPERATORS,
      groupable: true,
      aggregates: COUNT_ONLY,
    },
    phone: { column: 'phone', type: 'text', label: 'Phone', operators: TEXT_OPERATORS },
    email: { column: 'email', type: 'text', label: 'Email', operators: TEXT_OPERATORS },
    createdAt: {
      column: 'created_at',
      type: 'timestamp',
      label: 'Created at',
      operators: TEMPORAL_OPERATORS,
      sortable: true,
    },

    // Payroll-adjacent columns, gated exactly as `HrService.redactSensitive` gates them.
    // `basicSalary` is the second half of the pair this mechanism exists for.
    nationalId: {
      column: 'national_id',
      type: 'text',
      label: 'National ID',
      permission: 'payroll.payslips.view.all',
      operators: TEXT_OPERATORS,
    },
    bankName: {
      column: 'bank_name',
      type: 'text',
      label: 'Bank name',
      permission: 'payroll.payslips.view.all',
      operators: TEXT_OPERATORS,
    },
    bankAccountNumber: {
      column: 'bank_account_number',
      type: 'text',
      label: 'Bank account number',
      permission: 'payroll.payslips.view.all',
      operators: TEXT_OPERATORS,
    },
    mobileBankingNumber: {
      column: 'mobile_banking_number',
      type: 'text',
      label: 'Mobile banking number',
      permission: 'payroll.payslips.view.all',
      operators: TEXT_OPERATORS,
    },
    basicSalary: {
      column: 'basic',
      relation: 'salary',
      type: 'money',
      label: 'Basic salary',
      labelBn: 'মূল বেতন',
      permission: 'payroll.payslips.view.all',
      operators: NUMERIC_OPERATORS,
      sortable: true,
      aggregates: NUMERIC_AGGREGATES,
    },
  },
  defaultSort: { field: 'employeeCode', direction: 'asc' },
};

// ─────────────────────────────────────────────────────────────────────────────────────
// Audit log
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Tenant-wide, deliberately: `audit.view` is a tenant-level permission and `audit_logs`
 * carries a nullable `institution_id` (a login has no institution). Filtering by institution
 * here would quietly hide exactly the records an investigation needs. Tenant isolation is
 * still absolute — it comes from RLS, not from this source.
 */
const auditLogsSource: ReportSourceDef = {
  key: 'audit_logs',
  label: 'Audit log',
  labelBn: 'নিরীক্ষা লগ',
  table: 'audit_logs',
  permissions: ['audit.view'],
  scope: { kind: 'institution' },
  institutionColumn: null,
  archivedColumn: null,
  relations: {},
  columns: {
    // Countable, so "how many per class / per status" needs no other column selected.
    id: {
      column: 'id',
      type: 'uuid',
      label: 'Id',
      operators: ID_OPERATORS,
      aggregates: COUNT_ONLY,
    },
    occurredAt: {
      column: 'occurred_at',
      type: 'timestamp',
      label: 'Occurred at',
      operators: TEMPORAL_OPERATORS,
      sortable: true,
      groupable: true,
    },
    action: {
      column: 'action',
      type: 'enum',
      label: 'Action',
      operators: ENUM_OPERATORS,
      sortable: true,
      groupable: true,
      aggregates: COUNT_ONLY,
      enumValues: AUDIT_ACTIONS,
    },
    module: {
      column: 'module',
      type: 'text',
      label: 'Module',
      operators: TEXT_OPERATORS,
      sortable: true,
      groupable: true,
      aggregates: COUNT_ONLY,
    },
    resourceType: {
      column: 'resource_type',
      type: 'text',
      label: 'Resource type',
      operators: TEXT_OPERATORS,
      sortable: true,
      groupable: true,
      aggregates: COUNT_ONLY,
    },
    resourceId: {
      column: 'resource_id',
      type: 'uuid',
      label: 'Resource id',
      operators: ID_OPERATORS,
    },
    resourceLabel: {
      column: 'resource_label',
      type: 'text',
      label: 'Resource label',
      operators: TEXT_OPERATORS,
    },
    actorUserId: {
      column: 'actor_user_id',
      type: 'uuid',
      label: 'Actor user id',
      operators: ID_OPERATORS,
      groupable: true,
      aggregates: COUNT_ONLY,
    },
    actorEmail: {
      column: 'actor_email',
      type: 'text',
      label: 'Actor email',
      operators: TEXT_OPERATORS,
      sortable: true,
      groupable: true,
      aggregates: COUNT_ONLY,
    },
    institutionId: {
      column: 'institution_id',
      type: 'uuid',
      label: 'Institution id',
      operators: ID_OPERATORS,
      groupable: true,
      aggregates: COUNT_ONLY,
    },
    requestId: {
      column: 'request_id',
      type: 'text',
      label: 'Request id',
      operators: TEXT_OPERATORS,
    },
    isAiInitiated: {
      column: 'is_ai_initiated',
      type: 'boolean',
      label: 'AI initiated',
      operators: BOOLEAN_OPERATORS,
      groupable: true,
      aggregates: COUNT_ONLY,
    },
  },
  defaultSort: { field: 'occurredAt', direction: 'desc' },
};

// ─────────────────────────────────────────────────────────────────────────────────────

const ALL_SOURCES: readonly ReportSourceDef[] = [
  studentsSource,
  enrollmentsSource,
  attendanceSource,
  examResultsSource,
  invoicesSource,
  paymentsSource,
  employeesSource,
  auditLogsSource,
];

const SOURCE_INDEX: ReadonlyMap<string, ReportSourceDef> = new Map(
  ALL_SOURCES.map((source) => [source.key, source]),
);

export const REPORT_SOURCE_KEYS: readonly string[] = ALL_SOURCES.map((source) => source.key);

/** Every registered source. Order is stable so the picker renders predictably. */
export function listReportSources(): readonly ReportSourceDef[] {
  return ALL_SOURCES;
}

/**
 * Look a source up by key. `undefined` for anything unregistered — the caller turns that
 * into a 422 naming the key, never a query.
 */
export function findReportSource(key: string): ReportSourceDef | undefined {
  return SOURCE_INDEX.get(key);
}
