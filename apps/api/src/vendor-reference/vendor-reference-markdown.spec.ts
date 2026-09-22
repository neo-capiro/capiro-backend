import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildFrontmatter,
  CONTRACTING_TABLE_HEADER,
  DELEGATION_TABLE_HEADER,
  GENERATED_BY,
  HANDLING_NOTES_HEADING,
  ITEM_TABLE_HEADER,
  LOBBYING_TABLE_HEADER,
  renderVendorReferenceMarkdown,
  SECTION_HEADINGS,
  verificationLabel,
} from './vendor-reference-markdown.js';
import {
  DOSSIER_SECTIONS,
  LITIGATION_FINDING,
  LITIGATION_ITEM,
  LITIGATION_SOURCE,
  litigationRow,
  type VendorReferenceDossier,
} from './vendor-reference.types.js';

const TEMPLATE_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  'api-strategy',
  'src',
  'context',
  'templates',
  '15_vendor_reference_pull.md',
);

function dossier(over: Partial<VendorReferenceDossier> = {}): VendorReferenceDossier {
  return {
    generatedAt: '2026-09-17T12:00:00.000Z',
    asOf: '2026-09-17',
    input: { name: 'Lockheed Martin Corporation', uei: 'KM99JJBNQ9M5' },
    identity: {
      inputName: 'Lockheed Martin Corporation',
      matchedName: 'LOCKHEED MARTIN CORPORATION',
      uei: 'KM99JJBNQ9M5',
      cageCode: '3V1F7',
      basis: 'uei_input',
      samVerified: true,
      ambiguous: false,
      candidates: [],
      nameVariants: ['Lockheed Martin Corporation', 'LOCKHEED MARTIN CORPORATION'],
      explanation: 'Caller supplied UEI KM99JJBNQ9M5; SAM.gov confirms it.',
    },
    rows: [
      {
        section: 'company_identity',
        item: 'Legal name and DBA',
        finding: 'LOCKHEED MARTIN CORPORATION',
        source: 'SAM.gov entity',
        verification: 'confirmed',
      },
      {
        section: 'company_identity',
        item: 'Ownership and parent',
        finding: 'Not sourced; enter and cite independently',
        source: 'Manual',
        verification: 'not_sourced',
      },
      {
        section: 'federal_market_credentials',
        item: 'UEI',
        finding: 'KM99JJBNQ9M5',
        source: 'SAM.gov entity',
        verification: 'confirmed',
      },
      {
        section: 'federal_contracting_history',
        item: 'FA8611-26-C-0001 — F-35 sustainment | lot 19',
        finding: '',
        source: 'USAspending (contracts) / Capiro ingestion',
        verification: 'confirmed',
        detail: {
          agency: 'Department of Defense / Department of the Air Force',
          type: 'Contract',
          value: 1234567.89,
          awardDate: '2026-03-01',
          periodOfPerformance: null,
          matchBasis: 'exact_uei',
          recordId: 'CONT_AWD_1',
        },
      },
      {
        section: 'federal_lobbying_representation',
        item: 'Capitol Counsel LLC',
        finding: '',
        source: 'Senate LDA',
        verification: 'confirmed',
        detail: {
          registrant: 'Capitol Counsel LLC',
          clientOfRecord: 'LOCKHEED MARTIN CORPORATION',
          period: 'Q2 2026',
          income: 90000,
          issueCodes: ['DEF', 'BUD'],
          filingType: 'Q2',
          filingUuid: 'f-1',
          matchBasis: 'exact_legal_name',
        },
      },
      {
        section: 'congressional_delegation',
        item: 'Jane Doe (D)',
        finding: '',
        source: 'Capiro directory',
        verification: 'confirmed',
        detail: {
          bioguideId: 'D000001',
          member: 'Jane Doe (D)',
          chamber: 'House',
          stateDistrict: 'MD-08',
          committee: 'House Committee on Armed Services',
          committeeSystemCode: 'hsas00',
          role: 'Chair',
          districtBasis: 'sam_physical_address',
        },
      },
      litigationRow(),
    ],
    warnings: [],
    handlingNotes: ['Identity: caller supplied UEI.', 'Litigation is never sourced.'],
    ...over,
  };
}

