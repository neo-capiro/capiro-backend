import { assertionIdV1 } from './artifact-builders.js';
import { computeArtifactContentSha256 } from './extraction-artifact-v1.semantic.js';
import {
  DEFENSE_BUDGET_EXTRACTION_SCHEMA_VERSION,
  defenseBudgetExtractionArtifactV1Schema,
} from './extraction-artifact-v1.js';
import { buildMinimalArtifact } from './testing-helpers.js';

describe('defenseBudgetExtractionArtifactV1Schema', () => {
  it('parses a complete minimal artifact', () => {
    const artifact = buildMinimalArtifact();
    expect(() => defenseBudgetExtractionArtifactV1Schema.parse(artifact)).not.toThrow();
    expect(artifact.schemaVersion).toBe(DEFENSE_BUDGET_EXTRACTION_SCHEMA_VERSION);
    expect(artifact.artifactId).toBe(`dbx1_${artifact.contentSha256}`);
    expect(artifact.summary.completenessStatus).toBe('complete');
  });

  it('rejects unknown top-level fields', () => {
    const artifact = buildMinimalArtifact();
    const tampered = { ...artifact, unexpectedField: true };
    expect(() => defenseBudgetExtractionArtifactV1Schema.parse(tampered)).toThrow();
  });

  it('rejects unknown assertion fields', () => {
    const artifact = buildMinimalArtifact();
    const tampered = {
      ...artifact,
      assertions: [{ ...artifact.assertions[0]!, bogus: 1 }],
    };
    expect(() => defenseBudgetExtractionArtifactV1Schema.parse(tampered)).toThrow();
  });

  it('rejects exponential money strings', () => {
    const artifact = buildMinimalArtifact();
    const funding = {
      assertionId: assertionIdV1({ kind: 'funding', n: 1 }),
      assertionKind: 'funding' as const,
      identity: { lineKind: 'RDTE_PE' as const, peCode: '0602308A' },
      fiscalYear: 2099,
      field: 'request' as const,
      money: { originalValue: '1e3', originalUnit: 'thousands' as const, valueMillions: '1' },
      sourceFactIds: [],
      evidenceIds: [],
      confidence: 1,
    };
    const tampered = { ...artifact, assertions: [...artifact.assertions, funding] };
    expect(() => defenseBudgetExtractionArtifactV1Schema.parse(tampered)).toThrow();
  });

  it('rejects procurement identity without account', () => {
    const artifact = buildMinimalArtifact();
    const bad = {
      ...artifact.assertions[0]!,
      assertionKind: 'funding' as const,
      identity: { lineKind: 'PROCUREMENT_BLIN', code: 'ABC123', component: 'ARMY' },
      fiscalYear: 2099,
      field: 'request' as const,
      money: { originalValue: '1', originalUnit: 'millions' as const, valueMillions: '1' },
    };
    const tampered = { ...artifact, assertions: [bad] };
    expect(() => defenseBudgetExtractionArtifactV1Schema.parse(tampered)).toThrow();
  });

  it('rejects invalid PE codes on RDT&E identity', () => {
    const artifact = buildMinimalArtifact();
    const bad = {
      ...artifact.assertions[0]!,
      identity: { lineKind: 'RDTE_PE', peCode: 'not-a-pe' },
    };
    const tampered = { ...artifact, assertions: [bad] };
    expect(() => defenseBudgetExtractionArtifactV1Schema.parse(tampered)).toThrow();
  });

  it('rejects malformed SHA fields', () => {
    const artifact = buildMinimalArtifact();
    const tampered = {
      ...artifact,
      source: { ...artifact.source, sourcePdfSha256: 'ABCDEF' },
    };
    expect(() => defenseBudgetExtractionArtifactV1Schema.parse(tampered)).toThrow();
  });

  it('replay produces byte-identical canonical artifact', () => {
    const first = buildMinimalArtifact();
    const second = buildMinimalArtifact();
    expect(second).toEqual(first);
    expect(second.artifactId).toBe(first.artifactId);
    expect(computeArtifactContentSha256(second)).toBe(first.contentSha256);
  });
});
