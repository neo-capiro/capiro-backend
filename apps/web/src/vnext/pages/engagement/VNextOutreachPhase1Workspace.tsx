import type { Client } from '../../../pages/clients/clientTypes.js';
import type { VNextOutreachOperatorWorkspaceProps } from './VNextOutreachOperatorWorkspace.js';
import { VNextOutreachApproveSendWorkspace } from './VNextOutreachApproveSendWorkspace.js';
import { VNextOutreachWorkspace } from './VNextOutreachWorkspace.js';

/**
 * The Outreach builder: canonical planning steps, then the governed draft and
 * send spine, over one session.
 *
 *   goal · targets · delivery · context · Examples (optional)   -> planning
 *   drafts · send                                               -> governed spine
 *
 * Planning is `VNextOutreachWorkspace`, which owns the seven-step rail
 * (G · T · D · C · Ex · Dr · S) and the readiness model. Draft approval,
 * immutable version history, refine, test-to-self, preflight and the durable
 * send intent stay in `VNextOutreachApproveSendWorkspace`, which is the
 * reviewed implementation of that spine and the only place send lives.
 *
 * ── Why this changed ──────────────────────────────────────────────────────
 * Planning used to route to `VNextOutreachGuidedWorkspace`, an eight-step
 * template-first flow (`template · name · content_template · format · sponsor ·
 * target · context · review`). The Engagement V2 handoff supersedes that shape
 * and restores the canonical one:
 *
 *   - campaign type and name FOLD INTO Goal (types become presets that seed
 *     retained fields — a presentation-only simplification; the Campaign Spec
 *     contract is unchanged);
 *   - Template LEAVES the wizard and is an entry choice on the home screen,
 *     which `VNextOutreachHome`'s start-campaign chooser already provides;
 *   - Format is CUT outright — it had no spec field and no endpoint;
 *   - Delivery and Examples JOIN the rail. Both already had command builders
 *     (`deliveryCommands`, `addStyleSamplesCommand`) and no reachable UI.
 *
 * `VNextOutreachWorkspace` was written to exactly that canonical model and has
 * been in the tree, fully tested, but unreachable: its only importer was
 * `VNextOutreachOperatorWorkspace`, which nothing imported in turn. This file
 * is where that dead edge was — routing it back in is the substance of the
 * rebuild, not a new implementation of it.
 *
 * `VNextOutreachOperatorWorkspace` is deliberately NOT restored as the entry
 * point. It wraps the same workspace in a Meri operator rail
 * (`outreach-meri-operator.css`, `.ov3p1-meri-rail`), and decision 4 takes Meri
 * out of Engagement. The wrapper and its CSS are left in place, unrouted,
 * pending the open question about Send Meri / Generate with Meri / Edit with
 * Meri — those are separate capabilities on real endpoints and removing the
 * rail must not silently remove them.
 */
export function VNextOutreachPhase1Workspace(
  props: VNextOutreachOperatorWorkspaceProps,
) {
  if (props.step !== 'drafts' && props.step !== 'send') {
    return <VNextOutreachWorkspace {...props} />;
  }

  return <VNextOutreachApproveSendWorkspace {...props} />;
}

export type { Client };
