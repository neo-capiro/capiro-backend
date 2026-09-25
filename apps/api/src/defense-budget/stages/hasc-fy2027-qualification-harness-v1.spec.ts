import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from '@jest/globals';
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
        markAssertionCount: 926,
        warningCount: 0,
        omissionCount: 0,
        completenessStatus: 'complete',
      });
      expect(result.governedPacketSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result.stageProfileSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result.parserResultByteLength).toBeGreaterThan(0);
      expect(result.artifactLocator.startsWith(join(artifactRoot, 'artifacts'))).toBe(true);
      const artifact = JSON.parse(
        await readFile(result.artifactLocator, 'utf8'),
      ) as DefenseBudgetExtractionArtifactV1;
      expect(
        artifact.assertions.some(
          (assertion) => assertion.assertionKind === 'funding' && assertion.field === 'request',
        ),
      ).toBe(false);
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
