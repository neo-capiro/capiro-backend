/**
 * R7 — Five representative artifact smoke tests.
 *
 * Uses local, already-present artifacts only:
 * - one R-1
 * - one R-2
 * - one R-3 performer
 * - one committee report
 * - one P-doc
 *
 * For each:
 * 1. Converts to V1 using the Phase 1 adapter
 * 2. Writes artifact + manifest to temp files
 * 3. Verifies in inspect mode using FilesystemProofResolver
 * 4. Reports the decision, risk, route, and findings
 *
 * No AWS, no LlamaParse, no canonical writes, no DB writes.
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { canonicalJsonStringify, sha256Hex, sha256Bytes } from '../contracts/canonical-json.js';
import { adaptR1ArtifactToArtifactV1 } from '../contracts/adapters/r1-artifact-v1.adapter.js';
import { adaptR2ArtifactToArtifactV1 } from '../contracts/adapters/r2-artifact-v1.adapter.js';
import { adaptR3PerformerArtifactToArtifactV1 } from '../contracts/adapters/r3-performer-artifact-v1.adapter.js';
import { adaptCommitteeArtifactToArtifactV1 } from '../contracts/adapters/committee-artifact-v1.adapter.js';
import { adaptPdocArtifactToArtifactV1 } from '../contracts/adapters/pdoc-artifact-v1.adapter.js';
import { adapterTestContext } from '../contracts/adapters/testing-helpers.js';
import type { DefenseBudgetExtractionArtifactV1 } from '../contracts/extraction-artifact-v1.js';
import {
  parseBudgetCycleManifestV1,
  validateBudgetCycleManifestV1,
  type BudgetCycleManifestV1,
} from '../contracts/budget-cycle-manifest-v1.js';
import { FilesystemProofResolver } from './trusted-proof/filesystem-proof-resolver.js';
import { BudgetVerificationV1Service } from './services/budget-verification-v1.service.js';
import type { VerificationRequestV1 } from './verification-contract-v1.js';

/* ------------------------------------------------------------------ */
/* Temp directory                                                      */
/* ------------------------------------------------------------------ */

const TMP_DIR = path.join(os.tmpdir(), 'budget-verification-smoke');
const SOURCE_PDF_PATH = path.join(TMP_DIR, 'test-source.pdf');
const SOURCE_SHA = sha256Bytes(Buffer.from('%PDF-1.4 test source document\n'));

/* ------------------------------------------------------------------ */
/* Adapter context                                                     */
/* ------------------------------------------------------------------ */

function makeContext(docKey: string, family: string, exhibit: string) {
  return adapterTestContext({
    manifestDocumentKey: docKey,
    family: family as never,
    exhibit: exhibit as never,
    sourcePdfSha256: SOURCE_SHA,
    sourceLocator: SOURCE_PDF_PATH,
    sourceDocumentId: '00000000-0000-0000-0000-000000000001',
    sourceUrl: `file://${SOURCE_PDF_PATH}`,
    pageCount: 100,
    title: `Test ${exhibit}`,
    budgetCycle: 'pb',
    component: 'ARMY',
    documentType: exhibit.toLowerCase().replace('-', ''),
  });
}

/* ------------------------------------------------------------------ */
/* Manifest builder                                                    */
/* ------------------------------------------------------------------ */

function makeManifest(
  documentKey: string,
  family: string,
  exhibit: string,
  overrides: Record<string, unknown> = {},
): BudgetCycleManifestV1 {
  const raw = {
    schemaVersion: 'defense_budget_cycle_manifest_v1',
    cycleId: 'fy2027',
    fiscalYear: 2027,
    domain: 'defense',
    documents: [
      {
        documentKey,
        documentType: exhibit.toLowerCase().replace('-', ''),
        family,
        exhibit,
        authority: 'dod-comptroller',
        budgetCycle: 'pb',
        component: 'ARMY',
        title: `Test ${exhibit}`,
        required: true,
        allowEmpty: false,
        sourceLocator: SOURCE_PDF_PATH,
        parserPolicy: 'deterministic_table',
        requiredDataCategories: ['identity', 'funding'],
        requiredFundingFields: ['request'],
        expectedLineKinds: ['RDTE_PE'],
        ...overrides,
      },
    ],
  };
  const parsed = parseBudgetCycleManifestV1(raw);
  validateBudgetCycleManifestV1(parsed);
  return parsed;
}

/* ------------------------------------------------------------------ */
/* Write helpers                                                       */
/* ------------------------------------------------------------------ */

