import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adapterTestContext, ADAPTER_TEST_CONFIG_SHA, ADAPTER_TEST_SOURCE_SHA } from '../contracts/adapters/testing-helpers.js';
import { createHascSourceProfileV1 } from '../stages/authorization/hasc-source-profile-v1.js';
import { parseStageSourceProfileV1 } from '../stages/stage-source-profile-v1.js';
import { congressionalPacketResolverConfigFromEnv, createCongressionalPacketResolverV1, LIFECYCLE_TO_STAGE_V1, resolveCongressionalPacketLocator } from './congressional-packet-resolver-v1.js';
import { FilesystemParserArtifactStore } from './parser-artifact-store.js';
import { FilesystemExtractionArtifactStore } from './extraction-artifact-store.js';
import { buildParserRunIdentityV1 } from './parser-run-identity-v1.js';
import { parseParserRuntimeResultV1 } from './parser-runtime-contract-v1.js';
import { resolveSourceDocumentArtifactFactoryV1 } from './source-document-parser-handoff-artifact-factory-v1.js';

describe('production congressional packet resolver', () => {
  let root: string;
  let manifestPath: string;
  const request = {
    fiscalYear: 2027,
    authorityTrack: 'authorization',
    stage: 'hasc_mark',
    sourceFamily: 'auth_committee_mark',
    sourceDocumentId: 'source-doc',
    sourceKey: 'source-key-absent',
    sourceSha256: 'a'.repeat(64),
    sourceUrl: 'https://example.test/source.pdf',
  } as const;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'congressional-resolver-'));
    manifestPath = join(root, 'manifest.json');
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  async function resolverFor(content: string) {
    await writeFile(manifestPath, content, 'utf8');
    return createCongressionalPacketResolverV1({
      manifestPath,
      manifestSha256: createHash('sha256').update(content).digest('hex'),
      parserArtifactRoot: join(root, 'parser-artifacts'),
    });
  }

  it('requires absolute immutable manifest path and digest', () => {
    expect(() => createCongressionalPacketResolverV1({
      manifestPath: 'relative.json', manifestSha256: 'a'.repeat(64), parserArtifactRoot: root,
    })).toThrow(/absolute/);
    expect(() => createCongressionalPacketResolverV1({
      manifestPath: join(root, 'manifest.json'), manifestSha256: '', parserArtifactRoot: root,
    })).toThrow(/SHA-256/);
  });

  it('allows absent packet configuration for unrelated ingestion but rejects partial configuration', () => {
    expect(congressionalPacketResolverConfigFromEnv({})).toBeUndefined();
    expect(() => congressionalPacketResolverConfigFromEnv({ CONGRESSIONAL_PACKET_MANIFEST_PATH: 'manifest.json' })).toThrow(/SHA-256/);
  });

  it('maps each chamber action to its committee StageV1', () => {
    expect(LIFECYCLE_TO_STAGE_V1).toMatchObject({
      house_auth_action: 'hasc', senate_auth_action: 'sasc',
      house_appr_action: 'hac_d', senate_appr_action: 'sac_d',
    });
  });

  it('resolves relative packet locators beside the manifest and rejects path escape', () => {
    expect(resolveCongressionalPacketLocator(join(root, 'manifest.json'), 'packets/a.json'))
      .toBe(join(root, 'packets', 'a.json'));
    expect(() => resolveCongressionalPacketLocator(join(root, 'manifest.json'), '../outside.json'))
      .toThrow(/escapes manifest directory/);
  });

  it('returns missing only for a valid manifest with no exact source key', async () => {
    const profile = createHascSourceProfileV1({ fiscalYear: 2027, reportNumber: 'H. Rept. 1', sourceDocumentKeys: ['different-key'] });
    const manifest = JSON.stringify({
      schemaVersion: 'congressional_packet_manifest_v1',
      documents: [{
        documentKey: 'different-key', stage: 'hasc', fiscalYear: 2027, declaredUnit: 'thousands',
        sourcePdfSha256: ADAPTER_TEST_SOURCE_SHA, sourceLocator: 'source.pdf',
        packetLocator: 'packet.json', packetByteSha256: 'b'.repeat(64), profile,
        context: adapterTestContext({ manifestDocumentKey: 'different-key', sourceDocumentId: 'other-doc', sourcePdfSha256: ADAPTER_TEST_SOURCE_SHA, sourceLocator: 'source.pdf', fiscalYear: 2027, family: 'committee', exhibit: 'committee_report', authority: 'hasc', budgetCycle: 'hasc', documentType: 'committee_report' }),
        parserRuns: [{ sourceSha256: ADAPTER_TEST_SOURCE_SHA, method: 'deterministic_pdfplumber', parserVersion: 'test', parserConfigSha256: ADAPTER_TEST_CONFIG_SHA, requestedPages: [1], runtimeContractVersion: 'defense_budget_parser_job_v1' }],
      }],
    });
    const resolver = await resolverFor(manifest);
    await expect(resolver!(request)).resolves.toEqual({ kind: 'missing' });
  });

  it('resolves an exact packet and persisted parser proof from offline fixtures', async () => {
    const sourceKey = 'resolver-success-fixture';
    const sourceUrl = 'https://example.test/resolver-success.pdf';
    const parserFixturePath = join(
      process.cwd(),
      'src/defense-budget/rdte/cycle/__fixtures__/production-fy2024-r1-raw-parser-output-114pages.json',
    );
    const parserResultBytes = await readFile(parserFixturePath);
    const parserResult = parseParserRuntimeResultV1(JSON.parse(parserResultBytes.toString('utf8')));
    const profile = createHascSourceProfileV1({
      fiscalYear: 2024,
      reportNumber: 'H. Rept. resolver fixture',
      sourceDocumentKeys: [sourceKey],
    });
    const packet = {
      schemaVersion: 'congressional_structured_packet_v1' as const,
      documentKey: sourceKey,
      stage: 'hasc' as const,
      fiscalYear: 2024,
      declaredUnit: 'thousands' as const,
      profileId: profile.profileId,
      sourcePdfSha256: parserResult.inputSourceSha256,
      artifact: {
        chamber: 'HASC',
        fy: 2024,
        source: 'offline-resolver-fixture',
        rows: [
          {
            peCode: '0601102A',
            fy: 2024,
            mark: 123,
            markUnit: 'thousands' as const,
            page: 1,
            rowLabel: '001',
          },
        ],
      },
    };
    const packetBytes = Buffer.from(JSON.stringify(packet), 'utf8');
    const context = adapterTestContext({
      manifestDocumentKey: sourceKey,
      sourceDocumentId: request.sourceDocumentId,
      sourcePdfSha256: parserResult.inputSourceSha256,
      sourceLocator: sourceUrl,
      sourceUrl,
      fiscalYear: 2024,
      family: 'committee',
      exhibit: 'committee_report',
      authority: 'hasc',
      component: 'UNKNOWN',
      budgetCycle: 'hasc',
      documentType: 'committee_mark',
      parser: {
        method: parserResult.engine,
        parserVersion: parserResult.parserVersion,
        parserConfigSha256: parserResult.parserConfigSha256,
        outputArtifactSha256: parserResult.contentSha256,
        pageRanges: [{ startPage: 1, endPage: 114 }],
      },
    });
    const manifest = JSON.stringify({
      schemaVersion: 'congressional_packet_manifest_v1',
      documents: [
        {
          documentKey: sourceKey,
          stage: 'hasc',
          fiscalYear: 2024,
          declaredUnit: 'thousands',
          sourcePdfSha256: parserResult.inputSourceSha256,
          sourceLocator: sourceUrl,
          packetLocator: 'packet.json',
          packetByteSha256: createHash('sha256').update(packetBytes).digest('hex'),
          profile,
          context,
          parserRuns: [
            {
              sourceSha256: parserResult.inputSourceSha256,
              method: parserResult.engine,
              parserVersion: parserResult.parserVersion,
              parserConfigSha256: parserResult.parserConfigSha256,
              requestedPages: parserResult.requestedPages,
              runtimeContractVersion: 'defense_budget_parser_job_v1',
            },
          ],
        },
      ],
    });
    await writeFile(join(root, 'packet.json'), packetBytes);
    const resolver = await resolverFor(manifest);
    const parserStore = new FilesystemParserArtifactStore(join(root, 'parser-artifacts'));
    const identity = buildParserRunIdentityV1({
      sourceSha256: parserResult.inputSourceSha256,
      method: parserResult.engine,
      parserVersion: parserResult.parserVersion,
      parserConfigSha256: parserResult.parserConfigSha256,
      requestedPages: parserResult.requestedPages,
    });
    await parserStore.putVerified({
      identity,
      result: parserResult,
      resultJson: parserResultBytes.toString('utf8'),
    });

    const resolved = await resolver!({
      ...request,
      sourceKey,
      sourceSha256: parserResult.inputSourceSha256,
      sourceUrl,
      fiscalYear: 2024,
    });
    expect(resolved.kind).toBe('matched');
    if (resolved.kind !== 'matched') return;
    expect(resolved.factoryInputs.input.rows).toHaveLength(1);
    expect(resolved.factoryInputs.input.rows[0]?.peCode).toBe('0601102A');
    expect(resolved.factoryInputs.parserResultProofs).toHaveLength(1);
    expect(
      (resolved.factoryInputs.parserResultProofs[0]?.result as { inputSourceSha256: string })
        .inputSourceSha256,
    ).toBe(parserResult.inputSourceSha256);
  });

  it('carries the resolved offline bundle through factory selection and durable artifact persistence', async () => {
    const sourceKey = 'resolver-artifact-integration-fixture';
    const sourceUrl = 'https://example.test/resolver-artifact-integration.pdf';
    const parserFixturePath = join(
      process.cwd(),
      'src/defense-budget/rdte/cycle/__fixtures__/production-fy2024-r1-raw-parser-output-114pages.json',
    );
    const parserResultBytes = await readFile(parserFixturePath);
    const parserResult = parseParserRuntimeResultV1(JSON.parse(parserResultBytes.toString('utf8')));
    const profile = parseStageSourceProfileV1({
      ...createHascSourceProfileV1({
        fiscalYear: 2024,
        reportNumber: 'H. Rept. resolver artifact integration fixture',
        sourceDocumentKeys: [sourceKey],
      }),
      // This fixture intentionally exercises the legacy RDT&E-only adapter
      // boundary. The live HASC profile remains mixed-family and must still
      // fail closed until a governed native composer exists.
      requiredLineFamilies: ['rdte_pe'],
    });
    const packet = {
      schemaVersion: 'congressional_structured_packet_v1' as const,
      documentKey: sourceKey,
      stage: 'hasc' as const,
      fiscalYear: 2024,
      declaredUnit: 'thousands' as const,
      profileId: profile.profileId,
      sourcePdfSha256: parserResult.inputSourceSha256,
      artifact: {
        chamber: 'HASC',
        fy: 2024,
        source: 'offline-resolver-artifact-integration-fixture',
        rows: [
          {
            peCode: '0601102A',
            fy: 2024,
            mark: 296670,
            markUnit: 'thousands' as const,
            page: 1,
            rowLabel: '001',
            explanation: 'Defense Research Sciences',
          },
        ],
      },
    };
    const packetBytes = Buffer.from(JSON.stringify(packet), 'utf8');
    const context = adapterTestContext({
      manifestDocumentKey: sourceKey,
      sourceDocumentId: request.sourceDocumentId,
      sourcePdfSha256: parserResult.inputSourceSha256,
      sourceLocator: sourceUrl,
      sourceUrl,
      fiscalYear: 2024,
      family: 'committee',
      exhibit: 'committee_report',
      authority: 'hasc',
      component: 'UNKNOWN',
      budgetCycle: 'hasc',
      documentType: 'committee_mark',
      parser: {
        method: parserResult.engine,
        parserVersion: parserResult.parserVersion,
        parserConfigSha256: parserResult.parserConfigSha256,
        outputArtifactSha256: parserResult.contentSha256,
        pageRanges: [{ startPage: 1, endPage: 114 }],
      },
    });
    const manifest = JSON.stringify({
      schemaVersion: 'congressional_packet_manifest_v1',
      documents: [
        {
          documentKey: sourceKey,
          stage: 'hasc',
          fiscalYear: 2024,
          declaredUnit: 'thousands',
          sourcePdfSha256: parserResult.inputSourceSha256,
          sourceLocator: sourceUrl,
          packetLocator: 'packet-integration.json',
          packetByteSha256: createHash('sha256').update(packetBytes).digest('hex'),
          profile,
          context,
          parserRuns: [
            {
              sourceSha256: parserResult.inputSourceSha256,
              method: parserResult.engine,
              parserVersion: parserResult.parserVersion,
              parserConfigSha256: parserResult.parserConfigSha256,
              requestedPages: parserResult.requestedPages,
              runtimeContractVersion: 'defense_budget_parser_job_v1',
            },
          ],
        },
      ],
    });
    await writeFile(join(root, 'packet-integration.json'), packetBytes);
    const resolver = await resolverFor(manifest);
    const parserStore = new FilesystemParserArtifactStore(join(root, 'parser-artifacts'));
    const identity = buildParserRunIdentityV1({
      sourceSha256: parserResult.inputSourceSha256,
      method: parserResult.engine,
      parserVersion: parserResult.parserVersion,
      parserConfigSha256: parserResult.parserConfigSha256,
      requestedPages: parserResult.requestedPages,
    });
    await parserStore.putVerified({
      identity,
      result: parserResult,
      resultJson: parserResultBytes.toString('utf8'),
    });

    const resolved = await resolver!({
      ...request,
      sourceKey,
      sourceSha256: parserResult.inputSourceSha256,
      sourceUrl,
      fiscalYear: 2024,
    });
    expect(resolved.kind).toBe('matched');
    if (resolved.kind !== 'matched') return;

    const factory = resolveSourceDocumentArtifactFactoryV1({
      budgetFamily: 'committee',
      sourceDocumentId: request.sourceDocumentId,
      sourceKey,
      sourceSha256: parserResult.inputSourceSha256,
      sourceLocator: sourceUrl,
      fiscalYear: 2024,
      component: 'UNKNOWN',
      congressionalFactoryInputs: resolved.factoryInputs,
    });
    expect(factory).toBeDefined();
    const store = new FilesystemExtractionArtifactStore(join(root, 'extraction-artifacts'));
    const output = await factory!(
      {
        executionId: 'resolver-artifact-integration-execution',
        cycleId: 'cycle-2024-resolver-artifact-integration',
        manifestDocumentKey: sourceKey,
        sourceDocumentId: request.sourceDocumentId,
        sourceSha256: parserResult.inputSourceSha256,
        sourceLocator: sourceUrl,
        composedOutput: {} as never,
        exhibitType: 'committee_report',
        budgetFamily: 'committee',
        fiscalYear: 2024,
        authority: 'hasc',
        component: 'UNKNOWN',
        budgetCycle: 'hasc',
        documentType: 'committee_mark',
      },
      store,
    );

    expect(output.artifactLocator.startsWith(join(root, 'extraction-artifacts'))).toBe(true);
    expect(output.artifactByteSha256).toMatch(/^[a-f0-9]{64}$/);
    const persisted = await store.readVerified({
      locator: output.artifactLocator,
      expectedByteSha256: output.artifactByteSha256,
    });
    expect(JSON.parse(persisted.toString('utf8')).artifactId).toBe(output.artifactId);
    expect(
      output.artifact.assertions.some(
        (assertion) => 'field' in assertion && assertion.field === 'hascMark',
      ),
    ).toBe(true);
    expect(output.artifact.parserRuns).toHaveLength(1);
    expect(output.artifact.parserRuns[0]?.parserRunId).toBe(
      resolved.factoryInputs.parserResultProofs[0]?.parserRunId,
    );
  });

  it('propagates malformed and digest-mismatched manifests', async () => {
    const malformed = await resolverFor('{not-json');
    await expect(malformed!(request)).rejects.toThrow(/not valid JSON/);
    await writeFile(manifestPath, '{}', 'utf8');
    const resolver = createCongressionalPacketResolverV1({
      manifestPath,
      manifestSha256: 'b'.repeat(64),
      parserArtifactRoot: join(root, 'parser-artifacts'),
    });
    await expect(resolver!(request)).rejects.toThrow(/SHA-256 mismatch/);
  });
});
