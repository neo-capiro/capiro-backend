import { PRIVATE_SQL_NORMALIZATION_PINS as pins } from './private-sql-normalization-pins.js';
import {
  measurePrivateSqlNormalizationBehavior,
  privateSqlNormalizationRuntimeAdmitted,
  privateSqlNormalizationVersionMatches,
} from './private-sql-normalization-runtime.js';

describe('canonical meeting normalization runtime admission (offline)', () => {
  it('matches the full pinned scalar/property/trim/context fingerprint', () => {
    expect(measurePrivateSqlNormalizationBehavior()).toBe(pins.behaviorSha256);
    expect(privateSqlNormalizationRuntimeAdmitted()).toBe(true);
  });
  it.each(['node', 'v8', 'icu', 'unicode'])('refuses a changed %s implementation pin', (key) => {
    expect(privateSqlNormalizationVersionMatches({ ...pins.versions, [key]: 'changed' })).toBe(
      false,
    );
    expect(privateSqlNormalizationVersionMatches({ ...pins.versions, [key]: undefined })).toBe(
      false,
    );
  });
  it('binds multi-codepoint and newer-Unicode lowercase with original-input FinalSigma semantics', () => {
    expect('\u0130'.toLowerCase()).toBe('i\u0307');
    expect('\u1c89'.toLowerCase()).toBe('\u1c8a');
    expect('\u{10570}'.toLowerCase()).toBe('\u{10597}');
    // U+0345 is BOTH Cased and Case_Ignorable; it cannot itself supply
    // the nonignorable preceding/following Cased witness.
    expect('\u0345\u03a3'.toLowerCase()).toBe('\u0345\u03c3');
    expect('A\u03a3\u0345'.toLowerCase()).toBe('a\u03c2\u0345');
    expect('A\u03a3\u0345A'.toLowerCase()).toBe('a\u03c3\u0345a');
  });
});
