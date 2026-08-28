-- =====================================================================================
-- 0004 — Bangla room names
--
-- `rooms` was the one table with an English name column and no Bangla counterpart, found by
-- the schema conformance test rather than by review. It matters: staff refer to the science
-- lab as "বিজ্ঞান ল্যাব", and a timetable that can only print the English name is a timetable
-- half the school cannot read.
--
-- Nullable, like every other `name_bn`: the English name is required, the Bangla one is
-- supplied where the school has it.
-- =====================================================================================

alter table public.rooms
  add column if not exists name_bn varchar(128);
