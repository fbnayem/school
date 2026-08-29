-- =====================================================================================
-- 0017 — Payment gateway abstraction (Phase 12)
--
-- Four tables in front of the Phase 11 fee ledger, for money that arrives over the internet.
-- The properties enforced here rather than left to the application:
--
--   1. **No floating point.** Every monetary column is `numeric(14, 2)`; the driver returns a
--      string and `Money` is the only parser (ADR-004).
--   2. **Duplicate callbacks are a database-level no-op.** Gateways retry, and a double credit
--      is worse than a missed one. `payment_callbacks.dedupe_key` is UNIQUE — the second
--      delivery of the same event collides here no matter what the service forgot to check.
--   3. **A succeeded intent always names its fee-side payment.** The check constraint makes
--      "money arrived but the ledger never heard" unrepresentable; the service posts the
--      payment and flips the status in one transaction, and this constraint is the proof.
--   4. **Intent creation is idempotent per institution.** A partial unique index on
--      `(institution_id, idempotency_key)` means two identical "pay now" clicks race into one
--      row.
--   5. **An abandoned payment is not a failed one.** `expired` and `failed` are distinct
--      statuses in the enum, so the distinction cannot be quietly erased in code.
--
-- Row-level security is applied at the bottom exactly as 0009 does for the fee tables — the
-- catalogue loop in 0002 does not re-run for tables created later. `payment_callbacks` is the
-- one table whose `tenant_id` is nullable: a callback that references no known intent belongs
-- to no tenant, is written under the platform context, and is visible to no tenant. The
-- standard policy already reads correctly for that case (`tenant_id is not null and ...`).
-- =====================================================================================

-- -------------------------------------------------------------------------------------
-- Enumerations. Closed sets: a new provider or intent status changes signature-verification
-- and settlement-parsing code, so it should require a migration.
-- -------------------------------------------------------------------------------------

create type public.payment_gateway_provider as enum (
  'mock', 'bkash', 'nagad', 'rocket', 'sslcommerz', 'bank_transfer', 'cash'
);

create type public.payment_intent_status as enum (
  'created', 'redirected', 'pending', 'succeeded', 'failed', 'expired', 'cancelled', 'reconciled'
);

create type public.reconciliation_item_status as enum (
  'matched', 'missing_locally', 'missing_remotely', 'amount_mismatch'
);

-- -------------------------------------------------------------------------------------
-- Tables
-- -------------------------------------------------------------------------------------

