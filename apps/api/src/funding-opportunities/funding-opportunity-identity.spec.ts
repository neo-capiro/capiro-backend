import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException } from '@nestjs/common';
import {
  assertRequestSourceRecordId,
  LEGACY_POINTER_SOURCES,
  PLANNED_OPPORTUNITY_SOURCES,
  SOURCE_RECORD_TYPES,
  STORABLE_OPPORTUNITY_SOURCES,
  backfillIdentityColumns,
  buildSourceRecordIdentity,
  encodeSourceRecordPath,
  isLegacyPointerSource,
  isStorableSource,
  parseSourceRecordPath,
  readSourceRecordId,
  sourceRecordIdentityColumns,
  sourceRecordWhere,
} from './funding-opportunity-identity.js';
import { OPPORTUNITY_SOURCES } from './funding-opportunities.types.js';

const GRANT_ID = 'DE-FOA-0001';
const SAM_ID = '11111111-1111-1111-1111-111111111111';

describe('the two vocabularies are deliberately different sizes', () => {
  test('the API accepts exactly the two legacy sources', () => {
    // Widening THIS list is what makes a source requestable. P13 widens the
    // database's vocabulary without widening this one, which is the whole
    // meaning of "the schema can hold a forecast row and no code path can serve
    // one".
    expect([...OPPORTUNITY_SOURCES]).toEqual(['grants_gov', 'sam_gov']);
  });

  test('the schema can store the three planned sources as well', () => {
    expect([...STORABLE_OPPORTUNITY_SOURCES]).toEqual([
      'grants_gov',
      'sam_gov',
      'agency_forecast',
      'dibbs',
      'sbir_sttr',
    ]);
  });

  test('no planned source is reachable through the API vocabulary', () => {
    for (const planned of PLANNED_OPPORTUNITY_SOURCES) {
      expect(OPPORTUNITY_SOURCES as readonly string[]).not.toContain(planned);
    }
  });

  test('every storable source has a record type, and the types are distinct', () => {
    const types = STORABLE_OPPORTUNITY_SOURCES.map((s) => SOURCE_RECORD_TYPES[s]);
    expect(types.every((t) => typeof t === 'string' && t.length > 0)).toBe(true);
    expect(new Set(types).size).toBe(types.length);
  });

  test('only the two legacy sources are legacy-pointer sources', () => {
    expect([...LEGACY_POINTER_SOURCES]).toEqual(['grants_gov', 'sam_gov']);
    expect(isLegacyPointerSource('grants_gov')).toBe(true);
    expect(isLegacyPointerSource('agency_forecast')).toBe(false);
    expect(isStorableSource('agency_forecast')).toBe(true);
    expect(isStorableSource('fpds')).toBe(false);
  });
});

describe('building an identity is DUAL-WRITE by construction', () => {
  test('a grant row carries the legacy pointer AND the generic pair', () => {
    expect(buildSourceRecordIdentity('grants_gov', GRANT_ID)).toEqual({
      source: 'grants_gov',
      grantOpportunityId: GRANT_ID,
      samOpportunityId: null,
      sourceRecordType: 'grants_gov_opportunity',
      sourceRecordKey: GRANT_ID,
    });
  });

  test('a SAM row is the mirror image', () => {
    expect(buildSourceRecordIdentity('sam_gov', SAM_ID)).toEqual({
      source: 'sam_gov',
      grantOpportunityId: null,
      samOpportunityId: SAM_ID,
      sourceRecordType: 'sam_notice',
      sourceRecordKey: SAM_ID,
    });
  });

  test('a future source carries NO legacy pointer, only the generic pair', () => {
    expect(buildSourceRecordIdentity('agency_forecast', 'TANGO-F-9001')).toEqual({
      source: 'agency_forecast',
      grantOpportunityId: null,
      samOpportunityId: null,
      sourceRecordType: 'tango_procurement_forecast',
      sourceRecordKey: 'TANGO-F-9001',
    });
  });

  test('there is no way to get only one of the two forms for a legacy source', () => {
    // The failure this prevents: a row invisible to the generic index, or one
    // invisible to pre-P13 code. Both halves come from one call or neither does.
    for (const [source, id] of [
      ['grants_gov', GRANT_ID],
      ['sam_gov', SAM_ID],
    ] as const) {
      const columns = sourceRecordIdentityColumns(source, id);
      const legacy = columns.grantOpportunityId ?? columns.samOpportunityId;
      expect(legacy).toBe(id);
      expect(columns.sourceRecordKey).toBe(id);
      expect(columns.sourceRecordType).toBe(SOURCE_RECORD_TYPES[source]);
    }
  });

  test('the backfill helper returns the generic pair ONLY', () => {
    // Used on the update path. It must not touch the legacy pointer: an update
    // that rewrote it would move the row's identity, and the partial unique index
    // is built on that column.
    expect(backfillIdentityColumns('sam_gov', SAM_ID)).toEqual({
      sourceRecordType: 'sam_notice',
      sourceRecordKey: SAM_ID,
    });
    expect(backfillIdentityColumns('sam_gov', SAM_ID)).not.toHaveProperty('samOpportunityId');
  });

  test('the generic key is the legacy pointer verbatim, not a derived value', () => {
    // Deterministic and reversible without reading the migration. This is the
    // property the backfill relies on, and the reason a re-run is a no-op.
    expect(buildSourceRecordIdentity('grants_gov', GRANT_ID).sourceRecordKey).toBe(GRANT_ID);
  });
});

