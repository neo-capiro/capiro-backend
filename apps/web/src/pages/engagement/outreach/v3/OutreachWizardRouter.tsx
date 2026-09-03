import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
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
  /**
   * A durable Outreach V3 session id restored from the URL (section 7 of the
   * reliability repair). When present, the V3 route resumes this exact
   * session instead of minting a new one on every reload/remount.
   */
  outreachV3SessionId?: string | null;
  /** Fired once the V3 route has a real session id (new or resumed). */
  onOutreachV3SessionReady?: (sessionId: string) => void;
}

/**
 * Classic Outreach remains the semantic owner of every v2 draft, and — as of
 * 2026-09-03 (owner decision) — is the DEFAULT on every surface, including
 * the vNext presentation. V3 renders only when both explicit preview
 * switches are active (`?outreach-v3-preview=v3`, which also couples on
 * `engagement-api-preview`), on either host. `isVNextSurface` used to be an
 * automatic V3 trigger here; it is deliberately no longer consulted so
 * os.capiro.ai and app.capiro.ai route identically. A user can still
 * deliberately fall back to Classic from V3 without changing any existing
 * draft ownership.
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
    // also clears it. (On os.capiro.ai the engagement-api header is attached
    // regardless via ENGAGEMENT_API_FULL_OWNERSHIP — see engagement-api-preview.ts —
    // so this coupling is observable only on the canonical host.)
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
    !forceClassic && !hasClassicDraft && previewMode === 'v3' && isEngagementPreviewActive();

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
      sessionId={props.outreachV3SessionId}
      onSessionReady={props.onOutreachV3SessionReady}
      onOpenClassic={() => {
        clearOutreachV3Preview();
        setPreviewMode('off');
        setForceClassic(true);
      }}
    />
  );
}
