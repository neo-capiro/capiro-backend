/**
 * Multi-client Advocacy match + outcome QA against real disposable corpus samples.
 * Pure-module only — does not emit findings or touch client tables.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  resolveCommunityFundingRecipientMatch,
  filterAmbiguousCommunityFundingMatches,
  recipientTokenOverlap,
} from '../../src/clients/community-funding-advocacy-match.ts';
import { normalizeIdentityText } from '../../src/government-data/community-funding/community-funding.parser.ts';
import { matchCommunityFundingAppropriationsDeterministically } from '../../src/clients/community-funding-appropriations-outcome.ts';

const samplePath = process.argv[2] || '/tmp/cpf-qa-samples.json';
const outPath = process.argv[3] || '/tmp/cpf-match-qa-results.json';
const samples = JSON.parse(readFileSync(samplePath, 'utf8'));
const results: Array<Record<string, unknown>> = [];

function scenario(name: string, fn: () => Record<string, unknown>) {
  try {
    const r = fn();
    results.push({ name, ok: true, ...r });
  } catch (e) {
    results.push({
      name,
      ok: false,
      pass: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

scenario('S1_exact_recipient', () => {
  const row = samples.exact[0];
  const d = resolveCommunityFundingRecipientMatch({
    requestId: row.id,
    recipientName: row.recipient_name,
    recipientNormalized: row.recipient_normalized,
    state: row.state,
    confirmedRequestIds: new Set(),
    clientName: row.recipient_name,
    clientStates: new Set([row.state]),
  });
  return {
    decision: d,
    pass: d.matched === true && d.method === 'exact_recipient_normalized',
  };
});

scenario('S2_confirmed_mapping', () => {
  const row = samples.exact[1];
  const d = resolveCommunityFundingRecipientMatch({
    requestId: row.id,
    recipientName: 'Totally Different Client Inc',
    recipientNormalized: 'TOTALLY DIFFERENT CLIENT INC',
    state: 'ZZ',
    confirmedRequestIds: new Set([row.id]),
    clientName: 'Totally Different Client Inc',
    clientStates: new Set(['ZZ']),
  });
  return {
    decision: d,
    pass: d.matched === true && d.method === 'confirmed_client_intel_mapping' && d.confidence === 1,
  };
});

scenario('S3_exact_alias', () => {
  const row = samples.exact[2];
  const alias = normalizeIdentityText(row.recipient_name);
  const d = resolveCommunityFundingRecipientMatch({
    requestId: row.id,
    recipientName: row.recipient_name,
    recipientNormalized: row.recipient_normalized,
    state: row.state,
    confirmedRequestIds: new Set(),
    clientName: 'Holding Company Parent LLC',
    clientAliasesNormalized: new Set([alias, row.recipient_normalized]),
    clientStates: new Set([row.state]),
  });
  return {
    decision: d,
    pass:
      d.matched === true &&
      (d.method === 'exact_alias' || d.method === 'exact_recipient_normalized'),
  };
});

scenario('S4_no_match_fabricated', () => {
  const row = samples.exact[0];
  const d = resolveCommunityFundingRecipientMatch({
    requestId: row.id,
    recipientName: row.recipient_name,
    recipientNormalized: row.recipient_normalized,
    state: row.state,
    confirmedRequestIds: new Set(),
    clientName: 'Zzz Nonexistent Aerospace Widget Corp',
    clientStates: new Set(['AK']),
  });
  return { decision: d, pass: d.matched === false };
});

scenario('S5_fuzzy_no_geo_fail_closed', () => {
  const row = samples.unique[0];
  const base = row.recipient_name || row.recipient_normalized;
  const client = String(base).replace(/\b(INC|LLC|CORP|CITY OF)\b/gi, '').trim() + ' Services';
  const sim = recipientTokenOverlap(client, row.recipient_normalized);
  const d = resolveCommunityFundingRecipientMatch({
    requestId: row.id,
    recipientName: row.recipient_name,
    recipientNormalized: row.recipient_normalized,
    state: row.state,
    confirmedRequestIds: new Set(),
    clientName: client,
    clientStates: new Set(),
    recipientSimilarity: Math.max(sim, 0.75),
  });
  return { decision: d, sim, pass: d.matched === false };
});

scenario('S6_fuzzy_with_geo', () => {
  const row = samples.unique[0];
  const client = String(row.recipient_name || row.recipient_normalized).replace(/\bINC\b/i, 'Incorporated');
  const sim = Math.max(recipientTokenOverlap(client, row.recipient_normalized), 0.8);
  const d = resolveCommunityFundingRecipientMatch({
    requestId: row.id,
    recipientName: row.recipient_name,
    recipientNormalized: row.recipient_normalized,
    state: row.state,
    confirmedRequestIds: new Set(),
    clientName: client,
    clientStates: new Set([row.state]),
    recipientSimilarity: sim,
  });
  return {
    decision: d,
    sim,
    pass: d.matched === true && d.method === 'fuzzy_recipient_with_geography',
  };
});

scenario('S7_ambiguous_top_tie_dropped', () => {
  const decisions = [
    {
      requestId: 'a',
      decision: resolveCommunityFundingRecipientMatch({
        requestId: 'a',
        recipientName: 'Metro Transit Authority',
        recipientNormalized: 'METRO TRANSIT AUTHORITY',
        state: 'CA',
        confirmedRequestIds: new Set(),
        clientName: 'Metro Transit',
        clientStates: new Set(['CA']),
        recipientSimilarity: 0.85,
      }),
    },
    {
      requestId: 'b',
      decision: resolveCommunityFundingRecipientMatch({
        requestId: 'b',
        recipientName: 'Metro Transit Authority',
        recipientNormalized: 'METRO TRANSIT AUTHORITY',
        state: 'NY',
        confirmedRequestIds: new Set(),
        clientName: 'Metro Transit',
        clientStates: new Set(['NY']),
        recipientSimilarity: 0.85,
      }),
    },
  ];
  const filtered = filterAmbiguousCommunityFundingMatches(
    decisions.map((x) => ({ requestId: x.requestId, decision: x.decision })),
  );
  // Both matched fuzzy at equal similarity → drop all (fail closed)
  const bothMatched = decisions.every((d) => d.decision.matched);
  return {
    bothMatched,
    filteredCount: filtered.length,
    decisions: decisions.map((d) => d.decision),
    pass: bothMatched ? filtered.length === 0 : true,
  };
});

scenario('S8_one_decision_per_request_multi_prov', () => {
  const row = samples.multi_prov[0];
  const d1 = resolveCommunityFundingRecipientMatch({
    requestId: row.id,
    recipientName: row.recipient_name,
    recipientNormalized: row.recipient_normalized,
    state: row.state,
    confirmedRequestIds: new Set(),
    clientName: row.recipient_name,
    clientStates: new Set(row.state ? [row.state] : []),
  });
  const d2 = resolveCommunityFundingRecipientMatch({
    requestId: row.id,
    recipientName: row.recipient_name,
    recipientNormalized: row.recipient_normalized,
    state: row.state,
    confirmedRequestIds: new Set(),
    clientName: row.recipient_name,
    clientStates: new Set(row.state ? [row.state] : []),
  });
  return {
    n_src: row.n_src,
    d1,
    d2,
    pass:
      d1.matched === d2.matched &&
      JSON.stringify(d1) === JSON.stringify(d2) &&
      Number(row.n_src) > 1,
  };
});

scenario('S9_outcome_request_id', () => {
  const m = matchCommunityFundingAppropriationsDeterministically(
    {
      communityFundingRequestId: '11111111-1111-1111-1111-111111111111',
      appropriationsAccountRaw: 'Some Account',
      fiscalYear: 2026,
    },
    {
      communityFundingRequestId: '11111111-1111-1111-1111-111111111111',
      appropriationsAccountRaw: 'Other',
      fiscalYear: 2026,
      amountStage: 'final',
    },
    {
      attributableActivityDate: new Date('2025-01-01T00:00:00Z'),
      outcomeObservedAt: new Date('2025-06-01T00:00:00Z'),
    },
  );
  return {
    match: m,
    pass: m != null && m.causationClaimed === false && m.matchedOn === 'community_funding_request_id',
  };
});

scenario('S10_outcome_disagreeing_ids_fail_closed', () => {
  const m = matchCommunityFundingAppropriationsDeterministically(
    {
      communityFundingRequestId: '11111111-1111-1111-1111-111111111111',
      appropriationsAccountRaw: 'Account A',
      fiscalYear: 2026,
    },
    {
      communityFundingRequestId: '22222222-2222-2222-2222-222222222222',
      appropriationsAccountRaw: 'Account A',
      fiscalYear: 2026,
    },
    {
      attributableActivityDate: new Date('2025-01-01T00:00:00Z'),
      outcomeObservedAt: new Date('2025-06-01T00:00:00Z'),
    },
  );
  return { match: m, pass: m == null };
});

scenario('S11_outcome_account_fy', () => {
  const m = matchCommunityFundingAppropriationsDeterministically(
    {
      appropriationsAccountRaw: 'Department of Justice - COPS',
      fiscalYear: 2025,
    },
    {
      appropriationsAccountRaw: 'Department of Justice - COPS',
      fiscalYear: 2025,
      amountFrom: 1000000,
    },
    {
      attributableActivityDate: new Date('2024-03-01T00:00:00Z'),
      outcomeObservedAt: new Date('2024-09-01T00:00:00Z'),
    },
  );
  return {
    match: m,
    pass: m != null && m.causationClaimed === false && m.matchedOn === 'appropriations_account_fy',
  };
});

scenario('S12_outcome_same_timestamp_fail_closed', () => {
  const ts = new Date('2025-06-01T00:00:00Z');
  const m = matchCommunityFundingAppropriationsDeterministically(
    { communityFundingRequestId: '11111111-1111-1111-1111-111111111111' },
    { communityFundingRequestId: '11111111-1111-1111-1111-111111111111' },
    { attributableActivityDate: ts, outcomeObservedAt: ts },
  );
  return { match: m, pass: m == null };
});

const passed = results.filter((r) => r.pass === true).length;
const failed = results.filter((r) => r.pass !== true);
const summary = { passed, failed: failed.length, results };
writeFileSync(outPath, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
process.exit(failed.length ? 1 : 0);
