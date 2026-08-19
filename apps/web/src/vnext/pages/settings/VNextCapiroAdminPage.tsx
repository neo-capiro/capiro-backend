/**
 * vNext re-skin of pages/capiro-admin/CapiroAdminPage.tsx — identical
 * endpoints, query keys, the two-step type-DELETE tenant deletion, the
 * audit-logged impersonation flow (reason required, 10–500 chars) and the
 * personnel merge queue. The canonical PersonnelMergeTab stays exported for
 * the legacy Analyst Console; this file re-implements its body on vNext
 * primitives over the same endpoints.
 */
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import { useImpersonation } from '../../../state/impersonation.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { CapiroInput } from '../../components/fields/index.js';
import { CapiroEmptyState, CapiroSkeleton } from '../../components/feedback/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { CapiroTabs } from '../../components/menus/index.js';
import { CapiroModal } from '../../components/overlays/index.js';
import {
  CapiroTable,
  CapiroTableBody,
  CapiroTableCell,
  CapiroTableHead,
  CapiroTableHeaderCell,
  CapiroTableWrap,
} from '../../components/tables/index.js';
import {
  SvCard,
  SvPagination,
  SvTextArea,
  useSvConfirm,
  useSvPagination,
} from './settings-ui.js';
import { VNextAiKeysAdminPanel } from './VNextAiKeysAdminPanel.js';

interface TenantRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  clerkOrgId: string | null;
  logoS3Key: string | null;
  createdAt: string;
  _count: { memberships: number; clients: number };
}

interface CreateTenantInput {
  slug: string;
  name: string;
  adminEmail: string;
  adminFirstName?: string;
  adminLastName?: string;
}

export function VNextCapiroAdminPage() {
  const [tab, setTab] = useState('tenants');
  return (
    <div className="stv-stack">
      <h2 className="stv-card__title" style={{ margin: 0 }}>
        Capiro Admin
      </h2>
      <CapiroTabs
        label="Capiro admin sections"
        activeId={tab}
        onChange={setTab}
        items={[
          { id: 'tenants', label: 'Tenants' },
          { id: 'personnel-merge', label: 'Personnel Merge Queue' },
          { id: 'ai-keys', label: 'AI Keys & Usage' },
        ]}
      />
      {tab === 'tenants' ? (
        <TenantsTab />
      ) : tab === 'personnel-merge' ? (
        <VNextPersonnelMergeTab />
      ) : (
        <VNextAiKeysAdminPanel />
      )}
    </div>
  );
}

// ── Tab 1: Tenants ───────────────────────────────────────────────────────────

