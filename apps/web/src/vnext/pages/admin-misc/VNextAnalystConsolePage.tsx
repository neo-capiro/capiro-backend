/**
 * vNext re-skin of pages/admin/AnalystConsolePage.tsx — the Step 3.5 unified
 * analyst console (capiro_admin only). One home for every review queue plus an
 * SLA/counts header. Identical endpoints and query keys throughout; the SLA
 * math comes from the extracted analyst-console-shared.ts (single source of
 * truth with canonical). Tab children:
 *   - Reconciliation / Program matches — the vNext page ports (mounted bare).
 *   - Person candidates — the vNext PersonCandidates port.
 *   - Merge candidates — VNextPersonnelMergeTab (settings module; same
 *     component the Settings tenants page mounts).
 *   - Alias manager / Quarantine / Audit log — re-skinned here.
 *   - Provision links + SAM — honest placeholders (no backend endpoints yet),
 *     exactly like canonical.
 * Client-side gating is an affordance only; the server's RolesGuard on every
 * endpoint is the security boundary. Conditional tab rendering reproduces
 * canonical's destroyInactiveTabPane (fresh mount per activation).
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import { useMe } from '../../../lib/me.js';
import {
  ALIAS_TYPES,
  ageLabel,
  slaColor,
} from '../../../pages/admin/analyst-console-shared.js';
import type {
  AliasType,
  AuditLog,
  AuditLogResponse,
  DuplicateAliasGroup,
  ProgramAlias,
  ProgramSearchRow,
  QuarantineResponse,
  QuarantineRow,
  QuarantineType,
  ReviewCounts,
} from '../../../pages/admin/analyst-console-shared.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge, type CapiroBadgeTone } from '../../components/badges/index.js';
import { CapiroInput, CapiroSelect } from '../../components/fields/index.js';
import { CapiroEmptyState, CapiroErrorState, CapiroSkeleton } from '../../components/feedback/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { CapiroTabs, type CapiroTabItem } from '../../components/menus/index.js';
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
  SvCallout,
  SvCard,
  SvPagination,
  useSvConfirm,
} from '../settings/settings-ui.js';
import { VNextPersonnelMergeTab } from '../settings/VNextCapiroAdminPage.js';
import { VNextPeReconciliationPage } from './VNextPeReconciliationPage.js';
import { VNextProgramMatchQueuePage } from './VNextProgramMatchQueuePage.js';
import { VNextPersonCandidatesPage } from './VNextPersonCandidatesPage.js';

const SLA_TONE: Record<'green' | 'gold' | 'red', CapiroBadgeTone> = {
  green: 'success',
  gold: 'warning',
  red: 'danger',
};

function SlaChip({
  label,
  openCount,
  oldestOpenAt,
}: {
  label: string;
  openCount: number;
  oldestOpenAt: string | null;
}) {
  const tone = openCount > 0 ? SLA_TONE[slaColor(oldestOpenAt)] : 'success';
  const age = openCount > 0 ? ageLabel(oldestOpenAt) : 'clear';
  return (
    <CapiroBadge tone={tone} aria-label={`${label} ${openCount} open, oldest ${age}`}>
      {label}: {openCount} open{openCount > 0 ? ` · oldest ${age}` : ''}
    </CapiroBadge>
  );
}

// ── SLA / counts header ────────────────────────────────────────────────────────

function SlaHeader({
  counts,
  loading,
  error,
}: {
  counts?: ReviewCounts;
  loading: boolean;
  error: boolean;
}) {
  if (loading) {
    return (
      <SvCard aria-label="Loading review counts">
        <CapiroSkeleton height={16} />
      </SvCard>
    );
  }
  if (error || !counts) {
    return (
      <SvCallout
        kind="warning"
        title="Could not load review counts"
        description="SLA badges are unavailable; the queues below still load independently."
      />
    );
  }
  return (
    <SvCard aria-label="Review SLA dashboard">
      <div className="amx-sla-strip">
        <SlaChip
          label="Reconciliation"
          openCount={counts.reconciliation.openCount}
          oldestOpenAt={counts.reconciliation.oldestOpenAt}
        />
        <SlaChip
          label="PE→Program"
          openCount={counts.programMatch.openCount}
          oldestOpenAt={counts.programMatch.oldestOpenAt}
        />
        <SlaChip
          label="Person candidates"
          openCount={counts.personCandidate.openCount}
          oldestOpenAt={counts.personCandidate.oldestOpenAt}
        />
        <SlaChip
          label="Personnel merge"
          openCount={counts.personnelMerge.openCount}
          oldestOpenAt={counts.personnelMerge.oldestOpenAt}
        />
        <SlaChip
          label="Provision links"
          openCount={counts.provisionPeLink.candidateCount}
          oldestOpenAt={counts.provisionPeLink.oldestOpenAt}
        />
        <CapiroBadge tone={counts.programMatch.quarantinedCount > 0 ? 'warning' : 'success'}>
          Program quarantine: {counts.programQuarantine.count}
        </CapiroBadge>
        <CapiroBadge tone={counts.personnelQuarantine.count > 0 ? 'warning' : 'success'}>
          Personnel quarantine: {counts.personnelQuarantine.count}
        </CapiroBadge>
      </div>
    </SvCard>
  );
}

// ── Alias manager tab ───────────────────────────────────────────────────────────

function AliasManagerTab() {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useCapiroToast();
  const { confirm, dialog } = useSvConfirm();
  const [search, setSearch] = useState('');
  const [selectedProgram, setSelectedProgram] = useState<ProgramSearchRow | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editAlias, setEditAlias] = useState<ProgramAlias | null>(null);
  const [mergeFor, setMergeFor] = useState<DuplicateAliasGroup | null>(null);
  const [mergeKeepId, setMergeKeepId] = useState<string | null>(null);
  const [aliasForm, setAliasForm] = useState<{ alias: string; aliasType: AliasType; source: string }>({
    alias: '',
    aliasType: 'canonical',
    source: '',
  });
  const [aliasError, setAliasError] = useState<string | undefined>();

  const programs = useQuery({
    queryKey: ['analyst-console', 'program-search', search],
    queryFn: async (): Promise<{ data: ProgramSearchRow[]; total: number }> =>
      (await api.get('/api/programs', { params: { q: search || undefined, limit: 25 } })).data,
    staleTime: 30_000,
  });

  const aliases = useQuery({
    queryKey: ['analyst-console', 'aliases', selectedProgram?.id],
    enabled: !!selectedProgram,
    queryFn: async (): Promise<{ programId: string; data: ProgramAlias[]; total: number }> =>
      (await api.get(`/api/programs/admin/${encodeURIComponent(selectedProgram!.id)}/aliases`)).data,
  });

  const duplicates = useQuery({
    queryKey: ['analyst-console', 'duplicate-aliases'],
    queryFn: async (): Promise<{ data: DuplicateAliasGroup[]; total: number }> =>
      (await api.get('/api/programs/admin/duplicate-aliases')).data,
    staleTime: 30_000,
  });

  const createAlias = useMutation({
    mutationFn: async (input: { alias: string; aliasType: AliasType; source?: string }) =>
      (await api.post(`/api/programs/admin/${encodeURIComponent(selectedProgram!.id)}/aliases`, input)).data,
    onSuccess: () => {
      toast.success('Alias added.');
      setAddOpen(false);
      setAliasForm({ alias: '', aliasType: 'canonical', source: '' });
      void qc.invalidateQueries({ queryKey: ['analyst-console', 'aliases', selectedProgram?.id] });
      void qc.invalidateQueries({ queryKey: ['analyst-console', 'duplicate-aliases'] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const updateAlias = useMutation({
    mutationFn: async (input: { id: string; alias?: string; aliasType?: AliasType }) =>
      (
        await api.patch(`/api/programs/admin/aliases/${encodeURIComponent(input.id)}`, {
          alias: input.alias,
          aliasType: input.aliasType,
        })
      ).data,
    onSuccess: () => {
      toast.success('Alias updated.');
      setEditAlias(null);
      void qc.invalidateQueries({ queryKey: ['analyst-console', 'aliases', selectedProgram?.id] });
      void qc.invalidateQueries({ queryKey: ['analyst-console', 'duplicate-aliases'] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const deleteAlias = useMutation({
    mutationFn: async (id: string) =>
      (await api.delete(`/api/programs/admin/aliases/${encodeURIComponent(id)}`)).data,
    onSuccess: () => {
      toast.success('Alias deleted.');
      void qc.invalidateQueries({ queryKey: ['analyst-console', 'aliases', selectedProgram?.id] });
      void qc.invalidateQueries({ queryKey: ['analyst-console', 'duplicate-aliases'] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const merge = useMutation({
    mutationFn: async (input: { keepProgramId: string; mergeProgramId: string }) =>
      (await api.post('/api/programs/admin/merge', input)).data as Promise<{
        merged: true;
        keepProgramId: string;
        mergeProgramId: string;
        repointed: { matches: number; roles: number; officeLinks: number; provisionLinks: number };
        aliasesCopied: number;
      }>,
    onSuccess: (res) => {
      const r = res.repointed;
      toast.success(
        `Merged. Repointed ${r.matches} matches, ${r.roles} roles, ${r.officeLinks} office links, ${r.provisionLinks} provision links; ${res.aliasesCopied} aliases copied.`,
      );
      setMergeFor(null);
      setMergeKeepId(null);
      void qc.invalidateQueries({ queryKey: ['analyst-console', 'duplicate-aliases'] });
      void qc.invalidateQueries({ queryKey: ['analyst-console', 'aliases'] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const mergeOptions = mergeFor?.programs ?? [];
  const keeper = mergeOptions.find((p) => p.programId === mergeKeepId) ?? null;
  const loser = mergeOptions.find((p) => p.programId !== mergeKeepId) ?? null;

  const programOptions = programs.data?.data ?? [];

  function submitAliasForm(mode: 'add' | 'edit') {
    if (!aliasForm.alias.trim()) {
      setAliasError('Enter the alias text');
      return;
    }
    setAliasError(undefined);
    if (mode === 'add') {
      createAlias.mutate({
        alias: aliasForm.alias.trim(),
        aliasType: aliasForm.aliasType,
        source: aliasForm.source.trim() || undefined,
      });
    } else if (editAlias) {
      updateAlias.mutate({
        id: editAlias.id,
        alias: aliasForm.alias.trim(),
        aliasType: aliasForm.aliasType,
      });
    }
  }

  return (
    <div className="stv-stack">
      <SvCard
        title="Alias manager"
        description="Find a program, then review / add / edit / delete its aliases. Aliases drive PE→Program matching, so changes here directly affect the match queue."
      >
        <div className="stv-stack">
          <div className="stv-row">
            <span style={{ minWidth: 320 }}>
              <CapiroInput
                label="Program search"
                type="search"
                placeholder="Search programs by name or alias…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </span>
            <span style={{ minWidth: 360 }}>
              <CapiroSelect
                label="Pick a program"
                aria-busy={programs.isLoading || undefined}
                value={selectedProgram?.id ?? ''}
                onChange={(e) =>
                  setSelectedProgram(programOptions.find((p) => p.id === e.target.value) ?? null)
                }
                options={[
                  { value: '', label: 'Pick a program' },
                  ...programOptions.map((p) => ({
                    value: p.id,
                    label: `${p.canonicalName}${p.mdapCode ? ` · MDAP ${p.mdapCode}` : ''}${p.component ? ` · ${p.component}` : ''}`,
                  })),
                ]}
              />
            </span>
            {selectedProgram ? (
              <CapiroButton
                variant="primary"
                onClick={() => {
                  setAliasForm({ alias: '', aliasType: 'canonical', source: '' });
                  setAliasError(undefined);
                  setAddOpen(true);
                }}
              >
                Add alias
              </CapiroButton>
            ) : null}
          </div>

          {selectedProgram ? (
            aliases.isLoading ? (
              <div className="stv-stack" aria-label="Loading aliases">
                <CapiroSkeleton height={16} />
                <CapiroSkeleton height={16} width="70%" />
              </div>
            ) : (aliases.data?.data ?? []).length === 0 ? (
              <CapiroEmptyState title="No aliases for this program yet." />
            ) : (
              <CapiroTableWrap>
                <CapiroTable>
                  <CapiroTableHead>
                    <tr>
                      <CapiroTableHeaderCell>Alias</CapiroTableHeaderCell>
                      <CapiroTableHeaderCell>Type</CapiroTableHeaderCell>
                      <CapiroTableHeaderCell>Source</CapiroTableHeaderCell>
                      <CapiroTableHeaderCell>Confidence</CapiroTableHeaderCell>
                      <CapiroTableHeaderCell>Action</CapiroTableHeaderCell>
                    </tr>
                  </CapiroTableHead>
                  <CapiroTableBody>
                    {(aliases.data?.data ?? []).map((r) => (
                      <tr key={r.id}>
                        <CapiroTableCell>
                          <span className="stv-strong">{r.alias}</span>
                        </CapiroTableCell>
                        <CapiroTableCell>
                          <CapiroBadge>{r.aliasType}</CapiroBadge>
                        </CapiroTableCell>
                        <CapiroTableCell>{r.source ?? '—'}</CapiroTableCell>
                        <CapiroTableCell>{`${Math.round((r.confidence ?? 0) * 100)}%`}</CapiroTableCell>
                        <CapiroTableCell>
                          <span className="amx-inline-actions">
                            <CapiroButton
                              size="compact"
                              onClick={() => {
                                setAliasForm({
                                  alias: r.alias,
                                  aliasType: r.aliasType as AliasType,
                                  source: '',
                                });
                                setAliasError(undefined);
                                setEditAlias(r);
                              }}
                            >
                              Edit
                            </CapiroButton>
                            <CapiroButton
                              size="compact"
                              className="stv-btn-danger"
                              loading={deleteAlias.isPending}
                              onClick={() =>
                                confirm({
                                  title: 'Delete this alias?',
                                  okText: 'Delete',
                                  danger: true,
                                  onOk: () => deleteAlias.mutateAsync(r.id),
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
            )
          ) : (
            <CapiroEmptyState title="Search and select a program to manage its aliases." />
          )}
        </div>
      </SvCard>

      <SvCard
        title="Duplicate-alias detector"
        description="Normalized aliases shared across more than one program — usually two program records that should be one. Merge the duplicate into the canonical record; FK references are repointed and the loser is retired."
      >
        <div className="stv-stack">
          {duplicates.isError ? (
            <SvCallout kind="error" title="Failed to load duplicate aliases." />
          ) : null}
          {duplicates.isLoading ? (
            <div className="stv-stack" aria-label="Loading duplicate aliases">
              <CapiroSkeleton height={16} />
              <CapiroSkeleton height={16} width="70%" />
            </div>
          ) : (duplicates.data?.data ?? []).length === 0 ? (
            <CapiroEmptyState title="No duplicate aliases — the program graph is clean." />
          ) : (
            (duplicates.data?.data ?? []).map((g) => (
              <SvCard key={g.aliasNormalized} title={<span className="stv-code">{g.aliasNormalized}</span>}>
                <div className="stv-stack stv-stack--tight">
                  {g.programs.map((p) => (
                    <div key={p.programId} className="stv-row" style={{ gap: 8 }}>
                      <span className="stv-strong">{p.canonicalName ?? '(unknown program)'}</span>
                      <CapiroBadge tone={p.status === 'merged' ? 'neutral' : 'success'}>
                        {p.status ?? '—'}
                      </CapiroBadge>
                    </div>
                  ))}
                  <div className="stv-row">
                    <CapiroButton
                      size="compact"
                      onClick={() => {
                        setMergeKeepId(g.programs[0]?.programId ?? null);
                        setMergeFor(g);
                      }}
                    >
                      Merge programs
                    </CapiroButton>
                  </div>
                </div>
              </SvCard>
            ))
          )}
        </div>
      </SvCard>

      {/* Add / edit alias modals */}
      {addOpen || editAlias ? (
        <CapiroModal
          open
          title={editAlias ? 'Edit alias' : `Add alias — ${selectedProgram?.canonicalName ?? ''}`}
          onClose={() => {
            setAddOpen(false);
            setEditAlias(null);
          }}
        >
          <form
            className="stv-stack"
            onSubmit={(event) => {
              event.preventDefault();
              submitAliasForm(editAlias ? 'edit' : 'add');
            }}
          >
            <CapiroInput
              label="Alias"
              placeholder="e.g. Patriot Advanced Capability"
              error={aliasError}
              value={aliasForm.alias}
              onChange={(e) => setAliasForm((c) => ({ ...c, alias: e.target.value }))}
            />
            <CapiroSelect
              label="Alias type"
              value={aliasForm.aliasType}
              onChange={(e) => setAliasForm((c) => ({ ...c, aliasType: e.target.value as AliasType }))}
              options={ALIAS_TYPES.map((t) => ({ value: t, label: t }))}
            />
            {!editAlias ? (
              <CapiroInput
                label="Source (optional)"
                placeholder="e.g. analyst"
                value={aliasForm.source}
                onChange={(e) => setAliasForm((c) => ({ ...c, source: e.target.value }))}
              />
            ) : null}
            <div className="stv-row stv-row--end">
              <CapiroButton
                onClick={() => {
                  setAddOpen(false);
                  setEditAlias(null);
                }}
              >
                Cancel
              </CapiroButton>
              <CapiroButton
                variant="primary"
                type="submit"
                loading={createAlias.isPending || updateAlias.isPending}
              >
                {editAlias ? 'Save' : 'Add alias'}
              </CapiroButton>
            </div>
          </form>
        </CapiroModal>
      ) : null}

      {/* Merge confirm modal */}
      {mergeFor ? (
        <CapiroModal
          open
          title="Merge programs"
          onClose={() => {
            setMergeFor(null);
            setMergeKeepId(null);
          }}
        >
          <div className="stv-stack">
            <p className="stv-muted" style={{ margin: 0 }}>
              Choose which program to KEEP. The other is retired (status=merged); its matches,
              roles, links and aliases are repointed to the keeper. This is audit-logged and cannot
              be auto-undone.
            </p>
            <CapiroSelect
              label="Keep (canonical)"
              value={mergeKeepId ?? ''}
              onChange={(e) => setMergeKeepId(e.target.value || null)}
              options={mergeOptions.map((p) => ({
                value: p.programId,
                label: p.canonicalName ?? p.programId,
              }))}
            />
            {keeper && loser ? (
              <SvCallout
                kind="info"
                title={
                  <span>
                    Keep <span className="stv-strong">{keeper.canonicalName ?? keeper.programId}</span> ·
                    retire <span className="stv-strong">{loser.canonicalName ?? loser.programId}</span>
                  </span>
                }
              />
            ) : (
              <SvCallout kind="warning" title="Pick the program to keep." />
            )}
            <div className="stv-row stv-row--end">
              <CapiroButton
                onClick={() => {
                  setMergeFor(null);
                  setMergeKeepId(null);
                }}
              >
                Cancel
              </CapiroButton>
              <CapiroButton
                variant="primary"
                className="stv-btn-danger"
                disabled={!keeper || !loser}
                loading={merge.isPending}
                onClick={() =>
                  keeper && loser && merge.mutate({ keepProgramId: keeper.programId, mergeProgramId: loser.programId })
                }
              >
                Merge
              </CapiroButton>
            </div>
          </div>
        </CapiroModal>
      ) : null}

      {dialog}
    </div>
  );
}

