import type { MeriTurnScope } from '../../components/chat/meri-turn-scope.js';
import type { PendingApproval } from '../../components/chat/useMeriChatController.js';
import { outstandingApprovals } from '../../components/chat/meri-pending-approvals.js';
import { MeriIcon } from './meri-icons.js';
import { MeriThinkingTab, type MeriThinkingTabProps } from './MeriThinkingTab.js';
import { MeriEvidenceTab, type MeriEvidenceTabProps } from './MeriEvidenceTab.js';
import { MeriApprovalsTab } from './MeriApprovalsTab.js';

/**
 * MeriTurnInspector — content for VNextMeriContextRail's v6 "turn inspector"
 * override: a third override branch alongside activeArtifact and
 * activeSourceDetail, turn-scoped rather than conversation-scoped. The rail
 * owns the outer <aside>, the shared .vnext-meri__rail-panel-head (title +
 * Thinking/Evidence/Approvals tab strip, reusing the exact same
 * .vnext-meri__rail-panel-tab* classes the Context/Memory switcher uses) and
 * the collapse button — exactly the split MeriArtifactCanvas/MeriSourceDetail
 * already use. This component is just the content below that header: a back
 * link (mirrors MeriSourceDetail's "BACK TO CONTEXT" pattern) and the active
 * tab's body.
 */

export type MeriTurnInspectorTab = 'thinking' | 'evidence' | 'approvals';

export interface MeriTurnInspectorData {
  /** The message id of the assistant turn this inspector is scoped to. */
  turnId: string;
  turnScope?: MeriTurnScope;
  contextPacketId?: string;
  thinking: MeriThinkingTabProps;
  evidence: MeriEvidenceTabProps;
  approvals: PendingApproval[];
}

/**
 * Opening-tab rule: Approvals if this turn has one awaiting a decision, else
 * Thinking. Mirrors VNextMeriConversation.tsx's existing (currently
 * unconnected) boolean:
 *   const approval = controller.pendingApprovals.length > 0 && !controller.isStreaming;
 * translated to one turn's own approvals rather than the whole conversation's.
 */
export function meriTurnInspectorInitialTab(approvals: PendingApproval[]): MeriTurnInspectorTab {
  const awaitingDecision =
    outstandingApprovals(approvals).length > 0 ||
    approvals.some(
      (proposal) =>
        proposal.status === 'failed_retryable' &&
        proposal.approvalRecovery?.state !== 'checking' &&
        proposal.approvalRecovery?.state !== 'unavailable',
    );
  return awaitingDecision ? 'approvals' : 'thinking';
}

export interface MeriTurnInspectorProps {
  data: MeriTurnInspectorData;
  activeTab: MeriTurnInspectorTab;
  /** Closes the inspector, returning the rail to Context/Memory. */
  onClose: () => void;
  /**
   * When true, the in-body BACK row is omitted because the parent rail header
   * already supplies navigation (the compact Context/Memory / return
   * controls). The onClose capability is preserved for callers that render
   * their own back control.
   */
  suppressBack?: boolean;
  approvingProposalId: string | null;
  onApprove: (proposalId: string) => void;
  onApproveAll: () => void;
  onDismiss: (proposalId: string) => void;
  onRefreshApprovalStatus?: (proposalId: string) => void;
}

export function MeriTurnInspector({
  data,
  activeTab,
  onClose,
  suppressBack = false,
  approvingProposalId,
  onApprove,
  onApproveAll,
  onDismiss,
  onRefreshApprovalStatus = () => undefined,
}: MeriTurnInspectorProps) {
  return (
    <>
      {suppressBack ? null : (
        <button type="button" className="vnext-meri__turn-inspector-back" onClick={onClose}>
          <MeriIcon name="ChevronLeft" size={13} />
          BACK
        </button>
      )}
      <div className="vnext-meri__turn-inspector-body">
        {activeTab === 'thinking' ? <MeriThinkingTab {...data.thinking} /> : null}
        {activeTab === 'evidence' ? <MeriEvidenceTab {...data.evidence} /> : null}
        {activeTab === 'approvals' ? (
          <MeriApprovalsTab
            approvals={data.approvals}
            approvingProposalId={approvingProposalId}
            onApprove={onApprove}
            onApproveAll={onApproveAll}
            onDismiss={onDismiss}
            onRefreshApprovalStatus={onRefreshApprovalStatus}
          />
        ) : null}
      </div>
    </>
  );
}
