/**
 * OLD-vs-NEW parity: the NDAA-conference landing-point forecast.
 *
 * This one cannot import apps/api's side directly: the pure model lives inside
 * `conference-probability.service.ts`, which imports `@prisma/client` at module
 * scope, and apps/api's Prisma client is not generated in this workspace. Making a
 * permanent gate depend on generating a multi-megabyte client to reach one pure
 * function is the wrong trade.
 *
 * So parity is established two ways instead, which together are stronger than a
 * fixture comparison alone:
 *
 *  1. SOURCE IDENTITY — the model's text in apps/api and in
 *     `@capiro/defense-domain/pe-read` must be identical, function for function.
 *     A verbatim copy compared verbatim catches ANY divergence, including ones a
 *     fixture matrix would miss.
 *  2. BEHAVIOUR — the documented invariants are exercised against the package copy
 *     that defense-api actually runs, including the branches most likely to be
 *     "simplified" by a re-implementation.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildConferencePredictionFromHistory,
  CONFERENCE_MODEL_VERSION,
  MAX_CONFIDENCE,
  MIN_CONFIDENCE,
  toPredictionNumber,
  type ModelTrainingRow,
} from '@capiro/defense-domain/pe-read';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const LEGACY = read('apps/api/src/program-element/models/conference-probability.service.ts');
const NEXT = read('packages/defense-domain/src/pe-read/conference-prediction.ts');

/** Slice a top-level function declaration out of a module source. */
function fnSource(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `could not find function ${name}`);
  const rest = source.slice(start);
  // Functions in both files are separated by a blank line then a non-indented token.
  const end = rest.search(/\n\}\n/);
  assert.notEqual(end, -1, `could not find the end of ${name}`);
  return rest.slice(0, end + 2).trim();
}

test('PARITY: the forecast model is byte-identical between apps/api and the package copy', () => {
  for (const name of ['buildConferencePredictionFromHistory', 'toFeatures', 'average', 'clamp']) {
    assert.equal(
      fnSource(NEXT, name),
      fnSource(LEGACY, name),
      `${name} diverged between apps/api and @capiro/defense-domain/pe-read`,
    );
  }
});

test('PARITY: the model constants are identical', () => {
  for (const literal of [
    "MODEL_VERSION = 'conference-probability-v1'",
    'Z_95 = 1.96',
    'MIN_CONFIDENCE = 0.1',
    'MAX_CONFIDENCE = 0.95',
  ]) {
    const bare = literal.replace(/^const /, '');
    assert.ok(LEGACY.includes(bare), `apps/api no longer declares ${bare}`);
    assert.ok(NEXT.includes(bare), `the package copy no longer declares ${bare}`);
  }
  assert.equal(CONFERENCE_MODEL_VERSION, 'conference-probability-v1');
  assert.equal(MIN_CONFIDENCE, 0.1);
  assert.equal(MAX_CONFIDENCE, 0.95);
});

test('PARITY: the model uses simple-statistics, not a re-derived regression', () => {
  // A hand-rolled OLS would agree to within float noise but not exactly, and these
  // numbers feed money-adjacent forecast fields compared by deep equality.
  assert.match(LEGACY, /from 'simple-statistics'/);
  assert.match(NEXT, /from 'simple-statistics'/);
  for (const call of ['ss.linearRegression(', 'ss.sampleStandardDeviation(']) {
    assert.ok(LEGACY.includes(call), `apps/api no longer calls ${call}`);
    assert.ok(NEXT.includes(call), `the package copy no longer calls ${call}`);
  }
});

const HISTORY: ModelTrainingRow[] = [
  { request: 100, hascMark: 105, sascMark: 115, conference: 110 },
  { request: 200, hascMark: 190, sascMark: 210, conference: 205 },
  { request: 50, hascMark: 55, sascMark: 45, conference: 48 },
  { request: 80, hascMark: 80, sascMark: 92, conference: 88 },
  { request: 0, hascMark: 10, sascMark: 20, conference: 14 },
];

test('BEHAVIOUR: a zero HASC/SASC gap yields the flat minimum-confidence forecast', () => {
  const p = buildConferencePredictionFromHistory(
    { request: 90, hascMark: 95, sascMark: 95 },
    HISTORY,
  );
  assert.deepEqual(p, { predicted: 95, ciLow: 95, ciHigh: 95, confidence: MIN_CONFIDENCE });
});

test('BEHAVIOUR: no usable history yields null, never a fabricated forecast', () => {
  assert.equal(
    buildConferencePredictionFromHistory({ request: 120, hascMark: 125, sascMark: 140 }, []),
    null,
  );
  // Rows whose own gap is zero carry no closure signal and are filtered out; a
  // history made only of those is equivalent to no history.
  assert.equal(
    buildConferencePredictionFromHistory({ request: 120, hascMark: 125, sascMark: 140 }, [
      { request: 10, hascMark: 5, sascMark: 5, conference: 5 },
    ]),
    null,
  );
});

test('BEHAVIOUR: the forecast is deterministic and its CI brackets the point estimate', () => {
  const target = { request: 120, hascMark: 125, sascMark: 140 };
  const first = buildConferencePredictionFromHistory(target, HISTORY)!;
  const second = buildConferencePredictionFromHistory(target, HISTORY)!;
  assert.deepEqual(first, second, 'the model must be deterministic');
  assert.ok(first.ciLow <= first.predicted, 'ciLow must not exceed the point estimate');
  assert.ok(first.predicted <= first.ciHigh, 'the point estimate must not exceed ciHigh');
  assert.ok(
    first.confidence >= MIN_CONFIDENCE && first.confidence <= MAX_CONFIDENCE,
    'confidence must stay inside its clamp',
  );
});

test('BEHAVIOUR: direction matters — a SASC-high and a SASC-low target differ', () => {
  const up = buildConferencePredictionFromHistory({ request: 120, hascMark: 125, sascMark: 140 }, HISTORY)!;
  const down = buildConferencePredictionFromHistory({ request: 120, hascMark: 140, sascMark: 125 }, HISTORY)!;
  assert.notDeepEqual(up, down, 'the direction bias term must actually apply');
});

test('BEHAVIOUR: a zero request is handled without dividing by zero', () => {
  const p = buildConferencePredictionFromHistory({ request: 0, hascMark: 5, sascMark: 15 }, HISTORY)!;
  for (const v of [p.predicted, p.ciLow, p.ciHigh, p.confidence]) {
    assert.ok(Number.isFinite(v), `forecast produced a non-finite value: ${v}`);
  }
});

test('PARITY: money coercion accepts Decimal-like, string and number, and rejects junk', () => {
  assert.equal(toPredictionNumber(null), null);
  assert.equal(toPredictionNumber(undefined), null);
  assert.equal(toPredictionNumber(12.5), 12.5);
  assert.equal(toPredictionNumber('12.5'), 12.5);
  assert.equal(toPredictionNumber({ toNumber: () => 12.5 }), 12.5);
  assert.equal(toPredictionNumber(Number.NaN), null);
  assert.equal(toPredictionNumber(Number.POSITIVE_INFINITY), null);
  assert.equal(toPredictionNumber('not a number'), null);
  assert.equal(toPredictionNumber({}), null);
  // A genuine zero must survive coercion.
  assert.equal(toPredictionNumber(0), 0);
  assert.equal(toPredictionNumber('0'), 0);
});
