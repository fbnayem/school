/**
 * Knowledge base integration suite (Phase 31, docs/06 §5).
 *
 * This file exists to hold the retrieval-safety properties, not to prove the routes return
 * 200. Everything that matters here is a property a bug would break silently:
 *
 *  - a document really is chunked, embedded and searchable — asserted against the `vector`
 *    column itself in raw SQL, not against the API's own report of its own work;
 *  - a citation is exact: every stored chunk is byte-for-byte `source.slice(charFrom, charTo)`;
 *  - below the similarity floor, retrieval returns NOTHING, because docs/06 §5 says an answer
 *    with no citation is reported as "not found in your school's documents";
 *  - the embedding cache means re-ingesting unchanged text makes ZERO provider calls, proved
 *    by counting `ai_usage_events` around the call;
 *  - a staff-only collection is unreachable from a student's session, proved through the API
 *    and again in raw SQL as the unprivileged `shikkha_app` role;
 *  - one tenant's vectors are invisible to another, including to a raw SQL vector search.
 *
 * ── Why the fixtures look like this ───────────────────────────────────────────────────
 *
 * The embedding provider under test is the mock adapter (`AI_PROVIDER` defaults to `mock`),
 * which is a **deterministic feature-hashing embedder**: word and character-trigram features
 * hashed into a signed, L2-normalised vector. That has two consequences the fixtures are
 * designed around.
 *
 * First, identical text always embeds identically, so a query that *is* a chunk scores exactly
 * 1.0 against it. That makes the exact-match assertions real rather than lucky.
 *
 * Second, any two English paragraphs share common trigrams, so "unrelated" English text has a
 * measurable floor of similarity — around 0.30 against these fixtures, which is exactly where
 * the production default sits. Relying on the default floor to reject unrelated *English*
 * would therefore make this suite's outcome depend on the fixture's prose rather than on the
 * mechanism under test. So the negative case uses Bangla text, which shares neither words nor
 * trigrams with the corpus and scores ~0.00, and a second negative case pins `minScore`
 * explicitly. Both assert the same mechanism: below the floor, nothing comes back.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Client } from 'pg';
import { uuidv7 } from '@shikkha/shared';
import {
  createTestApp,
  seedTenant,
  testClient,
  truncateAll,
  TEST_APP_DATABASE_URL,
  TEST_PASSWORD,
  type SeededTenant,
} from '../helpers/test-app';
import { normalizeText } from '../../src/modules/knowledge/text-extraction';

// ── Fixtures ──────────────────────────────────────────────────────────────────────────

/** Staff-only. Nothing in it shares vocabulary with the syllabus. */
const STAFF_HANDBOOK = `# Staff Handbook

## Disciplinary Procedure for Employees

An employee who is subject to a formal warning must be informed in writing within seven working days. The written warning states the conduct concerned, the standard expected, and the period of review.

A second formal warning within twelve months escalates the matter to the governing body. The governing body may suspend the employee on full pay while the investigation proceeds.

## Salary Review and Increment

Salary increments are reviewed annually in December. An increment is not automatic; it follows the appraisal record and the approved payroll budget for the coming year.`;

/** Visible to staff, teaching and student audiences. */
const SYLLABUS = `# Class Six Mathematics Syllabus

## Chapter One: Fractions and Decimals

Students learn to add, subtract, multiply and divide fractions with unlike denominators. Converting a fraction to a decimal, and a decimal back to a fraction, is practised until it is automatic.

## Chapter Two: Simple Geometry

The chapter covers triangles, quadrilaterals and circles. Students measure angles with a protractor and calculate the perimeter and the area of each shape.

## Chapter Three: Introduction to Algebra

Algebra begins with letters standing for unknown numbers. Students solve one step equations such as x plus five equals twelve, and learn to check an answer by substitution.`;

/** Shares vocabulary with Chapter Two and with nothing else. Not a copy of it. */
const GEOMETRY_QUESTION =
  'measure angles with a protractor and calculate the perimeter and area of a triangle';

/** Shares vocabulary with the handbook's disciplinary section and with nothing else. */
const DISCIPLINARY_QUESTION = 'a formal warning escalates the matter to the governing body';

/** Neither words nor trigrams in common with the corpus: the honest "nothing here" query. */
const UNRELATED_QUESTION = 'মুদ্রাস্ফীতি এবং বৈদেশিক মুদ্রার বিনিময় হার কীভাবে নির্ধারিত হয়';