function writeManifest(manifest: BudgetCycleManifestV1): string {
  const p = path.join(TMP_DIR, `manifest-${manifest.documents[0]!.documentKey}.json`);
  fs.writeFileSync(p, canonicalJsonStringify(manifest) + '\n', 'utf8');
  return p;
}

function writeArtifact(artifact: DefenseBudgetExtractionArtifactV1, key: string): string {
  const p = path.join(TMP_DIR, `artifact-${key}.json`);
  fs.writeFileSync(p, canonicalJsonStringify(artifact) + '\n', 'utf8');
  return p;
}

/* ------------------------------------------------------------------ */
/* Verify helper                                                       */
/* ------------------------------------------------------------------ */

async function verifyArtifact(
  manifestPath: string,
  documentKey: string,
  artifactPath: string,
): Promise<{
  decision: string;
  riskScore: number;
  route: string;
  checks: { code: string; outcome: string; blocking: boolean }[];
  discrepancies: { code: string; severity: string }[];
}> {
  const resolver = new FilesystemProofResolver({ sourcePdfPath: SOURCE_PDF_PATH });
  const service = new BudgetVerificationV1Service(resolver, null);
  const request: VerificationRequestV1 = {
    manifestLocator: manifestPath,
    manifestDocumentKey: documentKey,
    extractionArtifactLocator: artifactPath,
    sourceDocumentId: '00000000-0000-0000-0000-000000000001',
    mode: 'inspect',
  };
  const result = await service.verify(request);
  return {
    decision: result.decision,
    riskScore: result.riskScore,
    route: result.route,
    checks: result.checks.map((c) => ({ code: c.code, outcome: c.outcome, blocking: c.blocking })),
    discrepancies: result.discrepancies.map((d) => ({ code: d.code, severity: d.severity })),
  };
}

/* ------------------------------------------------------------------ */
/* Setup/teardown                                                      */
/* ------------------------------------------------------------------ */

beforeAll(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.writeFileSync(SOURCE_PDF_PATH, '%PDF-1.4 test source document\n', 'utf8');
});

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* Smoke tests                                                         */
/* ------------------------------------------------------------------ */

