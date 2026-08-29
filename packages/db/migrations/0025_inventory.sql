-- =====================================================================================
-- 0025 — Inventory and procurement (Phase 19)
--
-- Twelve tenant-scoped tables: catalogue (item_categories, items, stores, suppliers),
-- stock (stock_movements, stock_levels) and procurement (purchase_requisitions,
-- requisition_items, purchase_orders, purchase_order_items, goods_receipts,
-- goods_receipt_items).
--
-- Four properties are enforced HERE, in the database, because each is one the application
-- can only get wrong once:
--
--   1. **stock_movements is APPEND-ONLY.** `inventory_stock_movements_no_mutation` refuses
--      UPDATE and DELETE for every role except the migrator. A wrong movement is corrected
--      by a compensating movement — the same philosophy as audit_logs (0005) and
--      workflow_actions (0014).
--   2. **stock_levels is DERIVED and cannot drift.** `inventory_stock_movements_apply`
--      applies every inserted movement's signed effect to the level row in the same
--      transaction, and `inventory_stock_levels_guard` refuses any write to stock_levels
--      that does not come from that trigger (a transaction-local setting is the handshake).
--      The only way to change a level — through the API or through raw SQL — is to write a
--      movement.
--   3. **Stock never goes negative.** `stock_levels_quantity_non_negative` is a check
--      constraint on the derived row; because the trigger updates it in the movement's own
--      transaction, an over-issue is refused by Postgres itself.
--   4. **Received never exceeds ordered.** `purchase_order_items_received_within_ordered`.
--
-- Quantities are numeric(14, 3) — three decimals for kg/litre — and every cost is
-- numeric(14, 2) (ADR-004: no floating-point money, ever).
--
-- `purchase_requisitions.workflow_request_id` and `goods_receipts.journal_entry_id` are
-- bare uuids without foreign keys: the workflow engine is an optional peer, and the journal
-- entry belongs to the accounting module (inventory posts through its LedgerService inside
-- the same transaction, but never touches its tables).
--
-- The RLS/grants/updated_at loop from 0002 does not re-run for tables created later, so it
-- is restated at the bottom, followed by named assertions and assert_rls_coverage().
-- =====================================================================================

-- -------------------------------------------------------------------------------------
-- Enumerations. Closed value sets — a new movement kind or order status changes stock and
-- procurement code as well as the schema. A school's own item categories, stores and
-- suppliers are rows, not values here.
-- -------------------------------------------------------------------------------------

create type public.inventory_unit as enum ('piece', 'box', 'kg', 'litre', 'metre', 'set');

create type public.inventory_item_status as enum ('active', 'inactive', 'discontinued');

create type public.inventory_supplier_status as enum ('active', 'inactive');

create type public.stock_movement_kind as enum (
  'receipt', 'issue', 'return', 'adjustment', 'transfer_in', 'transfer_out', 'write_off'
);

create type public.purchase_requisition_status as enum (
  'draft', 'submitted', 'approved', 'rejected', 'ordered', 'cancelled'
);

create type public.purchase_order_status as enum (
  'draft', 'issued', 'partially_received', 'received', 'cancelled'
);

-- -------------------------------------------------------------------------------------
-- Tables
-- -------------------------------------------------------------------------------------

