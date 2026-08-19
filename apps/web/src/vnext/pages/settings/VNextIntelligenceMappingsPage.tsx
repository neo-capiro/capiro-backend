/**
 * vNext re-skin of pages/settings/IntelligenceMappingsPage.tsx — identical
 * endpoints, query keys, deep-link seeding (?clientId= / ?source=), the
 * REQUIRES_INDIVIDUAL_REVIEW / AWARD_BEARING_SOURCES safety rules, bulk
 * confirm/reject thresholds and copy, via intelligence-mappings-shared.ts.
 * antd's column-header basis filter and confidence sorter become an explicit
 * filter select and a clickable sort header (presentation-only deviation).
 */
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Plus, RefreshCcw } from 'lucide-react';
import { useApi } from '../../../lib/use-api.js';
import {
  AWARD_BEARING_SOURCES,
  MAPPING_SOURCE_OPTIONS,
  MATCH_BASIS_LABELS,
  REQUIRES_INDIVIDUAL_REVIEW,
  asMappingSource,
  formatMappingSpend as formatSpend,
  invalidateClientIntel,
  mappingApiErrorMessage as apiErrorMessage,
  matchBasisLabel as basisLabel,
  type ClientIntelMapping,
  type ContractorCandidateView,
  type MappingSource,
  type ResolutionSummary,
} from '../../../pages/settings/intelligence-mappings-shared.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge, type CapiroBadgeTone } from '../../components/badges/index.js';
import { CapiroInput, CapiroSelect } from '../../components/fields/index.js';
import { CapiroEmptyState, CapiroSkeleton } from '../../components/feedback/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { CapiroMenu, CapiroPopover, CapiroTooltip } from '../../components/menus/index.js';
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
  SvProgress,
  SvSegmented,
  SvSortHeader,
  SvSwitch,
  useSvPagination,
  useSvSort,
} from './settings-ui.js';

function basisTone(basis: string | null): CapiroBadgeTone {
  if (basis === 'exact_uei' || basis === 'exact_cage' || basis === 'manual_pin') return 'success';
  if (basis === 'exact_legal_name_corroborated') return 'info';
  if (basis === 'exact_legal_name') return 'warning';
  return 'neutral';
}

function confidenceTone(confidence: number): 'success' | 'warning' | 'danger' {
  if (confidence >= 0.85) return 'success';
  if (confidence >= 0.5) return 'warning';
  return 'danger';
}