create table public.payment_intents (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  student_id uuid not null,
  invoice_ids jsonb not null,
  amount numeric(14, 2) not null,
  currency varchar(3) default 'BDT' not null,
  provider public.payment_gateway_provider not null,
  provider_intent_id varchar(128),
  status public.payment_intent_status default 'created' not null,
  idempotency_key varchar(200) not null,
  return_url varchar(500),
  expires_at timestamp with time zone not null,
  payment_id uuid,
  succeeded_at timestamp with time zone,
  failure_code varchar(64),
  failure_message varchar(500),
  cancelled_reason varchar(500),
  refund_status varchar(16) default 'none' not null,
  refund_reason varchar(1000),
  refund_requested_by uuid,
  refund_requested_at timestamp with time zone,
  refund_decided_by uuid,
  refund_decided_at timestamp with time zone,
  refund_decision_note varchar(1000),
  refund_provider_reference varchar(128),
  metadata jsonb default '{}'::jsonb not null,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.payment_callbacks (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid,
  intent_id uuid,
  provider public.payment_gateway_provider not null,
  raw_payload jsonb not null,
  signature varchar(512),
  signature_valid boolean not null,
  received_at timestamp with time zone default now() not null,
  processed_at timestamp with time zone,
  processing_result varchar(200),
  dedupe_key varchar(200) not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.payment_reconciliations (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  provider public.payment_gateway_provider not null,
  settlement_date date not null,
  file_key varchar(300),
  total_reported numeric(14, 2) default '0.00' not null,
  total_matched numeric(14, 2) default '0.00' not null,
  unmatched_count integer default 0 not null,
  status varchar(16) not null,
  run_by uuid,
  run_at timestamp with time zone default now() not null,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.reconciliation_items (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  reconciliation_id uuid not null,
  provider_reference varchar(128) not null,
  amount_reported numeric(14, 2),
  amount_local numeric(14, 2),
  intent_id uuid,
  status public.reconciliation_item_status not null,
  note varchar(500),
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

-- -------------------------------------------------------------------------------------
-- Foreign keys
-- -------------------------------------------------------------------------------------

alter table public.payment_intents
  add constraint payment_intents_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint payment_intents_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint payment_intents_student_id_students_id_fk
    foreign key (student_id) references public.students(id) on delete restrict,
  add constraint payment_intents_payment_id_payments_id_fk
    foreign key (payment_id) references public.payments(id) on delete restrict;

alter table public.payment_callbacks
  add constraint payment_callbacks_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint payment_callbacks_intent_id_payment_intents_id_fk
    foreign key (intent_id) references public.payment_intents(id) on delete set null;

alter table public.payment_reconciliations
  add constraint payment_reconciliations_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint payment_reconciliations_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict;

alter table public.reconciliation_items
  add constraint reconciliation_items_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint reconciliation_items_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  -- Short-form name (0007 style): the full `<table>_<column>_<reftable>_id_fk` form exceeds
  -- Postgres's 63-character identifier limit and would be silently truncated.
  add constraint reconciliation_items_reconciliation_id_fk
    foreign key (reconciliation_id) references public.payment_reconciliations(id) on delete cascade,
  add constraint reconciliation_items_intent_id_payment_intents_id_fk
    foreign key (intent_id) references public.payment_intents(id) on delete set null;

-- -------------------------------------------------------------------------------------
-- Indexes. Business-key uniqueness is partial on live rows (ADR-008), except the callback
-- dedupe key, which must hold across archived rows too — an archived callback was still
-- delivered once.
-- -------------------------------------------------------------------------------------

create unique index if not exists payment_intents_idempotency_key
  on public.payment_intents using btree (institution_id, idempotency_key)
  where archived_at is null;
create unique index if not exists payment_intents_provider_ref_key
  on public.payment_intents using btree (provider, provider_intent_id)
  where provider_intent_id is not null and archived_at is null;
create index if not exists payment_intents_tenant_idx
  on public.payment_intents using btree (tenant_id);
create index if not exists payment_intents_institution_status_idx
  on public.payment_intents using btree (institution_id, status, provider);
create index if not exists payment_intents_student_idx
  on public.payment_intents using btree (student_id, created_at);
create index if not exists payment_intents_payment_idx
  on public.payment_intents using btree (payment_id);

create unique index if not exists payment_callbacks_dedupe_key
  on public.payment_callbacks using btree (dedupe_key);
create index if not exists payment_callbacks_tenant_idx
  on public.payment_callbacks using btree (tenant_id);
create index if not exists payment_callbacks_intent_idx
  on public.payment_callbacks using btree (intent_id);
create index if not exists payment_callbacks_received_idx
  on public.payment_callbacks using btree (provider, received_at);

create index if not exists payment_reconciliations_tenant_idx
  on public.payment_reconciliations using btree (tenant_id);
create index if not exists payment_reconciliations_institution_idx
  on public.payment_reconciliations using btree (institution_id, provider, settlement_date);

create index if not exists reconciliation_items_tenant_idx
  on public.reconciliation_items using btree (tenant_id);
create index if not exists reconciliation_items_run_idx
  on public.reconciliation_items using btree (reconciliation_id, status);
create index if not exists reconciliation_items_intent_idx
  on public.reconciliation_items using btree (intent_id);

-- -------------------------------------------------------------------------------------
-- Check constraints — the module's invariants, restated where they cannot be argued with.
-- -------------------------------------------------------------------------------------

alter table public.payment_intents
  add constraint payment_intents_amount_positive check (amount > 0),
  add constraint payment_intents_currency_known check (currency in ('BDT', 'USD')),
  -- "The ledger posting happens in the same transaction": a succeeded (or later reconciled)
  -- intent that names no fee-side payment is unrepresentable.
  add constraint payment_intents_success_has_payment
    check (status not in ('succeeded', 'reconciled') or payment_id is not null),
  add constraint payment_intents_success_has_timestamp
    check (status not in ('succeeded', 'reconciled') or succeeded_at is not null),
  add constraint payment_intents_cancel_requires_reason
    check (status <> 'cancelled' or cancelled_reason is not null),
  add constraint payment_intents_refund_status_known
    check (refund_status in ('none', 'requested', 'rejected', 'completed')),
  -- Only money that actually arrived can be refunded, and a request is always on the record.
  add constraint payment_intents_refund_needs_success
    check (refund_status = 'none' or status in ('succeeded', 'reconciled')),
  add constraint payment_intents_refund_requires_reason
    check (refund_status = 'none' or refund_reason is not null),
  add constraint payment_intents_refund_decision_recorded
    check (refund_status not in ('rejected', 'completed') or refund_decided_by is not null);

alter table public.payment_callbacks
  add constraint payment_callbacks_processed_after_received
    check (processed_at is null or processed_at >= received_at);

alter table public.payment_reconciliations
  add constraint payment_reconciliations_totals_non_negative
    check (total_reported >= 0 and total_matched >= 0 and unmatched_count >= 0),
  add constraint payment_reconciliations_status_known
    check (status in ('matched', 'mismatched'));

alter table public.reconciliation_items
  add constraint reconciliation_items_amounts_non_negative
    check (
      (amount_reported is null or amount_reported >= 0)
      and (amount_local is null or amount_local >= 0)
    ),
  -- A row the file reported carries the reported amount; a row only we know about does not.
  add constraint reconciliation_items_reported_amount_present
    check (status = 'missing_remotely' or amount_reported is not null),
  add constraint reconciliation_items_remote_missing_has_intent
    check (status <> 'missing_remotely' or intent_id is not null);

-- -------------------------------------------------------------------------------------
-- Row-level security. The 0002 loop only covered tables that existed then; these four are
-- enabled, forced and given the identical `tenant_isolation` policy here.
-- -------------------------------------------------------------------------------------

do $$
declare
  target text;
  gateway_tables constant text[] := array[
    'payment_intents',
    'payment_callbacks',
    'payment_reconciliations',
    'reconciliation_items'
  ];
begin
  foreach target in array gateway_tables
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

    -- `updated_at` is maintained by the trigger, not by the application, so a hand-written
    -- SQL fix in production still leaves an honest timestamp behind.
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
  -- Named explicitly rather than relying only on the global sweep below, so that a typo in
  -- the array above is a failed migration instead of a table nobody notices is unprotected.
  select string_agg(c.relname, ', ' order by c.relname)
  into offending
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and c.relname = any (array[
      'payment_intents', 'payment_callbacks', 'payment_reconciliations', 'reconciliation_items'
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
      'Payment gateway tables without forced row-level security and a tenant_isolation policy: %',
      offending;
  end if;

  -- Every one of the four must also carry the tenant column the policy reads. A policy on a
  -- table without `tenant_id` would fail at query time, not here.
  select string_agg(t.name, ', ' order by t.name)
  into offending
  from unnest(array[
    'payment_intents', 'payment_callbacks', 'payment_reconciliations', 'reconciliation_items'
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
    raise exception 'Payment gateway tables without a tenant_id column: %', offending;
  end if;
end
$$;

-- The global sweep: every public table is either RLS-protected or explicitly exempt.
select assert_rls_coverage();
