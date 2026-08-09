// Stable barrel export for the Engagement page.
//
// NewOutreachWizard is now a fail-closed router: Classic Outreach remains the
// default, while the native V3 workspace requires both explicit preview modes.
// Existing v2 drafts always open with ClassicOutreachWizard because semantic
// conversion is not implemented.

export { OutreachWizardRouter as NewOutreachWizard } from '../v3/OutreachWizardRouter.js';
export { NewOutreachWizard as ClassicOutreachWizard } from './NewOutreachWizard.js';
export { StepCampaignSetup } from './StepCampaignSetup.js';
export { StepDirectionLanding } from './StepDirectionLanding.js';
export { StepRecipientsSelect } from './StepRecipientsSelect.js';
export { StepGenerate } from './StepGenerate.js';
export {
  flattenTargets,
  individualTarget,
  membershipOf,
  totalRecipients,
  type OutreachTarget,
  type TargetType,
} from './targets.js';
export { StepContext } from './StepContext.js';
export {
  WIZARD_STEPS,
  INITIAL_V2_STATE,
  recipientKey,
  type WizardDirection,
  type WizardV2State,
  type WizardStepId,
  type ContextKind,
  type ContextPoolItem,
  type SelectedContextItem,
} from './types.js';
