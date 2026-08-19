/**
 * Program Elements vNext — Contact review queue (native rebuild of
 * src/pages/program-element/PersonCandidatesPage.tsx, which is antd
 * throughout).
 *
 * Behavior contract preserved verbatim:
 *  - capiro_admin sees the scored review queue; every other role sees the
 *    lightweight "suggest a name" form that feeds the same queue.
 *  - Same query key (['pe-person-candidates', 'open']) and endpoints, same
 *    confirm/reject mutation, same success/error copy, same validation copy.
 *  - The antd Popconfirm on Confirm becomes a CapiroModal with identical copy
 *    ("Confirm this person → PE link?" / "This sets the person's primary PE
 *    and attaches a citation." / "Confirm link").
 *  - Score chips keep the 85%/70% confidence thresholds.
 * Presentation is Capiro primitives + the module's pe-v2 vocabulary. The antd
 * numbered pager (pageSize 25) becomes a Prev/Next pager over the same 25-row
 * pages.
 */
import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useApi } from '../../../lib/use-api.js';
import { useMe } from '../../../lib/me.js';
import {
  getPersonCandidates,
  resolvePersonCandidate,
  suggestPersonForPe,
} from '../../../pages/program-element/api.js';
import type { PersonCandidate } from '../../../pages/program-element/types.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge, type CapiroBadgeTone } from '../../components/badges/index.js';
import { CapiroEmptyState, CapiroErrorState } from '../../components/feedback/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { CapiroInput } from '../../components/fields/index.js';
import { CapiroModal } from '../../components/overlays/index.js';
import {
  CapiroTable,
  CapiroTableBody,
  CapiroTableCell,
  CapiroTableHead,
  CapiroTableHeaderCell,
  CapiroTableWrap,
} from '../../components/tables/index.js';
import { PeSkeletonBlock } from './pe-primitives.js';
import './pe-workspace.css';

const PAGE_SIZE = 25;

function QueueBreadcrumb() {
  const navigate = useNavigate();
  return (
    <div className="pe-v2-breadcrumb">
      <button type="button" onClick={() => navigate('/program-elements')}>
        Program elements
      </button>
      <span>›</span>
      <span>Monitoring tools</span>
      <span>›</span>
      <span>Contact review queue</span>
    </div>
  );
}

