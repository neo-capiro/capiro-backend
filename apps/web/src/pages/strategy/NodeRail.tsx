/*
 * The strategy panel — ported from the prototype sp-app MeriRail. G3 built the
 * MANUAL subset (Meri flag off): node summary (NOD-2), applied-confirmation
 * flash (NOD-3), deterministic quick actions (NOD-5), the manual field editor
 * (NOD-7), and delete (NOD-8); G5/G6 added Meri and the "Available actions in
 * Capiro" routing block. 344px slide-in panel, prototype-faithful.
 *
 * Phase 2 restructures it into a real chat surface:
 *   header · persistent drafted-plan note · ONE scrolling body (content, then
 *   the durable thread) · pinned footer (composer, suggestions, helper).
 * The composer moved OUT of the scroll container — it used to sit inline in the
 * body and scroll away — and the transcript is now server-persisted per context
 * instead of dying with the component.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { App } from 'antd';
import { Icon, iconBtn, fieldS, fieldLbl, chipBtn } from './strategy-ui.js';
import { OwnerPicker } from './OwnerPicker.js';
import { TargetPicker } from './TargetPicker.js';
import { useClientTargetsLite, targetDisplayLabel } from './client-targets-lite.js';
import { StrategyChatComposer } from './StrategyChatComposer.js';
import { StrategyChatThread, type PendingChatMessage } from './StrategyChatThread.js';
import { StrategyWatchPanel } from './agents/StrategyWatchPanel.js';
import { useAssistant, useStrategyConversation } from './api.js';
import {
  NODE_KIND_META,
  NODE_SUBJECTS,
  NODE_SUBJECT_LABEL,
  NODE_STATUS_OPTIONS,
} from './constants.js';
import { qOfDate, parseDbDate, nodeRangeLabel, monthLabel, shiftNodeMonths } from './fiscal.js';
import type { FiscalCalendar } from './fiscal.js';
import { useUpdateNode, useDeleteNode } from './api.js';
import { memberName, type TenantMember } from './members.js';
import type {
  NodeSubject,
  StrategyChatAttachment,
  StrategyChatMessage,
  StrategyNode,
  StrategyNodeArtifact,
  UpdateNodeInput,
} from './types.js';

/** The prototype's exact drafted-plan copy. Persistent and non-dismissible. */
export const DRAFTED_NOTE =
  'Meri drafted this plan. Every step is editable — drag to re-time, click to open, or just ask here.';

/**
 * Footer suggestion pills. Strategy-scope copy is the shipped MRI-4 set (real
 * instructions Meri can execute); node-scope copy is the prototype's three.
 * Both go through the assistant, so each one produces a durable exchange in the
 * thread rather than a silent mutation.
 */
const STRATEGY_SUGGESTIONS = [
  'Add a coalition sign-on letter',
  // The prototype's literal, adopted over MRI-4's longer "Flag a CR risk before
  // final bills": the short form is an equally complete instruction and the long
  // one wrapped the pill row to three lines instead of the prototype's two.
  'Flag a CR risk',
  // NOT the prototype's "Push markup defense" — that names a step that only
  // exists in the prototype's fixture. This is MRI-4's shipped copy, and it sits
  // alone on the second row in both, so the row geometry is unaffected.
  'Push the latest action a quarter',
];

/**
 * The node-scope pills are NOD-5's deterministic quick actions, relocated from
 * the panel body to the footer where the prototype puts them. They stay
 * deterministic — routing "Push a quarter" through the model would cost a
 * round-trip to do what a single PATCH already does exactly.
 */
type NodeQuickAction = 'push' | 'assign' | 'gate';
const NODE_SUGGESTIONS: Array<{ id: NodeQuickAction; label: string }> = [
  { id: 'push', label: 'Push a quarter' },
  { id: 'assign', label: 'Reassign to me' },
  { id: 'gate', label: 'Make it a gate' },
];

/** A UUID for the send's idempotency key. crypto.randomUUID is unavailable in
 *  jsdom and on http:// origins, so fall back to a v4-shaped random string. */
function newClientMessageId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = Math.floor(Math.random() * 16);
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** Subjects a real target (a specific person/office) makes sense for — mirrors
 *  api-strategy's OUTREACH_SUBJECTS (execution-eligibility.ts); other subjects
 *  (deliverable/submission/ask/outcome/optics) are about work product or
 *  concepts, not a counterparty to target. */
