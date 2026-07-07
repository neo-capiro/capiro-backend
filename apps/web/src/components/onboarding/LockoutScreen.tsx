import { useMe } from '../../lib/me.js';
import { usePortal } from '../../lib/billing.js';
import './ob-overlay.css';

/**
 * Wire/ACH lockout screen (Gherkin bridge: "the account is locked with all
 * access suspended... the firm sees a lockout screen with payment
 * instructions and a confirmation pathway"). Rendered by BillingGate INSTEAD
 * of the app shell while /api/billing/state reports locked=true; access is
 * restored automatically when onboard-api's lifecycle cron observes payment
 * (billing_status leaves past_due → locked_at cleared).
 *
 * Billing admins get the payment portal (pay the open invoice by card, or see
 * the wire instructions on the invoice itself); everyone else is pointed at
 * their billing admin. Styled with the onboarding design tokens (.ob-overlay).
 */
export function LockoutScreen() {
  const me = useMe();
  const portal = usePortal();
  const isBillingAdmin = Boolean(me.data?.billingAdmin);
  return (
    <div
      className="ob-overlay"
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        background: 'var(--bg-canvas)',
        padding: 24,
        fontFamily: 'var(--font-sans)',
      }}
    >
      <div
        style={{
          background: '#fff',
          border: '1px solid var(--border-1)',
          borderRadius: 8,
          boxShadow: '0 1px 2px rgba(21,22,26,0.04)',
          padding: '40px 36px',
          maxWidth: 460,
          width: '100%',
          textAlign: 'center',
        }}
      >
        <div
          style={{
            width: 52,
            height: 52,
            borderRadius: '50%',
            background: 'var(--critical-soft)',
            display: 'grid',
            placeItems: 'center',
            margin: '0 auto 18px',
            color: 'var(--critical)',
            fontSize: 22,
            fontWeight: 700,
          }}
        >
          !
        </div>
        <h1
          style={{
            margin: 0,
            fontFamily: 'var(--font-serif)',
            fontWeight: 500,
            fontSize: 26,
            letterSpacing: '-0.015em',
            color: 'var(--ink-1)',
          }}
        >
          Access suspended — unpaid invoice
        </h1>
        <p
          style={{
            margin: '10px 0 22px',
            fontSize: 13.5,
            color: 'var(--ink-2)',
            lineHeight: 1.6,
          }}
        >
          Your firm's Capiro invoice is past due beyond the payment window, so workspace access
          is suspended. Pay the open invoice and access is restored automatically — usually
          within the hour.
        </p>
        {isBillingAdmin ? (
          <button
            onClick={() => portal.mutate()}
            disabled={portal.isPending}
            style={{
              fontFamily: 'var(--font-sans)',
              fontSize: 13.5,
              fontWeight: 600,
              padding: '10px 20px',
              borderRadius: 6,
              cursor: portal.isPending ? 'wait' : 'pointer',
              border: '1px solid var(--accent)',
              background: 'var(--accent)',
              color: '#fff',
              width: '100%',
            }}
          >
            Open the payment portal
          </button>
        ) : (
          <div
            style={{
              fontSize: 13,
              color: 'var(--ink-2)',
              background: 'var(--bg-sunken)',
              border: '1px solid var(--border-1)',
              borderRadius: 6,
              padding: '12px 14px',
            }}
          >
            Contact your firm's billing admin to settle the invoice.
          </div>
        )}
        <p style={{ margin: '16px 0 0', fontSize: 12, color: 'var(--ink-3)', lineHeight: 1.55 }}>
          Paying by wire? The instructions are on the emailed invoice. Already paid or need
          help? <a href="mailto:support@capiro.ai" style={{ color: 'var(--accent)' }}>support@capiro.ai</a>
        </p>
      </div>
    </div>
  );
}
