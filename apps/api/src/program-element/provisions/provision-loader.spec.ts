import { describe, expect, jest, test } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { classifyProvisionAction } from './provision-action-classifier.js';
import {
  ProvisionLoader,
  buildLinksForProvision,
  trigrams,
  type ProgramAliasRow,
  type ProjectTitleRow,
  type ProvisionArtifact,
  type ProvisionLinkRow,
  type ProvisionLoaderPrisma,
} from './provision-loader.js';

/**
 * NOTE: the committed __fixtures__/committee_provisions_SAMPLE_fixture.json is a SYNTHETIC
 * test fixture — NOT real extracted committee-report data. The real loader consumes
 * committee_provisions_<report>_<fy>.json artifacts produced by the (deferred) pdfplumber
 * language-extraction pass. These tests exercise classification + linking against the
 * synthetic fixture (plus one in-spec provision carrying a verbatim PE code, since the
 * synthetic fixture intentionally contains none).
 */

const FIXTURE_PATH = path.resolve(__dirname, '__fixtures__/committee_provisions_SAMPLE_fixture.json');

function readFixture(): ProvisionArtifact {
  const raw = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) as ProvisionArtifact & { _note?: string };
  return { committee: raw.committee, fy: raw.fy, sourceDocumentId: raw.sourceDocumentId ?? null, provisions: raw.provisions };
}

/**
 * Fake ProvisionLoaderPrisma. Records every upserted provision + inserted link in arrays,
 * enforces the SAME idempotency contracts the DB does:
 *   - provision natural key (sourceDocumentId|'', committee, fy, heading, pageStart) → one row
 *   - link functional key (provisionId, peCode|'', programId|'') → ON CONFLICT DO NOTHING
 */
function makeFakePrisma(opts: {
  aliases?: ProgramAliasRow[];
  projectTitles?: ProjectTitleRow[];
  existingPeCodes?: string[];
}) {
  const existing = new Set(opts.existingPeCodes ?? []);
  const provisionsByKey = new Map<string, { id: string; actionType: string | null }>();
  const linksByKey = new Map<string, ProvisionLinkRow>();
  const provisionUpsertCalls: Array<Record<string, unknown>> = [];

  const fake: ProvisionLoaderPrisma = {
    loadAliases: jest.fn(async () => opts.aliases ?? []),
    loadProjectTitles: jest.fn(async () => opts.projectTitles ?? []),
    filterExistingPeCodes: jest.fn(async (candidates: string[]) => candidates.filter((c) => existing.has(c))),
    upsertProvision: jest.fn(async (input: Parameters<ProvisionLoaderPrisma['upsertProvision']>[0]) => {
      provisionUpsertCalls.push(input as unknown as Record<string, unknown>);
      const key = [input.sourceDocumentId ?? '', input.committee, input.fy, input.heading, input.pageStart ?? ''].join('::');
      const prev = provisionsByKey.get(key);
      if (prev) {
        prev.actionType = input.actionType; // UPDATE semantics
        return { id: prev.id };
      }
      const id = `prov-${provisionsByKey.size + 1}`;
      provisionsByKey.set(key, { id, actionType: input.actionType });
      return { id };
    }),
    insertLinkIfAbsent: jest.fn(async (link: ProvisionLinkRow) => {
      const key = [link.provisionId, link.peCode ?? '', link.programId ?? ''].join('::');
      if (linksByKey.has(key)) return 0; // ON CONFLICT DO NOTHING
      linksByKey.set(key, link);
      return 1;
    }),
  };

  return {
    fake,
    provisionsByKey,
    linksByKey,
    provisionUpsertCalls,
    links: () => Array.from(linksByKey.values()),
  };
}