const TARGETABLE_SUBJECTS: NodeSubject[] = ['member', 'committee', 'agency'];

export function StrategyMeriPanel({
  strategyId,
  clientId,
  node,
  calendar,
  members,
  meriEnabled,
  watcherEnabled,
  agenticEnabled,
  focusWatch,
  onWatchFocused,
  meriSummary,
  draftedByMeri,
  currentUserId,
  nodeArtifacts,
  staging,
  applied,
  onFlash,
  onSelectNode,
  onStageAgent,
  onOpenArtifact,
  onClose,
  onDeselect,
}: {
  strategyId: string;
  clientId: string;
  node: StrategyNode | null;
  calendar: FiscalCalendar;
  members: TenantMember[];
  meriEnabled: boolean;
  /**
   * Stage F: shows the Watch-mode block (UI belt). Requires BOTH /me bits —
   * features.agenticMeri AND features.strategyWatcher (canShowWatchRail):
   * the run-check route stacks StrategyWatcherGuard on top of AgenticGuard
   * and the scheduler skips watcher-flag-off tenants quietly, so on
   * agenticMeri alone the toggle would lie ("Watching" while nothing runs).
   */
  watcherEnabled?: boolean;
  /**
   * Stage G: shows the node-level "prepare with the agent" affordances (UI
   * belt = features.agenticMeri; the server enforces the per-intent
   * executionAgent flags). Optional so an older cached /me shape degrades.
   */
  agenticEnabled?: boolean;
  /**
   * Phase 1 §3 Step 3: the header's Watch chip asks the panel to reveal its
   * Watch block. The panel scrolls it into view and flags it briefly; Phase 4
   * replaces the block itself.
   */
  focusWatch?: boolean;
  /** Acknowledges a focusWatch request so it fires once per click. */
  onWatchFocused?: () => void;
  meriSummary?: string | null;
  /**
   * SHL-5 provenance: true ONLY for a plan Meri drafted from a goal. Drives the
   * persistent note — a manually created strategy renders nothing rather than
   * claiming Meri authored it.
   */
  draftedByMeri?: boolean;
  currentUserId: string | undefined;
  nodeArtifacts: StrategyNodeArtifact[];
  /** Stage G: which agent-staging plan is in flight (null = none). */
  staging?: 'workspace_draft' | 'outreach_record' | null;
  applied: string | null;
  onFlash: (msg: string) => void;
  onSelectNode: (id: string) => void;
  /** Stage G: plan an agent-staged draft/outreach for this node, then review it. */
  onStageAgent?: (intent: 'workspace_draft' | 'outreach_record') => void;
  onOpenArtifact: (a: StrategyNodeArtifact) => void;
  onClose: () => void;
  onDeselect: () => void;
}) {
  const { message, modal } = App.useApp();
  const update = useUpdateNode(strategyId);
  const del = useDeleteNode(strategyId);
  const assistant = useAssistant(strategyId);

  // The chat context: a selected step's thread, or the strategy thread. Each has
  // its own query key, so switching contexts renders that context's persisted
  // history rather than whichever one was fetched last.
  const contextNodeId = node?.id ?? null;
  const conversation = useStrategyConversation(strategyId, contextNodeId, meriEnabled);
  // The user's own message, echoed while the send is in flight. Scoped to the
  // context it was sent from so switching away mid-send does not show it under
  // the wrong thread.
  const [pending, setPending] = useState<{ contextNodeId: string | null; msg: PendingChatMessage } | null>(
    null,
  );

  /**
   * Strategies drafted before this phase have a `meriSummary` but no stored
   * conversation. Render it as Meri's opening line so their panel is not empty —
   * display-only, never written back.
   */
  const messages = useMemo<StrategyChatMessage[]>(() => {
    const rows = conversation.data ?? [];
    // A dismissed context gap is resolved as far as the user is concerned.
    const visible = rows.filter((m) => m.state !== 'dismissed');
    if (visible.length > 0 || contextNodeId || !conversation.isSuccess) return visible;
    if (!draftedByMeri || !meriSummary) return visible;
    return [
      {
        id: 'legacy-summary',
        strategyId,
        nodeId: null,
        role: 'meri',
        kind: 'message',
        body: meriSummary,
        attachments: [],
        action: null,
        state: 'active',
        createdByUserId: null,
        createdAt: '',
      },
    ];
  }, [conversation.data, conversation.isSuccess, contextNodeId, draftedByMeri, meriSummary, strategyId]);

  const runAssistant = (
    scope: 'node' | 'strategy',
    nodeId: string | undefined,
    instruction: string,
    attachments: StrategyChatAttachment[],
  ) => {
    const sentFrom = scope === 'node' ? (nodeId ?? null) : null;
    setPending({ contextNodeId: sentFrom, msg: { body: instruction, attachments } });
    assistant.mutate(
      {
        scope,
        ...(nodeId ? { nodeId } : {}),
        instruction,
        attachmentIds: attachments.map((a) => a.id),
        attachments,
        // Idempotency key: a retried POST reuses the stored user message rather
        // than posting a second bubble.
        clientMessageId: newClientMessageId(),
      },
      {
        onSuccess: (resp) => {
          onFlash(trimFlash(resp.reply) || 'Meri updated the plan.');
          // Phase 2 §5 Step 7: a send NEVER auto-opens a created step. The
          // reply's explicit `Open "<step>"` button is the only way in.
        },
        onError: () => message.error('Meri could not apply that — please try again.'),
        // Cleared on BOTH outcomes: the refetch has been queued by then, and on
        // failure the server-side `assistant_error` line is what should show.
        onSettled: () => setPending(null),
      },
    );
  };

  /** One field edit on the selected step, with its confirmation flash. */
  const commitNode = (input: UpdateNodeInput, flash: string) => {
    if (!node) return;
    update.mutate(
      { nodeId: node.id, input: { ...input, changeNote: flash } },
      {
        onSuccess: () => onFlash(flash),
        onError: () => message.error('Could not save that change.'),
      },
    );
  };

  const runQuickAction = (action: NodeQuickAction) => {
    if (!node) return;
    if (action === 'push') {
      const shifted = shiftNodeMonths(node.startsOn, node.endsOn, 3, calendar);
      if (shifted.applied === 0) {
        onFlash('Already at the end of the window.');
        return;
      }
      commitNode({ startsOn: shifted.startsOn, endsOn: shifted.endsOn ?? null }, 'Pushed one quarter.');
      return;
    }
    if (action === 'assign') {
      if (currentUserId) commitNode({ ownerUserId: currentUserId }, 'Reassigned to you.');
      return;
    }
    commitNode({ kind: 'gate' }, 'Converted to a gate.');
  };

  const quickActionDisabled = (action: NodeQuickAction): boolean => {
    if (update.isPending || del.isPending || assistant.isPending) return true;
    if (action === 'assign') return !currentUserId;
    if (action === 'gate') return node?.kind === 'gate';
    return false;
  };

  // Auto-scroll to newest: on context switch, on send, and when the reply lands.
  // Writing scrollTop on the panel body (rather than scrollIntoView) is the
  // prototype's own behaviour and cannot reach the timeline or the page.
  const bodyRef = useRef<HTMLDivElement>(null);
  const visibleCount = messages.length + (pending && pending.contextNodeId === contextNodeId ? 1 : 0);
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visibleCount, contextNodeId]);

  return (
    <div
      className="sp-rail-in"
      style={{
        width: 344,
        height: '100%',
        flexShrink: 0,
        borderLeft: '1px solid var(--border-1)',
        background: 'var(--bg-surface)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        // The prototype's global reset is border-box, so its 344px INCLUDES the
        // left border. Without this the panel is 344 + border wide and every
        // child inside it sits a subpixel off the prototype's geometry.
        boxSizing: 'border-box',
        // The prototype's body sets no line-height, so everything here resolves
        // to `normal`. Capiro renders inside antd's <App>, which sets an
        // absolute 22px on its wrapper — that inherits straight through and made
        // every unstyled line in this panel 6-8px taller than the prototype's.
        // Scoped to the panel rather than .sp-root so it cannot disturb the
        // header and timeline Phase 1 already signed off.
        lineHeight: 'normal',
      }}
    >
      <div
        style={{
          padding: '14px 16px',
          borderBottom: '1px solid var(--border-1)',
          background: 'linear-gradient(180deg, var(--accent-soft), var(--bg-surface))',
          display: 'flex',
          alignItems: 'center',
          gap: 9,
        }}
      >
        {node ? (
          <button
            onClick={onDeselect}
            style={{ ...iconBtn, border: '1px solid var(--border-2)', width: 28, height: 28 }}
          >
            <Icon name="chevleft" size={15} color="var(--ink-2)" />
          </button>
        ) : (
          <span
            style={{
              width: 28,
              height: 28,
              borderRadius: '50%',
              background: 'var(--accent)',
              color: '#fff',
              display: 'grid',
              placeItems: 'center',
            }}
          >
            <Icon name={meriEnabled ? 'spark' : 'panel'} size={15} color="#fff" />
          </span>
        )}
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 'var(--text-base)', fontWeight: 700, color: 'var(--ink-1)' }}>
            {node ? (meriEnabled ? 'Edit with Meri' : 'Edit step') : meriEnabled ? 'Meri' : 'Strategy panel'}
          </div>
          <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--ink-3)' }}>
            {node
              ? meriEnabled
                ? 'Ask Meri, or edit fields'
                : 'Edit fields'
              : meriEnabled
                ? 'Strategy assistant'
                : 'Select a step to edit'}
          </div>
        </div>
        <button onClick={onClose} style={iconBtn}>
          <Icon name="x" size={15} color="var(--ink-3)" />
        </button>
      </div>

      {/* Persistent drafted-plan note. Sits between the header and the scroll
          area, so it never scrolls away, and carries no close control — this is
          standing provenance, not a notification. Replaces the one-time blue
          page card. */}
      {draftedByMeri && (
        <div
          data-testid="sp-drafted-note"
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 7,
            padding: '8px 14px',
            background: 'var(--accent-soft)',
            borderBottom: '1px solid #C6D4F4',
            flexShrink: 0,
          }}
        >
          <Icon name="spark" size={12} color="var(--accent-ink)" />
          <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--accent-ink)', lineHeight: 1.45 }}>
            {DRAFTED_NOTE}
          </span>
        </div>
      )}

      {/* THE scroll container. One vertical block: content sections, then the
          thread. `minHeight: 0` lets it actually shrink inside the column, and
          every direct child is `flexShrink: 0` so a long thread grows the
          scroll height instead of compressing the cards and fields above it. */}
      <div
        ref={bodyRef}
        data-testid="sp-panel-body"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          overflowX: 'hidden',
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        {applied && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              flexShrink: 0,
              background: 'var(--success-soft)',
              border: '1px solid var(--success)',
              borderRadius: 8,
              padding: '8px 11px',
              fontSize: 'var(--text-xs)',
              color: 'var(--success)',
              fontWeight: 600,
            }}
          >
            <Icon name="check" size={13} color="var(--success)" /> {applied}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, flexShrink: 0 }}>
        {node ? (
          <>
            {/* The node composer moved to the pinned footer (§5 Step 7) — the
                inline accent box used to scroll away with the fields. */}
            <NodeEditor
              node={node}
              calendar={calendar}
              members={members}
              currentUserId={currentUserId}
              clientId={clientId}
              busy={update.isPending || del.isPending || assistant.isPending}
            onCommit={commitNode}
            onDelete={() => {
              modal.confirm({
                title: 'Delete this step?',
                content: node.title,
                okText: 'Delete',
                okButtonProps: { danger: true },
                onOk: () =>
                  new Promise<void>((resolve, reject) => {
                    del.mutate(node.id, {
                      onSuccess: () => {
                        onFlash('Step deleted.');
                        onDeselect();
                        resolve();
                      },
                      onError: () => {
                        message.error('Could not delete the step.');
                        reject(new Error('delete failed'));
                      },
                    });
                  }),
              });
            }}
            />
            <NodeActions
              artifacts={nodeArtifacts}
              agenticEnabled={agenticEnabled}
              staging={staging}
              onStageAgent={onStageAgent}
              onOpenArtifact={onOpenArtifact}
            />
          </>
        ) : (
          <>
            {/* The strategy-level Meri summary card is gone: the draft now seeds
                that summary as Meri's opening message in the thread below, and
                the prototype has no such card. */}
            {!meriEnabled && (
              <div
                style={{
                  background: 'var(--bg-surface-2)',
                  border: '1px solid var(--border-1)',
                  borderRadius: 9,
                  padding: '11px 13px',
                  fontSize: 'var(--text-sm)',
                  color: 'var(--ink-2)',
                  lineHeight: 1.5,
                }}
              >
                Select a step on the timeline to edit its fields, re-time it, or delete it. Use{' '}
                <b>+ Add step</b> in the header to create one.
              </div>
            )}
            {/* Stage F / Phase 4: Watch-mode affordance (agenticMeri+strategyWatcher UI belt). */}
            {watcherEnabled && (
              <StrategyWatchPanel
                strategyId={strategyId}
                focus={focusWatch}
                onFocused={onWatchFocused}
              />
            )}
          </>
        )}
        </div>

        {meriEnabled && (
          <StrategyChatThread
            messages={messages}
            pending={pending && pending.contextNodeId === contextNodeId ? pending.msg : null}
            onOpenNode={onSelectNode}
          />
        )}
      </div>

      {/* Pinned footer — OUTSIDE the scroll container, so the composer and its
          suggestions stay put however long the thread grows. */}
      {meriEnabled && (
        <div
          data-testid="sp-panel-footer"
          style={{
            padding: '11px 14px 12px',
            borderTop: '1px solid var(--border-1)',
            background: 'var(--bg-surface)',
            flexShrink: 0,
          }}
        >
          <StrategyChatComposer
            placeholder={node ? 'Ask Meri to change this step…' : 'Ask Meri to change anything…'}
            busy={assistant.isPending}
            onSubmit={(text, attachments) =>
              runAssistant(node ? 'node' : 'strategy', node?.id, text, attachments)
            }
          />
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 9 }}>
            {node
              ? NODE_SUGGESTIONS.map((a) => (
                  <button
                    key={a.id}
                    style={chipBtn}
                    disabled={quickActionDisabled(a.id)}
                    onClick={() => runQuickAction(a.id)}
                  >
                    {a.label}
                  </button>
                ))
              : STRATEGY_SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    style={chipBtn}
                    disabled={assistant.isPending}
                    onClick={() => runAssistant('strategy', undefined, s, [])}
                  >
                    {s}
                  </button>
                ))}
          </div>
          <div
            style={{
              fontSize: 'var(--text-2xs)',
              color: 'var(--ink-4)',
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              marginTop: 9,
            }}
          >
            <Icon name="check" size={11} color="var(--ink-4)" /> Meri applies changes instantly. Edits
            are logged.
          </div>
        </div>
      )}
    </div>
  );
}