/** The dimension the schema is built for; `AI_EMBEDDING_DIMENSIONS` defaults to the same. */
const EXPECTED_DIMENSIONS = 1536;

interface SearchResultBody {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  collectionId: string;
  collectionName: string;
  seq: number;
  excerpt: string;
  headingPath: string | null;
  charFrom: number;
  charTo: number;
  score: number;
}

describe('Knowledge base — tenant-isolated retrieval with pgvector', () => {
  let app: INestApplication;
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;
  const tokens: Record<string, string> = {};

  let staffCollectionId: string;
  let syllabusCollectionId: string;
  let handbookDocId: string;
  let syllabusDocId: string;
  let tenantBDocId: string;

  async function login(email: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ identifier: email, password: TEST_PASSWORD });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return response.body.accessToken as string;
  }

  const asTenant = (tenant: SeededTenant) => ({
    get: (role: string, path: string, query: Record<string, unknown> = {}) =>
      request(app.getHttpServer())
        .get(path)
        .query(query)
        .set('Authorization', `Bearer ${tokens[role]}`)
        .set('x-institution-id', tenant.institutionId),
    post: (role: string, path: string, body: object = {}) =>
      request(app.getHttpServer())
        .post(path)
        .set('Authorization', `Bearer ${tokens[role]}`)
        .set('x-institution-id', tenant.institutionId)
        .send(body),
    patch: (role: string, path: string, body: object = {}) =>
      request(app.getHttpServer())
        .patch(path)
        .set('Authorization', `Bearer ${tokens[role]}`)
        .set('x-institution-id', tenant.institutionId)
        .send(body),
  });

  let a: ReturnType<typeof asTenant>;
  let b: ReturnType<typeof asTenant>;

  /**
   * Run a callback as the unprivileged application role inside one transaction with the
   * tenant GUC set — exactly the credentials a compromised application would hold. RLS is
   * the thing under test, so nothing here may run as the migrator.
   */
  async function asAppRole<T>(tenantId: string, fn: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: TEST_APP_DATABASE_URL });
    await client.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
      return await fn(client);
    } finally {
      await client.query('rollback').catch(() => undefined);
      await client.end();
    }
  }

  /** Read-only inspection as the owner role, for assertions about rows the API hides. */
  async function asMigrator<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const client = testClient();
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  /**
   * `seedTenant` creates staff and guardian logins but no student login, and the audience
   * rule under test is precisely "which kind of person is this". The student user reuses an
   * existing password hash rather than running argon2 again — the KDF is not what this suite
   * is testing, and hashing costs seconds.
   */
  async function createStudentUser(tenant: SeededTenant, email: string): Promise<string> {
    await asMigrator(async (client) => {
      const userId = uuidv7();
      await client.query(
        `insert into users (id, tenant_id, email, password_hash, full_name_en, status, email_verified_at)
         select $1, $2, $3, u.password_hash, $4, 'active', now()
           from users u where u.id = $5`,
        [userId, tenant.tenantId, email, 'Knowledge Suite Student', tenant.users['owner']!.id],
      );
      await client.query(
        `insert into user_roles (id, tenant_id, user_id, role_id, institution_id)
         values ($1,$2,$3,$4,$5)`,
        [uuidv7(), tenant.tenantId, userId, tenant.roleIds['student'], tenant.institutionId],
      );
    });
    return email;
  }

  async function countUsageEvents(institutionId: string): Promise<number> {
    return asMigrator(async (client) => {
      const { rows } = await client.query<{ n: number }>(
        `select count(*)::int as n from ai_usage_events where institution_id = $1`,
        [institutionId],
      );
      return rows[0]!.n;
    });
  }

  interface ChunkRow {
    id: string;
    seq: number;
    content: string;
    char_from: number;
    char_to: number;
    heading_path: string | null;
    embedding_is_null: boolean;
    dims: number | null;
    archived: boolean;
    document_version: number;
  }

  async function chunksOf(documentId: string, opts: { live?: boolean } = {}): Promise<ChunkRow[]> {
    return asMigrator(async (client) => {
      const { rows } = await client.query<ChunkRow>(
        `select id::text,
                seq,
                content,
                char_from,
                char_to,
                heading_path,
                (embedding is null) as embedding_is_null,
                case when embedding is null then null else vector_dims(embedding) end as dims,
                (archived_at is not null) as archived,
                document_version
           from knowledge_chunks
          where document_id = $1
            ${opts.live ? 'and archived_at is null' : ''}
          order by document_version, seq`,
        [documentId],
      );
      return rows;
    });
  }

  beforeAll(async () => {
    app = await createTestApp();
    await truncateAll();
    tenantA = await seedTenant('knla', { students: 2 });
    tenantB = await seedTenant('knlb', { students: 2 });
    a = asTenant(tenantA);
    b = asTenant(tenantB);

    const studentEmail = await createStudentUser(tenantA, 'knla-student@knla.test');

    // `school_owner` holds `*`, so it carries ai.knowledge_base.manage and ai.copilot.use.
    tokens['owner'] = await login(tenantA.users['owner']!.email);
    // `teacher` audience is `teaching` and holds ai.copilot.use but not knowledge_base.manage.
    tokens['teacher'] = await login(tenantA.users['teacher']!.email);
    // `student` audience is `student` and holds ai.tutor.use only.
    tokens['student'] = await login(studentEmail);
    tokens['otherOwner'] = await login(tenantB.users['owner']!.email);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Collections
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('collections and audience visibility', () => {
    it('creates a staff-only collection and a collection students may search', async () => {
      const staff = await a.post('owner', '/api/v1/knowledge/collections', {
        slug: 'staff-handbook',
        nameEn: 'Staff Handbook',
        nameBn: 'কর্মী নির্দেশিকা',
        description: 'Employment policy, discipline and pay.',
        visibleToAudiences: ['staff'],
      });
      expect(staff.status, JSON.stringify(staff.body)).toBe(201);
      expect(staff.body.visibleToAudiences).toEqual(['staff']);
      staffCollectionId = staff.body.id;

      const syllabus = await a.post('owner', '/api/v1/knowledge/collections', {
        slug: 'class-six-syllabus',
        nameEn: 'Class Six Syllabus',
        visibleToAudiences: ['staff', 'teaching', 'student'],
      });
      expect(syllabus.status, JSON.stringify(syllabus.body)).toBe(201);
      syllabusCollectionId = syllabus.body.id;
    });

    it('refuses a collection nobody may search', async () => {
      const response = await a.post('owner', '/api/v1/knowledge/collections', {
        slug: 'nobody',
        nameEn: 'Unreachable',
        visibleToAudiences: [],
      });
      // 422 from the schema: an empty audience list is an invisible collection, not a safe
      // default, and the database restates the same rule as a check constraint.
      expect(response.status).toBe(422);
    });

    it('refuses a duplicate handle in the same institution', async () => {
      const response = await a.post('owner', '/api/v1/knowledge/collections', {
        slug: 'staff-handbook',
        nameEn: 'Another Handbook',
        visibleToAudiences: ['staff'],
      });
      expect(response.status).toBe(409);
    });

    it('a caller who cannot manage the knowledge base sees only their own audience’s collections', async () => {
      const teacher = await a.get('teacher', '/api/v1/knowledge/collections');
      expect(teacher.status, JSON.stringify(teacher.body)).toBe(200);
      const slugs = (teacher.body.data as { slug: string }[]).map((row) => row.slug);
      // `teaching`, so the syllabus is listed and the staff handbook is not even named.
      expect(slugs).toContain('class-six-syllabus');
      expect(slugs).not.toContain('staff-handbook');

      const owner = await a.get('owner', '/api/v1/knowledge/collections');
      expect(owner.status).toBe(200);
      expect((owner.body.data as { slug: string }[]).map((row) => row.slug)).toEqual(
        expect.arrayContaining(['staff-handbook', 'class-six-syllabus']),
      );
    });

    it('records the previous audience list when visibility is narrowed', async () => {
      const before = await a.get('owner', '/api/v1/knowledge/collections', { q: 'Class Six' });
      const collection = (before.body.data as { id: string; version: number }[])[0]!;

      const response = await a.patch(
        'owner',
        `/api/v1/knowledge/collections/${collection.id}`,
        { description: 'The mathematics syllabus for class six.', version: collection.version },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      // `__audit` is internal plumbing and must never reach the wire.
      expect(response.body).not.toHaveProperty('__audit');

      const audit = await asMigrator(async (client) => {
        const { rows } = await client.query<{ previous_value: unknown; is_ai_initiated: boolean }>(
          `select previous_value, is_ai_initiated
             from audit_logs
            where module = 'knowledge'
              and resource_type = 'knowledge_collection'
              and action = 'update'
              and resource_id = $1
            order by occurred_at desc limit 1`,
          [collection.id],
        );
        return rows[0];
      });
      expect(audit).toBeDefined();
      // A human edited a collection; no model was involved.
      expect(audit!.is_ai_initiated).toBe(false);
      expect(audit!.previous_value).toHaveProperty('description');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Ingestion
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('ingestion: extract → chunk → embed → store', () => {
    it('ingests a document to ready and writes real embeddings of the expected dimension', async () => {
      const response = await a.post('owner', '/api/v1/knowledge/documents', {
        collectionId: syllabusCollectionId,
        title: 'Class Six Mathematics Syllabus',
        sourceKind: 'text',
        text: SYLLABUS,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.status).toBe('ready');
      expect(response.body.failureReason).toBeNull();
      expect(response.body.chunkCount).toBeGreaterThan(1);
      expect(response.body.ingestedAt).toBeTruthy();
      syllabusDocId = response.body.id;

      // The API's own report is not evidence. The vector column is.
      const chunks = await chunksOf(syllabusDocId, { live: true });
      expect(chunks.length).toBe(response.body.chunkCount);
      for (const chunk of chunks) {
        expect(chunk.embedding_is_null, `chunk ${chunk.seq} has no embedding`).toBe(false);
        expect(chunk.dims).toBe(EXPECTED_DIMENSIONS);
        expect(chunk.archived).toBe(false);
      }
    });

    it('every chunk is an exact slice of the source, so a citation can be highlighted', async () => {
      const source = normalizeText(SYLLABUS);
      const chunks = await chunksOf(syllabusDocId, { live: true });
      for (const chunk of chunks) {
        expect(
          source.slice(chunk.char_from, chunk.char_to),
          `chunk ${chunk.seq} offsets do not reproduce its content`,
        ).toBe(chunk.content);
      }
      // Structure was actually used: the headings became citation paths.
      expect(chunks.some((chunk) => (chunk.heading_path ?? '').includes('Simple Geometry'))).toBe(
        true,
      );
    });

    it('ingests the staff handbook into the staff-only collection', async () => {
      const response = await a.post('owner', '/api/v1/knowledge/documents', {
        collectionId: staffCollectionId,
        title: 'Staff Handbook',
        sourceKind: 'text',
        text: STAFF_HANDBOOK,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.status).toBe('ready');
      handbookDocId = response.body.id;
    });

    it('refuses a PDF by name instead of ingesting an empty document', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/knowledge/documents')
        .set('Authorization', `Bearer ${tokens['owner']}`)
        .set('x-institution-id', tenantA.institutionId)
        .field('collectionId', syllabusCollectionId)
        .field('title', 'A scanned circular')
        .field('sourceKind', 'upload')
        .attach('file', Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj\n'), 'circular.pdf');

      // 501, and the message names the format: a silent empty ingestion would tell a
      // principal their circular is searchable when it is not.
      expect(response.status, JSON.stringify(response.body)).toBe(501);
      expect(JSON.stringify(response.body)).toContain('PDF');

      const documents = await a.get('owner', '/api/v1/knowledge/documents', {
        q: 'A scanned circular',
      });
      expect(documents.body.meta.total).toBe(0);
    });

    it('ingests an uploaded Markdown file through the storage module', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/knowledge/documents')
        .set('Authorization', `Bearer ${tokens['owner']}`)
        .set('x-institution-id', tenantA.institutionId)
        .field('collectionId', staffCollectionId)
        .field('title', 'Leave Policy')
        .field('sourceKind', 'upload')
        .attach(
          'file',
          Buffer.from(
            '# Leave Policy\n\n## Casual Leave\n\nTen days of casual leave accrue each calendar year and lapse if unused.\n',
            'utf8',
          ),
          'leave-policy.md',
        );
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.status).toBe('ready');
      expect(response.body.storageObjectKey).toContain(`tenants/${tenantA.tenantId}/`);
      expect(response.body.fileId).toBeTruthy();
    });

    it('marks the ingestion audit row AI-initiated, and the upload row not', async () => {
      const rows = await asMigrator(async (client) => {
        const { rows } = await client.query<{
          action: string;
          is_ai_initiated: boolean;
          new_value: Record<string, unknown>;
        }>(
          `select action, is_ai_initiated, new_value
             from audit_logs
            where module = 'knowledge'
              and resource_type = 'knowledge_document'
              and resource_id = $1
            order by occurred_at`,
          [syllabusDocId],
        );
        return rows;
      });

      const create = rows.find((row) => row.action === 'create');
      const pipeline = rows.find((row) => row.action === 'update');
      expect(create, 'the human upload must be on the record').toBeDefined();
      expect(create!.is_ai_initiated).toBe(false);
      // A model produced the vectors, and docs/06 §6 wants that answerable years later.
      expect(pipeline, 'the pipeline outcome must be on the record').toBeDefined();
      expect(pipeline!.is_ai_initiated).toBe(true);
      expect(pipeline!.new_value['status']).toBe('ready');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Retrieval
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('search: ranking, the floor, and citations', () => {
    it('returns the exact chunk for a query that is that chunk', async () => {
      const chunks = await chunksOf(syllabusDocId, { live: true });
      const geometry = chunks.find((chunk) =>
        (chunk.heading_path ?? '').includes('Simple Geometry'),
      )!;

      const response = await a.post('owner', '/api/v1/knowledge/search', {
        query: geometry.content,
        limit: 5,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);

      const results = response.body.results as SearchResultBody[];
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.chunkId).toBe(geometry.id);
      // Identical text embeds identically, so this is 1.0 and not a coincidence.
      expect(results[0]!.score).toBeGreaterThan(0.99);
      expect(response.body.belowFloor).toBe(false);
    });

    it('finds the right section for a related but different question', async () => {
      const response = await a.post('owner', '/api/v1/knowledge/search', {
        query: GEOMETRY_QUESTION,
        limit: 5,
      });
      expect(response.status).toBe(201);

      const results = response.body.results as SearchResultBody[];
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.documentId).toBe(syllabusDocId);
      expect(results[0]!.excerpt).toContain('perimeter');
      expect(results[0]!.headingPath).toContain('Simple Geometry');
    });

    it('every result carries a citation: document, title, section and offsets', async () => {
      const source = normalizeText(SYLLABUS);
      const response = await a.post('owner', '/api/v1/knowledge/search', {
        query: GEOMETRY_QUESTION,
        limit: 5,
      });
      const results = response.body.results as SearchResultBody[];

      for (const result of results) {
        expect(result.documentId).toBeTruthy();
        expect(result.documentTitle).toBeTruthy();
        expect(result.chunkId).toBeTruthy();
        expect(result.collectionName).toBeTruthy();
        expect(result.charTo).toBeGreaterThan(result.charFrom);
        if (result.documentId === syllabusDocId) {
          // The offsets are not decoration: they index the document the citation names.
          expect(source.slice(result.charFrom, result.charTo)).toBe(result.excerpt);
        }
      }
    });

    it('returns NOTHING when nothing clears the floor, rather than the least-bad chunk', async () => {
      const response = await a.post('owner', '/api/v1/knowledge/search', {
        query: UNRELATED_QUESTION,
        limit: 5,
      });
      expect(response.status).toBe(201);
      expect(response.body.results).toEqual([]);
      // The signal the copilot turns into "not found in your school's documents".
      expect(response.body.belowFloor).toBe(true);
    });

    it('honours a raised floor, and refuses to be talked below the configured one', async () => {
      const raised = await a.post('owner', '/api/v1/knowledge/search', {
        query: 'the monsoon flooded the cricket pitch last August',
        limit: 5,
        minScore: 0.9,
      });
      expect(raised.status).toBe(201);
      expect(raised.body.results).toEqual([]);
      expect(raised.body.minScore).toBe(0.9);

      // A client asking for zero gets the configured floor, not zero.
      const lowered = await a.post('owner', '/api/v1/knowledge/search', {
        query: UNRELATED_QUESTION,
        limit: 5,
        minScore: 0,
      });
      expect(lowered.status).toBe(201);
      expect(lowered.body.minScore).toBeGreaterThan(0);
      expect(lowered.body.results).toEqual([]);
    });

    it('logs a search as an export, because a search is data egress', async () => {
      await a.post('owner', '/api/v1/knowledge/search', {
        query: GEOMETRY_QUESTION,
        limit: 3,
      });

      const row = await asMigrator(async (client) => {
        const { rows } = await client.query<{ action: string; new_value: Record<string, unknown> }>(
          `select action, new_value
             from audit_logs
            where module = 'knowledge' and resource_type = 'knowledge_search'
            order by occurred_at desc limit 1`,
        );
        return rows[0];
      });
      expect(row, 'a retrieval must leave a trail').toBeDefined();
      expect(row!.action).toBe('export');
      expect(JSON.stringify(row!.new_value)).toContain('protractor');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // The embedding cache
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('the embedding cache', () => {
    it('re-ingesting identical content makes no provider call at all', async () => {
      const before = await countUsageEvents(tenantA.institutionId);
      expect(before, 'the first ingestion must have cost something').toBeGreaterThan(0);

      const response = await a.post(
        'owner',
        `/api/v1/knowledge/documents/${syllabusDocId}/reingest`,
        { text: SYLLABUS },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.status).toBe('ready');
      expect(response.body.contentVersion).toBe(2);

      const after = await countUsageEvents(tenantA.institutionId);
      // The whole point: identical text is served from the cache, so not one token is billed.
      expect(after).toBe(before);

      const cache = await asMigrator(async (client) => {
        const { rows } = await client.query<{ n: number; hits: number }>(
          `select count(*)::int as n, coalesce(sum(hit_count), 0)::int as hits
             from knowledge_embedding_cache where institution_id = $1`,
          [tenantA.institutionId],
        );
        return rows[0]!;
      });
      expect(cache.n).toBeGreaterThan(0);
      expect(cache.hits).toBeGreaterThan(0);
    });

    it('keeps the previous chunk version instead of deleting it', async () => {
      const all = await chunksOf(syllabusDocId);
      const archived = all.filter((chunk) => chunk.archived);
      const live = all.filter((chunk) => !chunk.archived);

      expect(archived.length).toBeGreaterThan(0);
      expect(archived.every((chunk) => chunk.document_version === 1)).toBe(true);
      expect(live.every((chunk) => chunk.document_version === 2)).toBe(true);
      // Search only ever sees the live version.
      const response = await a.post('owner', '/api/v1/knowledge/search', {
        query: GEOMETRY_QUESTION,
        limit: 10,
      });
      const ids = (response.body.results as SearchResultBody[]).map((result) => result.chunkId);
      expect(ids.some((id) => archived.some((chunk) => chunk.id === id))).toBe(false);
    });

    it('does not let one institution’s cache answer for another’s identical text', async () => {
      const before = await countUsageEvents(tenantB.institutionId);

      const collection = await b.post('otherOwner', '/api/v1/knowledge/collections', {
        slug: 'class-six-syllabus',
        nameEn: 'Class Six Syllabus',
        visibleToAudiences: ['staff', 'teaching', 'student'],
      });
      expect(collection.status, JSON.stringify(collection.body)).toBe(201);

      const document = await b.post('otherOwner', '/api/v1/knowledge/documents', {
        collectionId: collection.body.id,
        title: 'Class Six Mathematics Syllabus',
        // Byte-identical to tenant A's document: the content hashes are the same.
        sourceKind: 'text',
        text: SYLLABUS,
      });
      expect(document.status, JSON.stringify(document.body)).toBe(201);
      tenantBDocId = document.body.id;

      const after = await countUsageEvents(tenantB.institutionId);
      // The hash matches tenant A's cache rows and MUST NOT be served from them: a cache
      // keyed on a hash alone is an oracle for confirming another school's private text.
      expect(after).toBeGreaterThan(before);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Audience filtering
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('audience filtering', () => {
    it('a staff caller retrieves the handbook', async () => {
      const response = await a.post('owner', '/api/v1/knowledge/search', {
        query: DISCIPLINARY_QUESTION,
        limit: 5,
      });
      expect(response.status).toBe(201);
      const results = response.body.results as SearchResultBody[];
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.documentId).toBe(handbookDocId);
    });

    it('a student session can search, but never the staff-only collection', async () => {
      // The student's tutor can find the syllabus — so an empty answer below is a decision,
      // not an inability to search at all.
      const allowed = await a.post('student', '/api/v1/knowledge/search', {
        query: GEOMETRY_QUESTION,
        limit: 5,
      });
      expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);
      expect((allowed.body.results as SearchResultBody[]).length).toBeGreaterThan(0);

      // The identical query that just returned the handbook for staff returns nothing here.
      const denied = await a.post('student', '/api/v1/knowledge/search', {
        query: DISCIPLINARY_QUESTION,
        limit: 5,
      });
      expect(denied.status).toBe(201);
      const denialIds = (denied.body.results as SearchResultBody[]).map((r) => r.documentId);
      expect(denialIds).not.toContain(handbookDocId);
    });

    it('a student cannot even name a staff-only document', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/knowledge/documents/${handbookDocId}`)
        .set('Authorization', `Bearer ${tokens['student']}`)
        .set('x-institution-id', tenantA.institutionId);
      // 404 rather than 403: confirming the document exists is itself the disclosure. (The
      // route requires ai.copilot.use, which a student lacks, so a 403 is also correct — the
      // assertion is that it is never a 200.)
      expect([403, 404]).toContain(response.status);
      expect(JSON.stringify(response.body)).not.toContain('Disciplinary');
    });

    it('the audience filter holds in raw SQL as the application role', async () => {
      const staffChunk = (await chunksOf(handbookDocId, { live: true }))[0]!;

      await asAppRole(tenantA.tenantId, async (client) => {
        // The same vector search the service runs, with a student's audiences. The chunk's
        // own embedding is the query, so similarity is 1.0 and only the audience predicate
        // can be the reason a row is missing.
        const studentVisible = await client.query<{ n: number }>(
          `select count(*)::int as n
             from knowledge_chunks c
             join knowledge_collections k on k.id = c.collection_id
            where c.institution_id = $1
              and c.archived_at is null
              and k.archived_at is null
              and k.visible_to_audiences && '{student}'::public.knowledge_audience[]
              and (1 - (c.embedding <=> (select embedding from knowledge_chunks where id = $2))) > 0.99`,
          [tenantA.institutionId, staffChunk.id],
        );
        expect(studentVisible.rows[0]!.n).toBe(0);

        const staffVisible = await client.query<{ n: number }>(
          `select count(*)::int as n
             from knowledge_chunks c
             join knowledge_collections k on k.id = c.collection_id
            where c.institution_id = $1
              and c.archived_at is null
              and k.archived_at is null
              and k.visible_to_audiences && '{staff}'::public.knowledge_audience[]
              and (1 - (c.embedding <=> (select embedding from knowledge_chunks where id = $2))) > 0.99`,
          [tenantA.institutionId, staffChunk.id],
        );
        expect(staffVisible.rows[0]!.n).toBeGreaterThan(0);
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Tenant isolation
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('tenant isolation', () => {
    it('another tenant cannot borrow the institution header', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/knowledge/documents')
        .set('Authorization', `Bearer ${tokens['otherOwner']}`)
        .set('x-institution-id', tenantA.institutionId);
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('another tenant naming a document exactly gets a 404, not its title', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/knowledge/documents/${syllabusDocId}`)
        .set('Authorization', `Bearer ${tokens['otherOwner']}`)
        .set('x-institution-id', tenantB.institutionId);
      expect(response.status).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain('Chapter Two');
    });

    it('another tenant’s search finds only its own corpus', async () => {
      const response = await b.post('otherOwner', '/api/v1/knowledge/search', {
        query: DISCIPLINARY_QUESTION,
        limit: 10,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const documentIds = (response.body.results as SearchResultBody[]).map((r) => r.documentId);
      // Tenant B never ingested the handbook, and tenant A's copy is not reachable.
      expect(documentIds).not.toContain(handbookDocId);
      for (const id of documentIds) expect(id).toBe(tenantBDocId);
    });

    it('a raw SQL vector search under the other tenant’s GUC returns zero rows', async () => {
      const embedding = await asMigrator(async (client) => {
        const { rows } = await client.query<{ embedding: string }>(
          `select embedding::text as embedding
             from knowledge_chunks
            where document_id = $1 and archived_at is null
            order by seq limit 1`,
          [handbookDocId],
        );
        return rows[0]!.embedding;
      });

      await asAppRole(tenantB.tenantId, async (client) => {
        // Tenant B has its own chunks, so a zero here is isolation rather than an empty table.
        const own = await client.query<{ n: number }>(
          `select count(*)::int as n from knowledge_chunks`,
        );
        expect(own.rows[0]!.n).toBeGreaterThan(0);

        const leaked = await client.query<{ n: number }>(
          `select count(*)::int as n from knowledge_chunks where document_id = $1`,
          [handbookDocId],
        );
        expect(leaked.rows[0]!.n).toBe(0);

        // The exact vector of tenant A's handbook chunk finds nothing: its own row would score
        // 1.0, and it is not visible under this GUC.
        const nearest = await client.query<{ n: number }>(
          `select count(*)::int as n
             from knowledge_chunks
            where embedding is not null
              and (1 - (embedding <=> $1::public.vector)) > 0.9`,
          [embedding],
        );
        expect(nearest.rows[0]!.n).toBe(0);
      });

      // And the embedding cache is isolated the same way, for the same reason.
      await asAppRole(tenantB.tenantId, async (client) => {
        const { rows } = await client.query<{ n: number }>(
          `select count(*)::int as n from knowledge_embedding_cache where institution_id = $1`,
          [tenantA.institutionId],
        );
        expect(rows[0]!.n).toBe(0);
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Archival
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('archival', () => {
    it('a document is archived, never deleted, and leaves search immediately', async () => {
      const before = await chunksOf(handbookDocId);
      expect(before.length).toBeGreaterThan(0);

      const found = await a.post('owner', '/api/v1/knowledge/search', {
        query: DISCIPLINARY_QUESTION,
        limit: 5,
      });
      expect((found.body.results as SearchResultBody[])[0]!.documentId).toBe(handbookDocId);

      const archive = await a.post(
        'owner',
        `/api/v1/knowledge/documents/${handbookDocId}/archive`,
        { reason: 'Superseded by the 2027 edition of the staff handbook.' },
      );
      expect(archive.status, JSON.stringify(archive.body)).toBe(201);
      expect(archive.body.archivedAt).toBeTruthy();
      expect(archive.body.archivedChunks).toBeGreaterThan(0);

      const after = await chunksOf(handbookDocId);
      // Every row survives; none of them is live.
      expect(after.length).toBe(before.length);
      expect(after.every((chunk) => chunk.archived)).toBe(true);

      const gone = await a.post('owner', '/api/v1/knowledge/search', {
        query: DISCIPLINARY_QUESTION,
        limit: 5,
      });
      const ids = (gone.body.results as SearchResultBody[]).map((result) => result.documentId);
      expect(ids).not.toContain(handbookDocId);

      const listed = await a.get('owner', '/api/v1/knowledge/documents', {
        collectionId: staffCollectionId,
      });
      expect((listed.body.data as { id: string }[]).map((row) => row.id)).not.toContain(
        handbookDocId,
      );
    });

    it('refuses to archive without a reason', async () => {
      const response = await a.post(
        'owner',
        `/api/v1/knowledge/documents/${syllabusDocId}/archive`,
        {},
      );
      // 422 with the field path, from the audit interceptor's `requiresReason`.
      expect(response.status).toBe(422);
      const stillLive = await a.get('owner', `/api/v1/knowledge/documents/${syllabusDocId}`);
      expect(stillLive.body.archivedAt).toBeNull();
    });

    it('archiving a collection takes its documents and chunks with it', async () => {
      const response = await a.post(
        'owner',
        `/api/v1/knowledge/collections/${syllabusCollectionId}/archive`,
        { reason: 'The class six syllabus was replaced for the 2027 academic year.' },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.archivedDocuments).toBeGreaterThan(0);
      expect(response.body.archivedChunks).toBeGreaterThan(0);

      const search = await a.post('owner', '/api/v1/knowledge/search', {
        query: GEOMETRY_QUESTION,
        limit: 10,
      });
      expect(
        (search.body.results as SearchResultBody[]).map((result) => result.documentId),
      ).not.toContain(syllabusDocId);

      // Nothing was destroyed: tenant A's rows are all still there, archived.
      const rows = await asMigrator(async (client) => {
        const { rows } = await client.query<{ n: number; live: number }>(
          `select count(*)::int as n,
                  count(*) filter (where archived_at is null)::int as live
             from knowledge_chunks where institution_id = $1`,
          [tenantA.institutionId],
        );
        return rows[0]!;
      });
      expect(rows.n).toBeGreaterThan(0);
      // Only the uploaded leave policy, which lives in the staff collection, is still live.
      expect(rows.live).toBeGreaterThan(0);
    });
  });
});
