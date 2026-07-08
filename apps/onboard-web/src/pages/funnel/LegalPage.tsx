// 1.5 Legal Agreements — F1Legal (prototype/02-flow1.jsx). The doc bodies come
// from GET /funnel/legal and render inside the prototype's exact scroll box.
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Btn, Card, Checkbox, FunnelShell, Icon, ScreenTitle } from '../../ui/primitives';
import { useAdvanceSession, useFunnelApi, useFunnelSession, type LegalDoc } from '../../lib/funnel';
import { ErrorText, errorMessage } from './shared';

function LegalBlock({
  title,
  html,
  checked,
  onChange,
  label,
  extra,
}: {
  title: string;
  html: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: React.ReactNode;
  extra?: React.ReactNode;
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
        {extra && <span style={{ marginLeft: 'auto' }}>{extra}</span>}
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

/**
 * Open the agreement in a new tab as a self-contained, printable document.
 * We build a Blob URL and open it with window.open — NO synchronous
 * document.write into the opener and NO auto-triggered window.print(), which
 * is what previously froze/crashed the funnel tab. The user prints or saves as
 * PDF from the "Save as PDF" control inside the opened tab.
 */
function openAgreementTab(title: string, html: string) {
  const doc = `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${title}</title><style>
      body{font-family:Georgia,'Times New Roman',serif;color:#15161A;line-height:1.6;max-width:680px;margin:0 auto;padding:88px 24px 64px}
      .doc-bar{position:fixed;top:0;left:0;right:0;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 20px;background:#fff;border-bottom:1px solid #e5e7eb;font-family:-apple-system,Segoe UI,Roboto,sans-serif}
      .doc-bar b{font-size:13px}
      .doc-bar button{font:inherit;font-size:12.5px;font-weight:600;color:#fff;background:#2A57CE;border:none;border-radius:6px;padding:7px 14px;cursor:pointer}
      @media print{.doc-bar{display:none}body{padding-top:24px}}
    </style></head><body><div class="doc-bar"><b>${title}</b><button onclick="window.print()">Save as PDF / Print</button></div>${html}</body></html>`;
  const url = URL.createObjectURL(new Blob([doc], { type: 'text/html' }));
  const win = window.open(url, '_blank');
  if (!win) {
    // Popup blocked — fall back to a file download so the click still does something.
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title}.html`;
    a.click();
  }
  // Revoke after the new tab has had time to load the Blob.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** "Download PDF" affordance shared by both agreement blocks. */
function DownloadLink({ onClick }: { onClick: () => void }) {
  return (
    <a
      href="#"
      onClick={(e) => {
        e.preventDefault();
        onClick();
      }}
      style={{
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
  );
}

export function LegalPage() {
  const navigate = useNavigate();
  const api = useFunnelApi();
  const advanceSession = useAdvanceSession();
  const session = useFunnelSession();
  const [tosChecked, setTosChecked] = React.useState(false);
  const [saChecked, setSaChecked] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

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

  const ok = tosChecked && saChecked && !!tos && !!sa;

  const submit = async () => {
    if (!ok || busy || !tos || !sa) return;
    setBusy(true);
    setError(null);
    try {
      await api.acceptLegal({ tosVersion: tos.version, saVersion: sa.version });
      advanceSession({ state: 'legal_accepted' });
      navigate('/billing');
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <FunnelShell step={3} maxWidth={620}>
      <ScreenTitle
        title="Review and accept the agreements"
        sub="Both agreements must be accepted to continue. Acceptance is logged with a timestamp."
      />
      <div style={{ display: 'grid', gap: 16 }}>
        <LegalBlock
          title="Terms of Service"
          html={tos?.html ?? ''}
          checked={tosChecked}
          onChange={setTosChecked}
          label={
            <span>
              I agree to the <b>Terms of Service</b>
            </span>
          }
          extra={
            tos ? (
              <DownloadLink onClick={() => openAgreementTab('Capiro Terms of Service', tos.html)} />
            ) : undefined
          }
        />
        <LegalBlock
          title="Subscription Agreement"
          html={sa?.html ?? ''}
          checked={saChecked}
          onChange={setSaChecked}
          label={
            <span>
              I agree to the <b>SA</b>
            </span>
          }
          extra={
            sa ? (
              <DownloadLink
                onClick={() => openAgreementTab('Capiro Subscription Agreement', sa.html)}
              />
            ) : undefined
          }
        />
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
          Continue
        </Btn>
      </div>
    </FunnelShell>
  );
}
