import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeProfileContentSha256 } from './page-profiler.js';

let workDir: string;
beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'phase3-cli-'));
});
afterEach(() => rmSync(workDir, { recursive: true, force: true }));

const apiRoot = join(__dirname, '..', '..', '..');
function runScript(script: string, args: string[]) {
  return spawnSync(
    'pnpm',
    ['exec', 'tsx', join(apiRoot, 'scripts', script), ...args],
    {
      cwd: apiRoot,
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: '' },
    },
  );
}

function sourceFile() {
  const file = join(workDir, 'source.pdf');
  writeFileSync(file, '%PDF-1.4\n%%EOF\n', 'utf8');
  return file;
}

function manifestFile(parserPolicy: 'deterministic_table' | 'native_structured') {
  const file = join(workDir, 'manifest.json');
  writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 'defense_budget_cycle_manifest_v1',
      cycleId: 'fy2027-pb',
      fiscalYear: 2027,
      domain: 'defense',
      documents: [
        {
          documentKey: 'r1-army',
          family: 'rdte',
          exhibit: 'R-1',
          required: true,
          title: 'Army R-1',
          sourceLocator: 'source.pdf',
          authority: 'dod-comptroller',
          component: 'ARMY',
          budgetCycle: 'pb',
          documentType: 'r1',
          parserPolicy,
          requiredDataCategories: ['identity', 'funding'],
          requiredFundingFields: ['request'],
          expectedLineKinds: ['RDTE_PE'],
          allowEmpty: false,
        },
      ],
    }),
    'utf8',
  );
  return file;
}

function profileFile(sourceSha256: string) {
  const base = {
    schemaVersion: 'defense_budget_page_profile_v1' as const,
    sourceSha256,
    pages: [
      {
        page: 1,
        width: '612',
        height: '792',
        rotation: 0,
        embeddedTextCharacters: 100,
        alphanumericCharacters: 80,
        wordCount: 20,
        imageCount: 0,
        imageAreaRatio: '0',
        vectorLineCount: 8,
        horizontalLineCount: 4,
        verticalLineCount: 4,
        tableLikeTextLineCount: 3,
        hasEmbeddedTextLayer: true,
        likelyImageOnly: false,
        likelyRotated: false,
        likelyTablePage: true,
        likelyMixedLayout: false,
        profileWarnings: [],
      },
    ],
    summary: {
      pageCount: 1,
      imageOnlyPageCount: 0,
      tableLikelyPageCount: 1,
      mixedLayoutPageCount: 0,
      rotatedPageCount: 0,
      zeroContentPageCount: 0,
      estimatedPdfplumberPages: 1,
      estimatedCamelotPages: 1,
      estimatedDoclingPages: 0,
      estimatedPaddleocrPages: 0,
      estimatedLlamaparsePages: 0,
    },
    profileConfigSha256: 'b'.repeat(64),
  };
  const profile = { ...base, contentSha256: computeProfileContentSha256(base) };
  const file = join(workDir, 'profile.json');
  writeFileSync(file, JSON.stringify(profile), 'utf8');
  return file;
}

describe('Phase 3 operator commands', () => {
  it('rejects unknown extraction flags before parser or database work', () => {
    const result = runScript('extract-defense-budget-cycle.ts', ['--unknown']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unknown flag');
  });

  it('rejects paid authorization without a page cap', () => {
    const result = runScript('extract-defense-budget-cycle.ts', [
      '--manifest',
      'x',
      '--document',
      'x',
      '--source',
      'x',
      '--work-dir',
      'x',
      '--out',
      'x',
      '--allow-paid-parse',
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--max-paid-pages');
  });

  it('fails closed when native_structured has no explicit companion', () => {
    const source = sourceFile();
    const result = runScript('extract-defense-budget-cycle.ts', [
      '--manifest',
      manifestFile('native_structured'),
      '--document',
      'r1-army',
      '--source',
      source,
      '--work-dir',
      join(workDir, 'work'),
      '--out',
      join(workDir, 'out.json'),
    ]);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('--structured-companion');
  });

  it('produces byte-identical deterministic plans for identical inputs', () => {
    const source = sourceFile();
    const sourceSha = createHash('sha256').update(readFileSync(source)).digest('hex');
    const manifest = manifestFile('deterministic_table');
    const profile = profileFile(sourceSha);
    const out1 = join(workDir, 'plan-1.json');
    const out2 = join(workDir, 'plan-2.json');
    const baseArgs = [
      '--manifest',
      manifest,
      '--document',
      'r1-army',
      '--source',
      source,
      '--profile',
      profile,
    ];
    expect(runScript('plan-defense-budget-parse.ts', [...baseArgs, '--out', out1]).status).toBe(0);
    expect(runScript('plan-defense-budget-parse.ts', [...baseArgs, '--out', out2]).status).toBe(0);
    expect(readFileSync(out1, 'utf8')).toBe(readFileSync(out2, 'utf8'));
  });

  it('replay refuses unknown arguments', () => {
    const result = runScript('replay-defense-budget-parser-artifact.ts', [
      '--descriptor',
      'x',
      '--unknown',
    ]);
    expect(result.status).toBe(2);
  });
});
