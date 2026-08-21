import type { MeriLearnedMemory } from '../../components/chat/MeriMemoryPanel.js';
import { MeriIcon } from './meri-icons.js';

/**
 * MeriMemoryCallout — inline callout naming a memory candidate awaiting the
 * operator's review.
 *
 * Scope note: nothing in the SSE stream or the message payload links a
 * specific answer to the memory it used, so this cannot say "this answer
 * used memory X" the way the v4 spec's screen-D fixture implies. What is
 * real is `controller.learnedMemories`' pending_review state — a candidate
 * Meri wants to remember but hasn't yet, surfaced here rather than only in
 * the rail's Memory tab, since a pending candidate is exactly the kind of
 * thing worth surfacing where the user is already looking.
 */

const MONO = "var(--meri-font-mono, 'IBM Plex Mono', monospace)";

interface MeriMemoryCalloutProps {
  memories: MeriLearnedMemory[];
  onOpenMemory: () => void;
}

export function MeriMemoryCallout({ memories, onOpenMemory }: MeriMemoryCalloutProps) {
  const pending = memories.filter((memory) => memory.state === 'pending_review');
  if (pending.length === 0) return null;
  const first = pending[0]!;

  return (
    <div
      style={{
        margin: '0 18px 16px',
        padding: '13px 15px',
        borderRadius: 10,
        background: '#FAF9F6',
        border: '1px solid #E8E5DF',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <MeriIcon name="Lightbulb02" size={14} color="#101828" />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontFamily: MONO,
            fontSize: 9.5,
            fontWeight: 500,
            letterSpacing: '.08em',
            color: '#667085',
          }}
        >
          {pending.length === 1 ? 'MERI WANTS TO REMEMBER SOMETHING' : `MERI WANTS TO REMEMBER ${pending.length} THINGS`}
        </span>
      </div>
      <div style={{ marginTop: 8, fontSize: 13, lineHeight: '20px', color: '#344054' }}>
        {first.value}
        {pending.length > 1 ? ` — and ${pending.length - 1} more.` : ''}
      </div>
      <button
        type="button"
        onClick={onOpenMemory}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 7,
          height: 28,
          marginTop: 10,
          padding: '0 10px',
          borderRadius: 7,
          border: '1px solid #E0DCD4',
          background: '#ffffff',
          fontSize: 12.5,
          fontWeight: 600,
          color: '#344054',
          cursor: 'pointer',
        }}
      >
        Review in Memory
        <MeriIcon name="ChevronRight" size={13} color="#98A2B3" />
      </button>
    </div>
  );
}
