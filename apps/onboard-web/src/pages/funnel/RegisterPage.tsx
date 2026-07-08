// 1.2 Purchaser Registration — F1Register (prototype/02-flow1.jsx), wired to a
// headless Clerk sign-up (useSignUp) + POST /funnel/register.
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth, useClerk, useSignUp, useUser } from '@clerk/clerk-react';
import { isClerkAPIResponseError } from '@clerk/clerk-react/errors';
import { useQueryClient } from '@tanstack/react-query';
import { Btn, Card, Field, FunnelShell, ScreenTitle, TextInput } from '../../ui/primitives';
import {
  draftMatchesUser,
  FUNNEL_SESSION_KEY,
  readRegistrationDraft,
  storeRegistrationDraft,
  useFunnelApi,
} from '../../lib/funnel';
import { routeForState } from './FunnelStepGuard';
import { ErrorText, errorMessage } from './shared';

interface FieldErrors {
  email?: string;
  password?: string;
  form?: string;
}

function clerkFieldErrors(err: unknown): FieldErrors {
  if (isClerkAPIResponseError(err)) {
    const out: FieldErrors = {};
    const general: string[] = [];
    for (const e of err.errors) {
      const message = e.longMessage || e.message;
      const param = (e.meta as { paramName?: string } | undefined)?.paramName;
      if (param === 'email_address' && !out.email) out.email = message;
      else if (param === 'password' && !out.password) out.password = message;
      else general.push(message);
    }
    if (general.length) out.form = general.join(' ');
    return out;
  }
  return { form: errorMessage(err) };
}

const inlineErrorStyle: React.CSSProperties = {
  fontSize: 11.5,
  color: 'var(--critical)',
  lineHeight: 1.45,
};