describe('renderVendorReferenceMarkdown — template contract', () => {
  const template = readFileSync(TEMPLATE_PATH, 'utf8');
  const md = renderVendorReferenceMarkdown(dossier());

  test('every section heading in the template appears, in template order', () => {
    const templateHeadings = template.split(/\r?\n/).filter((l) => l.startsWith('## '));
    expect(templateHeadings).toEqual([...DOSSIER_SECTIONS.map((s) => SECTION_HEADINGS[s]), HANDLING_NOTES_HEADING]);
    let cursor = -1;
    for (const h of templateHeadings) {
      const idx = md.indexOf(`\n${h}\n`);
      expect(idx).toBeGreaterThan(cursor);
      cursor = idx;
    }
  });

  test('every table header line in the template is emitted verbatim', () => {
    const templateHeaders = template
      .split(/\r?\n/)
      .filter((l) => /^\| [A-Z]/.test(l) && !/Confirmed|Unverified/.test(l));
    expect(templateHeaders).toEqual(
      expect.arrayContaining([ITEM_TABLE_HEADER, CONTRACTING_TABLE_HEADER, LOBBYING_TABLE_HEADER, DELEGATION_TABLE_HEADER]),
    );
    for (const h of new Set(templateHeaders)) expect(md).toContain(`\n${h}\n`);
    // Item table appears for identity, credentials and litigation (3x).
    expect(md.split(`\n${ITEM_TABLE_HEADER}\n`).length - 1).toBe(3);
  });

  test('litigation row is rendered exactly as mandated and never populated', () => {
    expect(md).toContain(
      `| ${LITIGATION_ITEM} | ${LITIGATION_FINDING} | ${LITIGATION_SOURCE} | ${verificationLabel('not_sourced')} |`,
    );
    expect(md).toContain('> Capiro has no automated source for litigation or adverse history.');
  });

  test('structured columns render from detail and pipes are escaped', () => {
    expect(md).toContain(
      '| FA8611-26-C-0001 — F-35 sustainment \\| lot 19 | Department of Defense / Department of the Air Force | Contract | $1,234,568 | 2026-03-01 |  | USAspending (contracts) / Capiro ingestion | Confirmed |',
    );
    expect(md).toContain('| Capitol Counsel LLC | LOCKHEED MARTIN CORPORATION | Q2 2026 | $90,000 | DEF, BUD | Senate LDA | Confirmed |');
    expect(md).toContain('| Jane Doe (D) | House | MD-08 | House Committee on Armed Services | Chair | Capiro directory | Confirmed |');
  });

  test('handling notes and identity block are present', () => {
    expect(md).toContain('- Identity: caller supplied UEI.');
    expect(md).toContain('> **Identity basis:** Exact UEI (caller-supplied)');
  });

  test('labels enforced base-award semantics', () => {
    const enforced = dossier();
    enforced.rows[3]!.detail = {
      ...enforced.rows[3]!.detail,
      awardDateSemantics: 'base_award_signed',
    };
    expect(renderVendorReferenceMarkdown(enforced)).toContain('| Value | Award date (base signed) |');
  });

  test('labels enforced latest-action semantics', () => {
    const enforced = dossier();
    enforced.rows[3]!.detail = {
      ...enforced.rows[3]!.detail,
      awardDateSemantics: 'latest_action',
    };
    expect(renderVendorReferenceMarkdown(enforced)).toContain('| Value | Latest action date |');
  });
});

describe('buildFrontmatter — flat grammar + scope/id consistency', () => {
  const flat = /^[A-Za-z_][A-Za-z0-9_]*: (?:null|true|false|"[^"]*"|[A-Za-z_][A-Za-z0-9_]*)$/;

  function lines(fm: string): string[] {
    const body = fm.split('\n');
    expect(body[0]).toBe('---');
    expect(body[body.length - 1]).toBe('---');
    return body.slice(1, -1);
  }

  test('fixed keys match the template contract', () => {
    const fm = buildFrontmatter(dossier());
    for (const l of lines(fm)) expect(l).toMatch(flat);
    expect(fm).toContain('document_type: vendor_reference_pull');
    expect(fm).toContain('schema_version: "1.0"');
    expect(fm).toContain('as_of: "2026-09-17"');
    expect(fm).toContain('owner: "system"');
    expect(fm).toContain('authority: external_authoritative');
    expect(fm).toContain('source_of_truth: true');
    expect(fm).toContain(`generated_by: "${GENERATED_BY}"`);
    expect(GENERATED_BY).toBe('Capiro (partial; see the Verification column)');
  });

  test('no ids → scope once, ids null (never a placeholder id)', () => {
    const fm = buildFrontmatter(dossier());
    expect(fm).toContain('scope: once');
    expect(fm).toContain('client_id: null');
    expect(fm).toContain('strategy_id: null');
    expect(fm).not.toMatch(/client_123|strategy_456|user_123/);
  });

  test('clientId only → scope client with the real id', () => {
    const fm = buildFrontmatter(dossier({ input: { name: 'X', clientId: 'c-real' } }));
    expect(fm).toContain('scope: client');
    expect(fm).toContain('client_id: "c-real"');
    expect(fm).toContain('strategy_id: null');
  });

  test('strategyId → scope strategy with both real ids', () => {
    const fm = buildFrontmatter(dossier({ input: { name: 'X', clientId: 'c-real', strategyId: 's-real' } }));
    expect(fm).toContain('scope: strategy');
    expect(fm).toContain('client_id: "c-real"');
    expect(fm).toContain('strategy_id: "s-real"');
  });

  test('document_id is deterministic from the UEI and as_of', () => {
    expect(buildFrontmatter(dossier())).toContain('document_id: "ctx_vendor_pull_KM99JJBNQ9M5_20260917"');
  });
});
