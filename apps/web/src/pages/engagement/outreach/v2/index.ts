// Barrel export so callers can import everything from a single path:
//   import { NewOutreachWizard } from '@/pages/engagement/outreach/v2'

export { NewOutreachWizard } from './NewOutreachWizard.js';
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
