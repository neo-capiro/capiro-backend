import {
  isValidCanonicalId,
  normalizeCanonicalId,
  parseBillId,
  formatBillId,
  parseBillDesignation,
  zBioguideId,
  zBillId,
  zCommitteeSystemCode,
  CANONICAL_ID_TYPES,
} from '../../../src/index';
import type { EvalCase } from '../types';

/**
 * SC2.2 entity-grounding MECHANISM gate (Bucket-#3 C6.P6.2). Deterministic,
 * DB-free — it exercises the single source of truth every "no fabricated
 * members/bills/committees" behavior rests on: the canonical-id validators,
 * normalizers, round-trips, and the zod schemas that gate native tool params
 * at the registry's safeParse choke point.
 *
 * What this deliberately does NOT cover: whether the LLM chooses to call
 * resolve_entity before citing an entity — that's live-LLM behavior, outside
 * the deterministic gate's documented scope (see run-evals.ts header).
 */

// Shapes a model might FABRICATE — every one must be rejected. If any of
// these validates, a hallucinated identifier can masquerade as grounded.
const FABRICATED: Array<[string, string]> = [
  ['bioguide', 'Nancy Pelosi'], // a name is not an id
  ['bioguide', 'A00036'], // too short
  ['bioguide', 'AB000360'], // two leading letters
  ['billId', '119-xx-8800'], // invented bill type
  ['billId', 'hr-8800'], // missing congress
  ['committee', 'zzag00'], // chamber letter not h/s/j
  ['committee', 'hsag'], // missing digits
  ['committee', 'House Agriculture'], // a name is not a systemCode
];

const REAL: Array<[string, string, string]> = [
  // [type, messy input, expected normalized]
  ['bioguide', 'a000360', 'A000360'],
  ['bioguide', 'V000128', 'V000128'],
  ['billId', '119-HR-8800', '119-hr-8800'],
  ['committee', 'HSAG00', 'hsag00'],
];

export const entityGroundingCase: EvalCase = {
  id: 'entity.grounding.canonical-ids',
  category: 'entity',
  description:
    'Canonical-id mechanism: fabricated shapes rejected, real ids normalize + round-trip, zod schemas gate tool params',
  async run() {
    const problems: string[] = [];
    const seedFailure = process.env.MERIV2_EVAL_SEED_FAILURE === '1';

    // 1. Fabricated shapes must be rejected by every relevant validator.
    for (const [type, value] of FABRICATED) {
      const normalized = normalizeCanonicalId(type as never, value);
      if (isValidCanonicalId(type as never, normalized)) {
        problems.push(`fabricated ${type} "${value}" validated`);
      }
    }

    // 2. Real ids validate after normalization, and normalization is
    // idempotent (a normalized id re-normalizes to itself).
    for (const [type, messy, expected] of REAL) {
      const normalized = normalizeCanonicalId(type as never, messy);
      if (normalized !== expected) {
        problems.push(`normalize(${type}, "${messy}") = "${normalized}", expected "${expected}"`);
      }
      if (!isValidCanonicalId(type as never, normalized)) {
        problems.push(`real ${type} "${expected}" failed validation`);
      }
      if (normalizeCanonicalId(type as never, normalized) !== normalized) {
        problems.push(`normalization not idempotent for ${type} "${messy}"`);
      }
    }

    // 3. billId round-trip: parse -> format is the identity on canonical ids,
    // and a human designation lands on the same canonical id.
    const parsed = parseBillId('119-hr-8800');
    if (!parsed || formatBillId(parsed.congress, parsed.type, parsed.number) !== '119-hr-8800') {
      problems.push('billId parse->format round-trip broke');
    }
    const designated = parseBillDesignation('H.R. 8800 (119th)', 118);
    if (
      !designated ||
      formatBillId(designated.congress, designated.type, designated.number) !== '119-hr-8800'
    ) {
      problems.push('bill designation "H.R. 8800 (119th)" did not resolve to 119-hr-8800');
    }

    // 4. zod schemas (the registry safeParse gate for native tool params):
    // messy-but-real input passes NORMALIZED; fabricated input throws.
    const good = zBioguideId.safeParse('a000360');
    if (!good.success || good.data !== 'A000360') {
      problems.push('zBioguideId did not normalize+accept "a000360"');
    }
    if (zBioguideId.safeParse(seedFailure ? 'A000360' : 'Nancy Pelosi').success) {
      problems.push('zBioguideId accepted a member NAME — fabrication guard broken');
    }
    if (zBillId.safeParse('119-xx-8800').success) {
      problems.push('zBillId accepted an invented bill type');
    }
    if (!zCommitteeSystemCode.safeParse('HSAG00').success) {
      problems.push('zCommitteeSystemCode rejected a real systemCode');
    }

    // 5. Registry completeness: every declared id type has a working validator
    // (guards against adding a type without a pattern).
    for (const type of CANONICAL_ID_TYPES) {
      if (isValidCanonicalId(type, '')) {
        problems.push(`empty string validates as ${type}`);
      }
    }

    return {
      pass: problems.length === 0,
      detail:
        problems.length === 0
          ? `mechanism sound: ${FABRICATED.length} fabricated shapes rejected, ${REAL.length} real ids normalized, round-trips + zod gates green`
          : `entity-grounding FAILURES: ${problems.join('; ')}`,
    };
  },
};
