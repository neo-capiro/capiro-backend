import {
  MESSAGE_PLAN_MAX_OUTPUT_TOKENS,
  normalizeSourceId,
  sourceIdVariants,
} from './message-plan.service.js';

/**
 * Regression coverage for the live 2026-08-24 Outreach V3 generation outage.
 *
 * Symptom: every congressional-office campaign failed with 0 drafts. Job
 * 94fb8803-244b-47e6-8c84-d91a13b75470 (tenant 094dcbab…, 51 recipients) ended
 * `partial` with 23 items `MESSAGE_PLAN_INVALID` + 28 `held`, 0 succeeded; the
 * three retries before it failed 49, 39 and 23 items the same way.
 *
 * Root cause: `validatePlan` check #2 (CLAIM_CITES_UNKNOWN_SOURCE) required the
 * planner to echo an evidence `sourceId` byte-exact, but Outreach V3 sets
 * `sourceId` to the raw internal contextKey — a 110–133 char colon-delimited
 * string whose own `sourceType` is a prefix and whose middle segments repeat.
 * The model cited the right evidence and lost on transcription.
 *
 * These are the REAL ids captured from that job's persisted
 * `outreach_job_items.result_jsonb.manifest`.
 */

const REAL_EVIDENCE: ReadonlyArray<{ sourceType: string; sourceId: string }> = [
  {
    sourceType: 'context_plane:coverage',
    sourceId: 'f43c6a75-16be-4628-ad85-cf9f5ae1035d',
  },
  {
    sourceType: 'outreach_v3:capiro_record',
    sourceId:
      'outreach_v3:capiro_record:campaign_fact:campaign:capiro_record:client:635f2874-c3ac-417b-8360-1cb414746f13:all',
  },
  {
    sourceType: 'outreach_v3:government_record:lda_filing',
    sourceId:
      'outreach_v3:government_record:lda_filing:campaign_fact:campaign:government_record:lda_filing:4ff509f7-2b21-4e49-b11d-ba7c4ac4dc4a:all',
  },
  {
    sourceType: 'outreach_v3:government_record:program_element',
    sourceId:
      'outreach_v3:government_record:program_element:campaign_fact:campaign:government_record:program_element:6458B95004:all',
  },
];

const AMBIGUOUS = '\u0000ambiguous';

/** Mirrors the resolver built inside validatePlan check #2. */
function buildResolver(evidence: ReadonlyArray<{ sourceType: string; sourceId: string }>) {
  const canonicalById = new Map<string, string>();
  const register = (variant: string, canonical: string): void => {
    const key = normalizeSourceId(variant);
    if (!key) return;
    const existing = canonicalById.get(key);
    canonicalById.set(key, existing && existing !== canonical ? AMBIGUOUS : canonical);
  };
  for (const e of evidence) {
    for (const v of sourceIdVariants(e.sourceType, e.sourceId)) register(v, e.sourceId);
  }
  return (cited: string): string | null => {
    const hit = canonicalById.get(normalizeSourceId(cited));
    return !hit || hit === AMBIGUOUS ? null : hit;
  };
}

