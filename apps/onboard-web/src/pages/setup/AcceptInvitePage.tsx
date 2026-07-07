// 2A.0 — Admin invite → credential creation. Port of the prototype
// AcceptInvite create phase (the email-preview phase was demo-only), wired to
// Clerk's headless ticket flow (?__clerk_ticket=…).
import React from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth, useSignUp } from '@clerk/clerk-react';
import { Btn, Card, Field, TextInput, Spinner, Wordmark } from '../../ui/primitives';
import { ErrorText, errorMessage } from '../funnel/shared';

const inlineErrorStyle: React.CSSProperties = {
  fontSize: 11.5,
  color: 'var(--critical)',
  lineHeight: 1.45,
};

export function AcceptInvitePage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const ticket = params.get('__clerk_ticket');
  const { isLoaded: authLoaded, isSignedIn } = useAuth();
  const { isLoaded: signUpLoaded, signUp, setActive } = useSignUp();

  const [phase, setPhase] = React.useState<'loading' | 'create' | 'expired'>('loading');
  const [password, setPassword] = React.useState('');
  const [confirmPassword, setConfirmPassword] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const startedRef = React.useRef(false);

  const confirmMismatch = confirmPassword.length > 0 && confirmPassword !== password;

  // Already signed in → straight to the dashboard.
  React.useEffect(() => {
    if (authLoaded && isSignedIn) navigate('/setup', { replace: true });
  }, [authLoaded, isSignedIn, navigate]);

  // Start the ticket sign-up (verifies the invite + surfaces the email).
  React.useEffect(() => {
    if (!authLoaded || isSignedIn || !signUpLoaded || !signUp || startedRef.current) return;
    if (!ticket) {
      setPhase('expired');
      return;
    }
    startedRef.current = true;
    void (async () => {
      try {
        await signUp.create({ strategy: 'ticket', ticket });
        setPhase('create');
      } catch {
        // Expired/revoked/invalid ticket (Gherkin edge case).
        setPhase('expired');
      }
    })();
  }, [authLoaded, isSignedIn, signUpLoaded, signUp, ticket]);

  const submit = async () => {
    if (!signUp || submitting) return;
    if (password.length === 0 || password !== confirmPassword) return;
    setSubmitting(true);
    setError(null);
    try {
      const attempt = await signUp.update({ password });
      if (attempt.status === 'complete') {
        await setActive({ session: attempt.createdSessionId });
        navigate('/setup', { replace: true });
      } else {
        setError('Account creation needs another step — contact support@capiro.ai.');
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-canvas)',
      }}
    >
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          padding: '48px 40px 64px',
        }}
      >
        {phase === 'loading' ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}>
            <Spinner size={18} />
          </div>
        ) : phase === 'expired' ? (
          <div style={{ width: '100%', maxWidth: 400, marginTop: 12 }}>
            <div style={{ textAlign: 'center', marginBottom: 18 }}>
              <Wordmark size={17} />
            </div>
            <Card style={{ padding: '28px 26px', textAlign: 'center' }}>
              <p style={{ margin: 0, fontSize: 13.5, color: 'var(--ink-1)', fontWeight: 600 }}>
                Invite expired, contact your administrator
              </p>
            </Card>
          </div>
        ) : (
          <div style={{ width: '100%', maxWidth: 400, marginTop: 12 }}>
            <div style={{ textAlign: 'center', marginBottom: 18 }}>
              <Wordmark size={17} />
            </div>
            <Card style={{ padding: '28px 26px' }}>
              <h2
                style={{
                  margin: '0 0 4px',
                  fontFamily: 'var(--font-serif)',
                  fontWeight: 500,
                  fontSize: 22,
                  letterSpacing: '-0.015em',
                }}
              >
                Create your account
              </h2>
              <p style={{ margin: '0 0 18px', fontSize: 12.5, color: 'var(--ink-2)' }}>
                One credential works for both the setup dashboard and the Capiro app.
              </p>
              <div style={{ display: 'grid', gap: 13 }}>
                <Field label="Email">
                  <TextInput
                    value={signUp?.emailAddress ?? ''}
                    readOnly
                    style={{ color: 'var(--ink-3)' }}
                  />
                </Field>
                <Field label="Password">
                  <TextInput
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </Field>
                <Field label="Confirm password">
                  <>
                    <TextInput
                      type="password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                    />
                    {confirmMismatch && (
                      <span style={inlineErrorStyle}>Passwords do not match</span>
                    )}
                  </>
                </Field>
                {error && <ErrorText style={{ marginTop: 0 }}>{error}</ErrorText>}
                <Btn
                  variant="primary"
                  disabled={submitting || confirmMismatch || password.length === 0}
                  onClick={() => void submit()}
                  style={{ width: '100%', marginTop: 2 }}
                >
                  {submitting ? 'Creating account…' : 'Create account & sign in'}
                </Btn>
                <div id="clerk-captcha" />
              </div>
            </Card>
            <p
              style={{
                marginTop: 14,
                fontSize: 11.5,
                color: 'var(--ink-3)',
                textAlign: 'center',
                lineHeight: 1.55,
              }}
            >
              You'll land in the firm setup dashboard — the Capiro app unlocks once setup is
              complete.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
