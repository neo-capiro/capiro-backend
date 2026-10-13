import {
  harness,
  faraRow,
  installHooks,
  now,
  ctx,
  clientId,
  runId,
} from '../../test/fixtures/client-profile-fill-advocacy-history.js';

installHooks();
const sqlText = (value: string) => value.replace(/\s+/g, ' ').trim();
const faraSql = `WITH scored AS (
  SELECT fr.id, fr.registration_number AS "registrationNumber",
    fr.registrant_name AS "registrantName", fr.foreign_principal AS "foreignPrincipal",
    fr.country, fr.status, fr.registration_date AS "registrationDate", fr.description,
    GREATEST(similarity(fr.registrant_name, $1), word_similarity($1, fr.registrant_name))::float
      AS "registrantSimilarity",
    COALESCE(fp.principal_similarity, 0)::float AS "principalSimilarity"
  FROM fara_registration fr LEFT JOIN LATERAL (
    SELECT MAX(GREATEST(similarity(p.principal, $1), word_similarity($1, p.principal)))
      AS principal_similarity
    FROM unnest(string_to_array(fr.foreign_principal, '; ')) AS p(principal)
  ) fp ON true
) SELECT * FROM scored
  WHERE "registrationNumber" = ANY($2::text[])
    OR "registrantSimilarity" >= $3::float OR "principalSimilarity" >= $3::float
  ORDER BY GREATEST("registrantSimilarity", "principalSimilarity") DESC LIMIT 50`;
const match = (value: Record<string, unknown>) =>
  (value.metadata as Record<string, unknown>).clientMatch as Record<string, unknown>;

describe('FARA discovery query and source state', () => {
  it('stops at the shared findings cap before any name or source lookup', async () => {
    const h = harness();
    expect(await h.fara(200)).toEqual({
      count: 0,
      backfill: {
        status: 'in_progress',
        startedAt: now.toISOString(),
        completedAt: undefined,
        checkpoint: null,
        historyStart: null,
        examined: 0,
        candidates: 0,
        lastError: null,
      },
    });
    expect(h.captures.models).toEqual([]);
    expect(h.captures.global).toEqual([]);
    expect(h.captures.tenant).toEqual([]);
  });
  it.each([null, ''])(
    'completes without source or mapping queries for a missing name %p',
    async (clientName) => {
      const h = harness({ clientName });
      expect((await h.fara()).backfill).toMatchObject({
        status: 'complete',
        examined: 0,
        completedAt: now.toISOString(),
      });
      expect(h.captures.models.map((call) => call.operation)).toEqual(['name']);
      expect(h.captures.global).toEqual([]);
    },
  );
  it('uses tenant-scoped name and confirmed mappings with the exact global role-aware query', async () => {
    const h = harness({ confirmedKeys: { fara: ['old-registration', 'second-registration'] } });
    await h.fara();
    expect(h.captures.models.map((call) => call.operation)).toEqual(['name', 'mapping']);
    expect(h.captures.models[0]!.args).toEqual([
      { where: { id: clientId }, select: { id: true, name: true } },
    ]);
    expect(h.captures.models[1]!.args).toEqual([
      { where: { clientId, source: 'fara', confirmed: true }, select: { externalId: true } },
    ]);
    expect(h.captures.models.every((call) => call.tenantId === ctx.tenantId)).toBe(true);
    expect(h.captures.models.every((call) => call.transaction !== null)).toBe(true);
    expect(h.captures.global).toHaveLength(1);
    expect(sqlText(h.captures.global[0]!.sql)).toBe(sqlText(faraSql));
    expect(h.captures.global[0]!).toMatchObject({
      transaction: null,
      args: ['Acme Research', ['old-registration', 'second-registration'], 0.5],
    });
  });
  it('reports an empty global page as complete without fabricating a checkpoint', async () => {
    const h = harness();
    expect(await h.fara()).toEqual({
      count: 0,
      backfill: {
        status: 'complete',
        startedAt: now.toISOString(),
        completedAt: now.toISOString(),
        checkpoint: null,
        historyStart: null,
        examined: 0,
        candidates: 0,
        lastError: null,
      },
    });
    expect(h.captures.findings).toEqual([]);
  });
});

