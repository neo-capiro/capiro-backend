/**
 * UI-free capability domain types.
 *
 * Extracted from `CapabilityDrawer.tsx` so that vNext modules (which must not
 * reach antd-carrying files at runtime) and the canonical drawer share ONE
 * definition. `CapabilityDrawer.tsx` re-exports these for its existing
 * importers; new code should import from here.
 */

export interface Capability {
  id: string;
  clientId: string;
  name: string;
  type: string;
  description: string | null;
  sector: string | null;
  tags: string[];
  trl: number | null;
  mrl: number | null;
  peNumber: string | null;
  // Step 2.3 — explicit multi-PE list + match keywords used by client ⇄ PE relevance.
  peNumbers: string[];
  keywords: string[];
  appropriationAccount: string | null;
  serviceBranch: string | null;
  targetSubcommittee: string | null;
  fundingAsk: number | null;
  fundingAskLabel: string | null;
  justification: string | null;
  districtNexus: string | null;
  existingContracts: string | null;
  notes: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface SubmissionHistory {
  id: string;
  clientId: string;
  capabilityId: string | null;
  fiscalYear: string;
  title: string;
  meta: string | null;
  outcome: string | null;
  outcomeType: string;
  notes: string | null;
  createdAt: string;
}
