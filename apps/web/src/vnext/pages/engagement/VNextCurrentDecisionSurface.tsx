import {
  CurrentDecisionSurface,
  type CurrentDecisionSurfaceProps,
} from '../../../pages/engagement/outreach/v3/CurrentDecisionSurface.js';
// The vNext-token styling for the whole decision-surface subtree (Proposal /
// Goal / Sponsor / Targets / Context / Delivery). This scoped port replaces
// the four legacy outreach-v3 stylesheets the surface used to reach —
// outreach-v3.css + planning-surfaces.css (raw imports in
// VNextOutreachWorkspace) and context-review-surface.css +
// target-workspace.css (transitively through the canonical router) — see the
// generated file's header for the exact transform and cascade guarantees.
import './outreach-decision-vnext.css';

export type { CurrentDecisionSurfaceProps };

/**
 * vNext (os.capiro.ai) variant of the Outreach V3 decision router: same
 * props, same behavior — the routing/stage implementation IS the canonical
 * `CurrentDecisionSurface`, whose component graph is deliberately css-free
 * (its canonical stylesheets are attached by OutreachV3Route.tsx instead) —
 * with the vNext-token stylesheet attached in its place. Rendered inside the
 * `.capiro-vnext-root .engagement-vnext` wrapper (both the standalone
 * /engagement/outreach route and the canonical OutreachV3CompleteRoute
 * adapter provide it), where outreach-body-vnext.css maps every consumed
 * `--ov3-*` token onto the module's navy `--eng-*` palette.
 */
export function VNextCurrentDecisionSurface(props: CurrentDecisionSurfaceProps) {
  return <CurrentDecisionSurface {...props} />;
}
