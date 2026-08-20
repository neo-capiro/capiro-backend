import assert from 'node:assert/strict';
import test from 'node:test';
import { validateLiveBenchmarkCorpus } from '../src/real-batch.mjs';

const sha = (n) => String(n).repeat(64);
const strata = [
  'r1_zero_native_tables',
  'r2_identity_banner',
  'r2a_project_cost_table',
  'scanned_image_only',
  'navy_ba6_duplicate_flattening',
  'p1_table',
  'o1_op5_table',
  'defense_wide_volume',
];

function corpus() {
  return {
    schemaVersion: 'phase8_session5_benchmark_corpus_v1',
    entries: strata.map((stratum, index) => ({
      id: `entry-${index}`,
      stratum,
      pageClass: stratum === 'scanned_image_only' ? 'scanned_image' : 'complex_table',
      sourceSha256: sha((index % 8) + 1),
      pageNumber: index + 1,
      gold: {
        reviewStatus: 'accepted',
        incomplete: false,
        conflicted: false,
        sourceEvidenceSha256: sha(((index + 1) % 8) + 1),
        peIdentities: stratum === 'r2_identity_banner' ? ['0600001A'] : [],
        projectIdentities:
          stratum === 'r2a_project_cost_table' ? ['PROJECT-1'] : [],
        lineIdentities:
          ['p1_table', 'o1_op5_table'].includes(stratum) ? ['LINE-1'] : [],
        money: [
          {
            value: '1.25',
            unit: 'millions',
            fy: 2027,
            evidencePage: index + 1,
          },
        ],
        tableCells: ['row|cell'],
      },
    })),
  };
}

test('strict live gold gate requires scorable source/page/assertion evidence for all eight strata', () => {
  const value = validateLiveBenchmarkCorpus(corpus(), {
    requireScorableGold: true,
  });
  assert.equal(value.acceptedEntries, 8);
  assert.equal(value.scorableGoldEnforced, true);
});

test('strict live gold gate rejects accepted metadata with no scorable assertion arrays', () => {
  const value = corpus();
  value.entries[3].gold.peIdentities = [];
  value.entries[3].gold.projectIdentities = [];
  value.entries[3].gold.lineIdentities = [];
  value.entries[3].gold.money = [];
  value.entries[3].gold.tableCells = [];
  assert.throws(
    () =>
      validateLiveBenchmarkCorpus(value, { requireScorableGold: true }),
    (error) =>
      error.code === 'LIVE_CORPUS_NOT_ACCEPTABLE' &&
      error.details.problems.some((problem) =>
        problem.includes('no scorable identity/money/table assertion'),
      ),
  );
});

test('strict live gold gate rejects missing physical source identity even with accepted labels', () => {
  const value = corpus();
  value.entries[0].sourceSha256 = 'bad';
  assert.throws(
    () =>
      validateLiveBenchmarkCorpus(value, { requireScorableGold: true }),
    (error) => error.code === 'LIVE_CORPUS_NOT_ACCEPTABLE',
  );
});
