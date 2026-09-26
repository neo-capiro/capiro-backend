import {
  adapterTestContext,
  ADAPTER_TEST_CONFIG_SHA,
  ADAPTER_TEST_SOURCE_SHA,
} from '../contracts/adapters/testing-helpers.js';
import {
  sealParserRuntimeResult,
  type ParserRuntimeResultV1,
} from '../parser-router/parser-runtime-contract-v1.js';
import { parserRunIdV1 } from '../parser-router/parser-run-identity-v1.js';
import { createHascSourceProfileV1 } from './authorization/hasc-source-profile-v1.js';
import {
  CONGRESSIONAL_STAGE_ADAPTER_MODE_V1,
  resolveCongressionalSemanticArtifactFactoryV1,
  type CongressionalSemanticFactoryContextV1,
} from './congressional-semantic-artifact-factory-v1.js';
import { persistProofBoundCongressionalArtifactV1 } from '../parser-router/congressional-durable-semantic-artifact-factory-v1.js';
import { sha256Bytes } from '../contracts/canonical-json.js';
import type { ExtractionArtifactStoreV1 } from '../parser-router/extraction-artifact-store.js';
import type { Phase5ParserResultProofV1 } from '../non-rdte/non-rdte-proof-bound-artifact-v1.js';
import type { CommitteeArtifactV1Input } from '../contracts/adapters/committee-artifact-v1.adapter.js';
import type { StageV1 } from './stage-vocabulary-v1.js';

const SHA = ADAPTER_TEST_SOURCE_SHA;

function parserResult(): ParserRuntimeResultV1 {
  return sealParserRuntimeResult({
    schemaVersion: 'defense_budget_parser_result_v1',
    jobId: 'p3-congressional-test',
    engine: 'deterministic_pdfplumber',
    parserVersion: 'test-1',
    parserConfigSha256: ADAPTER_TEST_CONFIG_SHA,
    inputSourceSha256: SHA,
    requestedPages: [1],
    succeededPages: [1],
    failedPages: [],
    pages: [
      {
        page: 1,
        text: 'structured committee row fixture',
        blocks: [],
        tables: [],
        images: [],
        evidencePrecision: 'page_only',
        warnings: [],
      },
    ],
    warnings: [],
    metrics: {
      durationMillis: 1,
      pagesProcessed: 1,
      pagesSucceeded: 1,
      pagesFailed: 0,
      engineVersion: 'test',
    },
  });
}

function context(
  result: ParserRuntimeResultV1 = parserResult(),
): CongressionalSemanticFactoryContextV1 {
  const profile = createHascSourceProfileV1({
    fiscalYear: 2027,
    reportNumber: 'H. Rept. test',
    sourceDocumentKeys: ['congress-test'],
  });
  // This narrow profile is a unit-test contract, not production source
  // qualification. It demonstrates only the adapter's supported line kind.
  profile.requiredLineFamilies = ['rdte_pe'];
  return {
    profile,
    context: adapterTestContext({
      manifestDocumentKey: 'congress-test',
      sourceDocumentId: 'congress-test-source',
      sourcePdfSha256: SHA,
      fiscalYear: 2027,
      family: 'committee',
      exhibit: 'committee_report',
      authority: 'hasc',
      budgetCycle: 'pb_fy2027',
      parser: {
        method: result.engine,
        parserVersion: result.parserVersion,
        parserConfigSha256: result.parserConfigSha256,
        outputArtifactSha256: result.contentSha256,
        pageRanges: [{ startPage: 1, endPage: 1 }],
      },
    }),
  };
}

function input(overrides: Partial<CommitteeArtifactV1Input> = {}): CommitteeArtifactV1Input {
  return {
    chamber: 'HASC',
    fy: 2027,
    source: 'governed-structured-row.json',
    rows: [
      {
        peCode: '0601102A',
        fy: 2027,
        mark: '1200',
        markUnit: 'thousands',
        page: 1,
        explanation: 'test row',
      },
    ],
    ...overrides,
  };
}

function proof(result: ParserRuntimeResultV1): Phase5ParserResultProofV1[] {
  const parserRunId = parserRunIdV1({
    sourceSha256: result.inputSourceSha256,
    method: result.engine,
    parserVersion: result.parserVersion,
    parserConfigSha256: result.parserConfigSha256,
    requestedPages: result.requestedPages,
  });
  return [{ parserRunId, result, resultByteSha256: 'd'.repeat(64) }];
}

