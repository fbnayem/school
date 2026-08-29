-- =====================================================================================
-- 0033 — Tenant-isolated knowledge base with pgvector (Phase 31, docs/06 §5)
--
-- WHY THE VECTORS LIVE HERE, IN THIS DATABASE
--
-- Retrieval for the copilot and the tutor runs over embeddings of a school's own policies,
-- handbooks, syllabus, notices and admission rules. Those documents are as confidential as
-- any student record, and an embedding is not an anonymisation of the text it came from.
--
-- So the embeddings go in the SAME PostgreSQL database as everything else, and the SAME
-- row-level security applies to them as to every other row. A dedicated vector service
-- (Pinecone, Qdrant, a second Postgres) would be a SECOND tenant-isolation implementation
-- to get right, to keep right through every refactor, and to prove right in every audit —
-- and there is no reason to have two. One `tenant_isolation` policy, forced, on every table
-- in the system, is the whole security argument; adding a store that sits outside it would
-- replace a property with a promise.
--
-- Four tables:
--
--   knowledge_collections      a named body of documents, with the audiences allowed to
--                              search it. A staff handbook must not be retrievable from a
--                              student's tutor session, so visibility is data, not code.
--   knowledge_documents        one ingested source. Archived, never deleted (ADR-008).
--   knowledge_chunks           the retrievable units, with their embeddings and the
--                              offsets a citation needs. Append-only per document version.
--   knowledge_embedding_cache  content_hash → embedding, so re-ingesting unchanged text
--                              costs nothing. Tenant- AND institution-scoped; see below.
--
-- No money column exists in this module: token cost is attributed by the ai module's usage
-- log, which owns the `numeric(14, 4)` figures (ADR-004).
--
-- The RLS/grants/updated_at loop from 0002 does not re-run for tables created later, so it
-- is restated at the bottom, followed by named assertions and assert_rls_coverage().
-- =====================================================================================

-- -------------------------------------------------------------------------------------
-- The pgvector extension.
--
-- No earlier migration installs it — 0002's `search_vector` columns are `tsvector`, which is
-- built-in full-text search and an entirely different type despite the similar name. The
-- check below is therefore expected to take the `create` branch on a fresh database, and to
-- take the no-op branch on a database where an operator installed it by hand.
--
-- `create extension` is issued unqualified rather than `if not exists` so that the two cases
-- are distinguishable in the migration log. pgvector marks itself `trusted`, so the database
-- owner (`shikkha_migrator`) can install it without superuser rights; the development image
-- is pgvector/pgvector:pg17, which ships the extension files.
-- -------------------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_extension where extname = 'vector') then
    raise notice 'pgvector is already installed; leaving it alone';
  else
    create extension vector;
  end if;
end
$$;

-- -------------------------------------------------------------------------------------
-- Enumerations.
--
-- `knowledge_audience` deliberately mirrors `roles.audience` value for value. The audience a
-- collection is visible to is compared against the audiences of the caller's own roles, and
-- an identity mapping means there is no translation table between the two vocabularies to
-- get wrong, and no value in one that has no home in the other. If `roles.audience` ever
-- gains a value, this enum must gain it in the same migration or the new audience silently
-- sees nothing (fail-closed, but confusing).
-- -------------------------------------------------------------------------------------

create type public.knowledge_audience as enum (
  'staff', 'teaching', 'student', 'guardian', 'external'
);

/* Where the text came from. 'upload' carries bytes in object storage, 'url' records where
   the text was fetched from, 'text' is pasted directly into the API. */
create type public.knowledge_source_kind as enum ('upload', 'url', 'text');

/* The ingestion pipeline's stages, in order, plus its two terminal states. Stored rather
   than inferred so a document stuck part-way through is visible instead of merely absent
   from search results. */
create type public.knowledge_document_status as enum (
  'pending', 'extracting', 'chunking', 'embedding', 'ready', 'failed'
);

-- -------------------------------------------------------------------------------------
-- Tables
-- -------------------------------------------------------------------------------------