function NodeEditor({
  node,
  calendar,
  members,
  currentUserId,
  clientId,
  busy,
  onCommit,
  onDelete,
}: {
  node: StrategyNode;
  calendar: FiscalCalendar;
  members: TenantMember[];
  currentUserId: string | undefined;
  clientId: string;
  busy: boolean;
  onCommit: (input: UpdateNodeInput, flash: string) => void;
  onDelete: () => void;
}) {
  const navigate = useNavigate();
  const [titleBuf, setTitleBuf] = useState(node.title);
  const [noteBuf, setNoteBuf] = useState(node.note ?? '');
  const [showFields, setShowFields] = useState(true);
  const clientTargets = useClientTargetsLite(clientId);

  // Re-sync local text buffers whenever the committed node changes (after a
  // save, a restore, or selecting a different node).
  useEffect(() => {
    setTitleBuf(node.title);
    setNoteBuf(node.note ?? '');
  }, [node.id, node.title, node.note]);

  const k = NODE_KIND_META[node.kind];
  const startQ = qOfDate(parseDbDate(node.startsOn), calendar);
  const endQ = node.endsOn ? qOfDate(parseDbDate(node.endsOn), calendar) : startQ;
  const rangeLabel =
    node.openEnded && node.kind === 'risk'
      ? `${monthLabel(startQ, calendar)} · Ongoing`
      : nodeRangeLabel(startQ, endQ, calendar);

  return (
    <>
      {/* node summary (NOD-2) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            width: 22,
            height: 22,
            borderRadius: 6,
            background: k.color,
            color: '#fff',
            display: 'grid',
            placeItems: 'center',
            fontSize: 12,
            fontWeight: 800,
          }}
        >
          {k.letter}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 'var(--text-sm)',
              fontWeight: 700,
              color: 'var(--ink-1)',
              lineHeight: 1.25,
            }}
          >
            {node.title}
          </div>
          <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--ink-3)' }}>
            {k.label} · {NODE_SUBJECT_LABEL[node.subject]} · {rangeLabel}
          </div>
        </div>
      </div>

      {/* NOD-5's quick actions moved to the panel footer as this context's
          suggestion pills (§5 Step 7) — the prototype's node body has no
          quick-actions block, and keeping both would put the same three
          controls on screen twice. Same deterministic handlers, one home. */}

      {/* edit fields (NOD-7) — collapsible, default open with Meri off */}
      <div style={{ borderTop: '1px solid var(--border-1)', paddingTop: 12 }}>
        <button
          onClick={() => setShowFields((v) => !v)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            width: '100%',
            background: 'transparent',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            fontSize: 'var(--text-xs)',
            fontWeight: 700,
            color: 'var(--ink-2)',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}
        >
          <span style={{ transform: showFields ? 'rotate(90deg)' : 'none', display: 'grid' }}>
            <Icon name="chevron" size={13} color="var(--ink-3)" />
          </span>
          Edit fields manually
        </button>
        {showFields && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <span style={fieldLbl}>Type</span>
              <select
                value={node.kind}
                disabled={busy}
                onChange={(e) => onCommit({ kind: e.target.value as StrategyNode['kind'] }, 'Type updated.')}
                style={fieldS}
              >
                {(Object.keys(NODE_KIND_META) as StrategyNode['kind'][]).map((kk) => (
                  <option key={kk} value={kk}>
                    {NODE_KIND_META[kk].letter} · {NODE_KIND_META[kk].label}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <span style={fieldLbl}>Subject</span>
              <select
                value={node.subject}
                disabled={busy}
                onChange={(e) =>
                  onCommit({ subject: e.target.value as StrategyNode['subject'] }, 'Subject updated.')
                }
                style={fieldS}
              >
                {NODE_SUBJECTS.map((s) => (
                  <option key={s} value={s}>
                    {NODE_SUBJECT_LABEL[s]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <span style={fieldLbl}>Title</span>
            <textarea
              value={titleBuf}
              disabled={busy}
              onChange={(e) => setTitleBuf(e.target.value)}
              onBlur={() => {
                const next = titleBuf.trim();
                if (next && next !== node.title) onCommit({ title: next }, 'Title updated.');
                else setTitleBuf(node.title);
              }}
              rows={2}
              style={{ ...fieldS, resize: 'none', lineHeight: 1.4 }}
            />
          </div>

          <div>
            <span style={fieldLbl}>Owner</span>
            <OwnerPicker
              members={members}
              value={node.ownerUserId}
              onChange={(id) =>
                onCommit({ ownerUserId: id }, `Reassigned to ${memberName(members, id)}.`)
              }
            />
          </div>

          {TARGETABLE_SUBJECTS.includes(node.subject) && (
            <div>
              <span style={fieldLbl}>Target</span>
              <TargetPicker
                targets={clientTargets.data ?? []}
                loading={clientTargets.isLoading}
                value={node.targetRef}
                onChange={(target) =>
                  onCommit(
                    { targetRef: target },
                    target ? `Target set to ${targetDisplayLabel(target)}.` : 'Target cleared.',
                  )
                }
              />
            </div>
          )}

          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <span style={fieldLbl}>Starts</span>
              <input
                type="date"
                value={node.startsOn.slice(0, 10)}
                disabled={busy}
                onChange={(e) => e.target.value && onCommit({ startsOn: e.target.value }, 'Dates updated.')}
                style={fieldS}
              />
            </div>
            <div style={{ flex: 1 }}>
              <span style={fieldLbl}>Ends</span>
              <input
                type="date"
                value={node.endsOn ? node.endsOn.slice(0, 10) : ''}
                disabled={busy || (node.openEnded && node.kind === 'risk')}
                min={node.startsOn.slice(0, 10)}
                onChange={(e) => onCommit({ endsOn: e.target.value || null }, 'Dates updated.')}
                style={{ ...fieldS, opacity: node.openEnded && node.kind === 'risk' ? 0.5 : 1 }}
              />
            </div>
          </div>

          {node.kind === 'risk' && (
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 'var(--text-sm)',
                color: 'var(--ink-2)',
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={node.openEnded}
                disabled={busy}
                onChange={(e) =>
                  onCommit(
                    e.target.checked ? { openEnded: true, endsOn: null } : { openEnded: false },
                    e.target.checked ? 'Marked ongoing.' : 'Ongoing cleared.',
                  )
                }
              />
              Ongoing risk (no end date)
            </label>
          )}

          <div>
            <span style={fieldLbl}>Status</span>
            <select
              value={node.status}
              disabled={busy}
              onChange={(e) =>
                onCommit({ status: e.target.value as StrategyNode['status'] }, 'Status updated.')
              }
              style={fieldS}
            >
              {NODE_STATUS_OPTIONS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <span style={fieldLbl}>Notes</span>
            <textarea
              value={noteBuf}
              disabled={busy}
              onChange={(e) => setNoteBuf(e.target.value)}
              onBlur={() => {
                if (noteBuf !== (node.note ?? '')) onCommit({ note: noteBuf || null }, 'Notes updated.');
              }}
              rows={3}
              style={{ ...fieldS, resize: 'none', lineHeight: 1.45 }}
            />
          </div>

          {/* A3 dependency edges + A9 grounding provenance (read-only). */}
          {(node.dependsOnIds.length > 0 || node.provenance?.sources?.length) && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {node.dependsOnIds.length > 0 && (
                <div>
                  <span style={fieldLbl}>Depends on</span>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-2)' }}>
                    {node.dependsOnIds.length} earlier step{node.dependsOnIds.length === 1 ? '' : 's'} must
                    finish first
                  </div>
                </div>
              )}
              {node.provenance?.sources?.length ? (
                <div>
                  <span style={fieldLbl}>Grounded in</span>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 2 }}>
                    {node.provenance.sources.map((src, i) => {
                      // Stage E: a 'fact:<id>' ref anchors a Steward fact —
                      // deep-link into the review surface, which highlights it.
                      const factId = src.ref?.startsWith('fact:') ? src.ref.slice(5) : null;
                      if (factId) {
                        return (
                          <button
                            key={i}
                            onClick={() =>
                              navigate(
                                `/strategies/context/steward?fact=${encodeURIComponent(factId)}`,
                              )
                            }
                            title="Open this fact in the Steward review"
                            style={{
                              fontSize: 'var(--text-2xs)',
                              fontWeight: 600,
                              fontFamily: 'var(--font-sans)',
                              color: 'var(--accent-ink)',
                              background: 'var(--accent-soft)',
                              border: '1px solid #C6D4F4',
                              borderRadius: 6,
                              padding: '2px 7px',
                              cursor: 'pointer',
                            }}
                          >
                            {src.section}
                            {` · ${src.ref}`}
                          </button>
                        );
                      }
                      return (
                        <span
                          key={i}
                          style={{
                            fontSize: 'var(--text-2xs)',
                            fontWeight: 600,
                            color: 'var(--ink-2)',
                            background: 'var(--bg-surface-2)',
                            border: '1px solid var(--border-1)',
                            borderRadius: 6,
                            padding: '2px 7px',
                          }}
                        >
                          {src.section}
                          {src.ref ? ` · ${src.ref}` : ''}
                        </span>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>
        )}
      </div>

      <button
        onClick={onDelete}
        disabled={busy}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          alignSelf: 'flex-start',
          background: 'transparent',
          border: 'none',
          color: 'var(--critical)',
          fontSize: 'var(--text-xs)',
          fontWeight: 600,
          cursor: 'pointer',
          padding: 0,
        }}
      >
        <Icon name="trash" size={13} color="var(--critical)" /> Delete step
      </button>
    </>
  );
}

function trimFlash(s: string | undefined): string {
  const t = (s ?? '').trim();
  return t.length > 120 ? `${t.slice(0, 117)}…` : t;
}

/**
 * Stage G node-level agent affordances (behind the agenticMeri UI belt): have
 * Meri's Execution Agent PREPARE a Workspace draft / STAGE outreach for this
 * node, landing in the Execution review — an execution run, per plan §G,
 * that never sends anything. The deterministic direct-create
 * affordances these replaced (NOD-6's original "Draft in Workspace"/"Send
 * Outreach") were removed once the agent path proved reliable — it produces
 * everything they did (falls back to the same deterministic content when
 * generation isn't possible) plus a real recipient and grounded body when it
 * is, so there was no case left where the deterministic path won.
 */
const AGENT_ACTIONS: Array<{
  id: 'workspace_draft' | 'outreach_record';
  label: string;
  desc: string;
  icon: string;
}> = [
  {
    id: 'workspace_draft',
    label: 'Prepare in Workspace (agent)',
    desc: 'Have Meri write a full grounded document for this step — every section, cited to your context — staged for your review.',
    icon: 'spark',
  },
  {
    id: 'outreach_record',
    label: 'Stage outreach (agent)',
    desc: 'Have Meri draft the full outreach message for this step, grounded in your context — staged and never sent until you approve.',
    icon: 'spark',
  },
];

/**
 * NOD-6 "Available actions in Capiro" — have Meri's Execution Agent stage a
 * Workspace draft or outreach for the selected node (agenticEnabled), and
 * list the artifact back-links (sp_node_artifact) already created for it.
 * Staging itself lives in StrategyEditorPage's onStageAgent (needs the
 * mission-resolution + navigate); this block only surfaces the buttons + chips.
 */
function NodeActions({
  artifacts,
  agenticEnabled,
  staging,
  onStageAgent,
  onOpenArtifact,
}: {
  artifacts: StrategyNodeArtifact[];
  agenticEnabled?: boolean;
  staging?: 'workspace_draft' | 'outreach_record' | null;
  onStageAgent?: (intent: 'workspace_draft' | 'outreach_record') => void;
  onOpenArtifact: (a: StrategyNodeArtifact) => void;
}) {
  const [open, setOpen] = useState(true);
  const showAgent = Boolean(agenticEnabled && onStageAgent);
  return (
    <div style={{ borderTop: '1px solid var(--border-1)', paddingTop: 12 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          width: '100%',
          background: 'transparent',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          fontSize: 'var(--text-xs)',
          fontWeight: 700,
          color: 'var(--ink-2)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        }}
      >
        <span style={{ transform: open ? 'rotate(90deg)' : 'none', display: 'grid' }}>
          <Icon name="chevron" size={13} color="var(--ink-3)" />
        </span>
        Available actions in Capiro
      </button>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
          {showAgent &&
            AGENT_ACTIONS.map((a) => {
              const busy = staging === a.id;
              const anyStaging = Boolean(staging);
              return (
                <button
                  key={a.id}
                  onClick={() => onStageAgent?.(a.id)}
                  disabled={anyStaging}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 11,
                    textAlign: 'left',
                    background: 'var(--accent-soft)',
                    border: '1px solid #C6D4F4',
                    borderRadius: 10,
                    padding: '11px 13px',
                    cursor: anyStaging ? 'default' : 'pointer',
                    opacity: anyStaging && !busy ? 0.55 : 1,
                  }}
                >
                  <span
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: 8,
                      background: 'var(--bg-surface)',
                      display: 'grid',
                      placeItems: 'center',
                      flexShrink: 0,
                    }}
                  >
                    <Icon name={busy ? 'clock' : a.icon} size={15} color="var(--accent-ink)" />
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span
                      style={{
                        display: 'block',
                        fontSize: 'var(--text-sm)',
                        fontWeight: 700,
                        color: 'var(--accent-ink)',
                      }}
                    >
                      {busy ? 'Preparing…' : a.label}
                    </span>
                    <span
                      style={{
                        display: 'block',
                        fontSize: 'var(--text-2xs)',
                        color: 'var(--ink-3)',
                        lineHeight: 1.4,
                      }}
                    >
                      {a.desc}
                    </span>
                  </span>
                  <Icon name="arrow" size={15} color="var(--accent-ink)" />
                </button>
              );
            })}
          {artifacts.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
              <div style={fieldLbl}>Linked in Capiro</div>
              {artifacts.map((a) => (
                <button
                  key={a.id}
                  onClick={() => onOpenArtifact(a)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    textAlign: 'left',
                    background: 'var(--bg-surface-2)',
                    border: '1px solid var(--border-1)',
                    borderRadius: 8,
                    padding: '7px 10px',
                    cursor: 'pointer',
                  }}
                >
                  <Icon
                    name={a.artifactType === 'workspace_draft' ? 'doc' : 'users'}
                    size={13}
                    color="var(--ink-3)"
                  />
                  <span
                    style={{ flex: 1, fontSize: 'var(--text-xs)', color: 'var(--ink-2)', fontWeight: 600 }}
                  >
                    {a.artifactType === 'workspace_draft' ? 'Workspace draft' : 'Outreach campaign'}
                  </span>
                  <Icon name="external" size={13} color="var(--ink-4)" />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
