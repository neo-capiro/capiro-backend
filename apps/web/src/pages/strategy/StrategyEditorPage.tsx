/*
 * Strategy editor shell — prototype sp-app StrategyView frame + the G3 editing
 * surface: node rail (select → edit fields / quick actions / delete), Add step,
 * drag-to-retime, version history + restore, applied-confirmation flashes. The
 * Meri "Ask Meri" CTA + rail assistant land in G5 (behind strategyPlannerMeri);
 * with it off the rail opens via an "Edit panel" ghost button (SHL-4).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useUser } from '@clerk/clerk-react';
import { App } from 'antd';
import { Icon, btnGhost, iconBtn } from './strategy-ui.js';
import { StrategyTimeline } from './StrategyTimeline.js';
import { EditorRail } from './NodeRail.js';
import { HistoryModal } from './HistoryModal.js';
import { FirmConfig } from './FirmConfig.js';
import { RefCalendarConfig } from './RefCalendarConfig.js';
import { ExportView } from './ExportView.js';
import {
  useStrategy,
  useReferenceCalendars,
  useFirmPhases,
  useAddNode,
  useUpdateNode,
  useRecordArtifact,
  usePlanExecution,
  useMissions,
  useCreateMission,
  useUpdateMission,
} from './api.js';
import { useClientsLite } from './clients-lite.js';
import { useTenantMembers } from './members.js';
import { useApi } from '../../lib/use-api.js';
import { useMe } from '../../lib/me.js';
import { errorMessage } from '../../lib/error-message.js';
import { STRATEGY_TYPE_LABEL } from './constants.js';
import { clip } from './context/context-utils.js';
import {
  canShowWatchRail,
  findExecutionMission,
  EXECUTION_MISSION_NAME,
  classifyWaitingReason,
} from './agents/agent-utils.js';
import { buildCalendar, formatDbDate, parseDbDate } from './fiscal.js';
import type { StrategyNode, StrategyNodeArtifact } from './types.js';

type LayerKey = 'ppbe' | 'congress';

export function StrategyEditorPage() {
  const { id = null } = useParams();
  const navigate = useNavigate();
  const { user } = useUser();
  const { message } = App.useApp();
  const strategy = useStrategy(id);
  const reference = useReferenceCalendars();
  const firmPhases = useFirmPhases();
  const clients = useClientsLite();
  const members = useTenantMembers();
  const me = useMe();

  const calendar = useMemo(() => buildCalendar(new Date()), []);
  const [layers, setLayers] = useState<Record<LayerKey, boolean>>({ ppbe: true, congress: true });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [railOpen, setRailOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [firmOpen, setFirmOpen] = useState(false);
  const [refEdit, setRefEdit] = useState<'congress' | 'ppbe' | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [routing, setRouting] = useState<'workspace' | 'outreach' | null>(null);
  // Stage G: which agent-staging plan is in flight (distinct from `routing`,
  // the direct RTE route-out).
  const [staging, setStaging] = useState<'workspace_draft' | 'outreach_record' | null>(null);
  const [applied, setApplied] = useState<string | null>(null);
  const [draftBannerClosed, setDraftBannerClosed] = useState(false);
  const flashTimer = useRef<number>();
  const [searchParams] = useSearchParams();

  const addNode = useAddNode(id ?? '');
  const updateNode = useUpdateNode(id ?? '');
  const recordArtifact = useRecordArtifact(id ?? '');
  const planExecution = usePlanExecution();
  // Stage G: the node-agent affordance anchors its execution run on the
  // strategy's dedicated Execution mission (a run belongs to an ACTIVE mission,
  // per the RunsService contract). Loaded — and, on demand, provisioned — only
  // when the agentic UI belt is on.
  const missions = useMissions(id, Boolean(id) && Boolean(me.data?.features?.agenticMeri));
  const createMission = useCreateMission();
  const updateMission = useUpdateMission();
  const api = useApi();

  const flash = (msg: string) => {
    setApplied(msg);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setApplied(null), 4000);
  };
  useEffect(() => () => window.clearTimeout(flashTimer.current), []);

  // RTE-4 / URL-1: a ?node=<id> deep-link reselects + opens the rail once the
  // strategy has loaded (used on return from a Workspace/Outreach route-out).
  // Keyed on the loaded strategy id + the param so it fires once per load and
  // does not fight a later manual deselect.
  const loadedId = strategy.data?.id;
  useEffect(() => {
    const nodeParam = searchParams.get('node');
    if (!nodeParam || !loadedId) return;
    if (!strategy.data?.nodes.some((n) => n.id === nodeParam)) return;
    setSelectedId(nodeParam);
    setRailOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedId, searchParams]);

  const meriEnabled = Boolean(me.data?.features?.strategyPlannerMeri);
  // Stage F: the Watch-mode rail block requires BOTH /me bits — agenticMeri
  // (class AgenticGuard) AND strategyWatcher (StrategyWatcherGuard on
  // run-check + the scheduler's per-occurrence flag check). On agenticMeri
  // alone the toggle would show "Watching" while no check ever runs. UI belt —
  // the /strategy-api/agents routes are guarded server-side regardless.
  const watcherEnabled = canShowWatchRail(me.data?.features);
  // Stage G: the node-level "prepare with the agent" affordances ride the
  // agenticMeri UI belt (the server enforces the per-intent executionAgent
  // flags). Optional so an older cached /me shape degrades to hidden.
  const agenticEnabled = Boolean(me.data?.features?.agenticMeri);

  if (strategy.isLoading) {
    return <div style={{ padding: 40, color: 'var(--ink-3)' }}>Loading strategy…</div>;
  }
  if (strategy.isError || !strategy.data) {
    return (
      <div style={{ padding: 40 }}>
        <button onClick={() => navigate('/strategies')} style={{ ...btnGhost, marginBottom: 16 }}>
          <Icon name="chevleft" size={14} color="var(--ink-2)" /> Back to strategies
        </button>
        <div style={{ color: 'var(--ink-3)' }}>This strategy could not be loaded.</div>
      </div>
    );
  }

  const s = strategy.data;
  const sid = s.id;
  const clientName = clients.data?.find((c) => c.id === s.clientId)?.name ?? 'Client';
  const selectedNode = s.nodes.find((n) => n.id === selectedId) ?? null;
  // NOD-6 chips: artifacts arrive as a FLAT array on the strategy — filter by node.
  const nodeArtifacts = selectedNode ? s.artifacts.filter((a) => a.nodeId === selectedNode.id) : [];

  // SHL-5: one-time banner after a Meri draft. Keyed off draftedByMeri (set only
  // by the draft path) — NOT meriSummary, which a rail assist also writes and
  // would falsely flag a manual plan. Dismissal is per-strategy, per-browser
  // (localStorage), and also held in state so the banner disappears immediately
  // on click without a re-read.
  const draftKey = `sp-draft-banner-${sid}`;
  const draftDismissedStored = (() => {
    try {
      return localStorage.getItem(draftKey) === '1';
    } catch {
      return false;
    }
  })();
  const showDraftBanner = s.draftedByMeri && !draftBannerClosed && !draftDismissedStored;
  const dismissDraftBanner = () => {
    try {
      localStorage.setItem(draftKey, '1');
    } catch {
      /* localStorage unavailable — state still hides it this session */
    }
    setDraftBannerClosed(true);
  };

  const layerDefs: Array<[LayerKey, string, string]> = [
    ['ppbe', 'PPBE', 'var(--info)'],
    ['congress', 'Congress', 'var(--accent)'],
  ];

  const selectNode = (nid: string) => {
    setSelectedId(nid);
    setRailOpen(true);
  };

  const onAddStep = () => {
    const existing = new Set(s.nodes.map((n) => n.id));
    const startsOn = formatDbDate(new Date(Date.now() + 30 * 86_400_000));
    addNode.mutate(
      { kind: 'action', subject: 'deliverable', title: 'New step', status: 'draft', startsOn },
      {
        onSuccess: (detail) => {
          const created = detail.nodes.find((n) => !existing.has(n.id));
          if (created) selectNode(created.id);
          flash('Step added.');
        },
        onError: () => message.error('Could not add a step.'),
      },
    );
  };

  const onRetime = (nodeId: string, startsOn: string, endsOn: string | null, title: string) => {
    updateNode.mutate(
      { nodeId, input: { startsOn, endsOn, changeNote: `Re-timed ${title}` } },
      { onSuccess: () => flash(`Re-timed ${title}`), onError: () => message.error('Could not re-time the step.') },
    );
  };

  // RTE-4 return affordance appended to every route-out (?from + ?node).
  const routeReturn = `?from=${encodeURIComponent(`/strategies/${sid}`)}&node=`;

  // Node context block (title, dates, note, strategy goal) → HTML for the
  // Workspace draft's first section (RTE-1). Escaped — values are user text.
  const nodeContextHtml = (n: StrategyNode): string => {
    const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const dates =
      formatDbDate(parseDbDate(n.startsOn)) +
      (n.endsOn ? ` – ${formatDbDate(parseDbDate(n.endsOn))}` : '');
    return [
      `<p><strong>${esc(n.title)}</strong></p>`,
      `<p>${esc(dates)}</p>`,
      n.note ? `<p>${esc(n.note)}</p>` : '',
      s.goal ? `<p><em>Strategy goal:</em> ${esc(s.goal)}</p>` : '',
    ]
      .filter(Boolean)
      .join('\n');
  };

  // RTE-1/RTE-2: create the real WsDraft / OutreachRecord prefilled from the
  // node, record the node→artifact back-link (RTE-3, best-effort), then navigate
  // into the target with the return affordance. No workspace/outreach changes.
  const onRoute = (action: 'workspace' | 'outreach') => {
    const node = selectedNode;
    if (!node || routing) return;
    if (!clients.data) {
      message.error('Client is still loading — try again in a moment.');
      return;
    }
    setRouting(action);
    void (async () => {
      try {
        let ref: string;
        let target: string;
        if (action === 'workspace') {
          const product = node.kind === 'decision' ? 'Strategy memo' : 'White paper';
          const created = (
            await api.post<{ id: string; config?: { sections?: string[] } }>('/workspace-api/drafts', {
              docTitle: node.title,
              client: clientName,
              product,
            })
          ).data;
          ref = created.id;
          const section = created.config?.sections?.[0] ?? 'Background';
          await api.patch(`/workspace-api/drafts/${encodeURIComponent(ref)}`, {
            config: { sectionContent: { [section]: nodeContextHtml(node) } },
          });
          target = `/workspace/setup/${encodeURIComponent(ref)}`;
        } else {
          const rec = (
            await api.post<{ id: string }>('/api/engagement/outreach', {
              type: 'campaign',
              // Outreach title is capped at 240 server-side; node titles allow 300.
              title: node.title.slice(0, 240),
              subject: node.title,
              clientId: s.clientId,
              metadata: { strategyNodeId: node.id, strategyId: sid, objective: s.goal ?? node.title },
            })
          ).data;
          ref = rec.id;
          target = `/engagement/outreach/draft/${encodeURIComponent(ref)}`;
        }
        // Back-link is best-effort: a link failure must not strand the user away
        // from the artifact we just created.
        try {
          await recordArtifact.mutateAsync({
            nodeId: node.id,
            input: { artifactType: action === 'workspace' ? 'workspace_draft' : 'outreach_record', artifactRef: ref },
          });
        } catch {
          /* chip will be missing until re-linked; the artifact still exists */
        }
        navigate(`${target}${routeReturn}${node.id}`);
      } catch {
        message.error(
          action === 'workspace'
            ? 'Could not start the Workspace draft — please try again.'
            : 'Could not start the outreach — please try again.',
        );
        setRouting(null);
      }
    })();
  };

  const onOpenArtifact = (a: StrategyNodeArtifact) => {
    const suffix = selectedNode ? `${routeReturn}${selectedNode.id}` : '';
    const target =
      a.artifactType === 'workspace_draft'
        ? `/workspace/setup/${encodeURIComponent(a.artifactRef)}`
        : `/engagement/outreach/draft/${encodeURIComponent(a.artifactRef)}`;
    navigate(`${target}${suffix}`);
  };

  // Stage G: resolve (or create-and-activate) the strategy's dedicated Execution
  // mission so the run has an ACTIVE mission to anchor to (RunsService requires
  // one). Mirrors the Watch rail's create-then-activate, but the mission is
  // manual-only (no cadence) so the F2 Watcher scheduler never claims it (its
  // claim requires cadence IS NOT NULL). The list is refetched once when the
  // cache has not loaded yet, so a stale-empty cache does not mint a duplicate.
  const resolveExecutionMission = async (): Promise<string> => {
    const list = missions.data ?? (await missions.refetch()).data ?? [];
    const existing = findExecutionMission(list, sid);
    const mission =
      existing ??
      (await createMission.mutateAsync({ strategyId: sid, name: EXECUTION_MISSION_NAME }));
    if (!mission) throw new Error('Could not prepare an execution mission.');
    if (mission.state !== 'active') {
      await updateMission.mutateAsync({ id: mission.id, input: { state: 'active' } });
    }
    return mission.id;
  };

  // Stage G: have Meri's Execution Agent PLAN work against this node (stage a
  // Workspace draft / stage — never send — outreach), then land in the
  // Execution review for that strategy. Distinct from the direct RTE route-outs
  // above: this creates an execution run for review, it does not open an
  // artifact. An interactive bearer is always present here (Clerk), so the
  // server never has to park this on "requires interactive session".
  const onStageAgent = (intent: 'workspace_draft' | 'outreach_record') => {
    const node = selectedNode;
    if (!node || staging) return;
    // The server DTO's kind is 'workspace'|'outreach'; the rail's intent is the
    // artifact token. This is the sole boundary between the two vocabularies.
    const kind = intent === 'workspace_draft' ? 'workspace' : 'outreach';
    setStaging(intent);
    void (async () => {
      try {
        const missionId = await resolveExecutionMission();
        const run = await planExecution.mutateAsync({ missionId, strategyId: sid, nodeId: node.id, kind });
        // A returned run can be a G0 park (waiting_for_input), not a plan ready
        // to stage — the old unconditional "preparing/staged" flash claimed
        // success even when nothing was generated (e.g. the node has no owner,
        // or the wrong subject for outreach). Surface the real reason instead.
        if (!run || run.state === 'waiting_for_input') {
          const block = classifyWaitingReason(run?.waitingReason ?? null);
          message.warning(`Meri couldn't start: ${block.reason}`, 6);
        } else {
          flash(
            intent === 'workspace_draft'
              ? 'Meri is preparing a Workspace draft — review it under Execution.'
              : 'Meri staged outreach for review — nothing is sent. Review it under Execution.',
          );
        }
        navigate(`/strategies/agents/execution?strategyId=${encodeURIComponent(sid)}`);
      } catch (err) {
        message.error(
          errorMessage(
            err,
            intent === 'workspace_draft'
              ? 'Could not start the Workspace draft with the agent.'
              : 'Could not stage the outreach with the agent.',
          ),
        );
      } finally {
        setStaging(null);
      }
    })();
  };

  return (
    <div
      style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', height: '100%' }}
    >
      <div
        style={{
          padding: '14px 26px 24px',
          borderBottom: '1px solid var(--border-1)',
          background: 'var(--bg-surface)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={() => navigate('/strategies')}
            style={{ ...iconBtn, border: '1px solid var(--border-2)', width: 30, height: 30 }}
          >
            <Icon name="chevleft" size={16} color="var(--ink-2)" />
          </button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 'var(--text-xs)',
                color: 'var(--ink-3)',
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
              }}
            >
              {clientName} · {STRATEGY_TYPE_LABEL[s.type]}
            </div>
            <div
              style={{
                fontSize: 25,
                fontWeight: 700,
                color: 'var(--ink-1)',
                letterSpacing: '-0.02em',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                marginTop: 1,
              }}
            >
              {s.title}
            </div>
          </div>
        </div>

        <div
          style={{
            marginTop: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
            rowGap: 10,
          }}
        >
          <span
            style={{
              fontSize: 'var(--text-2xs)',
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              color: 'var(--ink-4)',
              marginRight: 2,
            }}
          >
            Layers
          </span>
          {layerDefs.map(([k, label, c]) => {
            const on = layers[k];
            return (
              <button
                key={k}
                onClick={() => setLayers((st) => ({ ...st, [k]: !st[k] }))}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '5px 11px',
                  borderRadius: 7,
                  cursor: 'pointer',
                  border: on ? `1px solid ${c}` : '1px solid var(--border-2)',
                  background: on ? 'var(--bg-surface-2)' : 'var(--bg-surface)',
                  color: on ? 'var(--ink-1)' : 'var(--ink-3)',
                  fontSize: 'var(--text-xs)',
                  fontWeight: 600,
                }}
              >
                <span style={{ width: 8, height: 8, borderRadius: 2, background: on ? c : 'var(--ink-4)' }} />
                {label}
              </button>
            );
          })}
          <span style={{ flex: 1 }} />

          <button
            onClick={onAddStep}
            disabled={addNode.isPending}
            style={{ ...btnGhost, padding: '8px 12px', fontSize: 'var(--text-sm)' }}
          >
            <Icon name="plus" size={14} color="var(--ink-2)" /> Add step
          </button>
          <button
            onClick={() => setHistoryOpen(true)}
            style={{ ...btnGhost, padding: '8px 12px', fontSize: 'var(--text-sm)' }}
          >
            <Icon name="clock" size={14} color="var(--ink-2)" /> History
          </button>
          <button
            onClick={() => setExportOpen(true)}
            style={{ ...btnGhost, padding: '8px 12px', fontSize: 'var(--text-sm)' }}
          >
            <Icon name="upload" size={14} color="var(--ink-2)" /> Export
          </button>
          {!railOpen &&
            (meriEnabled ? (
              // AI on (G5): accent "Ask Meri" CTA.
              <button
                onClick={() => setRailOpen(true)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  whiteSpace: 'nowrap',
                  padding: '8px 16px',
                  borderRadius: 9,
                  border: 'none',
                  background: 'var(--accent)',
                  color: '#fff',
                  fontSize: 'var(--text-sm)',
                  fontWeight: 700,
                  fontFamily: 'var(--font-sans)',
                  cursor: 'pointer',
                }}
              >
                <Icon name="spark" size={14} color="#fff" /> Ask Meri
              </button>
            ) : (
              // AI off (SHL-4): ghost "Edit panel" button opens the manual rail.
              <button
                onClick={() => setRailOpen(true)}
                style={{ ...btnGhost, padding: '8px 12px', fontSize: 'var(--text-sm)' }}
              >
                <Icon name="panel" size={14} color="var(--ink-2)" /> Edit panel
              </button>
            ))}
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div
          data-sp-scroll="true"
          onClick={() => setSelectedId(null)}
          style={{
            flex: 1,
            minHeight: 0,
            overflow: 'auto',
            padding: '16px 26px 24px',
            background: 'var(--bg-canvas)',
          }}
        >
          {showDraftBanner && (
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                background: 'var(--accent-soft)',
                border: '1px solid #C6D4F4',
                borderRadius: 10,
                padding: '11px 14px',
                marginBottom: 14,
              }}
            >
              <div style={{ marginTop: 1 }}>
                <Icon name="spark" size={15} color="var(--accent-ink)" />
              </div>
              <div style={{ flex: 1, fontSize: 'var(--text-sm)', color: 'var(--ink-2)', lineHeight: 1.5 }}>
                <b style={{ color: 'var(--accent-ink)' }}>Meri drafted this plan from your goal.</b> Every step is
                editable — drag to re-time, click to open, or ask Meri to change anything from the rail.
              </div>
              <button
                onClick={dismissDraftBanner}
                title="Dismiss"
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, display: 'grid' }}
              >
                <Icon name="x" size={13} color="var(--ink-4)" />
              </button>
            </div>
          )}
          {/* A8: Meri drafted on incomplete context. */}
          {s.groundingHealth?.status === 'degraded' && (
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                background: '#FFF6E5',
                border: '1px solid #E0A94A',
                borderRadius: 10,
                padding: '11px 14px',
                marginBottom: 14,
                fontSize: 'var(--text-sm)',
                color: 'var(--ink-2)',
                lineHeight: 1.5,
              }}
            >
              <div style={{ marginTop: 1 }}>
                <Icon name="spark" size={15} color="#9A6A12" />
              </div>
              <div style={{ flex: 1 }}>
                <b style={{ color: '#9A6A12' }}>Drafted on partial information.</b> Meri couldn't load:{' '}
                {s.groundingHealth.missingRequired.join(', ') || 'some client context'}. Review the plan's
                client-specific details before relying on it.
              </div>
            </div>
          )}
          {/* E: Meri drafted against UNRESOLVED MATERIAL Steward conflicts —
              amber-red, names the two disagreeing sources verbatim (≤120 chars
              each), links to the review surface. Annotate-only, never blocks. */}
          {s.groundingHealth?.status === 'conflicted' &&
            (() => {
              const first = s.groundingHealth?.openMaterialConflicts?.[0] ?? null;
              return (
                <div
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 10,
                    background: '#FCEDE6',
                    border: '1px solid #D97742',
                    borderRadius: 10,
                    padding: '11px 14px',
                    marginBottom: 14,
                    fontSize: 'var(--text-sm)',
                    color: 'var(--ink-2)',
                    lineHeight: 1.5,
                  }}
                >
                  <div style={{ marginTop: 1 }}>
                    <Icon name="alert" size={15} color="#A14D12" />
                  </div>
                  <div style={{ flex: 1 }}>
                    <b style={{ color: '#A14D12' }}>Drafted with unresolved context conflicts.</b>{' '}
                    {first ? (
                      <>
                        “{clip(first.factA)}” vs “{clip(first.factB)}” disagree in this client's
                        context.{' '}
                      </>
                    ) : (
                      <>The client context contains facts that materially disagree. </>
                    )}
                    Resolve which fact controls, then re-run Meri.{' '}
                    <button
                      onClick={() => navigate('/strategies/context/steward')}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        padding: 0,
                        cursor: 'pointer',
                        color: '#A14D12',
                        fontSize: 'var(--text-sm)',
                        fontWeight: 700,
                        textDecoration: 'underline',
                        fontFamily: 'var(--font-sans)',
                      }}
                    >
                      Review in the Steward
                    </button>
                  </div>
                </div>
              );
            })()}
          {/* A6: realism-verifier findings from the last Meri draft/assist. */}
          {s.violations && s.violations.length > 0 && (
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                background: s.violations.some((v) => v.severity === 'error') ? '#FDECEC' : '#FFF6E5',
                border: `1px solid ${s.violations.some((v) => v.severity === 'error') ? 'var(--critical)' : '#E0A94A'}`,
                borderRadius: 10,
                padding: '11px 14px',
                marginBottom: 14,
                fontSize: 'var(--text-sm)',
                color: 'var(--ink-2)',
                lineHeight: 1.5,
              }}
            >
              <b
                style={{
                  color: s.violations.some((v) => v.severity === 'error') ? 'var(--critical)' : '#9A6A12',
                }}
              >
                Meri's realism check flagged {s.violations.length} item
                {s.violations.length === 1 ? '' : 's'}
              </b>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {[...s.violations]
                  .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1))
                  .slice(0, 6)
                  .map((v, i) => (
                    <li
                      key={i}
                      style={{ color: v.severity === 'error' ? 'var(--critical)' : 'var(--ink-2)' }}
                    >
                      {v.message}
                      {v.suggestion ? ` — ${v.suggestion}` : ''}
                    </li>
                  ))}
              </ul>
            </div>
          )}
          <div style={{ zoom: 0.82 as unknown as number }}>
            <StrategyTimeline
              calendar={calendar}
              nodes={s.nodes}
              congress={reference.data?.congress ?? []}
              ppbeLanes={reference.data?.ppbeLanes ?? []}
              ppbeCurrentPhases={reference.data?.ppbeCurrentPhases ?? []}
              firmPhases={firmPhases.data ?? []}
              layers={layers}
              selectedId={selectedId}
              onSelectNode={selectNode}
              onRetime={onRetime}
              onEditCongress={() => setRefEdit('congress')}
              onEditPpbe={() => setRefEdit('ppbe')}
              onConfigureFirm={() => setFirmOpen(true)}
            />
          </div>
        </div>

        {railOpen && (
          <EditorRail
            strategyId={sid}
            node={selectedNode}
            calendar={calendar}
            members={members.data ?? []}
            meriEnabled={meriEnabled}
            watcherEnabled={watcherEnabled}
            agenticEnabled={agenticEnabled}
            meriSummary={s.meriSummary}
            currentUserId={user?.id}
            existingNodeIds={s.nodes.map((n) => n.id)}
            nodeArtifacts={nodeArtifacts}
            routing={routing}
            staging={staging}
            applied={applied}
            onFlash={flash}
            onSelectNode={selectNode}
            onRoute={onRoute}
            onStageAgent={onStageAgent}
            onOpenArtifact={onOpenArtifact}
            onClose={() => {
              setRailOpen(false);
              setSelectedId(null);
            }}
            onDeselect={() => setSelectedId(null)}
          />
        )}
      </div>

      {historyOpen && (
        <HistoryModal
          strategyId={sid}
          members={members.data ?? []}
          onClose={() => setHistoryOpen(false)}
          onRestored={(m) => flash(m)}
        />
      )}

      {firmOpen && (
        <FirmConfig
          firstRun={firmPhases.isSuccess && (firmPhases.data?.length ?? 0) === 0}
          phases={firmPhases.data ?? []}
          calendar={calendar}
          onClose={() => setFirmOpen(false)}
          onSaved={(m) => flash(m)}
        />
      )}

      {refEdit && reference.data && (
        <RefCalendarConfig
          kind={refEdit}
          calendars={reference.data}
          calendar={calendar}
          meriEnabled={meriEnabled}
          onClose={() => setRefEdit(null)}
          onSaved={(m) => flash(m)}
        />
      )}

      {exportOpen && (
        <ExportView
          strategy={s}
          clientName={clientName}
          calendar={calendar}
          layers={layers}
          congress={reference.data?.congress ?? []}
          ppbeLanes={reference.data?.ppbeLanes ?? []}
          ppbeCurrentPhases={reference.data?.ppbeCurrentPhases ?? []}
          firmPhases={firmPhases.data ?? []}
          onClose={() => setExportOpen(false)}
        />
      )}
    </div>
  );
}