describe('buildLinksForProvision (pure)', () => {
  test('a verbatim PE code yields an ACCEPTED pe_code link (high confidence)', () => {
    const links = buildLinksForProvision(
      {
        id: 'p1',
        heading: 'Increase for long-range fires development',
        text: 'The committee recommends an increase of $25.0 million for program element 0604801F to accelerate prototype development.',
      },
      new Set(['0604801F']),
      [],
      [],
    );
    const peLinks = links.filter((l) => l.matchBasis === 'pe_code');
    expect(peLinks).toHaveLength(1);
    expect(peLinks[0]).toMatchObject({ peCode: '0604801F', matchBasis: 'pe_code', reviewStatus: 'accepted' });
    expect(peLinks[0]!.confidence).toBeGreaterThanOrEqual(0.9);
  });

  test('a PE code that does NOT exist in program_element is not linked', () => {
    const links = buildLinksForProvision(
      { id: 'p1', heading: 'h', text: 'references 0604801F which does not exist' },
      new Set(), // nothing exists
      [],
      [],
    );
    expect(links.filter((l) => l.matchBasis === 'pe_code')).toHaveLength(0);
  });

  test('an alias-only match yields a CANDIDATE link (never accepted), capped + confidence < accept band', () => {
    const aliasIndex = [{ programId: 'prog-lrf', aliasNormalized: 'LONG RANGE FIRES' }].map((a) => ({
      ...a,
      tg: trigrams(a.aliasNormalized),
    }));
    const links = buildLinksForProvision(
      {
        id: 'p1',
        heading: 'Increase for long-range fires development',
        text: 'The committee recommends an increase for the long range fires program to accelerate prototype development.',
      },
      new Set(),
      [],
      aliasIndex,
    );
    const aliasLinks = links.filter((l) => l.matchBasis === 'program_alias');
    expect(aliasLinks.length).toBeGreaterThanOrEqual(1);
    for (const l of aliasLinks) {
      expect(l.reviewStatus).toBe('candidate');
      expect(l.reviewStatus).not.toBe('accepted');
      expect(l.confidence).toBeLessThanOrEqual(0.6);
      expect(l.programId).toBe('prog-lrf');
    }
  });

  test('project-title verbatim match yields a CANDIDATE project_title link', () => {
    const projectTitles: ProjectTitleRow[] = [
      { peCode: '0604801F', projectCode: 'A12', title: 'Hypersonic ground-test infrastructure' },
    ];
    const links = buildLinksForProvision(
      {
        id: 'p1',
        heading: 'Briefing on hypersonic test infrastructure',
        text: 'The committee directs a plan to expand Hypersonic ground-test infrastructure across the range.',
      },
      new Set(),
      projectTitles,
      [],
    );
    const titleLinks = links.filter((l) => l.matchBasis === 'project_title');
    expect(titleLinks).toHaveLength(1);
    expect(titleLinks[0]).toMatchObject({
      peCode: '0604801F',
      projectCode: 'A12',
      matchBasis: 'project_title',
      reviewStatus: 'candidate',
    });
  });
});

