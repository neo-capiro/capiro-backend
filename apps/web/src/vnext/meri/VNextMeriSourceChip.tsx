import type { MeriCitation } from '../../components/chat/chat-store.js';
import { MeriIcon, type MeriIconName } from './meri-icons.js';

function sourceIcon(citation: MeriCitation): MeriIconName {
  const haystack = `${citation.type} ${citation.tool}`.toLowerCase();
  if (haystack.includes('file') || haystack.includes('document')) return 'File05';
  if (haystack.includes('search') || haystack.includes('web')) return 'SearchLg';
  if (haystack.includes('bill') || haystack.includes('congress')) return 'Scales01';
  return 'Link03';
}

export function VNextMeriSourceChip({
  citation,
  onOpen,
}: {
  citation: MeriCitation;
  onOpen?: (citation: MeriCitation) => void;
}) {
  const label = citation.title?.trim() || `Source ${citation.n}`;
  return (
    <button
      type="button"
      className="vnext-meri__source-chip"
      title={label}
      onClick={() => onOpen?.(citation)}
    >
      <MeriIcon name={sourceIcon(citation)} size={12} color="#101828" />
      <span className="vnext-meri__source-chip-label">{label}</span>
    </button>
  );
}
