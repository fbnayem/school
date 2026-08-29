-- =====================================================================================
-- 0028 — Document and certificate generation (Phase 23)
--
-- Four tenant-scoped tables. This module renders official paper from data other modules
-- own; it stores no copy of a student, an employee or a guardian. What it does store is a
-- promise, and the promises are kept by the database rather than by service convention:
--
--   1. **An issued document is immutable.** `rendered_html` and `data_snapshot` freeze at
--      issue time. `issued_documents_immutable` refuses DELETE outright and refuses every
--      UPDATE except the single legal transition — revocation, which sets `revoked_at`,
--      `revoked_by` and `revoked_reason` and changes nothing else. Reissuing after the
--      underlying record changes creates a NEW row with a NEW serial.
--   2. **An active template is immutable.** `document_templates_immutable` allows a row to
--      be deactivated or archived and nothing else, so "edit" can only mean "supersede with
--      version + 1" — and documents already issued keep the edition they were printed from.
--   3. **Four eyes on an approval.** `document_requests_approver_not_requester` is a check
--      constraint: a row whose `approved_by` equals its `requested_by` cannot exist, however
--      many permissions the writer holds. `document_requests_guard_mutation` additionally
--      refuses the move to `issued` when the template requires approval and no distinct
--      approver has signed.
--   4. **Verification is append-only.** `document_verifications_append_only` refuses UPDATE
--      and DELETE, for the same reason `audit_logs` does (0005).
--
-- Serial numbers and verification codes are generated in the application from
-- `@shikkha/shared`'s CSPRNG helpers. The verification code carries a global unique index as
-- well as a per-institution one: the public verification endpoint receives a code and no
-- tenant, so an ambiguous code would be a correctness bug, not merely bad luck.
--
-- RLS is enabled, forced and given the standard `tenant_isolation` policy for every table,
-- and `assert_rls_coverage()` runs last so a mistake fails the migration rather than
-- shipping a silently-disabled control.
-- =====================================================================================

-- -------------------------------------------------------------------------------------
-- Enumerations. Closed sets only: a new document kind, page size or request status changes
-- the renderer and the state machine as well as the schema. The wording of a certificate,
-- its letterhead and its variable list are template rows, not enum values.
-- -------------------------------------------------------------------------------------

create type public.document_kind as enum (
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
  'custom'
);

create type public.document_page_size as enum ('a4', 'a5', 'letter');

create type public.document_orientation as enum ('portrait', 'landscape');

create type public.document_subject_kind as enum ('student', 'employee', 'guardian');

create type public.document_request_status as enum (
  'draft', 'pending_approval', 'approved', 'rejected', 'issued', 'revoked'
);

create type public.document_verification_channel as enum (
  'public_web', 'qr_scan', 'staff_portal'
);

-- -------------------------------------------------------------------------------------
-- Tables
-- -------------------------------------------------------------------------------------

