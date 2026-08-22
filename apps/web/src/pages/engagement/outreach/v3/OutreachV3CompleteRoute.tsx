import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowLeft, Check, ExternalLink } from 'lucide-react';
import { useApi } from '../../../../lib/use-api.js';
import type { Client } from '../../../clients/clientTypes.js';
import { createOutreachV3Session, safeOutreachV3Error } from './outreach-v3-api.js';
import type { OutreachSenderInbox } from '../v2/NewOutreachWizard.js';
import { VNextOutreachPhase1Workspace } from '../../../../vnext/pages/engagement/VNextOutreachPhase1Workspace.js';
import type { EngagementOutreachStep } from '../../../../vnext/pages/engagement/VNextOutreachWorkspace.js';
import '../../../../vnext/pages/engagement/engagement.css';
import '../../../../vnext/pages/engagement/engagement-ui-closeout.css';
import '../../../../vnext/pages/engagement/engagement-tones.css';

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
 * Canonical Engagement host for a new Outreach V3 campaign.
 *
 * This adapter now mounts the same template-first setup and governed
 * draft/test/send spine as the vNext Outreach route. Existing V2 records remain
 * in Classic Outreach through OutreachWizardRouter.
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
  const api = useApi();
  const [step, setStep] = useState<EngagementOutreachStep>('goal');

  /**
   * This host owns session creation. `staleTime: Infinity` prevents a focus
   * refetch from silently creating a second campaign, while `gcTime: 0` makes
   * an explicit return to this route start a genuinely new campaign.
   */
  const session = useQuery({
    queryKey: ['outreach-v3', 'complete-route-session'],
    queryFn: () => createOutreachV3Session(api, 'New outreach campaign'),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: false,
  });
  const restart = useMutation({
    mutationFn: () => session.refetch({ throwOnError: false }),
  });

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
          <button
            type="button"
            className="outreach-v3-route-toolbar__back"
            onClick={onCancel}
          >
            <ArrowLeft size={15} />
            Outreach
          </button>
          <div className="outreach-v3-route-toolbar__copy">
            <strong>New governed campaign</strong>
            <span>
              Workflow · name · sponsor · Directory targets · client context ·
              review · drafts · test · send
            </span>
          </div>
          <span className="outreach-v3-route-toolbar__spacer" />
          <div className="outreach-v3-route-toolbar__status">
            {!aiConfigured ? (
              <span className="uui-state-pill" data-tone="warning">
                AI provider required
              </span>
            ) : null}
            {connectionWarning ? (
              <span
                className="uui-state-pill"
                data-tone="warning"
                title={connectionWarning}
              >
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
        {session.data ? (
          <VNextOutreachPhase1Workspace
            sessionId={session.data.session.id}
            clients={clients}
            selectedClientId={selectedClientId}
            integrations={integrations}
            step={step}
            onStepChange={setStep}
            onExit={onCancel}
          />
        ) : session.isError ? (
          <div className="uui-engagement-error" role="alert">
            <strong>The campaign workspace could not be created</strong>
            <p>{safeOutreachV3Error(session.error)}</p>
            <div className="uui-engagement-error__actions">
              <button
                type="button"
                className="uui-button"
                onClick={onOpenClassic}
              >
                Open Classic Outreach
              </button>
              <button
                type="button"
                className="uui-button--primary"
                disabled={restart.isPending || session.isFetching}
                onClick={() => restart.mutate()}
              >
                Try again
              </button>
            </div>
          </div>
        ) : (
          <div className="uui-outreach-loading" aria-busy="true">
            <div className="uui-canvas-skeleton">
              <i />
              <i />
              <i />
              <i />
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
