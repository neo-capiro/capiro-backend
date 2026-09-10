/**
 * Phase 10B-28R -- production parser-runtime launcher contract.
 *
 * The lifecycle-bridge handoff spawns the isolated Python parser runtime via
 * `uv`. Phase 10B-28's offline proofs found that the plain `uv run ...`
 * launcher re-synced the project environment at every task start and, with
 * the drain image's empty runtime uv cache, rebuilt the editable root project
 * and fetched `hatchling` from PyPI -- failing hard without network. This
 * spec pins the two layers that close that gap so neither can regress
 * silently:
 *
 *   1. the launcher itself passes `--no-sync` (code layer, travels with the
 *      handoff wherever it runs);
 *   2. the ingestion-drain image sets UV_NO_SYNC=1 and UV_OFFLINE=1 (image
 *      layer, fails closed on ANY uv network attempt).
 *
 * The container-level proof (version/profile/parse through the real launcher
 * with Docker networking disabled) lives in
 * apps/api/scripts/verify-defense-budget-drain-offline-startup.sh; it needs a
 * built ARM64 image and is part of drain-image qualification, not unit CI.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  LIFECYCLE_BRIDGE_PARSER_RUNTIME_COMMAND_V1,
  buildLifecycleBridgeSyntheticManifestV1,
} from './source-document-parser-handoff.js';
import {
  parseBudgetCycleManifestV1,
  validateBudgetCycleManifestV1,
} from '../contracts/budget-cycle-manifest-v1.js';

const DRAIN_DOCKERFILE = resolve(__dirname, '../../../Dockerfile.defense-budget-ingestion-drain');
const HANDOFF_SOURCE = resolve(__dirname, './source-document-parser-handoff.ts');

describe('Phase 10B-28R -- lifecycle-bridge parser runtime launcher never syncs or downloads at runtime', () => {
  it('launches through uv with --no-sync immediately after the run verb', () => {
    expect(LIFECYCLE_BRIDGE_PARSER_RUNTIME_COMMAND_V1.command).toBe('uv');
    expect([...LIFECYCLE_BRIDGE_PARSER_RUNTIME_COMMAND_V1.commandArgs]).toEqual([
      'run',
      '--no-sync',
      'capiro-defense-budget-parser',
    ]);
  });

  it('is the only launcher the handoff constructs (no bare `uv run` left in the production handoff)', () => {
    const source = readFileSync(HANDOFF_SOURCE, 'utf8');
    const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // Exactly one LocalParserRuntimeClient construction, and it takes the
    // shared launcher constant rather than an inline argv.
    expect(stripped.match(/new LocalParserRuntimeClient\(/g)).toHaveLength(1);
    expect(stripped).toContain('command: LIFECYCLE_BRIDGE_PARSER_RUNTIME_COMMAND_V1.command');
    expect(stripped).toContain('commandArgs: [...LIFECYCLE_BRIDGE_PARSER_RUNTIME_COMMAND_V1.commandArgs]');
    expect(stripped).not.toMatch(/commandArgs:\s*\[\s*'run'\s*,\s*'capiro-defense-budget-parser'\s*\]/);
  });

  it('drain image declares UV_NO_SYNC=1 and UV_OFFLINE=1 after the build-time uv sync', () => {
    const dockerfile = readFileSync(DRAIN_DOCKERFILE, 'utf8');
    const syncIndex = dockerfile.indexOf('RUN uv sync --locked --no-dev --extra ocr');
    const noSyncIndex = dockerfile.search(/^\s*UV_NO_SYNC=1\s*\\?\s*$/m);
    const offlineIndex = dockerfile.search(/^\s*UV_OFFLINE=1\s*\\?\s*$/m);
    expect(syncIndex).toBeGreaterThan(-1);
    expect(noSyncIndex).toBeGreaterThan(syncIndex);
    expect(offlineIndex).toBeGreaterThan(syncIndex);
    // Both live in the same ENV instruction as the existing uv settings so a
    // task definition inherits them without restating them.
    const envBlock = dockerfile.slice(dockerfile.lastIndexOf('ENV DEFENSE_BUDGET_PARSER_PROJECT_DIR'));
    expect(envBlock).toMatch(/UV_CACHE_DIR=\/tmp\/uv-cache/);
    expect(envBlock).toMatch(/UV_NO_SYNC=1/);
    expect(envBlock).toMatch(/UV_OFFLINE=1/);
    // The offline gate must not be set before the build-time sync, or the
    // image could not be built at all.
    expect(dockerfile.slice(0, syncIndex)).not.toMatch(/UV_OFFLINE=1/);
    expect(dockerfile.slice(0, syncIndex)).not.toMatch(/UV_NO_SYNC=1/);
  });
});

describe('Phase 10B-28R -- buildLifecycleBridgeSyntheticManifestV1 (extracted production manifest shape)', () => {
  const RAW_CYCLE_ID = 'cff02efd-45e7-4ae4-8f7f-dacd12bdb84c';
  const input = {
    cycleId: RAW_CYCLE_ID,
    fiscalYear: 2024,
    sourceDocumentId: 'a99fbf5b-5eb4-45f3-87e4-96c40c2c0bb0',
    title: 'FY2024 ARMY RDT&E R-2 exhibits',
    sourcePath: '/tmp/defense-budget-parser-scratch/a99fbf5b/source.pdf',
    sourceUrl: 'https://www.asafm.army.mil/Portals/72/Documents/BudgetMaterial/2024/Base%20Budget/rdte/RDTE-Vol%201-Budget%20Activity%201.pdf',
    sourceSha256: '1fb7402152d0ec6ca536e20ac8d3ed8e7da61951ee691d1d05388abb4c462ab6',
    sourceKey: 'defense-budget-observation-cf5b34c86b34b7e75d9c5be7d18f4dc5a8bbea08aec23611bc2020efce6f74c4',
    budgetFamily: 'rdte' as const,
    exhibitType: 'R-2' as const,
    authority: 'dod-comptroller' as const,
    component: 'ARMY' as const,
    budgetCycle: 'pb',
    documentType: 'r2',
    parserPolicy: 'deterministic_table' as const,
  };

  it('tags only the proof-facing manifest cycleId and keeps the raw lifecycle UUID recoverable inside it', () => {
    const manifest = buildLifecycleBridgeSyntheticManifestV1(input);
    expect(manifest.cycleId).toBe(`fy2024:${RAW_CYCLE_ID}`);
    expect(manifest.cycleId.endsWith(RAW_CYCLE_ID)).toBe(true);
    expect(manifest.fiscalYear).toBe(2024);
    expect(manifest.documents).toHaveLength(1);
    expect(manifest.documents[0]!.documentKey).toBe(input.sourceDocumentId);
    expect(manifest.documents[0]!.component).toBe('ARMY');
    expect(manifest.documents[0]!.expectedLineKinds).toEqual(['RDTE_PE']);
    // [Phase 10B-31] the authoritative sourceKey is carried onto its own
    // dedicated field, distinct from sourceLocator (which stays the local
    // scratch path below) -- this is the fix for the confirmed production
    // bug where the metadata-agreement check compared the persisted
    // SourceDocument.sourceKey against sourceLocator instead.
    expect(manifest.documents[0]!.expectedSourceKey).toBe(input.sourceKey);
    expect(manifest.documents[0]!.sourceLocator).toBe(input.sourcePath);
    expect(manifest.documents[0]!.expectedSourceKey).not.toBe(manifest.documents[0]!.sourceLocator);
  });

  it('validates under the unchanged manifest validator with zero error findings', () => {
    const parsed = parseBudgetCycleManifestV1(buildLifecycleBridgeSyntheticManifestV1(input));
    const errors = validateBudgetCycleManifestV1(parsed).filter((finding) => finding.severity === 'error');
    expect(errors).toEqual([]);
  });

  it('preserves the exact serialized key order the handoff has always written (manifest hash stability)', () => {
    const manifest = buildLifecycleBridgeSyntheticManifestV1(input);
    expect(Object.keys(manifest)).toEqual(['schemaVersion', 'cycleId', 'fiscalYear', 'domain', 'documents']);
    expect(Object.keys(manifest.documents[0]!)).toEqual([
      'documentKey',
      'required',
      'title',
      'sourceLocator',
      'sourceUrl',
      'expectedSourceSha256',
      'expectedSourceKey',
      'family',
      'exhibit',
      'authority',
      'component',
      'budgetCycle',
      'documentType',
      'parserPolicy',
      'requiredDataCategories',
      'requiredFundingFields',
      'expectedLineKinds',
      'allowEmpty',
    ]);
  });

  it('defaults an unknown component to UNKNOWN and omits sourceUrl when absent', () => {
    const { component, sourceUrl, ...rest } = input;
    void component;
    void sourceUrl;
    const manifest = buildLifecycleBridgeSyntheticManifestV1(rest);
    expect(manifest.documents[0]!.component).toBe('UNKNOWN');
    expect('sourceUrl' in manifest.documents[0]!).toBe(false);
  });
});
