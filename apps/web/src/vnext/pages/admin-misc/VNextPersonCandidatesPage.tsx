/**
 * vNext re-skin of pages/program-element/PersonCandidatesPage.tsx — person →
 * PE link management. capiro_admin sees the scored review queue
 * (confirm / reject over the same endpoints + query keys); user_admin sees the
 * lightweight "suggest a name" form that feeds the same queue. Mounted as the
 * "Person candidates" tab of the vNext Analyst Console (the canonical
 * /program-elements/contacts route stays canonical — it belongs to the PE
 * module surface, not this tranche).
 */
import { useState } from 'react';
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
import { CapiroBadge } from '../../components/badges/index.js';
import { CapiroInput } from '../../components/fields/index.js';
import { CapiroEmptyState, CapiroSkeleton } from '../../components/feedback/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import {
  CapiroTable,
  CapiroTableBody,
  CapiroTableCell,
  CapiroTableHead,
  CapiroTableHeaderCell,
  CapiroTableWrap,
} from '../../components/tables/index.js';
import {
  SvCallout,
  SvCard,
  SvPagination,
  SvTextArea,
  useSvConfirm,
  useSvPagination,
} from '../settings/settings-ui.js';

function QueueBreadcrumb() {
  const navigate = useNavigate();
  return (
    <nav className="stv-row stv-small" aria-label="Breadcrumb" style={{ gap: 6 }}>
      <button
        type="button"
        className="amx-chip-button stv-muted stv-small"
        onClick={() => navigate('/program-elements')}
      >
        Program elements
      </button>
      <span className="stv-muted">›</span>
      <span className="stv-muted">Monitoring tools</span>
      <span className="stv-muted">›</span>
      <span className="stv-muted">Contact review queue</span>
    </nav>
  );
}

/** Score -> toned confidence badge (same thresholds as canonical scoreTag). */
function scoreBadge(score: number) {
  const pct = Math.round(score * 100);
  const tone = score >= 0.85 ? 'success' : score >= 0.7 ? 'warning' : 'neutral';
  return <CapiroBadge tone={tone}>{pct}%</CapiroBadge>;
}

/** capiro_admin view: review queue with confirm/reject. */
function ReviewQueue() {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useCapiroToast();
  const { confirm, dialog } = useSvConfirm();
  const [pending, setPending] = useState<string | null>(null);

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

  const rows = queue.data?.data ?? [];
  const { pageRows, currentPage, pageCount, setPage } = useSvPagination(rows, 25);

  return (
    <div className="stv-stack">
      <QueueBreadcrumb />
      <div>
        <h2 className="stv-card__title" style={{ margin: 0 }}>
          Contact review queue
        </h2>
        <p className="stv-card__desc">
          Acquisition personnel matched to your monitored lines from public records. Confirm the
          ones you recognize; low-confidence matches never reach a client brief unconfirmed.
        </p>
      </div>

      <SvCallout
        kind="info"
        title="Restricted lines never reach this queue."
        description="Where a program office is withheld from the public directory, Capiro records the restriction on the profile rather than sourcing the contact."
      />

      {queue.isError ? <SvCallout kind="error" title="Failed to load the queue." /> : null}

      {queue.isLoading ? (
        <div className="stv-stack" aria-label="Loading contact review queue">
          <CapiroSkeleton height={16} />
          <CapiroSkeleton height={16} width="70%" />
        </div>
      ) : rows.length === 0 ? (
        <CapiroEmptyState title="No open candidates — queue is clear." />
      ) : (
        <SvCard>
          <CapiroTableWrap>
            <CapiroTable>
              <CapiroTableHead>
                <tr>
                  <CapiroTableHeaderCell>Person</CapiroTableHeaderCell>
                  <CapiroTableHeaderCell>Proposed PE</CapiroTableHeaderCell>
                  <CapiroTableHeaderCell>Score</CapiroTableHeaderCell>
                  <CapiroTableHeaderCell>Why it matched</CapiroTableHeaderCell>
                  <CapiroTableHeaderCell>Action</CapiroTableHeaderCell>
                </tr>
              </CapiroTableHead>
              <CapiroTableBody>
                {pageRows.map((r: PersonCandidate) => (
                  <tr key={r.id}>
                    <CapiroTableCell>
                      <span className="stv-strong">{r.person?.fullName ?? '(unknown)'}</span>
                      <div className="amx-cell-sub">
                        {[r.person?.organization, r.person?.title].filter(Boolean).join(' · ') || '—'}
                      </div>
                    </CapiroTableCell>
                    <CapiroTableCell>
                      <span className="stv-code">{r.peCode}</span>
                      <div className="amx-cell-sub">
                        {r.programElement?.title ?? ''}
                        {r.programElement?.service ? ` (${r.programElement.service})` : ''}
                      </div>
                    </CapiroTableCell>
                    <CapiroTableCell>{scoreBadge(r.score)}</CapiroTableCell>
                    <CapiroTableCell>{r.matchBasis}</CapiroTableCell>
                    <CapiroTableCell>
                      <span className="amx-inline-actions">
                        <CapiroButton
                          size="compact"
                          variant="primary"
                          loading={pending === r.id}
                          onClick={() =>
                            confirm({
                              title: 'Confirm this person → PE link?',
                              body: "This sets the person's primary PE and attaches a citation.",
                              okText: 'Confirm link',
                              onOk: () => resolve.mutateAsync({ id: r.id, decision: 'confirm' }),
                            })
                          }
                        >
                          Confirm
                        </CapiroButton>
                        <CapiroButton
                          size="compact"
                          className="stv-btn-danger"
                          loading={pending === r.id}
                          onClick={() => resolve.mutate({ id: r.id, decision: 'reject' })}
                        >
                          Reject
                        </CapiroButton>
                      </span>
                    </CapiroTableCell>
                  </tr>
                ))}
              </CapiroTableBody>
            </CapiroTable>
          </CapiroTableWrap>
          <SvPagination currentPage={currentPage} pageCount={pageCount} onPage={setPage} />
        </SvCard>
      )}
      {dialog}
    </div>
  );
}

