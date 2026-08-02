/**
 * Workstream N — containment and architecture tests for the
 * defense_budget_extraction_v1 contract.
 *
 * Two layers of guard:
 *   1. Static scans over the contract/adapters/CLI sources: forbidden imports
 *      (writer, prisma, archive, llamaparse, AWS, fetch), fiscal-year
 *      hardcoding, random/wall-clock IDs, no entrypoint exposure, no canonical
 *      ingestion wiring. Comments are stripped before scanning so prose that
 *      names the forbidden symbols does not create false positives.
 *   2. Runtime truthfulness probes: prove adapters never rewrite parser
 *      provenance and never fabricate pages/boxes — these exercise the same
 *      properties the negative controls attack.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { adaptExtractionResultToArtifactV1 } from './adapters/extraction-result-v1.adapter.js';
import { adaptR1ArtifactToArtifactV1 } from './adapters/r1-artifact-v1.adapter.js';
import { adaptCommitteeArtifactToArtifactV1 } from './adapters/committee-artifact-v1.adapter.js';
import { adaptPdocArtifactToArtifactV1 } from './adapters/pdoc-artifact-v1.adapter.js';
import { adapterTestContext } from './adapters/testing-helpers.js';
import type { ExtractionResult } from '../extractors/types.js';

/* ------------------------------------------------------------------ */
/* static scan helpers                                                 */
/* ------------------------------------------------------------------ */

const CONTRACTS_DIR = __dirname;
const API_ROOT = path.resolve(CONTRACTS_DIR, '..', '..', '..');
const SCRIPTS_DIR = path.join(API_ROOT, 'scripts');

function listProductionContractFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.spec.ts') &&
        entry.name !== 'testing-helpers.ts'
      ) {
        out.push(full);
      }
    }
  };
  walk(CONTRACTS_DIR);
  return out.sort();
}

/** Strip block + line comments so documentation never creates false positives. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

function readStripped(file: string): string {
  return stripComments(fs.readFileSync(file, 'utf8'));
}

const CLI_SCRIPT_FILES = [
  'validate-defense-budget-cycle-manifest.ts',
  'convert-defense-budget-artifact.ts',
  'validate-defense-budget-extraction-artifact.ts',
].map((name) => path.join(SCRIPTS_DIR, name));

/* ------------------------------------------------------------------ */
/* forbidden imports — purity                                          */
/* ------------------------------------------------------------------ */

