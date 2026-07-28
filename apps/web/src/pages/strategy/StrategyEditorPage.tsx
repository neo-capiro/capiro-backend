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
import { Icon, btnGhost } from './strategy-ui.js';
import { StrategyTimeline } from './StrategyTimeline.js';
import { StrategyHeader, type LayerKey } from './StrategyHeader.js';
import { StrategyMeriPanel } from './NodeRail.js';
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
  usePlanExecution,
  useMissions,
  useCreateMission,
  useUpdateMission,
  useChangeSets,
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
  findWatchMission,
  EXECUTION_MISSION_NAME,
  classifyWaitingReason,
} from './agents/agent-utils.js';
import { buildCalendar, formatDbDate } from './fiscal.js';
import type { StrategyNode, StrategyNodeArtifact } from './types.js';

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
  // Stage G: which agent-staging plan is in flight (null = none).
  const [staging, setStaging] = useState<'workspace_draft' | 'outreach_record' | null>(null);
  const [applied, setApplied] = useState<string | null>(null);
  const flashTimer = useRef<number>();
  const [searchParams] = useSearchParams();
  // Step 3: the header's Watch chip asks the panel to reveal its Watch block.
  const [focusWatch, setFocusWatch] = useState(false);
  // Step 10: this page owns the editor's vertical scroll container.
  const scrollRef = useRef<HTMLDivElement>(null);

  const addNode = useAddNode(id ?? '');
  const updateNode = useUpdateNode(id ?? '');
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

  // Step 3 (interim Watch chip). Both reads reuse queries the Watch panel
  // already makes — same React Query keys, so this costs no extra request, and
  // both are gated on watcherEnabled (⊆ agenticMeri) so a non-canaried tenant
  // never fires a request the server would 403.
  //
  // "Current-head" caveat: StrategyDetail exposes no head version id, and
  // nothing client-side resolves one (the review queue discovers staleness
  // lazily from apply's 409). So the count is the strategy's `proposed`
  // change-sets — what the app currently treats as actionable. Phase 3 adds the
  // version-aware revalidation that makes this exact.
  const watchProposals = useChangeSets({ strategyId: id ?? undefined, status: 'proposed' }, watcherEnabled);
  const watchMission = findWatchMission(missions.data ?? [], id ?? '');
  const watchChip = watcherEnabled
    ? { on: watchMission?.state === 'active', pending: watchProposals.data?.length ?? 0 }
    : null;

  // Step 10: every open starts at the top of the plan. Keyed on the strategy id
  // ONLY — selecting a node (which re-renders this page) must not jump the
  // timeline back to the top.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = 0;
  }, [id]);

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

  const selectNode = (nid: string) => {
    setSelectedId(nid);
    setRailOpen(true);
  };

  // Step 3: the Watch chip opens the EXISTING editor panel on its Watch block —
  // it deliberately does not navigate to /strategies/agents/review. The panel
  // only renders Watch at the strategy level, so any node selection clears.
  const openWatch = () => {
    setSelectedId(null);
    setRailOpen(true);
    setFocusWatch(true);
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

  const onOpenArtifact = (a: StrategyNodeArtifact) => {
    const suffix = selectedNode ? `${routeReturn}${selectedNode.id}` : '';
    // Straight to the editor (not Setup) — the staging call that created this
    // artifact already set client/product/content, so Setup has nothing left
    // to configure.
    const target =
      a.artifactType === 'workspace_draft'
        ? `/workspace/draft/${encodeURIComponent(a.artifactRef)}`
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
      <StrategyHeader
        onBack={() => navigate('/strategies')}
        clientLabel={clientName}
        typeLabel={STRATEGY_TYPE_LABEL[s.type]}
        title={s.title}
        goal={s.goal}
        layers={layers}
        onToggleLayer={(k) => setLayers((st) => ({ ...st, [k]: !st[k] }))}
        watch={watchChip}
        onOpenWatch={openWatch}
        onExport={() => setExportOpen(true)}
        onHistory={() => setHistoryOpen(true)}
        onAskMeri={() => setRailOpen(true)}
        meriPanelOpen={railOpen}
        meriEnabled={meriEnabled}
        // Manual creation survives ONLY as the Meri-off fallback (§3 Step 2).
        onAddStep={meriEnabled ? undefined : onAddStep}
        addStepPending={addNode.isPending}
      />

      <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex' }}>
        {/* Steps 8 + 10: the editor owns VERTICAL scrolling only — horizontal
            belongs to the timeline's own grid scroller, and overflowX:hidden
            here means a wide timeline can never widen the document. Every
            ancestor down to the grid viewport carries min-width:0; without it a
            flex item refuses to shrink below its content and the overflow
            escapes to the body. Padding matches the prototype's timeline area
            (12px top, 26px sides) with its 20px scroll tail. */}
        <div
          ref={scrollRef}
          data-sp-scroll="true"
          onClick={() => setSelectedId(null)}
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            overflowY: 'auto',
            overflowX: 'hidden',
            padding: '12px 26px 20px',
            background: 'var(--bg-canvas)',
          }}
        >
          {/* Phase 2 §5 Step 8 — two page cards removed here:
              · the blue "Meri drafted this plan" card, replaced by the panel's
                persistent (non-dismissible) drafted-plan note; and
              · the amber "Drafted on partial information" card, replaced by the
                `context_gap` message the draft endpoint now persists into the
                strategy thread. That card also printed the Steward's INTERNAL
                template keys ("strategy_brief") straight at the user; the
                conversation message uses plain language.
              The harder conflicted / verifier banners below stay until Phase 5
              ships their repair behaviour. */}
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
          <div style={{ zoom: 0.82 as unknown as number, minWidth: 0 }}>
            <StrategyTimeline
              strategyId={sid}
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
          <StrategyMeriPanel
            strategyId={sid}
            clientId={s.clientId}
            node={selectedNode}
            calendar={calendar}
            members={members.data ?? []}
            meriEnabled={meriEnabled}
            watcherEnabled={watcherEnabled}
            agenticEnabled={agenticEnabled}
            focusWatch={focusWatch}
            onWatchFocused={() => setFocusWatch(false)}
            meriSummary={s.meriSummary}
            draftedByMeri={s.draftedByMeri}
            currentUserId={user?.id}
            nodeArtifacts={nodeArtifacts}
            staging={staging}
            applied={applied}
            onFlash={flash}
            onSelectNode={selectNode}
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
