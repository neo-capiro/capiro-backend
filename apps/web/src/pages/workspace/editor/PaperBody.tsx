/**
 * Main-document paper body (ported from the prototype `PaperBody`, asset_14).
 * Editable doc title, the budget-identifier meta line, the status-driven
 * SectionBlocks (with drag-to-reorder), and any inserted media blocks.
 *
 * Section ordering, rename, remove, and reorder mutate `cfg.sections`. Body text
 * mutates `cfg.sectionContent`; status changes mutate `cfg.sectionMeta`. The
 * parent owns the config + autosave.
 */
import { useState, type DragEvent } from 'react';
import type { WsAsk, WsBlock } from '../types.js';
import type { BudgetIdentifiers } from './BudgetBlock.js';
import { SectionBlock } from './SectionBlock.js';
import { InsertedBlock } from './canvas-blocks.js';
import { anonText } from './anonymize.js';
import type { SectionView } from './section-model.js';

export function PaperBody({
  docTitle,
  sections,
  blocks,
  ask,
  budget,
  anonymizeOn,
  anonMap,
  metaLine,
  draftingSection,
  onTitle,
  onReorder,
  onRenameSection,
  onRemoveSection,
  onChangeBody,
  onAsk,
  onGenerate,
  onRegenerate,
  onMarkReviewed,
  onRemoveBlock,
  onToast,
  readOnly,
}: {
  docTitle: string;
  sections: SectionView[];
  blocks: WsBlock[];
  ask: WsAsk;
  budget?: BudgetIdentifiers;
  anonymizeOn: boolean;
  anonMap: Array<[RegExp, string]>;
  metaLine: string;
  /** Name of the section currently being generated, if any. */
  draftingSection: string | null;
  /** View-only (someone else holds the edit lock). */
  readOnly?: boolean;
  onTitle: (title: string) => void;
  onReorder: (from: number, to: number) => void;
  onRenameSection: (index: number, name: string) => void;
  onRemoveSection: (name: string) => void;
  onChangeBody: (name: string, html: string) => void;
  onAsk: (key: keyof WsAsk, value: string) => void;
  onGenerate: (name: string) => void;
  onRegenerate: (name: string) => void;
  onMarkReviewed: (name: string) => void;
  onRemoveBlock: (id: string) => void;
  onToast: (msg: string) => void;
}) {
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  const onDrop = (i: number) => {
    if (dragIdx === null || dragIdx === i) {
      setDragIdx(null);
      setDragOver(null);
      return;
    }
    onReorder(dragIdx, i);
    setDragIdx(null);
    setDragOver(null);
  };

  return (
    <>
      <h1
        contentEditable={!readOnly}
        suppressContentEditableWarning
        spellCheck={false}
        onBlur={(e) => {
          if (readOnly) return;
          const v = e.currentTarget.textContent?.trim();
          if (v && v !== docTitle) onTitle(v);
        }}
        onFocus={(e) => (e.currentTarget.style.boxShadow = '0 0 0 3px var(--accent-glow)')}
        onBlurCapture={(e) => (e.currentTarget.style.boxShadow = 'none')}
        style={{
          fontFamily: 'var(--font-serif)',
          fontWeight: 500,
          fontSize: 23,
          letterSpacing: '-0.01em',
          margin: '0 0 9px',
          lineHeight: 1.14,
          outline: 'none',
          borderRadius: 4,
        }}
      >
        {anonymizeOn ? anonText(docTitle, true, anonMap) : docTitle}
      </h1>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 9.5,
          color: 'var(--ink-3)',
          marginBottom: 20,
        }}
      >
        {anonymizeOn ? anonText(metaLine, true, anonMap) : metaLine}
      </div>

      {sections.map((s, i) => (
        <SectionBlock
          key={s.name + i}
          section={s}
          index={i}
          anonymizeOn={anonymizeOn}
          anonMap={anonMap}
          ask={ask}
          budget={budget}
          readOnly={readOnly}
          drafting={draftingSection === s.name}
          isDragOver={dragOver === i}
          isDragging={dragIdx === i}
          onRename={onRenameSection}
          onRemove={() => onRemoveSection(s.name)}
          onChangeBody={(html) => onChangeBody(s.name, html)}
          onAsk={onAsk}
          onGenerate={() => onGenerate(s.name)}
          onRegenerate={() => onRegenerate(s.name)}
          onMarkReviewed={() => onMarkReviewed(s.name)}
          onToast={onToast}
          onDragStart={() => setDragIdx(i)}
          onDragOver={(e: DragEvent) => {
            e.preventDefault();
            setDragOver(i);
          }}
          onDrop={() => onDrop(i)}
          onDragEnd={() => {
            setDragIdx(null);
            setDragOver(null);
          }}
        />
      ))}

      {blocks.map((b) => (
        <InsertedBlock
          key={b.id}
          kind={b.type}
          variant={b.variant as string | undefined}
          onRemove={() => onRemoveBlock(b.id)}
        />
      ))}
    </>
  );
}
