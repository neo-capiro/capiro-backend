// 1.5 Legal Agreements — F1Legal (prototype/02-flow1.jsx). The doc bodies come
// from GET /funnel/legal and render inside the prototype's exact scroll box.
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Btn, Card, Checkbox, FunnelShell, Icon, ScreenTitle } from '../../ui/primitives';
import { useAdvanceSession, useFunnelApi, type LegalDoc } from '../../lib/funnel';
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

/** Print-friendly window of the agreement html — real PDF export lands later. */
function openPrintWindow(title: string, html: string) {
  const win = window.open('', '_blank');
  if (!win) return;
  win.document.write(
    `<!doctype html><html><head><title>${title}</title><style>body{font-family:Georgia,'Times New Roman',serif;color:#15161A;line-height:1.6;max-width:640px;margin:40px auto;padding:0 24px}</style></head><body>${html}</body></html>`,
  );
  win.document.close();
  win.focus();
  win.print();
}

export function LegalPage() {
  const navigate = useNavigate();
  const api = useFunnelApi();
  const advanceSession = useAdvanceSession();
  const [tosChecked, setTosChecked] = React.useState(false);
  const [saChecked, setSaChecked] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const docs = useQuery({
    queryKey: ['funnel', 'legal'],
    queryFn: () => api.getLegal(),
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
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                if (sa) openPrintWindow('Capiro Subscription Agreement', sa.html);
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