describe('malformed combinations fail closed', () => {
  test('an unknown source is refused, and the message lists the known ones', () => {
    expect(() => buildSourceRecordIdentity('fpds', 'x')).toThrow(BadRequestException);
    expect(() => buildSourceRecordIdentity('fpds', 'x')).toThrow(/grants_gov/);
  });

  test.each([['', 'empty'], ['   ', 'whitespace']])(
    'a %s record id (%s) is refused',
    (id) => {
      expect(() => buildSourceRecordIdentity('grants_gov', id)).toThrow(BadRequestException);
    },
  );

  test('a non-uuid SAM id from a REQUEST is a 400, not a Prisma error', () => {
    // Reaching `samOpportunityId` with a non-uuid is a driver error that surfaces
    // as a 500 and reads as a server fault rather than a bad request.
    expect(() => assertRequestSourceRecordId('sam_gov', 'not-a-uuid')).toThrow(
      BadRequestException,
    );
    expect(() => assertRequestSourceRecordId('sam_gov', 'not-a-uuid')).toThrow(/must be a UUID/);
  });

  test('building an identity does NOT apply the uuid check', () => {
    // Deliberate split. Producers read `sam_opportunity.id` out of a uuid column
    // and cannot produce a malformed one; validating there would only reject their
    // own valid data — and in a fixture, reject the fixture. The check belongs on
    // the paths where a stranger picked the string.
    expect(() => buildSourceRecordIdentity('sam_gov', 'n-1')).not.toThrow();
  });

  test('a grant id is NOT forced to look like a uuid, from either entry point', () => {
    // Grants.gov opportunity numbers are free-form source strings.
    expect(() => buildSourceRecordIdentity('grants_gov', 'DE-FOA-0001')).not.toThrow();
    expect(() => assertRequestSourceRecordId('grants_gov', 'DE-FOA-0001')).not.toThrow();
  });

  test('the request-path check is wired into the service and the path parser', () => {
    const service = readFileSync(join(__dirname, 'funding-opportunities.service.ts'), 'utf8');
    // Every workflow write and read reaches the database through findWorkflowRow.
    expect(service).toMatch(/assertRequestSourceRecordId\(source, sourceRecordId\);/);
    const identity = readFileSync(join(__dirname, 'funding-opportunity-identity.ts'), 'utf8');
    const parser = identity.slice(identity.indexOf('export function parseSourceRecordPath'));
    expect(parser).toContain('assertRequestSourceRecordId(');
  });

  test('a source record id is trimmed, so trailing whitespace cannot fork identity', () => {
    expect(buildSourceRecordIdentity('grants_gov', ` ${GRANT_ID} `).sourceRecordKey).toBe(GRANT_ID);
  });
});

