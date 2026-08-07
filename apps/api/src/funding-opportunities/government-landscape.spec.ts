import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException } from '@nestjs/common';
import {
  GovernmentLandscapeService,
  WIRED_LANDSCAPE_SOURCES,
  isHighConfidenceItem,
  landscapeFingerprint,
  orderLandscapeItems,
  type LandscapePort,
} from './government-landscape.service.js';
import { LANDSCAPE_SOURCES, type LandscapeItem } from './government-landscape.types.js';

/**
 * The Government Landscape packet (P33).
 *
 * Four properties carry the phase: the ethical wall holds, verified and
 * inferred never merge, a missing source lowers coverage without making a
 * claim, and the packet is deterministic down to its hash.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';
const CLIENT = '33333333-3333-3333-3333-333333333333';
const SAM_ID = '44444444-4444-4444-4444-444444444444';
const AS_OF = new Date('2026-08-07T12:00:00.000Z');

function makeService(over: Partial<LandscapePort> = {}) {
  const calls = { pe: 0, facilities: 0, place: 0 };
  const base: LandscapePort = {
    visibleClientIds: async () => [CLIENT],
    readProgramElementLinks: async () => [
      {
        id: 'match-accepted',
        peCode: '0204163N',
        reviewStatus: 'accepted',
        matchBasis: 'verbatim_pe_code',
        asOf: new Date('2026-07-01T00:00:00.000Z'),
      },
    ],
    readClientFacilities: async () => [
      { id: 'fac-1', name: 'Jacksonville Depot', state: 'FL', congressionalDistrict: '04' },
    ],
    readNoticePlace: async () => ({ state: 'FL' }),
  };
  const merged = { ...base, ...over };
  // Counted in the WRAPPER, not in the default implementation: an override
  // would otherwise silently replace the counter along with the behaviour, and
  // the query-count test would pass by measuring nothing.
  const port: LandscapePort = {
    visibleClientIds: merged.visibleClientIds,
    readProgramElementLinks: async (...args) => {
      calls.pe += 1;
      return merged.readProgramElementLinks(...args);
    },
    readClientFacilities: async (...args) => {
      calls.facilities += 1;
      return merged.readClientFacilities(...args);
    },
    readNoticePlace: async (...args) => {
      calls.place += 1;
      return merged.readNoticePlace(...args);
    },
  };
  return { service: new GovernmentLandscapeService({} as never).withPort(port), calls };
}

function item(over: Partial<LandscapeItem> = {}): LandscapeItem {
  return {
    source: 'program_element',
    sourceId: 'a',
    label: 'x',
    basis: 'source_backed',
    matchedOn: 'm',
    evidenceRef: null,
    asOf: null,
    ...over,
  };
}

describe('the ethical wall holds, and leaks nothing by holding', () => {
  test('a client the actor cannot see yields a DENIED packet, not a 403', async () => {
    // A 403 would confirm the client exists, which is the one thing an ethical
    // wall is for.
    const { service, calls } = makeService({ visibleClientIds: async () => [] });
    const packet = await service.compose(TENANT, USER, CLIENT, 'sam_gov', SAM_ID, AS_OF);
    expect(packet.items).toEqual([]);
    expect(packet.sources.every((s) => s.state === 'denied')).toBe(true);
    // And nothing was read on the client's behalf.
    expect(calls.pe).toBe(0);
    expect(calls.facilities).toBe(0);
  });

  test('a denied packet has the SAME fingerprint as any empty one', async () => {
    // A distinctive "denied" hash would let a caller detect a walled client by
    // comparing hashes.
    const denied = await makeService({ visibleClientIds: async () => [] }).service.compose(
      TENANT,
      USER,
      CLIENT,
      'sam_gov',
      SAM_ID,
      AS_OF,
    );
    expect(denied.fingerprint).toBe(landscapeFingerprint([]));
  });

  test('the wall uses the SAME allow-list the inbox uses', () => {
    const source = readFileSync(join(__dirname, 'government-landscape.service.ts'), 'utf8');
    // An ethical wall with two implementations has two chances to be wrong.
    expect(source).toMatch(/readVisibleClientIds/);
    expect(source).not.toMatch(/memoryWall/);
  });

  test('a grant is refused rather than given a packet of not_wired sources', async () => {
    const { service } = makeService();
    await expect(
      service.compose(TENANT, USER, CLIENT, 'grants_gov', 'DE-FOA-0001', AS_OF),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('verified and inferred never merge', () => {
  test('an ACCEPTED PE match is source-backed', async () => {
    const { service } = makeService();
    const packet = await service.compose(TENANT, USER, CLIENT, 'sam_gov', SAM_ID, AS_OF);
    const pe = packet.items.find((i) => i.source === 'program_element')!;
    expect(pe.basis).toBe('source_backed');
    expect(pe.matchedOn).toBe('0204163N');
    expect(isHighConfidenceItem(pe)).toBe(true);
  });

  test('a QUARANTINED match is admitted as INFERRED, not dropped and not promoted', async () => {
    // A NAICS or keyword coincidence produces exactly this row. Dropping it
    // would hide real information a human deciding whether to pursue can use;
    // promoting it would create a PE link from resemblance.
    const { service } = makeService({
      readProgramElementLinks: async () => [
        {
          id: 'match-q',
          peCode: '0605898N',
          reviewStatus: 'quarantined',
          matchBasis: 'naics_overlap',
          asOf: null,
        },
      ],
    });
    const packet = await service.compose(TENANT, USER, CLIENT, 'sam_gov', SAM_ID, AS_OF);
    const pe = packet.items.find((i) => i.source === 'program_element')!;
    expect(pe.basis).toBe('inferred');
    expect(isHighConfidenceItem(pe)).toBe(false);
    // And the label SAYS so, rather than relying on the badge alone.
    expect(pe.label).toMatch(/UNREVIEWED match/);
    expect(pe.label).toMatch(/Not evidence of a link/);
  });

  test('a candidate match is inferred too', async () => {
    const { service } = makeService({
      readProgramElementLinks: async () => [
        { id: 'm', peCode: '0101221N', reviewStatus: 'candidate', matchBasis: 'keyword', asOf: null },
      ],
    });
    const packet = await service.compose(TENANT, USER, CLIENT, 'sam_gov', SAM_ID, AS_OF);
    expect(packet.items[0]!.basis).toBe('inferred');
  });

  test('a match with no PE code contributes nothing rather than an empty link', async () => {
    const { service } = makeService({
      readProgramElementLinks: async () => [
        { id: 'm', peCode: null, reviewStatus: 'accepted', matchBasis: 'program_only', asOf: null },
      ],
    });
    const packet = await service.compose(TENANT, USER, CLIENT, 'sam_gov', SAM_ID, AS_OF);
    expect(packet.items.filter((i) => i.source === 'program_element')).toEqual([]);
  });

  test('source-backed items sort BEFORE inferred ones within a source', async () => {
    // A reader should meet the verified evidence first.
    const { service } = makeService({
      readProgramElementLinks: async () => [
        { id: 'b', peCode: 'AAA1', reviewStatus: 'quarantined', matchBasis: 'k', asOf: null },
        { id: 'a', peCode: 'ZZZ9', reviewStatus: 'accepted', matchBasis: 'verbatim', asOf: null },
      ],
    });
    const packet = await service.compose(TENANT, USER, CLIENT, 'sam_gov', SAM_ID, AS_OF);
    expect(packet.items.map((i) => i.basis).slice(0, 2)).toEqual(['source_backed', 'inferred']);
  });
});

describe('a district link is a STATE overlap, never a geocode', () => {
  test('a facility in the notice’s stated state produces a district item', async () => {
    const { service } = makeService();
    const packet = await service.compose(TENANT, USER, CLIENT, 'sam_gov', SAM_ID, AS_OF);
    const district = packet.items.find((i) => i.source === 'congressional_district')!;
    expect(district.matchedOn).toBe('FL-04');
    expect(district.basis).toBe('source_backed');
  });

  test('a facility in a DIFFERENT state produces none', async () => {
    const { service } = makeService({ readNoticePlace: async () => ({ state: 'TX' }) });
    const packet = await service.compose(TENANT, USER, CLIENT, 'sam_gov', SAM_ID, AS_OF);
    expect(packet.items.some((i) => i.source === 'congressional_district')).toBe(false);
  });

  test('a notice with NO stated place produces none — never an inferred district', async () => {
    // Inferring a district from a city name would be exactly the fabricated
    // district nexus `FundingOpportunity.districtBasis` already refuses.
    const { service } = makeService({ readNoticePlace: async () => ({ state: null }) });
    const packet = await service.compose(TENANT, USER, CLIENT, 'sam_gov', SAM_ID, AS_OF);
    expect(packet.items.some((i) => i.source === 'congressional_district')).toBe(false);
  });

  test('a facility with no recorded district produces none', async () => {
    const { service } = makeService({
      readClientFacilities: async () => [
        { id: 'f', name: 'Depot', state: 'FL', congressionalDistrict: null },
      ],
    });
    const packet = await service.compose(TENANT, USER, CLIENT, 'sam_gov', SAM_ID, AS_OF);
    expect(packet.items.some((i) => i.source === 'congressional_district')).toBe(false);
  });
});

describe('a missing source lowers coverage and makes no claim', () => {
  test('every declared source is reported, wired or not', async () => {
    const { service } = makeService();
    const packet = await service.compose(TENANT, USER, CLIENT, 'sam_gov', SAM_ID, AS_OF);
    expect(packet.sources.map((s) => s.source)).toEqual([...LANDSCAPE_SOURCES]);
  });

  test('`not_wired` and `empty` are DIFFERENT states with different sentences', async () => {
    // One says Capiro looked and found nothing; the other says Capiro cannot
    // look yet. Collapsing them turns "we have not built this" into "there is
    // nothing there".
    const { service } = makeService({ readProgramElementLinks: async () => [] });
    const packet = await service.compose(TENANT, USER, CLIENT, 'sam_gov', SAM_ID, AS_OF);
    const pe = packet.sources.find((s) => s.source === 'program_element')!;
    const hearings = packet.sources.find((s) => s.source === 'hearing')!;
    expect(pe.state).toBe('empty');
    expect(hearings.state).toBe('not_wired');
    expect(pe.explanation).not.toBe(hearings.explanation);
  });

  test('every not_wired explanation explicitly denies making a claim', async () => {
    const { service } = makeService();
    const packet = await service.compose(TENANT, USER, CLIENT, 'sam_gov', SAM_ID, AS_OF);
    for (const report of packet.sources.filter((s) => s.state === 'not_wired')) {
      expect(report.explanation).toMatch(/Nothing here says/i);
    }
  });

  test('coverage counts available over wired over declared, and is not a confidence', async () => {
    // A packet can be fully covered and contain nothing — Capiro looked
    // everywhere it can and found no connection, which is a real finding.
    const { service } = makeService();
    const packet = await service.compose(TENANT, USER, CLIENT, 'sam_gov', SAM_ID, AS_OF);
    expect(packet.coverage.wired).toBe(WIRED_LANDSCAPE_SOURCES.size);
    expect(packet.coverage.declared).toBe(LANDSCAPE_SOURCES.length);
    expect(packet.coverage.available).toBeLessThanOrEqual(packet.coverage.wired);
  });

  test('an unwired source contributes NO items, ever', async () => {
    const { service } = makeService();
    const packet = await service.compose(TENANT, USER, CLIENT, 'sam_gov', SAM_ID, AS_OF);
    for (const i of packet.items) expect(WIRED_LANDSCAPE_SOURCES.has(i.source)).toBe(true);
  });
});

describe('the packet is deterministic down to its hash', () => {
  test('the ordering is TOTAL — a tie on every other key still sorts stably', () => {
    // Without the id tiebreaker, two facilities in one state would sort by
    // whatever order Postgres returned them in, and the fingerprint would move
    // without any fact moving.
    const a = item({ sourceId: 'b', matchedOn: 'FL' });
    const b = item({ sourceId: 'a', matchedOn: 'FL' });
    expect(orderLandscapeItems([a, b]).map((i) => i.sourceId)).toEqual(['a', 'b']);
    expect(orderLandscapeItems([b, a]).map((i) => i.sourceId)).toEqual(['a', 'b']);
  });

  test('the same facts in any order produce the same fingerprint', () => {
    const one = item({ sourceId: '1', matchedOn: 'A' });
    const two = item({ source: 'client_facility', sourceId: '2', matchedOn: 'B' });
    expect(landscapeFingerprint(orderLandscapeItems([one, two]))).toBe(
      landscapeFingerprint(orderLandscapeItems([two, one])),
    );
  });

  test('a re-worded LABEL does not move the fingerprint', () => {
    // A label is composed prose a copy edit would change. Hashing it would make
    // the fingerprint report "the landscape changed" for a wording tweak.
    const original = orderLandscapeItems([item({ label: 'Original wording' })]);
    const reworded = orderLandscapeItems([item({ label: 'Rewritten wording' })]);
    expect(landscapeFingerprint(original)).toBe(landscapeFingerprint(reworded));
  });

  test('a re-observed asOf does not move the fingerprint', () => {
    const before = orderLandscapeItems([item({ asOf: '2026-01-01T00:00:00.000Z' })]);
    const after = orderLandscapeItems([item({ asOf: '2026-08-01T00:00:00.000Z' })]);
    expect(landscapeFingerprint(before)).toBe(landscapeFingerprint(after));
  });

  test('a changed BASIS does move it — that is a fact changing', () => {
    expect(landscapeFingerprint([item({ basis: 'source_backed' })])).not.toBe(
      landscapeFingerprint([item({ basis: 'inferred' })]),
    );
  });

  test('two composes of the same facts are byte-identical', async () => {
    const a = await makeService().service.compose(TENANT, USER, CLIENT, 'sam_gov', SAM_ID, AS_OF);
    const b = await makeService().service.compose(TENANT, USER, CLIENT, 'sam_gov', SAM_ID, AS_OF);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test('generatedAt is the caller’s clock, never a fresh one', async () => {
    const { service } = makeService();
    const packet = await service.compose(TENANT, USER, CLIENT, 'sam_gov', SAM_ID, AS_OF);
    expect(packet.generatedAt).toBe(AS_OF.toISOString());
  });
});

describe('one query per source, and no model anywhere', () => {
  test('the reads are issued once each regardless of item count', async () => {
    const { service, calls } = makeService({
      readClientFacilities: async () =>
        Array.from({ length: 40 }, (_, i) => ({
          id: `f${i}`,
          name: `Site ${i}`,
          state: 'FL',
          congressionalDistrict: '04',
        })),
    });
    const packet = await service.compose(TENANT, USER, CLIENT, 'sam_gov', SAM_ID, AS_OF);
    expect(packet.items.length).toBeGreaterThan(40);
    expect(calls).toEqual({ pe: 1, facilities: 1, place: 1 });
  });

  const source = readFileSync(join(__dirname, 'government-landscape.service.ts'), 'utf8');

  test('no LLM, no web research, no external call', () => {
    // IMPORTS and CALLS, not the word: this file's own doc says "No LLM, no
    // generic web research" in prose, and a bare substring search matches the
    // promise rather than a violation of it.
    const imports = (source.match(/^import[\s\S]*?from '[^']+';$/gm) ?? []).join(' ');
    expect(imports).not.toMatch(/anthropic|openai|langchain|meri|llm/i);
    expect(source).not.toMatch(/fetch\(/);
    expect(source).not.toMatch(/axios|https?:\/\/(?!$)/);
  });

  test('the composer writes nothing to the database', () => {
    // Scoped to a Prisma delegate. `createHash(...).update(...)` is a hash
    // being built, not a row being written, and a bare `.update(` search cannot
    // tell the two apart.
    expect(source).not.toMatch(/tx\.\w+\.(create|update|upsert|delete|createMany|updateMany)\(/);
    expect(source).not.toMatch(/prisma\.\w+\.(create|update|upsert|delete)\(/);
  });

  test('the only clock is the caller’s asOf parameter', () => {
    // A packet whose hash moved must mean a fact moved, so no clock may appear
    // in the composition. The one permitted `new Date()` is the DEFAULT VALUE of
    // the `asOf` parameter itself, which is the caller's clock by another name.
    // Prose stripped first: the file's own doc explains the exception, and a
    // raw count would score the explanation as a violation.
    const code = source.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const clocks = code.match(/new Date\(\)/g) ?? [];
    const defaults = code.match(/asOf: Date = new Date\(\)/g) ?? [];
    expect(clocks.length).toBe(1);
    expect(defaults.length).toBe(1);
  });
});