describe('Package 3 congressional semantic factory seam', () => {
  it('maps every stage explicitly and leaves non-committee stages unsupported', () => {
    const stages: StageV1[] = [
      'hasc',
      'sasc',
      'ndaa_conference',
      'hac_d',
      'sac_d',
      'appropriations_conference',
      'public_law',
      'continuing_resolution',
      'reprogramming',
      'execution',
    ];
    expect(Object.keys(CONGRESSIONAL_STAGE_ADAPTER_MODE_V1).sort()).toEqual([...stages].sort());
    expect(CONGRESSIONAL_STAGE_ADAPTER_MODE_V1.continuing_resolution).toBeNull();
    expect(CONGRESSIONAL_STAGE_ADAPTER_MODE_V1.reprogramming).toBeNull();
    expect(CONGRESSIONAL_STAGE_ADAPTER_MODE_V1.execution).toBeNull();
    expect(CONGRESSIONAL_STAGE_ADAPTER_MODE_V1.public_law).toBeNull();
  });

  it('builds a proof-bound RDT&E-only mark without assigning request ownership', () => {
    const result = parserResult();
    const factory = resolveCongressionalSemanticArtifactFactoryV1('committee', context(result));
    expect(factory).toBeDefined();
    const artifact = factory!(input(), proof(result));
    expect(
      artifact.assertions.some(
        (item) => item.assertionKind === 'funding' && item.field === 'request',
      ),
    ).toBe(false);
    expect(
      artifact.assertions.some(
        (item) => item.assertionKind === 'funding' && item.field === 'hascMark',
      ),
    ).toBe(true);
  });

  it('rejects request values because the legacy adapter would mark them as owned funding', () => {
    const result = parserResult();
    const factory = resolveCongressionalSemanticArtifactFactoryV1('committee', context(result))!;
    expect(() =>
      factory(
        input({
          rows: [
            {
              peCode: '0601102A',
              fy: 2027,
              request: '1000',
              requestUnit: 'thousands',
              mark: '1200',
              markUnit: 'thousands',
              page: 1,
            },
          ],
        }),
        proof(result),
      ),
    ).toThrow('legacy committee adapter request assertions are incompatible');
  });

  it('rejects empty rows, missing stage marks, and units outside the profile', () => {
    const result = parserResult();
    const factory = resolveCongressionalSemanticArtifactFactoryV1('committee', context(result))!;
    expect(() => factory(input({ rows: [] }), proof(result))).toThrow(
      'congressional semantic input contains no structured rows',
    );
    expect(() =>
      factory(input({ rows: [{ peCode: '0601102A', fy: 2027 }] }), proof(result)),
    ).toThrow('every legacy congressional row must carry its stage-owned mark value');
    const profile = context(result);
    profile.profile.declaredUnits = ['dollars'];
    const unitFactory = resolveCongressionalSemanticArtifactFactoryV1('committee', profile)!;
    expect(() => unitFactory(input(), proof(result))).toThrow(
      'which the stage profile does not permit',
    );
  });

  it('rejects mixed-family stage profiles, absent proof, and context authority mismatch', () => {
    const mixed = context();
    expect(() => resolveCongressionalSemanticArtifactFactoryV1('committee', mixed)).not.toThrow();
    mixed.profile.requiredLineFamilies.push('procurement_blin');
    expect(() => resolveCongressionalSemanticArtifactFactoryV1('committee', mixed)).toThrow(
      'legacy committee adapter is limited to RDTE-only stage profiles',
    );

    const exact = context();
    const factory = resolveCongressionalSemanticArtifactFactoryV1('committee', exact)!;
    expect(() => factory(input(), [])).toThrow(/parser-result proof|matching persisted results/);

    const wrongAuthority = context();
    wrongAuthority.context.authority = 'sasc';
    expect(() =>
      resolveCongressionalSemanticArtifactFactoryV1('committee', wrongAuthority),
    ).toThrow('stage hasc requires adapter authority hasc');
  });

  it('returns no factory for unrelated families and rejects unsupported stage/family pairs', () => {
    expect(resolveCongressionalSemanticArtifactFactoryV1('procurement', context())).toBeUndefined();
    const mismatch = context();
    expect(() => resolveCongressionalSemanticArtifactFactoryV1('public_law', mismatch)).toThrow(
      'budget family does not match the reviewed congressional stage',
    );
  });

  it('persists the exact serialized artifact and checks the durable byte digest', async () => {
    const result = parserResult();
    const store: ExtractionArtifactStoreV1 = {
      putImmutable: jest.fn(async ({ bytes }) => ({
        locator: 'immutable://congress/artifact',
        byteSha256: sha256Bytes(bytes),
      })),
      readVerified: jest.fn(),
      materializeForLocalConsumer: jest.fn(),
    };
    const output = await persistProofBoundCongressionalArtifactV1({
      budgetFamily: 'committee',
      factoryContext: context(result),
      input: input(),
      parserResultProofs: proof(result),
      store,
    });
    expect(output.artifactLocator).toBe('immutable://congress/artifact');
    expect(output.artifactByteSha256).toBe(
      sha256Bytes(Buffer.from(`${JSON.stringify(output.artifact, null, 2)}\n`)),
    );
    expect(output.assertionCount).toBe(output.artifact.assertions.length);

    const mismatchingStore: ExtractionArtifactStoreV1 = {
      ...store,
      putImmutable: jest.fn(async () => ({
        locator: 'immutable://wrong-hash',
        byteSha256: '0'.repeat(64),
      })),
    };
    await expect(
      persistProofBoundCongressionalArtifactV1({
        budgetFamily: 'committee',
        factoryContext: context(result),
        input: input(),
        parserResultProofs: proof(result),
        store: mismatchingStore,
      }),
    ).rejects.toThrow(/byte SHA changed across durable persistence/);
  });
});
