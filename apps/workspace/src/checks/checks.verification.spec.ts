import { ChecksService } from './checks.service.js';

/**
 * The Step 8 export gate is only as good as the verdict it reads. These cases pin
 * the three claims the UI depends on and must never conflate: whether
 * verification RAN, whether it PASSED, and whether the document has been edited
 * SINCE. They exercise the private derivations through a minimal instance because
 * the alternative — asserting them through the full evaluate() path — would need a
 * live draft row and would test Prisma, not this logic.
 */
type Internals = {
  verificationSummary(cfg: Record<string, unknown>): {
    ran: boolean;
    state: string;
    supportedCount: number;
    unsupportedCount: number;
    capturedAt: string | null;
  };
  staleness(
    cfg: Record<string, unknown>,
    updatedAt: Date,
  ): { changedAfterVerification: boolean; verifiedAt: string | null };
  contextSummary(cfg: Record<string, unknown>): {
    itemCount: number;
    exclusions: Array<{ label: string; reason: string }>;
    degraded: boolean;
  } | null;
};

const service = new ChecksService({} as never) as unknown as Internals;

const GENERATED_AT = '2026-07-28T12:00:00.000Z';

describe('ChecksService verification verdict', () => {
  it('reports not_verified for a draft that never ran the auditor', () => {
    // No contextProvenance and no groundingFindings key at all.
    const summary = service.verificationSummary({});
    expect(summary.ran).toBe(false);
    expect(summary.state).toBe('not_verified');
    expect(summary.supportedCount).toBe(0);
  });

  it('does not treat an absent groundingFindings key as a clean audit', () => {
    // Generation happened, but this draft predates the auditor. "No findings" must
    // not be inferred from "no findings recorded".
    const summary = service.verificationSummary({
      contextProvenance: { generatedAt: GENERATED_AT },
    });
    expect(summary.ran).toBe(false);
    expect(summary.state).toBe('not_verified');
  });

  it('distinguishes an empty audit with no citable claims from a pass', () => {
    const summary = service.verificationSummary({
      contextProvenance: { generatedAt: GENERATED_AT },
      groundingFindings: [],
      sectionCitations: {},
    });
    expect(summary.ran).toBe(true);
    expect(summary.state).toBe('not_verified');
  });

  it('reports verified only when claims were cited and nothing was flagged', () => {
    const summary = service.verificationSummary({
      contextProvenance: { generatedAt: GENERATED_AT },
      groundingFindings: [],
      sectionCitations: { Overview: [{ n: 1 }, { n: 2 }] },
    });
    expect(summary.state).toBe('verified');
    expect(summary.supportedCount).toBe(2);
    expect(summary.unsupportedCount).toBe(0);
    expect(summary.capturedAt).toBe(GENERATED_AT);
  });

  it('reports partially_verified with real counts when the auditor flagged claims', () => {
    const summary = service.verificationSummary({
      contextProvenance: { generatedAt: GENERATED_AT },
      groundingFindings: [
        { check: 'F1', severity: 'critical', detail: 'Funding direction reversed.' },
      ],
      sectionCitations: { Overview: [{ n: 1 }] },
    });
    expect(summary.state).toBe('partially_verified');
    expect(summary.supportedCount).toBe(1);
    expect(summary.unsupportedCount).toBe(1);
  });
});

describe('ChecksService staleness', () => {
  const cfg = { contextProvenance: { generatedAt: GENERATED_AT } };

  it('flags a document edited after verification', () => {
    const result = service.staleness(cfg, new Date('2026-07-28T13:00:00.000Z'));
    expect(result.changedAfterVerification).toBe(true);
    expect(result.verifiedAt).toBe(GENERATED_AT);
  });

  it('does not flag the write that generation itself performs', () => {
    // persistGeneratedSections updates the draft moments after generatedAt is
    // stamped; without the tolerance every fresh generation would look stale.
    const result = service.staleness(cfg, new Date('2026-07-28T12:00:00.500Z'));
    expect(result.changedAfterVerification).toBe(false);
  });

  it('never reports staleness for a document that was never verified', () => {
    const result = service.staleness({}, new Date('2026-07-28T13:00:00.000Z'));
    expect(result.changedAfterVerification).toBe(false);
    expect(result.verifiedAt).toBeNull();
  });
});

describe('ChecksService context summary', () => {
  it('reports attached-but-empty context as an exclusion rather than as used', () => {
    const summary = service.contextSummary({
      contextProvenance: {
        generatedAt: GENERATED_AT,
        contextItems: [{ id: 'a', kind: 'doc', label: 'A' }],
        memoryFiles: [],
        linkedPeCodes: [],
      },
      contextItemCount: 3,
    });
    expect(summary?.itemCount).toBe(1);
    expect(summary?.exclusions).toEqual([{ label: '2 attached items', reason: 'empty' }]);
  });

  it('surfaces a degraded context run', () => {
    const summary = service.contextSummary({
      contextProvenance: { generatedAt: GENERATED_AT, contextItems: [] },
      lastGenerationRun: { contextDegraded: true },
    });
    expect(summary?.degraded).toBe(true);
  });

  it('returns null when the draft has no provenance at all', () => {
    expect(service.contextSummary({})).toBeNull();
  });
});