/** Score -> colored confidence badge. Same 85%/70% thresholds as canonical. */
function ScoreBadge({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const tone: CapiroBadgeTone = score >= 0.85 ? 'success' : score >= 0.7 ? 'warning' : 'neutral';
  return <CapiroBadge tone={tone}>{pct}%</CapiroBadge>;
}

/** capiro_admin view: review queue with confirm/reject. */
function ReviewQueue() {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useCapiroToast();
  const [pending, setPending] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<PersonCandidate | null>(null);
  const [page, setPage] = useState(1);

  const queue = useQuery({
    queryKey: ['pe-person-candidates', 'open'],
    queryFn: () => getPersonCandidates(api, { status: 'open', limit: 200 }),
    staleTime: 30_000,
  });

  const resolve = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'confirm' | 'reject' }) =>
      resolvePersonCandidate(api, id, decision),
    onMutate: ({ id }) => setPending(id),
    onSuccess: (res, { decision }) => {
      toast.success(
        decision === 'confirm'
          ? res.linked
            ? 'Confirmed — person linked to PE.'
            : 'Confirmed (person was already linked).'
          : 'Rejected.',
      );
      void qc.invalidateQueries({ queryKey: ['pe-person-candidates'] });
    },
    onError: (e: unknown) => toast.error(`Failed: ${(e as Error).message}`),
    onSettled: () => setPending(null),
  });

  // antd's Table default sort: score descending.
  const rows = useMemo(
    () => [...(queue.data?.data ?? [])].sort((a, b) => b.score - a.score),
    [queue.data],
  );
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const clampedPage = Math.min(page, pageCount);
  const pageRows = rows.slice((clampedPage - 1) * PAGE_SIZE, clampedPage * PAGE_SIZE);

  return (
    <section className="pe-v2" data-screen-label="Contact review queue" style={{ minHeight: '100%' }}>
      <QueueBreadcrumb />
      <div className="pe-v2-page-head" style={{ borderBottom: 'none' }}>
        <div style={{ flex: 1, minWidth: 340 }}>
          <div className="pe-v2-page-title">Contact review queue</div>
          <div className="pe-v2-page-sub">
            Acquisition personnel matched to your monitored lines from public records. Confirm the
            ones you recognize; low-confidence matches never reach a client brief unconfirmed.
          </div>
        </div>
      </div>

      <div className="pe-v2-static-body">
        <div className="pe-v2-notice">
          Restricted lines never reach this queue. Where a program office is withheld from the
          public directory, Capiro records the restriction on the profile rather than sourcing the
          contact.
        </div>

        {queue.isError ? <CapiroErrorState title="Failed to load the queue." /> : null}
        <div className="pe-v2-card">
          {queue.isLoading ? (
            <div style={{ padding: 24 }}>
              <PeSkeletonBlock rows={6} />
            </div>
          ) : rows.length === 0 ? (
            <div style={{ padding: '32px 24px' }}>
              <CapiroEmptyState title="No open candidates — queue is clear." />
            </div>
          ) : (
            <>
              <CapiroTableWrap>
                <CapiroTable>
                  <CapiroTableHead>
                    <tr>
                      <CapiroTableHeaderCell>Person</CapiroTableHeaderCell>
                      <CapiroTableHeaderCell>Proposed PE</CapiroTableHeaderCell>
                      <CapiroTableHeaderCell aria-sort="descending">Score</CapiroTableHeaderCell>
                      <CapiroTableHeaderCell>Why it matched</CapiroTableHeaderCell>
                      <CapiroTableHeaderCell>Action</CapiroTableHeaderCell>
                    </tr>
                  </CapiroTableHead>
                  <CapiroTableBody>
                    {pageRows.map((r) => (
                      <tr key={r.id}>
                        <CapiroTableCell>
                          <div>
                            <strong>{r.person?.fullName ?? '(unknown)'}</strong>
                            <div style={{ fontSize: 12, color: 'var(--pev2-secondary)' }}>
                              {[r.person?.organization, r.person?.title].filter(Boolean).join(' · ') || '—'}
                            </div>
                          </div>
                        </CapiroTableCell>
                        <CapiroTableCell>
                          <div>
                            <span className="pe-v2-mono">{r.peCode}</span>
                            <div style={{ fontSize: 12, color: 'var(--pev2-secondary)' }}>
                              {r.programElement?.title ?? ''}
                              {r.programElement?.service ? ` (${r.programElement.service})` : ''}
                            </div>
                          </div>
                        </CapiroTableCell>
                        <CapiroTableCell>
                          <ScoreBadge score={r.score} />
                        </CapiroTableCell>
                        <CapiroTableCell>
                          <span
                            style={{
                              display: 'inline-block',
                              maxWidth: 320,
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              verticalAlign: 'bottom',
                            }}
                            title={r.matchBasis}
                          >
                            {r.matchBasis}
                          </span>
                        </CapiroTableCell>
                        <CapiroTableCell>
                          <div style={{ display: 'flex', gap: 8 }}>
                            <CapiroButton
                              variant="primary"
                              size="compact"
                              loading={pending === r.id}
                              onClick={() => setConfirming(r)}
                            >
                              Confirm
                            </CapiroButton>
                            <CapiroButton
                              size="compact"
                              loading={pending === r.id}
                              onClick={() => resolve.mutate({ id: r.id, decision: 'reject' })}
                            >
                              Reject
                            </CapiroButton>
                          </div>
                        </CapiroTableCell>
                      </tr>
                    ))}
                  </CapiroTableBody>
                </CapiroTable>
              </CapiroTableWrap>
              <div className="pe-v2-table-foot">
                <span>
                  {rows.length} OPEN CANDIDATE{rows.length === 1 ? '' : 'S'}
                </span>
                <span style={{ flex: 1, minWidth: 8 }} />
                <div className="pe-v2-pager">
                  <span style={{ color: 'var(--pev2-quiet)' }}>
                    PAGE {clampedPage} OF {pageCount}
                  </span>
                  <button
                    type="button"
                    className="pe-v2-quiet-link"
                    disabled={clampedPage <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    ← Prev
                  </button>
                  <button
                    type="button"
                    className="pe-v2-quiet-link"
                    disabled={clampedPage >= pageCount}
                    onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                  >
                    Next →
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      <CapiroModal
        open={confirming != null}
        title="Confirm this person → PE link?"
        onClose={() => setConfirming(null)}
      >
        <p style={{ fontSize: 13.5, lineHeight: 1.55, color: 'var(--pev2-body)', marginBottom: 16 }}>
          This sets the person&apos;s primary PE and attaches a citation.
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <CapiroButton size="compact" onClick={() => setConfirming(null)}>
            Cancel
          </CapiroButton>
          <CapiroButton
            variant="primary"
            size="compact"
            onClick={() => {
              if (confirming) resolve.mutate({ id: confirming.id, decision: 'confirm' });
              setConfirming(null);
            }}
          >
            Confirm link
          </CapiroButton>
        </div>
      </CapiroModal>
    </section>
  );
}

interface SuggestFields {
  peCode: string;
  fullName: string;
  roleTitle: string;
  organization: string;
  notes: string;
}

const EMPTY_SUGGEST: SuggestFields = { peCode: '', fullName: '', roleTitle: '', organization: '', notes: '' };

/** user_admin view: suggest a person they know for a PE. */
function SuggestForm() {
  const api = useApi();
  const toast = useCapiroToast();
  const [fields, setFields] = useState<SuggestFields>(EMPTY_SUGGEST);
  const [errors, setErrors] = useState<{ peCode?: string; fullName?: string }>({});

  const submit = useMutation({
    mutationFn: (v: SuggestFields) =>
      suggestPersonForPe(api, v.peCode.trim().toUpperCase(), {
        fullName: v.fullName.trim(),
        roleTitle: v.roleTitle.trim() || undefined,
        organization: v.organization.trim() || undefined,
        notes: v.notes.trim() || undefined,
      }),
    onSuccess: () => {
      toast.success('Thanks — your suggestion was submitted for review.');
      setFields(EMPTY_SUGGEST);
      setErrors({});
    },
    onError: (e: unknown) => toast.error(`Failed: ${(e as Error).message}`),
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next: { peCode?: string; fullName?: string } = {};
    if (!fields.peCode.trim()) next.peCode = 'Enter the PE code, e.g. 0604201A';
    if (!fields.fullName.trim()) next.fullName = 'Enter a name';
    setErrors(next);
    if (next.peCode || next.fullName) return;
    submit.mutate(fields);
  };

  const set = (key: keyof SuggestFields) => (event: FormEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const value = (event.target as HTMLInputElement).value;
    setFields((f) => ({ ...f, [key]: value }));
  };

  return (
    <section className="pe-v2" data-screen-label="Contact review queue" style={{ minHeight: '100%' }}>
      <QueueBreadcrumb />
      <div className="pe-v2-page-head" style={{ borderBottom: 'none' }}>
        <div style={{ flex: 1, minWidth: 340 }}>
          <div className="pe-v2-page-title">Contact review queue</div>
        </div>
      </div>
      <div className="pe-v2-static-body">
        <div className="pe-v2-card" style={{ maxWidth: 640 }}>
          <div className="pe-v2-card-head">
            <div className="pe-v2-card-title">Suggest a program contact</div>
          </div>
          <form className="pe-v2-form" onSubmit={onSubmit} noValidate>
            <p style={{ fontSize: 13.5, lineHeight: 1.55, color: 'var(--pev2-secondary)', margin: 0 }}>
              Know who runs a program? Tell us their name and the Program Element (PE) code. Our team reviews every
              suggestion before it&apos;s added — this never changes the data directly.
            </p>
            <CapiroInput
              label="Program Element (PE) code"
              placeholder="e.g. 0604201A"
              value={fields.peCode}
              onChange={set('peCode')}
              error={errors.peCode}
              disabled={submit.isPending}
            />
            <CapiroInput
              label="Person's full name"
              placeholder="e.g. Jane A. Smith"
              value={fields.fullName}
              onChange={set('fullName')}
              error={errors.fullName}
              disabled={submit.isPending}
            />
            <CapiroInput
              label="Role / title (optional)"
              placeholder="e.g. Project Manager, Apache Helicopters"
              value={fields.roleTitle}
              onChange={set('roleTitle')}
              disabled={submit.isPending}
            />
            <CapiroInput
              label="Organization (optional)"
              placeholder="e.g. CPE Aviation"
              value={fields.organization}
              onChange={set('organization')}
              disabled={submit.isPending}
            />
            <label className="capiro-field">
              <span className="capiro-field__label">Notes (optional)</span>
              <textarea
                className="capiro-input"
                rows={2}
                placeholder="How do you know this? Any context helps our review."
                value={fields.notes}
                onChange={set('notes')}
                disabled={submit.isPending}
              />
            </label>
            <div>
              <CapiroButton variant="primary" type="submit" loading={submit.isPending}>
                Submit suggestion
              </CapiroButton>
            </div>
          </form>
        </div>
      </div>
    </section>
  );
}

/**
 * Person → PE link management. capiro_admin sees the scored review queue;
 * user_admin sees a lightweight "suggest a name" form that feeds the same queue.
 */
export function PePersonCandidatesPage() {
  const me = useMe();
  const role = me.data?.role;

  if (me.isLoading) {
    return (
      <section className="pe-v2" style={{ minHeight: '100%' }}>
        <div className="pe-v2-static-body">
          <div className="pe-v2-card" style={{ padding: 24 }}>
            <PeSkeletonBlock rows={4} />
          </div>
        </div>
      </section>
    );
  }

  return role === 'capiro_admin' ? <ReviewQueue /> : <SuggestForm />;
}
