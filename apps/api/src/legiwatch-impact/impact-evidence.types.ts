import type { LegiWatchBillVersion, LegiWatchClientFact, LegiWatchCitation } from '@capiro/shared';

/** The evidence owner supplies current, authorized facts and immutable bill text. */
export interface ImpactEvidenceSnapshot {
  clientId: string;
  billId: string;
  fingerprint: string;
  billStatus: string | null;
  versions: LegiWatchBillVersion[];
  provisions: Array<LegiWatchCitation & { text: string }>;
  clientFacts: LegiWatchClientFact[];
  coverageNotes: string[];
}
