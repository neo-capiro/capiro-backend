import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Form, Input, Typography } from 'antd';
import { useSignUp } from '@clerk/clerk-react';

/**
 * Invitation-acceptance sign-up (onboarding v1): a headless Clerk ticket flow
 * that adds the REQUIRED "Confirm password" field (Ninja directive — Clerk's
 * hosted <SignUp> asks for the password only once, which is why this custom
 * form exists). Rendered by AuthPage when /sign-up carries a __clerk_ticket
 * query param (Clerk org-invitation links); ticket-less visits keep the
 * hosted component, preserving the invitation-only posture.
 *
 * Flow (Clerk ticket strategy):
 *   1. mount → signUp.create({ strategy:'ticket', ticket }) with no password
 *      → Clerk validates the invitation and returns the invitee's email
 *      (status 'missing_requirements').
 *   2. submit → signUp.update({ password }) → status 'complete'
 *      → setActive(createdSessionId) → hard-redirect to "/" so the org
 *      context loads fresh.
 * Expired/revoked tickets surface the Gherkin edge-case copy.
 */
export function TicketSignUpPage({ ticket }: { ticket: string }) {
  const { isLoaded, signUp, setActive } = useSignUp();
  const [email, setEmail] = useState<string | null>(null);
  const [ticketError, setTicketError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const claimed = useRef(false);

  useEffect(() => {
    if (!isLoaded || !signUp || claimed.current) return;
    claimed.current = true;
    signUp
      .create({ strategy: 'ticket', ticket })
      .then((attempt) => {
        setEmail(attempt.emailAddress ?? null);
      })
      .catch((err: unknown) => {
        const clerkMessage =
          (err as { errors?: Array<{ longMessage?: string; message?: string }> }).errors?.[0]
            ?.longMessage ?? (err as Error).message;
        // Expired / revoked invitation → the Gherkin edge-case copy.
        setTicketError(
          /expired|revoked|not found|invalid/i.test(clerkMessage ?? '')
            ? 'Invite expired, contact your administrator'
            : (clerkMessage ?? 'This invitation link could not be verified.'),
        );
      });
  }, [isLoaded, signUp, ticket]);

  const onFinish = async (values: { password: string; confirmPassword: string }) => {
    if (!signUp || !setActive) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      const attempt = await signUp.update({ password: values.password });
      if (attempt.status !== 'complete' || !attempt.createdSessionId) {
        setSubmitError('Sign-up could not be completed. Please try the invite link again.');
        return;
      }
      await setActive({ session: attempt.createdSessionId });
      // Hard navigation so the app boots with the new org session everywhere.
      window.location.assign('/');
    } catch (err: unknown) {
      const clerkMessage =
        (err as { errors?: Array<{ longMessage?: string; message?: string }> }).errors?.[0]
          ?.longMessage ?? (err as Error).message;
      setSubmitError(clerkMessage ?? 'Sign-up failed.');
    } finally {
      setSubmitting(false);
    }
  };

  if (ticketError) {
    return (
      <div style={{ padding: 24, maxWidth: 400 }}>
        <Alert type="warning" showIcon message={ticketError} />
      </div>
    );
  }

  return (
    <div style={{ padding: 24, width: 380, maxWidth: '100%' }}>
      <Typography.Title level={4} style={{ marginBottom: 4 }}>
        Create your account
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
        One credential works for both the setup dashboard and the Capiro app.
      </Typography.Paragraph>
      <Form layout="vertical" onFinish={onFinish} disabled={!email}>
        <Form.Item label="Email">
          <Input value={email ?? 'Verifying your invitation…'} readOnly />
        </Form.Item>
        <Form.Item
          name="password"
          label="Password"
          rules={[{ required: true, message: 'Choose a password' }]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Form.Item
          name="confirmPassword"
          label="Confirm password"
          dependencies={['password']}
          rules={[
            { required: true, message: 'Confirm your password' },
            ({ getFieldValue }) => ({
              validator(_rule, value) {
                if (!value || getFieldValue('password') === value) return Promise.resolve();
                return Promise.reject(new Error('Passwords do not match'));
              },
            }),
          ]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        {submitError && (
          <Alert type="error" showIcon message={submitError} style={{ marginBottom: 16 }} />
        )}
        <Button type="primary" htmlType="submit" block loading={submitting} disabled={!email}>
          Create account &amp; sign in
        </Button>
      </Form>
    </div>
  );
}
