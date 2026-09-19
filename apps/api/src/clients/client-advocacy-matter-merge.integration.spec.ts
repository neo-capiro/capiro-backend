import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { ClientAdvocacyMatterService } from './client-advocacy-matter.service.js';

/**
 * Native-SQL regression for mergeMatters provenance preservation, run
 * against the REAL migrated tables (not temp-table stand-ins) so the INSERT
 * ... SELECT column list is validated against the live schema — a mocked
 * test cannot catch "column exists in the list but not in the table" or a
 * constraint violation the merge would hit for real.
 *
 * Gated on MERGE_TEST_DATABASE_URL (root's disposable nativePG55464 with
 * migrations applied). Creates its own tenant/client/matters/links with
 * random ids and cleans them up afterwards; touches no application data.
 *
 * What it proves (against the pre-fix SQL, this FAILED with silent column
 * drops — the link rows arrived on the target with relationship_type,
 * confidence, provenance, evidence_class all NULL):
 *   1. A source-Matter link carrying full provenance keeps every column
 *      after merge.
 *   2. The unique (matter_id, link_type, link_key) dedup keeps the TARGET's
 *      row on collision and does not error.
 *   3. The source Matter is deleted and its records move.
 */
const databaseUrl = process.env.MERGE_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase('mergeMatters provenance — native SQL against migrated schema', () => {
  let db: PrismaClient;
  const tenantId = randomUUID();
  const clientId = randomUUID();
  const userId = randomUUID();
  const targetMatterId = randomUUID();
  const sourceMatterId = randomUUID();
  const recordId = randomUUID();
  const ctx = { tenantId, userId } as never;

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    // Minimal FK parents. clients.tenant_id -> tenants.id and
    // client_advocacy_matter.client_id -> clients.id are the chain the
    // matter/link tables hang off; insert the thinnest valid rows.
    await db.$executeRawUnsafe(
      `INSERT INTO tenants (id, name, slug) VALUES ($1::uuid, 'merge-test tenant', $2) ON CONFLICT (id) DO NOTHING`,
      tenantId,
      `merge-test-${tenantId.slice(0, 8)}`,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO clients (id, tenant_id, name, status) VALUES ($1::uuid, $2::uuid, 'merge-test client', 'active')`,
      clientId,
      tenantId,
    );
    for (const [id, title] of [
      [targetMatterId, 'target matter'],
      [sourceMatterId, 'source matter'],
    ] as const) {
      await db.$executeRawUnsafe(
        `INSERT INTO client_advocacy_matter (id, tenant_id, client_id, title, matter_type, status, external_key, auto_generated)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'other', 'active', $5, false)`,
        id,
        tenantId,
        clientId,
        title,
        `manual:test:${id}`,
      );
    }
  }, 60_000);

  afterAll(async () => {
    await db.$executeRawUnsafe(`DELETE FROM client_advocacy_record WHERE tenant_id = $1::uuid`, tenantId);
    await db.$executeRawUnsafe(`DELETE FROM client_advocacy_matter_link WHERE tenant_id = $1::uuid`, tenantId);
    await db.$executeRawUnsafe(`DELETE FROM client_advocacy_matter WHERE tenant_id = $1::uuid`, tenantId);
    await db.$executeRawUnsafe(`DELETE FROM clients WHERE id = $1::uuid`, clientId);
    await db.$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, tenantId);
    await db.$disconnect();
  }, 60_000);

  test('a source link keeps relationship_type/confidence/provenance/evidence_class through the merge', async () => {
    // One link on the SOURCE with every provenance column populated.
    await db.$executeRawUnsafe(
      `INSERT INTO client_advocacy_matter_link
         (tenant_id, matter_id, link_type, link_key, label, relationship_type, confidence, provenance, evidence_class, metadata_jsonb, created_by_user_id)
       VALUES ($1::uuid, $2::uuid, 'bill', '119-hr-1234', 'HR 1234', 'supports', 0.8750, 'Meri matched bill sponsor to committee', 'PUBLIC_VERIFIED', '{"note":"kept"}'::jsonb, $3::uuid)`,
      tenantId,
      sourceMatterId,
      userId,
    );
    // One colliding link already on the TARGET with the SAME
    // (link_type, link_key) — the merge's ON CONFLICT must keep the
    // target's row (its provenance wins) and must not error or duplicate.
    await db.$executeRawUnsafe(
      `INSERT INTO client_advocacy_matter_link
         (tenant_id, matter_id, link_type, link_key, label, relationship_type, confidence, provenance, evidence_class, metadata_jsonb, created_by_user_id)
       VALUES ($1::uuid, $2::uuid, 'bill', '119-hr-9999', 'HR 9999', 'planned_action', 0.5000, 'target original', 'INFERRED', '{"note":"target"}'::jsonb, $3::uuid)`,
      tenantId,
      targetMatterId,
      userId,
    );
    // Same (link_type, link_key) on the SOURCE — this is the real collision
    // the ON CONFLICT clause exists for. The source's provenance must lose.
    await db.$executeRawUnsafe(
      `INSERT INTO client_advocacy_matter_link
         (tenant_id, matter_id, link_type, link_key, label, relationship_type, confidence, provenance, evidence_class, metadata_jsonb, created_by_user_id)
       VALUES ($1::uuid, $2::uuid, 'bill', '119-hr-9999', 'HR 9999 (source copy)', 'supports', 0.9999, 'source duplicate that must lose', 'PUBLIC_VERIFIED', '{"note":"source"}'::jsonb, $3::uuid)`,
      tenantId,
      sourceMatterId,
      userId,
    );
    // A record on the source matter that must move.
    await db.$executeRawUnsafe(
      `INSERT INTO client_advocacy_record
         (id, tenant_id, client_id, record_type, title, source_type, evidence_class, confidence, external_key, matter_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'federal_lobbying', 'source record', 'manual', 'CLIENT_VERIFIED', 1, $4, $5::uuid)`,
      recordId,
      tenantId,
      clientId,
      `manual:test:record:${recordId}`,
      sourceMatterId,
    );

    const service = new ClientAdvocacyMatterService(
      { withTenant: (_t: string, run: (tx: never) => Promise<unknown>) => db.$transaction(async (tx) => run(tx as never)) } as never,
      {} as never,
    );

    await service.mergeMatters(ctx, clientId, targetMatterId, sourceMatterId);

    const links = await db.$queryRawUnsafe<
      Array<{ linkKey: string; relationshipType: string | null; confidence: string | null; provenance: string | null; evidenceClass: string | null; metadata: unknown }>
    >(
      `SELECT link_key AS "linkKey", relationship_type AS "relationshipType", confidence::text, provenance,
              evidence_class AS "evidenceClass", metadata_jsonb AS metadata
         FROM client_advocacy_matter_link
        WHERE tenant_id = $1::uuid AND matter_id = $2::uuid ORDER BY link_key`,
      tenantId,
      targetMatterId,
    );

    const moved = links.find((l) => l.linkKey === '119-hr-1234');
    expect(moved).toBeDefined();
    expect(moved!.relationshipType).toBe('supports');
    expect(Number(moved!.confidence)).toBeCloseTo(0.875, 4);
    expect(moved!.provenance).toBe('Meri matched bill sponsor to committee');
    expect(moved!.evidenceClass).toBe('PUBLIC_VERIFIED');
    expect((moved!.metadata as { note: string }).note).toBe('kept');

    // The target's own link survives the SAME-KEY collision untouched.
    const kept = links.find((l) => l.linkKey === '119-hr-9999');
    expect(kept).toBeDefined();
    expect(kept!.provenance).toBe('target original');
    expect(Number(kept!.confidence)).toBeCloseTo(0.5, 4);
    // Exactly one row for the collided key — ON CONFLICT deduped, target won.
    expect(links.filter((l) => l.linkKey === '119-hr-9999')).toHaveLength(1);

    // The source record moved LOCKED (a human merge is a human Matter
    // assignment; a later auto-cluster must not undo it) and the source
    // matter is gone.
    const record = await db.$queryRawUnsafe<Array<{ matterId: string; locked: boolean }>>(
      `SELECT matter_id AS "matterId", matter_locked AS locked FROM client_advocacy_record WHERE id = $1::uuid`,
      recordId,
    );
    expect(record[0]!.matterId).toBe(targetMatterId);
    expect(record[0]!.locked).toBe(true);
    const sourceGone = await db.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM client_advocacy_matter WHERE id = $1::uuid`,
      sourceMatterId,
    );
    expect(sourceGone).toHaveLength(0);
  }, 60_000);
});
