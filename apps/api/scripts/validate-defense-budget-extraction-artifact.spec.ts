/**
 * Phase 1 §7.2 — Artifact validator CLI tests.
 *
 * Tests the pure `validateArtifactFile` entry point without spawning a
 * process or calling `process.exit`.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  assertionIdV1,
  evidenceIdV1,
  factIdV1,
  omissionIdV1,
} from '../src/defense-budget/contracts/artifact-builders.js';
import {
  computeArtifactContentSha256,
  computeArtifactSummary,
} from '../src/defense-budget/contracts/extraction-artifact-v1.semantic.js';
import type { DefenseBudgetExtractionArtifactV1 } from '../src/defense-budget/contracts/extraction-artifact-v1.js';
import { buildMinimalArtifact } from '../src/defense-budget/contracts/testing-helpers.js';
import { validateArtifactFile } from './validate-defense-budget-extraction-artifact.js';

function writeTempArtifact(artifact: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-spec-'));
  const filePath = path.join(dir, 'artifact.json');
  fs.writeFileSync(filePath, JSON.stringify(artifact), 'utf8');
  return filePath;
}

/**
 * Build a complete artifact with a review-severity omission (covers a non-required fact).
 */
function buildArtifactWithReviewOmission(): DefenseBudgetExtractionArtifactV1 {
  const artifact = buildMinimalArtifact();
  const evidenceId = artifact.evidence[0]!.evidenceId;
  const extraFactId = factIdV1({
    sourcePath: 'rows[1].money',
    category: 'money',
    rawValue: '5',
  });
  const built: DefenseBudgetExtractionArtifactV1 = {
    ...artifact,
    sourceFacts: [
      ...artifact.sourceFacts,
      {
        factId: extraFactId,
        sourcePath: 'rows[1].money',
        category: 'money',
        requiredForCompleteness: true,
        rawValue: '5',
        evidenceIds: [evidenceId],
      },
    ],
    omissions: [
      {
        omissionId: omissionIdV1({ sourceFactId: extraFactId, reason: 'other' }),
        sourceFactId: extraFactId,
        reason: 'other',
        severity: 'review',
        message: 'review omission',
      },
    ],
  };
  const summary = computeArtifactSummary(built);
  const withSummary = { ...built, summary };
  const contentSha256 = computeArtifactContentSha256(withSummary);
  return {
    ...withSummary,
    contentSha256,
    artifactId: `dbx1_${contentSha256}`,
  };
}

/**
 * Build an incomplete artifact with a blocking omission.
 */
function buildIncompleteArtifact(): DefenseBudgetExtractionArtifactV1 {
  const artifact = buildMinimalArtifact();
  const evidenceId = artifact.evidence[0]!.evidenceId;
  const extraFactId = factIdV1({
    sourcePath: 'rows[1].money',
    category: 'money',
    rawValue: '5',
  });
  const built: DefenseBudgetExtractionArtifactV1 = {
    ...artifact,
    sourceFacts: [
      ...artifact.sourceFacts,
      {
        factId: extraFactId,
        sourcePath: 'rows[1].money',
        category: 'money',
        requiredForCompleteness: true,
        rawValue: '5',
        evidenceIds: [evidenceId],
      },
    ],
    omissions: [
      {
        omissionId: omissionIdV1({ sourceFactId: extraFactId, reason: 'other' }),
        sourceFactId: extraFactId,
        reason: 'other',
        severity: 'blocking',
        message: 'blocking omission',
      },
    ],
  };
  const summary = computeArtifactSummary(built);
  const withSummary = { ...built, summary };
  const contentSha256 = computeArtifactContentSha256(withSummary);
  return {
    ...withSummary,
    contentSha256,
    artifactId: `dbx1_${contentSha256}`,
  };
}

/**
 * Build an artifact with a funding assertion carrying UNKNOWN identity.
 */
