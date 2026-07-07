// 1.9 Org & Tenant Setup — F1Org (prototype/02-flow1.jsx). All fields are
// controlled and start empty (prototype placeholders kept); the logo dropzone
// is visual-only for now (file held in state, upload wiring lands with the
// dashboard phase).
import React from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Btn,
  Card,
  Field,
  FunnelShell,
  Icon,
  ScreenTitle,
  SelectInput,
  Tag,
  TextInput,
} from '../../ui/primitives';
import {
  useAdvanceSession,
  useFunnelApi,
  useFunnelSession,
  type FunnelSession,
} from '../../lib/funnel';
import { ErrorText, errorMessage } from './shared';

export function OrgPage() {
  const session = useFunnelSession();
  if (!session.data) return null;
  return <F1Org session={session.data} />;
}

function F1Org({ session }: { session: FunnelSession }) {
  const navigate = useNavigate();
  const api = useFunnelApi();
  const advanceSession = useAdvanceSession();

  const saved = session.orgProfile;
  const [orgName, setOrgName] = React.useState(saved?.legalName || session.orgName || '');
  const [vertical, setVertical] = React.useState<string | null>(saved?.vertical || null);
  const [teamSize, setTeamSize] = React.useState<string | null>(saved?.teamSize || null);
  const [tz, setTz] = React.useState<string | null>(saved?.timezone || null);
  const [locale, setLocale] = React.useState<string>(saved?.locale || 'en-US · USD');
  const [street, setStreet] = React.useState(saved?.address.street ?? '');
  const [city, setCity] = React.useState(saved?.address.city ?? '');
  const [state, setState] = React.useState(saved?.address.state ?? '');
  const [zip, setZip] = React.useState(saved?.address.zip ?? '');
  const [logoFile, setLogoFile] = React.useState<File | null>(null);
  const [itEmail, setItEmail] = React.useState(session.itAdminEmails?.[0] ?? '');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    if (!orgName || busy) return;
    setBusy(true);
    setError(null);
    try {
      const orgProfile = {
        legalName: orgName,
        vertical: vertical ?? '',
        teamSize: teamSize ?? '',
        timezone: tz ?? '',
        locale,
        address: { street, city, state, zip },
      };
      await api.setOrg({ orgProfile, itAdminEmail: itEmail || undefined });
      advanceSession({
        state: 'org_setup',
        orgProfile,
        itAdminEmails: itEmail ? [itEmail] : session.itAdminEmails,
      });
      navigate('/confirm');
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <FunnelShell step={7} maxWidth={620}>
      <ScreenTitle
        title="Set up your workspace"
        sub="This is what we need to provision your firm's instance."
      />
      <Card>
        <div style={{ display: 'grid', gap: 14 }}>
          <Field label="Firm legal name">
            <TextInput value={orgName} onChange={(e) => setOrgName(e.target.value)} />
          </Field>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="Industry vertical">
              <SelectInput
                placeholder="Select…"
                options={[
                  'Government affairs',
                  'Law firm',
                  'Defense & aerospace',
                  'Healthcare',
                  'Energy',
                  'Trade association',
                ]}
                value={vertical}
                onChange={(v) => setVertical(v)}
              />
            </Field>
            <Field label="Approximate team size">
              <SelectInput
                placeholder="Select…"
                options={['1–10', '11–50', '51–200', '200+']}
                value={teamSize}
                onChange={(v) => setTeamSize(v)}
              />
            </Field>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="Timezone">
              <SelectInput
                placeholder="Select…"
                options={[
                  'America/New_York (ET)',
                  'America/Chicago (CT)',
                  'America/Denver (MT)',
                  'America/Los_Angeles (PT)',
                ]}
                value={tz}
                onChange={(v) => setTz(v)}
              />
            </Field>
            <Field label="Default locale / currency" optional>
              <SelectInput
                options={['en-US · USD', 'en-GB · GBP', 'fr-CA · CAD']}
                value={locale}
                onChange={(v) => setLocale(v)}
              />
            </Field>
          </div>
          <Field label="Business address">
            <div style={{ display: 'grid', gap: 8 }}>
              <TextInput
                placeholder="Street"
                value={street}
                onChange={(e) => setStreet(e.target.value)}
              />
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 8 }}>
                <TextInput
                  placeholder="City"
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                />
                <TextInput
                  placeholder="State"
                  value={state}
                  onChange={(e) => setState(e.target.value)}
                />
                <TextInput placeholder="ZIP" value={zip} onChange={(e) => setZip(e.target.value)} />
              </div>
            </div>
          </Field>
          <Field label="Logo" optional>
            <>
              <div
                style={{
                  border: '1.5px dashed var(--border-strong)',
                  borderRadius: 6,
                  padding: '18px 14px',
                  textAlign: 'center',
                  fontSize: 12,
                  color: 'var(--ink-3)',
                  background: 'var(--bg-surface-2)',
                  cursor: 'pointer',
                  position: 'relative',
                }}
              >
                <Icon name="ImageUp" size={17} style={{ color: 'var(--ink-4)', marginBottom: 4 }} />
                <br />
                Drag and drop your logo, or{' '}
                <span style={{ color: 'var(--accent)', fontWeight: 600 }}>browse</span>
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => setLogoFile(e.target.files?.[0] ?? null)}
                  style={{
                    position: 'absolute',
                    inset: 0,
                    width: '100%',
                    height: '100%',
                    opacity: 0,
                    cursor: 'pointer',
                  }}
                />
              </div>
              {logoFile && (
                <span style={{ fontSize: 11.5, color: 'var(--ink-3)', lineHeight: 1.45 }}>
                  {logoFile.name} — will be applied to your workspace branding
                </span>
              )}
            </>
          </Field>
          <div
            style={{
              border: '1.5px solid var(--accent)',
              background: 'var(--accent-soft)',
              borderRadius: 8,
              padding: '14px 16px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <Icon name="ShieldCheck" size={15} style={{ color: 'var(--accent-ink)' }} />
              <b style={{ fontSize: 12.5, color: 'var(--accent-ink)' }}>IT Admin email address</b>
              <Tag tone="blue">Important</Tag>
            </div>
            <p
              style={{
                margin: '0 0 10px',
                fontSize: 12,
                color: 'var(--accent-ink)',
                lineHeight: 1.55,
                textWrap: 'pretty',
              }}
            >
              An IT admin at your firm must approve email permissions before any user can personally
              connect their inbox. You can do this step later, but it is <b>required before use</b>.
            </p>
            <TextInput
              value={itEmail}
              onChange={(e) => setItEmail(e.target.value)}
              placeholder="it@yourfirm.com"
              style={{ background: '#fff' }}
            />
          </div>
          {error && <ErrorText style={{ marginTop: 0 }}>{error}</ErrorText>}
          <Btn
            variant="primary"
            disabled={!orgName || busy}
            onClick={() => void submit()}
            style={{ width: '100%', marginTop: 4 }}
          >
            Finish Setup
          </Btn>
        </div>
      </Card>
    </FunnelShell>
  );
}