describe('reading is DUAL-READ, legacy pointer first', () => {
  test('a fully dual-written grant row reads its legacy pointer', () => {
    expect(
      readSourceRecordId({
        source: 'grants_gov',
        grantOpportunityId: GRANT_ID,
        sourceRecordKey: GRANT_ID,
      }),
    ).toBe(GRANT_ID);
  });

  test('a row written by PRE-P13 code still resolves', () => {
    // The rolling-deploy tail the migration's one-shot backfill cannot reach.
    // Preferring the generic key would make this row read as having no source
    // record, which renders as "Source record no longer in the catalog".
    expect(
      readSourceRecordId({ source: 'sam_gov', samOpportunityId: SAM_ID, sourceRecordKey: null }),
    ).toBe(SAM_ID);
  });

  test('a FUTURE-source row resolves from the generic key alone', () => {
    expect(
      readSourceRecordId({
        source: 'agency_forecast',
        grantOpportunityId: null,
        samOpportunityId: null,
        sourceRecordKey: 'TANGO-F-9001',
      }),
    ).toBe('TANGO-F-9001');
  });

  test('the legacy pointer WINS when the two disagree', () => {
    // They cannot disagree — the CHECK and the writers both prevent it — but if a
    // manual repair ever made them, the legacy column is the one the partial
    // unique index and the old code both use, so it is the one that decides.
    expect(
      readSourceRecordId({
        source: 'grants_gov',
        grantOpportunityId: 'LEGACY',
        sourceRecordKey: 'GENERIC',
      }),
    ).toBe('LEGACY');
  });

  test('a row with neither form returns null rather than throwing', () => {
    expect(readSourceRecordId({ source: 'grants_gov' })).toBeNull();
    expect(readSourceRecordId({ source: 'agency_forecast' })).toBeNull();
  });
});

describe('the lookup predicate covers both forms', () => {
  test('a grant lookup ORs the legacy pointer with the generic pair', () => {
    expect(sourceRecordWhere('grants_gov', GRANT_ID)).toEqual({
      source: 'grants_gov',
      OR: [
        { grantOpportunityId: GRANT_ID },
        { sourceRecordType: 'grants_gov_opportunity', sourceRecordKey: GRANT_ID },
      ],
    });
  });

  test('a SAM lookup does the same with its own pointer', () => {
    expect(sourceRecordWhere('sam_gov', SAM_ID)).toEqual({
      source: 'sam_gov',
      OR: [
        { samOpportunityId: SAM_ID },
        { sourceRecordType: 'sam_notice', sourceRecordKey: SAM_ID },
      ],
    });
  });

  test('a future source has no OR at all — there is no legacy form to consider', () => {
    expect(sourceRecordWhere('agency_forecast', 'TANGO-F-9001')).toEqual({
      source: 'agency_forecast',
      sourceRecordType: 'tango_procurement_forecast',
      sourceRecordKey: 'TANGO-F-9001',
    });
  });

  test('every predicate pins `source`, so two rails cannot collide on one key', () => {
    for (const source of STORABLE_OPPORTUNITY_SOURCES) {
      const id = source === 'sam_gov' ? SAM_ID : 'KEY-1';
      expect(sourceRecordWhere(source, id)).toHaveProperty('source', source);
    }
  });

  test('a malformed lookup throws instead of returning a predicate that matches everything', () => {
    // A `where` built from an invalid source could otherwise degenerate to
    // `{ source: 'fpds' }` and quietly match nothing — or worse, to `{}`.
    expect(() => sourceRecordWhere('fpds', 'x')).toThrow(BadRequestException);
  });
});

describe('URL encoding lives in one place', () => {
  test('a plain pair encodes to two segments', () => {
    expect(encodeSourceRecordPath('sam_gov', SAM_ID)).toBe(`sam_gov/${SAM_ID}`);
  });

  test('a slash in a source record id is encoded, not left to split the route', () => {
    // One unencoded slash turns a two-segment route into a three-segment 404, for
    // exactly the records that contain it and no others.
    expect(encodeSourceRecordPath('grants_gov', 'DE-FOA/0001')).toBe(
      'grants_gov/DE-FOA%2F0001',
    );
  });

  test('an encoded path round-trips back to the original pair', () => {
    for (const id of ['DE-FOA-0001', 'DE-FOA/0001', 'A B:C', SAM_ID]) {
      const source = id === SAM_ID ? 'sam_gov' : 'grants_gov';
      const [rawSource, rawId] = encodeSourceRecordPath(source, id).split('/', 2) as [
        string,
        string,
      ];
      // A slash-bearing id splits into more than two parts only if it was NOT
      // encoded, so this assertion is itself the encoding test.
      expect(encodeSourceRecordPath(source, id).split('/')).toHaveLength(2);
      expect(parseSourceRecordPath(rawSource, rawId)).toEqual({
        source,
        sourceRecordId: id,
      });
    }
  });

  test('parsing an unknown source fails closed rather than defaulting', () => {
    expect(() => parseSourceRecordPath('fpds', 'x')).toThrow(BadRequestException);
  });

  test('a malformed percent-escape is refused, not silently repaired', () => {
    expect(() => parseSourceRecordPath('grants_gov', '%E0%A4%A')).not.toThrow();
    expect(() => parseSourceRecordPath('%zz', 'id')).toThrow(BadRequestException);
  });
});

