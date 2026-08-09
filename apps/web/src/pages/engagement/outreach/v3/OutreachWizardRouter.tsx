import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { isEngagementPreviewActive } from '../../../../lib/engagement-api-preview.js';
import type { Client } from '../../../clients/clientTypes.js';
import type { OutreachRecord } from '../../OutreachView.js';
import {
  NewOutreachWizard as ClassicOutreachWizard,
  type OutreachSenderInbox,
} from '../v2/NewOutreachWizard.js';
import { OutreachV3Route } from './OutreachV3Route.js';
import {
  clearOutreachV3Preview,
  consumeOutreachV3PreviewActivation,
  readOutreachV3PreviewMode,
} from './outreach-v3-preview.js';

export interface OutreachWizardRouterProps {
  clients: Client[];
  selectedClientId: string | null;
  aiConfigured: boolean;
  emailConnected: boolean;
  sendFrom: string | null;
  sendableInboxes: OutreachSenderInbox[];
  onCancel: () => void;
  onComplete: () => void;
  initialRecord?: OutreachRecord | null;
  initialDraftId?: string | null;
}

/**
 * Classic Outreach remains the default and the semantic owner of every v2
 * draft. The final V3 workspace is mounted only when both explicit preview
 * switches are active and the user is starting or resuming a native V3 session.
 */
export function OutreachWizardRouter(props: OutreachWizardRouterProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const [previewMode, setPreviewMode] = useState(readOutreachV3PreviewMode);

  useEffect(() => {
    const result = consumeOutreachV3PreviewActivation(location.search);
    setPreviewMode(result.mode);
    if (!result.changed) return;
    navigate(
      {
        pathname: location.pathname,
        search: result.nextSearch,
        hash: location.hash,
      },
      { replace: true },
    );
  }, [location.hash, location.pathname, location.search, navigate]);

  const hasClassicDraft = Boolean(props.initialRecord || props.initialDraftId);
  const v3Enabled =
    previewMode === 'v3' && isEngagementPreviewActive() && !hasClassicDraft;

  if (!v3Enabled) {
    return <ClassicOutreachWizard {...props} />;
  }

  return (
    <OutreachV3Route
      clients={props.clients}
      selectedClientId={props.selectedClientId}
      onCancel={props.onCancel}
      onComplete={props.onComplete}
      onOpenClassic={() => {
        clearOutreachV3Preview();
        setPreviewMode('off');
      }}
    />
  );
}
