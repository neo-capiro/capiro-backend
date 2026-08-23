import { useState } from 'react';
import { CapiroArrowRightIcon, CapiroCheckIcon, CapiroMailPlusIcon } from '../../components/icons/index.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroSelect, CapiroTextarea } from '../../components/fields/index.js';
import './vnext-onboarding.css';

/**
 * VNextPersonalSetupGate — the per-user email/calendar hard gate modal
 * (onboarding v1, Flow 2B.1–2B.3) for the vNext shell. Re-skin of
 * components/onboarding/PersonalSetupGate.tsx: identical phases (gate →
 * connecting → connected → optional prefs), identical copy, and the same
 * Microsoft/Google start calls driven by the host (VNextOnboardingGates) —
 * only the presentation moves to vNext tokens and primitives.
 *
 * The provider glyphs are the same plain SVGs the legacy modal uses
 * (components/onboarding/primitives.tsx) — duplicated here rather than
 * imported because that module pulls ob-overlay.css into the runtime graph.
 */

function MsGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 21 21" aria-hidden="true">
      <rect x="1" y="1" width="9" height="9" fill="#F25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
      <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
      <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
    </svg>
  );
}

function GGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.5 12.3c0-.9-.1-1.5-.3-2.2H12v4.1h6.5c-.1 1.1-.8 2.7-2.4 3.8l3.7 2.9c2.3-2.1 3.7-5.1 3.7-8.6z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.2 0 6-1.1 8-2.9l-3.8-2.9c-1 .7-2.4 1.2-4.2 1.2-3.2 0-5.9-2.1-6.9-5l-3.9 3C3.2 21.3 7.3 24 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.1 14.4c-.2-.7-.4-1.5-.4-2.4s.1-1.7.4-2.4l-4-3C.4 8.2 0 10 0 12s.4 3.8 1.2 5.4l3.9-3z"
      />
      <path
        fill="#EA4335"
        d="M12 4.7c1.8 0 3 .8 3.7 1.4l2.7-2.6C16.4 1.3 14 0 12 0 7.3 0 3.2 2.7 1.2 6.6l4 3c.9-2.8 3.6-4.9 6.8-4.9z"
      />
    </svg>
  );
}

export function VNextPersonalSetupGateModal({
  connected,
  connecting,
  email,
  tenantName,
  onConnectMicrosoft,
  onConnectGoogle,
  onContinue,
}: {
  /** The current user has at least one connected email integration. */
  connected: boolean;
  /** The Microsoft OAuth start call is in flight / redirecting. */
  connecting: boolean;
  /** Current user's email (shown in the connecting + connected phases). */
  email: string | null;
  /** Tenant display name (prefs step subtitle). */
  tenantName: string;
  onConnectMicrosoft: () => void;
  onConnectGoogle: () => void;
  /** Close the modal (Continue / Save preferences / Skip for now). */
  onContinue: () => void;
}) {
  const [prefsOpen, setPrefsOpen] = useState(false);
  const phase = !connected
    ? connecting
      ? 'connecting'
      : 'gate'
    : prefsOpen
      ? 'prefs'
      : 'connected';

  return (
    <div className="vnext-ob-scrim">
      <div className="vnext-ob-modal">
        {phase === 'gate' || phase === 'connecting' ? (
          <>
            <div className="vnext-ob-puck">
              <CapiroMailPlusIcon size={22} aria-hidden="true" />
            </div>
            <h2>One last step before you can get started</h2>
            <p
              style={{
                margin: '10px 0 4px',
                fontSize: 13.5,
                fontWeight: 600,
                color: 'var(--capiro-color-text-primary, #131a24)',
              }}
            >
              Connect your email and calendar
            </p>
            <p
              style={{
                margin: '0 0 20px',
                fontSize: 12.5,
                color: 'var(--capiro-color-text-secondary, #48525f)',
              }}
            >
              Required for all Capiro features. Takes 30 seconds.
            </p>
            {phase === 'connecting' ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 10,
                  fontSize: 13,
                  color: 'var(--capiro-color-text-secondary, #48525f)',
                  padding: '10px 0',
                }}
              >
                <span className="vnext-ob-spinner" aria-hidden="true" />
                Connecting {email ?? 'your account'}…
              </div>
            ) : (
              <div style={{ display: 'grid', gap: 10 }}>
                <CapiroButton
                  variant="secondary"
                  leadingIcon={<MsGlyph />}
                  onClick={onConnectMicrosoft}
                  style={{ width: '100%' }}
                >
                  Connect with Microsoft
                </CapiroButton>
                <CapiroButton
                  variant="secondary"
                  leadingIcon={<GGlyph />}
                  onClick={onConnectGoogle}
                  style={{ width: '100%' }}
                >
                  Connect with Google
                </CapiroButton>
              </div>
            )}
            <div
              style={{
                marginTop: 16,
                fontSize: 11.5,
                color: 'var(--capiro-color-text-muted-2, #6d7783)',
              }}
            >
              This step can't be skipped — your workspace unlocks once connected.
            </div>
          </>
        ) : phase === 'connected' ? (
          <>
            <div className="vnext-ob-puck is-success">
              <CapiroCheckIcon size={24} style={{ strokeWidth: 2.6 }} aria-hidden="true" />
            </div>
            <h2>You're connected.</h2>
            <p
              style={{
                margin: '8px 0 20px',
                fontSize: 13,
                color: 'var(--capiro-color-text-secondary, #48525f)',
              }}
            >
              <b
                style={{
                  color: 'var(--capiro-color-text-primary, #131a24)',
                  fontFamily: 'var(--capiro-type-family-mono)',
                  letterSpacing: 0,
                  fontSize: 12.5,
                }}
              >
                {email ?? 'Your account'}
              </b>
              <br />
              confirmed for email and calendar sync.
            </p>
            <CapiroButton variant="primary" onClick={onContinue} style={{ width: '100%' }}>
              Continue to Capiro
              <CapiroArrowRightIcon size={15} aria-hidden="true" />
            </CapiroButton>
            <div style={{ marginTop: 14 }}>
              <a
                href="#"
                className="vnext-ob-link"
                onClick={(e) => {
                  e.preventDefault();
                  setPrefsOpen(true);
                }}
              >
                Set personal AI preferences first
              </a>
              <span style={{ fontSize: 12, color: 'var(--capiro-color-text-muted, #616b79)' }}>
                {' '}
                · optional
              </span>
            </div>
          </>
        ) : (
          <VNextPersonalPrefs tenantName={tenantName} onDone={onContinue} />
        )}
      </div>
    </div>
  );
}

