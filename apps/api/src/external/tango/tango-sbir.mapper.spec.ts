import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mapSbirSolicitation, mapSbirTopic, solicitationYear } from './tango-sbir.mapper.js';

/**
 * P42 — the SBIR/STTR mappers.
 *
 * These pin a READING of published field names, not the provider's behaviour.
 * Nothing has ever called `/api/sbir/`, so a green suite here means "the
 * mapper does what we decided", never "the mapper matches the API". The
 * distinction is the whole reason the file header calls itself provisional.
 */

/**
 * Prisma types a DATE input as `string | Date`, so the row fields are not
 * narrowed to Date even though `dateOnly` only ever produces one. Normalising
 * here keeps the assertions about the VALUE rather than about which of the two
 * shapes Prisma's generated type permits.
 */
function iso(value: string | Date | null | undefined): string | null {
  return value == null ? null : new Date(value).toISOString();
}

const SOLICITATION = {
  solicitation_id: 'SOL-2026-A',
  solicitation_number: 'DoD-SBIR-26.A',
  title: 'DoD SBIR 26.A',
  program: 'SBIR',
  cycle_name: '26.A',
  year: 2026,
  start_date: '2026-01-06',
  end_date: '2026-02-04',
  out_of_cycle: false,
  activity: 'Open',
  solicitation_status: 'Open',
  sol_download_url: 'https://example.invalid/sol.pdf',
};

const TOPIC = {
  topic_id: 'TOPIC-9001',
  topic_number: 'A26-001',
  title: 'Autonomous sustainment diagnostics',
  agency: 'Department of Defense',
  year: 2026,
  solicitation_number: 'DoD-SBIR-26.A',
  release_date: '2025-12-04',
  open_date: '2026-01-06',
  close_date: '2026-02-04',
  activity: 'Open',
  solicitation_status: 'Open',
  topic_url: 'https://example.invalid/topic/9001',
  official_solicitation_url: 'https://www.dodsbirsttr.mil/submissions/solicitation/9001',
};

describe('mapSbirSolicitation', () => {
  it('maps every documented field', () => {
    const row = mapSbirSolicitation(SOLICITATION)!;
    expect(row.tangoSbirId).toBe('SOL-2026-A');
    expect(row.solicitationNumber).toBe('DoD-SBIR-26.A');
    expect(row.title).toBe('DoD SBIR 26.A');
    expect(row.program).toBe('SBIR');
    expect(row.cycleName).toBe('26.A');
    expect(row.year).toBe(2026);
    expect(iso(row.startDate)).toBe('2026-01-06T00:00:00.000Z');
    expect(iso(row.endDate)).toBe('2026-02-04T00:00:00.000Z');
    expect(row.outOfCycle).toBe(false);
    expect(row.activity).toBe('Open');
    expect(row.solicitationStatus).toBe('Open');
    expect(row.solDownloadUrl).toBe('https://example.invalid/sol.pdf');
  });

  /**
   * The upsert key and the join key. Without either, the row cannot be stored
   * without inventing a value — `solicitation_number` is NOT NULL and is the
   * ONLY key a topic carries back to its cycle, so a cycle without one would be
   * stored unreachable.
   */
  it.each([
    ['no solicitation_id', { ...SOLICITATION, solicitation_id: undefined }],
    ['blank solicitation_id', { ...SOLICITATION, solicitation_id: '   ' }],
    ['no solicitation_number', { ...SOLICITATION, solicitation_number: undefined }],
    ['blank solicitation_number', { ...SOLICITATION, solicitation_number: '' }],
  ])('drops a record with %s rather than half-mapping it', (_label, raw) => {
    expect(mapSbirSolicitation(raw as Record<string, unknown>)).toBeNull();
  });

  it('never reaches for `uuid`, which is the DIBBS key and not this one', () => {
    // The natural wrong assumption: these APIs share no identity column. A
    // mapper reading raw['uuid'] would return null for every record and report
    // a clean "0 mapped" — the quiet failure this test exists to prevent.
    const withUuidOnly = { ...SOLICITATION, solicitation_id: undefined, uuid: 'SOL-2026-A' };
    expect(mapSbirSolicitation(withUuidOnly as Record<string, unknown>)).toBeNull();
  });

  it('keeps the provider spelling of `program` rather than normalising it', () => {
    // The contract documents the field, not its value set. Upper-casing or
    // mapping to an enum would be inventing a vocabulary the provider never
    // published, and would silently rewrite a value on first contact.
    expect(mapSbirSolicitation({ ...SOLICITATION, program: 'sttr' })!.program).toBe('sttr');
    expect(mapSbirSolicitation({ ...SOLICITATION, program: 'STTR ' })!.program).toBe('STTR');
  });

  it('reports an absent optional field as null, never as a default', () => {
    const row = mapSbirSolicitation({
      solicitation_id: 'SOL-1',
      solicitation_number: 'N-1',
    })!;
    expect(row.title).toBeNull();
    expect(row.program).toBeNull();
    expect(row.cycleName).toBeNull();
    expect(row.year).toBeNull();
    expect(row.startDate).toBeNull();
    expect(row.endDate).toBeNull();
    expect(row.solDownloadUrl).toBeNull();
    // A missing flag is UNKNOWN, never false. `out_of_cycle: null` and
    // `out_of_cycle: false` are different statements about the cycle.
    expect(row.outOfCycle).toBeNull();
  });

  it('does not derive status from the end date', () => {
    // A cycle whose end date has passed is not necessarily one the provider
    // calls closed — the same distinction P40 records for `is_open`.
    const row = mapSbirSolicitation({
      ...SOLICITATION,
      end_date: '2020-01-01',
      start_date: '2019-01-01',
      solicitation_status: 'Open',
    })!;
    expect(row.solicitationStatus).toBe('Open');
  });

  it('nulls an unparseable date rather than storing an Invalid Date', () => {
    const row = mapSbirSolicitation({ ...SOLICITATION, start_date: 'sometime in spring' })!;
    expect(row.startDate).toBeNull();
  });
});

