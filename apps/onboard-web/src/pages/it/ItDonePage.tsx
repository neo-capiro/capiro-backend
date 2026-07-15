// IT Admin terminal page: the 'done' phase of the prototype ItAdminView,
// standalone — the Microsoft consent callback 302s to /it/done.
import { Card, Icon } from '../../ui/primitives';
import { ExtShell } from '../setup/ExtShell';

/** The prototype ItAdminView 'done' phase card (shared with /it/:token). */
export function ItConnectionVerifiedCard() {
  return (
    <div style={{ maxWidth: 480, margin: '40px auto 0' }}>
      <Card style={{ textAlign: 'center', padding: '40px 36px' }}>
        <div
          style={{
            width: 52,
            height: 52,
            borderRadius: '50%',
            background: 'var(--success-soft)',
            display: 'grid',
            placeItems: 'center',
            margin: '0 auto 18px',
          }}
        >
          <Icon name="Check" size={25} strokeWidth={2.6} style={{ color: 'var(--success)' }} />
        </div>
        <h1
          style={{
            margin: 0,
            fontFamily: 'var(--font-serif)',
            fontWeight: 500,
            fontSize: 25,
            letterSpacing: '-0.015em',
          }}
        >
          Connection verified
        </h1>
        <p style={{ margin: '10px 0 0', fontSize: 13.5, color: 'var(--ink-2)', lineHeight: 1.6 }}>
          Your team can now connect their individual email and calendar.
          <br />
          <br />
          <b style={{ color: 'var(--ink-1)' }}>You're all set — no further action needed.</b>
        </p>
      </Card>
    </div>
  );
}

export function ItDonePage() {
  return (
    <ExtShell>
      <ItConnectionVerifiedCard />
    </ExtShell>
  );
}

/** Shown after the admin defers Google verification (skip-google). Distinct
 *  from the verified card — nothing is actually connected yet, and the same
 *  link stays open to finish later. */
export function ItConnectionSkippedCard() {
  return (
    <div style={{ maxWidth: 480, margin: '40px auto 0' }}>
      <Card style={{ textAlign: 'center', padding: '40px 36px' }}>
        <div
          style={{
            width: 52,
            height: 52,
            borderRadius: '50%',
            background: 'var(--notable-soft)',
            display: 'grid',
            placeItems: 'center',
            margin: '0 auto 18px',
          }}
        >
          <Icon name="Clock" size={23} style={{ color: 'var(--notable)' }} />
        </div>
        <h1
          style={{
            margin: 0,
            fontFamily: 'var(--font-serif)',
            fontWeight: 500,
            fontSize: 25,
            letterSpacing: '-0.015em',
          }}
        >
          Verification deferred
        </h1>
        <p style={{ margin: '10px 0 0', fontSize: 13.5, color: 'var(--ink-2)', lineHeight: 1.6 }}>
          No problem — your firm's setup can continue without this. Reopen this same link anytime to
          verify Google Workspace access when you're ready.
        </p>
      </Card>
    </div>
  );
}
