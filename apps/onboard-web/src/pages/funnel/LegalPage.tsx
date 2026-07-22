// 1.5 Legal Agreements — F1Legal. The doc bodies come from GET /funnel/legal
// and render inside the prototype's scroll box. This step is a lightweight
// e-signature ceremony: review each document, download the formal PDF, type a
// name + title + signature, and (optionally) get the signed copies emailed.
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Btn,
  Card,
  Checkbox,
  Field,
  FunnelShell,
  Icon,
  ScreenTitle,
  Spinner,
  TextInput,
} from '../../ui/primitives';
import { useAdvanceSession, useFunnelApi, useFunnelSession, type LegalDoc } from '../../lib/funnel';
import { ErrorText, errorMessage } from './shared';

/** Static blank (unsigned) formal PDFs served from onboard-web/public. */
const BLANK_PDF: Record<'tos' | 'sa', { href: string; title: string }> = {
  tos: { href: '/legal-docs/Capiro-Terms-of-Service.pdf', title: 'Terms of Service' },
  sa: { href: '/legal-docs/Capiro-Subscription-Agreement.pdf', title: 'Subscription Agreement' },
};

function LegalBlock({
  title,
  html,
  checked,
  onChange,
  label,
  downloadHref,
}: {
  title: string;
  html: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: React.ReactNode;
  downloadHref?: string;
}) {
  return (
    <Card pad={0} style={{ overflow: 'hidden' }}>
      <div
        style={{
          padding: '12px 18px',
          borderBottom: '1px solid var(--border-1)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <Icon name="ScrollText" size={15} style={{ color: 'var(--ink-3)' }} />
        <b style={{ fontSize: 13.5 }}>{title}</b>
        {downloadHref && (
          <a
            href={downloadHref}
            download
            style={{
              marginLeft: 'auto',
              fontSize: 12,
              color: 'var(--accent)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <Icon name="Download" size={12} />
            Download PDF
          </a>
        )}
      </div>
      <div
        style={{
          height: 130,
          overflowY: 'auto',
          padding: '12px 18px',
          background: 'var(--bg-surface-2)',
          fontSize: 11.5,
          lineHeight: 1.65,
          color: 'var(--ink-2)',
          whiteSpace: 'pre-wrap',
          fontFamily: 'var(--font-mono)',
          letterSpacing: 0,
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <div style={{ padding: '12px 18px', borderTop: '1px solid var(--border-1)' }}>
        <Checkbox checked={checked} onChange={onChange}>
          {label}
        </Checkbox>
      </div>
    </Card>
  );
}

/** Trigger a browser download for a fetched Blob (auth-gated signed copy). */
function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function LegalPage() {
  const navigate = useNavigate();
  const api = useFunnelApi();
  const advanceSession = useAdvanceSession();
  const session = useFunnelSession();

  const [tosChecked, setTosChecked] = React.useState(false);
  const [saChecked, setSaChecked] = React.useState(false);
  const [signerName, setSignerName] = React.useState('');
  const [nameTouched, setNameTouched] = React.useState(false);
  const [signerTitle, setSignerTitle] = React.useState('');
  const [authority, setAuthority] = React.useState(false);
  const [emailCopy, setEmailCopy] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [signed, setSigned] = React.useState(false);
  const [dlBusy, setDlBusy] = React.useState<'tos' | 'sa' | null>(null);
  const [dlError, setDlError] = React.useState<string | null>(null);

  // Keyed by PLAN: the SA has trial/paid variants, and the Back button allows
  // a plan change before payment — an unkeyed infinite-stale cache would keep
  // serving (and submitting!) the previous plan's agreement.
  const plan = session.data?.plan ?? null;
  const docs = useQuery({
    queryKey: ['funnel', 'legal', plan],
    queryFn: () => api.getLegal(),
    enabled: plan !== null,
    staleTime: Infinity,
  });
  const tos: LegalDoc | undefined = docs.data?.find((d) => d.docType === 'tos');
  const sa: LegalDoc | undefined = docs.data?.find((d) => d.docType === 'sa');

  const orgName = session.data?.orgName?.trim() || 'your organization';
  const email = session.data?.email ?? '';

  // Prefill the signer name from the registered purchaser once, without
  // clobbering an edit the user has already made.
  const suggestedName = session.data
    ? `${session.data.firstName ?? ''} ${session.data.lastName ?? ''}`.trim()
    : '';
  React.useEffect(() => {
    if (!nameTouched && !signerName && suggestedName) setSignerName(suggestedName);
  }, [suggestedName, nameTouched, signerName]);

  const ok =
    tosChecked &&
    saChecked &&
    signerName.trim().length > 0 &&
    signerTitle.trim().length > 0 &&
    authority &&
    !!tos &&
    !!sa;

  const submit = async () => {
    if (!ok || busy || !tos || !sa) return;
    setBusy(true);
    setError(null);
    try {
      await api.acceptLegal({
        tosVersion: tos.version,
        saVersion: sa.version,
        signerName: signerName.trim(),
        signerTitle: signerTitle.trim(),
        signatureName: signerName.trim(),
        emailCopy,
      });
      setSigned(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const download = async (docType: 'tos' | 'sa') => {
    setDlBusy(docType);
    setDlError(null);
    try {
      const { blob, filename } = await api.downloadSigned(docType);
      saveBlob(blob, filename);
    } catch (err) {
      setDlError(errorMessage(err));
    } finally {
      setDlBusy(null);
    }
  };

  const continueToBilling = () => {
    advanceSession({ state: 'legal_accepted' });
    navigate('/billing');
  };

  // ── Post-signature confirmation ────────────────────────────────────────────
  if (signed) {
    return (
      <FunnelShell step={3} maxWidth={620}>
        <ScreenTitle
          title="Agreements signed"
          sub="Your acceptance is recorded with a timestamped audit trail."
        />
        <Card style={{ display: 'grid', gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Icon name="CircleCheck" size={20} style={{ color: 'var(--success)' }} />
            <b style={{ fontSize: 15 }}>Signed by {signerName.trim()}</b>
          </div>
          {emailCopy && email && (
            <div style={{ fontSize: 13, color: 'var(--ink-2)' }}>
              A copy of the signed agreements is on its way to <b>{email}</b>.
            </div>
          )}
          <div style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>
            Download your countersigned copies (each includes a Certificate of Completion):
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <Btn
              variant="secondary"
              icon={dlBusy === 'tos' ? undefined : 'Download'}
              disabled={dlBusy !== null}
              onClick={() => void download('tos')}
            >
              {dlBusy === 'tos' && <Spinner size={13} />}
              Signed Terms of Service
            </Btn>
            <Btn
              variant="secondary"
              icon={dlBusy === 'sa' ? undefined : 'Download'}
              disabled={dlBusy !== null}
              onClick={() => void download('sa')}
            >
              {dlBusy === 'sa' && <Spinner size={13} />}
              Signed Subscription Agreement
            </Btn>
          </div>
          {dlError && <ErrorText>{dlError}</ErrorText>}
        </Card>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
          <Btn variant="primary" onClick={continueToBilling}>
            Continue
          </Btn>
        </div>
      </FunnelShell>
    );
  }

  // ── Review + sign ───────────────────────────────────────────────────────────
  return (
    <FunnelShell step={3} maxWidth={620}>
      <ScreenTitle
        title="Review and sign the agreements"
        sub="Both agreements must be accepted to continue. Your signature is logged with a timestamp, IP address, and a copy of the document you signed."
      />
      <div style={{ display: 'grid', gap: 16 }}>
        <LegalBlock
          title="Terms of Service"
          html={tos?.html ?? ''}
          checked={tosChecked}
          onChange={setTosChecked}
          downloadHref={tos ? BLANK_PDF.tos.href : undefined}
          label={
            <span>
              I agree to the <b>Terms of Service</b>
            </span>
          }
        />
        <LegalBlock
          title="Subscription Agreement"
          html={sa?.html ?? ''}
          checked={saChecked}
          onChange={setSaChecked}
          downloadHref={sa ? BLANK_PDF.sa.href : undefined}
          label={
            <span>
              I agree to the <b>Subscription Agreement</b>
            </span>
          }
        />

        <Card style={{ display: 'grid', gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="Save" size={15} style={{ color: 'var(--ink-3)' }} />
            <b style={{ fontSize: 13.5 }}>Sign electronically</b>
          </div>
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: '1fr 1fr' }}>
            <Field label="Full legal name">
              <TextInput
                value={signerName}
                placeholder="Jane Doe"
                onChange={(e) => {
                  setNameTouched(true);
                  setSignerName(e.target.value);
                }}
              />
            </Field>
            <Field label="Title">
              <TextInput
                value={signerTitle}
                placeholder="Managing Partner"
                onChange={(e) => setSignerTitle(e.target.value)}
              />
            </Field>
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--ink-3)', marginBottom: 4 }}>Signature</div>
            <div
              style={{
                borderBottom: '1.5px solid var(--border-strong)',
                padding: '6px 4px 8px',
                minHeight: 40,
                display: 'flex',
                alignItems: 'flex-end',
              }}
            >
              <span
                style={{
                  fontFamily: "Georgia, 'Times New Roman', serif",
                  fontStyle: 'italic',
                  fontSize: 26,
                  lineHeight: 1,
                  color: signerName.trim() ? 'var(--ink-1)' : 'var(--ink-4)',
                }}
              >
                {signerName.trim() ? `/s/  ${signerName.trim()}` : 'Type your name above to sign'}
              </span>
            </div>
          </div>
          <Checkbox checked={authority} onChange={setAuthority}>
            <span>
              I am authorized to bind <b>{orgName}</b> to these agreements, and I agree that my
              typed signature is the legal equivalent of my handwritten signature.
            </span>
          </Checkbox>
          <Checkbox checked={emailCopy} onChange={setEmailCopy}>
            <span>
              Email me a copy of the signed agreements{email ? <> ({email})</> : null}
            </span>
          </Checkbox>
        </Card>
      </div>

      {(error || docs.isError) && (
        <ErrorText style={{ textAlign: 'right' }}>{error ?? errorMessage(docs.error)}</ErrorText>
      )}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginTop: 20,
        }}
      >
        <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>
          Need custom terms?{' '}
          <a href="#" onClick={(e) => e.preventDefault()} style={{ color: 'var(--accent)' }}>
            Contact us
          </a>
        </span>
        <Btn variant="primary" disabled={!ok || busy} onClick={() => void submit()}>
          {busy && <Spinner size={13} color="#fff" />}
          Sign &amp; continue
        </Btn>
      </div>
    </FunnelShell>
  );
}
