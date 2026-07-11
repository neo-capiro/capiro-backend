import { useEffect, useState } from 'react';
import { BulbOutlined, DownOutlined } from '@ant-design/icons';

export interface MeriLearnedMemory {
  id: string;
  key: string;
  value: string;
  scope: string;
}

export function MeriMemoryPanel({
  memories,
  forgotten,
  expanded,
  onExpandedChange,
  onSave,
  onForget,
  onUndo,
}: {
  memories: MeriLearnedMemory[];
  forgotten: MeriLearnedMemory[];
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onSave: (id: string, value: string) => void;
  onForget: (id: string) => void;
  onUndo: (id: string) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    if (editingId && !memories.some((memory) => memory.id === editingId)) setEditingId(null);
  }, [editingId, memories]);

  const startEdit = (memory: MeriLearnedMemory) => {
    setEditingId(memory.id);
    setDraft(memory.value);
  };
  const commit = () => {
    if (!editingId) return;
    const value = draft.trim();
    if (value) onSave(editingId, value);
    setEditingId(null);
  };

  if (memories.length === 0 && forgotten.length === 0) return null;

  return (
    <section className="meri-memory" aria-label="Things Meri learned">
      <button
        type="button"
        className={`meri-memory-header${expanded ? '' : ' is-collapsed'}`}
        onClick={() => onExpandedChange(!expanded)}
        aria-expanded={expanded}
      >
        <BulbOutlined aria-hidden="true" />
        <span>Meri learned</span>
        <span className="meri-memory-count">{memories.length}</span>
        <DownOutlined className="meri-memory-chevron" aria-hidden="true" />
      </button>
      {expanded && (
        <div className="meri-memory-list">
          {memories.map((memory) => (
            <div className="meri-memory-item" key={memory.id}>
              <span className="meri-memory-spark" aria-hidden="true">
                ✦
              </span>
              {editingId === memory.id ? (
                <input
                  autoFocus
                  className="meri-memory-edit"
                  value={draft}
                  aria-label="Edit memory"
                  onChange={(event) => setDraft(event.target.value)}
                  onBlur={commit}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') commit();
                    if (event.key === 'Escape') setEditingId(null);
                  }}
                />
              ) : (
                <span className="meri-memory-text" title={memory.value}>
                  <strong>Meri learned: </strong>
                  {memory.value}
                </span>
              )}
              {editingId !== memory.id && (
                <span className="meri-memory-actions">
                  <button type="button" onClick={() => startEdit(memory)}>
                    Edit
                  </button>
                  <button type="button" onClick={() => onForget(memory.id)}>
                    Forget
                  </button>
                </span>
              )}
            </div>
          ))}
          {memories.length === 0 && <p className="meri-memory-empty">No active memories.</p>}
        </div>
      )}
      {forgotten.map((memory) => (
        <div className="meri-memory-undo" role="status" key={memory.id}>
          <span>
            Forgot “{memory.value.length > 48 ? `${memory.value.slice(0, 45)}…` : memory.value}”
          </span>
          <button type="button" onClick={() => onUndo(memory.id)}>
            Undo
          </button>
        </div>
      ))}
    </section>
  );
}
