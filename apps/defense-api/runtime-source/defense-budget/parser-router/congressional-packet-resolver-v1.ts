/** Fail-closed production resolver for the immutable congressional packet manifest. */
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { LifecycleStage } from '@capiro/defense-domain';
import { routingForLifecycleSource } from './source-family-routing.js';
import type { CongressionalPacketResolverV1 } from '../default-parser-handoff.adapter.js';
import { FilesystemParserArtifactStore } from './parser-artifact-store.js';
import {
  congressionalPacketManifestV1Schema,
  loadCongressionalFactoryInputsV1,
} from './congressional-manifest-packet-provider-v1.js';
import type { StageV1 } from '../stages/stage-vocabulary-v1.js';

export const LIFECYCLE_TO_STAGE_V1: Partial<Record<LifecycleStage, StageV1>> = {
  hasc_mark: 'hasc',
  hasc_report: 'hasc',
  house_auth_action: 'hasc',
  sasc_mark: 'sasc',
  sasc_report: 'sasc',
  senate_auth_action: 'sasc',
  auth_conference: 'ndaa_conference',
  hac_d_mark: 'hac_d',
  hac_d_report: 'hac_d',
  house_appr_action: 'hac_d',
  sac_d_mark: 'sac_d',
  sac_d_report: 'sac_d',
  senate_appr_action: 'sac_d',
  appr_conference_or_jes: 'appropriations_conference',
};

export interface CongressionalPacketResolverConfigV1 {
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly parserArtifactRoot: string;
}

export function resolveCongressionalPacketLocator(manifestPath: string, locator: string): string {
  if (isAbsolute(locator)) return locator;
  const manifestDir = resolve(manifestPath, '..');
  const packetPath = resolve(manifestDir, locator);
  if (
    packetPath !== manifestDir &&
    !packetPath.startsWith(`${manifestDir}/`) &&
    !packetPath.startsWith(`${manifestDir}\\`)
  )
    throw new Error('congressional packet locator escapes manifest directory');
  return packetPath;
}

export function congressionalPacketResolverConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  parserArtifactRoot?: string,
): CongressionalPacketResolverConfigV1 | undefined {
  const manifestPath = env.CONGRESSIONAL_PACKET_MANIFEST_PATH?.trim();
  const manifestSha256 = env.CONGRESSIONAL_PACKET_MANIFEST_SHA256?.trim();
  if (!manifestPath && !manifestSha256) return undefined;
  if (!manifestPath) throw new Error('CONGRESSIONAL_PACKET_MANIFEST_PATH is required');
  if (!manifestSha256 || !/^[a-f0-9]{64}$/.test(manifestSha256))
    throw new Error('CONGRESSIONAL_PACKET_MANIFEST_SHA256 must be a lowercase SHA-256 digest');
  const artifactRoot =
    parserArtifactRoot?.trim() || env.BUDGET_VERIFICATION_PARSER_ARTIFACT_ROOT?.trim();
  if (!artifactRoot) throw new Error('BUDGET_VERIFICATION_PARSER_ARTIFACT_ROOT is required');
  return { manifestPath, manifestSha256, parserArtifactRoot: artifactRoot };
}

export function createCongressionalPacketResolverV1(
  config: CongressionalPacketResolverConfigV1 | undefined,
): CongressionalPacketResolverV1 | undefined {
  if (!config) return undefined;
  if (!isAbsolute(config.manifestPath))
    throw new Error('congressional packet manifest path must be absolute');
  if (!/^[a-f0-9]{64}$/.test(config.manifestSha256))
    throw new Error('congressional packet manifest SHA-256 is required');
  if (!isAbsolute(config.parserArtifactRoot))
    throw new Error('parser artifact root must be absolute');
  const manifestPath = resolve(config.manifestPath);
  const parserArtifactStore = new FilesystemParserArtifactStore(resolve(config.parserArtifactRoot));

  return async (request) => {
    const bytes = await readFile(manifestPath);
    const actualSha = createHash('sha256').update(bytes).digest('hex');
    if (actualSha !== config.manifestSha256)
      throw new Error(
        `congressional packet manifest SHA-256 mismatch: expected ${config.manifestSha256}, got ${actualSha}`,
      );
    let raw: unknown;
    try {
      raw = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new Error('congressional packet manifest is not valid JSON');
    }
    const manifest = congressionalPacketManifestV1Schema.parse(raw);
    const matches = manifest.documents.filter((doc) => doc.documentKey === request.sourceKey);
    if (matches.length === 0) return { kind: 'missing' } as const;
    if (matches.length !== 1)
      throw new Error(`expected exactly one manifest document ${request.sourceKey}`);
    const doc = matches[0]!;
    const stage = LIFECYCLE_TO_STAGE_V1[request.stage];
    if (!stage)
      throw new Error(`lifecycle stage ${request.stage} has no congressional StageV1 mapping`);
    const routing = routingForLifecycleSource(
      request.authorityTrack,
      request.stage,
      request.sourceFamily,
    );
    if (doc.sourcePdfSha256 !== request.sourceSha256)
      throw new Error('congressional packet manifest source SHA does not match lifecycle source');
    if (doc.fiscalYear !== request.fiscalYear || doc.sourceLocator !== request.sourceUrl)
      throw new Error(
        'congressional packet manifest source identity does not match lifecycle source',
      );
    const loaded = await loadCongressionalFactoryInputsV1({
      manifest,
      request: {
        documentKey: request.sourceKey,
        sourceDocumentId: request.sourceDocumentId,
        profileId: doc.profile.profileId,
        stage,
        fiscalYear: request.fiscalYear,
        sourceSha256: request.sourceSha256,
        sourceLocator: request.sourceUrl,
        routing: {
          family: routing.family,
          exhibit: routing.exhibit,
          authority: routing.authority,
          budgetCycle: routing.budgetCycle,
          documentType: routing.documentType,
        },
      },
      parserArtifactStore,
      readPacket: async (locator) => {
        return readFile(resolveCongressionalPacketLocator(manifestPath, locator));
      },
    });
    return {
      kind: 'matched',
      factoryInputs: {
        packetBytes: loaded.packetBytes,
        factoryContext: loaded.factoryContext,
        packetKind: loaded.packetKind,
        input: loaded.input,
        ...(loaded.tables != null
          ? { tables: loaded.tables, resolutionContext: loaded.resolutionContext }
          : {}),
        parserResultProofs: loaded.parserResultProofs,
      },
    };
  };
}
