/**
 * Status-driven section block (ported from the prototype `SectionBlock`,
 * asset_14). Renders by `cfg.sectionMeta[name].status` (handoff Q-ED-9):
 *
 *   done / review  → rich-text body + actions (Regenerate / Mark reviewed);
 *                    "Needs review" notable pill when review.
 *   smart          → BudgetBlock + "Auto-populated" info pill + actions.
 *   tailored       → tailored paragraph (per-office) + actions.
 *   draft          → rich-text body + actions.
 *   empty          → empty-state with "Draft with Meri" (calls onGenerate,
 *                    which writes content + sets status=review).
 *
 * Drag-to-reorder, contentEditable <h3> rename, and trash-remove are wired to
 * the parent. The Meri-drafting placeholder shows while a generation is in
 * flight. Meri output stays attributable (accent + Sparkles label on the
 * empty-state and during drafting).
 */
import type { DragEvent } from 'react';
import type { WsAsk } from '../types.js';
import { Icon } from '../kit.js';
import { BudgetBlock, type BudgetIdentifiers } from './BudgetBlock.js';
import { SectionRichText } from './rich-text.js';
import { anonText } from './anonymize.js';
import type { SectionView } from './section-model.js';

function SectionActions({
  onRegenerate,
  onMarkReviewed,
}: {
  onRegenerate: () => void;
  onMarkReviewed: () => void;
}) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      <button
        className="btn sm btn-ghost"
        style={{ color: 'var(--accent)' }}
        onClick={onRegenerate}
      >
        <Icon name="RefreshCw" size={12} />
        Regenerate
      </button>
      <button
        className="btn sm btn-ghost"
        style={{ color: 'var(--ink-2)' }}
        onClick={onMarkReviewed}
      >
        <Icon name="Check" size={12} />
        Mark reviewed
      </button>
    </div>
  );
}

