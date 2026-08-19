/**
 * vNext re-skin of pages/settings/PolicyPacksPage.tsx — identical endpoints,
 * query keys, lifecycle/independence rules (policyPackActionState), payload
 * builders and copy via policy-packs-shared.ts. Simulations are evidence-only
 * and can never authorize an action; publishing and rollback remain
 * server-owned, audited transitions.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { History, Plus, RefreshCcw, ShieldCheck } from 'lucide-react';
import { ROLE_RANK } from '@capiro/shared';
import { useApi } from '../../../lib/use-api.js';
import { useMe } from '../../../lib/me.js';
import {
  buildPolicyPackPayload,
  buildSimulationPayload,
  policyPackActionState,
  policyPackErrorMessage as errorMessage,
  policyPackFormValuesFor as formValuesFor,
  policyPackStatusLabel as statusLabel,
  type PolicyDecisionRow,
  type PolicyOutcome,
  type PolicyPackEvent,
  type PolicyPackFormValues,
  type PolicyPackRow,
  type PolicyPackStatus,
  type PolicyRuleFormValue,
} from '../../../pages/settings/policy-packs-shared.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge, type CapiroBadgeTone } from '../../components/badges/index.js';
import { CapiroInput, CapiroSelect } from '../../components/fields/index.js';
import { CapiroEmptyState, CapiroSkeleton } from '../../components/feedback/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { CapiroTabs, CapiroTooltip } from '../../components/menus/index.js';
import { CapiroDrawer, CapiroModal } from '../../components/overlays/index.js';
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
  SvDescriptions,
  SvPagination,
  SvSwitch,
  SvTagInput,
  SvTextArea,
  useSvPagination,
} from './settings-ui.js';

interface SimulationFormValues {
  tool: string;
  inputJson: string;
  jurisdiction?: Exclude<PolicyPackRow['jurisdiction'], 'all'>;
  clientId?: string;
}

interface ReasonState {
  action: 'submit-review' | 'review' | 'second-approve' | 'publish' | 'retire' | 'rollback';
  pack: PolicyPackRow;
  targetId?: string;
}

function statusTone(status: PolicyPackStatus): CapiroBadgeTone {
  return {
    draft: 'neutral' as const,
    pending_review: 'warning' as const,
    reviewed: 'info' as const,
    published: 'success' as const,
    retired: 'neutral' as const,
    disabled_example: 'danger' as const,
  }[status];
}

function outcomeTone(outcome: PolicyOutcome): CapiroBadgeTone {
  return outcome === 'PASS' ? 'success' : outcome === 'WARN' ? 'warning' : 'danger';
}

const EMPTY_RULE: PolicyRuleFormValue = {
  id: '',
  description: '',
  outcome: 'WARN',
  enabled: true,
  tools: [],
  tests: [],
  authorityRef: '',
  reason: '',
  additionalMatchJson: '',
};

function emptyFormValues(): PolicyPackFormValues {
  return {
    packKey: '',
    version: '',
    jurisdiction: 'all',
    legalReviewStatus: 'pending',
    authorityType: 'approved_product_policy',
    authorityTitle: '',
    effectiveFrom: new Date().toISOString(),
    fourEyesRequired: true,
    fallback: 'WARN',
    nonProduction: true,
    rules: [{ ...EMPTY_RULE }],
  };
}

export function VNextPolicyPacksPage() {
  const api = useApi();
  const me = useMe();
  const qc = useQueryClient();
  const toast = useCapiroToast();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<PolicyPackRow | null>(null);
  const [editorValues, setEditorValues] = useState<PolicyPackFormValues>(emptyFormValues);
  const [reasonState, setReasonState] = useState<ReasonState | null>(null);
  const [reasonValue, setReasonValue] = useState('');
  const [reviewClassification, setReviewClassification] = useState<
    'approved' | 'not_required_product_policy'
  >('approved');
  const [rollbackTargetId, setRollbackTargetId] = useState<string | undefined>();
  const [simulationPack, setSimulationPack] = useState<PolicyPackRow | null>(null);
  const [simulationValues, setSimulationValues] = useState<SimulationFormValues>({
    tool: '',
    inputJson: '',
  });
  const [simulationResult, setSimulationResult] = useState<Record<string, unknown> | null>(null);
  const [eventsPack, setEventsPack] = useState<PolicyPackRow | null>(null);
  const [activeSection, setActiveSection] = useState('packs');

  const isAdmin = Boolean(me.data && ROLE_RANK[me.data.role] >= ROLE_RANK.user_admin);
  const currentUserId = me.data?.user.id ?? '';

  const packs = useQuery<PolicyPackRow[]>({
    queryKey: ['meri-policy-packs'],
    queryFn: async () => (await api.get<PolicyPackRow[]>('/api/clio/policy-packs')).data,
    enabled: isAdmin,
    retry: false,
  });
  const decisions = useQuery<PolicyDecisionRow[]>({
    queryKey: ['meri-policy-decisions'],
    queryFn: async () =>
      (await api.get<PolicyDecisionRow[]>('/api/clio/policy-packs/decisions/recent')).data,
    enabled: isAdmin && activeSection === 'decisions',
    retry: false,
  });
  const events = useQuery<PolicyPackEvent[]>({
    queryKey: ['meri-policy-pack-events', eventsPack?.id],
    queryFn: async () =>
      (
        await api.get<PolicyPackEvent[]>(
          `/api/clio/policy-packs/${encodeURIComponent(eventsPack!.id)}/events`,
        )
      ).data,
    enabled: isAdmin && Boolean(eventsPack),
    retry: false,
  });

  const invalidate = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['meri-policy-packs'] }),
      qc.invalidateQueries({ queryKey: ['meri-policy-decisions'] }),
    ]);
  };

  const operation = useMutation({
    mutationFn: async (request: {
      method: 'post' | 'patch';
      url: string;
      body?: Record<string, unknown>;
      success: string;
    }) => {
      const response =
        request.method === 'patch'
          ? await api.patch(request.url, request.body ?? {})
          : await api.post(request.url, request.body ?? {});
      return { data: response.data, success: request.success };
    },
    onSuccess: async ({ success }) => {
      toast.success(success);
      setEditorOpen(false);
      setEditing(null);
      setReasonState(null);
      setReasonValue('');
      setRollbackTargetId(undefined);
      await invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const simulate = useMutation({
    mutationFn: async (request: { packId: string; body: Record<string, unknown> }) =>
      (
        await api.post<Record<string, unknown>>(
          `/api/clio/policy-packs/${encodeURIComponent(request.packId)}/simulate`,
          request.body,
        )
      ).data,
    onSuccess: (result) => {
      setSimulationResult(result);
      toast.success('Simulation completed. No approval binding was created.');
      void qc.invalidateQueries({ queryKey: ['meri-policy-decisions'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const retired = useMemo(
    () => (packs.data ?? []).filter((pack) => pack.status === 'retired'),
    [packs.data],
  );

  const decisionRows = decisions.data ?? [];
  const decisionsPager = useSvPagination(decisionRows, 25);

  const openCreate = () => {
    setEditing(null);
    setEditorValues(emptyFormValues());
    setEditorOpen(true);
  };

  const openEdit = (pack: PolicyPackRow) => {
    setEditing(pack);
    setEditorValues(formValuesFor(pack));
    setEditorOpen(true);
  };

  const submitEditor = () => {
    try {
      const body = buildPolicyPackPayload(editorValues, Boolean(editing));
      operation.mutate({
        method: editing ? 'patch' : 'post',
        url: editing
          ? `/api/clio/policy-packs/${encodeURIComponent(editing.id)}`
          : '/api/clio/policy-packs',
        body,
        success: editing ? 'Policy-pack draft revised' : 'Policy-pack draft created',
      });
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const submitReason = () => {
    if (!reasonState || !reasonValue.trim()) return;
    const base = `/api/clio/policy-packs/${encodeURIComponent(reasonState.pack.id)}`;
    const body: Record<string, unknown> = { reason: reasonValue.trim() };
    if (reasonState.action === 'review') {
      body.legalReviewStatus = reviewClassification;
    }
    const targetId = rollbackTargetId ?? reasonState.targetId;
    if (reasonState.action === 'rollback' && !targetId) return;
    const url =
      reasonState.action === 'rollback'
        ? `${base}/rollback/${encodeURIComponent(targetId ?? '')}`
        : `${base}/${reasonState.action}`;
    const labels: Record<ReasonState['action'], string> = {
      'submit-review': 'Policy pack submitted for independent review',
      review: 'Independent review recorded',
      'second-approve': 'Second independent approval recorded',
      publish: 'Policy pack published',
      retire: 'Policy pack retired',
      rollback: 'Policy pack rolled back',
    };
    operation.mutate({ method: 'post', url, body, success: labels[reasonState.action] });
  };

  const openReason = (state: ReasonState) => {
    setReasonValue('');
    setReviewClassification('approved');
    setReasonState(state);
  };

  const setRule = (index: number, patch: Partial<PolicyRuleFormValue>) => {
    setEditorValues((current) => ({
      ...current,
      rules: current.rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)),
    }));
  };

  if (me.isLoading) {
    return (
      <SvCard aria-label="Loading policy packs">
        <div className="stv-stack">
          <CapiroSkeleton height={20} width="35%" />
          <CapiroSkeleton height={16} />
        </div>
      </SvCard>
    );
  }
  if (!isAdmin) {
    return (
      <SvCallout
        kind="warning"
        title="Policy-pack administration requires an administrator"
        description="The server also enforces this boundary. No policy data was requested."
      />
    );
  }

  return (
    <section className="stv-stack" aria-labelledby="policy-packs-title">
      <div className="stv-row stv-row--between stv-row--start">
        <div>
          <h2 id="policy-packs-title" className="stv-card__title" style={{ margin: 0 }}>
            Action policy packs
          </h2>
          <p className="stv-card__desc" style={{ maxWidth: 860 }}>
            Versioned, independently reviewed rules that decide whether Meri may perform an action,
            must request approval, or must block. Simulations are evidence-only and can never
            authorize an action. Publishing and rollback remain server-owned, audited transitions.
          </p>
        </div>
        <div className="stv-row">
          <CapiroButton
            leadingIcon={<RefreshCcw size={14} />}
            loading={operation.isPending}
            onClick={() =>
              operation.mutate({
                method: 'post',
                url: '/api/clio/policy-packs/seed-baseline',
                success: 'Reviewed baseline is available',
              })
            }
          >
            Install baseline
          </CapiroButton>
          <CapiroButton variant="primary" leadingIcon={<Plus size={14} />} onClick={openCreate}>
            New policy pack
          </CapiroButton>
        </div>
      </div>

      <SvCallout
        kind="info"
        title="Activation is intentionally separate from authoring"
        description="Drafts and simulations do not affect live actions. A production pack must complete the configured independent review path before an administrator can publish it."
      />

      <CapiroTabs
        label="Policy pack sections"
        activeId={activeSection}
        onChange={setActiveSection}
        items={[
          { id: 'packs', label: 'Policy packs' },
          { id: 'decisions', label: 'Recent decisions' },
        ]}
      />

      {activeSection === 'packs' ? (
        packs.isLoading ? (
          <div className="stv-stack" aria-label="Loading policy packs">
            <CapiroSkeleton height={16} />
            <CapiroSkeleton height={16} width="70%" />
          </div>
        ) : (packs.data ?? []).length === 0 ? (
          <CapiroEmptyState title="No policy packs yet. Install the reviewed baseline or create a non-production draft." />
        ) : (
          <CapiroTableWrap>
            <CapiroTable>
              <CapiroTableHead>
                <tr>
                  <CapiroTableHeaderCell>Policy pack</CapiroTableHeaderCell>
                  <CapiroTableHeaderCell>Scope</CapiroTableHeaderCell>
                  <CapiroTableHeaderCell>Lifecycle</CapiroTableHeaderCell>
                  <CapiroTableHeaderCell>Authority</CapiroTableHeaderCell>
                  <CapiroTableHeaderCell>Actions</CapiroTableHeaderCell>
                </tr>
              </CapiroTableHead>
              <CapiroTableBody>
                {(packs.data ?? []).map((pack) => {
                  const state = policyPackActionState(pack, currentUserId, retired);
                  const retiredCandidates = retired.filter(
                    (candidate) =>
                      candidate.packKey === pack.packKey && !candidate.nonProduction,
                  );
                  return (
                    <tr key={pack.id}>
                      <CapiroTableCell>
                        <span className="stv-strong">{pack.packKey}</span>
                        <div className="stv-muted stv-small">Version {pack.version}</div>
                      </CapiroTableCell>
                      <CapiroTableCell>
                        {pack.jurisdiction === 'all' ? 'All jurisdictions' : pack.jurisdiction}
                        <div className="stv-muted stv-small">
                          {pack.rules.length} rule(s) · fallback {pack.fallback}
                        </div>
                      </CapiroTableCell>
                      <CapiroTableCell>
                        <div className="stv-stack stv-stack--tight" style={{ gap: 2 }}>
                          <CapiroBadge tone={statusTone(pack.status)}>
                            {statusLabel(pack.status)}
                          </CapiroBadge>
                          <span className="stv-muted stv-small">
                            Legal review: {pack.legalReviewStatus.replaceAll('_', ' ')}
                          </span>
                          {pack.nonProduction && <CapiroBadge>Non-production</CapiroBadge>}
                        </div>
                      </CapiroTableCell>
                      <CapiroTableCell>
                        {pack.authority.title}
                        <div className="stv-muted stv-small">
                          {pack.authority.type.replaceAll('_', ' ')}
                        </div>
                      </CapiroTableCell>
                      <CapiroTableCell>
                        <span className="stv-row" style={{ gap: 4 }}>
                          {state.canEdit && (
                            <CapiroButton size="compact" onClick={() => openEdit(pack)}>
                              Edit
                            </CapiroButton>
                          )}
                          {state.canSubmitReview && (
                            <CapiroButton
                              size="compact"
                              onClick={() => openReason({ action: 'submit-review', pack })}
                            >
                              Submit review
                            </CapiroButton>
                          )}
                          {pack.status === 'pending_review' && !pack.reviewedByUserId && (
                            <CapiroTooltip content={state.reviewBlockedReason ?? 'Record the first independent review'}>
                              <CapiroButton
                                size="compact"
                                disabled={!state.canReview}
                                onClick={() => openReason({ action: 'review', pack })}
                              >
                                Review
                              </CapiroButton>
                            </CapiroTooltip>
                          )}
                          {pack.status === 'pending_review' &&
                            pack.fourEyesRequired &&
                            pack.reviewedByUserId && (
                              <CapiroTooltip
                                content={
                                  state.secondApprovalBlockedReason ??
                                  'Record the second independent approval'
                                }
                              >
                                <CapiroButton
                                  size="compact"
                                  disabled={!state.canSecondApprove}
                                  onClick={() => openReason({ action: 'second-approve', pack })}
                                >
                                  Second approve
                                </CapiroButton>
                              </CapiroTooltip>
                            )}
                          {state.canPublish && (
                            <CapiroButton
                              size="compact"
                              variant="primary"
                              leadingIcon={<ShieldCheck size={13} />}
                              onClick={() => openReason({ action: 'publish', pack })}
                            >
                              Publish
                            </CapiroButton>
                          )}
                          {state.canRetire && (
                            <CapiroButton
                              size="compact"
                              className="stv-btn-danger"
                              onClick={() => openReason({ action: 'retire', pack })}
                            >
                              Retire
                            </CapiroButton>
                          )}
                          {state.canRollback && (
                            <CapiroButton
                              size="compact"
                              onClick={() => {
                                setRollbackTargetId(retiredCandidates[0]?.id);
                                openReason({ action: 'rollback', pack });
                              }}
                            >
                              Roll back
                            </CapiroButton>
                          )}
                          {state.canSimulate && (
                            <CapiroButton
                              size="compact"
                              onClick={() => {
                                setSimulationPack(pack);
                                setSimulationResult(null);
                                setSimulationValues({
                                  tool: 'send_email',
                                  inputJson: '{\n  "to": "staff@example.gov"\n}',
                                  jurisdiction:
                                    pack.jurisdiction === 'all' ? 'federal' : pack.jurisdiction,
                                });
                              }}
                            >
                              Simulate
                            </CapiroButton>
                          )}
                          <CapiroButton
                            size="compact"
                            aria-label={`Lifecycle history for ${pack.packKey} ${pack.version}`}
                            leadingIcon={<History size={13} />}
                            onClick={() => setEventsPack(pack)}
                          >
                            History
                          </CapiroButton>
                        </span>
                      </CapiroTableCell>
                    </tr>
                  );
                })}
              </CapiroTableBody>
            </CapiroTable>
          </CapiroTableWrap>
        )
      ) : decisions.isLoading ? (
        <div className="stv-stack" aria-label="Loading decisions">
          <CapiroSkeleton height={16} />
          <CapiroSkeleton height={16} width="70%" />
        </div>
      ) : (
        <>
          <CapiroTableWrap>
            <CapiroTable>
              <CapiroTableHead>
                <tr>
                  <CapiroTableHeaderCell>When</CapiroTableHeaderCell>
                  <CapiroTableHeaderCell>Decision</CapiroTableHeaderCell>
                  <CapiroTableHeaderCell>Policy</CapiroTableHeaderCell>
                  <CapiroTableHeaderCell>Tool</CapiroTableHeaderCell>
                  <CapiroTableHeaderCell>Context</CapiroTableHeaderCell>
                  <CapiroTableHeaderCell>Reason</CapiroTableHeaderCell>
                </tr>
              </CapiroTableHead>
              <CapiroTableBody>
                {decisionsPager.pageRows.map((row) => (
                  <tr key={row.id}>
                    <CapiroTableCell>{new Date(row.decidedAt).toLocaleString()}</CapiroTableCell>
                    <CapiroTableCell>
                      <span className="stv-row" style={{ gap: 4 }}>
                        <CapiroBadge tone={outcomeTone(row.outcome)}>{row.outcome}</CapiroBadge>
                        {row.simulated && <CapiroBadge>Simulation</CapiroBadge>}
                      </span>
                    </CapiroTableCell>
                    <CapiroTableCell>
                      {row.packKey ?? 'Fail-closed authority'}
                      <div className="stv-muted stv-small">
                        {row.packVersion ?? 'unavailable'} · {row.ruleId ?? 'fallback'}
                      </div>
                    </CapiroTableCell>
                    <CapiroTableCell>{row.tool}</CapiroTableCell>
                    <CapiroTableCell>
                      <span className="stv-muted stv-small">
                        {row.jurisdiction} · {row.channel} · {row.policySource}/{row.policyMode}
                      </span>
                    </CapiroTableCell>
                    <CapiroTableCell>{row.reason}</CapiroTableCell>
                  </tr>
                ))}
              </CapiroTableBody>
            </CapiroTable>
          </CapiroTableWrap>
          <SvPagination
            currentPage={decisionsPager.currentPage}
            pageCount={decisionsPager.pageCount}
            onPage={decisionsPager.setPage}
          />
        </>
      )}

      {/* Editor modal */}
      {editorOpen ? (
        <CapiroModal
          open
          title={editing ? `Revise ${editing.packKey} ${editing.version}` : 'New policy-pack draft'}
          onClose={() => {
            setEditorOpen(false);
            setEditing(null);
          }}
        >
          <div className="stv-stack stv-modal-wide">
            <div className="stv-row stv-row--start">
              <span style={{ width: 240 }}>
                <CapiroInput
                  label="Pack key"
                  placeholder="firm-external-action-policy"
                  disabled={Boolean(editing)}
                  value={editorValues.packKey}
                  onChange={(e) => setEditorValues((c) => ({ ...c, packKey: e.target.value }))}
                />
              </span>
              <span style={{ width: 180 }}>
                <CapiroInput
                  label="Version"
                  placeholder="2026-08-01.v1"
                  disabled={Boolean(editing)}
                  value={editorValues.version}
                  onChange={(e) => setEditorValues((c) => ({ ...c, version: e.target.value }))}
                />
              </span>
              <span style={{ width: 180 }}>
                <CapiroSelect
                  label="Jurisdiction"
                  value={editorValues.jurisdiction}
                  onChange={(e) =>
                    setEditorValues((c) => ({
                      ...c,
                      jurisdiction: e.target.value as PolicyPackFormValues['jurisdiction'],
                    }))
                  }
                  options={[
                    'all',
                    'federal',
                    'state',
                    'local',
                    'regulatory',
                    'procurement',
                    'grants',
                  ].map((value) => ({ value, label: value === 'all' ? 'All' : value }))}
                />
              </span>
              <span style={{ width: 120 }}>
                <CapiroSelect
                  label="Fallback"
                  value={editorValues.fallback}
                  onChange={(e) =>
                    setEditorValues((c) => ({ ...c, fallback: e.target.value as PolicyOutcome }))
                  }
                  options={['PASS', 'WARN', 'BLOCK'].map((value) => ({ value, label: value }))}
                />
              </span>
            </div>

            <div className="stv-row stv-row--start">
              <span style={{ width: 260 }}>
                <CapiroInput
                  label="Effective from"
                  placeholder="2026-08-01T00:00:00Z"
                  value={editorValues.effectiveFrom}
                  onChange={(e) =>
                    setEditorValues((c) => ({ ...c, effectiveFrom: e.target.value }))
                  }
                />
              </span>
              <span style={{ width: 260 }}>
                <CapiroInput
                  label="Effective until (optional)"
                  placeholder="2027-08-01T00:00:00Z"
                  value={editorValues.effectiveUntil ?? ''}
                  onChange={(e) =>
                    setEditorValues((c) => ({ ...c, effectiveUntil: e.target.value || undefined }))
                  }
                />
              </span>
              <span style={{ width: 240 }}>
                <CapiroSelect
                  label="Legal review status"
                  value={editorValues.legalReviewStatus}
                  onChange={(e) =>
                    setEditorValues((c) => ({
                      ...c,
                      legalReviewStatus: e.target
                        .value as PolicyPackFormValues['legalReviewStatus'],
                    }))
                  }
                  options={[
                    { value: 'pending', label: 'Pending' },
                    { value: 'approved', label: 'Approved' },
                    {
                      value: 'not_required_product_policy',
                      label: 'Not required — product policy',
                    },
                    { value: 'rejected', label: 'Rejected' },
                  ]}
                />
              </span>
            </div>

            <SvCard title="Authority">
              <div className="stv-row stv-row--start">
                <span style={{ width: 230 }}>
                  <CapiroSelect
                    label="Authority type"
                    value={editorValues.authorityType}
                    onChange={(e) =>
                      setEditorValues((c) => ({
                        ...c,
                        authorityType: e.target.value as PolicyPackFormValues['authorityType'],
                      }))
                    }
                    options={[
                      'approved_product_policy',
                      'legal_authority',
                      'client_policy',
                      'example_only',
                    ].map((value) => ({ value, label: value.replaceAll('_', ' ') }))}
                  />
                </span>
                <span style={{ width: 300 }}>
                  <CapiroInput
                    label="Authority title"
                    value={editorValues.authorityTitle}
                    onChange={(e) =>
                      setEditorValues((c) => ({ ...c, authorityTitle: e.target.value }))
                    }
                  />
                </span>
                <span style={{ width: 300 }}>
                  <CapiroInput
                    label="Source reference"
                    placeholder="approved-policy:external-actions"
                    value={editorValues.authoritySourceRef ?? ''}
                    onChange={(e) =>
                      setEditorValues((c) => ({
                        ...c,
                        authoritySourceRef: e.target.value || undefined,
                      }))
                    }
                  />
                </span>
                <span style={{ width: 220 }}>
                  <CapiroInput
                    label="Source version"
                    value={editorValues.authoritySourceVersion ?? ''}
                    onChange={(e) =>
                      setEditorValues((c) => ({
                        ...c,
                        authoritySourceVersion: e.target.value || undefined,
                      }))
                    }
                  />
                </span>
              </div>
            </SvCard>

            <div className="stv-row">
              <label className="stv-row" style={{ gap: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={editorValues.fourEyesRequired !== false}
                  onChange={(e) =>
                    setEditorValues((c) => ({ ...c, fourEyesRequired: e.target.checked }))
                  }
                />
                Require two independent reviewers
              </label>
              <label className="stv-row" style={{ gap: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={editorValues.nonProduction !== false}
                  onChange={(e) =>
                    setEditorValues((c) => ({ ...c, nonProduction: e.target.checked }))
                  }
                />
                Non-production
              </label>
            </div>

            {editorValues.rules.map((rule, index) => (
              <SvCard
                key={index}
                title={`Rule ${index + 1}`}
                extra={
                  <CapiroButton
                    size="compact"
                    className="stv-btn-danger"
                    onClick={() =>
                      setEditorValues((c) => ({
                        ...c,
                        rules: c.rules.filter((_, i) => i !== index),
                      }))
                    }
                  >
                    Remove
                  </CapiroButton>
                }
              >
                <div className="stv-stack">
                  <div className="stv-row stv-row--start">
                    <span style={{ width: 230 }}>
                      <CapiroInput
                        label="Rule ID"
                        value={rule.id}
                        onChange={(e) => setRule(index, { id: e.target.value })}
                      />
                    </span>
                    <span style={{ width: 110 }}>
                      <CapiroSelect
                        label="Outcome"
                        value={rule.outcome}
                        onChange={(e) =>
                          setRule(index, { outcome: e.target.value as PolicyOutcome })
                        }
                        options={['PASS', 'WARN', 'BLOCK'].map((value) => ({
                          value,
                          label: value,
                        }))}
                      />
                    </span>
                    <span style={{ width: 140 }}>
                      <CapiroSelect
                        label="Risk tier"
                        value={rule.tier ?? ''}
                        onChange={(e) =>
                          setRule(index, {
                            tier: (e.target.value || undefined) as PolicyRuleFormValue['tier'],
                          })
                        }
                        options={[
                          { value: '', label: '—' },
                          ...['low', 'moderate', 'high', 'restricted'].map((value) => ({
                            value,
                            label: value,
                          })),
                        ]}
                      />
                    </span>
                    <span style={{ width: 180 }}>
                      <CapiroInput
                        label="Decision code"
                        value={rule.code ?? ''}
                        onChange={(e) => setRule(index, { code: e.target.value || undefined })}
                      />
                    </span>
                    <span className="stv-stack stv-stack--tight" style={{ gap: 6 }}>
                      <span className="capiro-field__label">Enabled</span>
                      <SvSwitch
                        checked={rule.enabled !== false}
                        onChange={(enabled) => setRule(index, { enabled })}
                        aria-label={`Rule ${index + 1} enabled`}
                      />
                    </span>
                  </div>
                  <CapiroInput
                    label="Description"
                    value={rule.description}
                    onChange={(e) => setRule(index, { description: e.target.value })}
                  />
                  <div>
                    <span
                      className="capiro-field__label"
                      style={{ display: 'block', marginBottom: 6 }}
                    >
                      Matching tools
                    </span>
                    <SvTagInput
                      value={rule.tools ?? []}
                      onChange={(tools) => setRule(index, { tools })}
                      placeholder="Type a server tool name and press Enter"
                      aria-label={`Rule ${index + 1} matching tools`}
                    />
                    <span className="capiro-field__help">
                      Other server-derived matching conditions can be added below.
                    </span>
                  </div>
                  <SvTextArea
                    label="Additional match conditions (JSON)"
                    rows={3}
                    placeholder={'{\n  "channels": ["email"],\n  "recipientTypes": ["government"]\n}'}
                    value={rule.additionalMatchJson ?? ''}
                    onChange={(additionalMatchJson) => setRule(index, { additionalMatchJson })}
                  />
                  <SvTextArea
                    label="Human-readable reason"
                    rows={2}
                    value={rule.reason}
                    onChange={(reason) => setRule(index, { reason })}
                  />
                  <div className="stv-row stv-row--start">
                    <span style={{ width: 330 }}>
                      <CapiroInput
                        label="Authority reference"
                        value={rule.authorityRef}
                        onChange={(e) => setRule(index, { authorityRef: e.target.value })}
                      />
                    </span>
                    <span style={{ minWidth: 330 }}>
                      <span
                        className="capiro-field__label"
                        style={{ display: 'block', marginBottom: 6 }}
                      >
                        Regression test IDs
                      </span>
                      <SvTagInput
                        value={rule.tests ?? []}
                        onChange={(tests) => setRule(index, { tests })}
                        placeholder="Type a test id and press Enter"
                        aria-label={`Rule ${index + 1} regression test IDs`}
                      />
                    </span>
                  </div>
                </div>
              </SvCard>
            ))}
            <div className="stv-row">
              <CapiroButton
                leadingIcon={<Plus size={14} />}
                onClick={() =>
                  setEditorValues((c) => ({ ...c, rules: [...c.rules, { ...EMPTY_RULE }] }))
                }
              >
                Add rule
              </CapiroButton>
            </div>

            <div className="stv-row stv-row--end">
              <CapiroButton
                onClick={() => {
                  setEditorOpen(false);
                  setEditing(null);
                }}
              >
                Cancel
              </CapiroButton>
              <CapiroButton variant="primary" loading={operation.isPending} onClick={submitEditor}>
                {editing ? 'Save revision' : 'Create draft'}
              </CapiroButton>
            </div>
          </div>
        </CapiroModal>
      ) : null}

      {/* Reason modal */}
      {reasonState ? (
        <CapiroModal
          open
          title={`${reasonState.action.replaceAll('-', ' ')} ${reasonState.pack.version}`}
          onClose={() => {
            setReasonState(null);
            setReasonValue('');
            setRollbackTargetId(undefined);
          }}
        >
          <div className="stv-stack">
            {reasonState.action === 'review' && (
              <CapiroSelect
                label="Review classification"
                value={reviewClassification}
                onChange={(e) =>
                  setReviewClassification(
                    e.target.value as 'approved' | 'not_required_product_policy',
                  )
                }
                options={[
                  { value: 'approved', label: 'Approved' },
                  {
                    value: 'not_required_product_policy',
                    label: 'Not required — approved product policy',
                  },
                ]}
              />
            )}
            {reasonState.action === 'rollback' && (
              <CapiroSelect
                label="Restore retired version"
                value={rollbackTargetId ?? ''}
                onChange={(e) => setRollbackTargetId(e.target.value || undefined)}
                options={[
                  { value: '', label: 'Select a rollback target' },
                  ...retired
                    .filter(
                      (candidate) =>
                        candidate.packKey === reasonState.pack.packKey &&
                        !candidate.nonProduction,
                    )
                    .map((candidate) => ({
                      value: candidate.id,
                      label: `${candidate.version} · retired`,
                    })),
                ]}
              />
            )}
            <SvTextArea
              label="Audit reason"
              rows={4}
              maxLength={4000}
              showCount
              value={reasonValue}
              onChange={setReasonValue}
            />
            <div className="stv-row stv-row--end">
              <CapiroButton
                onClick={() => {
                  setReasonState(null);
                  setReasonValue('');
                  setRollbackTargetId(undefined);
                }}
              >
                Cancel
              </CapiroButton>
              <CapiroButton
                variant="primary"
                loading={operation.isPending}
                disabled={
                  !reasonValue.trim() ||
                  (reasonState.action === 'rollback' && !rollbackTargetId)
                }
                onClick={submitReason}
              >
                Confirm
              </CapiroButton>
            </div>
          </div>
        </CapiroModal>
      ) : null}

      {/* Simulation modal */}
      {simulationPack ? (
        <CapiroModal
          open
          title={`Simulate ${simulationPack.packKey} ${simulationPack.version}`}
          onClose={() => {
            setSimulationPack(null);
            setSimulationResult(null);
          }}
        >
          <div className="stv-stack stv-modal-mid">
            <SvCallout
              kind="warning"
              title="Simulation cannot authorize an action"
              description="The result is logged as simulated and is deliberately non-bindable."
            />
            <div className="stv-row stv-row--start">
              <span style={{ width: 240 }}>
                <CapiroInput
                  label="Tool"
                  value={simulationValues.tool}
                  onChange={(e) =>
                    setSimulationValues((c) => ({ ...c, tool: e.target.value }))
                  }
                />
              </span>
              <span style={{ width: 180 }}>
                <CapiroSelect
                  label="Jurisdiction"
                  value={simulationValues.jurisdiction ?? ''}
                  onChange={(e) =>
                    setSimulationValues((c) => ({
                      ...c,
                      jurisdiction: (e.target.value || undefined) as
                        | SimulationFormValues['jurisdiction']
                        | undefined,
                    }))
                  }
                  options={[
                    { value: '', label: '—' },
                    ...['federal', 'state', 'local', 'regulatory', 'procurement', 'grants'].map(
                      (value) => ({ value, label: value }),
                    ),
                  ]}
                />
              </span>
              <span style={{ width: 300 }}>
                <CapiroInput
                  label="Client ID (optional)"
                  value={simulationValues.clientId ?? ''}
                  onChange={(e) =>
                    setSimulationValues((c) => ({
                      ...c,
                      clientId: e.target.value || undefined,
                    }))
                  }
                />
              </span>
            </div>
            <SvTextArea
              label="Canonical tool input"
              rows={8}
              value={simulationValues.inputJson}
              onChange={(inputJson) => setSimulationValues((c) => ({ ...c, inputJson }))}
            />
            {simulationResult && (
              <SvDescriptions
                items={[
                  {
                    label: 'Outcome',
                    value: (
                      <CapiroBadge tone={outcomeTone(simulationResult.outcome as PolicyOutcome)}>
                        {String(simulationResult.outcome)}
                      </CapiroBadge>
                    ),
                  },
                  { label: 'Bindable', value: 'No' },
                  { label: 'Rule', value: String(simulationResult.ruleId ?? 'fallback') },
                  { label: 'Reason', value: String(simulationResult.reason ?? '') },
                ]}
              />
            )}
            <div className="stv-row stv-row--end">
              <CapiroButton
                onClick={() => {
                  setSimulationPack(null);
                  setSimulationResult(null);
                }}
              >
                Cancel
              </CapiroButton>
              <CapiroButton
                variant="primary"
                loading={simulate.isPending}
                onClick={() => {
                  if (!simulationPack) return;
                  try {
                    simulate.mutate({
                      packId: simulationPack.id,
                      body: buildSimulationPayload(simulationValues),
                    });
                  } catch (error) {
                    toast.error(errorMessage(error));
                  }
                }}
              >
                Run simulation
              </CapiroButton>
            </div>
          </div>
        </CapiroModal>
      ) : null}

      {/* Lifecycle history drawer */}
      <CapiroDrawer
        open={Boolean(eventsPack)}
        title={
          eventsPack
            ? `Lifecycle history · ${eventsPack.packKey} ${eventsPack.version}`
            : 'Lifecycle history'
        }
        onClose={() => setEventsPack(null)}
      >
        {events.isLoading ? (
          <div className="stv-stack" aria-label="Loading lifecycle events">
            <CapiroSkeleton height={16} />
            <CapiroSkeleton height={16} width="70%" />
          </div>
        ) : events.data?.length ? (
          <div className="stv-stack stv-stack--tight">
            {events.data.map((event) => (
              <details key={event.id} style={{ borderBottom: '1px solid var(--stv-border)', padding: '8px 0' }}>
                <summary className="stv-row" style={{ cursor: 'pointer' }}>
                  <CapiroBadge>{event.action.replaceAll('_', ' ')}</CapiroBadge>
                  <span>{new Date(event.occurredAt).toLocaleString()}</span>
                </summary>
                <div className="stv-stack stv-stack--tight" style={{ paddingTop: 8 }}>
                  <span>
                    {event.fromStatus ?? 'none'} → {event.toStatus ?? 'none'}
                  </span>
                  <span>{event.reason}</span>
                  <span className="stv-muted stv-small">
                    Actor {event.actorUserId} · {event.actorRole}
                  </span>
                </div>
              </details>
            ))}
          </div>
        ) : (
          <CapiroEmptyState title="No lifecycle events found" />
        )}
      </CapiroDrawer>
    </section>
  );
}