describe('FARA organization attribution', () => {
  it('uses full registrant identity despite a low live score and keeps the match inferred', async () => {
    const h = harness({
      globalRows: {
        fara: [faraRow({ registrantName: 'ACME RESEARCH, Inc.', registrantSimilarity: 0.01 })],
      },
    });
    expect((await h.fara()).count).toBe(1);
    expect(h.captures.findings[0]!).toMatchObject({ factKind: 'recommendation', confidence: 0.95 });
    expect(h.captures.findings[0]!.proposedValue).toMatchObject({
      evidenceClass: 'INFERRED',
      confidence: 0.95,
    });
    expect(match(h.captures.findings[0]!.proposedValue)).toEqual({
      method: 'organization_name',
      confidence: 0.95,
      similarity: 1,
      matchedRole: 'registrant',
    });
  });
  it('matches one complete foreign-principal segment without treating the joined blob as one name', async () => {
    const h = harness({
      globalRows: {
        fara: [
          faraRow({
            registrantName: 'Other Lobbying Firm',
            foreignPrincipal: 'Unrelated Government; Acme Research LLC; Other Organization',
            principalSimilarity: 0.02,
          }),
        ],
      },
    });
    expect((await h.fara()).count).toBe(1);
    expect(match(h.captures.findings[0]!.proposedValue)).toMatchObject({
      matchedRole: 'foreign_principal',
      similarity: 1,
    });
    expect(h.captures.findings[0]!.evidence[0]!.metadata).toMatchObject({
      matchedRole: 'foreign_principal',
    });
  });
  it('prefers the principal identity when both complete organization names match', async () => {
    const h = harness({
      globalRows: {
        fara: [
          faraRow({
            registrantName: 'Acme Research',
            foreignPrincipal: 'Acme Research',
            registrantSimilarity: 0.99,
            principalSimilarity: 0.51,
          }),
        ],
      },
    });
    await h.fara();
    expect(match(h.captures.findings[0]!.proposedValue)).toMatchObject({
      matchedRole: 'foreign_principal',
      similarity: 1,
    });
  });
  it.each([
    { registrantName: 'Acme Research Center', foreignPrincipal: 'Other Organization' },
    {
      registrantName: 'Acme Partners',
      foreignPrincipal: 'Other Acme Research Center; Another Company',
    },
  ])('rejects a high-scoring partial identity %p', async (names) => {
    const h = harness({
      globalRows: {
        fara: [faraRow({ ...names, registrantSimilarity: 0.99, principalSimilarity: 0.99 })],
      },
    });
    expect(await h.fara()).toMatchObject({
      count: 0,
      backfill: { examined: 1, candidates: 0, status: 'complete' },
    });
    expect(h.captures.findings).toEqual([]);
    expect(h.captures.tenant).toEqual([]);
  });
});

describe('FARA confirmed attribution', () => {
  it('bypasses full-name matching and reports the stronger live principal role at full confidence', async () => {
    const h = harness({
      confirmedKeys: { fara: ['reg-1'] },
      globalRows: {
        fara: [
          faraRow({
            registrationNumber: 'reg-1',
            registrantName: 'Unrelated Firm',
            foreignPrincipal: 'Unrelated Principal',
            registrantSimilarity: 0.02,
            principalSimilarity: 0.2,
          }),
        ],
      },
    });
    expect((await h.fara()).count).toBe(1);
    expect(h.captures.findings[0]!).toMatchObject({ factKind: 'fact', confidence: 1 });
    expect(h.captures.findings[0]!.proposedValue).toMatchObject({
      evidenceClass: 'PUBLIC_VERIFIED',
    });
    expect(match(h.captures.findings[0]!.proposedValue)).toEqual({
      method: 'confirmed_client_intel_mapping',
      confidence: 1,
      similarity: null,
      matchedRole: 'foreign_principal',
    });
  });
  it('omits a speculative live role for a confirmed zero-score mapping while retaining evidence metadata', async () => {
    const h = harness({
      confirmedKeys: { fara: ['reg-1'] },
      globalRows: {
        fara: [
          faraRow({ registrationNumber: 'reg-1', registrantSimilarity: 0, principalSimilarity: 0 }),
        ],
      },
    });
    await h.fara();
    expect(match(h.captures.findings[0]!.proposedValue)).toMatchObject({
      matchedRole: null,
      similarity: null,
    });
    expect(h.captures.findings[0]!.evidence[0]!.metadata).toEqual({
      registrationNumber: 'reg-1',
      matchedRole: 'registrant',
    });
  });
  it('keeps the registrant tie-break for confirmed mappings with equal nonzero scores', async () => {
    const h = harness({
      confirmedKeys: { fara: ['reg-1'] },
      globalRows: {
        fara: [
          faraRow({
            registrationNumber: 'reg-1',
            registrantSimilarity: 0.6,
            principalSimilarity: 0.6,
          }),
        ],
      },
    });
    await h.fara();
    expect(match(h.captures.findings[0]!.proposedValue)).toMatchObject({
      matchedRole: 'registrant',
    });
  });
});