create table public.item_categories (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  name_en varchar(128) not null,
  name_bn varchar(128),
  parent_id uuid,
  sort_order smallint default 0 not null,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.items (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  code varchar(32) not null,
  name_en varchar(128) not null,
  name_bn varchar(128),
  category_id uuid,
  unit public.inventory_unit default 'piece' not null,
  reorder_level numeric(14, 3) default '0.000' not null,
  is_consumable boolean default true not null,
  ledger_account_code varchar(32),
  status public.inventory_item_status default 'active' not null,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.stores (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  campus_id uuid not null,
  code varchar(32) not null,
  name_en varchar(128) not null,
  name_bn varchar(128),
  keeper_employee_id uuid,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.suppliers (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  code varchar(32) not null,
  name_en varchar(128) not null,
  name_bn varchar(128),
  contact_person varchar(128),
  phone varchar(20),
  email varchar(255),
  address varchar(500),
  status public.inventory_supplier_status default 'active' not null,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.stock_movements (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  item_id uuid not null,
  store_id uuid not null,
  kind public.stock_movement_kind not null,
  quantity numeric(14, 3) not null,
  unit_cost numeric(14, 2),
  reference_type varchar(64),
  reference_id uuid,
  moved_on date not null,
  moved_by uuid,
  reason varchar(1000),
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.stock_levels (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  item_id uuid not null,
  store_id uuid not null,
  quantity numeric(14, 3) default '0.000' not null,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.purchase_requisitions (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  requested_by uuid not null,
  needed_by date,
  justification varchar(1000) not null,
  status public.purchase_requisition_status default 'draft' not null,
  workflow_request_id uuid,
  submitted_at timestamp with time zone,
  decided_by uuid,
  decided_at timestamp with time zone,
  decision_reason varchar(1000),
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.requisition_items (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  requisition_id uuid not null,
  item_id uuid not null,
  quantity numeric(14, 3) not null,
  estimated_unit_cost numeric(14, 2),
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.purchase_orders (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  supplier_id uuid not null,
  order_number varchar(32) not null,
  requisition_id uuid,
  ordered_on date not null,
  expected_on date,
  status public.purchase_order_status default 'draft' not null,
  subtotal numeric(14, 2) default '0.00' not null,
  tax numeric(14, 2) default '0.00' not null,
  total numeric(14, 2) default '0.00' not null,
  issued_by uuid,
  issued_at timestamp with time zone,
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

create table public.purchase_order_items (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  order_id uuid not null,
  item_id uuid not null,
  quantity numeric(14, 3) not null,
  unit_cost numeric(14, 2) not null,
  received_quantity numeric(14, 3) default '0.000' not null,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.goods_receipts (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  order_id uuid not null,
  received_on date not null,
  received_by uuid not null,
  note varchar(1000),
  journal_entry_id uuid,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.goods_receipt_items (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  receipt_id uuid not null,
  order_item_id uuid not null,
  quantity numeric(14, 3) not null,
  unit_cost numeric(14, 2) not null,
  store_id uuid not null,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

-- -------------------------------------------------------------------------------------
-- Foreign keys. `restrict` throughout for institutional parents; `cascade` only where the
-- child is genuinely owned by its parent (requisition items by their requisition, order
-- items by their order, receipt items by their receipt).
-- -------------------------------------------------------------------------------------

alter table public.item_categories
  add constraint item_categories_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint item_categories_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint item_categories_parent_id_item_categories_id_fk
    foreign key (parent_id) references public.item_categories(id) on delete restrict;

alter table public.items
  add constraint items_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint items_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint items_category_id_item_categories_id_fk
    foreign key (category_id) references public.item_categories(id) on delete restrict;

alter table public.stores
  add constraint stores_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint stores_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint stores_campus_id_campuses_id_fk
    foreign key (campus_id) references public.campuses(id) on delete restrict,
  add constraint stores_keeper_employee_id_employees_id_fk
    foreign key (keeper_employee_id) references public.employees(id) on delete restrict;

alter table public.suppliers
  add constraint suppliers_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint suppliers_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict;

alter table public.stock_movements
  add constraint stock_movements_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint stock_movements_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint stock_movements_item_id_items_id_fk
    foreign key (item_id) references public.items(id) on delete restrict,
  add constraint stock_movements_store_id_stores_id_fk
    foreign key (store_id) references public.stores(id) on delete restrict;

alter table public.stock_levels
  add constraint stock_levels_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint stock_levels_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint stock_levels_item_id_items_id_fk
    foreign key (item_id) references public.items(id) on delete restrict,
  add constraint stock_levels_store_id_stores_id_fk
    foreign key (store_id) references public.stores(id) on delete restrict;

alter table public.purchase_requisitions
  add constraint purchase_requisitions_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint purchase_requisitions_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict;

alter table public.requisition_items
  add constraint requisition_items_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint requisition_items_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint requisition_items_requisition_id_purchase_requisitions_id_fk
    foreign key (requisition_id) references public.purchase_requisitions(id) on delete cascade,
  add constraint requisition_items_item_id_items_id_fk
    foreign key (item_id) references public.items(id) on delete restrict;

alter table public.purchase_orders
  add constraint purchase_orders_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint purchase_orders_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint purchase_orders_supplier_id_suppliers_id_fk
    foreign key (supplier_id) references public.suppliers(id) on delete restrict,
  add constraint purchase_orders_requisition_id_purchase_requisitions_id_fk
    foreign key (requisition_id) references public.purchase_requisitions(id) on delete restrict;

alter table public.purchase_order_items
  add constraint purchase_order_items_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint purchase_order_items_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint purchase_order_items_order_id_purchase_orders_id_fk
    foreign key (order_id) references public.purchase_orders(id) on delete cascade,
  add constraint purchase_order_items_item_id_items_id_fk
    foreign key (item_id) references public.items(id) on delete restrict;

alter table public.goods_receipts
  add constraint goods_receipts_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint goods_receipts_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint goods_receipts_order_id_purchase_orders_id_fk
    foreign key (order_id) references public.purchase_orders(id) on delete restrict;

alter table public.goods_receipt_items
  add constraint goods_receipt_items_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint goods_receipt_items_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint goods_receipt_items_receipt_id_goods_receipts_id_fk
    foreign key (receipt_id) references public.goods_receipts(id) on delete cascade,
  add constraint goods_receipt_items_order_item_id_purchase_order_items_id_fk
    foreign key (order_item_id) references public.purchase_order_items(id) on delete restrict,
  add constraint goods_receipt_items_store_id_stores_id_fk
    foreign key (store_id) references public.stores(id) on delete restrict;

-- -------------------------------------------------------------------------------------
-- Indexes. Business uniqueness is partial (`where archived_at is null`) so an archived
-- code becomes reusable; document numbers (purchase orders) are never reused, so theirs is
-- total. `stock_levels_item_store_key` is total because a level row is a running balance —
-- and it is the ON CONFLICT target of the movement trigger's upsert.
-- -------------------------------------------------------------------------------------

create unique index if not exists item_categories_institution_name_key
  on public.item_categories using btree (institution_id, name_en) where archived_at is null;
create index if not exists item_categories_tenant_idx
  on public.item_categories using btree (tenant_id);
create index if not exists item_categories_parent_idx
  on public.item_categories using btree (parent_id);

create unique index if not exists items_institution_code_key
  on public.items using btree (institution_id, code) where archived_at is null;
create index if not exists items_tenant_idx
  on public.items using btree (tenant_id);
create index if not exists items_category_idx
  on public.items using btree (category_id);
create index if not exists items_institution_status_idx
  on public.items using btree (institution_id, status);

create unique index if not exists stores_institution_code_key
  on public.stores using btree (institution_id, code) where archived_at is null;
create index if not exists stores_tenant_idx
  on public.stores using btree (tenant_id);
create index if not exists stores_campus_idx
  on public.stores using btree (campus_id);
create index if not exists stores_keeper_idx
  on public.stores using btree (keeper_employee_id);

create unique index if not exists suppliers_institution_code_key
  on public.suppliers using btree (institution_id, code) where archived_at is null;
create index if not exists suppliers_tenant_idx
  on public.suppliers using btree (tenant_id);
create index if not exists suppliers_institution_status_idx
  on public.suppliers using btree (institution_id, status);

create index if not exists stock_movements_tenant_idx
  on public.stock_movements using btree (tenant_id);
create index if not exists stock_movements_item_store_idx
  on public.stock_movements using btree (item_id, store_id, moved_on);
create index if not exists stock_movements_store_idx
  on public.stock_movements using btree (store_id);
create index if not exists stock_movements_reference_idx
  on public.stock_movements using btree (reference_type, reference_id);
create index if not exists stock_movements_institution_kind_idx
  on public.stock_movements using btree (institution_id, kind);

create unique index if not exists stock_levels_item_store_key
  on public.stock_levels using btree (item_id, store_id);
create index if not exists stock_levels_tenant_idx
  on public.stock_levels using btree (tenant_id);
create index if not exists stock_levels_store_idx
  on public.stock_levels using btree (store_id);

create index if not exists purchase_requisitions_tenant_idx
  on public.purchase_requisitions using btree (tenant_id);
create index if not exists purchase_requisitions_institution_status_idx
  on public.purchase_requisitions using btree (institution_id, status);
create index if not exists purchase_requisitions_requested_by_idx
  on public.purchase_requisitions using btree (requested_by);

create unique index if not exists requisition_items_requisition_item_key
  on public.requisition_items using btree (requisition_id, item_id) where archived_at is null;
create index if not exists requisition_items_tenant_idx
  on public.requisition_items using btree (tenant_id);
create index if not exists requisition_items_item_idx
  on public.requisition_items using btree (item_id);

create unique index if not exists purchase_orders_institution_number_key
  on public.purchase_orders using btree (institution_id, order_number);
create index if not exists purchase_orders_tenant_idx
  on public.purchase_orders using btree (tenant_id);
create index if not exists purchase_orders_supplier_idx
  on public.purchase_orders using btree (supplier_id);
create index if not exists purchase_orders_institution_status_idx
  on public.purchase_orders using btree (institution_id, status);
create index if not exists purchase_orders_requisition_idx
  on public.purchase_orders using btree (requisition_id);

create unique index if not exists purchase_order_items_order_item_key
  on public.purchase_order_items using btree (order_id, item_id) where archived_at is null;
create index if not exists purchase_order_items_tenant_idx
  on public.purchase_order_items using btree (tenant_id);
create index if not exists purchase_order_items_item_idx
  on public.purchase_order_items using btree (item_id);

create index if not exists goods_receipts_tenant_idx
  on public.goods_receipts using btree (tenant_id);
create index if not exists goods_receipts_order_idx
  on public.goods_receipts using btree (order_id);

create index if not exists goods_receipt_items_tenant_idx
  on public.goods_receipt_items using btree (tenant_id);
create index if not exists goods_receipt_items_receipt_idx
  on public.goods_receipt_items using btree (receipt_id);
create index if not exists goods_receipt_items_order_item_idx
  on public.goods_receipt_items using btree (order_item_id);
create index if not exists goods_receipt_items_store_idx
  on public.goods_receipt_items using btree (store_id);

-- -------------------------------------------------------------------------------------
-- Check constraints — the invariants that belong in the database, not only in Zod.
-- -------------------------------------------------------------------------------------

alter table public.items
  add constraint items_reorder_level_non_negative check (reorder_level >= 0);

alter table public.stock_levels
  -- THE non-negative-stock guarantee. The level is maintained by the movement trigger in
  -- the movement's own transaction, so an over-issue fails here even from raw SQL.
  add constraint stock_levels_quantity_non_negative check (quantity >= 0);

alter table public.stock_movements
  -- Only an adjustment carries a sign (a count can find stock as well as lose it); every
  -- other kind is strictly positive and its kind expresses the direction.
  add constraint stock_movements_quantity_shape check (
    (kind = 'adjustment' and quantity <> 0)
    or (kind <> 'adjustment' and quantity > 0)
  ),
  -- Valuation cost enters the system on receipts; a receipt without a cost is unpriceable.
  add constraint stock_movements_receipt_has_cost check (
    kind <> 'receipt' or unit_cost is not null
  ),
  add constraint stock_movements_cost_non_negative check (
    unit_cost is null or unit_cost >= 0
  ),
  -- A correction or loss with no stated reason is unaccountable.
  add constraint stock_movements_correction_has_reason check (
    kind not in ('adjustment', 'write_off')
    or (reason is not null and char_length(btrim(reason)) > 0)
  ),
  -- The two halves of a transfer share a reference id, so they can be paired later.
  add constraint stock_movements_transfer_has_reference check (
    kind not in ('transfer_in', 'transfer_out') or reference_id is not null
  );

alter table public.purchase_requisitions
  add constraint purchase_requisitions_justification_present check (
    char_length(btrim(justification)) > 0
  ),
  add constraint purchase_requisitions_submitted_recorded check (
    status = 'draft' or submitted_at is not null
  ),
  add constraint purchase_requisitions_decision_recorded check (
    status in ('draft', 'submitted', 'cancelled')
    or (decided_by is not null and decided_at is not null)
  );

alter table public.requisition_items
  add constraint requisition_items_quantity_positive check (quantity > 0),
  add constraint requisition_items_cost_non_negative check (
    estimated_unit_cost is null or estimated_unit_cost >= 0
  );

alter table public.purchase_orders
  add constraint purchase_orders_amounts_non_negative check (
    subtotal >= 0 and tax >= 0 and total >= 0
  ),
  add constraint purchase_orders_total_is_derived check (total = subtotal + tax),
  add constraint purchase_orders_issued_recorded check (
    status in ('draft', 'cancelled') or issued_at is not null
  ),
  add constraint purchase_orders_cancel_requires_reason check (
    status <> 'cancelled'
    or (cancelled_reason is not null and cancelled_by is not null and cancelled_at is not null)
  );

alter table public.purchase_order_items
  add constraint purchase_order_items_quantity_positive check (quantity > 0),
  add constraint purchase_order_items_cost_non_negative check (unit_cost >= 0),
  -- Received quantity may never exceed ordered quantity — restated here so a service bug
  -- (or raw SQL) cannot over-receive.
  add constraint purchase_order_items_received_within_ordered check (
    received_quantity >= 0 and received_quantity <= quantity
  );

alter table public.goods_receipt_items
  add constraint goods_receipt_items_quantity_positive check (quantity > 0),
  add constraint goods_receipt_items_cost_non_negative check (unit_cost >= 0);

-- -------------------------------------------------------------------------------------
-- Trigger 1: stock_movements is append-only. Same pattern as workflow_actions (0014):
-- the migrator is exempt (data fixes under change control), everyone else is refused.
-- -------------------------------------------------------------------------------------

create or replace function inventory_stock_movements_reject_mutation() returns trigger
language plpgsql
as $$
begin
  if pg_has_role(current_user, 'shikkha_migrator', 'MEMBER') then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  raise exception
    'stock_movements is append-only; correct a mistake with a compensating movement. % is not permitted for role %',
    tg_op, current_user
    using errcode = 'insufficient_privilege';
end
$$;

drop trigger if exists inventory_stock_movements_no_mutation on public.stock_movements;
create trigger inventory_stock_movements_no_mutation
  before update or delete on public.stock_movements
  for each row execute function inventory_stock_movements_reject_mutation();

-- -------------------------------------------------------------------------------------
-- Trigger 2: stock_levels is derived — refuse every writer except the movement trigger.
-- The handshake is a transaction-local setting only inventory_stock_movements_apply()
-- flips on (and immediately back off). The migrator is exempt so seeding and controlled
-- repairs remain possible.
-- -------------------------------------------------------------------------------------

create or replace function inventory_stock_levels_guard_write() returns trigger
language plpgsql
as $$
begin
  if pg_has_role(current_user, 'shikkha_migrator', 'MEMBER') then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  if coalesce(current_setting('app.inventory_stock_writer', true), '') = 'on' then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  raise exception
    'stock_levels is derived from stock_movements; write a movement instead of %-ing the level directly',
    tg_op
    using errcode = 'insufficient_privilege';
end
$$;

drop trigger if exists inventory_stock_levels_guard on public.stock_levels;
create trigger inventory_stock_levels_guard
  before insert or update or delete on public.stock_levels
  for each row execute function inventory_stock_levels_guard_write();

-- -------------------------------------------------------------------------------------
-- Trigger 3: every inserted movement is applied to its level row in the same transaction.
-- The upsert's arbiter is stock_levels_item_store_key; a negative outcome fails the
-- stock_levels_quantity_non_negative check, which aborts the movement insert itself —
-- stock cannot go negative even under concurrency, because the level row is take-locked
-- by the upsert.
-- -------------------------------------------------------------------------------------

create or replace function inventory_stock_movements_apply() returns trigger
language plpgsql
as $$
declare
  delta numeric(14, 3);
begin
  delta := case new.kind
    when 'receipt' then new.quantity
    when 'return' then new.quantity
    when 'transfer_in' then new.quantity
    when 'adjustment' then new.quantity
    when 'issue' then -new.quantity
    when 'transfer_out' then -new.quantity
    when 'write_off' then -new.quantity
  end;

  perform set_config('app.inventory_stock_writer', 'on', true);

  insert into public.stock_levels
    (id, tenant_id, institution_id, item_id, store_id, quantity, created_by, updated_by)
  values
    (gen_random_uuid(), new.tenant_id, new.institution_id, new.item_id, new.store_id,
     delta, new.created_by, new.created_by)
  on conflict (item_id, store_id) do update
    set quantity = public.stock_levels.quantity + excluded.quantity,
        updated_by = excluded.updated_by;

  perform set_config('app.inventory_stock_writer', 'off', true);

  return null;
end
$$;

drop trigger if exists inventory_stock_movements_apply_level on public.stock_movements;
create trigger inventory_stock_movements_apply_level
  after insert on public.stock_movements
  for each row execute function inventory_stock_movements_apply();

-- -------------------------------------------------------------------------------------
-- Row-level security, grants and updated_at for the new tables. The catalogue loop in
-- 0002 does not re-run for tables created later, so it is restated here.
-- -------------------------------------------------------------------------------------

do $$
declare
  target text;
  inventory_tables constant text[] := array[
    'item_categories',
    'items',
    'stores',
    'suppliers',
    'stock_movements',
    'stock_levels',
    'purchase_requisitions',
    'requisition_items',
    'purchase_orders',
    'purchase_order_items',
    'goods_receipts',
    'goods_receipt_items'
  ];
begin
  foreach target in array inventory_tables
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
      'item_categories', 'items', 'stores', 'suppliers', 'stock_movements', 'stock_levels',
      'purchase_requisitions', 'requisition_items', 'purchase_orders', 'purchase_order_items',
      'goods_receipts', 'goods_receipt_items'
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
      'Inventory tables without forced row-level security and a tenant_isolation policy: %',
      offending;
  end if;

  -- Every one of the twelve must also carry the tenant column the policy reads. A policy on
  -- a table without `tenant_id` would fail at query time, not here.
  select string_agg(t.name, ', ' order by t.name)
  into offending
  from unnest(array[
    'item_categories', 'items', 'stores', 'suppliers', 'stock_movements', 'stock_levels',
    'purchase_requisitions', 'requisition_items', 'purchase_orders', 'purchase_order_items',
    'goods_receipts', 'goods_receipt_items'
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
    raise exception 'Inventory tables without a tenant_id column: %', offending;
  end if;

  -- The append-only and derived-level triggers must exist; without them stock_levels is an
  -- ordinary writable table and the movement log is editable history.
  if not exists (
    select 1 from pg_trigger
    where tgname = 'inventory_stock_movements_no_mutation'
      and tgrelid = 'public.stock_movements'::regclass
  ) then
    raise exception 'stock_movements append-only trigger is missing';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'inventory_stock_levels_guard'
      and tgrelid = 'public.stock_levels'::regclass
  ) then
    raise exception 'stock_levels derived-write guard trigger is missing';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'inventory_stock_movements_apply_level'
      and tgrelid = 'public.stock_movements'::regclass
  ) then
    raise exception 'stock_movements level-maintenance trigger is missing';
  end if;
end
$$;

-- The global sweep: every public table is either RLS-protected or explicitly exempt.
select assert_rls_coverage();