function buildArtifactWithUnknownIdentity(): DefenseBudgetExtractionArtifactV1 {
  const artifact = buildMinimalArtifact();
  const evidenceId = artifact.evidence[0]!.evidenceId;
  const moneyFactId = factIdV1({
    sourcePath: 'rows[0].money',
    category: 'money',
    rawValue: '100',
  });
  const funding = {
    assertionId: assertionIdV1({ kind: 'funding', n: 1 }),
    assertionKind: 'funding' as const,
    identity: { lineKind: 'UNKNOWN' as const, code: '???' },
    fiscalYear: 2099,
    field: 'request' as const,
    money: { originalValue: '100', originalUnit: 'thousands' as const, valueMillions: '0.1' },
    sourceFactIds: [moneyFactId],
    evidenceIds: [evidenceId],
    confidence: 1,
  };
  const built: DefenseBudgetExtractionArtifactV1 = {
    ...artifact,
    sourceFacts: [
      ...artifact.sourceFacts,
      {
        factId: moneyFactId,
        sourcePath: 'rows[0].money',
        category: 'money',
        requiredForCompleteness: false,
        rawValue: '100',
        evidenceIds: [evidenceId],
      },
    ],
    assertions: [...artifact.assertions, funding],
  };
  const summary = computeArtifactSummary(built);
  const withSummary = { ...built, summary };
  const contentSha256 = computeArtifactContentSha256(withSummary);
  return {
    ...withSummary,
    contentSha256,
    artifactId: `dbx1_${contentSha256}`,
  };
}