describe('ProvisionLoader.load (injected fake prisma)', () => {
  test('classifies actionType per provision from the SAMPLE fixture', async () => {
    const artifact = readFixture();
    const { fake, provisionUpsertCalls } = makeFakePrisma({});
    const loader = new ProvisionLoader(fake, classifyProvisionAction);

    await loader.load([artifact], { commit: true });

    const byHeading = new Map(provisionUpsertCalls.map((c) => [c.heading as string, c.actionType as string | null]));
    expect(byHeading.get('Briefing on hypersonic test infrastructure')).toBe('directs_briefing');
    expect(byHeading.get('Increase for long-range fires development')).toBe('adds');
    expect(byHeading.get('Limitation on retirement of legacy platform')).toBe('restricts');
    // Pure descriptive narrative → unclassified (null), stored as-is rather than guessed.
    expect(byHeading.get('Program element overview')).toBeNull();
  });

  test('a provision whose text has a verbatim, EXISTING PE code yields an ACCEPTED pe_code link', async () => {
    // The synthetic fixture has no PE codes, so feed an in-spec artifact for this path.
    const artifact: ProvisionArtifact = {
      committee: 'HASC',
      fy: 2027,
      sourceDocumentId: null,
      provisions: [
        {
          heading: 'Increase for long-range fires development',
          text: 'The committee recommends an increase of $25.0 million for program element 0604801F.',
          pageStart: 143,
          pageEnd: 143,
        },
      ],
    };
    const { fake, links } = makeFakePrisma({ existingPeCodes: ['0604801F'] });
    const loader = new ProvisionLoader(fake, classifyProvisionAction);

    await loader.load([artifact], { commit: true });

    const peLinks = links().filter((l) => l.matchBasis === 'pe_code');
    expect(peLinks).toHaveLength(1);
    expect(peLinks[0]).toMatchObject({ peCode: '0604801F', reviewStatus: 'accepted' });
  });

  test('an alias-only match yields a CANDIDATE link and never accepts', async () => {
    const artifact = readFixture(); // contains "long-range fires program element" language
    const { fake, links } = makeFakePrisma({
      aliases: [{ programId: 'prog-lrf', aliasNormalized: 'LONG RANGE FIRES' }],
    });
    const loader = new ProvisionLoader(fake, classifyProvisionAction);

    await loader.load([artifact], { commit: true });

    const aliasLinks = links().filter((l) => l.matchBasis === 'program_alias');
    expect(aliasLinks.length).toBeGreaterThanOrEqual(1);
    expect(aliasLinks.every((l) => l.reviewStatus === 'candidate')).toBe(true);
    expect(aliasLinks.some((l) => l.reviewStatus === 'accepted')).toBe(false);
  });

  test('re-run is idempotent: no duplicate provisions and no duplicate links', async () => {
    const artifact: ProvisionArtifact = {
      committee: 'HASC',
      fy: 2027,
      sourceDocumentId: 'doc-1',
      provisions: [
        {
          heading: 'Increase for long-range fires development',
          text: 'The committee recommends an increase of $25.0 million for program element 0604801F. Long range fires program.',
          pageStart: 143,
          pageEnd: 144,
        },
      ],
    };
    const harness = makeFakePrisma({
      existingPeCodes: ['0604801F'],
      aliases: [{ programId: 'prog-lrf', aliasNormalized: 'LONG RANGE FIRES' }],
    });
    const loader = new ProvisionLoader(harness.fake, classifyProvisionAction);

    const first = await loader.load([artifact], { commit: true });
    const linksAfterFirst = harness.links().length;
    const provisionsAfterFirst = harness.provisionsByKey.size;

    const second = await loader.load([artifact], { commit: true });

    // Same provision row (UPDATE, not INSERT) and no new links on the re-run.
    expect(harness.provisionsByKey.size).toBe(provisionsAfterFirst);
    expect(harness.links().length).toBe(linksAfterFirst);
    expect(second.provisionsUpserted).toBe(first.provisionsUpserted);
    // The 2nd run inserts ZERO links (all conflicted).
    const insertedSecond = Object.values(second.linksInsertedByBasis).reduce((a, b) => a + b, 0);
    expect(insertedSecond).toBe(0);
  });

  test('dry run computes a summary without any DB write', async () => {
    const artifact = readFixture();
    const harness = makeFakePrisma({
      aliases: [{ programId: 'prog-lrf', aliasNormalized: 'LONG RANGE FIRES' }],
    });
    const loader = new ProvisionLoader(harness.fake, classifyProvisionAction);

    const summary = await loader.load([artifact], { commit: false });

    expect(summary.filesRead).toBe(1);
    expect(summary.provisionsUpserted).toBe(artifact.provisions.length);
    expect(harness.provisionUpsertCalls).toHaveLength(0); // NO writes in dry run
    expect(harness.links()).toHaveLength(0);
    expect(harness.fake.upsertProvision).not.toHaveBeenCalled();
    expect(harness.fake.insertLinkIfAbsent).not.toHaveBeenCalled();
  });
});
