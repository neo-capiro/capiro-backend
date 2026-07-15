/**
 * PersonalSetupGate — the per-user email/calendar hard gate modal (onboarding
 * v1, Flow 2B.1–2B.3). Pixel port of `PersonalSetupGate` + `PersonalPrefs`
 * from apps/onboard-web/prototype/04-app-env3.jsx: style objects are copied
 * verbatim. The prototype rendered its own dimmed AppFrame behind the modal;
 * here OnboardingGates dims the real app content and mounts only this fixed
 * overlay. The overlay z-index is raised from the prototype's 50 so it sits
 * above the app chrome (chat FAB is z-index 998).
 *
 * Phases: gate → connecting (redirecting to the Microsoft or Google OAuth
 * consent screen) → connected (after the OAuth return finds a connected
 * integration) → optional prefs step. Both providers use the same engagement
 * integration Settings → Integrations already exposes (POST
 * .../integrations/{microsoft,google}/start).
 */
import { useState } from 'react';
import { ArrowRight, Check, MailPlus } from 'lucide-react';
import {
  GGlyph,
  MsGlyph,
  ObBtn,
  ObField,
  ObSelectInput,
  ObSpinner,
  obInputStyle,
} from './primitives.js';

export function PersonalSetupGateModal({
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
    <div
      className="ob-overlay"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(12,26,56,0.5)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 1200,
        padding: 24,
      }}
    >
      <div
        style={{
          background: '#fff',
          borderRadius: 10,
          width: '100%',
          maxWidth: 440,
          boxShadow: '0 18px 50px rgba(12,26,56,0.35)',
          padding: '36px 34px',
          textAlign: 'center',
        }}
      >
        {phase === 'gate' || phase === 'connecting' ? (
          <>
            <div
              style={{
                width: 50,
                height: 50,
                borderRadius: '50%',
                background: 'var(--accent-soft)',
                display: 'grid',
                placeItems: 'center',
                margin: '0 auto 16px',
              }}
            >
              <MailPlus size={22} style={{ color: 'var(--accent)' }} />
            </div>
            <h2
              style={{
                margin: 0,
                fontFamily: 'var(--font-serif)',
                fontWeight: 500,
                fontSize: 23,
                letterSpacing: '-0.015em',
              }}
            >
              One last step before you can get started
            </h2>
            <p
              style={{
                margin: '10px 0 4px',
                fontSize: 13.5,
                fontWeight: 600,
                color: 'var(--ink-1)',
              }}
            >
              Connect your email and calendar
            </p>
            <p style={{ margin: '0 0 20px', fontSize: 12.5, color: 'var(--ink-2)' }}>
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
                  color: 'var(--ink-2)',
                  padding: '10px 0',
                }}
              >
                <ObSpinner size={16} />
                Connecting {email ?? 'your account'}…
              </div>
            ) : (
              <div style={{ display: 'grid', gap: 10 }}>
                <ObBtn
                  variant="secondary"
                  size="lg"
                  onClick={onConnectMicrosoft}
                  style={{ width: '100%' }}
                >
                  <MsGlyph /> Connect with Microsoft
                </ObBtn>
                <ObBtn
                  variant="secondary"
                  size="lg"
                  onClick={onConnectGoogle}
                  style={{ width: '100%' }}
                >
                  <GGlyph /> Connect with Google
                </ObBtn>
              </div>
            )}
            <div style={{ marginTop: 16, fontSize: 11.5, color: 'var(--ink-4)' }}>
              This step can't be skipped — your workspace unlocks once connected.
            </div>
          </>
        ) : phase === 'connected' ? (
          <>
            <div
              style={{
                width: 50,
                height: 50,
                borderRadius: '50%',
                background: 'var(--success-soft)',
                display: 'grid',
                placeItems: 'center',
                margin: '0 auto 16px',
              }}
            >
              <Check size={24} strokeWidth={2.6} style={{ color: 'var(--success)' }} />
            </div>
            <h2
              style={{
                margin: 0,
                fontFamily: 'var(--font-serif)',
                fontWeight: 500,
                fontSize: 24,
                letterSpacing: '-0.015em',
              }}
            >
              You're connected.
            </h2>
            <p style={{ margin: '8px 0 20px', fontSize: 13, color: 'var(--ink-2)' }}>
              <b
                style={{
                  color: 'var(--ink-1)',
                  fontFamily: 'var(--font-mono)',
                  letterSpacing: 0,
                  fontSize: 12.5,
                }}
              >
                {email ?? 'Your account'}
              </b>
              <br />
              confirmed for email and calendar sync.
            </p>
            <ObBtn
              variant="primary"
              onClick={onContinue}
              icon={ArrowRight}
              style={{ width: '100%' }}
            >
              Continue to Capiro
            </ObBtn>
            <div style={{ marginTop: 14 }}>
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  setPrefsOpen(true);
                }}
                style={{ fontSize: 12.5, color: 'var(--accent)', fontWeight: 600 }}
              >
                Set personal AI preferences first
              </a>
              <span style={{ fontSize: 12, color: 'var(--ink-3)' }}> · optional</span>
            </div>
          </>
        ) : (
          <PersonalPrefs tenantName={tenantName} onDone={onContinue} />
        )}
      </div>
    </div>
  );
}

/**
 * 2B.3 — personal AI settings (skippable). Verbatim port of the prototype's
 * `PersonalPrefs`. There is no trivially reusable structured personal-AI-
 * settings endpoint in apps/api today (personal Meri context lives in the
 * user's memory FILES, edited via Settings → Memory → "My files" /
 * MemoryFileEditor), so Save currently behaves like Skip.
 *
 * TODO(onboarding-v1): wire "Save preferences" to a personal AI preferences
 * endpoint once one exists (candidate: a structured field on /api/me, or a
 * writer for the user-scope memory file that Settings → Memory edits).
 */
function PersonalPrefs({ tenantName, onDone }: { tenantName: string; onDone: () => void }) {
  const [myTone, setMyTone] = useState('Match firm default');
  return (
    <div style={{ textAlign: 'left' }}>
      <h2
        style={{
          margin: 0,
          fontFamily: 'var(--font-serif)',
          fontWeight: 500,
          fontSize: 22,
          letterSpacing: '-0.015em',
          textAlign: 'center',
        }}
      >
        Personalize your Meri experience
      </h2>
      <p
        style={{ margin: '8px 0 18px', fontSize: 12.5, color: 'var(--ink-2)', textAlign: 'center' }}
      >
        Layered on top of {tenantName}'s firm-wide settings.
      </p>
      <div style={{ display: 'grid', gap: 13 }}>
        <ObField label="Preferred tone">
          <ObSelectInput
            options={['Match firm default', 'Direct and brief', 'Warm and consultative', 'Formal']}
            value={myTone}
            onChange={setMyTone}
          />
        </ObField>
        <ObField label="Communication style notes">
          <textarea
            rows={2}
            style={{ ...obInputStyle, resize: 'vertical' }}
            placeholder="e.g. lead with the ask, keep briefs under 200 words"
          ></textarea>
        </ObField>
        <ObField label="Any restrictions" optional>
          <textarea
            rows={2}
            style={{ ...obInputStyle, resize: 'vertical' }}
            placeholder="Topics Meri should avoid for you"
          ></textarea>
        </ObField>
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
        <ObBtn onClick={onDone} style={{ flex: 1 }}>
          Skip for now
        </ObBtn>
        <ObBtn variant="primary" onClick={onDone} style={{ flex: 1 }}>
          Save preferences
        </ObBtn>
      </div>
    </div>
  );
}