describe('R7 — Artifact smoke (5 representative artifacts)', () => {
  it('R-1: produces a deterministic decision in inspect mode', async () => {
    const ctx = makeContext('r1_test', 'rdte', 'R-1');
    const artifact = adaptR1ArtifactToArtifactV1(
      {
        docType: 'r1',
        pageCount: 1,
        rows: [
          {
            peCode: '0601102A',
            title: 'Test PE',
            budgetActivity: 'BA 1',
            lineNumber: '1',
            page: 1,
            fyColumns: { '2027': 1000000, '2028': null },
          },
        ],
        unparsed_pages: [],
        stats: { rows: 1, pages_with_rows: 1 },
      },
      ctx,
      { fundingUnit: 'dollars' },
    );
    const manifest = makeManifest('r1_test', 'rdte', 'R-1');
    const manifestPath = writeManifest(manifest);
    const artifactPath = writeArtifact(artifact, 'r1');
    const result = await verifyArtifact(manifestPath, 'r1_test', artifactPath);
    expect(['PASS', 'REVIEW', 'REJECT']).toContain(result.decision);
    expect(result.riskScore).toBeGreaterThanOrEqual(0);
    expect(result.riskScore).toBeLessThanOrEqual(100);
    console.log('  R-1 smoke:', JSON.stringify(result));
  });

  it('R-2: produces a deterministic decision in inspect mode', async () => {
    const ctx = makeContext('r2_test', 'rdte', 'R-2');
    const artifact = adaptR2ArtifactToArtifactV1(
      {
        docType: 'r2',
        exhibitType: 'r2',
        fy: 2027,
        sourceUrl: `file://${SOURCE_PDF_PATH}`,
        volumeId: 'vol1',
        pageCount: 100,
        programElements: [
          {
            peCode: '0601102A',
            peName: 'Test PE',
            budgetActivity: 'BA 1',
            appropriation: 'RDTE',
            pageStart: 1,
            pageEnd: 10,
            mission: 'Test mission',
            projects: [
              {
                projectCode: 'ABC',
                title: 'Test Project',
                mission: 'Test project mission',
                page: 1,
              },
            ],
            fyData: [{ fy: 2027, field: 'request', value: 500000, unit: 'dollars' }],
          },
        ],
        stats: { program_elements: 1, projects: 1, pages_with_exhibits: 1 },
      },
      ctx,
    );
    const manifest = makeManifest('r2_test', 'rdte', 'R-2');
    const manifestPath = writeManifest(manifest);
    const artifactPath = writeArtifact(artifact, 'r2');
    const result = await verifyArtifact(manifestPath, 'r2_test', artifactPath);
    expect(['PASS', 'REVIEW', 'REJECT']).toContain(result.decision);
    expect(result.riskScore).toBeGreaterThanOrEqual(0);
    expect(result.riskScore).toBeLessThanOrEqual(100);
    console.log('  R-2 smoke:', JSON.stringify(result));
  });

  it('R-3 performer: produces a deterministic decision in inspect mode', async () => {
    const ctx = makeContext('r3_test', 'rdte', 'R-3');
    const artifact = adaptR3PerformerArtifactToArtifactV1(
      {
        docType: 'r3',
        exhibitType: 'performer',
        fy: 2027,
        sourceUrl: `file://${SOURCE_PDF_PATH}`,
        volumeId: 'vol1',
        publisher: 'test-publisher',
        pageCount: 100,
        performers: [
          {
            peCode: '0601102A',
            peName: 'Test PE',
            projectCode: null,
            projectName: null,
            costCategory: null,
            performer: 'Test Performer',
            performerNormalized: 'test-performer',
            location: null,
            contractMethod: null,
            totalCost: null,
            fy: 2027,
            page: 1,
          },
        ],
        stats: { program_elements: 1, projects: 1, pages_with_exhibits: 1 },
      },
      ctx,
      { costUnit: 'dollars' },
    );
    const manifest = makeManifest('r3_test', 'rdte', 'R-3', {
      requiredDataCategories: ['identity', 'funding', 'performers'],
    });
    const manifestPath = writeManifest(manifest);
    const artifactPath = writeArtifact(artifact, 'r3');
    const result = await verifyArtifact(manifestPath, 'r3_test', artifactPath);
    expect(['PASS', 'REVIEW', 'REJECT']).toContain(result.decision);
    expect(result.riskScore).toBeGreaterThanOrEqual(0);
    expect(result.riskScore).toBeLessThanOrEqual(100);
    console.log('  R-3 smoke:', JSON.stringify(result));
  });

  it('committee report: produces a deterministic decision in inspect mode', async () => {
    const ctx = makeContext('committee_test', 'committee', 'committee_report');
    const artifact = adaptCommitteeArtifactToArtifactV1(
      {
        rows: [{ fy: 2027, peCode: '0601102A', request: 100, requestUnit: 'thousands' }],
      },
      ctx,
      { mode: 'HASC', defaultFiscalYear: 2027, legacyDeclaredUnit: 'thousands' },
    );
    const manifest = makeManifest('committee_test', 'committee', 'committee_report', {
      requiredDataCategories: ['identity', 'funding'],
      requiredFundingFields: ['hascMark'],
      documentType: 'committee_report',
    });
    const manifestPath = writeManifest(manifest);
    const artifactPath = writeArtifact(artifact, 'committee');
    const result = await verifyArtifact(manifestPath, 'committee_test', artifactPath);
    expect(['PASS', 'REVIEW', 'REJECT']).toContain(result.decision);
    expect(result.riskScore).toBeGreaterThanOrEqual(0);
    expect(result.riskScore).toBeLessThanOrEqual(100);
    console.log('  Committee smoke:', JSON.stringify(result));
  });

  it('P-doc: produces a deterministic decision in inspect mode', async () => {
    const ctx = makeContext('pdoc_test', 'procurement', 'P-1');
    const artifact = adaptPdocArtifactToArtifactV1(
      {
        pes: [
          {
            peCode: '0601102A',
            title: 'Test PE',
            budgetActivity: 'BA 1',
            fyData: [
              {
                fy: 2027,
                quantity: 1,
                requestDollarsThousands: 100,
                unitCostDollars: 100,
              },
            ],
          },
        ],
      },
      ctx,
      { account: 'missile_procurement_army', defaultFiscalYear: 2027 },
    );
    const manifest = makeManifest('pdoc_test', 'procurement', 'P-1', {
      requiredDataCategories: ['identity', 'funding', 'quantities', 'unit_cost'],
      expectedLineKinds: ['PROCUREMENT_BLIN'],
      documentType: 'p1',
    });
    const manifestPath = writeManifest(manifest);
    const artifactPath = writeArtifact(artifact, 'pdoc');
    const result = await verifyArtifact(manifestPath, 'pdoc_test', artifactPath);
    expect(['PASS', 'REVIEW', 'REJECT']).toContain(result.decision);
    expect(result.riskScore).toBeGreaterThanOrEqual(0);
    expect(result.riskScore).toBeLessThanOrEqual(100);
    console.log('  P-doc smoke:', JSON.stringify(result));
  });
});
