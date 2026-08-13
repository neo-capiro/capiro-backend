import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import { useMe } from '../../../lib/me.js';
import { hasAtLeast } from '@capiro/shared';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroModal } from '../../components/overlays/index.js';

/**
 * Import with LDA (PORTFOLIO-HANDOFF §7.1.1).
 *
 * Bulk client onboarding from Lobbying Disclosure Act filings. The contract is
 * propose → review → explicit apply — the import never writes silently.
 *
 * Flow (mirrors the canonical FirmOnboardingWizard):
 *   1. firm   — if the tenant has no registrant anchor yet, search LDA registrants
 *               (GET /firm/lda-registrants?q=) and set it (PUT /firm/registrant).
 *               If the anchor is already set we skip straight to step 2.
 *   2. select — list the firm's filed clients (GET /firm/import-candidates) with
 *               spend + recency; multi-select the ones to onboard. Already-imported
 *               candidates are shown but locked (onboardedAs).
 *   3. result — POST /firm/import; the server runs the prepopulation cascade
 *               per client.
 *
 * Required states implemented: idle · running · no matches · permission denied
 * (403) · review-and-confirm · apply failure · success with a count ·
 * registrant-not-configured (the "source unavailable" analogue when the tenant
 * has not anchored an LDA registrant).
 */

interface RegistrantHit {
  id: number;
  name: string;
  city: string | null;
  state: string | null;
  totalClients: number;
  totalFilings: number;
}

interface ImportCandidate {
  ldaClientId: number;
  name: string;
  filings: number;
  latestFilingYear: number | null;
  totalSpend: number;
  onboardedAs: string | null;
}

interface ImportCandidatesResponse {
  registrantId: number | null;
  registrantName: string | null;
  candidates: ImportCandidate[];
}

interface ImportResult {
  created?: number;
  imported?: number;
  skipped?: number;
}

type Stage = 'firm' | 'select';

const CURRENCY = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