describe('contract purity — forbidden imports', () => {
  const FORBIDDEN: Array<{ label: string; pattern: RegExp }> = [
    { label: 'ProgramElementWriterService', pattern: /ProgramElementWriterService/ },
    { label: 'program-element-writer.service', pattern: /program-element-writer\.service/ },
    { label: 'PrismaService', pattern: /PrismaService/ },
    { label: '@prisma/client', pattern: /@prisma\/client/ },
    { label: 'RawArchiveService', pattern: /RawArchiveService/ },
    { label: 'LlamaParseClient', pattern: /LlamaParseClient/ },
    { label: 'AWS SDK clients', pattern: /@aws-sdk\// },
    { label: 'fetch(', pattern: /\bfetch\s*\(/ },
  ];

  it.each(listProductionContractFiles())('%s imports nothing forbidden', (file) => {
    const stripped = readStripped(file);
    for (const { label, pattern } of FORBIDDEN) {
      expect({ file, label, hit: pattern.test(stripped) }).toEqual({
        file,
        label,
        hit: false,
      });
    }
  });

  it.each(CLI_SCRIPT_FILES)('CLI %s imports nothing forbidden', (file) => {
    const stripped = readStripped(file);
    for (const { label, pattern } of FORBIDDEN) {
      expect({ file, label, hit: pattern.test(stripped) }).toEqual({
        file,
        label,
        hit: false,
      });
    }
  });

  it('the contract tree contains production files to scan', () => {
    expect(listProductionContractFiles().length).toBeGreaterThan(5);
  });
});

/* ------------------------------------------------------------------ */
/* determinism — no random/wall-clock IDs                              */
/* ------------------------------------------------------------------ */

describe('contract determinism', () => {
  it.each(listProductionContractFiles())('%s uses no random or wall-clock values', (file) => {
    const stripped = readStripped(file);
    expect({ file, hit: /randomUUID|Math\.random|Date\.now|new Date\s*\(/.test(stripped) }).toEqual(
      { file, hit: false },
    );
  });

  it.each(listProductionContractFiles())('%s hardcodes no fiscal years', (file) => {
    const stripped = readStripped(file);
    // Tests/examples may use fiscal years freely; production contract code must not.
    expect({
      file,
      hit: /\b(19|20|21)\d{2}\b/.test(stripped.replace(/min\(1900\)|max\(2200\)|1900|2200/g, '')),
    }).toEqual({ file, hit: false });
  });
});

/* ------------------------------------------------------------------ */
/* no production wiring                                                */
/* ------------------------------------------------------------------ */

describe('no production wiring of the new contract', () => {
  const PROTECTED_SCRIPTS = [
    'ingest-defense-budget-pdf.ts',
    'sync-comptroller-jbooks.ts',
    'sync-jbook-r2.ts',
    'sync-jbook-performers.ts',
    'parse-hasc-sasc-reports.ts',
    'parse-defense-approps-reports.ts',
    'parse-ndaa-conference.ts',
    'parse-defense-approps-public-law.ts',
    'parse-pdoc-army.ts',
  ];

  it.each(PROTECTED_SCRIPTS)('%s does not import the contract adapters', (script) => {
    const file = path.join(SCRIPTS_DIR, script);
    const stripped = readStripped(file);
    expect({ script, hit: /defense-budget\/contracts|contracts\/adapters/.test(stripped) }).toEqual(
      {
        script,
        hit: false,
      },
    );
  });

  it('entrypoint-dispatcher.inc does not expose the new local commands', () => {
    const dispatcher = fs.readFileSync(path.join(SCRIPTS_DIR, 'entrypoint-dispatcher.inc'), 'utf8');
    for (const command of [
      'convert-defense-budget-artifact',
      'validate-defense-budget-cycle-manifest',
      'validate-defense-budget-extraction-artifact',
      'convert:defense-budget-artifact',
      'validate:defense-budget-manifest',
      'validate:defense-budget-artifact',
    ]) {
      expect({ command, exposed: dispatcher.includes(command) }).toEqual({
        command,
        exposed: false,
      });
    }
  });
});

/* ------------------------------------------------------------------ */
/* runtime truthfulness probes (negative-control targets)              */
/* ------------------------------------------------------------------ */

describe('adapter provenance and evidence truthfulness', () => {
  it('extraction-result adapter keeps deterministic_pdfplumber as deterministic_pdfplumber', () => {
    const extraction: ExtractionResult = {
      lineAssertions: [],
      yearValues: [],
      warnings: [],
    } as unknown as ExtractionResult;
    const artifact = adaptExtractionResultToArtifactV1(
      extraction,
      adapterTestContext({ parser: { method: 'deterministic_pdfplumber' } as never }),
    );
    expect(artifact.parserRuns.map((run) => run.method)).toEqual(['deterministic_pdfplumber']);
  });

  it('extraction-result adapter keeps llamaparse as llamaparse', () => {
    const extraction: ExtractionResult = {
      lineAssertions: [],
      yearValues: [],
      warnings: [],
    } as unknown as ExtractionResult;
    const artifact = adaptExtractionResultToArtifactV1(
      extraction,
      adapterTestContext({ parser: { method: 'llamaparse' } as never }),
    );
    expect(artifact.parserRuns.map((run) => run.method)).toEqual(['llamaparse']);
  });

  it('committee adapter never coerces a missing page to page 1', () => {
    const artifact = adaptCommitteeArtifactToArtifactV1(
      { rows: [{ peCode: '0601102A', mark: 100 }] },
      adapterTestContext(),
      { mode: 'HASC', legacyDeclaredUnit: 'dollars', defaultFiscalYear: 2099 },
    );
    const rowEvidence = artifact.evidence.filter((ev) => ev.granularity !== 'document_only');
    expect(rowEvidence).toHaveLength(0);
    expect(artifact.evidence.every((ev) => ev.page !== 1 || ev.granularity !== 'page_only')).toBe(
      true,
    );
    expect(artifact.warnings.some((w) => w.code === 'legacy_committee_artifact_missing_page')).toBe(
      true,
    );
  });

  it('r1 adapter never fabricates a bounding box for page-only provenance', () => {
    const artifact = adaptR1ArtifactToArtifactV1(
      {
        docType: 'R',
        pageCount: 10,
        rows: [{ peCode: '0602308A', title: 'T', budgetActivity: null, lineNumber: null, page: 3 }],
        unparsed_pages: [],
        stats: { rows: 1, pages_with_rows: 1 },
      },
      adapterTestContext(),
      { fundingUnit: 'thousands' },
    );
    expect(artifact.evidence.every((ev) => ev.boundingBox == null)).toBe(true);
    expect(artifact.evidence.every((ev) => ev.textSpan == null)).toBe(true);
  });

  it('pdoc adapter never invents page evidence for page-less rows', () => {
    const artifact = adaptPdocArtifactToArtifactV1(
      {
        pes: [
          {
            peCode: '0132E00700',
            title: 'CTG',
            fyData: [{ fy: 2099, quantity: 1, requestDollarsThousands: 100, unitCostDollars: 100 }],
            lineItems: [],
          },
        ],
      },
      adapterTestContext({ family: 'procurement', exhibit: 'P-40' }),
      { account: 'procurement_of_ammunition_army', defaultFiscalYear: 2099 },
    );
    expect(artifact.evidence.every((ev) => ev.boundingBox == null)).toBe(true);
    expect(
      artifact.evidence
        .filter((ev) => ev.granularity === 'page_only')
        .every((ev) => ev.page != null),
    ).toBe(true);
  });
});
