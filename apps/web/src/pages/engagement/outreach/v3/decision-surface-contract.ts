import type { Client } from '../../../clients/clientTypes.js';
import type {
  CapabilityResult,
  OutreachV3Command,
  OutreachV3ContextCandidate,
  OutreachV3ContextReviewResponse,
  OutreachV3ContextSearchInput,
  OutreachV3Proposal,
  OutreachV3SessionEnvelope,
  OutreachV3Stage,
  OutreachV3StrategyData,
  OutreachV3TargetCandidate,
  OutreachV3TargetCoverageResponse,
  OutreachV3TargetLocator,
  OutreachV3TargetSearchData,
} from './contracts.js';
import type { OutreachV3TargetProfileResponse } from './target-intelligence-contracts.js';

export interface OutreachV3DecisionSurfaceProps {
  session: OutreachV3SessionEnvelope;
  stage: OutreachV3Stage;
  clients: Client[];
  selectedClientId: string | null;
  busy: boolean;
  applyCommands: (commands: OutreachV3Command[]) => Promise<unknown>;
  pendingProposals: OutreachV3Proposal[];
  proposalBusy: boolean;
  applyProposal: (proposal: OutreachV3Proposal) => Promise<unknown>;
  rejectProposal: (proposal: OutreachV3Proposal) => Promise<unknown>;
  searchTargets: (input: {
    query?: string;
    clientId?: string | null;
    sources?: string[];
    limit?: number;
  }) => Promise<unknown>;
  targetCandidates: OutreachV3TargetCandidate[];
  targetSearchPending: boolean;
  targetSearchError?: string | null;
  targetSearchResult?: CapabilityResult<OutreachV3TargetSearchData>;
  getTargetProfile: (locator: OutreachV3TargetLocator) => Promise<unknown>;
  targetProfile?: OutreachV3TargetProfileResponse;
  targetProfilePending: boolean;
  coverage?: OutreachV3TargetCoverageResponse;
  coveragePending: boolean;
  searchContext: (input: OutreachV3ContextSearchInput) => Promise<unknown>;
  contextCandidates: OutreachV3ContextCandidate[];
  contextSearchPending: boolean;
  contextSearchError?: string | null;
  contextReview?: OutreachV3ContextReviewResponse;
  contextReviewPending: boolean;
  contextReviewError?: string | null;
  strategy?: CapabilityResult<OutreachV3StrategyData>;
  strategyPending: boolean;
  strategyError?: string | null;
  onFinish: () => void;
}
