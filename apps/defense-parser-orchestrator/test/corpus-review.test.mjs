import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SESSION5_REQUIRED_STRATA,
  buildSession5BenchmarkCorpus,
  computeDocumentContentSha,
  loadCorpusReviewLedger,
  validateCorpusReviewLedger,
  validateGoldEvidence,
} from '../src/corpus-review.mjs';

const H = (char) => char.repeat(64);

function hashDocument(document) {
  const value = structuredClone(document);
  value.contentSha256 = computeDocumentContentSha(value);
  return value;
}

function syntheticEvidence(stratum, index) {
  const id = `entry-${index}-${stratum}`;
  const gold = {
    peIdentities: stratum === 'r2_identity_banner' ? ['0600000A'] : [],
    projectIdentities:
      stratum === 'r2a_project_cost_table' ? ['P001'] : [],
    lineIdentities: ['LINE-1'],
    money: [
      {
        value: '10',
        unit: 'millions',
        fy: 2027,
        evidencePage: index + 1,
      },
    ],
    tableCells: ['LINE-1', '10'],
  };
  return hashDocument({
    schemaVersion: 'phase8_session5_gold_evidence_v1',
    id,
    stratum,
    pageClass: stratum === 'r2_identity_banner'
      ? 'identity_banner'
      : 'complex_table',
    source: {
      sourceDocumentId: `doc-${index}`,
      sourceUrl: `https://example.invalid/${index}.pdf`,
      sourcePdfSha256: H(String((index % 9) + 1)),
      fiscalYear: 2027,
      family: 'TEST',
      exhibit: 'TEST',
      authority: 'TEST',
      component: 'TEST',
      physicalPage: index + 1,
      printedPage: String(index + 1),
      title: `Test ${stratum}`,
    },
    review: {
      reviewStatus: 'accepted',
      reviewMethod: 'fixture',
      reviewer: 'independent-test',
      reviewedAt: '2026-08-19T00:00:00Z',
      incomplete: false,
      conflicted: false,
      hashBasis: 'test',
      notes: [],
    },
    excerpt: {
      text: `Source assertion for ${stratum}`,
      units: '$ in Millions',
      columnInterpretation: 'test',
    },
    gold,
  });
}

function syntheticReadyLedger() {
  const evidenceByPath = new Map();
  const entries = SESSION5_REQUIRED_STRATA.map((stratum, index) => {
    const evidence = syntheticEvidence(stratum, index);
    const path = `evidence/${evidence.id}.json`;
    evidenceByPath.set(path, evidence);
    return {
      id: evidence.id,
      stratum,
      pageClass: evidence.pageClass,
      status: 'accepted',
      evidencePath: path,
      sourceSummary: {
        sourcePdfSha256: evidence.source.sourcePdfSha256,
        physicalPage: evidence.source.physicalPage,
        printedPage: evidence.source.printedPage,
      },
      blockers: [],
    };
  });
  const ledger = hashDocument({
    schemaVersion: 'phase8_session5_corpus_review_ledger_v1',
    sourceBranchBaseSha: 'a'.repeat(40),
    reviewedAt: '2026-08-19T00:00:00Z',
    requiredStrata: [...SESSION5_REQUIRED_STRATA],
    model: {
      modelPackageArn: 'arn:aws:sagemaker:test',
      modelName: 'nemotron-parse',
      modelVersion: 'pinned',
      parserOptionsHash: H('f'),
    },
    entries,
    summary: {
      requiredStrataCount: 8,
      acceptedStrataCount: 8,
      blockedStrataCount: 0,
      acceptedStrata: [...SESSION5_REQUIRED_STRATA],
      blockedStrata: [],
      liveCorpusReady: true,
    },
  });
  return { ledger, evidenceByPath };
}

test('committed corpus ledger truthfully accepts all eight strata', async () => {
  const { ledger, evidenceByPath } = await loadCorpusReviewLedger(
    'docs/defense-budget/phase8-session5-corpus-review-ledger.json',
  );
  const analysis = validateCorpusReviewLedger(ledger, evidenceByPath);
  assert.equal(analysis.acceptedStrata.length, 8);
  assert.equal(analysis.blockedStrata.length, 0);
  assert.equal(analysis.liveCorpusReady, true);
  assert.deepEqual(analysis.acceptedStrata, [...SESSION5_REQUIRED_STRATA]);
});

test('tampered evidence content hash is rejected', () => {
  const evidence = syntheticEvidence('r2_identity_banner', 1);
  evidence.excerpt.text = 'tampered';
  assert.throws(
    () => validateGoldEvidence(evidence),
    (error) => error.code === 'CONTENT_HASH_MISMATCH',
  );
});

test('incomplete or conflicted evidence cannot be accepted', () => {
  const evidence = syntheticEvidence('r2_identity_banner', 1);
  evidence.review.incomplete = true;
  evidence.contentSha256 = computeDocumentContentSha(evidence);
  assert.throws(
    () => validateGoldEvidence(evidence),
    (error) => error.code === 'GOLD_NOT_ACCEPTABLE',
  );
});

test('all eight accepted source-grounded strata build a benchmark corpus', () => {
  const { ledger, evidenceByPath } = syntheticReadyLedger();
  const analysis = validateCorpusReviewLedger(ledger, evidenceByPath);
  const corpus = buildSession5BenchmarkCorpus(ledger, analysis);
  assert.equal(analysis.liveCorpusReady, true);
  assert.equal(corpus.entries.length, 8);
  assert.equal(corpus.providers[1].id, 'nemotron_parse');
  assert.equal(corpus.entries[0].gold.reviewStatus, 'accepted');
});

test('accepted evidence without an immutable source SHA is rejected', () => {
  const evidence = syntheticEvidence('r2_identity_banner', 1);
  evidence.source.sourcePdfSha256 = null;
  evidence.contentSha256 = computeDocumentContentSha(evidence);
  assert.throws(
    () => validateGoldEvidence(evidence),
    (error) => error.code === 'INVALID_SHA256',
  );
});
