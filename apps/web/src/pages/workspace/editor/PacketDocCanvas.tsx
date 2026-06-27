/**
 * Canvas for a non-main packet document (ported from the prototype
 * `BlankDocCanvas`, asset_14). Each packet doc persists to its own
 * `WsDocument.body` (Q-ED-7): `{ title, blocks: WsBlock[] }`. Section blocks
 * carry rich-text content; photo/table/logo blocks render placeholders.
 *
 * Insert actions append blocks to THIS document's body (the parent routes the
 * InsertRail to the active doc). State changes bubble up through onChange so the
 * editor's debounced autosave persists the body via useUpdateDocument.
 */
import type { WsBlock, WsLetterhead } from '../types.js';
import { Icon } from '../kit.js';
import { Letterhead, InsertedBlock } from './canvas-blocks.js';
import { SectionRichText } from './rich-text.js';

export interface PacketBody {
  title?: string;
  blocks: WsBlock[];
}

export function PacketDocCanvas({
  label,
  body,
  firmName,
  firmAddr,
  letterhead,
  onChange,
  onAskMeri,
  onToast,
  readOnly,
}: {
  label: string;
  body: PacketBody;
  firmName: string;
  firmAddr: string;
  letterhead?: WsLetterhead;
  onChange: (body: PacketBody) => void;
  onAskMeri: () => void;
  onToast: (msg: string) => void;
  /** View-only (someone else holds the edit lock). */
  readOnly?: boolean;
}) {
  const blocks = body.blocks ?? [];
  const title = body.title ?? label;
  const sections = blocks.filter((b) => b.type === 'section');
  const media = blocks.filter((b) => b.type !== 'section');

  const setBlock = (id: string, patch: Partial<WsBlock>) =>
    onChange({ ...body, blocks: blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)) });
  const removeBlock = (id: string) =>
    onChange({ ...body, blocks: blocks.filter((b) => b.id !== id) });

  return (
    <div
      className="card"
      style={{
        position: 'relative',
        maxWidth: 624,
        width: '100%',
        margin: '0 auto',
        padding: 0,
        overflow: 'hidden',
        borderTopLeftRadius: 0,
      }}
    >
      <Letterhead
        letterhead={letterhead}
        firmName={firmName}
        firmAddr={firmAddr}
        onToast={onToast}
      />
      <div style={{ padding: '20px 30px 30px', minHeight: 260 }}>
        <h1
          contentEditable={!readOnly}
          suppressContentEditableWarning
          spellCheck={false}
          onBlur={(e) => {
            if (readOnly) return;
            onChange({ ...body, title: e.currentTarget.textContent ?? label });
          }}
          style={{
            fontFamily: 'var(--font-serif)',
            fontWeight: 500,
            fontSize: 23,
            letterSpacing: '-0.01em',
            margin: '0 0 18px',
            lineHeight: 1.14,
            outline: 'none',
          }}
        >
          {title}
        </h1>

        {sections.length === 0 && media.length === 0 && (
          <div
            style={{
              textAlign: 'center',
              padding: '40px 20px',
              color: 'var(--ink-3)',
              borderRadius: 8,
              border: '1px dashed var(--border-1)',
              background: 'var(--bg-surface-2)',
            }}
          >
            <div style={{ fontSize: 28, marginBottom: 10 }}>
              <Icon name="FilePlus" size={28} style={{ color: 'var(--ink-4)' }} />
            </div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink-2)', marginBottom: 6 }}>
              Blank document
            </div>
            <div style={{ fontSize: 12, lineHeight: 1.55, maxWidth: 260, margin: '0 auto 14px' }}>
              Use the <b>Insert</b> panel to add sections, photos, or a table — or ask Meri to draft
              this document.
            </div>
            <button className="btn sm btn-accent" onClick={onAskMeri}>
              <Icon name="Sparkles" size={12} />
              Ask Meri to draft
            </button>
          </div>
        )}

        {sections.map((sec) => (
          <div
            key={sec.id}
            style={{
              marginBottom: 20,
              paddingBottom: 16,
              borderBottom: '1px solid var(--border-1)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <h3
                contentEditable={!readOnly}
                suppressContentEditableWarning
                spellCheck={false}
                onBlur={(e) => {
                  if (readOnly) return;
                  setBlock(sec.id, { title: e.currentTarget.textContent ?? sec.title });
                }}
                style={{ margin: 0, fontSize: 15, fontWeight: 700, outline: 'none', flex: 1 }}
              >
                {sec.title ?? 'New section'}
              </h3>
              <button
                onClick={() => removeBlock(sec.id)}
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
            <SectionRichText
              value={sec.content ?? ''}
              onChange={(html) => setBlock(sec.id, { content: html })}
              dataSection={sec.title ?? 'New section'}
              readOnly={readOnly}
              aria-label={`${sec.title ?? 'section'} body`}
              placeholder="Write here…"
              style={{
                fontSize: 13,
                lineHeight: 1.58,
                color: 'var(--ink-2)',
                outline: 'none',
                minHeight: 40,
              }}
            />
          </div>
        ))}

        {media.map((b) => (
          <InsertedBlock
            key={b.id}
            kind={b.type}
            variant={b.variant as string | undefined}
            onRemove={() => removeBlock(b.id)}
          />
        ))}
      </div>
    </div>
  );
}
