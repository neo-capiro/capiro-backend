/**
 * LockedFeatureNotice — inline feature-gate banner (onboarding v1, Flow 3).
 * Verbatim style port of the "Locked feature — inline gate banner" row from
 * `AppFeatureScreen` in apps/onboard-web/prototype/04-app-env3.jsx (dashed
 * border row with a lock icon).
 *
 * NOT mounted anywhere yet — this is the hook point for future trial
 * feature-gating: drop `<LockedFeatureNotice feature="Portfolio-wide
 * intelligence export" />` at the top of any surface that is
 * full-plan-only. Billing admins ("Super Admins" in onboarding-v1 copy) get
 * an Upgrade Now CTA that routes to /onboarding/subscribe; everyone else is
 * told to ask a Super Admin.
 */
import { useNavigate } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { useMe } from '../../lib/me.js';
import { ObBtn } from './primitives.js';
import './ob-overlay.css';

export function LockedFeatureNotice({ feature }: { feature: string }) {
  const me = useMe();
  const navigate = useNavigate();
  const billingAdmin = Boolean(me.data?.billingAdmin);

  return (
    <div
      className="ob-overlay"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        background: 'var(--bg-surface-2)',
        border: '1px dashed var(--border-strong)',
        borderRadius: 8,
        padding: '12px 16px',
        marginBottom: 14,
      }}
    >
      <Lock size={15} style={{ color: 'var(--ink-3)' }} />
      <div style={{ flex: 1, fontSize: 12.5, color: 'var(--ink-2)' }}>
        <b style={{ color: 'var(--ink-1)' }}>{feature}</b> — this feature is available on the full
        plan.
      </div>
      {billingAdmin ? (
        <ObBtn variant="primary" size="sm" onClick={() => navigate('/onboarding/subscribe')}>
          Upgrade Now →
        </ObBtn>
      ) : (
        <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>Ask a Super Admin to upgrade.</span>
      )}
    </div>
  );
}