export function VNextIntelligenceMappingsPage() {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useCapiroToast();
  const [searchParams] = useSearchParams();
  // A client-scoped arrival (?clientId=<uuid>) must land on THAT client's rows
  // without the user searching for them again.
  const deepLinkedClientId = searchParams.get('clientId') ?? undefined;
  const [clientSearch, setClientSearch] = useState('');
  const [clientIdFilter, setClientIdFilter] = useState<string | undefined>(deepLinkedClientId);
  // Seed the source filter from the URL (?source=fec_employer) so deep links
  // from the intel profile panels land the user directly on the rows they need
  // to confirm.
  const [sourceFilter, setSourceFilter] = useState<string | undefined>(
    searchParams.get('source') ?? undefined,
  );
  const [basisFilter, setBasisFilter] = useState<string | undefined>(undefined);
  const [confirmedFilter, setConfirmedFilter] = useState<'all' | 'confirmed' | 'unconfirmed'>('all');
  const [manualOpen, setManualOpen] = useState(false);
  const sort = useSvSort<'confidence'>('confidence');
  // Human-readable name of the source the list is filtered to, for the empty
  // state's copy. Undefined when unfiltered or when ?source= is not a real source.
  const sourceFilterLabel = MAPPING_SOURCE_OPTIONS.find((o) => o.value === sourceFilter)?.label;

  const mappingsQuery = useQuery<ClientIntelMapping[]>({
    queryKey: ['intelligence-mappings'],
    queryFn: async () => (await api.get<ClientIntelMapping[]>('/api/intelligence/mappings')).data,
    staleTime: 30_000,
  });

  const resolveAllMutation = useMutation({
    mutationFn: async () =>
      (await api.post<ResolutionSummary>('/api/intelligence/resolve-all')).data,
    onSuccess: (summary) => {
      toast.success(
        `Resolution complete — ${summary.mappingsCreated} mappings · ${summary.autoConfirmed} auto-confirmed · ${summary.needsReview} need review · ${summary.totalClients} clients processed`,
      );
      void qc.invalidateQueries({ queryKey: ['intelligence-mappings'] });
      invalidateClientIntel(qc);
    },
    onError: (err) => {
      toast.error(`Resolution failed — ${apiErrorMessage(err)}`);
    },
  });

  /**
   * "Find exact identifier matches" — the SAFE automatic action.
   *
   * Auto-confirms only an unambiguous tier-1 identifier match. It cannot confirm a
   * fuzzy name, by construction on the API side rather than by convention here.
   */
  const identifierMatchMutation = useMutation({
    mutationFn: async () =>
      (
        await api.post<ResolutionSummary>(
          '/api/intelligence/mappings/match-contractor-identifiers',
        )
      ).data,
    onSuccess: (summary) => {
      toast.success(
        `Exact identifier matching complete — ${summary.autoConfirmed} confirmed from exact identifiers · ${summary.needsReview} need review · ${summary.totalClients} clients processed. A similar name is never confirmed automatically.`,
      );
      void qc.invalidateQueries({ queryKey: ['intelligence-mappings'] });
      void qc.invalidateQueries({ queryKey: ['contractor-candidates'] });
      invalidateClientIntel(qc);
    },
    onError: (err) => toast.error(`Identifier matching failed — ${apiErrorMessage(err)}`),
  });

  const confirmMutation = useMutation({
    // `id` is destructured OUT of the body deliberately. It identifies the row in
    // the PATH; sending it in the body too gave the request two sources of truth
    // about which row to write, and since the API runs `forbidNonWhitelisted`
    // against a DTO that declares no `id`, every call from this page was in fact
    // being rejected with 400 `property id should not exist`.
    mutationFn: async ({
      id,
      ...body
    }: {
      id: string;
      confirmed: boolean;
      relationshipType?: string;
      rollUpAwards?: boolean;
      rejectionReason?: string;
    }) => api.patch(`/api/intelligence/mappings/${id}`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['intelligence-mappings'] });
      void qc.invalidateQueries({ queryKey: ['contractor-candidates'] });
      invalidateClientIntel(qc);
    },
    onError: (err) => {
      toast.error(`Update failed — ${apiErrorMessage(err)}`);
    },
  });

  const mappings = mappingsQuery.data ?? [];

  /**
   * All clients, for the client-scoped picker. Loaded unconditionally so the
   * picker works whether or not a ?clientId arrived — an empty picker on a fresh
   * visit would push people back to filtering by free text.
   */
  const clientsQuery = useQuery<ClientLite[]>({
    queryKey: ['clients-lite-for-mapping'],
    queryFn: async () => (await api.get<ClientLite[]>('/api/clients')).data,
    staleTime: 60_000,
  });

  const selectedClientName = clientsQuery.data?.find((c) => c.id === clientIdFilter)?.name ?? null;

  const distinctSources = useMemo(
    () => [...new Set(mappings.map((m) => m.source))].sort(),
    [mappings],
  );

  const filtered = useMemo(() => {
    let data = mappings;
    if (clientIdFilter) data = data.filter((m) => m.clientId === clientIdFilter);
    if (clientSearch.trim()) {
      const q = clientSearch.trim().toLowerCase();
      data = data.filter(
        (m) =>
          m.clientName.toLowerCase().includes(q) || m.externalName.toLowerCase().includes(q),
      );
    }
    if (sourceFilter) data = data.filter((m) => m.source === sourceFilter);
    if (basisFilter) data = data.filter((m) => (m.matchBasis ?? 'legacy_unrecorded') === basisFilter);
    if (confirmedFilter === 'confirmed') data = data.filter((m) => m.confirmed);
    if (confirmedFilter === 'unconfirmed') data = data.filter((m) => !m.confirmed);
    return data;
  }, [mappings, clientIdFilter, clientSearch, sourceFilter, basisFilter, confirmedFilter]);

  const sorted = useMemo(
    () =>
      [...filtered].sort((a, b) =>
        sort.dir === 'desc' ? b.confidence - a.confidence : a.confidence - b.confidence,
      ),
    [filtered, sort.dir],
  );

  const { pageRows, currentPage, pageCount, setPage } = useSvPagination(sorted, 25);

  async function handleConfirmAll() {
    const eligible = filtered.filter((m) => m.confidence >= 0.60 && !m.confirmed);
    const toConfirm = eligible.filter((m) => !REQUIRES_INDIVIDUAL_REVIEW.has(m.source));
    const skipped = eligible.length - toConfirm.length;
    for (const m of toConfirm) {
      await confirmMutation.mutateAsync({ id: m.id, confirmed: true });
    }
    toast.success(
      `Confirmed ${toConfirm.length} mapping(s) with ≥60% confidence` +
        (skipped > 0
          ? ` — ${skipped} mapping(s) skipped — federal contractor, assistance-recipient, and PAC-committee matches require individual review regardless of confidence.`
          : ''),
    );
  }

  async function handleRejectAll() {
    // REQUIRES_INDIVIDUAL_REVIEW applies to reject too, since P05. A durable
    // rejection is exactly what entity resolution then refuses to revisit;
    // rejecting a real identity by accident silently removes award history the
    // client is entitled to.
    const lowConfidence = filtered.filter((m) => m.confidence < 0.5 && !m.confirmed);
    const toReject = lowConfidence.filter((m) => !REQUIRES_INDIVIDUAL_REVIEW.has(m.source));
    const skipped = lowConfidence.length - toReject.length;
    for (const m of toReject) {
      await confirmMutation.mutateAsync({
        id: m.id,
        confirmed: false,
        rejectionReason: 'Bulk rejected below the 50% confidence threshold',
      });
    }
    toast.success(
      `Rejected ${toReject.length} low-confidence mapping(s)` +
        (skipped > 0
          ? ` — ${skipped} mapping(s) skipped — federal contractor, assistance-recipient, and PAC-committee matches require individual review, and a rejection there needs a written reason.`
          : ''),
    );
  }

  return (
    <div className="stv-stack">
      <div className="stv-row stv-row--between">
        <h2 className="stv-card__title" style={{ margin: 0 }}>
          Intelligence Mappings
        </h2>
        <div className="stv-row">
          <CapiroButton leadingIcon={<Plus size={14} />} onClick={() => setManualOpen(true)}>
            Add mapping manually
          </CapiroButton>
          <CapiroTooltip content="Matches clients to federal contractors by exact UEI only, and confirms a match only when that identifier resolves to exactly one contractor with no conflicting facts. A similar name is never confirmed automatically.">
            <CapiroButton
              leadingIcon={<CheckCircle2 size={14} />}
              loading={identifierMatchMutation.isPending}
              onClick={() => identifierMatchMutation.mutate()}
            >
              Find exact identifier matches
            </CapiroButton>
          </CapiroTooltip>
          <CapiroButton
            variant="primary"
            leadingIcon={<RefreshCcw size={14} />}
            loading={resolveAllMutation.isPending}
            onClick={() => resolveAllMutation.mutate()}
          >
            Resolve All Clients
          </CapiroButton>
        </div>
      </div>

      {/* Client-scoped review. Rendered above the table so an arrival from a
          profile CTA sees this client's contractor candidates immediately, with
          the evidence, rather than a tenant-wide list to filter. */}
      {clientIdFilter ? (
        <ContractorCandidatePanel
          clientId={clientIdFilter}
          clientName={selectedClientName}
          onChanged={() => {
            void qc.invalidateQueries({ queryKey: ['intelligence-mappings'] });
            invalidateClientIntel(qc);
          }}
        />
      ) : null}

      {/* Filters + bulk actions */}
      <SvCard>
        <div className="stv-row">
          <span style={{ width: 220 }}>
            <CapiroSelect
              label="Client"
              value={clientIdFilter ?? ''}
              onChange={(e) => setClientIdFilter(e.target.value || undefined)}
              options={[
                { value: '', label: 'All clients' },
                ...(clientsQuery.data ?? []).map((c) => ({ label: c.name, value: c.id })),
              ]}
            />
          </span>
          <span style={{ width: 240 }}>
            <CapiroInput
              label="Search"
              placeholder="Search client or external name…"
              value={clientSearch}
              onChange={(e) => setClientSearch(e.target.value)}
            />
          </span>
          <span style={{ width: 150 }}>
            <CapiroSelect
              label="Source"
              value={sourceFilter ?? ''}
              onChange={(e) => setSourceFilter(e.target.value || undefined)}
              options={[
                { value: '', label: 'All sources' },
                ...distinctSources.map((s) => ({ label: s, value: s })),
              ]}
            />
          </span>
          <span style={{ width: 220 }}>
            <CapiroSelect
              label="Match basis"
              value={basisFilter ?? ''}
              onChange={(e) => setBasisFilter(e.target.value || undefined)}
              options={[
                { value: '', label: 'All bases' },
                ...Object.keys(MATCH_BASIS_LABELS).map((k) => ({
                  value: k,
                  label: MATCH_BASIS_LABELS[k]!,
                })),
              ]}
            />
          </span>
          <span style={{ width: 160 }}>
            <CapiroSelect
              label="Status"
              value={confirmedFilter}
              onChange={(e) =>
                setConfirmedFilter(e.target.value as 'all' | 'confirmed' | 'unconfirmed')
              }
              options={[
                { label: 'All statuses', value: 'all' },
                { label: 'Confirmed', value: 'confirmed' },
                { label: 'Unconfirmed', value: 'unconfirmed' },
              ]}
            />
          </span>
          <span className="stv-spacer" />
          <div className="stv-row" style={{ marginTop: 18 }}>
            <CapiroTooltip content="Excludes federal-contractor, assistance-recipient, and PAC-committee mappings — those require individual review regardless of confidence.">
              <CapiroButton
                size="compact"
                leadingIcon={<CheckCircle2 size={13} />}
                onClick={() => void handleConfirmAll()}
                disabled={
                  !filtered.some(
                    (m) =>
                      m.confidence >= 0.60 &&
                      !m.confirmed &&
                      !REQUIRES_INDIVIDUAL_REVIEW.has(m.source),
                  )
                }
              >
                Confirm All ≥ 60%
              </CapiroButton>
            </CapiroTooltip>
            <CapiroTooltip content="Excludes federal-contractor, assistance-recipient, and PAC-committee mappings — a rejection there is durable, so it needs individual review and a written reason.">
              <CapiroButton
                size="compact"
                className="stv-btn-danger"
                onClick={() => void handleRejectAll()}
                disabled={
                  !filtered.some(
                    (m) =>
                      m.confidence < 0.5 &&
                      !m.confirmed &&
                      !REQUIRES_INDIVIDUAL_REVIEW.has(m.source),
                  )
                }
              >
                Reject All &lt; 50%
              </CapiroButton>
            </CapiroTooltip>
          </div>
        </div>
      </SvCard>

      {mappingsQuery.isLoading ? (
        <div className="stv-stack" aria-label="Loading mappings">
          <CapiroSkeleton height={16} />
          <CapiroSkeleton height={16} />
          <CapiroSkeleton height={16} width="70%" />
        </div>
      ) : sorted.length === 0 ? (
        <CapiroEmptyState
          title={sourceFilterLabel ? `No ${sourceFilterLabel} mappings yet.` : 'No mappings yet.'}
          description="Entity resolution proposes candidates automatically, but it can only match records that exist in the federal source tables. If it found nothing for this client, attach the record yourself — a manual mapping is confirmed straight away."
          action={
            <span className="stv-row">
              <CapiroButton
                variant="primary"
                leadingIcon={<Plus size={14} />}
                onClick={() => setManualOpen(true)}
              >
                Add mapping manually
              </CapiroButton>
              <CapiroButton
                leadingIcon={<RefreshCcw size={14} />}
                loading={resolveAllMutation.isPending}
                onClick={() => resolveAllMutation.mutate()}
              >
                Resolve All Clients
              </CapiroButton>
            </span>
          }
        />
      ) : (
        <>
          <CapiroTableWrap>
            <CapiroTable>
              <CapiroTableHead>
                <tr>
                  <CapiroTableHeaderCell>Client</CapiroTableHeaderCell>
                  <CapiroTableHeaderCell>Source</CapiroTableHeaderCell>
                  <CapiroTableHeaderCell>External Name</CapiroTableHeaderCell>
                  <CapiroTableHeaderCell>Match basis</CapiroTableHeaderCell>
                  <CapiroTableHeaderCell>
                    <SvSortHeader
                      label="Confidence"
                      active={sort.key === 'confidence'}
                      dir={sort.dir}
                      onToggle={() => sort.toggle('confidence')}
                    />
                  </CapiroTableHeaderCell>
                  <CapiroTableHeaderCell>Confirmed</CapiroTableHeaderCell>
                  <CapiroTableHeaderCell>Updated</CapiroTableHeaderCell>
                </tr>
              </CapiroTableHead>
              <CapiroTableBody>
                {pageRows.map((record) => (
                  <tr key={record.id}>
                    <CapiroTableCell>
                      <span className="stv-strong">{record.clientName}</span>
                    </CapiroTableCell>
                    <CapiroTableCell>
                      <CapiroBadge style={{ textTransform: 'capitalize' }}>
                        {record.source}
                      </CapiroBadge>
                    </CapiroTableCell>
                    <CapiroTableCell>{record.externalName}</CapiroTableCell>
                    <CapiroTableCell>
                      <span className="stv-row" style={{ gap: 4 }}>
                        <CapiroBadge tone={basisTone(record.matchBasis)}>
                          {basisLabel(record.matchBasis)}
                        </CapiroBadge>
                        {record.relationshipType && record.relationshipType !== 'self' ? (
                          <CapiroTooltip
                            content={
                              record.rollUpAwards
                                ? 'Reviewed corporate relationship; this entity’s awards roll up to the client.'
                                : 'Reviewed corporate relationship; awards do NOT roll up to the client.'
                            }
                          >
                            <CapiroBadge tone={record.rollUpAwards ? 'info' : 'neutral'}>
                              {record.relationshipType.replace(/_/g, ' ')}
                            </CapiroBadge>
                          </CapiroTooltip>
                        ) : null}
                      </span>
                    </CapiroTableCell>
                    <CapiroTableCell>
                      <span className="stv-row" style={{ gap: 8, flexWrap: 'nowrap', minWidth: 120 }}>
                        <SvProgress
                          percent={Math.round(record.confidence * 100)}
                          tone={confidenceTone(record.confidence)}
                          label={`Confidence ${Math.round(record.confidence * 100)}%`}
                        />
                        <span className="stv-small" style={{ minWidth: 36 }}>
                          {Math.round(record.confidence * 100)}%
                        </span>
                      </span>
                    </CapiroTableCell>
                    <CapiroTableCell>
                      {record.reviewStatus === 'rejected' ? (
                        <CapiroTooltip content={record.rejectionReason ?? 'Rejected by reviewer'}>
                          <CapiroBadge tone="danger">Rejected</CapiroBadge>
                        </CapiroTooltip>
                      ) : AWARD_BEARING_SOURCES.has(record.source) && !record.confirmed ? (
                        // Both award-bearing sources, not just `contracting` — a
                        // bare toggle sends only {confirmed}, which the API refuses
                        // because relationship and roll-up cannot be inherited.
                        <CapiroTooltip content="Whose money this is has to be decided explicitly — a relationship type and an award roll-up choice. Use “Add mapping manually” to record both.">
                          <CapiroBadge tone="warning">Review individually</CapiroBadge>
                        </CapiroTooltip>
                      ) : (
                        <SvSwitch
                          checked={record.confirmed}
                          aria-label={`Confirm mapping ${record.externalName}`}
                          disabled={
                            confirmMutation.isPending &&
                            confirmMutation.variables?.id === record.id
                          }
                          onChange={(checked) =>
                            confirmMutation.mutate({
                              id: record.id,
                              confirmed: checked,
                              ...(!checked
                                ? { rejectionReason: 'Rejected from mappings review' }
                                : {}),
                            })
                          }
                        />
                      )}
                    </CapiroTableCell>
                    <CapiroTableCell>
                      <span className="stv-muted stv-small">
                        {new Date(record.updatedAt).toLocaleDateString()}
                      </span>
                    </CapiroTableCell>
                  </tr>
                ))}
              </CapiroTableBody>
            </CapiroTable>
          </CapiroTableWrap>
          <div className="stv-row stv-row--between">
            <span className="stv-muted stv-small">
              {filtered.length} mapping{filtered.length !== 1 ? 's' : ''} shown ·{' '}
              {filtered.filter((m) => m.confirmed).length} confirmed ·{' '}
              {
                filtered.filter(
                  (m) => m.confidence >= 0.85 && !REQUIRES_INDIVIDUAL_REVIEW.has(m.source),
                ).length
              }{' '}
              auto-confirm eligible
            </span>
            <SvPagination currentPage={currentPage} pageCount={pageCount} onPage={setPage} />
          </div>
        </>
      )}

      {/* Seed the picker from ?source= too, so arriving from a profile CTA opens
          the modal already on the source that CTA was about. */}
      <ManualMapModal
        open={manualOpen}
        initialSource={asMappingSource(searchParams.get('source'))}
        onClose={() => setManualOpen(false)}
      />
    </div>
  );
}

