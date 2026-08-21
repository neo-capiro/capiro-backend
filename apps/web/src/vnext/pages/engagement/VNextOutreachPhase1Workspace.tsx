import type { Client } from '../../../pages/clients/clientTypes.js';
import {
  VNextOutreachOperatorWorkspace,
  type VNextOutreachOperatorWorkspaceProps,
} from './VNextOutreachOperatorWorkspace.js';
import { VNextOutreachApproveSendWorkspace } from './VNextOutreachApproveSendWorkspace.js';

/**
 * Phase 1 keeps the existing planning implementation intact and replaces only
 * the approve-and-send spine with the reviewed Outreach V3 prototype.
 *
 * The hand-off between the surfaces is explicit and reversible: Plan still
 * owns goal/targets/delivery/context/examples, while Drafts and Send use the
 * new approach review → generation → draft review → preflight → send → results
 * experience. Both surfaces operate on the same canonical session and APIs.
 */
export function VNextOutreachPhase1Workspace(
  props: VNextOutreachOperatorWorkspaceProps,
) {
  if (props.step !== 'drafts' && props.step !== 'send') {
    return <VNextOutreachOperatorWorkspace {...props} />;
  }

  return <VNextOutreachApproveSendWorkspace {...props} />;
}

export type { Client };
