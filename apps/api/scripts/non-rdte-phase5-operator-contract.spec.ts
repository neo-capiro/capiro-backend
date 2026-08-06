import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseFamily, refuseUnknownFlags } from './lib/non-rdte-phase5-operator-lib.js';
import { inspectPhase5DocumentCompleteness } from '../src/defense-budget/non-rdte/non-rdte-document-completeness-v1.js';
import type { DefenseBudgetExtractionArtifactV1 } from '../src/defense-budget/contracts/extraction-artifact-v1.js';

const API_ROOT = path.resolve(__dirname, '..');
const SHA = 'a'.repeat(64);
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

function resolvePnpm(): { command: string; prefix: string[]; shell: boolean } {
  const corepack = path.join(
    path.dirname(process.execPath),
    'node_modules',
    'corepack',
    'dist',
    'pnpm.js',
  );
  if (fs.existsSync(corepack)) {
    return { command: process.execPath, prefix: [corepack], shell: false };
  }
  const hermesPnpm = 'C:/Users/neoma/AppData/Local/hermes/node/node_modules/corepack/dist/pnpm.js';
  if (fs.existsSync(hermesPnpm)) {
    return { command: process.execPath, prefix: [hermesPnpm], shell: false };
  }
  return {
    command: 'pnpm',
    prefix: [],
    shell: process.platform === 'win32',
  };
}

function runScript(script: string, args: string[]) {
  const pnpm = resolvePnpm();
  return spawnSync(pnpm.command, [...pnpm.prefix, 'exec', 'tsx', script, ...args], {
    cwd: API_ROOT,
    encoding: 'utf8',
    shell: pnpm.shell,
    timeout: 60_000,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
}

function manifest() {
  return {
    schemaVersion: 'defense_budget_cycle_manifest_v1',
    /* The manifest's semantic rules require the cycleId to name its fiscal year. */
    cycleId: 'phase5-command-test-fy2027',
    fiscalYear: 2027,
    domain: 'defense',
    documents: [
      {
        documentKey: 'p1-test',
        required: true,
        title: 'P-1 Test',
        sourceLocator: 'fixture://p1.pdf',
        expectedSourceSha256: SHA,
        family: 'procurement',
        exhibit: 'P-1',
        authority: 'dod-comptroller',
        component: 'ARMY',
        budgetCycle: 'pb_fy2027',
        documentType: 'pb_exhibit',
        parserPolicy: 'deterministic_table',
        requiredDataCategories: ['identity', 'funding', 'procurement_lines'],
        requiredFundingFields: ['request'],
        expectedLineKinds: ['PROCUREMENT_BLIN'],
        allowEmpty: false,
        account: '2031A',
        summaryDetailRole: 'summary',
        procurementBaseAdvance: 'base',
      },
    ],
  };
}

function emptyArtifact(): DefenseBudgetExtractionArtifactV1 {
  return {
    schemaVersion: 'defense_budget_extraction_v1',
    artifactId: 'dbx1_empty',
    contentSha256: SHA,
    source: {
      manifestDocumentKey: 'p1-test',
      sourcePdfSha256: SHA,
      sourceLocator: 'fixture://p1.pdf',
      fiscalYear: 2027,
      family: 'procurement',
      exhibit: 'P-1',
      authority: 'dod-comptroller',
      component: 'ARMY',
      budgetCycle: 'pb_fy2027',
      documentType: 'pb_exhibit',
    },
    parserRuns: [],
    evidence: [],
    sourceFacts: [],
    assertions: [],
    warnings: [],
    omissions: [],
    summary: {
      sourceFactCount: 0,
      requiredSourceFactCount: 0,
      coveredRequiredSourceFactCount: 0,
      omittedRequiredSourceFactCount: 0,
      uncoveredRequiredSourceFactCount: 0,
      assertionCount: 0,
      warningCount: 0,
      omissionCount: 0,
      countsByAssertionKind: {},
      countsByOmissionReason: {},
      completenessStatus: 'complete',
    },
  };
}

describe('Phase 5 operator contracts', () => {
  it('parses only the three native non-RDT&E families', () => {
    expect(parseFamily('procurement')).toBe('procurement');
    expect(parseFamily('om')).toBe('om');
    expect(parseFamily('milcon')).toBe('milcon');
    expect(() => parseFamily('rdte')).toThrow();
  });

  it('refuses --commit in every posture', () => {
    expect(() => refuseUnknownFlags(['--commit'], ['--commit'])).toThrow(
      /no --commit|promotion mode/,
    );
  });

  it('inspect is executable, read-only, and returns a deterministic preflight', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p5-inspect-'));
    try {
      const manifestPath = path.join(temp, 'manifest.json');
      fs.writeFileSync(manifestPath, JSON.stringify(manifest()), 'utf8');
      const result = runScript('scripts/inspect-defense-budget-non-rdte.ts', [
        '--manifest',
        manifestPath,
        '--family',
        'procurement',
      ]);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(output.externalCalls).toBe(false);
      expect(output.paidParserCalls).toBe(false);
      expect(output.canonicalWrites).toBe(false);
      expect(output.documentCount).toBe(1);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it('extract reports a missing required parser result as incomplete, not success', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p5-extract-'));
    try {
      const manifestPath = path.join(temp, 'manifest.json');
      const parserMapPath = path.join(temp, 'parser-map.json');
      const outDir = path.join(temp, 'out');
      fs.writeFileSync(manifestPath, JSON.stringify(manifest()), 'utf8');
      fs.writeFileSync(parserMapPath, '{}', 'utf8');
      const result = runScript('scripts/extract-defense-budget-non-rdte.ts', [
        '--manifest',
        manifestPath,
        '--parser-map',
        parserMapPath,
        '--out-dir',
        outDir,
        '--family',
        'procurement',
      ]);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(3);
      const output = JSON.parse(result.stdout) as { missingRequired: string[] };
      expect(output.missingRequired).toEqual(['p1-test']);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it('required documents cannot silently emit an empty successful artifact', () => {
    const document = manifest().documents[0]!;
    const findings = inspectPhase5DocumentCompleteness({
      document: document as never,
      artifact: emptyArtifact(),
    });
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'required_document_empty', blocking: true }),
        expect.objectContaining({ code: 'expected_line_kind_missing', blocking: true }),
      ]),
    );
  });

  it('verification delegates to the merged Phase 2 trusted verifier', () => {
    const source = fs.readFileSync(
      path.join(API_ROOT, 'scripts/verify-defense-budget-non-rdte.ts'),
      'utf8',
    );
    expect(source).toContain('scripts/verify-defense-budget-extraction-v1.ts');
    expect(source).toContain("'--persist-audit'");
    expect(source).not.toContain('ProgramElementWriterService');
  });

  it('projection has no commit mode and uses the proof-bound wrapper', () => {
    const result = runScript('scripts/plan-defense-budget-non-rdte-projection.ts', ['--commit']);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(5);
    const source = fs.readFileSync(
      path.join(API_ROOT, 'scripts/plan-defense-budget-non-rdte-projection.ts'),
      'utf8',
    );
    expect(source).toContain('planProofBoundNonRdteCanonicalProjection');
  });
});