describe('FARA finding durability and bounded accounting', () => {
  it('persists the actual discovery envelope and source-specific date, metadata and evidence', async () => {
    const row = faraRow({
      registrationNumber: '5555',
      registrationDate: new Date('2024-03-02T00:00:00Z'),
      country: 'Example',
      status: 'Active',
      description: 'Represented policy matters.',
    });
    const h = harness({ globalRows: { fara: [row] } });
    await h.fara();
    expect(h.captures.findings[0]!).toMatchObject({
      runId,
      tenantId: ctx.tenantId,
      clientId,
      kind: 'advocacy_record',
      targetKey: 'advocacy:fara:5555',
      source: 'advocacy_history',
      factKind: 'recommendation',
      currentValue: null,
      confidence: 0.95,
      status: 'pending',
    });
    expect(h.captures.findings[0]!.proposedValue).toMatchObject({
      externalKey: 'fara:5555',
      recordType: 'fara_registration',
      title: `FARA registration — ${row.registrantName} for ${row.foreignPrincipal}`,
      summary: row.description,
      activityDate: '2024-03-02T00:00:00.000Z',
      status: 'Active',
      outcome: null,
      sourceType: 'fara',
      sourceId: '5555',
      sourceUrl: null,
      metadata: {
        registrationNumber: '5555',
        registrantName: row.registrantName,
        foreignPrincipal: row.foreignPrincipal,
        country: 'Example',
      },
    });
    expect(h.captures.findings[0]!.evidence).toEqual([
      {
        label: `FARA registration — ${row.registrantName} for ${row.foreignPrincipal}`,
        source: 'FARA (Foreign Agents Registration Act) registration',
        metadata: { registrationNumber: '5555', matchedRole: 'registrant' },
      },
    ]);
  });
  it('keeps absent registration dates and descriptions null', async () => {
    const h = harness({
      globalRows: { fara: [faraRow({ registrationDate: null, description: null })] },
    });
    await h.fara();
    expect(h.captures.findings[0]!.proposedValue).toMatchObject({
      activityDate: null,
      summary: null,
    });
  });
});

describe('FARA durable finding writes', () => {
  it('checks terminal history, retires pending other-run copies, then inserts in one tenant transaction', async () => {
    const h = harness({ globalRows: { fara: [faraRow()] } });
    await h.fara();
    expect(h.captures.tenant.map((call) => call.rail)).toEqual(['terminal', 'retire', 'insert']);
    const [terminal, retire, insert] = h.captures.tenant;
    expect(terminal!.sql).toContain("status IN ('accepted', 'rejected')");
    expect(terminal!.args).toEqual([ctx.tenantId, clientId, h.captures.findings[0]!.contentHash]);
    expect(retire!.args).toEqual([...terminal!.args, runId]);
    expect(retire!.sql).toContain("run_id <> $4::uuid AND status = 'pending'");
    expect(insert!.sql).toContain('ON CONFLICT (run_id, content_hash) DO NOTHING');
    expect([retire!.transaction, insert!.transaction]).toEqual([
      terminal!.transaction,
      terminal!.transaction,
    ]);
  });
  it('does not retire or rewrite a terminal accepted/rejected content hash', async () => {
    const h = harness({ globalRows: { fara: [faraRow()] }, terminalResults: [true] });
    expect(await h.fara()).toMatchObject({ count: 0, backfill: { examined: 1, candidates: 0 } });
    expect(h.captures.tenant.map((call) => call.rail)).toEqual(['terminal']);
    expect(h.captures.findings).toEqual([]);
  });
});

describe('FARA insert cap and failure reporting', () => {
  it('counts successful inserts rather than attempts and stops before an unprocessed third row', async () => {
    const h = harness({
      globalRows: {
        fara: [
          faraRow({ registrationNumber: 'first' }),
          faraRow({ registrationNumber: 'second' }),
          faraRow({ registrationNumber: 'third' }),
        ],
      },
      insertResults: [false, true, true],
    });
    expect(await h.fara(199)).toMatchObject({
      count: 1,
      backfill: { status: 'complete', examined: 3, candidates: 1 },
    });
    expect(h.captures.findings.map((finding) => finding.targetKey)).toEqual([
      'advocacy:fara:first',
      'advocacy:fara:second',
    ]);
  });
  it('retains source result order while filtering unmatched organizations', async () => {
    const h = harness({
      globalRows: {
        fara: [
          faraRow({ registrationNumber: 'z' }),
          faraRow({
            registrationNumber: 'skip',
            registrantName: 'Another Company',
            foreignPrincipal: 'Another Principal',
          }),
          faraRow({ registrationNumber: 'a' }),
        ],
      },
    });
    expect((await h.fara()).count).toBe(2);
    expect(h.captures.findings.map((finding) => finding.targetKey)).toEqual([
      'advocacy:fara:z',
      'advocacy:fara:a',
    ]);
  });
  it('reports a global query failure as partial and redacts source-error secrets', async () => {
    const h = harness({
      railErrors: {
        fara: new Error(
          'source failed api_key=secret-one; Authorization: secret-two, bearer secret-three',
        ),
      },
    });
    expect(await h.fara()).toMatchObject({
      count: 0,
      backfill: {
        status: 'partial',
        examined: 0,
        candidates: 0,
        lastError: 'source failed api_key=[redacted]; Authorization=[redacted], bearer=[redacted]',
      },
    });
    expect(h.captures.warnings).toEqual([
      'FARA discovery rail unavailable: source failed api_key=[redacted]; Authorization=[redacted], bearer=[redacted]',
    ]);
    expect(h.captures.findings).toEqual([]);
  });
  it('bounds error text and leaves completedAt unset for a partial rail', async () => {
    const h = harness({ railErrors: { fara: new Error('x'.repeat(900)) } });
    const result = await h.fara();
    expect(result.backfill.lastError).toBe('x'.repeat(800));
    expect(result.backfill.completedAt).toBeUndefined();
    expect(result.backfill.checkpoint).toBeNull();
  });
});
