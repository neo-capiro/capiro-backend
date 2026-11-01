import { createHash } from 'node:crypto';
import { PRIVATE_SQL_NORMALIZATION_PINS as pins } from './private-sql-normalization-pins.js';

/** Semantic admission for the canonical JS transform used by the ordinary
 * meeting owner. No database, data lookup or import-time work. The sparse wire
 * includes EVERY scalar's nonidentity case mapping, context properties and trim
 * behavior, followed by both FinalSigma contexts for every relevant scalar.
 * The exact runtime tuple also pins the ECMAScript algorithm implementation.
 */
export function measurePrivateSqlNormalizationBehavior(): string {
  const digest = createHash('sha256').update('meri-js-contact-normalization-v1\n');
  const relevant: number[] = [];
  const hexes = (value: string) =>
    Array.from(value, (c) => c.codePointAt(0)!.toString(16)).join(',');
  for (let cp = 0; cp < 0x110000; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const value = String.fromCodePoint(cp);
    const lower = value.toLowerCase();
    const flags = (/\p{Cased}/u.test(value) ? 1 : 0) | (/\p{Case_Ignorable}/u.test(value) ? 2 : 0);
    const trimmed = value.trim() === '';
    if (lower !== value || flags || trimmed) {
      relevant.push(cp);
      digest.update(cp + ':' + hexes(lower) + ':' + flags + ':' + Number(trimmed) + '\n');
    }
  }
  for (const cp of [35, ...relevant]) {
    const c = String.fromCodePoint(cp);
    const contexts = [
      c + '\u03a3',
      'A' + c + '\u03a3',
      'A\u03a3' + c,
      'A\u03a3' + c + 'A',
      'A' + c + '\u03a3A',
      'A' + c + '\u03a3' + c,
      'A\u03a3' + c + '\u03a3',
      'A' + c + c + '\u03a3' + c + c + 'A',
    ];
    contexts.forEach((input, i) =>
      digest.update(cp + '/' + i + ':' + hexes(input.trim().toLowerCase()) + '\n'),
    );
  }
  return digest.digest('hex');
}

export function privateSqlNormalizationVersionMatches(
  versions: Readonly<Record<string, string | undefined>>,
): boolean {
  return Object.entries(pins.versions).every(([key, value]) => versions[key] === value);
}

let admitted: boolean | undefined;
export function privateSqlNormalizationRuntimeAdmitted(): boolean {
  // Runtime drift refuses before obtaining even the dedicated DB client.
  if (!privateSqlNormalizationVersionMatches(process.versions)) return false;
  if (admitted === undefined)
    admitted = measurePrivateSqlNormalizationBehavior() === pins.behaviorSha256;
  return admitted;
}
