// 2A — Import profiles: LDA-filings flow (prototype ImportOverlay, wired to
// the real /api/firm endpoints). Stage 1: find your firm in LDA filings.
// Stage 2: pick filed clients to import.
import React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Btn, Icon, Modal, Spinner, Tag, TextInput } from '../../ui/primitives';
import { ErrorText, errorMessage } from '../funnel/shared';
import { useCapiroApi, type ImportCandidate } from '../../lib/capiro-api';

/** `$180K` / `$1.2M` compact money: <1000 → $N, <1M → $NK rounded, else $N.NM. */
export function formatCompactSpend(n: number): string {
  if (n < 1000) return `$${Math.round(n)}`;
  if (n < 1_000_000) return `$${Math.round(n / 1000)}K`;
  return `$${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

const REGISTRANT_KEY = ['capiro', 'registrant'] as const;
const CANDIDATES_KEY = ['capiro', 'import-candidates'] as const;

export function ImportOverlay({
  cap,
  imported,
  plan,
  billingAdmin,
  appBaseUrl,
  onClose,
  onImported,
}: {
  cap: number;
  /** Profiles already imported (from setup/state) — drives the cap math. */
  imported: number;
  plan: 'trial' | 'paid';
  billingAdmin: boolean;
  appBaseUrl: string;
  onClose: () => void;
  /** Called after a successful import run (created > 0) — parent refetches + transitions. */
  onImported: (created: number) => void;
}) {
  const api = useCapiroApi();
  const queryClient = useQueryClient();

  const registrant = useQuery({
    queryKey: REGISTRANT_KEY,
    queryFn: () => api.getRegistrant(),
    retry: false,
  });
  const candidatesQuery = useQuery({
    queryKey: CANDIDATES_KEY,
    queryFn: () => api.getImportCandidates(),
    enabled: registrant.data?.ldaRegistrantId != null,
    retry: false,
  });

  // Stage: search until the tenant has a registrant; "Change firm" overrides
  // back; "manual" is the type-it-in path for firms/clients not in LDA data.
  const [stageOverride, setStageOverride] = React.useState<'search' | 'table' | 'manual' | null>(
    null,
  );
  const stage = stageOverride ?? (registrant.data?.ldaRegistrantId != null ? 'table' : 'search');

  const [q, setQ] = React.useState('');
  const [submittedQ, setSubmittedQ] = React.useState('');
  const [settingFirm, setSettingFirm] = React.useState(false);
  const [sel, setSel] = React.useState<number[]>([]);
  const [importing, setImporting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Manual-add form (stage === 'manual').
  const [mName, setMName] = React.useState('');
  const [mWebsite, setMWebsite] = React.useState('');
  const [mDesc, setMDesc] = React.useState('');
  const [manualBusy, setManualBusy] = React.useState(false);
  const [manualAdded, setManualAdded] = React.useState(0);

  const search = useQuery({
    queryKey: ['capiro', 'lda-registrants', submittedQ],
    queryFn: () => api.searchLdaRegistrants(submittedQ),
    enabled: submittedQ.trim().length >= 2,
    retry: false,
  });

  const candidates: ImportCandidate[] = candidatesQuery.data?.candidates ?? [];
  const registrantName =
    candidatesQuery.data?.registrantName ?? registrant.data?.ldaRegistrantName ?? '';
  const notImported = candidates.filter((c) => c.onboardedAs == null);
  const remaining = Math.max(0, cap - imported);
  const capHit = sel.length >= remaining;

  const toggle = (id: number) =>
    setSel((s) =>
      s.includes(id) ? s.filter((x) => x !== id) : s.length < remaining ? [...s, id] : s,
    );

  const chooseFirm = async (registrantId: number) => {
    if (settingFirm) return;
    setSettingFirm(true);
    setError(null);
    try {
      await api.setRegistrant(registrantId);
      await queryClient.invalidateQueries({ queryKey: REGISTRANT_KEY });
      await queryClient.invalidateQueries({ queryKey: CANDIDATES_KEY });
      setSel([]);
      setStageOverride('table');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSettingFirm(false);
    }
  };

  /** Chunked POST /api/firm/import; close on clean success like the prototype. */
  const doImport = async (): Promise<number> => {
    if (importing || sel.length === 0) return 0;
    setImporting(true);
    setError(null);
    try {
      const result = await api.importClients(sel);
      await queryClient.invalidateQueries({ queryKey: CANDIDATES_KEY });
      if (result.created > 0) onImported(result.created);
      if (result.capMessage) {
        setError(result.capMessage);
        setSel([]);
        return result.created;
      }
      onClose();
      return result.created;
    } catch (err) {
      setError(errorMessage(err));
      return 0;
    } finally {
      setImporting(false);
    }
  };

  const remainingAfterManual = Math.max(0, cap - imported - manualAdded);

  const doManualAdd = async () => {
    const name = mName.trim();
    if (manualBusy || !name) return;
    if (remainingAfterManual <= 0) {
      setError(`That's your ${cap}-profile ${plan === 'paid' ? '' : 'trial '}limit.`);
      return;
    }
    setManualBusy(true);
    setError(null);
    try {
      await api.createClient({
        name,
        ...(mWebsite.trim() ? { website: mWebsite.trim() } : {}),
        ...(mDesc.trim() ? { description: mDesc.trim() } : {}),
      });
      setManualAdded((n) => n + 1);
      onImported(1); // completes the setup task + refreshes the dashboard count
      setMName('');
      setMWebsite('');
      setMDesc('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setManualBusy(false);
    }
  };

  if (stage === 'manual')
    return (
      <Modal title="Add a client manually" onClose={onClose} width={560}>
        <p
          style={{
            margin: '-2px 0 14px',
            fontSize: 13,
            color: 'var(--ink-2)',
            lineHeight: 1.6,
            textWrap: 'pretty',
          }}
        >
          Add clients that aren't in your LDA filings. Just the name is required to get started —
          you'll <b>finish setting up each client in your Portfolio</b> (issues, contacts, federal
          links, and more). Richer profiles give Meri the context it needs for the best results.
        </p>
        <div style={{ display: 'grid', gap: 12 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-2)' }}>
              Client name <span style={{ color: 'var(--critical)' }}>*</span>
            </label>
            <TextInput
              placeholder="e.g. Overland AI"
              value={mName}
              onChange={(e) => setMName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void doManualAdd();
              }}
              style={{ background: '#fff', marginTop: 4 }}
            />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-2)' }}>
              Website <span style={{ color: 'var(--ink-3)', fontWeight: 400 }}>(optional)</span>
            </label>
            <TextInput
              placeholder="acme.com"
              value={mWebsite}
              onChange={(e) => setMWebsite(e.target.value)}
              style={{ background: '#fff', marginTop: 4 }}
            />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-2)' }}>
              Short description{' '}
              <span style={{ color: 'var(--ink-3)', fontWeight: 400 }}>(optional)</span>
            </label>
            <TextInput
              placeholder="What they do / what you work on for them"
              value={mDesc}
              onChange={(e) => setMDesc(e.target.value)}
              style={{ background: '#fff', marginTop: 4 }}
            />
          </div>
        </div>
        {manualAdded > 0 && (
          <div
            style={{
              marginTop: 12,
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              fontSize: 12.5,
              color: 'var(--success)',
              fontWeight: 600,
            }}
          >
            <Icon name="CircleCheck" size={15} />
            {manualAdded} client{manualAdded === 1 ? '' : 's'} added · {remainingAfterManual} of{' '}
            {cap} profiles remaining
          </div>
        )}
        {error && <ErrorText>{error}</ErrorText>}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            borderTop: '1px solid var(--border-1)',
            paddingTop: 14,
            marginTop: 16,
          }}
        >
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              setError(null);
              setStageOverride('search');
            }}
            style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--accent)' }}
          >
            ← Search LDA filings instead
          </a>
          <span style={{ flex: 1 }} />
          <Btn onClick={onClose}>Done</Btn>
          <Btn
            variant="primary"
            disabled={!mName.trim() || manualBusy || remainingAfterManual <= 0}
            onClick={() => void doManualAdd()}
          >
            {manualBusy ? 'Adding…' : 'Add client'}
          </Btn>
        </div>
      </Modal>
    );

  if (stage === 'search')
    return (
      <Modal title="Find your firm in LDA filings" onClose={onClose} width={620}>
        <p
          style={{
            margin: '-2px 0 14px',
            fontSize: 13,
            color: 'var(--ink-2)',
            lineHeight: 1.6,
            textWrap: 'pretty',
          }}
        >
          Your firm files lobbying disclosures (LDA) under a registrant. Find it below to pull in
          your actual filed clients — each lands with its federal data pre-linked, no name-guessing.
        </p>
        <div style={{ display: 'flex', gap: 0 }}>
          <TextInput
            placeholder="Search your firm's name (e.g. Meridian Strategies)"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setSubmittedQ('');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && q.trim()) setSubmittedQ(q.trim());
            }}
            style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0, background: '#fff' }}
          />
          <button
            onClick={() => q.trim() && setSubmittedQ(q.trim())}
            style={{
              width: 46,
              border: 'none',
              borderRadius: '0 6px 6px 0',
              background: 'var(--bg-dark)',
              color: '#fff',
              cursor: 'pointer',
              display: 'grid',
              placeItems: 'center',
            }}
          >
            <Icon name="Search" size={15} />
          </button>
        </div>
        {search.isFetching && (
          <div
            style={{
              marginTop: 12,
              display: 'flex',
              alignItems: 'center',
              gap: 9,
              fontSize: 12.5,
              color: 'var(--ink-2)',
            }}
          >
            <Spinner />
            Searching LDA registrants…
          </div>
        )}
        {search.data && search.data.length === 0 && (
          <div style={{ marginTop: 12, fontSize: 12.5, color: 'var(--ink-3)', lineHeight: 1.55 }}>
            No registrants matched “{submittedQ}”. Check the spelling, or{' '}
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                setError(null);
                setMName(q.trim());
                setStageOverride('manual');
              }}
              style={{ color: 'var(--accent)', fontWeight: 600 }}
            >
              add your clients manually
            </a>
            .
          </div>
        )}
        {search.data && search.data.length > 0 && (
          <div
            style={{ marginTop: 12, display: 'grid', gap: 8, maxHeight: 340, overflowY: 'auto' }}
          >
            {search.data.map((hit) => (
              <div
                key={hit.id}
                onClick={() => void chooseFirm(hit.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  border: '1px solid var(--border-1)',
                  borderRadius: 8,
                  padding: '12px 14px',
                  cursor: settingFirm ? 'default' : 'pointer',
                  opacity: settingFirm ? 0.6 : 1,
                  background: 'var(--bg-surface-2)',
                }}
              >
                <Icon name="Landmark" size={16} style={{ color: 'var(--ink-3)' }} />
                <div style={{ flex: 1 }}>
                  <b style={{ fontSize: 13 }}>{hit.name}</b>
                  <div style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>
                    {[hit.city, hit.state].filter(Boolean).join(', ')}
                    {[hit.city, hit.state].filter(Boolean).length > 0 ? ' · ' : ''}
                    {hit.totalClients} filed clients
                  </div>
                </div>
                <Icon name="ChevronRight" size={15} style={{ color: 'var(--ink-3)' }} />
              </div>
            ))}
          </div>
        )}
        {error && <ErrorText>{error}</ErrorText>}
        <div style={{ display: 'flex', alignItems: 'center', marginTop: 16 }}>
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              setError(null);
              setStageOverride('manual');
            }}
            style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--accent)' }}
          >
            Can't find your firm? Add clients manually
          </a>
          <span style={{ flex: 1 }} />
          <Btn onClick={onClose}>Cancel</Btn>
        </div>
      </Modal>
    );

  return (
    <Modal title="Import your clients" onClose={onClose} width={720}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '-4px 0 12px' }}>
        <Icon name="Landmark" size={14} style={{ color: 'var(--ink-3)' }} />
        <b style={{ fontSize: 12.5 }}>{registrantName}</b>
        <span style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>
          · {candidates.length} filed clients
        </span>
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setStageOverride('search');
            setSel([]);
          }}
          style={{ marginLeft: 'auto', fontSize: 12.5, fontWeight: 600, color: 'var(--accent)' }}
        >
          Change firm
        </a>
      </div>
      <div style={{ border: '1px solid var(--border-1)', borderRadius: 8, overflow: 'hidden' }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '34px 1fr 130px 70px 70px',
            alignItems: 'center',
            padding: '8px 14px',
            background: 'var(--bg-surface-2)',
            borderBottom: '1px solid var(--border-1)',
            fontSize: 10.5,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            fontWeight: 700,
            color: 'var(--ink-3)',
          }}
        >
          <span></span>
          <span>Client</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            Lobbying spend <Icon name="ChevronsUpDown" size={11} />
          </span>
          <span>Filings</span>
          <span>Latest</span>
        </div>
        <div style={{ maxHeight: 320, overflowY: 'auto' }}>
          {candidatesQuery.isLoading && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 9,
                padding: '14px 14px',
                fontSize: 12.5,
                color: 'var(--ink-2)',
              }}
            >
              <Spinner />
              Loading your filed clients…
            </div>
          )}
          {candidates.map((c, i) => {
            const isImported = c.onboardedAs != null;
            const isSel = sel.includes(c.ldaClientId);
            const disabled = isImported || (!isSel && capHit);
            return (
              <div
                key={c.ldaClientId}
                onClick={() => !disabled && toggle(c.ldaClientId)}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '34px 1fr 130px 70px 70px',
                  alignItems: 'center',
                  padding: '9px 14px',
                  borderBottom: i < candidates.length - 1 ? '1px solid var(--border-1)' : 'none',
                  cursor: disabled ? 'default' : 'pointer',
                  opacity: !isImported && disabled ? 0.45 : 1,
                  background: isSel ? 'var(--accent-soft)' : '#fff',
                }}
              >
                <span
                  style={{
                    width: 15,
                    height: 15,
                    borderRadius: 4,
                    display: 'grid',
                    placeItems: 'center',
                    border: isSel ? '1px solid var(--accent)' : '1px solid var(--border-strong)',
                    background: isSel ? 'var(--accent)' : isImported ? 'var(--bg-sunken)' : '#fff',
                  }}
                >
                  {isSel && (
                    <Icon name="Check" size={10} strokeWidth={3} style={{ color: '#fff' }} />
                  )}
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <b
                    style={{
                      fontSize: 12.5,
                      letterSpacing: '0.01em',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {c.name}
                  </b>
                  {isImported && <Tag tone="neutral">Imported</Tag>}
                </span>
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                    letterSpacing: 0,
                    color: 'var(--ink-2)',
                  }}
                >
                  {formatCompactSpend(c.totalSpend)}
                </span>
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                    letterSpacing: 0,
                    color: 'var(--ink-2)',
                  }}
                >
                  {c.filings}
                </span>
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                    letterSpacing: 0,
                    color: 'var(--ink-2)',
                  }}
                >
                  {c.latestFilingYear ?? '—'}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setSel(notImported.slice(0, remaining).map((c) => c.ldaClientId));
          }}
          style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--accent)' }}
        >
          Select all {notImported.length} not-yet-imported
        </a>
        <span
          style={{
            fontSize: 12,
            color: 'var(--ink-3)',
            fontFamily: 'var(--font-mono)',
            letterSpacing: 0,
          }}
        >
          {imported + sel.length} / {cap} profiles
        </span>
      </div>
      {capHit && notImported.length > sel.length && plan !== 'paid' && (
        <div
          style={{
            marginTop: 12,
            display: 'flex',
            gap: 10,
            alignItems: 'center',
            background: 'var(--accent-soft)',
            borderRadius: 6,
            padding: '11px 14px',
          }}
        >
          <Icon name="Sparkles" size={15} style={{ color: 'var(--accent-ink)', flexShrink: 0 }} />
          <span style={{ flex: 1, fontSize: 12.5, color: 'var(--accent-ink)', lineHeight: 1.5 }}>
            That's your {cap}-profile trial limit — {notImported.length - sel.length} filed clients
            still waiting.{' '}
            {billingAdmin
              ? 'Subscribe to bring in your full portfolio.'
              : 'Ask a Super Admin to subscribe for the full portfolio.'}
          </span>
          {billingAdmin && (
            <Btn
              variant="primary"
              size="sm"
              onClick={() =>
                void (async () => {
                  if (sel.length > 0) await doImport();
                  window.location.assign(`${appBaseUrl}/onboarding/subscribe`);
                })()
              }
            >
              View subscription options
            </Btn>
          )}
        </div>
      )}
      {capHit && plan === 'paid' && notImported.length > sel.length && (
        <div style={{ marginTop: 12, fontSize: 12, color: 'var(--ink-3)' }}>
          Profile cap reached ({cap}).{' '}
          {billingAdmin
            ? 'Raise your tier from Settings › Billing.'
            : 'Contact a Super Admin to add more client profiles.'}
        </div>
      )}
      {error && <ErrorText>{error}</ErrorText>}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          borderTop: '1px solid var(--border-1)',
          paddingTop: 14,
          marginTop: 14,
        }}
      >
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setError(null);
            setStageOverride('manual');
          }}
          style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--accent)' }}
        >
          + Add a client manually
        </a>
        <span style={{ flex: 1 }} />
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn
          variant="primary"
          disabled={sel.length === 0 || importing}
          onClick={() => void doImport()}
        >
          {importing
            ? 'Importing…'
            : `Import ${sel.length > 0 ? sel.length + ' ' : ''}client${sel.length === 1 ? '' : 's'}`}
        </Btn>
      </div>
    </Modal>
  );
}