/** user_admin view: suggest a person they know for a PE. */
function SuggestForm() {
  const api = useApi();
  const toast = useCapiroToast();
  const [form, setForm] = useState({
    peCode: '',
    fullName: '',
    roleTitle: '',
    organization: '',
    notes: '',
  });
  const [errors, setErrors] = useState<{ peCode?: string; fullName?: string }>({});

  const submit = useMutation({
    mutationFn: (v: typeof form) =>
      suggestPersonForPe(api, v.peCode.trim().toUpperCase(), {
        fullName: v.fullName.trim(),
        roleTitle: v.roleTitle.trim() || undefined,
        organization: v.organization.trim() || undefined,
        notes: v.notes.trim() || undefined,
      }),
    onSuccess: () => {
      toast.success('Thanks — your suggestion was submitted for review.');
      setForm({ peCode: '', fullName: '', roleTitle: '', organization: '', notes: '' });
    },
    onError: (e: unknown) => toast.error(`Failed: ${(e as Error).message}`),
  });

  function handleSubmit() {
    const next: { peCode?: string; fullName?: string } = {};
    if (!form.peCode.trim()) next.peCode = 'Enter the PE code, e.g. 0604201A';
    if (!form.fullName.trim()) next.fullName = 'Enter a name';
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    submit.mutate(form);
  }

  return (
    <div className="stv-stack">
      <QueueBreadcrumb />
      <h2 className="stv-card__title" style={{ margin: 0 }}>
        Contact review queue
      </h2>
      <SvCard title="Suggest a program contact" className="amx-body--narrow">
        <div className="stv-stack">
          <p className="stv-muted" style={{ margin: 0 }}>
            Know who runs a program? Tell us their name and the Program Element (PE) code. Our team
            reviews every suggestion before it&apos;s added — this never changes the data directly.
          </p>
          <form
            className="stv-stack"
            onSubmit={(event) => {
              event.preventDefault();
              handleSubmit();
            }}
          >
            <CapiroInput
              label="Program Element (PE) code"
              placeholder="e.g. 0604201A"
              error={errors.peCode}
              disabled={submit.isPending}
              value={form.peCode}
              onChange={(e) => setForm((c) => ({ ...c, peCode: e.target.value }))}
            />
            <CapiroInput
              label="Person's full name"
              placeholder="e.g. Jane A. Smith"
              error={errors.fullName}
              disabled={submit.isPending}
              value={form.fullName}
              onChange={(e) => setForm((c) => ({ ...c, fullName: e.target.value }))}
            />
            <CapiroInput
              label="Role / title (optional)"
              placeholder="e.g. Project Manager, Apache Helicopters"
              disabled={submit.isPending}
              value={form.roleTitle}
              onChange={(e) => setForm((c) => ({ ...c, roleTitle: e.target.value }))}
            />
            <CapiroInput
              label="Organization (optional)"
              placeholder="e.g. CPE Aviation"
              disabled={submit.isPending}
              value={form.organization}
              onChange={(e) => setForm((c) => ({ ...c, organization: e.target.value }))}
            />
            <SvTextArea
              label="Notes (optional)"
              rows={2}
              placeholder="How do you know this? Any context helps our review."
              disabled={submit.isPending}
              value={form.notes}
              onChange={(notes) => setForm((c) => ({ ...c, notes }))}
            />
            <div className="stv-row">
              <CapiroButton variant="primary" type="submit" loading={submit.isPending}>
                Submit suggestion
              </CapiroButton>
            </div>
          </form>
        </div>
      </SvCard>
    </div>
  );
}

/**
 * Person → PE link management. capiro_admin sees the scored review queue;
 * user_admin sees a lightweight "suggest a name" form that feeds the same queue.
 */
export function VNextPersonCandidatesPage() {
  const me = useMe();
  const role = me.data?.role;

  if (me.isLoading) {
    return (
      <div className="stv-stack" aria-label="Loading">
        <CapiroSkeleton height={16} />
        <CapiroSkeleton height={16} width="70%" />
      </div>
    );
  }

  return role === 'capiro_admin' ? <ReviewQueue /> : <SuggestForm />;
}
