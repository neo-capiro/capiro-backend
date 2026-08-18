// Entry point kept for import stability: the canonical router
// (CurrentDecisionSurface.tsx) imports TargetWorkspace through here. The
// stylesheet attachment that used to live in this file (target-workspace.css)
// moved to OutreachV3Route.tsx with the rest of the outreach-v3 stylesheets,
// so the component graph itself stays css-free and the vNext Engagement
// surface can reuse it without a runtime dependency on legacy-design-system
// css (its scoped port lives at
// vnext/pages/engagement/outreach-decision-vnext.css).

export { TargetWorkspace } from './TargetWorkspace.js';
export type { TargetWorkspaceProps } from './TargetWorkspace.js';