describe('mapSbirTopic', () => {
  it('maps every documented field', () => {
    const row = mapSbirTopic(TOPIC)!;
    expect(row.tangoSbirId).toBe('TOPIC-9001');
    expect(row.topicNumber).toBe('A26-001');
    expect(row.title).toBe('Autonomous sustainment diagnostics');
    expect(row.agency).toBe('Department of Defense');
    expect(row.year).toBe(2026);
    expect(row.solicitationNumber).toBe('DoD-SBIR-26.A');
    expect(iso(row.releaseDate)).toBe('2025-12-04T00:00:00.000Z');
    expect(iso(row.openDate)).toBe('2026-01-06T00:00:00.000Z');
    expect(iso(row.closeDate)).toBe('2026-02-04T00:00:00.000Z');
    expect(row.topicUrl).toBe('https://example.invalid/topic/9001');
  });

  it.each([
    ['no topic_id', { ...TOPIC, topic_id: undefined }],
    ['blank topic_id', { ...TOPIC, topic_id: '  ' }],
  ])('drops a record with %s', (_label, raw) => {
    expect(mapSbirTopic(raw as Record<string, unknown>)).toBeNull();
  });

  it('never reaches for `uuid` or for the sibling `solicitation_id`', () => {
    expect(
      mapSbirTopic({ ...TOPIC, topic_id: undefined, uuid: 'TOPIC-9001' } as Record<
        string,
        unknown
      >),
    ).toBeNull();
    expect(
      mapSbirTopic({ ...TOPIC, topic_id: undefined, solicitation_id: 'TOPIC-9001' } as Record<
        string,
        unknown
      >),
    ).toBeNull();
  });

  /**
   * A topic without a stated parent is a real topic, not a broken one. The
   * column is nullable precisely so that case is representable — dropping it
   * would lose a genuine record over a secondary field, the same trade
   * `reconcileQuantity` refuses to make in the DIBBS mapper.
   */
  it('keeps a topic that states no parent cycle', () => {
    const row = mapSbirTopic({ ...TOPIC, solicitation_number: undefined })!;
    expect(row.tangoSbirId).toBe('TOPIC-9001');
    expect(row.solicitationNumber).toBeNull();
  });

  it('keeps a CLOSED topic — reference-only is a rule about pursuit, not storage', () => {
    const row = mapSbirTopic({ ...TOPIC, solicitation_status: 'Closed' })!;
    expect(row.solicitationStatus).toBe('Closed');
  });

  it('stores official_solicitation_url as a URL and never parses a DSIP id from it', () => {
    const row = mapSbirTopic(TOPIC)!;
    expect(row.officialSolicitationUrl).toBe(
      'https://www.dodsbirsttr.mil/submissions/solicitation/9001',
    );
    // Nothing in the row carries a parsed fragment of that URL.
    const values = Object.values(row).map((v) => (typeof v === 'string' ? v : ''));
    expect(values.filter((v) => v === '9001')).toHaveLength(0);
  });

  it('does not split agency into agency and component', () => {
    // The resource publishes ONE agency field. Deriving a component from it
    // would be parsing a guess out of a name — the contractOffices mistake.
    const row = mapSbirTopic({ ...TOPIC, agency: 'Department of Defense | Navy' })!;
    expect(row.agency).toBe('Department of Defense | Navy');
    expect(Object.keys(row)).not.toContain('component');
  });
});

