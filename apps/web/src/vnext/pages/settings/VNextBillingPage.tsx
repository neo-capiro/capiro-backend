/**
 * vNext re-skin of pages/admin/BillingPage.tsx — identical hooks (useBilling /
 * usePortal), status vocabulary, thresholds and copy; presentation on the
 * vNext primitives.
 */
import { useNavigate } from 'react-router-dom';
import type { BillingStatus } from '@capiro/shared';
import { useBilling, usePortal } from '../../../lib/billing.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge, type CapiroBadgeTone } from '../../components/badges/index.js';
import { CapiroSkeleton } from '../../components/feedback/index.js';
import { SvCallout, SvCard, SvProgress, SvStat } from './settings-ui.js';

const STATUS_TAG: Record<BillingStatus, { tone: CapiroBadgeTone; label: string }> = {
  none: { tone: 'neutral', label: 'Not subscribed' },
  trialing: { tone: 'info', label: 'Trialing' },
  active: { tone: 'success', label: 'Active' },
  past_due: { tone: 'danger', label: 'Past due' },
  canceled: { tone: 'danger', label: 'Canceled' },
  comped: { tone: 'warning', label: 'Complimentary' },
};

const money = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

export function VNextBillingPage() {
  const navigate = useNavigate();
  const billing = useBilling();
  const portal = usePortal();

  if (billing.isError) {
    return (
      <SvCard title="Billing">
        <SvCallout
          kind="warning"
          title="Billing isn't available for your account"
          description="Only tenant admins can view billing. If you are an admin and still see this, billing may not be configured on this environment yet."
        />
      </SvCard>
    );
  }

  const s = billing.data;

  // Billing dormant on this environment (Stripe not configured) — no paywall,
  // no plan to manage yet.
  if (s && !s.billingEnabled) {
    return (
      <SvCard title="Billing">
        <SvCallout
          kind="info"
          title="Billing isn't enabled yet"
          description="Subscriptions and usage billing will appear here once billing is turned on for your account."
        />
      </SvCard>
    );
  }

  const status = s?.status ?? 'none';
  const tag = STATUS_TAG[status];
  const monthly = s ? s.slots * s.pricePerSlotUsd : 0;
  const usagePct =
    s && s.llmAllowanceUsd > 0 ? Math.min(100, (s.llmUsedUsd / s.llmAllowanceUsd) * 100) : 0;
  const slotsPct = s && s.slots > 0 ? Math.min(100, (s.usedSlots / s.slots) * 100) : 0;
  const notSubscribed = status === 'none' || status === 'canceled';

  if (billing.isLoading) {
    return (
      <SvCard title="Billing & plan" aria-label="Loading billing">
        <div className="stv-stack">
          <CapiroSkeleton height={24} width="30%" />
          <CapiroSkeleton height={16} />
          <CapiroSkeleton height={16} width="70%" />
        </div>
      </SvCard>
    );
  }

  return (
    <div className="stv-stack">
      <SvCard title="Billing & plan" extra={<CapiroBadge tone={tag.tone}>{tag.label}</CapiroBadge>}>
        <div className="stv-stack">
          {status === 'past_due' && (
            <SvCallout
              kind="error"
              title="Your last payment failed"
              description="Update your payment method to avoid losing access."
            />
          )}
          {notSubscribed ? (
            <>
              <p style={{ margin: 0 }}>
                {status === 'canceled'
                  ? 'Your subscription is canceled. Resubscribe to continue adding clients.'
                  : "You haven't subscribed yet."}
              </p>
              <div className="stv-row">
                <CapiroButton variant="primary" onClick={() => navigate('/onboarding/subscribe')}>
                  Choose a plan
                </CapiroButton>
              </div>
            </>
          ) : (
            <>
              <div className="stv-grid-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
                <div className="stv-stack--tight stv-stack">
                  <SvStat label="Client slots" value={`${s?.usedSlots ?? 0} / ${s?.slots ?? 0}`} />
                  <SvProgress percent={Math.round(slotsPct)} label="Client slots used" />
                </div>
                <SvStat label="Price / slot" value={money(s?.pricePerSlotUsd ?? 0)} />
                <SvStat label="Monthly (slots)" value={money(monthly)} />
                <SvStat
                  label="Renews"
                  value={s?.currentPeriodEnd ? new Date(s.currentPeriodEnd).toLocaleDateString() : '—'}
                />
              </div>
              <div className="stv-row">
                <CapiroButton variant="primary" loading={portal.isPending} onClick={() => portal.mutate()}>
                  Manage billing & payment
                </CapiroButton>
                <CapiroButton loading={portal.isPending} onClick={() => portal.mutate()}>
                  Add client slots
                </CapiroButton>
              </div>
            </>
          )}
        </div>
      </SvCard>

      {!notSubscribed && (
        <SvCard title="AI usage this period">
          <div className="stv-stack">
            {s?.llmWarn && (
              <SvCallout
                kind="warning"
                title="Approaching your AI usage allowance"
                description="Usage beyond your included allowance is billed at 2× cost."
              />
            )}
            <div className="stv-grid-2">
              <div className="stv-stack stv-stack--tight">
                <span className="stv-muted">
                  {money(s?.llmUsedUsd ?? 0)} used of {money(s?.llmAllowanceUsd ?? 0)} included
                </span>
                <SvProgress
                  percent={Math.round(usagePct)}
                  tone={usagePct >= 100 ? 'danger' : undefined}
                  label="AI usage against allowance"
                />
              </div>
              <SvStat label="Billable overage" value={money(s?.llmOverageUsd ?? 0)} />
            </div>
            <p className="stv-muted stv-small" style={{ margin: 0 }}>
              Allowance is $20 per client slot per month, pooled across your team. Detailed usage is
              on the{' '}
              <a
                href="/settings/ai-usage"
                onClick={(event) => {
                  event.preventDefault();
                  navigate('/settings/ai-usage');
                }}
              >
                AI Usage
              </a>{' '}
              tab.
            </p>
          </div>
        </SvCard>
      )}
    </div>
  );
}
