-- =====================================================================================
-- 0022 — Communication centre (Phase 14)
--
-- Nine tenant-scoped tables: tenant-editable notification templates, notice-board
-- announcements with read receipts, person-to-person message threads, and mass
-- notification campaigns with per-recipient delivery records. Four properties are
-- enforced here rather than left to the application, because each is a guarantee the
-- application can only get wrong once:
--
--   1. **Messages are append-only.** `messages` gets the same treatment as `audit_logs`
--      and `behaviour_record_notes`: UPDATE and DELETE privileges are revoked from the
--      application role AND a trigger refuses both operations for every role, so what was
--      said in a parent-teacher conversation cannot be quietly rewritten — not even by a
--      hand-written SQL "fix". A retraction is a new system message.
--   2. **A mass send needs two people.** `notification_campaigns_approver_distinct`
--      restates in the database what the service enforces at runtime: the approver of a
--      campaign must be a different person from its requester, so not even a school owner
--      holding every permission can approve their own blast to every guardian's phone.
--   3. **No recipient snapshots.** The campaign table stores an audience *definition*
--      (jsonb) and a resolved *count* — there is no column a list of phone numbers could
--      go into. Recipients are resolved at send time by the service.
--   4. **Delivery reports are idempotent.** The partial unique index on
--      `notification_deliveries.provider_message_id` makes the webhook's idempotency key a
--      real key, so a redelivered report can address exactly one row.
--
-- Row-level security is applied at the bottom with the standard `tenant_isolation` policy;
-- the 0002 loop does not re-run for tables created later, so it is done here explicitly
-- and `assert_rls_coverage()` is called last.
-- =====================================================================================

-- -------------------------------------------------------------------------------------
-- Enumerations. Closed value sets only: a school's own message *templates* are rows in
-- `message_templates`, not values here.
-- -------------------------------------------------------------------------------------

create type public.communication_channel as enum ('sms', 'email', 'in_app', 'push');

create type public.announcement_audience as enum (
  'all', 'students', 'guardians', 'employees', 'class', 'section', 'role'
);

create type public.announcement_status as enum ('draft', 'scheduled', 'published', 'archived');

create type public.message_thread_kind as enum ('direct', 'broadcast');

create type public.notification_campaign_status as enum (
  'draft', 'queued', 'sending', 'sent', 'failed', 'cancelled'
);

create type public.notification_delivery_status as enum (
  'queued', 'sent', 'delivered', 'failed', 'bounced'
);

-- -------------------------------------------------------------------------------------
-- Tables
-- -------------------------------------------------------------------------------------

