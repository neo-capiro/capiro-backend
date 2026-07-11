/**
 * TrialBanner — persistent free-trial strip (onboarding v1, Flow 3).
 * Verbatim style port of `TrialBanner` from
 * apps/onboard-web/prototype/04-app-env3.jsx, rendered under the app top bar
 * on every authenticated screen.
 *
 * Renders ONLY when the tenant is onboarding-v1 (`onboardingFlowVersion ===
 * 1`) AND `status === 'trialing'` — legacy tenants and any billing-state
 * error render nothing (fail-open, zero change).
 */
import { useNavigate } from 'react-router-dom';
import { Hourglass } from 'lucide-react';
import { useBillingState } from '../../lib/billing.js';
import { useMe } from '../../lib/me.js';
import './ob-overlay.css';

export function TrialBanner() {
  const billing = useBillingState();
  const me = useMe();
  const navigate = useNavigate();

  const state = billing.data;
  if (!state || state.onboardingFlowVersion !== 1 || state.status !== 'trialing') return null;

  const daysRemaining = state.trialEndsAt
    ? Math.ceil((new Date(state.trialEndsAt).getTime() - Date.now()) / 86_400_000)
    : null;
  const billingAdmin = Boolean(me.data?.billingAdmin);

  return (
    <div
      className="ob-overlay"
      style={{
        background: 'var(--notable-soft)',
        borderBottom: '1px solid rgba(162,105,19,0.25)',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '6px 20px',
        flexShrink: 0,
      }}
    >
      <Hourglass size={13} style={{ color: 'var(--notable)' }} />
      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--notable)' }}>
        Free trial ·{' '}
        {daysRemaining !== null
          ? `${daysRemaining} days remaining`
          : 'Trial starts when setup completes'}{' '}
        ·{' '}
        <span style={{ fontFamily: 'var(--font-mono)', letterSpacing: 0 }}>
          {state.usedSlots}/{state.slots}
        </span>{' '}
        client profiles used
      </span>
      <span style={{ flex: 1 }}></span>
      {billingAdmin ? (
        <button
          type="button"
          onClick={() => navigate('/onboarding/subscribe')}
          style={{
            fontFamily: 'var(--font-sans)',
            fontSize: 11.5,
            fontWeight: 700,
            color: '#fff',
            background: 'var(--notable)',
            border: 'none',
            borderRadius: 5,
            padding: '4px 12px',
            cursor: 'pointer',
          }}
        >
          Upgrade Now
        </button>
      ) : (
        <span style={{ fontSize: 11.5, color: 'var(--notable)' }}>
          Contact your Super Admin to upgrade.
        </span>
      )}
    </div>
  );
}
