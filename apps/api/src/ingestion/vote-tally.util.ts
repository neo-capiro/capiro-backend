/**
 * Pure roll-call tally helpers shared by sync-house-votes + sync-senate-votes
 * (LegiWatch A1). Buckets raw voteCast strings into lanes and computes overall
 * + per-party totals from member rows, so both chambers produce identical
 * `partyTotals` JSON regardless of source-field naming.
 */

export type VoteLane = 'yea' | 'nay' | 'present' | 'notVoting';

/** House uses Yea/Nay (or Aye/No on non-2/3 votes); Senate uses Yea/Nay/Present/Not Voting. */
export function voteBucket(raw: string | null | undefined): VoteLane {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'yea' || v === 'aye' || v === 'yes') return 'yea';
  if (v === 'nay' || v === 'no') return 'nay';
  if (v === 'present') return 'present';
  return 'notVoting'; // "Not Voting", blank, "Present - Announced", etc.
}

export interface PartyLaneTotals {
  yea: number;
  nay: number;
  present: number;
  notVoting: number;
}

export interface VoteTally {
  yeas: number;
  nays: number;
  present: number;
  notVoting: number;
  partyTotals: Record<string, PartyLaneTotals>;
}

/** Overall + per-party tallies from normalized {cast, party} member rows. */
export function tallyFrom(
  members: Array<{ cast: string | null | undefined; party: string | null | undefined }>,
): VoteTally {
  const t: VoteTally = { yeas: 0, nays: 0, present: 0, notVoting: 0, partyTotals: {} };
  for (const m of members) {
    const lane = voteBucket(m.cast);
    const party = (m.party ?? '?').trim() || '?';
    if (!t.partyTotals[party]) t.partyTotals[party] = { yea: 0, nay: 0, present: 0, notVoting: 0 };
    if (lane === 'yea') {
      t.yeas++;
      t.partyTotals[party].yea++;
    } else if (lane === 'nay') {
      t.nays++;
      t.partyTotals[party].nay++;
    } else if (lane === 'present') {
      t.present++;
      t.partyTotals[party].present++;
    } else {
      t.notVoting++;
      t.partyTotals[party].notVoting++;
    }
  }
  return t;
}
