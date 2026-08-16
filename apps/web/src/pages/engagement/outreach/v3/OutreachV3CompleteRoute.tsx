import { useMemo, useState } from 'react';
import { ArrowLeft, Check, ExternalLink } from 'lucide-react';
import type { Client } from '../../../clients/clientTypes.js';
import type { OutreachSenderInbox } from '../v2/NewOutreachWizard.js';
import {
  VNextOutreachWorkspace,
  type EngagementOutreachStep,
} from '../../../../vnext/pages/engagement/VNextOutreachWorkspace.js';
import '../../../../vnext/pages/engagement/engagement.css';
import '../../../../vnext/pages/engagement/engagement-ui-closeout.css';

export interface OutreachV3CompleteRouteProps {
  clients: Client[];
  selectedClientId: string | null;
  aiConfigured: boolean;
  emailConnected: boolean;
  sendFrom: string | null;
  sendableInboxes: OutreachSenderInbox[];
  onCancel: () => void;
  onComplete: () => void;
  onOpenClassic: () => void;
}

function normalizeProvider(provider: string): string {
  const value = provider.trim().toLowerCase();
  if (['microsoft', 'microsoft_365', 'office365', 'outlook'].includes(value)) {
    return 'microsoft_365';
  }
  if (['google', 'google_workspace', 'gmail'].includes(value)) {
    return 'google_workspace';
  }
  return value;
}

/**
 * Canonical Engagement host for the completed Outreach V3 workbench.
 *
 * Meetings and Reports remain rendered by EngagementPage on both domains. Only
 * a new native V3 campaign enters this adapter; existing V2 records remain in
 * Classic Outreach through OutreachWizardRouter.
 */
export function OutreachV3CompleteRoute({
  clients,
  selectedClientId,
  aiConfigured,
  emailConnected,
  sendFrom,
  sendableInboxes,
  onCancel,
  onComplete,
  onOpenClassic,
}: OutreachV3CompleteRouteProps) {
  const [step, setStep] = useState<EngagementOutreachStep>('goal');
  const integrations = useMemo(
    () =>
      sendableInboxes.map((inbox) => ({
        id: inbox.id,
        provider: normalizeProvider(inbox.provider),
        status: 'connected',
        accountEmail: inbox.accountEmail,
        displayName: inbox.displayName,
      })),
    [sendableInboxes],
  );

  const connectionWarning = !emailConnected
    ? 'Connect Outlook or Gmail before test or real sending.'
    : integrations.length === 0
      ? `No sendable mailbox was returned${sendFrom ? ` for ${sendFrom}` : ''}.`
      : null;

  return (
    <div className="capiro-vnext-root outreach-v3-complete-host">
      <section className="engagement-vnext">
        <header className="outreach-v3-route-toolbar">
          <button type="button" className="outreach-v3-route-toolbar__back" onClick={onCancel}>
            <ArrowLeft size={15} />
            Outreach
          </button>
          <div className="outreach-v3-route-toolbar__copy">
            <strong>New governed campaign</strong>
            <span>Goal · targets · delivery · context · immutable drafts · preflight · send</span>
          </div>
          <span className="outreach-v3-route-toolbar__spacer" />
          <div className="outreach-v3-route-toolbar__status">
            {!aiConfigured ? (
              <span className="uui-state-pill" data-tone="warning">
                AI provider required
              </span>
            ) : null}
            {connectionWarning ? (
              <span className="uui-state-pill" data-tone="warning" title={connectionWarning}>
                Mailbox review
              </span>
            ) : null}
            <button
              type="button"
              className="outreach-v3-route-toolbar__secondary"
              onClick={onOpenClassic}
            >
              <ExternalLink size={14} />
              Classic Outreach
            </button>
            <button
              type="button"
              className="outreach-v3-route-toolbar__primary"
              onClick={onComplete}
            >
              <Check size={15} />
              Done
            </button>
          </div>
        </header>
        <VNextOutreachWorkspace
          clients={clients}
          selectedClientId={selectedClientId}
          integrations={integrations}
          step={step}
          onStepChange={setStep}
        />
      </section>
    </div>
  );
}
