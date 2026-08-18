import { useNavigate } from 'react-router-dom';
import { Hourglass } from 'lucide-react';
import { useBillingState } from '../../../lib/billing.js';
import { useMe } from '../../../lib/me.js';
import './vnext-onboarding.css';

/**
 * VNextTrialBanner — persistent free-trial strip (onboarding v1, Flow 3) for
 * the vNext shell. Re-skin of components/onboarding/TrialBanner.tsx: the
 * render condition (`onboardingFlowVersion === 1` AND `status === 'trialing'`,
 * fail-open on any billing-state error), the day-count math, the slots copy
 * and the billing-admin gate on "Upgrade Now" are identical — only the
 * presentation moves from the prototype's ob-overlay tokens to vNext tokens.
 */
export function VNextTrialBanner() {
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
    <div className="vnext-ob-trial">
      <Hourglass size={13} aria-hidden="true" />
      <span className="vnext-ob-trial-copy">
        Free trial ·{' '}
        {daysRemaining !== null
          ? `${daysRemaining} days remaining`
          : 'Trial starts when setup completes'}{' '}
        · <span className="vnext-ob-mono">{state.usedSlots}/{state.slots}</span> client profiles
        used
      </span>
      <span style={{ flex: 1 }} />
      {billingAdmin ? (
        <button
          type="button"
          className="vnext-ob-trial-upgrade"
          onClick={() => navigate('/onboarding/subscribe')}
        >
          Upgrade Now
        </button>
      ) : (
        <span className="vnext-ob-trial-note">Contact your Super Admin to upgrade.</span>
      )}
    </div>
  );
}
