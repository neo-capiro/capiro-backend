import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adapterTestContext, ADAPTER_TEST_CONFIG_SHA, ADAPTER_TEST_SOURCE_SHA } from '../contracts/adapters/testing-helpers.js';
import { createHascSourceProfileV1 } from '../stages/authorization/hasc-source-profile-v1.js';
import { congressionalPacketResolverConfigFromEnv, createCongressionalPacketResolverV1, LIFECYCLE_TO_STAGE_V1, resolveCongressionalPacketLocator } from './congressional-packet-resolver-v1.js';

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