describe('validateArtifactFile', () => {
  it('accepts a valid complete artifact', () => {
    const artifact = buildMinimalArtifact();
    const artifactPath = writeTempArtifact(artifact);
    const result = validateArtifactFile(artifactPath);
    expect(result.valid).toBe(true);
    expect(result.completenessStatus).toBe('complete');
    expect(result.findings.filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('accepts a complete artifact with requireComplete', () => {
    const artifact = buildMinimalArtifact();
    const artifactPath = writeTempArtifact(artifact);
    const result = validateArtifactFile(artifactPath, { requireComplete: true });
    expect(result.valid).toBe(true);
  });

  it('accepts a review omission without requireComplete', () => {
    const artifact = buildArtifactWithReviewOmission();
    const artifactPath = writeTempArtifact(artifact);
    const result = validateArtifactFile(artifactPath);
    expect(result.valid).toBe(true);
    expect(result.completenessStatus).toBe('complete_with_omissions');
  });

  it('rejects a review omission with requireComplete', () => {
    const artifact = buildArtifactWithReviewOmission();
    const artifactPath = writeTempArtifact(artifact);
    const result = validateArtifactFile(artifactPath, { requireComplete: true });
    expect(result.valid).toBe(false);
  });

  it('rejects a blocking omission', () => {
    const artifact = buildIncompleteArtifact();
    const artifactPath = writeTempArtifact(artifact);
    const result = validateArtifactFile(artifactPath);
    expect(result.valid).toBe(true); // blocking omission is not a semantic error
    expect(result.completenessStatus).toBe('incomplete');
  });

  it('rejects a blocking omission with requireComplete', () => {
    const artifact = buildIncompleteArtifact();
    const artifactPath = writeTempArtifact(artifact);
    const result = validateArtifactFile(artifactPath, { requireComplete: true });
    expect(result.valid).toBe(false);
  });

  it('rejects an artifact with a blocking warning', () => {
    const artifact = buildMinimalArtifact();
    const tampered: DefenseBudgetExtractionArtifactV1 = {
      ...artifact,
      warnings: [
        {
          warningId: 'warn_test_blocking',
          code: 'test_blocking_warning',
          severity: 'blocking',
          message: 'blocking test warning',
          sourceFactIds: [],
          evidenceIds: [],
        },
      ],
    };
    const summary = computeArtifactSummary(tampered);
    const withSummary = { ...tampered, summary };
    const contentSha256 = computeArtifactContentSha256(withSummary);
    const final: DefenseBudgetExtractionArtifactV1 = {
      ...withSummary,
      contentSha256,
      artifactId: `dbx1_${contentSha256}`,
    };
    const artifactPath = writeTempArtifact(final);
    const result = validateArtifactFile(artifactPath);
    expect(result.completenessStatus).toBe('incomplete');
  });

  it('detects an unknown direct identity', () => {
    const artifact = buildArtifactWithUnknownIdentity();
    const artifactPath = writeTempArtifact(artifact);
    const result = validateArtifactFile(artifactPath);
    expect(result.completenessStatus).toBe('incomplete');
  });

  it('detects an unknown relationship endpoint', () => {
    const artifact = buildMinimalArtifact();
    const evidenceId = artifact.evidence[0]!.evidenceId;
    const relFactId = factIdV1({
      sourcePath: 'rows[0].refs',
      category: 'relationship',
      rawValue: null,
    });
    const relationship = {
      assertionId: assertionIdV1({ kind: 'relationship', n: 1 }),
      assertionKind: 'relationship' as const,
      from: { lineKind: 'UNKNOWN' as const, code: '???' },
      to: { lineKind: 'RDTE_PE' as const, peCode: '0601102A' },
      relationshipType: 'references' as const,
      explicitInSource: true,
      sourceFactIds: [relFactId],
      evidenceIds: [evidenceId],
      confidence: 1,
    };
    const built: DefenseBudgetExtractionArtifactV1 = {
      ...artifact,
      sourceFacts: [
        ...artifact.sourceFacts,
        {
          factId: relFactId,
          sourcePath: 'rows[0].refs',
          category: 'relationship',
          requiredForCompleteness: false,
          evidenceIds: [evidenceId],
        },
      ],
      assertions: [...artifact.assertions, relationship],
    };
    const summary = computeArtifactSummary(built);
    const withSummary = { ...built, summary };
    const contentSha256 = computeArtifactContentSha256(withSummary);
    const final: DefenseBudgetExtractionArtifactV1 = {
      ...withSummary,
      contentSha256,
      artifactId: `dbx1_${contentSha256}`,
    };
    const artifactPath = writeTempArtifact(final);
    const result = validateArtifactFile(artifactPath);
    expect(result.completenessStatus).toBe('incomplete');
  });

  it('detects content-hash tampering', () => {
    const artifact = buildMinimalArtifact();
    const tampered: DefenseBudgetExtractionArtifactV1 = {
      ...artifact,
      contentSha256: '0'.repeat(64),
    };
    const artifactPath = writeTempArtifact(tampered);
    const result = validateArtifactFile(artifactPath);
    expect(result.valid).toBe(false);
    expect(result.findings.some((f) => f.code === 'content_sha_mismatch')).toBe(true);
  });

  it('detects summary-count tampering', () => {
    const artifact = buildMinimalArtifact();
    const tampered: DefenseBudgetExtractionArtifactV1 = {
      ...artifact,
      summary: { ...artifact.summary, assertionCount: 99 },
    };
    const artifactPath = writeTempArtifact(tampered);
    const result = validateArtifactFile(artifactPath);
    expect(result.valid).toBe(false);
    expect(result.findings.some((f) => f.code === 'summary_mismatch')).toBe(true);
  });

  it('detects an invalid evidence reference', () => {
    const artifact = buildMinimalArtifact();
    const tampered: DefenseBudgetExtractionArtifactV1 = {
      ...artifact,
      sourceFacts: [{ ...artifact.sourceFacts[0]!, evidenceIds: ['ev_missing'] }],
    };
    const artifactPath = writeTempArtifact(tampered);
    const result = validateArtifactFile(artifactPath);
    expect(result.valid).toBe(false);
    expect(result.findings.some((f) => f.code === 'unknown_evidence_reference')).toBe(true);
  });

  it('rejects a schema-invalid artifact', () => {
    const artifactPath = writeTempArtifact({ bogus: true });
    const result = validateArtifactFile(artifactPath);
    expect(result.valid).toBe(false);
    expect(result.schemaErrors).toBeDefined();
  });

  it('reports incomplete status on an incomplete artifact', () => {
    const artifact = buildIncompleteArtifact();
    const artifactPath = writeTempArtifact(artifact);
    const result = validateArtifactFile(artifactPath);
    expect(result.completenessStatus).toBe('incomplete');
  });
});