export function SectionBlock({
  section,
  index,
  anonymizeOn,
  anonMap,
  ask,
  budget,
  drafting,
  readOnly,
  isDragOver,
  isDragging,
  onRename,
  onRemove,
  onChangeBody,
  onAsk,
  onGenerate,
  onRegenerate,
  onMarkReviewed,
  onToast,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  section: SectionView;
  index: number;
  anonymizeOn: boolean;
  anonMap: Array<[RegExp, string]>;
  ask: WsAsk;
  budget?: BudgetIdentifiers;
  /** True while a Meri generation for THIS section is in flight. */
  drafting: boolean;
  /** View-only (someone else holds the edit lock). */
  readOnly?: boolean;
  isDragOver: boolean;
  isDragging: boolean;
  onRename: (index: number, name: string) => void;
  onRemove: () => void;
  onChangeBody: (html: string) => void;
  onAsk: (key: keyof WsAsk, value: string) => void;
  onGenerate: () => void;
  onRegenerate: () => void;
  onMarkReviewed: () => void;
  onToast: (msg: string) => void;
  onDragStart: () => void;
  onDragOver: (e: DragEvent) => void;
  onDrop: () => void;
  onDragEnd: () => void;
}) {
  const { name, status, smart, tailor, content } = section;
  const hasBody = !!content.trim();
  // Render exactly one body variant. Priority: smart → drafting → tailor →
  // prose (has body or a prose status) → empty.
  const showProse =
    !smart &&
    !tailor &&
    !drafting &&
    (hasBody || status === 'done' || status === 'review' || status === 'draft');
  const showEmpty = !smart && !tailor && !drafting && !showProse && !hasBody;

  return (
    <div
      // E-18: stable per-section anchor (present for ALL states incl. empty) so
      // the checks "Fix" action can scroll to + reveal a section that has no body.
      data-ws-section-block={name}
      tabIndex={-1}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      style={{
        marginBottom: 20,
        paddingBottom: 16,
        borderTop: isDragOver ? '2px solid var(--accent)' : '2px solid transparent',
        borderBottom: '1px solid var(--border-1)',
        opacity: isDragging ? 0.45 : 1,
        transition: 'border-color 0.1s, opacity 0.15s',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span
          title="Drag to reorder"
          style={{
            color: 'var(--ink-4)',
            cursor: 'grab',
            display: 'grid',
            placeItems: 'center',
            flex: 'none',
          }}
        >
          <Icon name="GripVertical" size={14} />
        </span>
        <h3
          contentEditable={!readOnly}
          suppressContentEditableWarning
          spellCheck={false}
          onBlur={(e) => {
            if (readOnly) return;
            onRename(index, e.currentTarget.textContent ?? name);
          }}
          onFocus={(e) => (e.currentTarget.style.boxShadow = '0 0 0 3px var(--accent-glow)')}
          onBlurCapture={(e) => (e.currentTarget.style.boxShadow = 'none')}
          style={{
            margin: 0,
            fontSize: 15,
            fontWeight: 700,
            lineHeight: 1.25,
            outline: 'none',
            borderRadius: 4,
          }}
        >
          {name}
        </h3>
        {status === 'review' && <span className="pill notable">Needs review</span>}
        {/* A failed regeneration keeps the OLD text. Label it so the reader never
            mistakes retained content for what Meri just produced. */}
        {section.stale && (
          <span className="pill critical" title={section.staleReason}>
            <Icon name="AlertTriangle" size={10} />
            Not regenerated
          </span>
        )}
        {smart && (
          <span className="pill info">
            <Icon name="Sparkles" size={10} />
            Auto-populated
          </span>
        )}
        <div style={{ flex: 1 }} />
        <button
          onClick={onRemove}
          title="Remove section"
          style={{
            border: 'none',
            background: 'none',
            cursor: 'pointer',
            color: 'var(--ink-4)',
            display: 'grid',
            placeItems: 'center',
            padding: 2,
          }}
        >
          <Icon name="Trash2" size={13} />
        </button>
      </div>

      {/* Smart / budget section. */}
      {smart && (
        <>
          <BudgetBlock ask={ask} budget={budget} onAsk={onAsk} onToast={onToast} />
          <SectionActions onRegenerate={onRegenerate} onMarkReviewed={onMarkReviewed} />
        </>
      )}

      {/* Meri drafting placeholder (generation in flight). */}
      {drafting && (
        <div
          className="card"
          style={{
            padding: 13,
            background: 'var(--accent-soft)',
            border: '1px dashed var(--accent)',
            boxShadow: 'none',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              color: 'var(--accent-ink)',
              fontWeight: 600,
              fontSize: 12.5,
              marginBottom: 9,
            }}
          >
            <Icon name="Sparkles" size={14} />
            Meri is drafting from your context…
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {[92, 100, 64].map((w, i) => (
              <div
                key={i}
                className="ws-skeleton-bar"
                style={{
                  height: 8,
                  width: w + '%',
                  borderRadius: 5,
                }}
              />
            ))}
          </div>
        </div>
      )}

      {/* Tailored (per-office) section. */}
      {tailor && !drafting && (
        <>
          {hasBody ? (
            <SectionRichText
              value={anonymizeOn ? anonText(content, true, anonMap) : content}
              onChange={onChangeBody}
              dataSection={name}
              readOnly={readOnly}
              aria-label={`${name} body`}
              style={{
                fontSize: 13,
                lineHeight: 1.58,
                color: 'var(--ink-1)',
                margin: '0 0 10px',
                outline: 'none',
              }}
            />
          ) : (
            <p
              style={{ fontSize: 13, lineHeight: 1.58, color: 'var(--ink-1)', margin: '0 0 10px' }}
            >
              This section is tailored per submission target. Switch offices above, or let Meri
              draft a district-specific impact paragraph.
            </p>
          )}
          <SectionActions onRegenerate={onRegenerate} onMarkReviewed={onMarkReviewed} />
        </>
      )}

      {/* Prose section with a body. */}
      {showProse && (
        <>
          <SectionRichText
            value={anonymizeOn ? anonText(content, true, anonMap) : content}
            onChange={onChangeBody}
            dataSection={name}
            readOnly={readOnly}
            aria-label={`${name} body`}
            placeholder="Write here…"
            style={{
              fontSize: 13,
              lineHeight: 1.58,
              color: 'var(--ink-1)',
              margin: '0 0 10px',
              outline: 'none',
            }}
          />
          <SectionActions onRegenerate={onRegenerate} onMarkReviewed={onMarkReviewed} />
        </>
      )}

      {/* Empty section — write here or let Meri draft it. */}
      {showEmpty && (
        <div
          className="card"
          style={{
            padding: 13,
            background: 'var(--bg-surface-2)',
            boxShadow: 'none',
            border: '1px dashed var(--border-1)',
          }}
        >
          <div style={{ fontSize: 12.5, color: 'var(--ink-3)', marginBottom: 9 }}>
            Empty section. Write here, or let Meri draft it from your context.
          </div>
          <button className="btn sm btn-accent" onClick={onGenerate}>
            <Icon name="Sparkles" size={12} />
            Draft with Meri
          </button>
        </div>
      )}
    </div>
  );
}
