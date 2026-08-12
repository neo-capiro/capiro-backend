import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroModal } from '../../components/overlays/index.js';

/**
 * Import with LDA (PORTFOLIO-HANDOFF §7.1.1).
 *
 * Bulk client onboarding from Lobbying Disclosure Act filings. The contract is
 * propose → review → explicit apply — the import never writes silently. The
 * review step reads the registrant's matched filings (`firm/import-candidates`);
 * the apply step posts the confirmed selection (`firm/import`). Both endpoints
 * already exist on the live backend (see `docs/handoff/portfolio-api-inventory.md`).
 *
 * Required states implemented: idle · running · no matches · permission denied
 * (403) · review-and-confirm · apply failure · success with a count ·
 * registrant-not-configured (the "source unavailable" analogue when the tenant
 * has not anchored an LDA registrant).
 */

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

const CURRENCY = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

export function ImportWithLdaModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [appliedCount, setAppliedCount] = useState<number | null>(null);

  const candidates = useQuery<ImportCandidatesResponse>({
    queryKey: ['firm', 'import-candidates'],
    queryFn: async () => (await api.get<ImportCandidatesResponse>('/api/firm/import-candidates')).data,
    enabled: open,
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
    setSelected(new Set());
    setAppliedCount(null);
    apply.reset();
    onClose();
  };

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
          filings to clients. Link the registrant in Settings, then reopen this import.
        </div>
      );
    }

    // No matches.
    if (pending.length === 0) {
      return (
        <div className="capiro-portfolio__state" role="status">
          No new clients to import from <strong>{data.registrantName}</strong> — every matched
          filing is already in your portfolio.
        </div>
      );
    }

    // Review-and-confirm.
    return (
      <>
        <p className="capiro-portfolio__meta">
          {pending.length} matched client{pending.length === 1 ? '' : 's'} from{' '}
          <strong>{data.registrantName}</strong>. Select which to add — nothing is created until you
          confirm.
        </p>
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
            disabled={selected.size === 0}
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
    <CapiroModal open={open} title="Import with LDA" onClose={handleClose}>
      {renderBody()}
    </CapiroModal>
  );
}
