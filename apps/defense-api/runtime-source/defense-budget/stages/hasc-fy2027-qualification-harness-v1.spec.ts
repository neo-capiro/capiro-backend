import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { sha256Bytes } from '../contracts/canonical-json.js';
import type { DefenseBudgetExtractionArtifactV1 } from '../contracts/extraction-artifact-v1.js';
import { runHascFy2027QualificationV1 } from './hasc-fy2027-qualification-harness-v1.js';

describe('FY2027 HASC Package 3 qualification harness', () => {
  it('persists source-bound parser proof bytes and qualifies the mark-only packet in isolation', async () => {
    const packetBytes = await readFile(
      resolve(
        process.cwd(),
        '../../docs/defense-budget/package-3/qualification/hasc-fy2027-rdte-mark-only.json',
      ),
    );
    const artifactRoot = await mkdtemp(join(tmpdir(), 'p3-hasc-qualification-'));
    try {
      const result = await runHascFy2027QualificationV1({ packetBytes, artifactRoot });
      expect(result).toMatchObject({
        qualification_only: true,
        production_registration: false,
        backfill: false,
        publication: false,
        sourceSha256: '6587d1cec52d8d3eda3551648f50e4bc15371ea9167da2999e263e8c8e14480a',
        sourcePages: [618, 665],
        requestAssertionCount: 0,
        nativeStagePacketSchemaVersion: 'congressional_stage_packet_v1',
        nativeTableRowCount: 926,
        requiredLineFamilies: ['rdte_pe'],
        nativeLineIndexEntryCount: 0,
        markAssertionCount: 0,
        warningCount: 0,
        omissionCount: 926,
        unresolvedRowCount: 926,
        completenessStatus: 'incomplete',
      });
      expect(result.governedPacketSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result.stageProfileSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result.parserResultByteLength).toBeGreaterThan(0);
      expect(result.nativeTableCount).toBeGreaterThan(0);
      expect(result.artifactLocator.startsWith(join(artifactRoot, 'artifacts'))).toBe(true);
      expect(result.parserResultLocator.startsWith(join(artifactRoot, 'parser-results'))).toBe(true);
      const parserResultBytes = await readFile(result.parserResultLocator);
      expect(sha256Bytes(parserResultBytes)).toBe(result.parserResultByteSha256);
      const persistedParserResult = JSON.parse(parserResultBytes.toString('utf8')) as {
        contentSha256: string;
      };
      const artifact = JSON.parse(
        await readFile(result.artifactLocator, 'utf8'),
      ) as DefenseBudgetExtractionArtifactV1;
      expect(artifact.parserRuns).toHaveLength(1);
      expect(artifact.parserRuns[0]?.parserRunId).toBe(result.parserRunId);
      expect(artifact.parserRuns[0]?.outputArtifactSha256).toBe(
        persistedParserResult.contentSha256,
      );
      expect(
        artifact.assertions.some(
          (assertion) => assertion.assertionKind === 'funding' && assertion.field === 'request',
        ),
      ).toBe(false);
      expect(artifact.assertions.filter(
        (assertion) => assertion.assertionKind === 'funding' && assertion.field === 'hascMark',
      )).toHaveLength(0);
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it('rejects any governed packet byte change before persistence', async () => {
    const packetBytes = await readFile(
      resolve(
        process.cwd(),
        '../../docs/defense-budget/package-3/qualification/hasc-fy2027-rdte-mark-only.json',
      ),
    );
    const artifactRoot = await mkdtemp(join(tmpdir(), 'p3-hasc-tamper-'));
    try {
      await expect(
        runHascFy2027QualificationV1({
          packetBytes: Buffer.concat([packetBytes, Buffer.from(' ')]),
          artifactRoot,
        }),
      ).rejects.toThrow('packet bytes do not match the reviewed qualification pin');
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });
});