// ── Quarantine tab ───────────────────────────────────────────────────────────

function QuarantineTab() {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useCapiroToast();
  const { confirm, dialog } = useSvConfirm();
  const [type, setType] = useState<QuarantineType>('program_element');
  const [source, setSource] = useState('');
  const [sourceDraft, setSourceDraft] = useState('');
  const [page, setPage] = useState(1);
  const [viewing, setViewing] = useState<QuarantineRow | null>(null);
  const limit = 25;

  const queue = useQuery({
    queryKey: ['analyst-console', 'quarantine', type, source, page],
    queryFn: async (): Promise<QuarantineResponse> =>
      (
        await api.get('/api/capiro-admin/quarantine', {
          params: { type, source: source || undefined, page, limit },
        })
      ).data,
  });

  const reprocess = useMutation({
    mutationFn: async (id: string) =>
      (await api.post(`/api/capiro-admin/quarantine/${type}/${encodeURIComponent(id)}/reprocess`)).data as Promise<{
        reprocessed: boolean;
        accepted: boolean;
        reason?: string;
      }>,
    onSuccess: (res) => {
      if (res.accepted) {
        toast.success('Reprocessed and accepted — record promoted.');
        void qc.invalidateQueries({ queryKey: ['analyst-console', 'quarantine'] });
      } else {
        // Canonical used message.warning; the vNext toast API has success/error
        // only, and a still-invalid record is a failure from the user's view.
        toast.error(`Still invalid: ${res.reason ?? 'reprocess rejected'}`);
      }
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const discard = useMutation({
    mutationFn: async (id: string) =>
      (await api.post(`/api/capiro-admin/quarantine/${type}/${encodeURIComponent(id)}/discard`)).data,
    onSuccess: () => {
      toast.success('Discarded.');
      void qc.invalidateQueries({ queryKey: ['analyst-console', 'quarantine'] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const rows = queue.data?.data ?? [];
  const pageCount = Math.max(1, Math.ceil((queue.data?.total ?? 0) / limit));

  return (
    <SvCard
      title="Quarantine"
      description="Ingestion records the writer rejected (invalid PE code, missing name, etc.). Inspect the raw record, then reprocess to retry validation or discard if it is junk."
    >
      <div className="stv-stack">
        <form
          className="stv-row"
          onSubmit={(event) => {
            event.preventDefault();
            setSource(sourceDraft.trim());
            setPage(1);
          }}
        >
          <span style={{ minWidth: 220 }}>
            <CapiroSelect
              label="Type"
              value={type}
              onChange={(e) => {
                setType(e.target.value as QuarantineType);
                setPage(1);
              }}
              options={[
                { value: 'program_element', label: 'Program element' },
                { value: 'acquisition_personnel', label: 'Acquisition personnel' },
              ]}
            />
          </span>
          <span style={{ minWidth: 240 }}>
            <CapiroInput
              label="Source filter"
              type="search"
              placeholder="Filter by source…"
              value={sourceDraft}
              onChange={(e) => setSourceDraft(e.target.value)}
            />
          </span>
          <CapiroButton type="submit">Apply filter</CapiroButton>
        </form>

        {queue.isError ? (
          <SvCallout kind="error" title="Failed to load the quarantine queue." />
        ) : null}

        {queue.isLoading ? (
          <div className="stv-stack" aria-label="Loading quarantine queue">
            <CapiroSkeleton height={16} />
            <CapiroSkeleton height={16} width="70%" />
          </div>
        ) : rows.length === 0 ? (
          <CapiroEmptyState title="No quarantined records." />
        ) : (
          <>
            <CapiroTableWrap>
              <CapiroTable>
                <CapiroTableHead>
                  <tr>
                    <CapiroTableHeaderCell>Source</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>Reason</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>Quarantined</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>Raw record</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>Action</CapiroTableHeaderCell>
                  </tr>
                </CapiroTableHead>
                <CapiroTableBody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <CapiroTableCell>{r.source}</CapiroTableCell>
                      <CapiroTableCell>
                        {r.reason ?? <span className="stv-muted">—</span>}
                      </CapiroTableCell>
                      <CapiroTableCell>{new Date(r.quarantinedAt).toLocaleString()}</CapiroTableCell>
                      <CapiroTableCell>
                        <CapiroButton size="compact" onClick={() => setViewing(r)}>
                          View
                        </CapiroButton>
                      </CapiroTableCell>
                      <CapiroTableCell>
                        <span className="amx-inline-actions">
                          <CapiroButton
                            size="compact"
                            variant="primary"
                            loading={reprocess.isPending}
                            onClick={() =>
                              confirm({
                                title: 'Reprocess this record?',
                                body: 'Re-runs writer validation; promotes it if it now passes.',
                                okText: 'Reprocess',
                                onOk: () => reprocess.mutateAsync(r.id),
                              })
                            }
                          >
                            Reprocess
                          </CapiroButton>
                          <CapiroButton
                            size="compact"
                            className="stv-btn-danger"
                            loading={discard.isPending}
                            onClick={() =>
                              confirm({
                                title: 'Discard this record?',
                                body: 'Permanently deletes the quarantined record.',
                                okText: 'Discard',
                                danger: true,
                                onOk: () => discard.mutateAsync(r.id),
                              })
                            }
                          >
                            Discard
                          </CapiroButton>
                        </span>
                      </CapiroTableCell>
                    </tr>
                  ))}
                </CapiroTableBody>
              </CapiroTable>
            </CapiroTableWrap>
            <SvPagination currentPage={page} pageCount={pageCount} onPage={setPage} />
          </>
        )}
      </div>

      {viewing ? (
        <CapiroModal open title="Raw record" onClose={() => setViewing(null)}>
          <div className="stv-stack">
            <pre className="stv-pre">{JSON.stringify(viewing.rawRecord, null, 2)}</pre>
            <div className="stv-row stv-row--end">
              <CapiroButton onClick={() => setViewing(null)}>Close</CapiroButton>
            </div>
          </div>
        </CapiroModal>
      ) : null}

      {dialog}
    </SvCard>
  );
}

// ── Audit log tab ───────────────────────────────────────────────────────────

function AuditLogTab() {
  const api = useApi();
  const [action, setAction] = useState('');
  const [entityType, setEntityType] = useState('');
  const [actionDraft, setActionDraft] = useState('');
  const [entityTypeDraft, setEntityTypeDraft] = useState('');
  const [page, setPage] = useState(1);
  const [viewing, setViewing] = useState<AuditLog | null>(null);
  const limit = 25;

  const logs = useQuery({
    queryKey: ['analyst-console', 'audit-logs', action, entityType, page],
    queryFn: async (): Promise<AuditLogResponse> =>
      (
        await api.get('/api/capiro-admin/audit-logs', {
          params: { action: action || undefined, entityType: entityType || undefined, page, limit },
        })
      ).data,
  });

  const rows = logs.data?.data ?? [];
  const pageCount = Math.max(1, Math.ceil((logs.data?.total ?? 0) / limit));

  return (
    <SvCard
      title="Audit log"
      description="Analyst actions recorded under your tenant — newest first. Filter by action or entity type and expand any row to see the before/after snapshot."
    >
      <div className="stv-stack">
        <form
          className="stv-row"
          onSubmit={(event) => {
            event.preventDefault();
            setAction(actionDraft.trim());
            setEntityType(entityTypeDraft.trim());
            setPage(1);
          }}
        >
          <span style={{ minWidth: 240 }}>
            <CapiroInput
              label="Action filter"
              type="search"
              placeholder="action (e.g. program.merge)"
              value={actionDraft}
              onChange={(e) => setActionDraft(e.target.value)}
            />
          </span>
          <span style={{ minWidth: 240 }}>
            <CapiroInput
              label="Entity type filter"
              type="search"
              placeholder="entity type (e.g. program)"
              value={entityTypeDraft}
              onChange={(e) => setEntityTypeDraft(e.target.value)}
            />
          </span>
          <CapiroButton type="submit">Apply filters</CapiroButton>
        </form>

        {logs.isError ? <SvCallout kind="error" title="Failed to load the audit log." /> : null}

        {logs.isLoading ? (
          <div className="stv-stack" aria-label="Loading audit log">
            <CapiroSkeleton height={16} />
            <CapiroSkeleton height={16} width="70%" />
          </div>
        ) : rows.length === 0 ? (
          <CapiroEmptyState title="No audit-log entries match." />
        ) : (
          <>
            <CapiroTableWrap>
              <CapiroTable>
                <CapiroTableHead>
                  <tr>
                    <CapiroTableHeaderCell>When</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>Action</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>Entity</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>Entity id</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>Actor role</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>Detail</CapiroTableHeaderCell>
                  </tr>
                </CapiroTableHead>
                <CapiroTableBody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <CapiroTableCell>{new Date(r.occurredAt).toLocaleString()}</CapiroTableCell>
                      <CapiroTableCell>
                        <CapiroBadge tone="info">{r.action}</CapiroBadge>
                      </CapiroTableCell>
                      <CapiroTableCell>{r.entityType}</CapiroTableCell>
                      <CapiroTableCell>
                        {r.entityId ? <span className="stv-code">{r.entityId}</span> : '—'}
                      </CapiroTableCell>
                      <CapiroTableCell>
                        <CapiroBadge>{r.actorRole}</CapiroBadge>
                      </CapiroTableCell>
                      <CapiroTableCell>
                        <CapiroButton size="compact" onClick={() => setViewing(r)}>
                          View
                        </CapiroButton>
                      </CapiroTableCell>
                    </tr>
                  ))}
                </CapiroTableBody>
              </CapiroTable>
            </CapiroTableWrap>
            <SvPagination currentPage={page} pageCount={pageCount} onPage={setPage} />
          </>
        )}
      </div>

      {viewing ? (
        <CapiroModal
          open
          title={`${viewing.action} · ${viewing.entityType}`}
          onClose={() => setViewing(null)}
        >
          <div className="stv-stack">
            <div>
              <span className="stv-muted stv-small">Before</span>
              <pre className="stv-pre">{JSON.stringify(viewing.before, null, 2)}</pre>
            </div>
            <div>
              <span className="stv-muted stv-small">After</span>
              <pre className="stv-pre">{JSON.stringify(viewing.after, null, 2)}</pre>
            </div>
            <div className="stv-row stv-row--end">
              <CapiroButton onClick={() => setViewing(null)}>Close</CapiroButton>
            </div>
          </div>
        </CapiroModal>
      ) : null}
    </SvCard>
  );
}

// ── Honest placeholder tabs ─────────────────────────────────────────────────

function ProvisionLinksTab({ count }: { count: number }) {
  return (
    <SvCard>
      <CapiroEmptyState
        title="Provision → PE links"
        description={`${count} candidate link${count === 1 ? '' : 's'} awaiting review. Review UI pending — there is no provision-link review endpoint yet.`}
      />
    </SvCard>
  );
}

function SamMatchesTab() {
  return (
    <SvCard>
      <CapiroEmptyState
        title="SAM.gov matches"
        description="Pending SAM.gov integration (Step 3.1). No data is available yet — this tab is a placeholder."
      />
    </SvCard>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

/** A tab badge (trailing count), shown only when the count is positive.
 *  CapiroTabItem badges render the raw number — a >999 count shows as-is
 *  (canonical capped the text at "999+"). */
function tabBadge(count?: number): CapiroTabItem['badge'] {
  return count != null && count > 0 ? { count, tone: 'info' } : undefined;
}

export function VNextAnalystConsolePage() {
  const me = useMe();
  const api = useApi();
  const isCapiroAdmin = me.data?.role === 'capiro_admin';
  const [tab, setTab] = useState('reconciliation');

  const counts = useQuery({
    queryKey: ['analyst-console', 'review-counts'],
    enabled: isCapiroAdmin,
    queryFn: async (): Promise<ReviewCounts> => (await api.get('/api/capiro-admin/review-counts')).data,
    staleTime: 30_000,
  });

  const c = counts.data;
  const programMatchCount = c ? c.programMatch.openCount + c.programMatch.quarantinedCount : undefined;
  const quarantineCount = c ? c.programQuarantine.count + c.personnelQuarantine.count : undefined;

  const items = useMemo<CapiroTabItem[]>(
    () => [
      { id: 'reconciliation', label: 'Reconciliation', badge: tabBadge(c?.reconciliation.openCount) },
      { id: 'program-matches', label: 'Program matches', badge: tabBadge(programMatchCount) },
      { id: 'alias-manager', label: 'Alias manager' },
      { id: 'person-candidates', label: 'Person candidates', badge: tabBadge(c?.personCandidate.openCount) },
      { id: 'merge-candidates', label: 'Merge candidates', badge: tabBadge(c?.personnelMerge.openCount) },
      { id: 'quarantine', label: 'Quarantine', badge: tabBadge(quarantineCount) },
      { id: 'audit-log', label: 'Audit log' },
      { id: 'provision-links', label: 'Provision links', badge: tabBadge(c?.provisionPeLink.candidateCount) },
      { id: 'sam', label: 'SAM' },
    ],
    [c, programMatchCount, quarantineCount],
  );

  if (me.isLoading) {
    return (
      <div className="settings-vnext amx">
        <div className="stv-body" aria-label="Loading">
          <CapiroSkeleton height={22} width="30%" />
          <CapiroSkeleton height={16} />
        </div>
      </div>
    );
  }
  if (!isCapiroAdmin) {
    return (
      <div className="settings-vnext amx">
        <div className="stv-body">
          <CapiroErrorState
            title="403"
            description="The analyst console is restricted to Capiro administrators."
          />
        </div>
      </div>
    );
  }

  return (
    <div className="settings-vnext amx">
      <header className="stv-header">
        <div>
          <h1>Analyst Console</h1>
          <p>One home for every review queue, with SLA counts across the pipeline.</p>
        </div>
        <div className="amx-header-actions">
          <CapiroButton
            size="compact"
            title="Refresh SLA counts"
            loading={counts.isFetching}
            onClick={() => void counts.refetch()}
          >
            Refresh counts
          </CapiroButton>
        </div>
      </header>
      <div className="stv-tabstrip">
        <CapiroTabs label="Analyst console queues" items={items} activeId={tab} onChange={setTab} />
      </div>
      <div className="stv-body">
        <SlaHeader counts={counts.data} loading={counts.isLoading} error={counts.isError} />
        {/* Conditional mounting == canonical destroyInactiveTabPane: each tab
            self-fetches on activation and unmounts cleanly on switch. */}
        {tab === 'reconciliation' ? <VNextPeReconciliationPage /> : null}
        {tab === 'program-matches' ? <VNextProgramMatchQueuePage /> : null}
        {tab === 'alias-manager' ? <AliasManagerTab /> : null}
        {tab === 'person-candidates' ? <VNextPersonCandidatesPage /> : null}
        {tab === 'merge-candidates' ? <VNextPersonnelMergeTab /> : null}
        {tab === 'quarantine' ? <QuarantineTab /> : null}
        {tab === 'audit-log' ? <AuditLogTab /> : null}
        {tab === 'provision-links' ? (
          <ProvisionLinksTab count={c?.provisionPeLink.candidateCount ?? 0} />
        ) : null}
        {tab === 'sam' ? <SamMatchesTab /> : null}
      </div>
    </div>
  );
}
