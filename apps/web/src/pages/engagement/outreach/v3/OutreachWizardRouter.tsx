import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { isVNextSurface } from '../../../../env.js';
import { isEngagementPreviewActive } from '../../../../lib/engagement-api-preview.js';
import type { Client } from '../../../clients/clientTypes.js';
import type { OutreachRecord } from '../../OutreachView.js';
import {
  NewOutreachWizard as ClassicOutreachWizard,
  type OutreachSenderInbox,
} from '../v2/NewOutreachWizard.js';
import { OutreachV3CompleteRoute } from './OutreachV3CompleteRoute.js';
import {
  clearOutreachV3Preview,
  consumeOutreachV3PreviewActivation,
  readOutreachV3PreviewMode,
} from './outreach-v3-preview.js';
import { activateEngagementPreview, clearEngagementPreview } from '../../../../lib/engagement-api-preview.js';

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
 * Classic Outreach remains the semantic owner of every v2 draft. New
 * campaigns use V3 automatically on the vNext presentation; the canonical app
 * still requires both explicit preview switches. A user can deliberately fall
 * back to Classic without changing any existing draft ownership.
 */
export function OutreachWizardRouter(props: OutreachWizardRouterProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const [previewMode, setPreviewMode] = useState(readOutreachV3PreviewMode);
  const [forceClassic, setForceClassic] = useState(false);

  useEffect(() => {
    const result = consumeOutreachV3PreviewActivation(location.search);
    setPreviewMode(result.mode);
    if (result.changed) setForceClassic(result.mode === 'off');

    // Couple: activating outreach-v3-preview also activates engagement-api-preview,
    // so V3 outreach requests route through the dark engagement-api. Deactivating
    // also clears it. On vNext both are auto-on — this only affects canonical.
    if (result.changed) {
      if (result.mode === 'v3') activateEngagementPreview();
      else if (result.mode === 'off') clearEngagementPreview();
    }

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
    !forceClassic &&
    !hasClassicDraft &&
    (isVNextSurface || (previewMode === 'v3' && isEngagementPreviewActive()));

  if (!v3Enabled) {
    return <ClassicOutreachWizard {...props} />;
  }

  return (
    <OutreachV3CompleteRoute
      clients={props.clients}
      selectedClientId={props.selectedClientId}
      aiConfigured={props.aiConfigured}
      emailConnected={props.emailConnected}
      sendFrom={props.sendFrom}
      sendableInboxes={props.sendableInboxes}
      onCancel={props.onCancel}
      onComplete={props.onComplete}
      onOpenClassic={() => {
        clearOutreachV3Preview();
        setPreviewMode('off');
        setForceClassic(true);
      }}
    />
  );
}
