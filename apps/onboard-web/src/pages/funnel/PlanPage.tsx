// 1.4 Plan Selection — F1Plan (prototype/02-flow1.jsx). Subscribe is the main
// CTA; trial is a quiet nudge below. Paid bullets carry the price-lock copy
// (decision Q2); PRICE_LOCK_COPY/PRICE_CHANGE_COPY end with a period in
// @capiro/shared, so the period-free bullet variants are inlined verbatim.
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Btn, FunnelShell, OptionCard, ScreenTitle, Tag } from '../../ui/primitives';
import {
  useAdvanceSession,
  useFunnelApi,
  useFunnelSession,
  type FunnelSession,
  type PlanChoice,
} from '../../lib/funnel';
import { ErrorText, errorMessage } from './shared';

export function PlanPage() {
  const session = useFunnelSession();
  if (!session.data) return null;
  return <PlanForm session={session.data} />;
}

function PlanForm({ session }: { session: FunnelSession }) {
  const navigate = useNavigate();
  const api = useFunnelApi();
  const advanceSession = useAdvanceSession();
  const [plan, setPlan] = React.useState<PlanChoice | null>(session.plan ?? null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    if (!plan || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.setPlan(plan);
      advanceSession({ state: 'plan_selected', plan });
      navigate('/legal');
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <FunnelShell step={2} maxWidth={560}>
      <ScreenTitle title="Choose how to start" />
      <OptionCard
        selected={plan === 'paid'}
        onClick={() => setPlan('paid')}
        title="Subscribe Now"
        badge={<Tag tone="blue">Recommended</Tag>}
        price="$200 / profile · billed monthly · 10-profile minimum ($2,000/month)"
      >
        Choose your client profile tier and get started with your full portfolio from day one.
        <ul style={{ margin: '10px 0 0', padding: '0 0 0 16px', display: 'grid', gap: 4 }}>
          <li>Limited-time price — lock in $200/profile for 2 years</li>
          <li>Pay by card, wire, or ACH</li>
          <li>Volume discounts available for large accounts — contact sales</li>
          <li>
            Your price is locked for 24 months from subscription; thereafter prices are subject to
            change
          </li>
        </ul>
      </OptionCard>
      <div
        onClick={() => setPlan('trial')}
        style={{
          display: 'flex',
          gap: 10,
          alignItems: 'flex-start',
          cursor: 'pointer',
          marginTop: 14,
          padding: '12px 16px',
          borderRadius: 8,
          border:
            plan === 'trial' ? '1.5px solid var(--border-strong)' : '1px dashed var(--border-2)',
          background: plan === 'trial' ? 'var(--bg-surface-2)' : 'transparent',
        }}
      >
        <span
          style={{
            width: 14,
            height: 14,
            borderRadius: '50%',
            flexShrink: 0,
            marginTop: 2,
            border:
              plan === 'trial' ? '4.5px solid var(--ink-2)' : '1.5px solid var(--border-strong)',
            background: '#fff',
          }}
        ></span>
        <div style={{ fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.55 }}>
          <b style={{ color: 'var(--ink-1)' }}>Just exploring? Start with a 30-day free trial.</b>
          <br />
          $0 today · 10 client profile limit · no user cap · converts to a subscription on day 31
          unless you cancel.
        </div>
      </div>
      {error && <ErrorText style={{ textAlign: 'right' }}>{error}</ErrorText>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
        <Btn variant="primary" disabled={!plan || busy} onClick={() => void submit()}>
          Continue
        </Btn>
      </div>
    </FunnelShell>
  );
}