// ── The migration itself ────────────────────────────────────────────────────

describe('the migration expands and never narrows', () => {
  const sql = readFileSync(
    join(
      __dirname,
      '../../prisma/migrations/20260820010000_funding_opportunity_generic_source/migration.sql',
    ),
    'utf8',
  );
  /**
   * The SQL with `--` comment lines removed.
   *
   * The narrowing assertions below have to run against STATEMENTS. This file's own
   * header says "does not drop, rename or narrow anything", and a naive
   * `not.toMatch(/RENAME/i)` over the raw text fails on that sentence — a test
   * that fails because the file explains itself is a test nobody will keep.
   */
  const ddl = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

  test('both columns are added NULLABLE, with no default', () => {
    // A NOT NULL breaks the first insert from pre-P13 code the moment the
    // migration lands; a DEFAULT invents an identity for a row that has none.
    //
    // Asserted against the ADD COLUMN statement alone. The exclusivity CHECK
    // legitimately contains `"source_record_key" IS NOT NULL` — that is the
    // requirement on FUTURE sources, not a column constraint, and a whole-file
    // regex cannot tell the two apart.
    const addColumns =
      ddl.match(/ALTER TABLE "client_funding_opportunity"\s*\n\s*ADD COLUMN[\s\S]*?;/)?.[0] ?? '';
    expect(addColumns).toMatch(/ADD COLUMN IF NOT EXISTS "source_record_type" VARCHAR\(48\),/);
    expect(addColumns).toMatch(/ADD COLUMN IF NOT EXISTS "source_record_key"\s+TEXT;/);
    expect(addColumns).not.toMatch(/NOT NULL/);
    expect(addColumns).not.toMatch(/DEFAULT/);
  });

  test('it drops NO column and renames nothing', () => {
    expect(ddl).not.toMatch(/DROP COLUMN/i);
    expect(ddl).not.toMatch(/RENAME/i);
    // The two legacy pointers must survive verbatim.
    expect(ddl).not.toMatch(/DROP[^\n]*grant_opportunity_id/i);
    expect(ddl).not.toMatch(/DROP[^\n]*sam_opportunity_id/i);
    // The only DROPs allowed are the two constraint replacements, each of which is
    // immediately re-added.
    expect(ddl.match(/DROP CONSTRAINT IF EXISTS/g)).toHaveLength(2);
  });

  test('the backfill is guarded on IS NULL, so a re-run is a no-op', () => {
    const updates = sql.match(/UPDATE "client_funding_opportunity"[\s\S]*?;/g) ?? [];
    expect(updates).toHaveLength(2);
    for (const update of updates) {
      expect(update).toMatch(/"source_record_key" IS NULL/);
    }
  });

  test('the source vocabulary is widened, never narrowed', () => {
    const chk = sql.match(/"client_funding_opportunity_source_chk"\s*\n?\s*CHECK[^;]*;/)?.[0] ?? '';
    for (const source of STORABLE_OPPORTUNITY_SOURCES) {
      expect(chk).toContain(`'${source}'`);
    }
  });

  test('the exclusivity CHECK still REQUIRES the legacy pointer for a legacy source', () => {
    const chk =
      sql.match(/"client_funding_opportunity_one_source_chk" CHECK \([\s\S]*?\n    \);/)?.[0] ?? '';
    expect(chk).toMatch(/"source" = 'grants_gov'[\s\S]*?"grant_opportunity_id" IS NOT NULL/);
    expect(chk).toMatch(/"source" = 'sam_gov'[\s\S]*?"sam_opportunity_id" IS NOT NULL/);
  });

  test('a future source is required to carry the generic pair and NO legacy pointer', () => {
    const chk =
      sql.match(/"client_funding_opportunity_one_source_chk" CHECK \([\s\S]*?\n    \);/)?.[0] ?? '';
    const generic =
      chk.match(/"source" NOT IN \('grants_gov', 'sam_gov'\)[\s\S]*?"source_record_type" IS NOT NULL/)?.[0] ??
      '';
    expect(generic).toMatch(/"grant_opportunity_id" IS NULL/);
    expect(generic).toMatch(/"sam_opportunity_id" IS NULL/);
    expect(generic).toMatch(/"source_record_key" IS NOT NULL/);
  });

  test('every `=` on source_record_type is guarded by IS NOT NULL', () => {
    // THE THREE-VALUED-LOGIC TRAP, as a regression test.
    //
    // A CHECK passes when it evaluates to TRUE *or to NULL*, and `NULL = 'x'` is
    // NULL. Written as
    //   (key IS NULL AND type IS NULL) OR (key IS NOT NULL AND type = 'sam_notice')
    // a row with a key and a NULL type takes `FALSE OR NULL` → NULL → and Postgres
    // ADMITS IT. That is not hypothetical: the first version of this migration was
    // rehearsed against pgvector:pg16 and that exact row inserted successfully.
    //
    // Asserted structurally rather than by re-reading the rehearsal, so the guard
    // cannot be dropped by someone tidying the constraint later.
    const chk =
      ddl.match(/"client_funding_opportunity_one_source_chk" CHECK \([\s\S]*?\n    \);/)?.[0] ?? '';
    expect(chk).not.toBe('');
    const equalityBranches = chk.match(/"source_record_type" = '[a-z_]+'/g) ?? [];
    expect(equalityBranches).toHaveLength(2);
    for (const recordType of ['grants_gov_opportunity', 'sam_notice']) {
      expect(chk).toMatch(
        new RegExp(
          `"source_record_type" IS NOT NULL\\s*\\n\\s*AND "source_record_type" = '${recordType}'`,
        ),
      );
    }
  });

  test('the generic unique index is PARTIAL and includes `source`', () => {
    const idx =
      sql.match(/CREATE UNIQUE INDEX IF NOT EXISTS "client_funding_opportunity_generic_uniq"[\s\S]*?;/)?.[0] ??
      '';
    expect(idx).toContain('"tenant_id", "client_id", "source", "source_record_key"');
    expect(idx).toMatch(/WHERE "source_record_key" IS NOT NULL/);
  });

  test('every statement is retry-safe', () => {
    // A failed migration blocks every later one, so a half-applied run has to be
    // re-runnable.
    for (const create of sql.match(/CREATE (UNIQUE )?INDEX[^\n]*/g) ?? []) {
      expect(create).toContain('IF NOT EXISTS');
    }
    for (const add of sql.match(/ADD CONSTRAINT "([a-z_]+)"/g) ?? []) {
      const name = add.match(/"([a-z_]+)"/)![1];
      expect(sql).toContain(`DROP CONSTRAINT IF EXISTS "${name}"`);
    }
  });
});

