import {
  clientId,
  ctx,
  findingInput,
  harness,
  runId,
  sqlText,
  tenantId,
} from '../../test/fixtures/client-profile-fill-completion-persistence.js';

const contentHash = '2f72b4ff597f99cb05d571ebcf10ce2b6c197b494d5253c06d052b9814d099f5';

it('writes the complete finding envelope with canonical hash and original JSON payload order in one tenant transaction', async () => {
  const h = harness();
  const input = findingInput();
  expect(await h.add(input)).toBe(true);
  expect(h.phases).toEqual(['begin', 'terminal', 'retire', 'insert', 'commit']);
  expect(h.prisma.withTenant).toHaveBeenCalledTimes(1);
  expect(h.transactions[0]!.tenantId).toBe(tenantId);
  expect(new Set(h.calls.map((call) => call.transaction))).toEqual(new Set([1]));
  expect(h.callsOf('terminal')[0]!.args).toEqual([tenantId, clientId, contentHash]);
  expect(h.callsOf('retire')[0]!.args).toEqual([tenantId, clientId, contentHash, runId]);
  expect(h.callsOf('insert')[0]!.args).toEqual([
    runId,
    tenantId,
    clientId,
    'profile_completion',
    'profile-completion',
    'completion_audit',
    'fact',
    '{"old":true}',
    '{"z":2,"a":{"d":"date","b":1},"list":[{"z":9,"a":4},5]}',
    '[{"label":"Audit evidence","metadata":{"z":2,"a":1}}]',
    0.9,
    'informational',
    contentHash,
  ]);
  expect(sqlText(h.callsOf('terminal')[0]!.sql)).toBe(
    sqlText(`SELECT id FROM client_profile_fill_finding
    WHERE tenant_id = $1::uuid AND client_id = $2::uuid AND content_hash = $3
      AND status IN ('accepted', 'rejected') LIMIT 1`),
  );
  expect(sqlText(h.callsOf('retire')[0]!.sql)).toBe(
    sqlText(`UPDATE client_profile_fill_finding
    SET status = 'informational', updated_at = now()
    WHERE tenant_id = $1::uuid AND client_id = $2::uuid AND content_hash = $3
      AND run_id <> $4::uuid AND status = 'pending'`),
  );
  expect(sqlText(h.callsOf('insert')[0]!.sql)).toBe(
    sqlText(`INSERT INTO client_profile_fill_finding
    (run_id, tenant_id, client_id, kind, target_key, source, fact_kind,
      current_value_jsonb, proposed_value_jsonb, evidence_jsonb, confidence, status, content_hash)
    VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7,
      $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, $13)
    ON CONFLICT (run_id, content_hash) DO NOTHING`),
  );
});

it('uses stable deep object ordering for hashing while preserving array order and original payload serialization', async () => {
  const h = harness();
  await h.add(
    findingInput({ proposedValue: { list: [{ a: 4, z: 9 }, 5], a: { b: 1, d: 'date' }, z: 2 } }),
  );
  expect(h.callsOf('insert')[0]!.args[12]).toBe(contentHash);
  expect(h.callsOf('insert')[0]!.args[8]).toBe(
    '{"list":[{"a":4,"z":9},5],"a":{"b":1,"d":"date"},"z":2}',
  );
});

it.each([
  { field: 'factKind', value: 'recommendation' },
  { field: 'currentValue', value: { changed: true } },
  { field: 'confidence', value: 0.1 },
  { field: 'evidence', value: [{ label: 'Other' }] },
  { field: 'status', value: 'pending' },
])('excludes $field from content identity', async ({ field, value }) => {
  const h = harness();
  await h.add({ ...findingInput(), [field]: value });
  expect(h.callsOf('insert')[0]!.args[12]).toBe(contentHash);
});

it.each([
  {
    field: 'kind',
    value: 'other',
    hash: '803363fcd8f0ee1b11d2b07b48ebce84eb0fdef019ceb711b88d5fdea0cf2994',
  },
  {
    field: 'source',
    value: 'other_source',
    hash: '1197c7ecf7819ec28f303e3ab597002845b50582b592e596e1ca8c6bb71a3dbc',
  },
  {
    field: 'targetKey',
    value: 'different',
    hash: '03b75600fc0db6d96e49cda51c873d27ad1c6161f9e72c14ce4771db5afd0a45',
  },
  {
    field: 'proposedValue',
    value: { x: 1 },
    hash: 'e8704ecf191ad82839536b99c4e079dff676c0a37296558c0abe85e8993b6bb2',
  },
])('includes $field in content identity', async ({ field, value, hash }) => {
  const h = harness();
  await h.add({ ...findingInput(), [field]: value });
  expect(h.callsOf('insert')[0]!.args[12]).toBe(hash);
});

it('preserves the existing Date hash normalization while JSON payload serialization retains the ISO date', async () => {
  const h = harness();
  await h.add(findingInput({ proposedValue: { stamp: new Date('2026-10-13T12:00:00.000Z') } }));
  expect(h.callsOf('insert')[0]!.args[12]).toBe(
    '26815ee36ac7cc58325a6d244dbc7b19485a64c5b411f96548ec87cd3c87b132',
  );
  expect(h.callsOf('insert')[0]!.args[8]).toBe('{"stamp":"2026-10-13T12:00:00.000Z"}');
});