/**
 * 2B.3 — personal AI settings (skippable). Same copy and behavior as the
 * legacy PersonalPrefs: there is no trivially reusable structured personal-
 * AI-settings endpoint in apps/api today (personal Meri context lives in the
 * user's memory FILES, edited via Settings → Memory → "My files" /
 * MemoryFileEditor), so Save currently behaves like Skip.
 *
 * TODO(onboarding-v1): wire "Save preferences" to a personal AI preferences
 * endpoint once one exists (candidate: a structured field on /api/me, or a
 * writer for the user-scope memory file that Settings → Memory edits) — in
 * BOTH this modal and the legacy PersonalSetupGate.
 */
function VNextPersonalPrefs({ tenantName, onDone }: { tenantName: string; onDone: () => void }) {
  const [myTone, setMyTone] = useState('Match firm default');
  const toneOptions = [
    'Match firm default',
    'Direct and brief',
    'Warm and consultative',
    'Formal',
  ].map((value) => ({ value, label: value }));
  return (
    <div style={{ textAlign: 'left' }}>
      <h2 style={{ fontSize: 22, textAlign: 'center' }}>Personalize your Meri experience</h2>
      <p
        style={{
          margin: '8px 0 18px',
          fontSize: 12.5,
          color: 'var(--capiro-color-text-secondary, #48525f)',
          textAlign: 'center',
        }}
      >
        Layered on top of {tenantName}'s firm-wide settings.
      </p>
      <div style={{ display: 'grid', gap: 13 }}>
        <CapiroSelect
          label="Preferred tone"
          options={toneOptions}
          value={myTone}
          onChange={(e) => setMyTone(e.target.value)}
        />
        <CapiroTextarea
          label="Communication style notes"
          rows={2}
          placeholder="e.g. lead with the ask, keep briefs under 200 words"
        />
        <CapiroTextarea
          label="Any restrictions (optional)"
          rows={2}
          placeholder="Topics Meri should avoid for you"
        />
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
        <CapiroButton onClick={onDone} style={{ flex: 1 }}>
          Skip for now
        </CapiroButton>
        <CapiroButton variant="primary" onClick={onDone} style={{ flex: 1 }}>
          Save preferences
        </CapiroButton>
      </div>
    </div>
  );
}