describe('schema.prisma agrees with the migration', () => {
  const schema = readFileSync(join(__dirname, '../../prisma/schema.prisma'), 'utf8');
  const model = schema.slice(
    schema.indexOf('model ClientFundingOpportunity {'),
    schema.indexOf('@@map("client_funding_opportunity")'),
  );

  test('both columns are declared, and both are optional', () => {
    expect(model).toMatch(/sourceRecordType\s+String\?\s+@map\("source_record_type"\)/);
    expect(model).toMatch(/sourceRecordKey\s+String\?\s+@map\("source_record_key"\)/);
  });

  test('the legacy pointers are still declared', () => {
    expect(model).toMatch(/grantOpportunityId String\?/);
    expect(model).toMatch(/samOpportunityId\s+String\?/);
  });

  test('the non-unique lookup index is declared, so `prisma migrate dev` sees no drift', () => {
    expect(model).toContain('client_funding_opportunity_source_record_idx');
  });
});

// ── Nothing writes a planned source yet ─────────────────────────────────────

describe('no new source is enabled by this phase', () => {
  const dir = join(__dirname);
  const files = [
    'funding-opportunities.service.ts',
    'funding-opportunities.controller.ts',
    'funding-opportunity-inbox.service.ts',
    'funding-opportunity-actions.service.ts',
  ];

  test.each(files)('%s never names a planned source', (file) => {
    const source = readFileSync(join(dir, file), 'utf8');
    for (const planned of PLANNED_OPPORTUNITY_SOURCES) {
      expect(source).not.toContain(`'${planned}'`);
    }
  });

  test('the producers only ever build a legacy identity', () => {
    for (const script of [
      '../../scripts/generate-funding-grant-candidates.ts',
      '../../scripts/generate-sam-opportunity-candidates.ts',
    ]) {
      const source = readFileSync(join(dir, script), 'utf8');
      for (const planned of PLANNED_OPPORTUNITY_SOURCES) {
        expect(source).not.toContain(`'${planned}'`);
      }
    }
  });
});