create table public.document_templates (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  key varchar(64) not null,
  name varchar(128) not null,
  name_bn varchar(128),
  kind public.document_kind not null,
  body_html text not null,
  page_size public.document_page_size default 'a4' not null,
  orientation public.document_orientation default 'portrait' not null,
  margins jsonb default '{"top":20,"right":18,"bottom":20,"left":18}'::jsonb not null,
  header_html text,
  footer_html text,
  variables jsonb default '[]'::jsonb not null,
  requires_approval boolean default false not null,
  version integer default 1 not null,
  is_active boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.document_requests (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  template_id uuid not null,
  template_version integer not null,
  subject_kind public.document_subject_kind not null,
  subject_id uuid not null,
  requested_by uuid not null,
  purpose varchar(500) not null,
  status public.document_request_status default 'draft' not null,
  approved_by uuid,
  approved_at timestamp with time zone,
  rejection_reason varchar(1000),
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.issued_documents (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  request_id uuid,
  template_id uuid not null,
  template_version integer not null,
  subject_kind public.document_subject_kind not null,
  subject_id uuid not null,
  serial_number varchar(48) not null,
  issued_on date not null,
  issued_by uuid not null,
  rendered_html text not null,
  storage_key varchar(512),
  data_snapshot jsonb default '{}'::jsonb not null,
  verification_code varchar(32) not null,
  revoked_at timestamp with time zone,
  revoked_by uuid,
  revoked_reason varchar(1000),
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.document_verifications (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  issued_document_id uuid not null,
  verified_at timestamp with time zone default now() not null,
  verifier_ip varchar(64),
  channel public.document_verification_channel default 'public_web' not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

-- -------------------------------------------------------------------------------------
-- Foreign keys. `restrict` throughout: a template with issued documents, a request that
-- produced one, and a document that has been verified must never become removable.
--
-- `subject_id` deliberately has NO foreign key — it is polymorphic on `subject_kind`, and a
-- real FK would need three mutually exclusive nullable columns whose exclusion would itself
-- need a constraint. The service resolves and scope-checks the subject on every path, and an
-- issued document additionally carries its own snapshot, so it stays truthful even after the
-- subject row is archived.
-- -------------------------------------------------------------------------------------

alter table public.document_templates
  add constraint document_templates_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint document_templates_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict;

alter table public.document_requests
  add constraint document_requests_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint document_requests_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint document_requests_template_id_document_templates_id_fk
    foreign key (template_id) references public.document_templates(id) on delete restrict;

alter table public.issued_documents
  add constraint issued_documents_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint issued_documents_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint issued_documents_request_id_document_requests_id_fk
    foreign key (request_id) references public.document_requests(id) on delete restrict,
  add constraint issued_documents_template_id_document_templates_id_fk
    foreign key (template_id) references public.document_templates(id) on delete restrict;

alter table public.document_verifications
  add constraint document_verifications_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint document_verifications_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint document_verifications_document_id_issued_documents_id_fk
    foreign key (issued_document_id) references public.issued_documents(id) on delete restrict;

-- -------------------------------------------------------------------------------------
-- Indexes. Serial numbers, verification codes and template version numbers are NOT partial
-- on `archived_at`: none of them is ever reused, archived or not.
-- -------------------------------------------------------------------------------------

create unique index if not exists document_templates_institution_key_version_key
  on public.document_templates using btree (institution_id, key, version);
create unique index if not exists document_templates_active_key
  on public.document_templates using btree (institution_id, key)
  where is_active and archived_at is null;
create index if not exists document_templates_tenant_idx
  on public.document_templates using btree (tenant_id);
create index if not exists document_templates_institution_kind_idx
  on public.document_templates using btree (institution_id, kind);

create index if not exists document_requests_tenant_idx
  on public.document_requests using btree (tenant_id);
create index if not exists document_requests_institution_status_idx
  on public.document_requests using btree (institution_id, status);
create index if not exists document_requests_subject_idx
  on public.document_requests using btree (subject_kind, subject_id);
create index if not exists document_requests_template_idx
  on public.document_requests using btree (template_id);
create index if not exists document_requests_requested_by_idx
  on public.document_requests using btree (requested_by);

create unique index if not exists issued_documents_institution_serial_key
  on public.issued_documents using btree (institution_id, serial_number);
create unique index if not exists issued_documents_institution_verification_key
  on public.issued_documents using btree (institution_id, verification_code);
-- Global as well: the public endpoint resolves a code with no tenant in hand, so a code that
-- matched two documents in two tenants would be a correctness bug, not merely bad luck.
create unique index if not exists issued_documents_verification_code_key
  on public.issued_documents using btree (verification_code);
create index if not exists issued_documents_tenant_idx
  on public.issued_documents using btree (tenant_id);
create index if not exists issued_documents_subject_idx
  on public.issued_documents using btree (subject_kind, subject_id);
create index if not exists issued_documents_institution_issued_idx
  on public.issued_documents using btree (institution_id, issued_on);
create index if not exists issued_documents_template_idx
  on public.issued_documents using btree (template_id);
create index if not exists issued_documents_request_idx
  on public.issued_documents using btree (request_id);

create index if not exists document_verifications_tenant_idx
  on public.document_verifications using btree (tenant_id);
create index if not exists document_verifications_document_idx
  on public.document_verifications using btree (issued_document_id, verified_at);
create index if not exists document_verifications_institution_idx
  on public.document_verifications using btree (institution_id, verified_at);

-- -------------------------------------------------------------------------------------
-- Check constraints. The facts a violation of which makes a certificate a lie, restated
-- where they cannot be argued with.
-- -------------------------------------------------------------------------------------

alter table public.document_templates
  add constraint document_templates_version_positive check (version >= 1),
  add constraint document_templates_body_not_empty check (length(btrim(body_html)) > 0),
  -- The declared placeholder allow-list is an array; the renderer iterates it.
  add constraint document_templates_variables_array check (jsonb_typeof(variables) = 'array'),
  add constraint document_templates_margins_object check (jsonb_typeof(margins) = 'object');

alter table public.document_requests
  -- Four eyes, in the database. The requester can hold every permission in the catalogue and
  -- still not be their own approver.
  add constraint document_requests_approver_not_requester
    check (approved_by is null or approved_by <> requested_by),
  -- A decision always records when it was made. It does not always name a person: a template
  -- that needs no approval is approved on arrival by nobody, and inventing an approver for it
  -- would put a name against a decision that person never made.
  add constraint document_requests_decision_recorded
    check (status not in ('approved', 'rejected') or approved_at is not null),
  -- A rejection, by contrast, is always somebody's act and always carries a reason.
  add constraint document_requests_rejection_recorded
    check (status <> 'rejected'
           or (approved_by is not null and btrim(coalesce(rejection_reason, '')) <> '')),
  add constraint document_requests_template_version_positive check (template_version >= 1),
  add constraint document_requests_purpose_not_empty check (length(btrim(purpose)) > 0);

alter table public.issued_documents
  add constraint issued_documents_rendered_not_empty check (length(rendered_html) > 0),
  add constraint issued_documents_snapshot_object
    check (jsonb_typeof(data_snapshot) = 'object'),
  add constraint issued_documents_template_version_positive check (template_version >= 1),
  add constraint issued_documents_serial_not_empty check (length(btrim(serial_number)) > 0),
  add constraint issued_documents_verification_code_length
    check (length(verification_code) >= 10),
  -- A revocation is who, when and why together, or none of them.
  add constraint issued_documents_revocation_recorded
    check ((revoked_at is null and revoked_by is null and revoked_reason is null)
           or (revoked_at is not null and revoked_by is not null
               and btrim(coalesce(revoked_reason, '')) <> '')),
  -- A document cannot be revoked before it was issued.
  add constraint issued_documents_revoked_after_issue
    check (revoked_at is null or revoked_at >= created_at);

-- -------------------------------------------------------------------------------------
-- Trigger: an active template is immutable (invariant 2).
--
-- A template row accepts exactly two kinds of change: being deactivated (`is_active`
-- false — which is what superseding it with a new version does) and being archived. Every
-- content field is frozen, so "editing a template" can only mean creating version + 1, and a
-- certificate issued last year cannot have its wording rewritten under it.
-- -------------------------------------------------------------------------------------

create or replace function document_templates_guard_mutation() returns trigger
language plpgsql
as $$
begin
  if pg_has_role(current_user, 'shikkha_migrator', 'MEMBER') then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    raise exception
      'document templates are never deleted; deactivate or archive the version instead'
      using errcode = 'insufficient_privilege';
  end if;

  if new.id <> old.id
     or new.tenant_id <> old.tenant_id
     or new.institution_id <> old.institution_id
     or new.key <> old.key
     or new.version <> old.version
     or new.kind <> old.kind
     or new.name <> old.name
     or new.name_bn is distinct from old.name_bn
     or new.body_html <> old.body_html
     or new.header_html is distinct from old.header_html
     or new.footer_html is distinct from old.footer_html
     or new.page_size <> old.page_size
     or new.orientation <> old.orientation
     or new.margins <> old.margins
     or new.variables <> old.variables
     or new.requires_approval <> old.requires_approval
  then
    raise exception
      'document template % version % is immutable; publish a new version instead of editing it',
      old.key, old.version
      using errcode = 'insufficient_privilege',
            constraint = 'document_templates_immutable';
  end if;

  return new;
end
$$;

create trigger document_templates_immutable
  before update or delete on public.document_templates
  for each row execute function document_templates_guard_mutation();

-- -------------------------------------------------------------------------------------
-- Trigger: the request state machine, and the approval gate (invariant 3).
--
-- The check constraint above guarantees an approver is never the requester. This trigger
-- guarantees the approver *exists* when the template demands one: the move to `issued` is
-- refused for a template with `requires_approval` unless a distinct person has approved.
-- -------------------------------------------------------------------------------------

create or replace function document_requests_guard_mutation() returns trigger
language plpgsql
as $$
declare
  needs_approval boolean;
begin
  if pg_has_role(current_user, 'shikkha_migrator', 'MEMBER') then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    raise exception 'document requests are never deleted; archive the request instead'
      using errcode = 'insufficient_privilege';
  end if;

  -- The identity of a request — who asked, for whom, from which edition of which template —
  -- is fixed at creation. Changing it after an approval would launder the approval.
  if new.id <> old.id
     or new.tenant_id <> old.tenant_id
     or new.institution_id <> old.institution_id
     or new.template_id <> old.template_id
     or new.template_version <> old.template_version
     or new.subject_kind <> old.subject_kind
     or new.subject_id <> old.subject_id
     or new.requested_by <> old.requested_by
  then
    raise exception 'the identity of document request % cannot be changed', old.id
      using errcode = 'insufficient_privilege',
            constraint = 'document_requests_identity_fixed';
  end if;

  if new.status <> old.status then
    if not (
      (old.status = 'draft'
        and new.status in ('pending_approval', 'approved', 'rejected', 'issued'))
      or (old.status = 'pending_approval' and new.status in ('approved', 'rejected'))
      or (old.status = 'approved' and new.status = 'issued')
      or (old.status = 'issued' and new.status = 'revoked')
    ) then
      raise exception 'a document request cannot move from % to %', old.status, new.status
        using errcode = 'check_violation',
              constraint = 'document_requests_status_transition';
    end if;
  end if;

  if new.status = 'issued' and old.status <> 'issued' then
    select t.requires_approval into needs_approval
      from public.document_templates t
     where t.id = new.template_id;

    if coalesce(needs_approval, false) and new.approved_by is null then
      raise exception
        'document request % is for a template that requires approval and has not been approved',
        old.id
        using errcode = 'check_violation',
              constraint = 'document_requests_approval_required';
    end if;
  end if;

  return new;
end
$$;

create trigger document_requests_state_machine
  before update or delete on public.document_requests
  for each row execute function document_requests_guard_mutation();

-- -------------------------------------------------------------------------------------
-- Trigger: an issued document is issuable (invariant 1, insert side).
--
-- The version the document records must be the version the template actually is, the request
-- (when there is one) must be for the same subject in the same institution, and a template
-- that requires approval cannot produce a document without one. Without this, a bulk-issue
-- path could bypass the approval gate that `document_requests` defends.
-- -------------------------------------------------------------------------------------

create or replace function issued_documents_assert_issuable() returns trigger
language plpgsql
as $$
declare
  tpl record;
  req record;
begin
  select t.version, t.requires_approval, t.institution_id
    into tpl
    from public.document_templates t
   where t.id = new.template_id;

  if tpl is null then
    raise exception 'issued document names an unknown template %', new.template_id
      using errcode = 'foreign_key_violation';
  end if;

  if tpl.institution_id <> new.institution_id then
    raise exception 'template % belongs to a different institution', new.template_id
      using errcode = 'check_violation',
            constraint = 'issued_documents_template_consistent';
  end if;

  if tpl.version <> new.template_version then
    raise exception
      'issued document records template version % but template % is version %',
      new.template_version, new.template_id, tpl.version
      using errcode = 'check_violation',
            constraint = 'issued_documents_template_consistent';
  end if;

  if new.request_id is null then
    if tpl.requires_approval then
      raise exception
        'template % requires approval, so a document cannot be issued without an approved request',
        new.template_id
        using errcode = 'check_violation',
              constraint = 'issued_documents_approval_required';
    end if;
    return new;
  end if;

  select r.institution_id, r.subject_kind, r.subject_id, r.template_id,
         r.template_version, r.approved_by, r.requested_by
    into req
    from public.document_requests r
   where r.id = new.request_id;

  if req is null then
    raise exception 'issued document names an unknown request %', new.request_id
      using errcode = 'foreign_key_violation';
  end if;

  if req.institution_id <> new.institution_id
     or req.subject_kind <> new.subject_kind
     or req.subject_id <> new.subject_id
     or req.template_id <> new.template_id
     or req.template_version <> new.template_version
  then
    raise exception 'issued document % does not match its request', new.serial_number
      using errcode = 'check_violation',
            constraint = 'issued_documents_request_consistent';
  end if;

  if tpl.requires_approval
     and (req.approved_by is null or req.approved_by = req.requested_by)
  then
    raise exception
      'request % has no approver distinct from its requester; the document cannot be issued',
      new.request_id
      using errcode = 'check_violation',
            constraint = 'issued_documents_approval_required';
  end if;

  return new;
end
$$;

create trigger issued_documents_issuable
  before insert on public.issued_documents
  for each row execute function issued_documents_assert_issuable();

-- -------------------------------------------------------------------------------------
-- Trigger: an issued document is immutable (invariant 1, the load-bearing one).
--
-- DELETE is refused outright. UPDATE is refused except for the single legal transition —
-- revoking a document that has not already been revoked — during which every other column,
-- `rendered_html` and `data_snapshot` above all, must be byte-for-byte unchanged.
--
-- The migrator role is exempt, exactly as it is for `audit_logs` (0005) and `journal_lines`
-- (0018), so retention and test resets still work; the application role never is.
-- -------------------------------------------------------------------------------------

create or replace function issued_documents_guard_mutation() returns trigger
language plpgsql
as $$
begin
  if pg_has_role(current_user, 'shikkha_migrator', 'MEMBER') then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    raise exception
      'an issued document is permanent; revoke it with a reason rather than deleting it'
      using errcode = 'insufficient_privilege';
  end if;

  if old.revoked_at is null
     and new.revoked_at is not null
     and new.revoked_by is not null
     and btrim(coalesce(new.revoked_reason, '')) <> ''
     and new.id = old.id
     and new.tenant_id = old.tenant_id
     and new.institution_id = old.institution_id
     and new.request_id is not distinct from old.request_id
     and new.template_id = old.template_id
     and new.template_version = old.template_version
     and new.subject_kind = old.subject_kind
     and new.subject_id = old.subject_id
     and new.serial_number = old.serial_number
     and new.issued_on = old.issued_on
     and new.issued_by = old.issued_by
     and new.rendered_html = old.rendered_html
     and new.storage_key is not distinct from old.storage_key
     and new.data_snapshot = old.data_snapshot
     and new.verification_code = old.verification_code
     and new.archived_at is null
  then
    return new;
  end if;

  raise exception
    'issued document % is immutable: its rendered content and data snapshot are frozen at issue time. Issue a new document, or revoke this one.',
    old.serial_number
    using errcode = 'insufficient_privilege',
          constraint = 'issued_documents_immutable';

  -- Unreachable; plpgsql wants a return on every path.
  return null;
end
$$;

create trigger issued_documents_immutable
  before update or delete on public.issued_documents
  for each row execute function issued_documents_guard_mutation();

-- -------------------------------------------------------------------------------------
-- Trigger: verifications are append-only (invariant 4). A log that can be edited after the
-- fact is not evidence of anything.
-- -------------------------------------------------------------------------------------

create or replace function document_verifications_guard_mutation() returns trigger
language plpgsql
as $$
begin
  if pg_has_role(current_user, 'shikkha_migrator', 'MEMBER') then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  raise exception 'document verifications are append-only'
    using errcode = 'insufficient_privilege',
          constraint = 'document_verifications_append_only';

  -- Unreachable; plpgsql wants a return on every path.
  return null;
end
$$;

create trigger document_verifications_append_only
  before update or delete on public.document_verifications
  for each row execute function document_verifications_guard_mutation();

-- -------------------------------------------------------------------------------------
-- Row-level security: enable + force + the standard tenant_isolation policy + grants +
-- updated_at trigger, per table. The catalogue loop in 0002 does not re-run for tables
-- created later, so it is restated here.
-- -------------------------------------------------------------------------------------

do $$
declare
  target text;
  document_tables constant text[] := array[
    'document_templates',
    'document_requests',
    'issued_documents',
    'document_verifications'
  ];
begin
  foreach target in array document_tables
  loop
    execute format('alter table public.%I enable row level security', target);
    execute format('alter table public.%I force row level security', target);

    execute format('drop policy if exists tenant_isolation on public.%I', target);

    execute format($p$
      create policy tenant_isolation on public.%I
        for all
        using (
          app_is_platform_admin()
          or (tenant_id is not null and tenant_id = app_current_tenant_id())
        )
        with check (
          app_is_platform_admin()
          or (tenant_id is not null and tenant_id = app_current_tenant_id())
        )
    $p$, target);

    execute format('grant select, insert, update, delete on public.%I to shikkha_app', target);
    execute format('grant select on public.%I to shikkha_readonly', target);

    execute format('drop trigger if exists set_updated_at on public.%I', target);
    execute format(
      'create trigger set_updated_at before update on public.%I
         for each row execute function set_updated_at()',
      target
    );
  end loop;
end
$$;

-- -------------------------------------------------------------------------------------
-- Assertions — fail the migration rather than ship a silently-disabled control.
-- -------------------------------------------------------------------------------------

do $$
declare
  offending text;
begin
  select string_agg(c.relname, ', ' order by c.relname)
  into offending
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and c.relname = any (array[
      'document_templates', 'document_requests', 'issued_documents', 'document_verifications'
    ])
    and (
      not c.relrowsecurity
      or not c.relforcerowsecurity
      or not exists (
        select 1 from pg_policy p where p.polrelid = c.oid and p.polname = 'tenant_isolation'
      )
    );

  if offending is not null then
    raise exception
      'Document tables without forced row-level security and a tenant_isolation policy: %',
      offending;
  end if;

  select string_agg(t.name, ', ' order by t.name)
  into offending
  from unnest(array[
    'document_templates', 'document_requests', 'issued_documents', 'document_verifications'
  ]) as t(name)
  where not exists (
    select 1
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = t.name
      and a.attname = 'tenant_id'
      and a.attnum > 0
      and not a.attisdropped
  );

  if offending is not null then
    raise exception 'Document tables without a tenant_id column: %', offending;
  end if;

  -- The immutability guarantee is the module's whole reason to exist. A missing trigger here
  -- would leave issued certificates editable, so it fails the migration.
  if not exists (
    select 1 from pg_trigger
     where tgname = 'issued_documents_immutable'
       and tgrelid = 'public.issued_documents'::regclass
       and not tgisinternal
  ) then
    raise exception 'issued_documents_immutable trigger is missing';
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'document_requests_approver_not_requester'
       and conrelid = 'public.document_requests'::regclass
  ) then
    raise exception 'document_requests_approver_not_requester constraint is missing';
  end if;
end
$$;

-- The global sweep: every public table is either RLS-protected or explicitly exempt.
select assert_rls_coverage();
