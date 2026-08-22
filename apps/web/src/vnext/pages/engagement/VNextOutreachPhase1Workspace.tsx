import type { Client } from '../../../pages/clients/clientTypes.js';
import type { VNextOutreachOperatorWorkspaceProps } from './VNextOutreachOperatorWorkspace.js';
import { VNextOutreachApproveSendWorkspace } from './VNextOutreachApproveSendWorkspace.js';
import { VNextOutreachGuidedWorkspace } from './VNextOutreachGuidedWorkspace.js';

/**
 * Outreach V3 uses one guided, workflow-specific setup for every new campaign,
 * then hands the same canonical session to the governed draft and send spine.
 *
 * The setup surface owns workflow choice, campaign name, sponsor, Directory
 * recipients, client-profile context, and the per-recipient review packet.
 * Draft approval, immutable version history, test-to-self, preflight, and real
 * send remain in the reviewed Phase 1 approve/send workspace.
 */
export function VNextOutreachPhase1Workspace(
  props: VNextOutreachOperatorWorkspaceProps,
) {
  if (props.step !== 'drafts' && props.step !== 'send') {
    return <VNextOutreachGuidedWorkspace {...props} />;
  }

  return <VNextOutreachApproveSendWorkspace {...props} />;
}

export type { Client };
