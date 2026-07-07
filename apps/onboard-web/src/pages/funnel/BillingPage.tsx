// 1.6a/1.6b Billing — F1PayTrial / F1PayPaid (prototype/02-flow1.jsx).
// The prototype's fake CardFields / routing-account inputs are replaced by a
// real Stripe Payment Element (card / us_bank_account) in exactly the area
// they occupied; every surrounding note line and padding is kept verbatim.
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { loadStripe, type Appearance, type Stripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { PRICE_CHANGE_COPY, PRICE_LOCK_COPY } from '@capiro/shared';
import {
  Btn,
  Card,
  Field,
  FunnelShell,
  Icon,
  ScreenTitle,
  Spinner,
  TextInput,
} from '../../ui/primitives';
import { useConfig } from '../../useConfig';
import {
  useAdvanceSession,
  useFunnelApi,
  useFunnelSession,
  type FunnelApi,
  type FunnelSession,
  type PayMethod,
} from '../../lib/funnel';
import { ErrorText, errorMessage } from './shared';

// ── Stripe plumbing ─────────────────────────────────────────────────────────

let stripePromise: Promise<Stripe | null> | null = null;
function getStripe(publishableKey: string): Promise<Stripe | null> {
  if (!stripePromise) stripePromise = loadStripe(publishableKey);
  return stripePromise;
}

const stripeAppearance: Appearance = {
  variables: {
    colorPrimary: '#2A57CE',
    colorText: '#15161A',
    colorDanger: '#B5301B',
    colorBackground: '#ffffff',
    borderRadius: '6px',
    fontSizeBase: '13.5px',
  },
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const notConfiguredNote = (
  <div style={{ fontSize: 11.5, color: 'var(--critical)', lineHeight: 1.5 }}>
    Payments are not configured
  </div>
);

function ElementPlaceholder({ error }: { error: string | null }) {
  return error ? (
    <ErrorText style={{ marginTop: 0 }}>{error}</ErrorText>
  ) : (
    <div style={{ display: 'grid', placeItems: 'center', padding: '26px 0' }}>
      <Spinner size={18} />
    </div>
  );
}

/** Primary CTA inside <Elements> — confirms the SetupIntent/PaymentIntent. */
function StripeConfirmButton({
  mode,
  label,
  disabled,
  onDone,
}: {
  mode: 'setup' | 'payment';
  label: string;
  disabled?: boolean;
  onDone: () => Promise<void>;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    if (!stripe || !elements || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result =
        mode === 'setup'
          ? await stripe.confirmSetup({ elements, redirect: 'if_required' })
          : await stripe.confirmPayment({ elements, redirect: 'if_required' });
      if (result.error) {
        setError(result.error.message ?? 'Payment failed — please try again.');
        setBusy(false);
        return;
      }
      await onDone();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <>
      {error && <ErrorText>{error}</ErrorText>}
      <Btn
        variant="primary"
        disabled={busy || disabled}
        onClick={() => void submit()}
        style={{ width: '100%', marginTop: 18 }}
      >
        {label}
      </Btn>
    </>
  );
}

// ── Shared tab bar (verbatim prototype styles) ──────────────────────────────

function TabBtn({
  id,
  label,
  tab,
  setTab,
}: {
  id: PayMethod;
  label: string;
  tab: PayMethod;
  setTab: (id: PayMethod) => void;
}) {
  return (
    <button
      onClick={() => setTab(id)}
      style={{
        flex: 1,
        padding: '8px 0',
        fontSize: 12.5,
        fontWeight: 600,
        fontFamily: 'var(--font-sans)',
        cursor: 'pointer',
        border: 'none',
        borderBottom: tab === id ? '2px solid var(--accent)' : '2px solid transparent',
        background: 'transparent',
        color: tab === id ? 'var(--accent-ink)' : 'var(--ink-3)',
      }}
    >
      {label}
    </button>
  );
}

// ── Route component ─────────────────────────────────────────────────────────

export function BillingPage() {
  const session = useFunnelSession();
  if (!session.data) return null;
  return session.data.plan === 'paid' ? (
    <F1PayPaid session={session.data} />
  ) : (
    <F1PayTrial session={session.data} />
  );
}

// ── 1.6a Trial — payment method on file (Card / Wire / ACH) ─────────────────

function F1PayTrial({ session }: { session: FunnelSession }) {
  const config = useConfig();
  const navigate = useNavigate();
  const api = useFunnelApi();
  const advanceSession = useAdvanceSession();
  const stripePk = config.stripePublishableKey;

  const [tab, setTabState] = React.useState<PayMethod>(session.payMethod ?? 'card');
  const [secrets, setSecrets] = React.useState<Partial<Record<'card' | 'ach', string>>>({});
  const [setupError, setSetupError] = React.useState<string | null>(null);
  const [wireBusy, setWireBusy] = React.useState(false);
  const [wireError, setWireError] = React.useState<string | null>(null);
  const [billingContact, setBillingContact] = React.useState(session.email);
  const requestedRef = React.useRef<Partial<Record<'card' | 'ach', boolean>>>({});

  const setTab = (id: PayMethod) => {
    setTabState(id);
    setSetupError(null);
    setWireError(null);
  };

  // Create the SetupIntent for the focused tab (once per method).
  React.useEffect(() => {
    if (tab === 'wire' || !stripePk) return;
    const method = tab;
    if (requestedRef.current[method]) return;
    requestedRef.current[method] = true;
    api
      .createSetupIntent(method)
      .then((r) => setSecrets((s) => ({ ...s, [method]: r.clientSecret })))
      .catch((err) => {
        requestedRef.current[method] = false;
        setSetupError(errorMessage(err));
      });
  }, [tab, stripePk, api]);

  const completeTrial = async (method: PayMethod) => {
    await api.trialComplete(method);
    advanceSession({ state: 'payment_on_file', payMethod: method });
    navigate('/admins');
  };

  const completeWire = async () => {
    if (wireBusy) return;
    setWireBusy(true);
    setWireError(null);
    try {
      await completeTrial('wire');
    } catch (err) {
      setWireError(errorMessage(err));
      setWireBusy(false);
    }
  };

  const cardNote = (
    <div
      style={{
        marginTop: 12,
        fontSize: 11.5,
        color: 'var(--ink-3)',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
      }}
    >
      <Icon name="Lock" size={11} />
      Card stored securely — no charge until day 31.
    </div>
  );

  const achNote = (
    <div style={{ fontSize: 11.5, color: 'var(--ink-3)', display: 'flex', gap: 6 }}>
      <Icon name="Clock" size={12} style={{ marginTop: 1 }} />
      No charge today. If your trial converts on day 31, your bank account is debited then — ACH
      takes 1–3 business days to clear.
    </div>
  );

  return (
    <FunnelShell step={4} maxWidth={520}>
      <ScreenTitle
        kicker="Free trial"
        title="Add a payment method to start your trial"
        sub={
          <span>
            You won't be charged today. Your trial converts to a paid subscription on{' '}
            <b style={{ color: 'var(--ink-1)' }}>day 31</b> unless you cancel — that's when your
            selected method is first charged.
          </span>
        }
      />
      <Card pad={0}>
        <div
          style={{ display: 'flex', borderBottom: '1px solid var(--border-1)', padding: '0 12px' }}
        >
          <TabBtn id="card" label="Card" tab={tab} setTab={setTab} />
          <TabBtn id="wire" label="Wire" tab={tab} setTab={setTab} />
          <TabBtn id="ach" label="ACH" tab={tab} setTab={setTab} />
        </div>
        <div style={{ padding: 20 }}>
          {tab === 'card' &&
            (stripePk && secrets.card ? (
              <Elements
                stripe={getStripe(stripePk)}
                options={{ clientSecret: secrets.card, appearance: stripeAppearance }}
              >
                <PaymentElement />
                {cardNote}
                <StripeConfirmButton
                  mode="setup"
                  label="Start Free Trial"
                  onDone={() => completeTrial('card')}
                />
              </Elements>
            ) : (
              <>
                {stripePk ? <ElementPlaceholder error={setupError} /> : notConfiguredNote}
                {cardNote}
                <Btn variant="primary" disabled style={{ width: '100%', marginTop: 18 }}>
                  Start Free Trial
                </Btn>
              </>
            ))}
          {tab === 'wire' && (
            <>
              <div style={{ display: 'grid', gap: 12 }}>
                <div
                  style={{
                    background: 'var(--accent-soft)',
                    borderRadius: 6,
                    padding: '12px 14px',
                    fontSize: 12.5,
                    color: 'var(--accent-ink)',
                    lineHeight: 1.55,
                    display: 'flex',
                    gap: 9,
                  }}
                >
                  <Icon name="Landmark" size={16} style={{ marginTop: 1 }} />
                  <span>
                    No charge today. If your trial converts on day 31, bank wire instructions and an
                    invoice are emailed to <b>{session.email}</b>. Cancel before then and nothing is
                    billed.
                  </span>
                </div>
                <Field label="Billing contact (for invoice)">
                  <TextInput
                    value={billingContact}
                    onChange={(e) => setBillingContact(e.target.value)}
                  />
                </Field>
              </div>
              {wireError && <ErrorText>{wireError}</ErrorText>}
              <Btn
                variant="primary"
                disabled={wireBusy}
                onClick={() => void completeWire()}
                style={{ width: '100%', marginTop: 18 }}
              >
                Start Free Trial
              </Btn>
            </>
          )}
          {tab === 'ach' &&
            (stripePk && secrets.ach ? (
              <Elements
                stripe={getStripe(stripePk)}
                options={{ clientSecret: secrets.ach, appearance: stripeAppearance }}
              >
                <div style={{ display: 'grid', gap: 12 }}>
                  <PaymentElement />
                  {achNote}
                </div>
                <StripeConfirmButton
                  mode="setup"
                  label="Start Free Trial"
                  onDone={() => completeTrial('ach')}
                />
              </Elements>
            ) : (
              <>
                <div style={{ display: 'grid', gap: 12 }}>
                  {stripePk ? <ElementPlaceholder error={setupError} /> : notConfiguredNote}
                  {achNote}
                </div>
                <Btn variant="primary" disabled style={{ width: '100%', marginTop: 18 }}>
                  Start Free Trial
                </Btn>
              </>
            ))}
        </div>
      </Card>
    </FunnelShell>
  );
}

// ── 1.6b Paid — profile tier & payment ──────────────────────────────────────

async function pollUntilAdvanced(api: FunnelApi, isMounted: () => boolean): Promise<boolean> {
  for (let i = 0; i < 80; i++) {
    if (!isMounted()) return false;
    const status = await api.paidStatus();
    if (status.advanced) return true;
    await sleep(1500);
  }
  throw new Error(
    'Payment confirmation is taking longer than expected — contact support@capiro.ai.',
  );
}

function F1PayPaid({ session }: { session: FunnelSession }) {
  const config = useConfig();
  const navigate = useNavigate();
  const api = useFunnelApi();
  const advanceSession = useAdvanceSession();
  const stripePk = config.stripePublishableKey;

  const [profiles, setProfiles] = React.useState<number>(Math.max(10, session.profiles ?? 10));
  const [tab, setTabState] = React.useState<PayMethod>(session.payMethod ?? 'card');
  const [confirm, setConfirm] = React.useState<{
    method: 'card' | 'ach';
    clientSecret: string;
  } | null>(null);
  const [invoiceUrl, setInvoiceUrl] = React.useState<string | null>(null);
  const [billingContact, setBillingContact] = React.useState(session.email);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const mountedRef = React.useRef(true);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const n = Math.max(10, profiles || 10);
  const price = (n * 200).toLocaleString();

  const setTab = (id: PayMethod) => {
    setTabState(id);
    setError(null);
  };

  const finish = async (method: PayMethod) => {
    const advanced = await pollUntilAdvanced(api, () => mountedRef.current);
    if (!advanced) return;
    advanceSession({ state: 'payment_on_file', payMethod: method, profiles: n });
    navigate('/admins');
  };

  const subscribe = async (method: 'card' | 'ach') => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.subscribe({ profiles: n, method });
      if (res.clientSecret) {
        setConfirm({ method, clientSecret: res.clientSecret });
        setBusy(false);
      } else {
        await finish(method);
      }
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const subscribeWire = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.subscribe({ profiles: n, method: 'wire' });
      if (res.hostedInvoiceUrl) setInvoiceUrl(res.hostedInvoiceUrl);
      await finish('wire');
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const cardNote = (
    <div style={{ marginTop: 12, fontSize: 11.5, color: 'var(--ink-3)' }}>
      Your card is charged <b>${price}</b> immediately on subscribe.
    </div>
  );

  const achNote = (
    <div style={{ fontSize: 11.5, color: 'var(--ink-3)', display: 'flex', gap: 6 }}>
      <Icon name="Clock" size={12} style={{ marginTop: 1 }} />
      ACH debits take 1–3 business days to clear. Your workspace provisions immediately.
    </div>
  );

  return (
    <FunnelShell step={4} maxWidth={860}>
      <ScreenTitle kicker="Subscription" title="Choose your tier and payment method" />
      <div
        style={{ display: 'grid', gridTemplateColumns: '1fr 1.2fr', gap: 16, alignItems: 'start' }}
      >
        <Card>
          <b style={{ fontSize: 13.5 }}>Client profile tier</b>
          <div style={{ margin: '14px 0 10px' }}>
            <Field label="Number of client profiles" hint="Minimum 10 profiles.">
              <TextInput
                type="number"
                min={10}
                value={profiles}
                disabled={!!confirm || busy}
                onChange={(e) => setProfiles(parseInt(e.target.value) || 10)}
                style={{ fontFamily: 'var(--font-mono)', letterSpacing: 0, width: 120 }}
              />
            </Field>
          </div>
          <div
            style={{
              background: 'var(--bg-sunken)',
              border: '1px solid var(--border-1)',
              borderRadius: 6,
              padding: '12px 14px',
              fontFamily: 'var(--font-mono)',
              fontSize: 12.5,
              letterSpacing: 0,
              color: 'var(--ink-1)',
            }}
          >
            {n} profiles × $200 = <b>${price}/month</b>
          </div>
          {n < 10 && (
            <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--critical)' }}>
              Minimum is 10 profiles.
            </div>
          )}
          <div style={{ marginTop: 12, fontSize: 11.5, color: 'var(--ink-3)', lineHeight: 1.5 }}>
            {PRICE_LOCK_COPY} Volume discounts for large accounts —{' '}
            <a href="#" onClick={(e) => e.preventDefault()} style={{ color: 'var(--accent)' }}>
              contact sales
            </a>
            . {PRICE_CHANGE_COPY}
          </div>
        </Card>
        <Card pad={0}>
          <div
            style={{
              display: 'flex',
              borderBottom: '1px solid var(--border-1)',
              padding: '0 12px',
            }}
          >
            <TabBtn id="card" label="Card" tab={tab} setTab={setTab} />
            <TabBtn id="wire" label="Wire" tab={tab} setTab={setTab} />
            <TabBtn id="ach" label="ACH" tab={tab} setTab={setTab} />
          </div>
          <div style={{ padding: 20 }}>
            {tab === 'card' &&
              (confirm && confirm.method === 'card' && stripePk ? (
                <Elements
                  stripe={getStripe(stripePk)}
                  options={{ clientSecret: confirm.clientSecret, appearance: stripeAppearance }}
                >
                  <PaymentElement />
                  {cardNote}
                  <StripeConfirmButton
                    mode="payment"
                    label="Confirm payment"
                    onDone={() => finish('card')}
                  />
                </Elements>
              ) : (
                <>
                  {!stripePk && notConfiguredNote}
                  {cardNote}
                  {error && <ErrorText>{error}</ErrorText>}
                  <Btn
                    variant="primary"
                    disabled={n < 10 || busy || !stripePk}
                    onClick={() => void subscribe('card')}
                    style={{ width: '100%', marginTop: 18 }}
                  >
                    Subscribe — ${price}/month
                  </Btn>
                </>
              ))}
            {tab === 'wire' && (
              <>
                <div style={{ display: 'grid', gap: 12 }}>
                  <div
                    style={{
                      background: 'var(--accent-soft)',
                      borderRadius: 6,
                      padding: '12px 14px',
                      fontSize: 12.5,
                      color: 'var(--accent-ink)',
                      lineHeight: 1.55,
                      display: 'flex',
                      gap: 9,
                    }}
                  >
                    <Icon name="Landmark" size={16} style={{ marginTop: 1 }} />
                    <span>
                      Bank wire instructions will be emailed to <b>{session.email}</b> and an
                      invoice for <b>${price}</b> is generated on submit. Your workspace provisions
                      immediately; access locks if the invoice goes unpaid.
                      {invoiceUrl && (
                        <>
                          <br />
                          <a
                            href={invoiceUrl}
                            target="_blank"
                            rel="noreferrer"
                            style={{ color: 'var(--accent-ink)', fontWeight: 600 }}
                          >
                            View your invoice
                          </a>
                        </>
                      )}
                    </span>
                  </div>
                  <Field label="Billing contact (for invoice)">
                    <TextInput
                      value={billingContact}
                      onChange={(e) => setBillingContact(e.target.value)}
                    />
                  </Field>
                </div>
                {error && <ErrorText>{error}</ErrorText>}
                <Btn
                  variant="primary"
                  disabled={n < 10 || busy}
                  onClick={() => void subscribeWire()}
                  style={{ width: '100%', marginTop: 18 }}
                >
                  Subscribe — ${price}/month
                </Btn>
              </>
            )}
            {tab === 'ach' &&
              (confirm && confirm.method === 'ach' && stripePk ? (
                <Elements
                  stripe={getStripe(stripePk)}
                  options={{ clientSecret: confirm.clientSecret, appearance: stripeAppearance }}
                >
                  <div style={{ display: 'grid', gap: 12 }}>
                    <PaymentElement />
                    {achNote}
                  </div>
                  <StripeConfirmButton
                    mode="payment"
                    label="Confirm payment"
                    onDone={() => finish('ach')}
                  />
                </Elements>
              ) : (
                <>
                  <div style={{ display: 'grid', gap: 12 }}>
                    {!stripePk && notConfiguredNote}
                    {achNote}
                  </div>
                  {error && <ErrorText>{error}</ErrorText>}
                  <Btn
                    variant="primary"
                    disabled={n < 10 || busy || !stripePk}
                    onClick={() => void subscribe('ach')}
                    style={{ width: '100%', marginTop: 18 }}
                  >
                    Subscribe — ${price}/month
                  </Btn>
                </>
              ))}
          </div>
        </Card>
      </div>
    </FunnelShell>
  );
}
