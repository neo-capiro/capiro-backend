/*
 * Editor rail — ported from the prototype sp-app MeriRail. G3 builds the MANUAL
 * subset (Meri flag off): node summary (NOD-2), applied-confirmation flash
 * (NOD-3), deterministic quick actions (NOD-5), the manual field editor
 * (NOD-7), and delete (NOD-8). The Meri "Ask Meri" box + suggestion chips
 * (NOD-4) and the "Available actions in Capiro" routing block (NOD-6) are
 * gated off here and land in G5/G6. 344px slide-in panel, prototype-faithful.
 */
import { useEffect, useState } from 'react';
import { App } from 'antd';
import { Icon, Ava, iconBtn, fieldS, fieldLbl, chipBtn } from './strategy-ui.js';
import { OwnerPicker } from './OwnerPicker.js';
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
import type { StrategyNode, UpdateNodeInput } from './types.js';

export function EditorRail({
  strategyId,
  node,
  calendar,
  members,
  meriEnabled,
  currentUserId,
  applied,
  onFlash,
  onClose,
  onDeselect,
}: {
  strategyId: string;
  node: StrategyNode | null;
  calendar: FiscalCalendar;
  members: TenantMember[];
  meriEnabled: boolean;
  currentUserId: string | undefined;
  applied: string | null;
  onFlash: (msg: string) => void;
  onClose: () => void;
  onDeselect: () => void;
}) {
  const { message, modal } = App.useApp();
  const update = useUpdateNode(strategyId);
  const del = useDeleteNode(strategyId);

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

      <div
        style={{
          flex: 1,
          overflow: 'auto',
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

        {node ? (
          <NodeEditor
            node={node}
            calendar={calendar}
            members={members}
            currentUserId={currentUserId}
            busy={update.isPending || del.isPending}
            onCommit={(input, flash) => {
              update.mutate(
                { nodeId: node.id, input: { ...input, changeNote: flash } },
                {
                  onSuccess: () => onFlash(flash),
                  onError: () => message.error('Could not save that change.'),
                },
              );
            }}
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
        ) : (
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
      </div>
    </div>
  );
}

function NodeEditor({
  node,
  calendar,
  members,
  currentUserId,
  busy,
  onCommit,
  onDelete,
}: {
  node: StrategyNode;
  calendar: FiscalCalendar;
  members: TenantMember[];
  currentUserId: string | undefined;
  busy: boolean;
  onCommit: (input: UpdateNodeInput, flash: string) => void;
  onDelete: () => void;
}) {
  const [titleBuf, setTitleBuf] = useState(node.title);
  const [noteBuf, setNoteBuf] = useState(node.note ?? '');
  const [showFields, setShowFields] = useState(true);

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

  const pushQuarter = () => {
    const shifted = shiftNodeMonths(node.startsOn, node.endsOn, 3, calendar);
    if (shifted.applied === 0) {
      onCommit({}, 'Already at the end of the window.');
      return;
    }
    onCommit(
      { startsOn: shifted.startsOn, endsOn: shifted.endsOn ?? null },
      'Pushed one quarter.',
    );
  };

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

      {/* quick actions (NOD-5, deterministic) */}
      <div>
        <div style={{ ...fieldLbl, marginBottom: 7 }}>Quick actions</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button style={chipBtn} disabled={busy} onClick={pushQuarter}>
            Push a quarter
          </button>
          <button
            style={chipBtn}
            disabled={busy || !currentUserId}
            onClick={() =>
              currentUserId && onCommit({ ownerUserId: currentUserId }, 'Reassigned to you.')
            }
          >
            Reassign to me
          </button>
          <button
            style={chipBtn}
            disabled={busy || node.kind === 'gate'}
            onClick={() => onCommit({ kind: 'gate' }, 'Converted to a gate.')}
          >
            Make it a gate
          </button>
        </div>
      </div>

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