interface ClientLite {
  id: string;
  name: string;
}

/**
 * Contractor identity candidates for ONE client, with the full match explanation.
 *
 * This panel is the answer to §8's "do not display a bare confidence percentage".
 * For each candidate it shows the basis, the exact identifiers that matched, the
 * normalized names actually compared, the corroborating facts and — the part a
 * percentage can never convey — the CONFLICTING facts. Confirm is disabled for a
 * candidate the policy judged ambiguous, with the reason shown.
 */
function ContractorCandidatePanel({
  clientId,
  clientName,
  onChanged,
}: {
  clientId: string;
  clientName: string | null;
  onChanged: () => void;
}) {
  const api = useApi();
  const toast = useCapiroToast();

  const candidates = useQuery<ContractorCandidateView>({
    queryKey: ['contractor-candidates', clientId],
    queryFn: async () =>
      (
        await api.get<ContractorCandidateView>(
          `/api/intelligence/mappings/${clientId}/contractor-candidates`,
        )
      ).data,
    enabled: Boolean(clientId),
    staleTime: 30_000,
    retry: 1,
  });

  const pinMutation = useMutation({
    mutationFn: async (input: {
      contractorId: string;
      contractorName: string;
      relationshipType: string;
      rollUpAwards: boolean;
    }) =>
      api.post(`/api/intelligence/mappings/${clientId}/manual`, {
        source: 'contracting',
        externalId: input.contractorId,
        externalName: input.contractorName,
        relationshipType: input.relationshipType,
        rollUpAwards: input.rollUpAwards,
      }),
    onSuccess: (_d, input) => {
      toast.success(
        `Contractor identity confirmed — "${input.contractorName}" is now a confirmed contracting mapping (${input.relationshipType.replace(/_/g, ' ')}).`,
      );
      void candidates.refetch();
      onChanged();
    },
    onError: (err) => toast.error(`Confirm failed — ${apiErrorMessage(err)}`),
  });

  const rejectMutation = useMutation({
    mutationFn: async (input: { contractorId: string; contractorName: string }) =>
      api.post(`/api/intelligence/mappings/${clientId}/reject-candidate`, {
        source: 'contracting',
        externalId: input.contractorId,
        externalName: input.contractorName,
        reason: 'Rejected from contractor identity review',
      }),
    onSuccess: () => {
      toast.success('Contractor candidate rejected');
      void candidates.refetch();
      onChanged();
    },
    onError: (err) => toast.error(`Reject failed — ${apiErrorMessage(err)}`),
  });

  const relationItems = [
    ['former_name', 'former name'],
    ['parent', 'parent'],
    ['subsidiary', 'subsidiary'],
    ['operating_unit', 'operating unit'],
    ['alias', 'alias'],
  ] as const;

  return (
    <SvCard
      data-testid="contractor-candidate-panel"
      title={`Federal contractor identity — ${clientName ?? 'selected client'}`}
      extra={
        <span className="stv-row" style={{ gap: 8 }}>
          {candidates.data?.client.uei ? (
            <CapiroBadge tone="success">UEI on file: {candidates.data.client.uei}</CapiroBadge>
          ) : (
            <CapiroTooltip content="Without a UEI, no contractor identity can be confirmed automatically — every candidate needs manual review.">
              <CapiroBadge tone="warning">No UEI on file</CapiroBadge>
            </CapiroTooltip>
          )}
          <CapiroButton
            size="compact"
            onClick={() => void candidates.refetch()}
            loading={candidates.isFetching}
          >
            Refresh
          </CapiroButton>
        </span>
      }
    >
      {candidates.isPending ? (
        <div className="stv-stack" aria-label="Loading contractor candidates">
          <CapiroSkeleton height={16} />
          <CapiroSkeleton height={16} width="70%" />
        </div>
      ) : candidates.isError ? (
        <SvCallout
          kind="error"
          title="Contractor candidates could not be loaded"
          description="This is a request failure, not an empty result — no conclusion can be drawn about whether candidates exist."
          action={
            <CapiroButton size="compact" onClick={() => void candidates.refetch()}>
              Retry
            </CapiroButton>
          }
        />
      ) : (candidates.data?.candidates.length ?? 0) === 0 ? (
        <CapiroEmptyState
          title="No candidates found"
          description="No federal contractor record resembles this client's name, and no UEI match was found. Use Add mapping manually to pin an exact record — a renamed or legacy entity will not surface by name."
        />
      ) : (
        <CapiroTableWrap style={{ maxHeight: 380, overflowY: 'auto' }}>
          <CapiroTable>
            <CapiroTableHead>
              <tr>
                <CapiroTableHeaderCell>Federal contractor</CapiroTableHeaderCell>
                <CapiroTableHeaderCell>Basis</CapiroTableHeaderCell>
                <CapiroTableHeaderCell>Identifiers &amp; obligations</CapiroTableHeaderCell>
                <CapiroTableHeaderCell>Evidence</CapiroTableHeaderCell>
                <CapiroTableHeaderCell />
              </tr>
            </CapiroTableHead>
            <CapiroTableBody>
              {candidates.data!.candidates.map((r) => (
                <tr key={r.contractorId}>
                  <CapiroTableCell>
                    <span className="stv-strong">{r.contractorName}</span>
                    <div className="stv-muted stv-small">
                      normalized: {r.explanation?.normalizedCandidateName ?? '—'}
                    </div>
                  </CapiroTableCell>
                  <CapiroTableCell>
                    <div className="stv-stack stv-stack--tight" style={{ gap: 2 }}>
                      <CapiroBadge tone={basisTone(r.matchBasis)}>
                        {basisLabel(r.matchBasis)} · tier {r.matchTier}
                      </CapiroBadge>
                      {Object.entries(r.explanation?.exactIdentifiers ?? {}).map(([k, v]) => (
                        <code key={k} className="stv-code">
                          {k}: {v}
                        </code>
                      ))}
                    </div>
                  </CapiroTableCell>
                  <CapiroTableCell>
                    <div className="stv-stack stv-stack--tight" style={{ gap: 0 }}>
                      <span className="stv-small">
                        Obligated: {formatSpend(r.explanation?.totalObligated ?? null)}
                      </span>
                      <span className="stv-muted stv-small">
                        {/* null, not 0 — "we hold no figure" is not "there were no awards". */}
                        Awards: {r.explanation?.awardCount ?? 'not held'}
                      </span>
                      <span className="stv-muted stv-small">
                        Source synced:{' '}
                        {r.explanation?.sourceSyncedAt
                          ? new Date(r.explanation.sourceSyncedAt).toLocaleDateString()
                          : 'unknown'}
                      </span>
                    </div>
                  </CapiroTableCell>
                  <CapiroTableCell>
                    <div className="stv-stack stv-stack--tight" style={{ gap: 2 }}>
                      {r.explanation?.corroborators.length ? (
                        <span className="stv-small">
                          Corroborated by: {r.explanation.corroborators.join(', ')}
                        </span>
                      ) : (
                        <span className="stv-muted stv-small">
                          No corroborating facts beyond the name.
                        </span>
                      )}
                      {r.explanation?.conflicts.length ? (
                        <ul style={{ margin: 0, paddingLeft: 16 }}>
                          {r.explanation.conflicts.map((c) => (
                            <li key={c}>
                              <span className="stv-warning-text stv-small">{c}</span>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      {!r.autoConfirmEligible && r.explanation?.conflicts.length === 0 ? (
                        <span className="stv-muted stv-small">Needs a human decision.</span>
                      ) : null}
                    </div>
                  </CapiroTableCell>
                  <CapiroTableCell>
                    {r.mapping?.reviewStatus === 'rejected' ? (
                      <CapiroTooltip content={r.mapping.rejectionReason ?? 'Rejected by reviewer'}>
                        <CapiroBadge tone="danger">Rejected</CapiroBadge>
                      </CapiroTooltip>
                    ) : r.mapping?.confirmed ? (
                      <CapiroBadge tone="success">Confirmed</CapiroBadge>
                    ) : (
                      <span className="stv-row" style={{ gap: 4 }}>
                        <CapiroButton
                          size="compact"
                          variant="primary"
                          loading={
                            pinMutation.isPending &&
                            pinMutation.variables?.contractorId === r.contractorId
                          }
                          onClick={() =>
                            pinMutation.mutate({
                              contractorId: r.contractorId,
                              contractorName: r.contractorName,
                              relationshipType: 'self',
                              rollUpAwards: true,
                            })
                          }
                        >
                          Confirm as this client
                        </CapiroButton>
                        <CapiroPopover
                          label={`Other relationships for ${r.contractorName}`}
                          trigger={<span className="capiro-button capiro-button--secondary capiro-button--compact">Other…</span>}
                        >
                          <CapiroMenu
                            label="Confirm with relationship"
                            items={relationItems.flatMap(([relationshipType, label]) => [
                              {
                                id: `${relationshipType}:rollup`,
                                label: `Confirm as ${label} · roll awards up`,
                                onSelect: () =>
                                  pinMutation.mutate({
                                    contractorId: r.contractorId,
                                    contractorName: r.contractorName,
                                    relationshipType,
                                    rollUpAwards: true,
                                  }),
                              },
                              {
                                id: `${relationshipType}:no-rollup`,
                                label: `Confirm as ${label} · do not roll awards up`,
                                onSelect: () =>
                                  pinMutation.mutate({
                                    contractorId: r.contractorId,
                                    contractorName: r.contractorName,
                                    relationshipType,
                                    rollUpAwards: false,
                                  }),
                              },
                            ])}
                          />
                        </CapiroPopover>
                        <CapiroButton
                          size="compact"
                          className="stv-btn-danger"
                          loading={
                            rejectMutation.isPending &&
                            rejectMutation.variables?.contractorId === r.contractorId
                          }
                          onClick={() =>
                            rejectMutation.mutate({
                              contractorId: r.contractorId,
                              contractorName: r.contractorName,
                            })
                          }
                        >
                          Reject
                        </CapiroButton>
                      </span>
                    )}
                  </CapiroTableCell>
                </tr>
              ))}
            </CapiroTableBody>
          </CapiroTable>
        </CapiroTableWrap>
      )}
    </SvCard>
  );
}

interface LdaSearchResult {
  id: string;
  name: string;
  state: string | null;
  totalFilings: number;
  latestFilingYear: number | null;
  totalSpending: number | null;
  issueCodes: string[];
  similarity: number;
}

interface FecEmployerResult {
  id: string;
  name: string;
  contributionCount: number;
  totalAmount: number | null;
  latestYear: number | null;
  similarity: number;
}

interface ContractorResult {
  id: string;
  name: string;
  uei: string | null;
  category: string | null;
  totalContracts: number | null;
  rankByContracts: number | null;
  sourceSyncedAt: string | null;
  similarity: number;
  /** True when the query WAS the contractor's UEI — a verified identifier hit. */
  matchedOnIdentifier: boolean;
}

/**
 * The contractor search returns a wrapper rather than a bare array:
 * `unsupportedIdentifier` lets the UI say what actually happened when a user
 * pastes an identifier (e.g. CAGE) the source data cannot support.
 */
interface ContractorSearchResponse {
  results: ContractorResult[];
  unsupportedIdentifier: string | null;
}

interface AssistanceRecipientResult {
  id: string;
  uei: string | null;
  // Always present — the search query filters WHERE recipient_name IS NOT NULL.
  name: string;
  state: string | null;
  awardCount: number;
  totalObligated: number | null;
  similarity: number;
}

/**
 * Attach an external record to a client by its exact identifier. Fuzzy
 * auto-resolve keys off the client's NAME, so a renamed/legacy entity
 * ("RAYTHEON TECHNOLOGIES" registrants, or "RAYTHEON" contribution-employer
 * strings, under a client named "RTX") never surfaces and can't be confirmed.
 * Here the user searches the federal registry freely and pins the exact
 * record(s) — saved as confirmed mappings the union logic reads at once.
 */
function ManualMapModal({
  open,
  initialSource,
  onClose,
}: {
  open: boolean;
  /** Preselect this source when the modal opens (from the URL's ?source=). */
  initialSource?: MappingSource;
  onClose: () => void;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useCapiroToast();
  const [source, setSource] = useState<MappingSource>(initialSource ?? 'lda');
  const [clientId, setClientId] = useState<string | undefined>(undefined);
  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');
  const [relationshipType, setRelationshipType] = useState('self');
  const [rollUpAwards, setRollUpAwards] = useState(true);

  // The modal stays mounted between opens, so useState's initial value only
  // applies once. Re-apply the deep-linked source each time it opens.
  useEffect(() => {
    if (open && initialSource) setSource(initialSource);
  }, [open, initialSource]);

  // Reset transient state when the modal closes (canonical afterClose).
  useEffect(() => {
    if (open) return;
    setSource('lda');
    setClientId(undefined);
    setRelationshipType('self');
    setRollUpAwards(true);
    setSearchInput('');
    setQuery('');
  }, [open]);

  const clientsQuery = useQuery<ClientLite[]>({
    queryKey: ['clients-lite-for-mapping'],
    queryFn: async () => (await api.get<ClientLite[]>('/api/clients')).data,
    enabled: open,
    staleTime: 60_000,
  });

  const ldaSearch = useQuery<LdaSearchResult[]>({
    queryKey: ['lda-client-search', query],
    queryFn: async () =>
      (
        await api.get<LdaSearchResult[]>(
          `/api/intelligence/lda-clients/search?q=${encodeURIComponent(query)}`,
        )
      ).data,
    enabled: open && source === 'lda' && query.trim().length > 0,
  });

  const fecSearch = useQuery<FecEmployerResult[]>({
    queryKey: ['fec-employer-search', query],
    queryFn: async () =>
      (
        await api.get<FecEmployerResult[]>(
          `/api/intelligence/fec-employers/search?q=${encodeURIComponent(query)}`,
        )
      ).data,
    enabled: open && source === 'fec_employer' && query.trim().length > 0,
  });

  const contractorSearch = useQuery<ContractorSearchResponse>({
    queryKey: ['contractor-search', query],
    queryFn: async () =>
      (
        await api.get<ContractorSearchResponse>(
          `/api/intelligence/contractors/search?q=${encodeURIComponent(query)}`,
        )
      ).data,
    enabled: open && source === 'contracting' && query.trim().length > 0,
  });

  const assistanceRecipientSearch = useQuery<AssistanceRecipientResult[]>({
    queryKey: ['assistance-recipient-search', query],
    queryFn: async () =>
      (
        await api.get<AssistanceRecipientResult[]>(
          `/api/intelligence/assistance-recipients/search?q=${encodeURIComponent(query)}`,
        )
      ).data,
    enabled: open && source === 'assistance_recipient' && query.trim().length > 0,
  });

  const isFetching =
    source === 'lda'
      ? ldaSearch.isFetching
      : source === 'fec_employer'
        ? fecSearch.isFetching
        : source === 'contracting'
          ? contractorSearch.isFetching
          : assistanceRecipientSearch.isFetching;

  const attachMutation = useMutation({
    mutationFn: async (r: { id: string; name: string }) =>
      api.post(`/api/intelligence/mappings/${clientId}/manual`, {
        source,
        externalId: r.id,
        externalName: r.name,
        ...(['contracting', 'assistance_recipient'].includes(source)
          ? { relationshipType, rollUpAwards }
          : {}),
      }),
    onSuccess: (_d, r) => {
      const sourceLabel =
        source === 'lda'
          ? 'LDA'
          : source === 'fec_employer'
            ? 'FEC employer'
            : source === 'contracting'
              ? 'federal contractor'
              : 'assistance recipient';
      const feeds =
        source === 'lda'
          ? 'issue-code matching'
          : source === 'fec_employer'
            ? 'contribution panel'
            : source === 'contracting'
              ? 'contract/obligation footprint'
              : 'grant/assistance footprint';
      const awardBearing = source === 'contracting' || source === 'assistance_recipient';
      toast.success(
        awardBearing && !rollUpAwards
          ? `Mapping attached — "${r.name}" is now a confirmed ${sourceLabel} relationship. Its awards will not be attributed to this client.`
          : `Mapping attached — "${r.name}" is now a confirmed ${sourceLabel} mapping. It feeds this client's ${feeds} immediately.`,
      );
      void qc.invalidateQueries({ queryKey: ['intelligence-mappings'] });
      invalidateClientIntel(qc);
    },
    onError: (err) => toast.error(`Attach failed — ${apiErrorMessage(err)}`),
  });

  const attachButton = (record: { id: string; name: string }) => (
    <CapiroButton
      size="compact"
      variant="primary"
      disabled={!clientId}
      loading={attachMutation.isPending && attachMutation.variables?.id === record.id}
      onClick={() => attachMutation.mutate({ id: record.id, name: record.name })}
    >
      Attach
    </CapiroButton>
  );

  if (!open) return null;

  return (
    <CapiroModal open title="Attach a federal record manually" onClose={onClose}>
      <div className="stv-stack stv-modal-wide">
        <span className="stv-muted stv-small">
          Use this for records the automatic matcher can&apos;t find — a renamed or legacy entity
          (&quot;RAYTHEON TECHNOLOGIES&quot; under a client named &quot;RTX&quot;). Pick the client,
          search the federal registry, and pin the exact record. It&apos;s saved as a confirmed
          mapping and folded into that client&apos;s footprint right away.
        </span>

        <SvSegmented
          block
          aria-label="Mapping source"
          value={source}
          onChange={(v) => {
            setSource(v);
            setSearchInput('');
            setQuery('');
          }}
          options={MAPPING_SOURCE_OPTIONS}
        />

        <CapiroSelect
          label="1 · Select the client to attach to"
          value={clientId ?? ''}
          onChange={(e) => setClientId(e.target.value || undefined)}
          options={[
            { value: '', label: 'Select a client' },
            ...(clientsQuery.data ?? []).map((c) => ({ label: c.name, value: c.id })),
          ]}
        />

        {source === 'contracting' || source === 'assistance_recipient' ? (
          <SvCard>
            <div className="stv-row">
              <span style={{ width: 220 }}>
                <CapiroSelect
                  label="Federal entity relationship"
                  value={relationshipType}
                  onChange={(e) => setRelationshipType(e.target.value)}
                  options={[
                    { value: 'self', label: 'This client' },
                    { value: 'alias', label: 'Alias' },
                    { value: 'former_name', label: 'Former name' },
                    { value: 'parent', label: 'Parent' },
                    { value: 'subsidiary', label: 'Subsidiary' },
                    { value: 'operating_unit', label: 'Operating unit' },
                  ]}
                />
              </span>
              <span className="stv-row" style={{ marginTop: 18 }}>
                <SvSwitch
                  checked={rollUpAwards}
                  onChange={setRollUpAwards}
                  aria-label="Roll awards up"
                />
                <span>Roll this entity’s awards up to the client</span>
              </span>
            </div>
          </SvCard>
        ) : null}

        <form
          className="stv-row"
          onSubmit={(event) => {
            event.preventDefault();
            setQuery(searchInput);
          }}
        >
          <span style={{ flex: 1 }}>
            <CapiroInput
              label="2 · Search"
              placeholder={
                source === 'lda'
                  ? '2 · Search LDA registry by name or id (e.g. raytheon, or 4321)'
                  : source === 'fec_employer'
                    ? '2 · Search FEC contributor-employers by name (e.g. raytheon)'
                    : source === 'contracting'
                      ? '2 · Search federal contractors by name (e.g. raytheon)'
                      : '2 · Search assistance recipients by name or UEI'
              }
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </span>
          <CapiroButton variant="primary" type="submit" loading={isFetching} style={{ marginTop: 18 }}>
            Search
          </CapiroButton>
        </form>

        {query.trim().length > 0 &&
          (source === 'lda' ? (
            <SearchResultTable
              loading={ldaSearch.isFetching}
              emptyText="No LDA registrants matched. Try a shorter name or the numeric id."
              headers={['LDA id', 'Registrant name', 'State', 'Filings', 'Latest', 'Spend', 'Issue codes', '']}
              rows={(ldaSearch.data ?? []).map((r) => ({
                key: r.id,
                cells: [
                  <code className="stv-code" key="id">
                    {r.id}
                  </code>,
                  r.name,
                  r.state ?? '—',
                  r.totalFilings,
                  r.latestFilingYear ?? '—',
                  formatSpend(r.totalSpending),
                  r.issueCodes.length ? (
                    <span key="codes">
                      {r.issueCodes.slice(0, 4).map((c) => (
                        <CapiroBadge key={c}>{c}</CapiroBadge>
                      ))}
                      {r.issueCodes.length > 4 ? (
                        <span className="stv-muted"> +{r.issueCodes.length - 4}</span>
                      ) : null}
                    </span>
                  ) : (
                    <span className="stv-muted">—</span>
                  ),
                  attachButton(r),
                ],
              }))}
            />
          ) : source === 'fec_employer' ? (
            <SearchResultTable
              loading={fecSearch.isFetching}
              emptyText="No FEC employers matched. Try a shorter or alternate spelling."
              headers={['Contributor employer', 'Contributions', 'Total', 'Latest', '']}
              rows={(fecSearch.data ?? []).map((r) => ({
                key: r.id,
                cells: [
                  r.name,
                  r.contributionCount,
                  formatSpend(r.totalAmount),
                  r.latestYear ?? '—',
                  attachButton(r),
                ],
              }))}
            />
          ) : source === 'contracting' ? (
            <>
              {contractorSearch.data?.unsupportedIdentifier ? (
                <SvCallout
                  kind="warning"
                  title={contractorSearch.data.unsupportedIdentifier}
                />
              ) : null}
              <SearchResultTable
                loading={contractorSearch.isFetching}
                emptyText="No federal contractors matched. Try a shorter or alternate spelling, the exact UEI, or paste the contractor UUID."
                headers={['Contractor name', 'UEI', 'Category', 'Total contracts', 'Rank', '']}
                rows={(contractorSearch.data?.results ?? []).map((r) => ({
                  key: r.id,
                  cells: [
                    r.name,
                    r.uei ? (
                      <span className="stv-row" style={{ gap: 4 }} key="uei">
                        <code className="stv-code">{r.uei}</code>
                        {r.matchedOnIdentifier ? (
                          <CapiroTooltip content="Your search matched this contractor's UEI exactly — a verified identifier, not a name guess.">
                            <CapiroBadge tone="success">exact</CapiroBadge>
                          </CapiroTooltip>
                        ) : null}
                      </span>
                    ) : (
                      '—'
                    ),
                    r.category ?? '—',
                    formatSpend(r.totalContracts),
                    r.rankByContracts ? `#${r.rankByContracts}` : '—',
                    attachButton(r),
                  ],
                }))}
              />
            </>
          ) : (
            <SearchResultTable
              loading={assistanceRecipientSearch.isFetching}
              emptyText="No assistance recipients matched. Try a shorter name or the exact UEI."
              headers={['Recipient name', 'UEI', 'State', 'Awards', 'Total obligated', '']}
              rows={(assistanceRecipientSearch.data ?? []).map((r) => ({
                key: r.id,
                cells: [
                  r.name,
                  r.uei ?? '—',
                  r.state ?? '—',
                  r.awardCount,
                  formatSpend(r.totalObligated),
                  attachButton(r),
                ],
              }))}
            />
          ))}

        <div className="stv-row stv-row--end">
          <CapiroButton onClick={onClose}>Done</CapiroButton>
        </div>
      </div>
    </CapiroModal>
  );
}

function SearchResultTable({
  loading,
  emptyText,
  headers,
  rows,
}: {
  loading: boolean;
  emptyText: string;
  headers: string[];
  rows: Array<{ key: string; cells: React.ReactNode[] }>;
}) {
  if (loading) {
    return (
      <div className="stv-stack" aria-label="Searching">
        <CapiroSkeleton height={16} />
        <CapiroSkeleton height={16} width="70%" />
      </div>
    );
  }
  if (rows.length === 0) return <CapiroEmptyState title={emptyText} />;
  return (
    <CapiroTableWrap style={{ maxHeight: 340, overflowY: 'auto' }}>
      <CapiroTable>
        <CapiroTableHead>
          <tr>
            {headers.map((h, i) => (
              <CapiroTableHeaderCell key={i}>{h}</CapiroTableHeaderCell>
            ))}
          </tr>
        </CapiroTableHead>
        <CapiroTableBody>
          {rows.map((row) => (
            <tr key={row.key}>
              {row.cells.map((cell, i) => (
                <CapiroTableCell key={i}>{cell}</CapiroTableCell>
              ))}
            </tr>
          ))}
        </CapiroTableBody>
      </CapiroTable>
    </CapiroTableWrap>
  );
}
