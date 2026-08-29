-- =====================================================================================
-- 0031 — Inventory: repair the derived stock-level trigger
--
-- Every outbound stock movement — issue, transfer_out, write_off — was rejected by the
-- database, no matter how much stock was on hand.
--
-- 0025's `inventory_stock_movements_apply` applied the signed delta with a single
-- `insert ... on conflict (item_id, store_id) do update`. That reads as "add the delta to
-- the running balance", and for an inbound movement it behaves that way. For an outbound
-- one it does not: PostgreSQL evaluates a table's CHECK constraints against the *proposed
-- insertion tuple*, before ON CONFLICT arbitration decides the row already exists and the
-- DO UPDATE branch should run instead. The proposed tuple carries the bare negative delta,
-- so `stock_levels_quantity_non_negative` failed on it and aborted the whole movement:
--
--     insert into probe(id, q) values (1, 100) on conflict (id) do update ...;  -- q = 100
--     insert into probe(id, q) values (1, -30) on conflict (id) do update ...;
--     ERROR:  new row for relation "probe" violates check constraint "probe_q_check"
--     DETAIL:  Failing row contains (1, -30.000).
--
-- The balance would have been 70. The check never got to see it.
--
-- The fix separates "make sure the level row exists" from "apply the delta to it":
--
--   1. Insert a ZERO row, `on conflict do nothing`. Zero always satisfies the check, so
--      this step is safe for an outbound movement, and `do nothing` makes it idempotent
--      when two transactions create the same (item, store) level at once.
--   2. `update ... set quantity = quantity + delta`. The update takes a row lock, so
--      concurrent movements against one (item, store) serialise here, and the check now
--      sees the real resulting balance — which is exactly what it was written to guard.
--
-- The guarantees from 0025 are unchanged and now actually reachable: stock_levels stays
-- derived, stock still cannot go negative, and a negative outcome still aborts the
-- movement insert itself rather than leaving a movement without its level effect.
--
-- `create or replace function` rebinds the existing trigger; no data is touched. Level
-- rows cannot have drifted, because the broken path never committed anything.
-- =====================================================================================

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

  -- Step 1: the level row must exist before it can be adjusted. Zero passes the
  -- non-negative check whatever the movement's direction, and `do nothing` absorbs the
  -- race where a concurrent movement created the same level row a moment earlier.
  insert into public.stock_levels
    (id, tenant_id, institution_id, item_id, store_id, quantity, created_by, updated_by)
  values
    (gen_random_uuid(), new.tenant_id, new.institution_id, new.item_id, new.store_id,
     0, new.created_by, new.created_by)
  on conflict (item_id, store_id) do nothing;

  -- Step 2: apply the signed delta to the balance itself. This is the write that
  -- `stock_levels_quantity_non_negative` is meant to police, and now the value it sees is
  -- the resulting balance rather than the delta in isolation.
  update public.stock_levels
     set quantity = quantity + delta,
         updated_by = new.created_by
   where item_id = new.item_id
     and store_id = new.store_id;

  perform set_config('app.inventory_stock_writer', 'off', true);

  return null;
end
$$;

-- -------------------------------------------------------------------------------------
-- Assertions
-- -------------------------------------------------------------------------------------

do $$
declare
  tenant uuid := gen_random_uuid();
  institution uuid := gen_random_uuid();
  item uuid := gen_random_uuid();
  store uuid := gen_random_uuid();
  balance numeric(14, 3);
begin
  -- The trigger must still be attached to the table after the replace.
  if not exists (
    select 1 from pg_trigger
    where tgname = 'inventory_stock_movements_apply_level'
      and tgrelid = 'public.stock_movements'::regclass
      and not tgisinternal
  ) then
    raise exception 'the derived stock-level trigger is missing after the replace';
  end if;

  -- And the outbound path must now reach the balance rather than dying on the delta.
  -- Exercised on a scratch table shaped like stock_levels so the assertion proves the
  -- ordering fix itself without inventing tenant, institution, item or store rows.
  create temp table stock_level_probe (
    item_id uuid not null,
    store_id uuid not null,
    quantity numeric(14, 3) not null,
    constraint stock_level_probe_non_negative check (quantity >= 0),
    constraint stock_level_probe_key unique (item_id, store_id)
  ) on commit drop;

  insert into stock_level_probe (item_id, store_id, quantity)
  values (item, store, 0)
  on conflict (item_id, store_id) do nothing;
  update stock_level_probe set quantity = quantity + 100 where item_id = item and store_id = store;

  insert into stock_level_probe (item_id, store_id, quantity)
  values (item, store, 0)
  on conflict (item_id, store_id) do nothing;
  update stock_level_probe set quantity = quantity + (-30) where item_id = item and store_id = store;

  select quantity into balance from stock_level_probe where item_id = item and store_id = store;
  if balance is distinct from 70.000 then
    raise exception 'the two-step level apply did not produce 70.000 (got %)', balance;
  end if;

  -- ...while an outbound movement that would overdraw is still refused.
  begin
    update stock_level_probe set quantity = quantity + (-999) where item_id = item and store_id = store;
    raise exception 'an overdrawing update was accepted; the non-negative check is not doing its job';
  exception
    when check_violation then null;
  end;

  -- Silence the unused-variable warnings for the identifiers kept for readability.
  perform tenant, institution;
end
$$;