describe('message-plan source citation resolution (live outage regression)', () => {
  const resolve = buildResolver(REAL_EVIDENCE);

  it('keeps the reasoning-model token ceiling that fixed the earlier truncation bug', () => {
    // Guards against a regression back to the 2000 ceiling that caused the
    // *previous* MESSAGE_PLAN_INVALID outage (empty text / incomplete response).
    expect(MESSAGE_PLAN_MAX_OUTPUT_TOKENS).toBeGreaterThanOrEqual(8000);
  });

  it('accepts the exact sourceId (unchanged behavior)', () => {
    for (const e of REAL_EVIDENCE) {
      expect(resolve(e.sourceId)).toBe(e.sourceId);
    }
  });

  it('accepts a citation that drops the trailing :all scope suffix', () => {
    // The single most likely model output: it writes the id but stops at the uuid.
    const e = REAL_EVIDENCE[2]!;
    expect(resolve(e.sourceId.slice(0, e.sourceId.lastIndexOf(':')))).toBe(e.sourceId);
  });

  it('accepts a citation that omits the duplicated sourceType prefix', () => {
    const e = REAL_EVIDENCE[2]!;
    const withoutPrefix = e.sourceId.slice(`${e.sourceType}:`.length);
    expect(resolve(withoutPrefix)).toBe(e.sourceId);
  });

  it('accepts separator drift (- or / instead of :) and case/whitespace noise', () => {
    const e = REAL_EVIDENCE[3]!;
    expect(resolve(e.sourceId.replace(/:/g, '-'))).toBe(e.sourceId);
    expect(resolve(`  ${e.sourceId.toUpperCase()}  `)).toBe(e.sourceId);
    expect(resolve(`"${e.sourceId}"`)).toBe(e.sourceId);
  });

  it('still resolves the plain-uuid context-plane source', () => {
    expect(resolve('f43c6a75-16be-4628-ad85-cf9f5ae1035d')).toBe(
      'f43c6a75-16be-4628-ad85-cf9f5ae1035d',
    );
  });

  // ── The security half: tolerance must not become "accept anything" ──

  it('rejects a citation to a source that is not in the packet at all', () => {
    expect(resolve('outreach_v3:government_record:bill:campaign_fact:hr-1234:all')).toBeNull();
    expect(resolve('00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('rejects a bare sourceType, which identifies no single evidence row', () => {
    // Two REAL_EVIDENCE rows share the government_record family; a bare type is
    // not a citation and must not silently bind to one of them.
    expect(resolve('outreach_v3:government_record')).toBeNull();
    expect(resolve('context_plane')).toBeNull();
  });

  it('never trims a variant back to just the sourceType', () => {
    // Regression: an earlier refactor added the re-prefixed form
    // `context_plane:coverage:<uuid>` and then applied trailing-scope trimming to
    // it, yielding bare `context_plane:coverage` — which normalizes to
    // `context_plane` and made a bare-type citation resolve.
    for (const e of REAL_EVIDENCE) {
      const variants = sourceIdVariants(e.sourceType, e.sourceId);
      expect(variants).not.toContain(e.sourceType);
      for (const v of variants) {
        expect(normalizeSourceId(v)).not.toBe(normalizeSourceId(e.sourceType));
      }
    }
  });

  it('rejects an empty or whitespace-only citation', () => {
    expect(resolve('')).toBeNull();
    expect(resolve('   ')).toBeNull();
  });

  it('never resolves a variant two distinct evidence rows share', () => {
    // Synthesize a genuine collision: two refs whose ids differ only by the
    // scope suffix the resolver is willing to drop.
    const base =
      'outreach_v3:capiro_record:campaign_fact:campaign:capiro_record:client:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const collide = buildResolver([
      { sourceType: 'outreach_v3:capiro_record', sourceId: `${base}:all` },
      { sourceType: 'outreach_v3:capiro_record', sourceId: `${base}:staff-1` },
    ]);
    // Each exact id still resolves to itself…
    expect(collide(`${base}:all`)).toBe(`${base}:all`);
    expect(collide(`${base}:staff-1`)).toBe(`${base}:staff-1`);
    // …but the ambiguous truncation resolves to neither.
    expect(collide(base)).toBeNull();
  });

  it('does not emit dangerously short variants', () => {
    for (const e of REAL_EVIDENCE) {
      for (const v of sourceIdVariants(e.sourceType, e.sourceId)) {
        expect(v.length).toBeGreaterThanOrEqual(8);
      }
    }
  });

  it('proves the pre-fix failure modes were all rejected by exact matching', () => {
    // Documents the actual bug: under the old Set-of-exact-strings resolver every
    // one of these realistic model outputs was reported CLAIM_CITES_UNKNOWN_SOURCE.
    const e = REAL_EVIDENCE[2]!;
    const exactOnly = new Set([
      e.sourceId,
      `${e.sourceType}-${e.sourceId}`,
      `${e.sourceType}:${e.sourceId}`,
    ]);
    const realisticModelOutputs = [
      e.sourceId.slice(0, e.sourceId.lastIndexOf(':')),
      e.sourceId.slice(`${e.sourceType}:`.length),
      e.sourceId.replace(/:/g, '-'),
    ];
    for (const guess of realisticModelOutputs) {
      expect(exactOnly.has(guess)).toBe(false); // old behavior: rejected
      expect(resolve(guess)).toBe(e.sourceId); // new behavior: resolved
    }
  });
});