it.each([
  { label: 'null', currentValue: null, expected: 'null' },
  { label: 'undefined', currentValue: undefined, expected: 'null' },
  { label: 'false', currentValue: false, expected: 'false' },
])(
  'serializes $label current values without changing nullish normalization',
  async ({ currentValue, expected }) => {
    const h = harness();
    await h.add(findingInput({ currentValue }));
    expect(h.callsOf('insert')[0]!.args[7]).toBe(expected);
    expect(h.callsOf('insert')[0]!.args[12]).toBe(contentHash);
  },
);

it.each([
  { label: 'negative', confidence: -2, expected: 0 },
  { label: 'above one', confidence: 2, expected: 1 },
  { label: 'fraction', confidence: 0.4, expected: 0.4 },
  { label: 'NaN', confidence: NaN, expected: NaN },
])('retains confidence coercion for $label values', async ({ confidence, expected }) => {
  const h = harness();
  await h.add(findingInput({ confidence }));
  expect(h.callsOf('insert')[0]!.args[10]).toBe(expected);
});

it.each([
  { label: 'zero', insertResult: 0, inserted: false },
  { label: 'one', insertResult: 1, inserted: true },
  { label: 'string zero', insertResult: '0', inserted: false },
  { label: 'string one', insertResult: '1', inserted: true },
  { label: 'null', insertResult: null, inserted: false },
])('returns the existing inserted-count result for $label', async ({ insertResult, inserted }) => {
  const h = harness({ insertResult });
  expect(await h.add()).toBe(inserted);
  expect(h.phases).toEqual(['begin', 'terminal', 'retire', 'insert', 'commit']);
});

it('loads scoped cursor records without cloning their watermark object', async () => {
  const watermark = { backfill: { status: 'complete' }, lastLdaKey: 'filing-one' };
  const h = harness({ cursorRows: [{ watermark }] });
  expect(await h.readCursor()).toBe(watermark);
  expect(h.calls[0]!.args).toEqual([tenantId, clientId, 'advocacy_history']);
  expect(sqlText(h.calls[0]!.sql)).toBe(
    sqlText(`SELECT watermark_jsonb AS watermark
    FROM client_profile_fill_source_cursor WHERE tenant_id = $1::uuid AND client_id = $2::uuid AND source = $3`),
  );
});

it.each([
  { label: 'missing row', rows: [] },
  { label: 'null', rows: [{ watermark: null }] },
  { label: 'array', rows: [{ watermark: [1] }] },
  { label: 'string', rows: [{ watermark: 'invalid' }] },
])('returns an empty record for a $label cursor', async ({ rows }) => {
  const h = harness({ cursorRows: rows });
  expect(await h.readCursor('different_source')).toEqual({});
  expect(h.calls[0]!.args).toEqual([tenantId, clientId, 'different_source']);
});

it('writes the exact cursor merge SQL and JSON without replacing unrelated watermark keys', async () => {
  const h = harness();
  const watermark = { scanAt: '2026-10-13T12:00:00.000Z', nested: { value: 1 }, absent: undefined };
  await h.writeCursor(watermark, 'lifecycle_outcomes');
  expect(h.phases).toEqual(['begin', 'cursor-write', 'commit']);
  expect(h.calls[0]!.args).toEqual([
    tenantId,
    clientId,
    'lifecycle_outcomes',
    '{"scanAt":"2026-10-13T12:00:00.000Z","nested":{"value":1}}',
  ]);
  expect(sqlText(h.calls[0]!.sql)).toBe(
    sqlText(`INSERT INTO client_profile_fill_source_cursor
    (tenant_id, client_id, source, watermark_jsonb, last_successful_at, last_attempt_at, last_error, updated_at)
    VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, now(), now(), NULL, now())
    ON CONFLICT (tenant_id, client_id, source) DO UPDATE
    SET watermark_jsonb = client_profile_fill_source_cursor.watermark_jsonb || EXCLUDED.watermark_jsonb,
      last_successful_at = now(), last_attempt_at = now(), last_error = NULL, updated_at = now()`),
  );
});

it('loads only canonical confirmed mappings in tenant scope and returns deduplicated external keys', async () => {
  const h = harness({ mappings: ['number-one', 'number-one', 'number-two'] });
  expect(await h.mapping()).toEqual(new Set(['number-one', 'number-two']));
  expect(h.prisma.withTenant).toHaveBeenCalledWith(ctx.tenantId, expect.any(Function));
  expect(h.calls[0]!.args).toEqual([
    { where: { clientId, source: 'fara', confirmed: true }, select: { externalId: true } },
  ]);
});

it('retains source-specific confirmed-key lookup and an empty mapping set', async () => {
  const h = harness();
  expect(await h.mapping('testimony')).toEqual(new Set());
  expect(h.calls[0]!.args).toEqual([
    { where: { clientId, source: 'testimony', confirmed: true }, select: { externalId: true } },
  ]);
});
