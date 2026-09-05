// Step 2, Campaign Setup.
//
// Outreach 2.0 has a single campaign type, so setup is down to one field:
// the campaign name. Continue is gated on a non-empty name (see canAdvance
// in NewOutreachWizard). `clientId` stays in wizard state as an optional
// association with no UI on this step. Presentation rebuilt onto Tailwind +
// React Aria per the real migration (handover §0, §6.5); the field itself
// and its wiring are unchanged.
import './ui/tailwind.css';
import { Input } from './ui/Input.js';

interface Props {
  campaignName: string;
  onName: (name: string) => void;
}

export function StepCampaignSetup({ campaignName, onName }: Props) {
  return (
    <div className="ov2-tw-root">
      <h2 className="text-[22px] leading-7 font-bold tracking-[-0.02em] text-ink-primary">
        Name your campaign
      </h2>
      <div className="mt-1.5 mb-5 text-sm leading-5 text-ink-secondary">
        A working name for this outreach — it appears in your drafts and reports, never to
        recipients.
      </div>
      <Input
        id="ov2-campaign-name"
        autoFocus
        value={campaignName}
        onChange={onName}
        placeholder="e.g. FY27 NDAA, Section 218 push"
        label="Campaign name"
        height={40}
      />
    </div>
  );
}
