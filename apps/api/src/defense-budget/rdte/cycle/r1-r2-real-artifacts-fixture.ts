/**
 * Shared real-artifact builders for R-1 <-> R-2 reconciliation tests
 * (Phase 10B-16 Part G, Phase 10B-17 Part D/E). Not a spec file itself --
 * imported by `r1-r2-cross-reconciliation.spec.ts` and
 * `r1-r2-reconciliation-bridge.spec.ts` so both exercise the exact same
 * real-artifact construction rather than two independently-drifting copies.
 *
 * Both artifacts are built from real, previously-captured parser output:
 *   - R-1: `production-fy2024-r1-raw-parser-output-114pages.json` through
 *     the exact production R-1 branch (`applyR1TextReconstructionV1` ->
 *     `extractR1FromPages` -> `buildR1Artifact`).
 *   - R-2: `production-fy2024-army-r2-raw-parser-output-170pages.json`
 *     through the exact production R-2 branch.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseParserRuntimeResultV1,
  type ParserPageResultV1,
} from '../../parser-router/parser-runtime-contract-v1.js';
import { applyR1TextReconstructionV1 } from '../r1/r1-text-row-reconstructor-v1.js';
import { extractR1FromPages } from '../r1/r1-extractor-v1.js';
import { buildR1Artifact } from '../r1/r1-artifact-builder-v1.js';
import { segmentR2ExhibitPages } from '../r2/r2-exhibit-segmenter.js';
import { resolveR2Contexts } from '../r2/r2-context-resolver.js';
import { extractR2Identities } from '../r2/r2-identity-extractor-v1.js';
import { extractR2Narrative } from '../r2/r2-narrative-extractor-v1.js';
import { extractR2PeFunding } from '../r2/r2-cost-table-extractor-v1.js';
import { buildR2PeFundingArtifact } from '../r2/r2-pe-funding-builder.js';
import { buildCompleteR2Artifact } from '../r2/r2-complete-artifact-builder-v1.js';
import type { DefenseBudgetExtractionArtifactV1 } from '../../contracts/extraction-artifact-v1.js';

export const R1_SOURCE_SHA = 'ed9f94b6068c8f1ce40483adfe69d644cc3f033bbcc8271537db39ca91101425';
export const R1_SOURCE_DOCUMENT_ID = '62e8a102-4f01-471b-9cb6-eab58cb41270';
export const R1_SOURCE_URL =
  'https://comptroller.war.gov/Portals/45/Documents/defbudget/FY2024/FY2024_r1.pdf';

export const R2_SOURCE_SHA = '1fb7402152d0ec6ca536e20ac8d3ed8e7da61951ee691d1d05388abb4c462ab6';
export const R2_SOURCE_DOCUMENT_ID = '1d20fc43-b6c0-4212-b6fd-aa95cbc3c342';
export const R2_SOURCE_URL =
  'https://www.asafm.army.mil/Portals/72/Documents/BudgetMaterial/2024/Base%20Budget/rdte/RDTE-Vol%201-Budget%20Activity%201.pdf';

export const TARGET_PE = '0601102A';
export const CYCLE_FISCAL_YEAR = 2024;

function readRawPages(fixtureName: string, expectedSha: string): ParserPageResultV1[] {
  const fixturePath = join(__dirname, '__fixtures__', fixtureName);
  if (!existsSync(fixturePath)) throw new Error(`missing fixture: ${fixturePath}`);
  const raw = JSON.parse(readFileSync(fixturePath, 'utf8')) as unknown;
  const parsed = parseParserRuntimeResultV1(raw);
  if (parsed.inputSourceSha256 !== expectedSha) {
    throw new Error(
      `fixture source SHA drifted: expected ${expectedSha}, got ${parsed.inputSourceSha256}`,
    );
  }
  return parsed.pages as ParserPageResultV1[];
}

export function buildRealR1Artifact(): DefenseBudgetExtractionArtifactV1 {
  const pages = readRawPages('production-fy2024-r1-raw-parser-output-114pages.json', R1_SOURCE_SHA);
  const reconstruction = applyR1TextReconstructionV1(pages, CYCLE_FISCAL_YEAR);
  const extraction = extractR1FromPages({
    pages: reconstruction.pages,
    cycleFiscalYear: CYCLE_FISCAL_YEAR,
    rowContextByPage: reconstruction.rowContextByPage,
  });
  return buildR1Artifact({
    source: {
      manifestDocumentKey: R1_SOURCE_DOCUMENT_ID,
      sourceDocumentId: R1_SOURCE_DOCUMENT_ID,
      sourcePdfSha256: R1_SOURCE_SHA,
      sourceLocator: R1_SOURCE_URL,
      sourceUrl: R1_SOURCE_URL,
      fiscalYear: CYCLE_FISCAL_YEAR,
      family: 'rdte',
      exhibit: 'R-1',
      authority: 'dod-comptroller',
      component: 'UNKNOWN',
      budgetCycle: 'pb',
      documentType: 'r1',
      title: 'r1',
    },
    parserRuns: [],
    extraction: { ...extraction, omissions: [...extraction.omissions, ...reconstruction.omissions] },
    cycleFiscalYear: CYCLE_FISCAL_YEAR,
  });
}

function toContiguousRanges(pages: readonly number[]): Array<{ startPage: number; endPage: number }> {
  const sorted = [...pages].sort((a, b) => a - b);
  const ranges: Array<{ startPage: number; endPage: number }> = [];
  for (const page of sorted) {
    const last = ranges[ranges.length - 1];
    if (last != null && page === last.endPage + 1) last.endPage = page;
    else ranges.push({ startPage: page, endPage: page });
  }
  return ranges;
}

export function buildRealR2Artifact(): DefenseBudgetExtractionArtifactV1 {
  const pages = readRawPages(
    'production-fy2024-army-r2-raw-parser-output-170pages.json',
    R2_SOURCE_SHA,
  );
  const source = {
    manifestDocumentKey: R2_SOURCE_DOCUMENT_ID,
    sourceDocumentId: R2_SOURCE_DOCUMENT_ID,
    sourcePdfSha256: R2_SOURCE_SHA,
    sourceLocator: R2_SOURCE_URL,
    sourceUrl: R2_SOURCE_URL,
    fiscalYear: CYCLE_FISCAL_YEAR,
    family: 'rdte' as const,
    exhibit: 'R-2' as const,
    authority: 'dod-comptroller' as const,
    component: 'ARMY' as const,
    budgetCycle: 'pb',
    documentType: 'r2',
    title: 'r2',
  };
  const parserRuns = [
    {
      parserRunId: `pr1_real_r2_${R2_SOURCE_SHA.slice(0, 16)}`,
      method: 'deterministic_pdfplumber' as const,
      parserVersion: 'pdfplumber-0.11.0',
      parserConfigSha256: '3bc9df29aec9638eee25da1d99832c01f59b1c1d99f0a0346f74cf16975ce9b1',
      inputSourceSha256: R2_SOURCE_SHA,
      outputArtifactSha256: R2_SOURCE_SHA,
      pageRanges: toContiguousRanges(pages.map((p) => p.page)),
    },
  ];

  const resolution = resolveR2Contexts(segmentR2ExhibitPages(pages));
  const identities = extractR2Identities({ pages, contextResolution: resolution });
  const narrative = extractR2Narrative({ pages, contextResolution: resolution });

  const contexts = new Map<string, { pageStart: number; pageEnd: number }>();
  for (const page of resolution.pages) {
    if (page.kind !== 'r2_pe_summary' && page.kind !== 'r2_continuation') continue;
    if (!page.peCode) continue;
    const current = contexts.get(page.peCode);
    if (current) {
      current.pageStart = Math.min(current.pageStart, page.page);
      current.pageEnd = Math.max(current.pageEnd, page.page);
    } else contexts.set(page.peCode, { pageStart: page.page, pageEnd: page.page });
  }
  const funding = [...contexts.entries()].map(([peCode, range]) =>
    extractR2PeFunding({ pages, peContext: { peCode, ...range }, cycleFiscalYear: CYCLE_FISCAL_YEAR }),
  );
  const fundingArtifact = buildR2PeFundingArtifact({
    source,
    parserRuns,
    extractions: funding,
    comparisonRequests: [],
    cycleFiscalYear: CYCLE_FISCAL_YEAR,
  });
  return buildCompleteR2Artifact({ fundingArtifact, parserRuns, identities, narrative });
}