describe('solicitationYear', () => {
  it('accepts a plausible four-digit year', () => {
    expect(solicitationYear(2026)).toBe(2026);
    expect(solicitationYear('2026')).toBe(2026);
  });

  /**
   * The two cases the range actually adds over `int()`. A date STRING is
   * already null before this function sees it (`num()` uses `Number()`, so
   * '2026-01-01' is NaN) — these are the values `int()` would otherwise hand
   * back as plausible years.
   */
  it('refuses an epoch-milliseconds timestamp', () => {
    expect(solicitationYear(1767225600000)).toBeNull();
  });

  it('refuses a two-digit year rather than storing something that sorts wrong', () => {
    expect(solicitationYear(26)).toBeNull();
  });

  it('is null for anything unparseable, and for a date string', () => {
    expect(solicitationYear('2026-01-01')).toBeNull();
    expect(solicitationYear('twenty twenty six')).toBeNull();
    expect(solicitationYear(null)).toBeNull();
    expect(solicitationYear(undefined)).toBeNull();
  });

  it('stays inside the CHECK the column carries, so a bad year cannot fail a good row', () => {
    // tango_sbir_*_year_chk bounds this 1980-2200. If the mapper let a value
    // through that the CHECK refuses, one bad secondary field would abort the
    // insert of an otherwise-good record.
    for (const out of [1979, 2201, 0, -2026]) {
      expect(solicitationYear(out)).toBeNull();
    }
    expect(solicitationYear(1980)).toBe(1980);
    expect(solicitationYear(2200)).toBe(2200);
  });
});

/**
 * A source scan, in the style `tango-dibbs.mapper.spec.ts` established.
 *
 * The subject is a rule the type system cannot express: this mapper must not
 * invent the four concepts P42's plan names but the provider does not publish.
 * Asserting on the FILE TEXT is what catches a future edit that adds one back
 * by reading something adjacent.
 */
describe('the mapper does not invent what the provider does not publish', () => {
  const source = readFileSync(join(__dirname, 'tango-sbir.mapper.ts'), 'utf8');
  // Comments explain exactly these absences, so a naive substring scan matches
  // its own documentation. Strip comments first — the same trap P49's
  // "never calls the provider" test hit against its own header.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it.each([['phase'], ['description'], ['dsip'], ['grant_link'], ['component']])(
    'maps no `%s` field',
    (concept) => {
      expect(code.toLowerCase()).not.toContain(`${concept}:`);
    },
  );

  it('never reads a raw key the contract does not document', () => {
    const documented = new Set([
      'topic_id',
      'title',
      'agency',
      'year',
      'topic_number',
      'solicitation_number',
      'release_date',
      'open_date',
      'close_date',
      'activity',
      'solicitation_status',
      'topic_url',
      'official_solicitation_url',
      'solicitation_id',
      'program',
      'cycle_name',
      'start_date',
      'end_date',
      'out_of_cycle',
      'sol_download_url',
    ]);
    const read = [...code.matchAll(/raw\['([a-z_]+)'\]/g)].map((m) => m[1]!);
    expect(read.length).toBeGreaterThan(0);
    expect([...new Set(read)].filter((key) => !documented.has(key))).toEqual([]);
  });
});