function TenantsTab() {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useCapiroToast();
  const navigate = useNavigate();
  const { start: startImpersonation } = useImpersonation();
  const { confirm, dialog } = useSvConfirm();
  const [open, setOpen] = useState(false);
  const [impOpen, setImpOpen] = useState<TenantRow | null>(null);
  // Second-step delete confirmation: the row confirm arms this, the modal below
  // requires typing DELETE before the destructive mutation actually fires.
  const [deleteTarget, setDeleteTarget] = useState<TenantRow | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [deleteError, setDeleteError] = useState<string | undefined>();
  const [form, setForm] = useState<CreateTenantInput>({ slug: '', name: '', adminEmail: '' });
  const [formErrors, setFormErrors] = useState<Partial<Record<keyof CreateTenantInput, string>>>(
    {},
  );
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | undefined>();

  const tenants = useQuery<TenantRow[]>({
    queryKey: ['capiro-admin', 'tenants'],
    queryFn: async () => (await api.get('/api/capiro-admin/tenants')).data,
  });

  const create = useMutation({
    mutationFn: async (input: CreateTenantInput) =>
      (await api.post('/api/capiro-admin/tenants', input)).data,
    onSuccess: (_data, vars) => {
      toast.success(`Tenant created. Invitation email sent to ${vars.adminEmail}`);
      setOpen(false);
      setForm({ slug: '', name: '', adminEmail: '' });
      qc.invalidateQueries({ queryKey: ['capiro-admin', 'tenants'] });
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const deleteTenant = useMutation({
    mutationFn: async (tenantId: string) =>
      (await api.delete(`/api/capiro-admin/tenants/${tenantId}`)).data,
    onSuccess: (_data, tenantId) => {
      const t = tenants.data?.find((x) => x.id === tenantId);
      toast.success(`Tenant ${t?.slug ?? ''} deleted`);
      setDeleteTarget(null);
      setDeleteConfirm('');
      qc.invalidateQueries({ queryKey: ['capiro-admin', 'tenants'] });
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const impersonate = useMutation({
    mutationFn: async (input: { tenantId: string; tenantSlug: string; reason: string }) =>
      (
        await api.post('/api/capiro-admin/impersonate', {
          tenantId: input.tenantId,
          reason: input.reason,
        })
      ).data,
    onSuccess: (_data, vars) => {
      startImpersonation(vars.tenantSlug);
      setImpOpen(null);
      setReason('');
      qc.invalidateQueries(); // any data is now from the impersonated tenant
      toast.success(`Acting as ${vars.tenantSlug}. Use the chip in the header to end.`);
      navigate('/');
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const rows = tenants.data ?? [];
  const { pageRows, currentPage, pageCount, setPage } = useSvPagination(rows, 20);

  const submitCreate = () => {
    const errors: Partial<Record<keyof CreateTenantInput, string>> = {};
    const slug = form.slug.trim();
    if (!slug) errors.slug = 'Tenant slug is required';
    else if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug))
      errors.slug = 'Lowercase, 2-63 chars, [a-z0-9-], cannot start with a hyphen';
    const name = form.name.trim();
    if (!name || name.length < 2) errors.name = 'Display name is required (min 2 characters)';
    const email = form.adminEmail.trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      errors.adminEmail = 'A valid admin email is required';
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) return;
    create.mutate({
      slug,
      name,
      adminEmail: email,
      ...(form.adminFirstName?.trim() ? { adminFirstName: form.adminFirstName.trim() } : {}),
      ...(form.adminLastName?.trim() ? { adminLastName: form.adminLastName.trim() } : {}),
    });
  };

  const submitImpersonation = () => {
    if (!impOpen) return;
    const trimmed = reason.trim();
    if (trimmed.length < 10 || trimmed.length > 500) {
      setReasonError('Reason must be 10-500 characters');
      return;
    }
    setReasonError(undefined);
    impersonate.mutate({ tenantId: impOpen.id, tenantSlug: impOpen.slug, reason: trimmed });
  };

  const submitDelete = () => {
    if (!deleteTarget) return;
    if (deleteConfirm !== 'DELETE') {
      setDeleteError('Type DELETE (all caps) to confirm');
      return;
    }
    setDeleteError(undefined);
    deleteTenant.mutate(deleteTarget.id);
  };

  return (
    <div className="stv-stack">
      <div className="stv-row stv-row--between">
        <h3 className="stv-card__title" style={{ margin: 0 }}>
          Tenants
        </h3>
        <CapiroButton variant="primary" onClick={() => setOpen(true)}>
          Create tenant
        </CapiroButton>
      </div>

      {tenants.isLoading ? (
        <div className="stv-stack" aria-label="Loading tenants">
          <CapiroSkeleton height={16} />
          <CapiroSkeleton height={16} width="70%" />
        </div>
      ) : (
        <>
          <CapiroTableWrap>
            <CapiroTable>
              <CapiroTableHead>
                <tr>
                  <CapiroTableHeaderCell>Slug</CapiroTableHeaderCell>
                  <CapiroTableHeaderCell>Name</CapiroTableHeaderCell>
                  <CapiroTableHeaderCell>Status</CapiroTableHeaderCell>
                  <CapiroTableHeaderCell>Members</CapiroTableHeaderCell>
                  <CapiroTableHeaderCell>Clients</CapiroTableHeaderCell>
                  <CapiroTableHeaderCell>Created</CapiroTableHeaderCell>
                  <CapiroTableHeaderCell />
                </tr>
              </CapiroTableHead>
              <CapiroTableBody>
                {pageRows.map((r) => (
                  <tr key={r.id}>
                    <CapiroTableCell>{r.slug}</CapiroTableCell>
                    <CapiroTableCell>{r.name}</CapiroTableCell>
                    <CapiroTableCell>
                      <CapiroBadge
                        tone={
                          r.status === 'active'
                            ? 'success'
                            : r.status === 'suspended'
                              ? 'danger'
                              : 'warning'
                        }
                      >
                        {r.status}
                      </CapiroBadge>
                    </CapiroTableCell>
                    <CapiroTableCell>{r._count.memberships}</CapiroTableCell>
                    <CapiroTableCell>{r._count.clients}</CapiroTableCell>
                    <CapiroTableCell>{r.createdAt}</CapiroTableCell>
                    <CapiroTableCell>
                      <span className="stv-row" style={{ gap: 4 }}>
                        <CapiroButton
                          size="compact"
                          onClick={() =>
                            confirm({
                              title: 'Impersonate this tenant?',
                              body: 'A reason will be required and audit-logged.',
                              okText: 'Continue',
                              onOk: () => {
                                setReason('');
                                setImpOpen(r);
                              },
                            })
                          }
                        >
                          Impersonate
                        </CapiroButton>
                        <CapiroButton
                          size="compact"
                          className="stv-btn-danger"
                          onClick={() =>
                            confirm({
                              title: `Delete tenant "${r.slug}"?`,
                              body: 'Permanently deletes the tenant, its Clerk org, all members, clients, meetings and data. This cannot be undone.',
                              okText: 'Continue',
                              danger: true,
                              onOk: () => {
                                setDeleteConfirm('');
                                setDeleteError(undefined);
                                setDeleteTarget(r);
                              },
                            })
                          }
                        >
                          Delete
                        </CapiroButton>
                      </span>
                    </CapiroTableCell>
                  </tr>
                ))}
              </CapiroTableBody>
            </CapiroTable>
          </CapiroTableWrap>
          <SvPagination currentPage={currentPage} pageCount={pageCount} onPage={setPage} />
        </>
      )}

      {/* Create tenant */}
      {open ? (
        <CapiroModal open title="Create tenant + invite admin" onClose={() => setOpen(false)}>
          <form
            className="stv-stack"
            onSubmit={(event) => {
              event.preventDefault();
              submitCreate();
            }}
          >
            <CapiroInput
              label="Tenant slug"
              placeholder="acme-lobbying"
              helpText="Lowercase, [a-z0-9-]. The first label of the tenant subdomain (slug.app.capiro.ai)."
              error={formErrors.slug}
              value={form.slug}
              onChange={(e) => setForm((c) => ({ ...c, slug: e.target.value }))}
            />
            <CapiroInput
              label="Display name"
              placeholder="Acme Lobbying Group"
              error={formErrors.name}
              value={form.name}
              onChange={(e) => setForm((c) => ({ ...c, name: e.target.value }))}
            />
            <div className="stv-grid-2">
              <CapiroInput
                label="Admin first name"
                placeholder="Jane"
                value={form.adminFirstName ?? ''}
                onChange={(e) => setForm((c) => ({ ...c, adminFirstName: e.target.value }))}
              />
              <CapiroInput
                label="Admin last name"
                placeholder="Doe"
                value={form.adminLastName ?? ''}
                onChange={(e) => setForm((c) => ({ ...c, adminLastName: e.target.value }))}
              />
            </div>
            <CapiroInput
              label="Admin email"
              placeholder="admin@acme.com"
              helpText="An onboarding invitation email is sent to this address."
              error={formErrors.adminEmail}
              value={form.adminEmail}
              onChange={(e) => setForm((c) => ({ ...c, adminEmail: e.target.value }))}
            />
            <div className="stv-row stv-row--end">
              <CapiroButton onClick={() => setOpen(false)}>Cancel</CapiroButton>
              <CapiroButton variant="primary" type="submit" loading={create.isPending}>
                Create + send invite
              </CapiroButton>
            </div>
          </form>
        </CapiroModal>
      ) : null}

      {/* Reason for impersonation */}
      {impOpen ? (
        <CapiroModal open title={`Impersonate ${impOpen.slug}`} onClose={() => setImpOpen(null)}>
          <form
            className="stv-stack"
            onSubmit={(event) => {
              event.preventDefault();
              submitImpersonation();
            }}
          >
            <p className="stv-muted" style={{ margin: 0 }}>
              The reason is recorded in the audit log alongside your user id. Any data access during
              this session is attributed to you, not the tenant's admin.
            </p>
            <SvTextArea
              label="Reason"
              rows={3}
              placeholder="Investigating ticket #1234, invitation flow"
              value={reason}
              onChange={setReason}
            />
            {reasonError ? <span className="capiro-field__error">{reasonError}</span> : null}
            <div className="stv-row stv-row--end">
              <CapiroButton onClick={() => setImpOpen(null)}>Cancel</CapiroButton>
              <CapiroButton variant="primary" type="submit" loading={impersonate.isPending}>
                Start impersonation
              </CapiroButton>
            </div>
          </form>
        </CapiroModal>
      ) : null}

      {/* Second-step delete confirmation — type DELETE to arm the real deletion */}
      {deleteTarget ? (
        <CapiroModal
          open
          title="Permanently delete tenant"
          onClose={() => {
            if (deleteTenant.isPending) return;
            setDeleteTarget(null);
            setDeleteConfirm('');
          }}
        >
          <form
            className="stv-stack"
            onSubmit={(event) => {
              event.preventDefault();
              submitDelete();
            }}
          >
            <p style={{ margin: 0 }}>You are about to permanently delete:</p>
            <p style={{ textAlign: 'center', margin: '12px 0 4px' }}>
              <span className="stv-strong" style={{ fontSize: 26, lineHeight: 1.25 }}>
                {deleteTarget.name}
              </span>
              <br />
              <span className="stv-muted stv-small">{deleteTarget.slug}</span>
            </p>
            <p className="stv-danger-text" style={{ margin: 0 }}>
              This erases its Clerk org, all members, clients, meetings and data. This cannot be
              undone.
            </p>
            <CapiroInput
              label="Type DELETE to confirm"
              placeholder="DELETE"
              autoComplete="off"
              autoFocus
              error={deleteError}
              value={deleteConfirm}
              onChange={(e) => setDeleteConfirm(e.target.value)}
            />
            <div className="stv-row stv-row--end">
              <CapiroButton
                onClick={() => {
                  setDeleteTarget(null);
                  setDeleteConfirm('');
                }}
                disabled={deleteTenant.isPending}
              >
                Cancel
              </CapiroButton>
              <CapiroButton
                variant="primary"
                className="stv-btn-danger"
                type="submit"
                loading={deleteTenant.isPending}
                disabled={deleteConfirm !== 'DELETE'}
              >
                Delete tenant
              </CapiroButton>
            </div>
          </form>
        </CapiroModal>
      ) : null}

      {dialog}
    </div>
  );
}

// ── Tab 2: Personnel merge queue (Step 36) ──────────────────────────────────

interface MergePersonDetail {
  id: string;
  fullName: string;
  organization: string | null;
  title: string | null;
  role: string | null;
  service: string | null;
  status: string;
  confidence: number;
  sources: Array<{ source: string; sourceUrl: string | null; observedAt: string }>;
}

interface MergeCandidate {
  id: string;
  primaryPersonId: string;
  secondaryPersonId: string;
  similarityScore: number;
  status: string;
  createdAt: string;
  primaryPerson: MergePersonDetail | null;
  secondaryPerson: MergePersonDetail | null;
}

interface MergeQueueResponse {
  data: MergeCandidate[];
  total: number;
  page: number;
  limit: number;
}

type MergeDecision = 'merge' | 'keep_separate' | 'reject_a' | 'reject_b';

function PersonRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="stv-row stv-row--start" style={{ gap: 8, marginBottom: 4, flexWrap: 'nowrap' }}>
      <span className="stv-muted stv-small" style={{ minWidth: 96 }}>
        {label}
      </span>
      <span className="stv-small">{value ?? <span className="stv-muted">—</span>}</span>
    </div>
  );
}

function PersonCard({ person, side }: { person: MergePersonDetail | null; side: string }) {
  if (!person) {
    return (
      <SvCard title={`${side} (missing)`}>
        <CapiroEmptyState title="Person record not found" />
      </SvCard>
    );
  }
  return (
    <SvCard title={`${side} · ${person.fullName}`}>
      <PersonRow label="Organization" value={person.organization} />
      <PersonRow label="Title" value={person.title} />
      <PersonRow label="Role" value={person.role} />
      <PersonRow label="Service" value={person.service} />
      <PersonRow
        label="Status"
        value={
          <CapiroBadge tone={person.status === 'active' ? 'success' : 'neutral'}>
            {person.status}
          </CapiroBadge>
        }
      />
      <PersonRow label="Confidence" value={`${Math.round(person.confidence * 100)}%`} />
      <PersonRow
        label="Sources"
        value={
          person.sources.length === 0 ? (
            '—'
          ) : (
            <span className="stv-row" style={{ gap: 4 }}>
              {person.sources.map((s, i) => (
                <CapiroBadge key={`${s.source}-${i}`}>{s.source}</CapiroBadge>
              ))}
            </span>
          )
        }
      />
    </SvCard>
  );
}

// Exported (additive — behavior unchanged) so the vNext Analyst Console
// (vnext/pages/admin-misc) can mount this merge-candidates queue as a tab
// without duplicating its logic — same move the canonical console made with
// the legacy PersonnelMergeTab.
export function VNextPersonnelMergeTab() {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useCapiroToast();
  const { confirm, dialog } = useSvConfirm();
  const [pending, setPending] = useState<{ id: string; decision: MergeDecision } | null>(null);

  const queue = useQuery<MergeQueueResponse>({
    queryKey: ['capiro-admin', 'personnel-merge-queue', 'open'],
    queryFn: async () =>
      (
        await api.get<MergeQueueResponse>('/api/admin/acquisition-personnel/merge-queue', {
          params: { status: 'open' },
        })
      ).data,
  });

  const resolve = useMutation({
    mutationFn: async (input: { id: string; decision: MergeDecision }) =>
      (
        await api.post(`/api/admin/acquisition-personnel/merge-queue/${input.id}/resolve`, {
          decision: input.decision,
        })
      ).data,
    onMutate: (input) => setPending(input),
    onSuccess: (_data, input) => {
      const label =
        input.decision === 'merge'
          ? 'Merged'
          : input.decision === 'keep_separate'
            ? 'Kept separate'
            : 'Rejected';
      toast.success(`${label}`);
      void qc.invalidateQueries({ queryKey: ['capiro-admin', 'personnel-merge-queue'] });
    },
    onError: (err) => toast.error((err as Error).message),
    onSettled: () => setPending(null),
  });

  const candidates = queue.data?.data ?? [];
  const isPending = (id: string, decision: MergeDecision) =>
    resolve.isPending && pending?.id === id && pending?.decision === decision;
  const anyPendingFor = (id: string) => resolve.isPending && pending?.id === id;

  return (
    <div className="stv-stack">
      <div className="stv-row stv-row--between">
        <h3 className="stv-card__title" style={{ margin: 0 }}>
          Personnel Merge Queue
        </h3>
        <CapiroButton size="compact" onClick={() => queue.refetch()} loading={queue.isFetching}>
          Refresh
        </CapiroButton>
      </div>
      <p className="stv-muted" style={{ margin: 0 }}>
        Near-duplicate acquisition personnel flagged by the writer (name match with a differing
        organization, or 0.70–0.92 trigram similarity). Review each side-by-side and decide: merge
        into one record, keep them separate, or mark one as the wrong record.
      </p>

      {queue.isLoading ? (
        <div className="stv-stack" aria-label="Loading merge queue">
          <CapiroSkeleton height={16} />
          <CapiroSkeleton height={16} width="70%" />
        </div>
      ) : candidates.length === 0 ? (
        <CapiroEmptyState title="No open merge candidates." />
      ) : (
        <div className="stv-stack">
          {candidates.map((c) => (
            <SvCard
              key={c.id}
              title={
                <span className="stv-row" style={{ gap: 8 }}>
                  Similarity
                  <CapiroBadge tone={c.similarityScore >= 0.85 ? 'danger' : 'warning'}>
                    {(c.similarityScore * 100).toFixed(0)}%
                  </CapiroBadge>
                  <span className="stv-muted stv-small" style={{ fontWeight: 400 }}>
                    queued {new Date(c.createdAt).toLocaleString()}
                  </span>
                </span>
              }
            >
              <div className="stv-stack">
                <div className="stv-grid-2">
                  <PersonCard person={c.primaryPerson} side="Record A (primary)" />
                  <PersonCard person={c.secondaryPerson} side="Record B (secondary)" />
                </div>
                <div className="stv-row">
                  <CapiroButton
                    variant="primary"
                    loading={isPending(c.id, 'merge')}
                    disabled={anyPendingFor(c.id)}
                    onClick={() =>
                      confirm({
                        title: 'Merge these into one record?',
                        body: 'Record B will be consolidated into Record A and deleted.',
                        okText: 'Merge',
                        onOk: () => resolve.mutateAsync({ id: c.id, decision: 'merge' }),
                      })
                    }
                  >
                    Merge
                  </CapiroButton>
                  <CapiroButton
                    loading={isPending(c.id, 'keep_separate')}
                    disabled={anyPendingFor(c.id)}
                    onClick={() => resolve.mutate({ id: c.id, decision: 'keep_separate' })}
                  >
                    Keep separate
                  </CapiroButton>
                  <CapiroButton
                    className="stv-btn-danger"
                    loading={isPending(c.id, 'reject_a')}
                    disabled={anyPendingFor(c.id)}
                    onClick={() => resolve.mutate({ id: c.id, decision: 'reject_a' })}
                  >
                    Mark A wrong
                  </CapiroButton>
                  <CapiroButton
                    className="stv-btn-danger"
                    loading={isPending(c.id, 'reject_b')}
                    disabled={anyPendingFor(c.id)}
                    onClick={() => resolve.mutate({ id: c.id, decision: 'reject_b' })}
                  >
                    Mark B wrong
                  </CapiroButton>
                </div>
              </div>
            </SvCard>
          ))}
        </div>
      )}

      {dialog}
    </div>
  );
}