create table public.message_templates (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  key varchar(64) not null,
  name varchar(128) not null,
  channel public.communication_channel not null,
  subject varchar(255),
  body_en text not null,
  body_bn text,
  variables jsonb default '[]'::jsonb not null,
  is_system boolean default false not null,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.announcements (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  campus_id uuid,
  title varchar(255) not null,
  title_bn varchar(255),
  body text not null,
  body_bn text,
  audience public.announcement_audience default 'all' not null,
  audience_ref_id uuid,
  publish_at timestamp with time zone,
  expires_at timestamp with time zone,
  status public.announcement_status default 'draft' not null,
  published_by uuid,
  published_at timestamp with time zone,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.announcement_reads (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  announcement_id uuid not null,
  user_id uuid not null,
  read_at timestamp with time zone default now() not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.message_threads (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  subject varchar(255) not null,
  kind public.message_thread_kind default 'direct' not null,
  created_by_user_id uuid not null,
  last_message_at timestamp with time zone,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.thread_participants (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  thread_id uuid not null,
  user_id uuid not null,
  role_in_thread varchar(32) default 'member' not null,
  last_read_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.messages (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  thread_id uuid not null,
  sender_user_id uuid not null,
  body text not null,
  sent_at timestamp with time zone default now() not null,
  is_system boolean default false not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.message_attachments (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  message_id uuid not null,
  file_id uuid not null,
  storage_key varchar(512) not null,
  filename varchar(255) not null,
  mime_type varchar(128) not null,
  size_bytes bigint not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.notification_campaigns (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  template_id uuid not null,
  channel public.communication_channel not null,
  audience jsonb not null,
  scheduled_for timestamp with time zone,
  status public.notification_campaign_status default 'draft' not null,
  requested_by uuid not null,
  submitted_at timestamp with time zone,
  approved_by uuid,
  approved_at timestamp with time zone,
  total_recipients integer default 0 not null,
  sent_count integer default 0 not null,
  failed_count integer default 0 not null,
  sent_at timestamp with time zone,
  cancelled_reason varchar(1000),
  cancelled_by uuid,
  cancelled_at timestamp with time zone,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.notification_deliveries (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  campaign_id uuid,
  recipient_user_id uuid,
  recipient_address varchar(255) not null,
  channel public.communication_channel not null,
  template_key varchar(64) not null,
  status public.notification_delivery_status default 'queued' not null,
  provider_message_id varchar(128),
  error varchar(1000),
  attempts integer default 0 not null,
  sent_at timestamp with time zone,
  delivered_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

-- -------------------------------------------------------------------------------------
-- Foreign keys. `restrict` throughout: a conversation, an announcement or a delivery
-- record must never silently lose its institution, thread or campaign. `audience_ref_id`
-- and the user-id columns deliberately carry no FK — the former is polymorphic (class,
-- section or role), and communications must survive their subject's later archival.
-- -------------------------------------------------------------------------------------

alter table public.message_templates
  add constraint message_templates_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint message_templates_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict;

alter table public.announcements
  add constraint announcements_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint announcements_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint announcements_campus_id_campuses_id_fk
    foreign key (campus_id) references public.campuses(id) on delete restrict;

alter table public.announcement_reads
  add constraint announcement_reads_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint announcement_reads_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint announcement_reads_announcement_id_announcements_id_fk
    foreign key (announcement_id) references public.announcements(id) on delete restrict;

alter table public.message_threads
  add constraint message_threads_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint message_threads_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict;

alter table public.thread_participants
  add constraint thread_participants_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint thread_participants_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint thread_participants_thread_id_message_threads_id_fk
    foreign key (thread_id) references public.message_threads(id) on delete restrict;

alter table public.messages
  add constraint messages_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint messages_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint messages_thread_id_message_threads_id_fk
    foreign key (thread_id) references public.message_threads(id) on delete restrict;

alter table public.message_attachments
  add constraint message_attachments_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint message_attachments_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint message_attachments_message_id_messages_id_fk
    foreign key (message_id) references public.messages(id) on delete restrict,
  add constraint message_attachments_file_id_files_id_fk
    foreign key (file_id) references public.files(id) on delete restrict;

alter table public.notification_campaigns
  add constraint notification_campaigns_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint notification_campaigns_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint notification_campaigns_template_id_message_templates_id_fk
    foreign key (template_id) references public.message_templates(id) on delete restrict;

alter table public.notification_deliveries
  add constraint notification_deliveries_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint notification_deliveries_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint notification_deliveries_campaign_id_notification_campaigns_id_fk
    foreign key (campaign_id) references public.notification_campaigns(id) on delete restrict;

-- -------------------------------------------------------------------------------------
-- Indexes
-- -------------------------------------------------------------------------------------

create unique index if not exists message_templates_institution_key_key
  on public.message_templates using btree (institution_id, key) where archived_at is null;
create index if not exists message_templates_tenant_idx
  on public.message_templates using btree (tenant_id);
create index if not exists message_templates_institution_channel_idx
  on public.message_templates using btree (institution_id, channel);

create index if not exists announcements_tenant_idx
  on public.announcements using btree (tenant_id);
create index if not exists announcements_institution_status_idx
  on public.announcements using btree (institution_id, status);
create index if not exists announcements_audience_idx
  on public.announcements using btree (institution_id, audience, audience_ref_id);
create index if not exists announcements_publish_idx
  on public.announcements using btree (institution_id, publish_at);

-- A read receipt, once true, stays true — the unique index is total, not partial.
create unique index if not exists announcement_reads_announcement_user_key
  on public.announcement_reads using btree (announcement_id, user_id);
create index if not exists announcement_reads_tenant_idx
  on public.announcement_reads using btree (tenant_id);
create index if not exists announcement_reads_user_idx
  on public.announcement_reads using btree (user_id);

create index if not exists message_threads_tenant_idx
  on public.message_threads using btree (tenant_id);
create index if not exists message_threads_institution_idx
  on public.message_threads using btree (institution_id, last_message_at);
create index if not exists message_threads_creator_idx
  on public.message_threads using btree (created_by_user_id);

create unique index if not exists thread_participants_thread_user_key
  on public.thread_participants using btree (thread_id, user_id) where archived_at is null;
create index if not exists thread_participants_tenant_idx
  on public.thread_participants using btree (tenant_id);
create index if not exists thread_participants_user_idx
  on public.thread_participants using btree (user_id);

create index if not exists messages_tenant_idx
  on public.messages using btree (tenant_id);
create index if not exists messages_thread_idx
  on public.messages using btree (thread_id, sent_at);
create index if not exists messages_sender_idx
  on public.messages using btree (sender_user_id);

create index if not exists message_attachments_tenant_idx
  on public.message_attachments using btree (tenant_id);
create index if not exists message_attachments_message_idx
  on public.message_attachments using btree (message_id);
create index if not exists message_attachments_file_idx
  on public.message_attachments using btree (file_id);

create index if not exists notification_campaigns_tenant_idx
  on public.notification_campaigns using btree (tenant_id);
create index if not exists notification_campaigns_institution_status_idx
  on public.notification_campaigns using btree (institution_id, status);
create index if not exists notification_campaigns_template_idx
  on public.notification_campaigns using btree (template_id);
create index if not exists notification_campaigns_requested_idx
  on public.notification_campaigns using btree (requested_by);

-- The webhook idempotency key. Partial: a delivery only gets one once handed to a provider.
create unique index if not exists notification_deliveries_provider_message_key
  on public.notification_deliveries using btree (provider_message_id)
  where provider_message_id is not null;
create index if not exists notification_deliveries_tenant_idx
  on public.notification_deliveries using btree (tenant_id);
create index if not exists notification_deliveries_campaign_idx
  on public.notification_deliveries using btree (campaign_id, status);
create index if not exists notification_deliveries_recipient_idx
  on public.notification_deliveries using btree (recipient_user_id);
create index if not exists notification_deliveries_status_idx
  on public.notification_deliveries using btree (status, created_at);

-- -------------------------------------------------------------------------------------
-- Check constraints — the communication invariants, restated where they cannot be argued
-- with.
-- -------------------------------------------------------------------------------------

alter table public.message_templates
  add constraint message_templates_body_present check (length(btrim(body_en)) > 0);

alter table public.announcements
  add constraint announcements_title_present check (length(btrim(title)) > 0),
  add constraint announcements_body_present check (length(btrim(body)) > 0),
  add constraint announcements_expiry_after_publish check (
    publish_at is null or expires_at is null or expires_at > publish_at
  ),
  -- class/section/role audiences are meaningless without the id of the class, section or
  -- role they refer to.
  add constraint announcements_audience_ref_required check (
    audience not in ('class', 'section', 'role') or audience_ref_id is not null
  ),
  -- A published notice always says who published it and when.
  add constraint announcements_published_recorded check (
    status <> 'published' or (published_by is not null and published_at is not null)
  );

alter table public.messages
  add constraint messages_body_present check (length(btrim(body)) > 0);

alter table public.message_attachments
  add constraint message_attachments_size_positive check (size_bytes > 0);

alter table public.notification_campaigns
  -- THE two-person rule: a campaign is never approved by the person who requested it.
  add constraint notification_campaigns_approver_distinct check (
    approved_by is null or approved_by <> requested_by
  ),
  add constraint notification_campaigns_counts_non_negative check (
    total_recipients >= 0 and sent_count >= 0 and failed_count >= 0
  ),
  -- Anything past draft (other than a cancellation of a never-submitted draft) was
  -- submitted by someone at a recorded time.
  add constraint notification_campaigns_submitted_recorded check (
    status in ('draft', 'cancelled') or submitted_at is not null
  ),
  add constraint notification_campaigns_approval_recorded check (
    approved_by is null or approved_at is not null
  ),
  add constraint notification_campaigns_cancel_recorded check (
    status <> 'cancelled'
    or (cancelled_by is not null and cancelled_at is not null and cancelled_reason is not null)
  );

alter table public.notification_deliveries
  add constraint notification_deliveries_attempts_non_negative check (attempts >= 0);

-- -------------------------------------------------------------------------------------
-- Append-only enforcement for messages — the same mechanism as `audit_logs` in 0002 and
-- `behaviour_record_notes` in 0020.
--
-- Two layers, deliberately redundant: the trigger refuses UPDATE/DELETE for *every* role
-- (including the table owner running a hand-written fix), and the privilege revocation
-- below the grant loop removes even the theoretical path from the application role.
-- A retraction is a new `is_system` message, never an edit.
-- -------------------------------------------------------------------------------------

create or replace function comm_messages_reject_mutation() returns trigger
language plpgsql
as $$
begin
  raise exception 'messages is append-only; % is not permitted', tg_op
    using errcode = 'insufficient_privilege';
end
$$;

drop trigger if exists messages_no_mutation on public.messages;
create trigger messages_no_mutation
  before update or delete on public.messages
  for each row execute function comm_messages_reject_mutation();

-- -------------------------------------------------------------------------------------
-- Row-level security. The 0002 loop does not re-run for tables created later; the policy,
-- the grants and the `set_updated_at` trigger are applied here for these nine tables.
-- -------------------------------------------------------------------------------------

do $$
declare
  target text;
  communication_tables constant text[] := array[
    'message_templates',
    'announcements',
    'announcement_reads',
    'message_threads',
    'thread_participants',
    'messages',
    'message_attachments',
    'notification_campaigns',
    'notification_deliveries'
  ];
begin
  foreach target in array communication_tables
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

    -- Default privileges cover tables created by the migrator, but restating the grant makes
    -- this migration correct even if the default privileges were altered between releases.
    execute format('grant select, insert, update, delete on public.%I to shikkha_app', target);
    execute format('grant select on public.%I to shikkha_readonly', target);

    -- `updated_at` is maintained by the trigger, not by the application. On the append-only
    -- messages table this trigger is unreachable: `messages_no_mutation` sorts before it
    -- and fires first.
    execute format('drop trigger if exists set_updated_at on public.%I', target);
    execute format(
      'create trigger set_updated_at before update on public.%I
         for each row execute function set_updated_at()',
      target
    );
  end loop;
end
$$;

-- Messages are append-only for the application role at the privilege level as well: like
-- `audit_logs`, the application cannot even attempt an UPDATE or DELETE.
revoke update, delete on public.messages from shikkha_app;

-- -------------------------------------------------------------------------------------
-- Assertions — fail the migration rather than ship a silently-disabled control.
-- -------------------------------------------------------------------------------------

do $$
declare
  offending text;
begin
  -- Named explicitly rather than relying only on the global sweep below, so that a typo in
  -- the array above is a failed migration instead of a table nobody notices is unprotected.
  select string_agg(c.relname, ', ' order by c.relname)
  into offending
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and c.relname = any (array[
      'message_templates', 'announcements', 'announcement_reads', 'message_threads',
      'thread_participants', 'messages', 'message_attachments',
      'notification_campaigns', 'notification_deliveries'
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
      'Communication tables without forced row-level security and a tenant_isolation policy: %',
      offending;
  end if;

  -- Every one of the nine must also carry the tenant column the policy reads. A policy on a
  -- table without `tenant_id` would fail at query time, not here.
  select string_agg(t.name, ', ' order by t.name)
  into offending
  from unnest(array[
    'message_templates', 'announcements', 'announcement_reads', 'message_threads',
    'thread_participants', 'messages', 'message_attachments',
    'notification_campaigns', 'notification_deliveries'
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
    raise exception 'Communication tables without a tenant_id column: %', offending;
  end if;

  -- The append-only trigger must exist on the messages table.
  if not exists (
    select 1
    from pg_trigger tg
    join pg_class c on c.oid = tg.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'messages'
      and tg.tgname = 'messages_no_mutation'
  ) then
    raise exception 'messages is missing its append-only trigger';
  end if;
end
$$;

-- The global sweep: every public table is either RLS-protected or explicitly exempt.
select assert_rls_coverage();