export function RegisterPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const api = useFunnelApi();
  const { isLoaded: authLoaded, isSignedIn } = useAuth();
  const { isLoaded: signUpLoaded, signUp, setActive } = useSignUp();
  const { user } = useUser();
  const clerk = useClerk();
  const sessionEmail = user?.primaryEmailAddress?.emailAddress ?? null;

  const [firstName, setFirstName] = React.useState('');
  const [lastName, setLastName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [orgName, setOrgName] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [confirmPassword, setConfirmPassword] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [errors, setErrors] = React.useState<FieldErrors>({});

  const confirmMismatch = confirmPassword.length > 0 && confirmPassword !== password;

  // Already signed in with a session (guard only lets that through when no
  // funnel session exists yet): POST /funnel/register and skip to the right
  // step — but ONLY when the stored draft carries orgName (RegisterDto rejects
  // an empty one with a 400 dead-end). Without a draft, show the form so the
  // user can re-enter the details; the signed-in submit path below handles it.
  const autoRegisterRef = React.useRef(false);
  React.useEffect(() => {
    if (!authLoaded || !isSignedIn || autoRegisterRef.current) return;
    const draft = readRegistrationDraft();
    if (!draft?.orgName?.trim()) return; // fall through to the manual form
    // The draft was typed by a DIFFERENT person than the signed-in session
    // (shared browser): auto-registering would silently make the wrong
    // account the purchaser. Show the form + identity banner instead.
    if (!draftMatchesUser(draft, sessionEmail)) return;
    autoRegisterRef.current = true;
    void (async () => {
      try {
        const snapshot = await api.register({
          firstName: draft.firstName || user?.firstName || '',
          lastName: draft.lastName || user?.lastName || '',
          orgName: draft.orgName,
        });
        queryClient.setQueryData(FUNNEL_SESSION_KEY, snapshot);
        navigate(routeForState(snapshot.state), { replace: true });
      } catch (err) {
        setErrors({ form: errorMessage(err) });
      }
    })();
  }, [authLoaded, isSignedIn, api, navigate, queryClient, user]);

  const submit = async () => {
    if (submitting) return;
    if (!isSignedIn && (!password || password !== confirmPassword)) return;
    setSubmitting(true);
    setErrors({});
    try {
      storeRegistrationDraft({ firstName, lastName, orgName, email: email.trim() });

      // Signed-in recovery path (#9): the Clerk account exists but the funnel
      // register POST never landed — a signUp.create would throw ("already
      // signed in"), so register directly with the re-entered form values.
      // HARD IDENTITY CHECK: registering under a session whose email differs
      // from the one typed silently makes the WRONG account the purchaser
      // (the tenant + Super Admin land on the signed-in user, not the person
      // on the form). Refuse and point at sign-out.
      if (isSignedIn) {
        const typed = email.trim().toLowerCase();
        if (typed && sessionEmail && typed !== sessionEmail.toLowerCase()) {
          setErrors({
            email: `You're signed in as ${sessionEmail}, so this registration would belong to that account — sign out first to register as ${typed}.`,
          });
          return;
        }
        autoRegisterRef.current = true;
        const snapshot = await api.register({ firstName, lastName, orgName });
        queryClient.setQueryData(FUNNEL_SESSION_KEY, snapshot);
        navigate(routeForState(snapshot.state), { replace: true });
        return;
      }

      if (!signUpLoaded || !signUp) return;
      const attempt = await signUp.create({
        emailAddress: email,
        password,
        firstName,
        lastName,
      });
      if (attempt.status === 'complete') {
        autoRegisterRef.current = true; // we register right here — skip the effect
        await setActive({ session: attempt.createdSessionId });
        const snapshot = await api.register({ firstName, lastName, orgName });
        queryClient.setQueryData(FUNNEL_SESSION_KEY, snapshot);
      }
      // Email verification pending ('missing_requirements'): the verify page
      // starts the email-code flow and completes registration afterwards.
      navigate('/verify');
    } catch (err) {
      setErrors(clerkFieldErrors(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <FunnelShell step={0}>
      <ScreenTitle
        kicker="Create your organization"
        title="Let's get your firm set up"
        sub="You're registering as the purchaser and billing contact for your organization."
      />
      <Card>
        <div style={{ display: 'grid', gap: 14 }}>
          {isSignedIn && sessionEmail && (
            <div
              style={{
                fontSize: 12.5,
                lineHeight: 1.55,
                background: 'var(--accent-soft)',
                border: '1px solid var(--accent)',
                borderRadius: 6,
                padding: '10px 14px',
                color: 'var(--accent-ink)',
              }}
            >
              You're signed in as <b>{sessionEmail}</b> — this registration (and the new workspace)
              will belong to that account.{' '}
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  void clerk.signOut().then(() => window.location.reload());
                }}
                style={{ color: 'var(--accent-ink)', fontWeight: 700 }}
              >
                Sign out
              </a>{' '}
              to register as someone else.
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="First name">
              <TextInput value={firstName} onChange={(e) => setFirstName(e.target.value)} />
            </Field>
            <Field label="Last name">
              <TextInput value={lastName} onChange={(e) => setLastName(e.target.value)} />
            </Field>
          </div>
          <Field label="Work email">
            <>
              <TextInput value={email} onChange={(e) => setEmail(e.target.value)} />
              {errors.email && <span style={inlineErrorStyle}>{errors.email}</span>}
            </>
          </Field>
          <Field label="Organization name">
            <TextInput value={orgName} onChange={(e) => setOrgName(e.target.value)} />
          </Field>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="Password">
              <>
                <TextInput
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                {errors.password && <span style={inlineErrorStyle}>{errors.password}</span>}
              </>
            </Field>
            <Field label="Confirm password">
              <>
                <TextInput
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                />
                {confirmMismatch && <span style={inlineErrorStyle}>Passwords do not match</span>}
              </>
            </Field>
          </div>
          {errors.form && <ErrorText style={{ marginTop: 0 }}>{errors.form}</ErrorText>}
          <Btn
            variant="primary"
            // Every early-return in submit() is mirrored here so the button
            // never presents an enabled dead click (e.g. password filled but
            // confirm-password still empty).
            disabled={
              submitting ||
              !firstName.trim() ||
              !lastName.trim() ||
              !orgName.trim() ||
              (!isSignedIn && (!email.trim() || !password || !confirmPassword || confirmMismatch))
            }
            onClick={() => void submit()}
            style={{ marginTop: 4, width: '100%' }}
          >
            {submitting ? 'Creating account…' : 'Create Account'}
          </Btn>
          <div id="clerk-captcha" />
        </div>
      </Card>
      <div
        style={{
          marginTop: 14,
          fontSize: 12,
          color: 'var(--ink-3)',
          textAlign: 'center',
          lineHeight: 1.6,
        }}
      >
        No platform account or role is created yet — that happens after checkout.
        <br />
        Already have an account?{' '}
        <a href="#" onClick={(e) => e.preventDefault()} style={{ color: 'var(--accent)' }}>
          Sign in
        </a>
      </div>
    </FunnelShell>
  );
}