export function ImportWithLdaModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const me = useMe();
  const canManage = Boolean(me.data && hasAtLeast(me.data.role, 'user_admin'));

  const [stage, setStage] = useState<Stage>('firm');
  const [search, setSearch] = useState('');
  const [submittedSearch, setSubmittedSearch] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [appliedCount, setAppliedCount] = useState<number | null>(null);
  // One-shot guard so the open-time auto-advance to the select step fires once.
  const [didInitStage, setDidInitStage] = useState(false);

  // Current firm anchor. Drives the initial stage: anchored → jump to select.
  const registrant = useQuery<{ ldaRegistrantId: number | null; ldaRegistrantName: string | null }>(
    {
      queryKey: ['firm', 'registrant'],
      queryFn: async () =>
        (await api.get<{ ldaRegistrantId: number | null; ldaRegistrantName: string | null }>(
          '/api/firm/registrant',
        )).data,
      enabled: open,
    },
  );

  const hasAnchor = Boolean(registrant.data?.ldaRegistrantId);

  // Registrant search (only when on the firm step and a query was submitted).
  const registrantSearch = useQuery<RegistrantHit[]>({
    queryKey: ['firm', 'lda-registrants', submittedSearch],
    queryFn: async () =>
      (await api.get<RegistrantHit[]>('/api/firm/lda-registrants', {
        params: { q: submittedSearch },
      })).data,
    enabled: open && stage === 'firm' && submittedSearch.trim().length >= 2,
  });

  const candidates = useQuery<ImportCandidatesResponse>({
    queryKey: ['firm', 'import-candidates'],
    queryFn: async () => (await api.get<ImportCandidatesResponse>('/api/firm/import-candidates')).data,
    enabled: open && stage === 'select' && hasAnchor,
  });

  const setRegistrant = useMutation({
    mutationFn: async (registrantId: number) =>
      (await api.put<{ ldaRegistrantId: number; ldaRegistrantName: string }>(
        '/api/firm/registrant',
        { registrantId },
      )).data,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['firm', 'registrant'] });
      void queryClient.invalidateQueries({ queryKey: ['firm', 'import-candidates'] });
      setStage('select');
    },
  });

  const apply = useMutation({
    mutationFn: async (ldaClientIds: number[]) =>
      (await api.post<ImportResult>('/api/firm/import', { ldaClientIds })).data,
    onSuccess: (result) => {
      const count = result.created ?? result.imported ?? 0;
      setAppliedCount(count);
      // Invalidate the client list and the pulse aggregates so the index
      // reflects the new records (§7.1.1 "On apply").
      void queryClient.invalidateQueries({ queryKey: ['clients'] });
      void queryClient.invalidateQueries({ queryKey: ['intelligence', 'portfolio-summary'] });
    },
  });

  // Once per open: when the registrant query resolves, jump straight to the
  // select step if the firm anchor already exists (no need to re-pick the firm).
  // After this one-shot init, `stage` is authoritative — so "Change firm" can
  // send the user back to the firm step even though an anchor exists.
  useEffect(() => {
    if (!open || didInitStage || registrant.isLoading) return;
    setDidInitStage(true);
    if (hasAnchor) setStage('select');
  }, [open, didInitStage, registrant.isLoading, hasAnchor]);

  const pending = useMemo(
    () => (candidates.data?.candidates ?? []).filter((c) => c.onboardedAs == null),
    [candidates.data],
  );

  const toggle = (id: number) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const handleClose = () => {
    setStage('firm');
    setSearch('');
    setSubmittedSearch('');
    setSelected(new Set());
    setAppliedCount(null);
    setDidInitStage(false);
    apply.reset();
    setRegistrant.reset();
    onClose();
  };

  const renderFirmStep = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <p className="capiro-portfolio__meta" style={{ marginBottom: 0 }}>
        Your firm files lobbying disclosures (LDA) under a registrant. Find it below to pull in
        your actual filed clients — each lands with its federal data pre-linked, no name-guessing.
      </p>
      {!canManage && (
        <div className="capiro-portfolio__state" role="status">
          Setting the firm and importing requires an admin. Ask an admin to complete this step.
        </div>
      )}
      <div>
        <input
          className="capiro-input"
          placeholder="Search your firm's name (e.g. Maven Advocacy)"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') setSubmittedSearch(search.trim());
          }}
          style={{ width: '100%' }}
        />
        <div style={{ marginTop: 8 }}>
          <CapiroButton
            variant="quiet"
            size="compact"
            onClick={() => setSubmittedSearch(search.trim())}
            disabled={search.trim().length < 2}
          >
            Search
          </CapiroButton>
        </div>
      </div>
      {submittedSearch.trim().length >= 2 && (
        <div>
          {registrantSearch.isLoading ? (
            <div aria-busy="true">
              <div className="capiro-portfolio__skeleton" style={{ height: 120 }} />
            </div>
          ) : registrantSearch.isError ? (
            <div className="capiro-portfolio__state capiro-portfolio__state--error" role="status">
              The registrant search failed.{' '}
              <CapiroButton variant="quiet" size="compact" onClick={() => void registrantSearch.refetch()}>
                Retry
              </CapiroButton>
            </div>
          ) : (registrantSearch.data ?? []).length === 0 ? (
            <div className="capiro-portfolio__state" role="status">
              No matching registrants. Try a shorter or different name.
            </div>
          ) : (
            <ul className="capiro-portfolio-lda__list">
              {(registrantSearch.data ?? []).map((r) => (
                <li key={r.id}>
                  <div className="capiro-portfolio-lda__row" style={{ cursor: 'default' }}>
                    <span className="capiro-portfolio-lda__name">{r.name}</span>
                    <span className="capiro-portfolio__meta">
                      {[r.city, r.state].filter(Boolean).join(', ') || '—'} · {r.totalClients}{' '}
                      client{r.totalClients === 1 ? '' : 's'} · {r.totalFilings} filing
                      {r.totalFilings === 1 ? '' : 's'}
                    </span>
                    <span style={{ marginLeft: 'auto' }}>
                      <CapiroButton
                        variant="primary"
                        size="compact"
                        disabled={!canManage}
                        loading={setRegistrant.isPending && setRegistrant.variables === r.id}
                        onClick={() => setRegistrant.mutate(r.id)}
                      >
                        This is us
                      </CapiroButton>
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );

  const renderBody = () => {
    // Success with a count.
    if (appliedCount != null) {
      return (
        <div className="capiro-portfolio__state capiro-portfolio__state--success" role="status">
          <strong>{appliedCount}</strong> client{appliedCount === 1 ? '' : 's'} imported. They are
          now in the client list and the portfolio pulse.
          <div style={{ marginTop: 12 }}>
            <CapiroButton variant="primary" size="compact" onClick={handleClose}>
              Done
            </CapiroButton>
          </div>
        </div>
      );
    }

    // Firm selection step.
    if (stage === 'firm') {
      return renderFirmStep();
    }

    // Running.
    if (candidates.isLoading) {
      return (
        <div aria-busy="true">
          <p className="capiro-portfolio__meta">Looking up matched registrants…</p>
          <div className="capiro-portfolio__skeleton" style={{ height: 200 }} />
        </div>
      );
    }

    // Source unavailable / permission denied.
    if (candidates.isError) {
      const status = (candidates.error as { response?: { status?: number } })?.response?.status;
      const denied = status === 403;
      return (
        <div className="capiro-portfolio__state capiro-portfolio__state--error" role="status">
          {denied
            ? 'You do not have permission to import clients. Importing requires an account administrator.'
            : 'The LDA source could not be reached. No client records were changed.'}
          <div style={{ marginTop: 12 }}>
            <CapiroButton variant="quiet" size="compact" onClick={() => void candidates.refetch()}>
              Retry
            </CapiroButton>
          </div>
        </div>
      );
    }

    const data = candidates.data;

    // Registrant not configured — the LDA source is not anchored for this tenant.
    if (!data || data.registrantId == null) {
      return (
        <div className="capiro-portfolio__state" role="status">
          Import with LDA needs a lobbying registrant linked to your firm before it can match
          filings to clients.{' '}
          {canManage ? (
            <>
              <CapiroButton variant="quiet" size="compact" onClick={() => setStage('firm')}>
                Find your firm
              </CapiroButton>{' '}
              to link the registrant, then reopen this import.
            </>
          ) : (
            'Ask an admin to link the registrant in Settings, then reopen this import.'
          )}
        </div>
      );
    }

    // No matches.
    if (pending.length === 0) {
      return (
        <div className="capiro-portfolio__state" role="status">
          No new clients to import from <strong>{data.registrantName}</strong> — every matched
          filing is already in your portfolio.
          {canManage && (
            <div style={{ marginTop: 12 }}>
              <CapiroButton variant="quiet" size="compact" onClick={() => setStage('firm')}>
                Change firm
              </CapiroButton>
            </div>
          )}
        </div>
      );
    }

    // Review-and-confirm.
    return (
      <>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 12,
          }}
        >
          <p className="capiro-portfolio__meta" style={{ margin: 0 }}>
            {pending.length} matched client{pending.length === 1 ? '' : 's'} from{' '}
            <strong>{data.registrantName}</strong>. Select which to add — nothing is created until
            you confirm.
          </p>
          {canManage && (
            <CapiroButton variant="quiet" size="compact" onClick={() => setStage('firm')}>
              Change firm
            </CapiroButton>
          )}
        </div>
        {apply.isError ? (
          <div className="capiro-portfolio__state capiro-portfolio__state--error" role="alert">
            The import failed. No client records were created — your selection is unchanged, so you
            can retry.
          </div>
        ) : null}
        <ul className="capiro-portfolio-lda__list">
          {pending.map((c) => (
            <li key={c.ldaClientId}>
              <label className="capiro-portfolio-lda__row">
                <input
                  type="checkbox"
                  checked={selected.has(c.ldaClientId)}
                  onChange={() => toggle(c.ldaClientId)}
                />
                <span className="capiro-portfolio-lda__name">{c.name}</span>
                <span className="capiro-portfolio__meta">
                  {c.filings} filing{c.filings === 1 ? '' : 's'}
                  {c.latestFilingYear ? ` · latest ${c.latestFilingYear}` : ''} ·{' '}
                  {CURRENCY.format(c.totalSpend)}
                </span>
              </label>
            </li>
          ))}
        </ul>
        <div className="capiro-portfolio-lda__foot">
          <CapiroButton variant="quiet" size="compact" onClick={handleClose}>
            Cancel
          </CapiroButton>
          <CapiroButton
            variant="primary"
            size="compact"
            disabled={selected.size === 0 || !canManage}
            loading={apply.isPending}
            onClick={() => apply.mutate(Array.from(selected))}
          >
            Import {selected.size > 0 ? selected.size : ''} client{selected.size === 1 ? '' : 's'}
          </CapiroButton>
        </div>
      </>
    );
  };

  return (
    <CapiroModal
      open={open}
      title={stage === 'firm' ? 'Find your firm in LDA filings' : 'Import with LDA'}
      onClose={handleClose}
    >
      {renderBody()}
    </CapiroModal>
  );
}
