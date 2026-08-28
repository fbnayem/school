CREATE TYPE "public"."academic_year_status" AS ENUM('planning', 'active', 'completed', 'archived');--> statement-breakpoint
CREATE TYPE "public"."audit_action" AS ENUM('create', 'update', 'archive', 'restore', 'approve', 'reject', 'publish', 'unpublish', 'login', 'logout', 'login_failed', 'password_reset', 'permission_change', 'export', 'import', 'payment', 'refund', 'ai_action', 'impersonate');--> statement-breakpoint
CREATE TYPE "public"."blood_group" AS ENUM('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-');--> statement-breakpoint
CREATE TYPE "public"."employment_status" AS ENUM('active', 'probation', 'on_leave', 'suspended', 'resigned', 'terminated', 'retired');--> statement-breakpoint
CREATE TYPE "public"."enrollment_status" AS ENUM('active', 'completed', 'promoted', 'repeated', 'transferred_out', 'withdrawn', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."gender" AS ENUM('male', 'female', 'other', 'undisclosed');--> statement-breakpoint
CREATE TYPE "public"."guardian_relation" AS ENUM('father', 'mother', 'brother', 'sister', 'uncle', 'aunt', 'grandfather', 'grandmother', 'legal_guardian', 'other');--> statement-breakpoint
CREATE TYPE "public"."institution_type" AS ENUM('school', 'college', 'school_and_college', 'madrasah', 'coaching_center', 'training_institute', 'university');--> statement-breakpoint
CREATE TYPE "public"."instruction_medium" AS ENUM('bangla', 'english_version', 'english_medium');--> statement-breakpoint
CREATE TYPE "public"."religion" AS ENUM('islam', 'hinduism', 'buddhism', 'christianity', 'other');--> statement-breakpoint
CREATE TYPE "public"."shift_kind" AS ENUM('morning', 'day', 'evening', 'single');--> statement-breakpoint
CREATE TYPE "public"."student_status" AS ENUM('active', 'on_leave', 'transferred', 'withdrawn', 'graduated', 'alumni', 'archived');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('invited', 'active', 'suspended', 'deactivated');--> statement-breakpoint
CREATE TABLE "campuses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"institution_id" uuid NOT NULL,
	"code" varchar(32) NOT NULL,
	"name_en" varchar(255) NOT NULL,
	"name_bn" varchar(255),
	"is_primary" boolean DEFAULT false NOT NULL,
	"address_line1" varchar(255),
	"district" varchar(64),
	"division" varchar(32),
	"phone" varchar(20),
	"latitude" varchar(24),
	"longitude" varchar(24),
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" varchar(500),
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "feature_flag_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"flag_key" varchar(96) NOT NULL,
	"tenant_id" uuid NOT NULL,
	"institution_id" uuid,
	"enabled" boolean NOT NULL,
	"note" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "feature_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(96) NOT NULL,
	"description" text,
	"default_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "institutions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" varchar(32) NOT NULL,
	"name_en" varchar(255) NOT NULL,
	"name_bn" varchar(255),
	"type" "institution_type" DEFAULT 'school' NOT NULL,
	"medium" "instruction_medium" DEFAULT 'bangla' NOT NULL,
	"eiin" varchar(12),
	"education_board" varchar(32),
	"established_year" integer,
	"address_line1" varchar(255),
	"address_line2" varchar(255),
	"district" varchar(64),
	"division" varchar(32),
	"postcode" varchar(10),
	"phone" varchar(20),
	"email" varchar(320),
	"website" varchar(255),
	"logo_file_id" uuid,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" varchar(500),
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(63) NOT NULL,
	"name_en" varchar(255) NOT NULL,
	"name_bn" varchar(255),
	"contact_email" varchar(320) NOT NULL,
	"contact_phone" varchar(20),
	"timezone" varchar(64) DEFAULT 'Asia/Dhaka' NOT NULL,
	"default_locale" varchar(5) DEFAULT 'en' NOT NULL,
	"currency" varchar(3) DEFAULT 'BDT' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"suspended_at" timestamp with time zone,
	"suspension_reason" varchar(500),
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" varchar(500),
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(64) NOT NULL,
	"name_en" varchar(128) NOT NULL,
	"name_bn" varchar(128),
	"description" text,
	"monthly_price" varchar(20) DEFAULT '0.00' NOT NULL,
	"max_students" integer,
	"max_institutions" integer,
	"max_staff" integer,
	"max_storage_mb" integer,
	"features" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_public" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" varchar(500)
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"status" varchar(32) DEFAULT 'trialing' NOT NULL,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone,
	"trial_ends_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"limit_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "auth_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"user_id" uuid,
	"purpose" varchar(32) NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"email" varchar(320),
	"phone" varchar(20),
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" varchar(64) NOT NULL,
	"name_en" varchar(128) NOT NULL,
	"name_bn" varchar(128),
	"description" text,
	"permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"audience" varchar(16) DEFAULT 'staff' NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"is_sensitive" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" varchar(500),
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"user_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"family_id" uuid NOT NULL,
	"rotation_count" integer DEFAULT 0 NOT NULL,
	"user_agent" varchar(512),
	"ip_address" "inet",
	"device_label" varchar(128),
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"institution_id" uuid,
	"campus_id" uuid,
	"valid_from" timestamp with time zone,
	"valid_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"email" varchar(320) NOT NULL,
	"phone" varchar(20),
	"password_hash" text,
	"full_name_en" varchar(255) NOT NULL,
	"full_name_bn" varchar(255),
	"avatar_file_id" uuid,
	"locale" varchar(5) DEFAULT 'en' NOT NULL,
	"status" "user_status" DEFAULT 'invited' NOT NULL,
	"email_verified_at" timestamp with time zone,
	"phone_verified_at" timestamp with time zone,
	"is_platform_admin" boolean DEFAULT false NOT NULL,
	"mfa_enabled" boolean DEFAULT false NOT NULL,
	"mfa_secret" text,
	"mfa_recovery_codes" jsonb,
	"last_login_at" timestamp with time zone,
	"last_login_ip" "inet",
	"failed_login_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"credentials_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"must_change_password" boolean DEFAULT false NOT NULL,
	"preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" varchar(500),
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"institution_id" uuid,
	"campus_id" uuid,
	"actor_user_id" uuid,
	"actor_email" varchar(320),
	"actor_roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"impersonator_user_id" uuid,
	"action" "audit_action" NOT NULL,
	"module" varchar(64) NOT NULL,
	"resource_type" varchar(64) NOT NULL,
	"resource_id" uuid,
	"resource_label" varchar(255),
	"previous_value" jsonb,
	"new_value" jsonb,
	"reason" text,
	"request_id" varchar(64),
	"ip_address" "inet",
	"user_agent" varchar(512),
	"is_ai_initiated" boolean DEFAULT false NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"user_id" uuid,
	"attempted_identifier" varchar(320),
	"event_type" varchar(48) NOT NULL,
	"severity" varchar(16) DEFAULT 'info' NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"request_id" varchar(64),
	"ip_address" "inet",
	"user_agent" varchar(512),
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"institution_id" uuid,
	"storage_key" varchar(512) NOT NULL,
	"storage_driver" varchar(16) DEFAULT 'local' NOT NULL,
	"original_filename" varchar(255) NOT NULL,
	"mime_type" varchar(128) NOT NULL,
	"size_bytes" bigint NOT NULL,
	"checksum" varchar(64) NOT NULL,
	"category" varchar(48) NOT NULL,
	"owner_type" varchar(48),
	"owner_id" uuid,
	"is_sensitive" boolean DEFAULT false NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"uploaded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" varchar(500),
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "academic_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"institution_id" uuid NOT NULL,
	"code" varchar(16) NOT NULL,
	"name_en" varchar(64) NOT NULL,
	"name_bn" varchar(64),
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" varchar(500),
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "academic_years" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"institution_id" uuid NOT NULL,
	"name" varchar(32) NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"status" "academic_year_status" DEFAULT 'planning' NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	"weekend_days" jsonb DEFAULT '[5, 6]'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" varchar(500),
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "calendar_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"institution_id" uuid NOT NULL,
	"academic_year_id" uuid NOT NULL,
	"campus_id" uuid,
	"title_en" varchar(255) NOT NULL,
	"title_bn" varchar(255),
	"description" text,
	"kind" varchar(24) DEFAULT 'event' NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"is_non_teaching" boolean DEFAULT false NOT NULL,
	"overrides_weekend" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" varchar(500),
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "class_levels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"institution_id" uuid NOT NULL,
	"code" varchar(16) NOT NULL,
	"name_en" varchar(64) NOT NULL,
	"name_bn" varchar(64),
	"ordinal" smallint NOT NULL,
	"has_groups" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" varchar(500),
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "class_subjects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"institution_id" uuid NOT NULL,
	"academic_year_id" uuid NOT NULL,
	"class_level_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"group_id" uuid,
	"periods_per_week" smallint DEFAULT 0 NOT NULL,
	"full_marks" smallint DEFAULT 100 NOT NULL,
	"pass_marks" smallint DEFAULT 33 NOT NULL,
	"mark_distribution" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_optional" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" varchar(500),
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"institution_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"name_en" varchar(64) NOT NULL,
	"name_bn" varchar(64),
	"sequence" smallint NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"is_break" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" varchar(500)
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"institution_id" uuid NOT NULL,
	"campus_id" uuid NOT NULL,
	"code" varchar(32) NOT NULL,
	"name_en" varchar(128) NOT NULL,
	"kind" varchar(24) DEFAULT 'classroom' NOT NULL,
	"capacity" smallint,
	"floor" varchar(16),
	"building" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" varchar(500),
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"institution_id" uuid NOT NULL,
	"campus_id" uuid NOT NULL,
	"academic_year_id" uuid NOT NULL,
	"class_level_id" uuid NOT NULL,
	"shift_id" uuid,
	"group_id" uuid,
	"name_en" varchar(64) NOT NULL,
	"name_bn" varchar(64),
	"capacity" smallint,
	"room_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" varchar(500),
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "shifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"institution_id" uuid NOT NULL,
	"campus_id" uuid,
	"kind" "shift_kind" DEFAULT 'single' NOT NULL,
	"name_en" varchar(64) NOT NULL,
	"name_bn" varchar(64),
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" varchar(500),
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "subjects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"institution_id" uuid NOT NULL,
	"code" varchar(16) NOT NULL,
	"name_en" varchar(128) NOT NULL,
	"name_bn" varchar(128),
	"short_name" varchar(16),
	"kind" varchar(16) DEFAULT 'compulsory' NOT NULL,
	"is_fourth_subject" boolean DEFAULT false NOT NULL,
	"exclude_from_gpa" boolean DEFAULT false NOT NULL,
	"has_practical" boolean DEFAULT false NOT NULL,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" varchar(500),
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "terms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"institution_id" uuid NOT NULL,
	"academic_year_id" uuid NOT NULL,
	"name_en" varchar(64) NOT NULL,
	"name_bn" varchar(64),
	"sequence" smallint NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"weight_basis_points" integer DEFAULT 0 NOT NULL,
	"is_closed" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" varchar(500),
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "departments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"institution_id" uuid NOT NULL,
	"code" varchar(32) NOT NULL,
	"name_en" varchar(128) NOT NULL,
	"name_bn" varchar(128),
	"head_employee_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" varchar(500),
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "designations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"institution_id" uuid NOT NULL,
	"code" varchar(32) NOT NULL,
	"name_en" varchar(128) NOT NULL,
	"name_bn" varchar(128),
	"rank" smallint DEFAULT 0 NOT NULL,
	"is_teaching" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" varchar(500),
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "employee_section_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"institution_id" uuid NOT NULL,
	"academic_year_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"role" varchar(32) DEFAULT 'class_teacher' NOT NULL,
	"effective_from" date,
	"effective_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" varchar(500),
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "employee_subject_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"institution_id" uuid NOT NULL,
	"academic_year_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"class_subject_id" uuid,
	"is_primary" boolean DEFAULT true NOT NULL,
	"effective_from" date,
	"effective_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" varchar(500),
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "employees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"institution_id" uuid NOT NULL,
	"campus_id" uuid,
	"user_id" uuid,
	"employee_code" varchar(32) NOT NULL,
	"full_name_en" varchar(255) NOT NULL,
	"full_name_bn" varchar(255),
	"father_name_en" varchar(255),
	"mother_name_en" varchar(255),
	"date_of_birth" date,
	"gender" "gender",
	"blood_group" "blood_group",
	"religion" "religion",
	"marital_status" varchar(16),
	"national_id" varchar(20),
	"email" varchar(320),
	"phone" varchar(20) NOT NULL,
	"alternate_phone" varchar(20),
	"present_address" text,
	"permanent_address" text,
	"emergency_contact_name" varchar(255),
	"emergency_contact_phone" varchar(20),
	"department_id" uuid,
	"designation_id" uuid,
	"employment_type" varchar(24) DEFAULT 'permanent' NOT NULL,
	"employment_status" "employment_status" DEFAULT 'active' NOT NULL,
	"joining_date" date NOT NULL,
	"confirmation_date" date,
	"resignation_date" date,
	"last_working_date" date,
	"photo_file_id" uuid,
	"qualification_summary" varchar(255),
	"specialization" varchar(255),
	"bank_name" varchar(128),
	"bank_account_number" varchar(34),
	"bank_branch" varchar(128),
	"mobile_banking_provider" varchar(24),
	"mobile_banking_number" varchar(20),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" varchar(500),
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"institution_id" uuid NOT NULL,
	"campus_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"academic_year_id" uuid NOT NULL,
	"class_level_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"shift_id" uuid,
	"group_id" uuid,
	"roll_number" varchar(16) NOT NULL,
	"board_registration_number" varchar(32),
	"status" "enrollment_status" DEFAULT 'active' NOT NULL,
	"enrolled_on" date NOT NULL,
	"ended_on" date,
	"end_reason" varchar(255),
	"promoted_from_enrollment_id" uuid,
	"is_repeating" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" varchar(500),
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "guardians" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"institution_id" uuid NOT NULL,
	"user_id" uuid,
	"full_name_en" varchar(255) NOT NULL,
	"full_name_bn" varchar(255),
	"phone" varchar(20) NOT NULL,
	"alternate_phone" varchar(20),
	"email" varchar(320),
	"national_id" varchar(20),
	"occupation" varchar(128),
	"employer" varchar(255),
	"income_band" varchar(32),
	"education_level" varchar(64),
	"address" text,
	"photo_file_id" uuid,
	"preferred_channel" varchar(16) DEFAULT 'sms' NOT NULL,
	"preferred_locale" varchar(5) DEFAULT 'bn' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" varchar(500),
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "student_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"institution_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"document_type" varchar(48) NOT NULL,
	"title" varchar(255) NOT NULL,
	"document_number" varchar(64),
	"issued_on" date,
	"expires_on" date,
	"verified_at" timestamp with time zone,
	"verified_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" varchar(500),
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "student_guardians" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"institution_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"guardian_id" uuid NOT NULL,
	"relation" "guardian_relation" NOT NULL,
	"relation_other" varchar(64),
	"is_primary" boolean DEFAULT false NOT NULL,
	"is_billing_contact" boolean DEFAULT false NOT NULL,
	"is_emergency_contact" boolean DEFAULT false NOT NULL,
	"can_access_portal" boolean DEFAULT true NOT NULL,
	"has_custody" boolean DEFAULT true NOT NULL,
	"notes" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" varchar(500),
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "student_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"institution_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"enrollment_id" uuid,
	"event" varchar(32) NOT NULL,
	"from_status" "student_status",
	"to_status" "student_status" NOT NULL,
	"effective_date" date NOT NULL,
	"reason" text,
	"approved_by_employee_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "students" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"institution_id" uuid NOT NULL,
	"user_id" uuid,
	"student_code" varchar(32) NOT NULL,
	"admission_number" varchar(32) NOT NULL,
	"admission_date" date NOT NULL,
	"full_name_en" varchar(255) NOT NULL,
	"full_name_bn" varchar(255),
	"nickname" varchar(64),
	"date_of_birth" date NOT NULL,
	"gender" "gender" NOT NULL,
	"blood_group" "blood_group",
	"religion" "religion",
	"nationality" varchar(64) DEFAULT 'Bangladeshi' NOT NULL,
	"birth_registration_number" varchar(20),
	"national_id" varchar(20),
	"father_name_en" varchar(255),
	"father_name_bn" varchar(255),
	"mother_name_en" varchar(255),
	"mother_name_bn" varchar(255),
	"phone" varchar(20),
	"email" varchar(320),
	"present_address" text,
	"permanent_address" text,
	"district" varchar(64),
	"division" varchar(32),
	"photo_file_id" uuid,
	"previous_institution_name" varchar(255),
	"previous_class_completed" varchar(64),
	"transfer_certificate_number" varchar(64),
	"medical_conditions" text,
	"allergies" text,
	"special_needs" text,
	"emergency_medical_note" text,
	"status" "student_status" DEFAULT 'active' NOT NULL,
	"status_changed_at" timestamp with time zone,
	"status_reason" varchar(500),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" varchar(500),
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
ALTER TABLE "campuses" ADD CONSTRAINT "campuses_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campuses" ADD CONSTRAINT "campuses_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_flag_overrides" ADD CONSTRAINT "feature_flag_overrides_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_flag_overrides" ADD CONSTRAINT "feature_flag_overrides_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institutions" ADD CONSTRAINT "institutions_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_campus_id_campuses_id_fk" FOREIGN KEY ("campus_id") REFERENCES "public"."campuses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_groups" ADD CONSTRAINT "academic_groups_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_groups" ADD CONSTRAINT "academic_groups_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_years" ADD CONSTRAINT "academic_years_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_years" ADD CONSTRAINT "academic_years_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_academic_year_id_academic_years_id_fk" FOREIGN KEY ("academic_year_id") REFERENCES "public"."academic_years"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_campus_id_campuses_id_fk" FOREIGN KEY ("campus_id") REFERENCES "public"."campuses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_levels" ADD CONSTRAINT "class_levels_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_levels" ADD CONSTRAINT "class_levels_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_subjects" ADD CONSTRAINT "class_subjects_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_subjects" ADD CONSTRAINT "class_subjects_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_subjects" ADD CONSTRAINT "class_subjects_academic_year_id_academic_years_id_fk" FOREIGN KEY ("academic_year_id") REFERENCES "public"."academic_years"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_subjects" ADD CONSTRAINT "class_subjects_class_level_id_class_levels_id_fk" FOREIGN KEY ("class_level_id") REFERENCES "public"."class_levels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_subjects" ADD CONSTRAINT "class_subjects_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_subjects" ADD CONSTRAINT "class_subjects_group_id_academic_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."academic_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "periods" ADD CONSTRAINT "periods_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "periods" ADD CONSTRAINT "periods_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "periods" ADD CONSTRAINT "periods_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_campus_id_campuses_id_fk" FOREIGN KEY ("campus_id") REFERENCES "public"."campuses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sections" ADD CONSTRAINT "sections_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sections" ADD CONSTRAINT "sections_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sections" ADD CONSTRAINT "sections_campus_id_campuses_id_fk" FOREIGN KEY ("campus_id") REFERENCES "public"."campuses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sections" ADD CONSTRAINT "sections_academic_year_id_academic_years_id_fk" FOREIGN KEY ("academic_year_id") REFERENCES "public"."academic_years"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sections" ADD CONSTRAINT "sections_class_level_id_class_levels_id_fk" FOREIGN KEY ("class_level_id") REFERENCES "public"."class_levels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sections" ADD CONSTRAINT "sections_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sections" ADD CONSTRAINT "sections_group_id_academic_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."academic_groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_campus_id_campuses_id_fk" FOREIGN KEY ("campus_id") REFERENCES "public"."campuses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subjects" ADD CONSTRAINT "subjects_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subjects" ADD CONSTRAINT "subjects_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terms" ADD CONSTRAINT "terms_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terms" ADD CONSTRAINT "terms_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terms" ADD CONSTRAINT "terms_academic_year_id_academic_years_id_fk" FOREIGN KEY ("academic_year_id") REFERENCES "public"."academic_years"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "designations" ADD CONSTRAINT "designations_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "designations" ADD CONSTRAINT "designations_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_section_assignments" ADD CONSTRAINT "employee_section_assignments_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_section_assignments" ADD CONSTRAINT "employee_section_assignments_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_section_assignments" ADD CONSTRAINT "employee_section_assignments_academic_year_id_academic_years_id_fk" FOREIGN KEY ("academic_year_id") REFERENCES "public"."academic_years"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_section_assignments" ADD CONSTRAINT "employee_section_assignments_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_section_assignments" ADD CONSTRAINT "employee_section_assignments_section_id_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_subject_assignments" ADD CONSTRAINT "employee_subject_assignments_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_subject_assignments" ADD CONSTRAINT "employee_subject_assignments_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_subject_assignments" ADD CONSTRAINT "employee_subject_assignments_academic_year_id_academic_years_id_fk" FOREIGN KEY ("academic_year_id") REFERENCES "public"."academic_years"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_subject_assignments" ADD CONSTRAINT "employee_subject_assignments_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_subject_assignments" ADD CONSTRAINT "employee_subject_assignments_section_id_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_subject_assignments" ADD CONSTRAINT "employee_subject_assignments_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_subject_assignments" ADD CONSTRAINT "employee_subject_assignments_class_subject_id_class_subjects_id_fk" FOREIGN KEY ("class_subject_id") REFERENCES "public"."class_subjects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_campus_id_campuses_id_fk" FOREIGN KEY ("campus_id") REFERENCES "public"."campuses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_designation_id_designations_id_fk" FOREIGN KEY ("designation_id") REFERENCES "public"."designations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_campus_id_campuses_id_fk" FOREIGN KEY ("campus_id") REFERENCES "public"."campuses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_academic_year_id_academic_years_id_fk" FOREIGN KEY ("academic_year_id") REFERENCES "public"."academic_years"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_class_level_id_class_levels_id_fk" FOREIGN KEY ("class_level_id") REFERENCES "public"."class_levels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_section_id_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."sections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_group_id_academic_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."academic_groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardians" ADD CONSTRAINT "guardians_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardians" ADD CONSTRAINT "guardians_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardians" ADD CONSTRAINT "guardians_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_documents" ADD CONSTRAINT "student_documents_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_documents" ADD CONSTRAINT "student_documents_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_documents" ADD CONSTRAINT "student_documents_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_guardians" ADD CONSTRAINT "student_guardians_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_guardians" ADD CONSTRAINT "student_guardians_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_guardians" ADD CONSTRAINT "student_guardians_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_guardians" ADD CONSTRAINT "student_guardians_guardian_id_guardians_id_fk" FOREIGN KEY ("guardian_id") REFERENCES "public"."guardians"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_status_history" ADD CONSTRAINT "student_status_history_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_status_history" ADD CONSTRAINT "student_status_history_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_status_history" ADD CONSTRAINT "student_status_history_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_status_history" ADD CONSTRAINT "student_status_history_enrollment_id_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_status_history" ADD CONSTRAINT "student_status_history_approved_by_employee_id_employees_id_fk" FOREIGN KEY ("approved_by_employee_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "students" ADD CONSTRAINT "students_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "students" ADD CONSTRAINT "students_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "students" ADD CONSTRAINT "students_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "campuses_institution_code_key" ON "campuses" USING btree ("institution_id","code") WHERE "campuses"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "campuses_primary_key" ON "campuses" USING btree ("institution_id") WHERE "campuses"."is_primary" AND "campuses"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "campuses_tenant_idx" ON "campuses" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "campuses_institution_idx" ON "campuses" USING btree ("institution_id");--> statement-breakpoint
CREATE UNIQUE INDEX "feature_flag_overrides_scope_key" ON "feature_flag_overrides" USING btree ("flag_key","tenant_id","institution_id") WHERE "feature_flag_overrides"."institution_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "feature_flag_overrides_tenant_key" ON "feature_flag_overrides" USING btree ("flag_key","tenant_id") WHERE "feature_flag_overrides"."institution_id" IS NULL;--> statement-breakpoint
CREATE INDEX "feature_flag_overrides_tenant_idx" ON "feature_flag_overrides" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "feature_flags_key_key" ON "feature_flags" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "institutions_tenant_code_key" ON "institutions" USING btree ("tenant_id","code") WHERE "institutions"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "institutions_tenant_idx" ON "institutions" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "institutions_eiin_key" ON "institutions" USING btree ("eiin") WHERE "institutions"."eiin" IS NOT NULL AND "institutions"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations" USING btree ("slug") WHERE "organizations"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "organizations_active_idx" ON "organizations" USING btree ("is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "plans_key_key" ON "plans" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_tenant_active_key" ON "subscriptions" USING btree ("tenant_id") WHERE "subscriptions"."status" IN ('trialing', 'active', 'past_due');--> statement-breakpoint
CREATE INDEX "subscriptions_tenant_idx" ON "subscriptions" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_tokens_hash_key" ON "auth_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "auth_tokens_user_purpose_idx" ON "auth_tokens" USING btree ("user_id","purpose");--> statement-breakpoint
CREATE INDEX "auth_tokens_expiry_idx" ON "auth_tokens" USING btree ("expires_at") WHERE "auth_tokens"."used_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "roles_tenant_key_key" ON "roles" USING btree ("tenant_id","key") WHERE "roles"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "roles_tenant_idx" ON "roles" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_family_idx" ON "sessions" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "sessions_expiry_idx" ON "sessions" USING btree ("expires_at") WHERE "sessions"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "user_roles_unique_scope_key" ON "user_roles" USING btree ("user_id","role_id","institution_id","campus_id") WHERE "user_roles"."institution_id" IS NOT NULL AND "user_roles"."campus_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "user_roles_unique_institution_key" ON "user_roles" USING btree ("user_id","role_id","institution_id") WHERE "user_roles"."institution_id" IS NOT NULL AND "user_roles"."campus_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "user_roles_unique_tenant_key" ON "user_roles" USING btree ("user_id","role_id") WHERE "user_roles"."institution_id" IS NULL;--> statement-breakpoint
CREATE INDEX "user_roles_user_idx" ON "user_roles" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_roles_tenant_idx" ON "user_roles" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_tenant_email_key" ON "users" USING btree ("tenant_id","email") WHERE "users"."archived_at" IS NULL AND "users"."tenant_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "users_platform_email_key" ON "users" USING btree ("email") WHERE "users"."archived_at" IS NULL AND "users"."tenant_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "users_tenant_phone_key" ON "users" USING btree ("tenant_id","phone") WHERE "users"."phone" IS NOT NULL AND "users"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "users_tenant_idx" ON "users" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "users_status_idx" ON "users" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "audit_logs_tenant_occurred_idx" ON "audit_logs" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_logs_resource_idx" ON "audit_logs" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "audit_logs_actor_idx" ON "audit_logs" USING btree ("actor_user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_logs_module_idx" ON "audit_logs" USING btree ("tenant_id","module","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_logs_request_idx" ON "audit_logs" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "security_events_type_occurred_idx" ON "security_events" USING btree ("event_type","occurred_at");--> statement-breakpoint
CREATE INDEX "security_events_identifier_idx" ON "security_events" USING btree ("attempted_identifier","occurred_at");--> statement-breakpoint
CREATE INDEX "security_events_ip_idx" ON "security_events" USING btree ("ip_address","occurred_at");--> statement-breakpoint
CREATE INDEX "security_events_user_idx" ON "security_events" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "security_events_severity_idx" ON "security_events" USING btree ("severity","occurred_at") WHERE "security_events"."severity" IN ('warning', 'critical');--> statement-breakpoint
CREATE UNIQUE INDEX "files_storage_key_key" ON "files" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "files_tenant_idx" ON "files" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "files_owner_idx" ON "files" USING btree ("owner_type","owner_id");--> statement-breakpoint
CREATE INDEX "files_checksum_idx" ON "files" USING btree ("tenant_id","checksum");--> statement-breakpoint
CREATE INDEX "files_pending_idx" ON "files" USING btree ("created_at") WHERE "files"."uploaded_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "academic_groups_institution_code_key" ON "academic_groups" USING btree ("institution_id","code") WHERE "academic_groups"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "academic_groups_tenant_idx" ON "academic_groups" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "academic_years_institution_name_key" ON "academic_years" USING btree ("institution_id","name") WHERE "academic_years"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "academic_years_current_key" ON "academic_years" USING btree ("institution_id") WHERE "academic_years"."is_current" AND "academic_years"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "academic_years_tenant_idx" ON "academic_years" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "academic_years_institution_idx" ON "academic_years" USING btree ("institution_id");--> statement-breakpoint
CREATE INDEX "calendar_events_lookup_idx" ON "calendar_events" USING btree ("academic_year_id","start_date","end_date");--> statement-breakpoint
CREATE INDEX "calendar_events_tenant_idx" ON "calendar_events" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "class_levels_institution_code_key" ON "class_levels" USING btree ("institution_id","code") WHERE "class_levels"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "class_levels_institution_ordinal_key" ON "class_levels" USING btree ("institution_id","ordinal") WHERE "class_levels"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "class_levels_tenant_idx" ON "class_levels" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "class_subjects_unique_key" ON "class_subjects" USING btree ("academic_year_id","class_level_id","subject_id","group_id") WHERE "class_subjects"."group_id" IS NOT NULL AND "class_subjects"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "class_subjects_unique_nogroup_key" ON "class_subjects" USING btree ("academic_year_id","class_level_id","subject_id") WHERE "class_subjects"."group_id" IS NULL AND "class_subjects"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "class_subjects_tenant_idx" ON "class_subjects" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "class_subjects_lookup_idx" ON "class_subjects" USING btree ("academic_year_id","class_level_id");--> statement-breakpoint
CREATE UNIQUE INDEX "periods_shift_sequence_key" ON "periods" USING btree ("shift_id","sequence") WHERE "periods"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "periods_tenant_idx" ON "periods" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rooms_campus_code_key" ON "rooms" USING btree ("campus_id","code") WHERE "rooms"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "rooms_tenant_idx" ON "rooms" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sections_unique_key" ON "sections" USING btree ("academic_year_id","class_level_id","shift_id","name_en") WHERE "sections"."archived_at" IS NULL AND "sections"."shift_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "sections_unique_no_shift_key" ON "sections" USING btree ("academic_year_id","class_level_id","name_en") WHERE "sections"."archived_at" IS NULL AND "sections"."shift_id" IS NULL;--> statement-breakpoint
CREATE INDEX "sections_tenant_idx" ON "sections" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "sections_year_class_idx" ON "sections" USING btree ("academic_year_id","class_level_id");--> statement-breakpoint
CREATE INDEX "sections_campus_idx" ON "sections" USING btree ("campus_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shifts_institution_name_key" ON "shifts" USING btree ("institution_id","name_en") WHERE "shifts"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "shifts_tenant_idx" ON "shifts" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subjects_institution_code_key" ON "subjects" USING btree ("institution_id","code") WHERE "subjects"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "subjects_tenant_idx" ON "subjects" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "terms_year_sequence_key" ON "terms" USING btree ("academic_year_id","sequence") WHERE "terms"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "terms_tenant_idx" ON "terms" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "terms_year_idx" ON "terms" USING btree ("academic_year_id");--> statement-breakpoint
CREATE UNIQUE INDEX "departments_institution_code_key" ON "departments" USING btree ("institution_id","code") WHERE "departments"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "departments_tenant_idx" ON "departments" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "designations_institution_code_key" ON "designations" USING btree ("institution_id","code") WHERE "designations"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "designations_tenant_idx" ON "designations" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "employee_section_primary_key" ON "employee_section_assignments" USING btree ("section_id","academic_year_id") WHERE "employee_section_assignments"."role" = 'class_teacher' AND "employee_section_assignments"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "employee_section_unique_key" ON "employee_section_assignments" USING btree ("employee_id","section_id","role") WHERE "employee_section_assignments"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "employee_section_employee_idx" ON "employee_section_assignments" USING btree ("employee_id","academic_year_id");--> statement-breakpoint
CREATE INDEX "employee_section_section_idx" ON "employee_section_assignments" USING btree ("section_id");--> statement-breakpoint
CREATE INDEX "employee_section_tenant_idx" ON "employee_section_assignments" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "employee_subject_unique_key" ON "employee_subject_assignments" USING btree ("employee_id","section_id","subject_id") WHERE "employee_subject_assignments"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "employee_subject_primary_key" ON "employee_subject_assignments" USING btree ("section_id","subject_id") WHERE "employee_subject_assignments"."is_primary" AND "employee_subject_assignments"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "employee_subject_employee_idx" ON "employee_subject_assignments" USING btree ("employee_id","academic_year_id");--> statement-breakpoint
CREATE INDEX "employee_subject_section_idx" ON "employee_subject_assignments" USING btree ("section_id","subject_id");--> statement-breakpoint
CREATE INDEX "employee_subject_tenant_idx" ON "employee_subject_assignments" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "employees_institution_code_key" ON "employees" USING btree ("institution_id","employee_code") WHERE "employees"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "employees_user_key" ON "employees" USING btree ("user_id") WHERE "employees"."user_id" IS NOT NULL AND "employees"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "employees_nid_key" ON "employees" USING btree ("institution_id","national_id") WHERE "employees"."national_id" IS NOT NULL AND "employees"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "employees_tenant_idx" ON "employees" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "employees_institution_status_idx" ON "employees" USING btree ("institution_id","employment_status");--> statement-breakpoint
CREATE INDEX "employees_department_idx" ON "employees" USING btree ("department_id");--> statement-breakpoint
CREATE INDEX "employees_phone_idx" ON "employees" USING btree ("tenant_id","phone");--> statement-breakpoint
CREATE UNIQUE INDEX "enrollments_student_year_key" ON "enrollments" USING btree ("student_id","academic_year_id") WHERE "enrollments"."status" <> 'cancelled' AND "enrollments"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "enrollments_section_roll_key" ON "enrollments" USING btree ("section_id","roll_number") WHERE "enrollments"."status" <> 'cancelled' AND "enrollments"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "enrollments_tenant_idx" ON "enrollments" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "enrollments_section_idx" ON "enrollments" USING btree ("section_id","status");--> statement-breakpoint
CREATE INDEX "enrollments_student_idx" ON "enrollments" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "enrollments_year_class_idx" ON "enrollments" USING btree ("academic_year_id","class_level_id");--> statement-breakpoint
CREATE UNIQUE INDEX "guardians_institution_phone_key" ON "guardians" USING btree ("institution_id","phone") WHERE "guardians"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "guardians_user_key" ON "guardians" USING btree ("user_id") WHERE "guardians"."user_id" IS NOT NULL AND "guardians"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "guardians_tenant_idx" ON "guardians" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "guardians_nid_idx" ON "guardians" USING btree ("institution_id","national_id");--> statement-breakpoint
CREATE INDEX "student_documents_student_idx" ON "student_documents" USING btree ("student_id","document_type");--> statement-breakpoint
CREATE INDEX "student_documents_tenant_idx" ON "student_documents" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "student_guardians_unique_key" ON "student_guardians" USING btree ("student_id","guardian_id") WHERE "student_guardians"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "student_guardians_primary_key" ON "student_guardians" USING btree ("student_id") WHERE "student_guardians"."is_primary" AND "student_guardians"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "student_guardians_billing_key" ON "student_guardians" USING btree ("student_id") WHERE "student_guardians"."is_billing_contact" AND "student_guardians"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "student_guardians_student_idx" ON "student_guardians" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "student_guardians_guardian_idx" ON "student_guardians" USING btree ("guardian_id") WHERE "student_guardians"."can_access_portal" AND "student_guardians"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "student_guardians_tenant_idx" ON "student_guardians" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "student_status_history_student_idx" ON "student_status_history" USING btree ("student_id","effective_date");--> statement-breakpoint
CREATE INDEX "student_status_history_tenant_idx" ON "student_status_history" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "students_institution_code_key" ON "students" USING btree ("institution_id","student_code") WHERE "students"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "students_institution_admission_key" ON "students" USING btree ("institution_id","admission_number") WHERE "students"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "students_brn_key" ON "students" USING btree ("institution_id","birth_registration_number") WHERE "students"."birth_registration_number" IS NOT NULL AND "students"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "students_user_key" ON "students" USING btree ("user_id") WHERE "students"."user_id" IS NOT NULL AND "students"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "students_tenant_idx" ON "students" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "students_institution_status_idx" ON "students" USING btree ("institution_id","status");--> statement-breakpoint
CREATE INDEX "students_dedupe_idx" ON "students" USING btree ("institution_id","full_name_en","date_of_birth");--> statement-breakpoint
CREATE INDEX "students_phone_idx" ON "students" USING btree ("tenant_id","phone");