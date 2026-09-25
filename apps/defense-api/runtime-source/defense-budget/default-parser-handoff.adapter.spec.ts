/**
 * Phase 10B-31 -- unit coverage for `toBudgetComponentOrThrow`, the
 * fail-closed translation `DefaultParserHandoffAdapter.handoff()` applies to
 * the bridge's raw, persisted `component` before forwarding it into the
 * parser/manifest pipeline's closed `BudgetComponentV1` vocabulary.
 *
 * Exercised directly (not through the full `handoff()` pipeline, which would
 * require standing up `runParserHandoffForSourceDocument`'s real parser
 * runtime) because this is where the repair's fail-closed guarantee actually
 * lives: a `null` component is a legitimate "no component applies" value and
 * must become `undefined` (letting the manifest builder's own documented
 * default to `'UNKNOWN'` apply); a recognized non-null component must pass
 * through unchanged; an UNRECOGNIZED non-null value is a genuine data
 * problem and must throw rather than be silently coerced to `'UNKNOWN'`,
 * which would hide exactly the kind of real-vs-reported disagreement this
 * repair exists to catch.
 */
import { toBudgetComponentOrThrow } from './default-parser-handoff.adapter.js';
import { DefaultParserHandoffAdapter } from './default-parser-handoff.adapter.js';
import { runParserHandoffForSourceDocument } from './parser-router/source-document-parser-handoff.js';
import { BUDGET_COMPONENT_V1_VALUES } from './contracts/extraction-artifact-v1.js';

jest.mock('./parser-router/source-document-parser-handoff.js', () => ({
  runParserHandoffForSourceDocument: jest.fn(),
}));

describe('toBudgetComponentOrThrow', () => {
  it("maps null to undefined (the manifest builder's own default to UNKNOWN then applies)", () => {
    expect(toBudgetComponentOrThrow(null)).toBeUndefined();
  });

  it.each(BUDGET_COMPONENT_V1_VALUES)(
    'passes a recognized component (%s) through unchanged',
    (component) => {
      expect(toBudgetComponentOrThrow(component)).toBe(component);
    },
  );

  it('fails closed on an unrecognized non-null component rather than silently coercing it to UNKNOWN', () => {
    expect(() => toBudgetComponentOrThrow('SPACE_FORCE_TYPO')).toThrow(
      /not a recognized BudgetComponentV1 value/,
    );
  });

  it('the thrown error names the actual offending value and the full recognized vocabulary', () => {
    expect(() => toBudgetComponentOrThrow('bogus')).toThrow(/"bogus"/);
    for (const value of BUDGET_COMPONENT_V1_VALUES) {
      expect(() => toBudgetComponentOrThrow('bogus')).toThrow(new RegExp(value));
    }
  });
});

describe('DefaultParserHandoffAdapter congressional packet boundary', () => {
  const input = {
    cycleId: 'cycle',
    sourceDocumentId: 'doc',
    sourceSha256: 'a'.repeat(64),
    sourcePath: '/tmp/source.pdf',
    fiscalYear: 2027,
    authorityTrack: 'authorization',
    stage: 'hasc_mark',
    sourceFamily: 'auth_committee_mark',
    title: 'HASC mark',
    sourceUrl: 'https://example.test/source.pdf',
    sourceKey: 'source-key',
    component: 'ARMY',
  } as any;

  beforeEach(() => jest.clearAllMocks());

  it('returns typed governed review for absent packet and never invokes generic parser', async () => {
    const adapter = new DefaultParserHandoffAdapter({ workDir: '/tmp' });
    const result = await adapter.handoff(input);
    expect(result.governedReview).toEqual({
      code: 'CONGRESSIONAL_GOVERNED_PACKET_MISSING',
      scope: {
        fiscalYear: 2027,
        authorityTrack: 'authorization',
        stage: 'hasc_mark',
        sourceFamily: 'auth_committee_mark',
        sourceDocumentId: 'doc',
      },
    });
    expect(runParserHandoffForSourceDocument).not.toHaveBeenCalled();
  });

  it('propagates packet provider errors so the caller can retry', async () => {
    const adapter = new DefaultParserHandoffAdapter({
      workDir: '/tmp',
      resolveCongressionalPacket: async () => {
        throw new Error('packet store unavailable');
      },
    });
    await expect(adapter.handoff(input)).rejects.toThrow('packet store unavailable');
    expect(runParserHandoffForSourceDocument).not.toHaveBeenCalled();
  });

  it('passes the exact matched governed bundle into the committee artifact factory path', async () => {
    const factoryInputs = { governed: 'exact-bundle' } as any;
    jest.mocked(runParserHandoffForSourceDocument).mockResolvedValue({
      decision: 'PASS',
      finalState: 'TERMINAL_PASSED',
      artifactLocator: 's3://artifacts/exact.json',
      outputPath: '/tmp/exact.json',
    });
    const adapter = new DefaultParserHandoffAdapter({
      workDir: '/tmp',
      resolveCongressionalPacket: async () => ({ kind: 'matched', factoryInputs }),
    });

    await adapter.handoff(input);

    expect(runParserHandoffForSourceDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        congressionalFactoryInputs: factoryInputs,
        budgetFamily: 'committee',
        budgetCycle: 'hasc',
        authority: 'hasc',
      }),
    );
  });

  it('rejects inconsistent congressional classification before packet lookup', async () => {
    const resolver = jest.fn(async () => ({ kind: 'missing' as const }));
    const adapter = new DefaultParserHandoffAdapter({
      workDir: '/tmp',
      resolveCongressionalPacket: resolver,
    });

    await expect(adapter.handoff({ ...input, authorityTrack: 'appropriations' })).rejects.toThrow(
      /does not belong to track/,
    );
    expect(resolver).not.toHaveBeenCalled();
  });
});