create table public.knowledge_collections (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null references public.organizations (id) on delete restrict,
  institution_id uuid not null references public.institutions (id) on delete restrict,
  slug varchar(64) not null,
  name_en varchar(160) not null,
  name_bn varchar(160),
  description varchar(1000),
  -- Which audiences may retrieve from this collection. An array rather than a single value
  -- because a syllabus is legitimately for teachers AND students, while a staff handbook is
  -- for neither of the other two.
  visible_to_audiences public.knowledge_audience[] default array['staff']::public.knowledge_audience[] not null,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.knowledge_documents (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null references public.organizations (id) on delete restrict,
  institution_id uuid not null references public.institutions (id) on delete restrict,
  collection_id uuid not null references public.knowledge_collections (id) on delete restrict,
  title varchar(300) not null,
  source_kind public.knowledge_source_kind not null,
  -- The object-storage key, produced by the storage module (tenant-prefixed there, never
  -- here). Denormalised alongside `file_id` so a re-ingestion can fetch the bytes without
  -- joining `files`; `file_id` remains the authorization record and the row the orphan
  -- sweeper reads, exactly as for a library cover or a student document.
  storage_object_key varchar(512),
  file_id uuid references public.files (id) on delete set null,
  source_url varchar(2000),
  -- SHA-256 of the EXTRACTED TEXT, not of the uploaded bytes: two uploads of the same policy
  -- in different file formats should be recognised as the same content to embed.
  content_hash varchar(64) not null,
  byte_size integer,
  language varchar(16),
  status public.knowledge_document_status default 'pending' not null,
  failure_reason varchar(1000),
  -- Incremented on every successful re-ingestion. Chunks are append-only per version: the
  -- previous version's rows are archived, never updated in place, so a citation issued last
  -- month still resolves to the text that was actually retrieved.
  content_version integer default 1 not null,
  chunk_count integer default 0 not null,
  token_count integer default 0 not null,
  ingested_at timestamp with time zone,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.knowledge_chunks (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null references public.organizations (id) on delete restrict,
  institution_id uuid not null references public.institutions (id) on delete restrict,
  -- Denormalised from the document. The search path filters by collection (for the audience
  -- check) and orders by vector distance in one statement; carrying the collection here keeps
  -- that a single index-qualified scan instead of a join the planner must push a vector
  -- ordering through. A trigger is not needed because a chunk never moves between documents.
  collection_id uuid not null references public.knowledge_collections (id) on delete restrict,
  document_id uuid not null references public.knowledge_documents (id) on delete restrict,
  document_version integer default 1 not null,
  seq integer not null,
  content text not null,
  -- SHA-256 of `content`. The embedding cache's lookup key, so identical text — the same
  -- boilerplate paragraph in two circulars — is embedded once.
  content_hash varchar(64) not null,
  -- An ESTIMATE (see the chunker), used for budgeting chunk sizes. Authoritative token counts
  -- for cost attribution come from the provider's usage response, not from here.
  token_count integer not null,
  -- 1536 is a NUMERIC LITERAL, matching the default AI_EMBEDDING_DIMENSIONS. It is not a
  -- parameter: pgvector fixes the dimension in the column type, and a different embedding
  -- model does not merely need a wider column — every stored vector becomes meaningless
  -- because it lives in a different space. Changing models therefore requires a re-embed
  -- migration (new column, re-ingest every document, swap, drop), never an ALTER COLUMN.
  embedding public.vector(1536),
  embedding_model varchar(128),
  -- Citation anchors, in the coordinates of the extracted text. Character offsets are always
  -- present; page numbers only for paginated sources.
  char_from integer not null,
  char_to integer not null,
  page_from integer,
  page_to integer,
  -- The heading trail the chunk sits under ("Admissions > Fees > Refunds"), captured by the
  -- structural pass so a citation can name the section, not just an offset.
  heading_path varchar(500),
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.knowledge_embedding_cache (
  id uuid primary key default gen_random_uuid() not null,
  -- Tenant- AND institution-scoped, which is the entire point of this table's shape.
  --
  -- A content hash is a global fact: the same paragraph of text hashes the same everywhere.
  -- A cache keyed on the hash ALONE would therefore be reachable across tenants, and that is
  -- an oracle: a competitor could hash a guess at School A's confidential admission policy,
  -- find a cache hit, and learn that School A holds exactly that text. The saving is not
  -- worth the disclosure, so the key includes the institution and RLS covers the table like
  -- any other.
  tenant_id uuid not null references public.organizations (id) on delete restrict,
  institution_id uuid not null references public.institutions (id) on delete restrict,
  content_hash varchar(64) not null,
  model varchar(128) not null,
  dimensions integer not null,
  embedding public.vector(1536) not null,
  hit_count integer default 0 not null,
  last_used_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

-- -------------------------------------------------------------------------------------
-- Indexes
-- -------------------------------------------------------------------------------------

create unique index if not exists knowledge_collections_institution_slug_key
  on public.knowledge_collections using btree (institution_id, slug) where archived_at is null;
create index if not exists knowledge_collections_tenant_idx
  on public.knowledge_collections using btree (tenant_id);
-- GIN over the audience array, so `visible_to_audiences && $1` is an index scan rather than
-- a filter once a school has many collections.
create index if not exists knowledge_collections_audience_idx
  on public.knowledge_collections using gin (visible_to_audiences);

create index if not exists knowledge_documents_tenant_idx
  on public.knowledge_documents using btree (tenant_id);
create index if not exists knowledge_documents_collection_idx
  on public.knowledge_documents using btree (collection_id, status);
create index if not exists knowledge_documents_institution_status_idx
  on public.knowledge_documents using btree (institution_id, status);
-- Re-ingesting an unchanged file should be recognisable without reading every row.
create index if not exists knowledge_documents_content_hash_idx
  on public.knowledge_documents using btree (institution_id, content_hash);

create unique index if not exists knowledge_chunks_document_version_seq_key
  on public.knowledge_chunks using btree (document_id, document_version, seq);
create index if not exists knowledge_chunks_tenant_idx
  on public.knowledge_chunks using btree (tenant_id);
-- The pre-filter for every search: live chunks of one institution's collections.
create index if not exists knowledge_chunks_live_idx
  on public.knowledge_chunks using btree (institution_id, collection_id)
  where archived_at is null;
create index if not exists knowledge_chunks_content_hash_idx
  on public.knowledge_chunks using btree (tenant_id, content_hash);

/*
 * THE VECTOR INDEX. HNSW, not IVFFlat.
 *
 * The tradeoff, stated so the next person does not have to re-derive it:
 *
 *   IVFFlat partitions the vectors into `lists` clusters and probes a few of them. It builds
 *   fast and uses little memory, but the number of lists must be chosen for the corpus size
 *   (√rows is the usual rule) and RE-CHOSEN — meaning a reindex — as the corpus grows. It
 *   also cannot be built usefully on an empty table, and every one of these tables starts
 *   empty on the day a school signs up. An index whose quality silently decays as data
 *   arrives is the wrong default for a multi-tenant product where nobody is watching each
 *   tenant's corpus size.
 *
 *   HNSW builds a navigable graph. It costs more to build and more memory to hold, but its
 *   recall does not depend on a parameter that has to track the row count, and it is correct
 *   on an empty table from the first insert.
 *
 * At the scale this product actually sees — a school's policies, handbook, syllabus and
 * notices are tens of thousands of chunks, not tens of millions — HNSW's memory cost is
 * irrelevant and its maintenance-free behaviour is worth everything. IVFFlat becomes the
 * right choice somewhere north of roughly 5–10 million vectors in this table, where HNSW's
 * build time and resident memory start to dominate and a scheduled reindex is affordable
 * because someone is already operating the cluster closely.
 *
 * `vector_cosine_ops` because the search ranks by cosine distance (`<=>`); an index built for
 * L2 would simply not be used by that operator.
 *
 * NOTE ON RLS AND ANN. An approximate index returns its nearest candidates and the RLS policy
 * (plus the institution/collection/archived filters) is applied to them afterwards, so a
 * naive `order by embedding <=> $1 limit 10` could return fewer than ten rows for the caller.
 * The service compensates: it raises `hnsw.ef_search` for the statement and over-fetches, and
 * for a single institution's corpus the filter is selective enough that the planner usually
 * chooses an exact scan anyway. This index exists for the tenant whose corpus outgrows that.
 */
create index if not exists knowledge_chunks_embedding_hnsw_idx
  on public.knowledge_chunks using hnsw (embedding public.vector_cosine_ops);

create unique index if not exists knowledge_embedding_cache_lookup_key
  on public.knowledge_embedding_cache using btree (institution_id, model, content_hash);
create index if not exists knowledge_embedding_cache_tenant_idx
  on public.knowledge_embedding_cache using btree (tenant_id);

-- -------------------------------------------------------------------------------------
-- Check constraints — the invariants that belong in the database, not only in Zod.
-- -------------------------------------------------------------------------------------

alter table public.knowledge_collections
  -- A collection nobody may search is not a safe default, it is an invisible one. Requiring
  -- at least one audience makes "who can read this" a decision somebody made.
  --
  -- `coalesce(..., 0)` is load-bearing and was a real bug in this file before it was tested:
  -- `array_length('{}', 1)` is NULL, not 0, and a CHECK constraint that evaluates to NULL
  -- PASSES. Without the coalesce this constraint accepted exactly the row it exists to refuse.
  add constraint knowledge_collections_audience_not_empty
    check (coalesce(array_length(visible_to_audiences, 1), 0) >= 1);

alter table public.knowledge_documents
  -- A failure must say why. A `failed` row with a null reason is an outage nobody can debug.
  add constraint knowledge_documents_failure_reason_required
    check (status <> 'failed' or failure_reason is not null),
  -- The source kind and the source columns must agree, so no row can claim to be an upload
  -- while pointing at nothing.
  add constraint knowledge_documents_source_coherent
    check (
      (source_kind = 'upload' and storage_object_key is not null)
      or (source_kind = 'url' and source_url is not null)
      or source_kind = 'text'
    ),
  add constraint knowledge_documents_counts_non_negative
    check (chunk_count >= 0 and token_count >= 0),
  add constraint knowledge_documents_content_version_positive
    check (content_version >= 1);

alter table public.knowledge_chunks
  add constraint knowledge_chunks_seq_non_negative check (seq >= 0),
  add constraint knowledge_chunks_token_count_positive check (token_count > 0),
  -- Offsets are the citation. A zero-width or inverted span cannot point at anything.
  add constraint knowledge_chunks_offsets_ordered check (char_to > char_from and char_from >= 0),
  add constraint knowledge_chunks_pages_ordered
    check (page_from is null or page_to is null or page_to >= page_from),
  -- An embedding whose model is unknown cannot be compared with anything, and a model name
  -- with no embedding is a half-written row. Neither is allowed to exist.
  add constraint knowledge_chunks_embedding_model_paired
    check ((embedding is null) = (embedding_model is null));

alter table public.knowledge_embedding_cache
  add constraint knowledge_embedding_cache_hit_count_non_negative check (hit_count >= 0),
  -- Restated on the row as well as in the column type: a cache entry that records a different
  -- dimension than the column holds would mean the model changed without a re-embed.
  add constraint knowledge_embedding_cache_dimensions_expected check (dimensions = 1536);

-- -------------------------------------------------------------------------------------
-- Row-level security, grants and updated_at for the new tables. The catalogue loop in
-- 0002 does not re-run for tables created later, so it is restated here.
-- -------------------------------------------------------------------------------------

do $$
declare
  target text;
  knowledge_tables constant text[] := array[
    'knowledge_collections',
    'knowledge_documents',
    'knowledge_chunks',
    'knowledge_embedding_cache'
  ];
begin
  foreach target in array knowledge_tables
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
  embedding_typmod integer;
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
      'knowledge_collections', 'knowledge_documents', 'knowledge_chunks',
      'knowledge_embedding_cache'
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
      'Knowledge tables without forced row-level security and a tenant_isolation policy: %',
      offending;
  end if;

  -- Every one of the four must also carry the tenant column the policy reads. A policy on a
  -- table without `tenant_id` would fail at query time, not here.
  select string_agg(t.name, ', ' order by t.name)
  into offending
  from unnest(array[
    'knowledge_collections', 'knowledge_documents', 'knowledge_chunks',
    'knowledge_embedding_cache'
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
    raise exception 'Knowledge tables without a tenant_id column: %', offending;
  end if;

  -- The vector index must exist. Without it, retrieval still returns correct answers by
  -- sequential scan — which is why its absence would never show up as a failing test, only
  -- as a school whose copilot times out once their handbook is fully ingested.
  if not exists (
    select 1
    from pg_class i
    join pg_index x on x.indexrelid = i.oid
    join pg_class t on t.oid = x.indrelid
    join pg_namespace n on n.oid = t.relnamespace
    join pg_am am on am.oid = i.relam
    where n.nspname = 'public'
      and t.relname = 'knowledge_chunks'
      and am.amname in ('hnsw', 'ivfflat')
  ) then
    raise exception 'knowledge_chunks has no HNSW or IVFFlat index on its embedding column';
  end if;

  -- pgvector encodes the dimension in the column's typmod. Asserting it here ties the schema
  -- to the AI_EMBEDDING_DIMENSIONS default the service checks at ingest time, so the two
  -- cannot drift apart silently and produce a "different vector dimensions" error only when
  -- the first document is embedded.
  select a.atttypmod
  into embedding_typmod
  from pg_attribute a
  where a.attrelid = 'public.knowledge_chunks'::regclass
    and a.attname = 'embedding';

  if embedding_typmod is distinct from 1536 then
    raise exception
      'knowledge_chunks.embedding must be vector(1536) to match AI_EMBEDDING_DIMENSIONS, found typmod %',
      embedding_typmod;
  end if;
end
$$;

-- The global sweep: every public table is either RLS-protected or explicitly exempt.
select assert_rls_coverage();
