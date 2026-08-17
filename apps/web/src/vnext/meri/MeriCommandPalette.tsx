import { useEffect, useMemo, useRef, useState } from 'react';
import type { MeriChatController } from '../../components/chat/useMeriChatController.js';
import { useCapiroToast } from '../components/feedback/toast.js';
import { MeriIcon, type MeriIconName } from './meri-icons.js';

/**
 * MeriCommandPalette — full-surface ⌘K palette (threads, messages, context,
 * sources and actions). Pixel-parity port of the design prototype's
 * `paletteOpen` overlay.
 *
 * BACKEND GAP: there is no cross-workspace search endpoint today. Results are
 * prototype fixtures; row actions close the palette and toast the intent.
 * Tracked in GAPS.md (Meri vNext — command palette search).
 */

const MONO = "var(--meri-font-mono, 'IBM Plex Mono', monospace)";

type PaletteResultKind = 'THREAD' | 'MESSAGE' | 'SOURCE' | 'SKILL' | 'CLIENT';

interface PaletteResult {
  key: number;
  icon: MeriIconName;
  title: string;
  sub: string;
  kind: PaletteResultKind;
}

const PALETTE_RESULTS: PaletteResult[] = [
  {
    key: 1,
    icon: 'MessageTextSquare01',
    title: 'FY27 rotorcraft position after the HASC mark',
    sub: 'Lockheed Martin · 4 messages',
    kind: 'THREAD',
  },
  {
    key: 2,
    icon: 'SearchLg',
    title: '“engine qualification schedule”',
    sub: 'Found in 3 messages across 2 threads',
    kind: 'MESSAGE',
  },
  {
    key: 3,
    icon: 'File05',
    title: 'HASC FY27 committee report',
    sub: 'Capiro intelligence · last verified Aug 14',
    kind: 'SOURCE',
  },
  {
    key: 4,
    icon: 'Stars02',
    title: 'Run Portfolio Changes',
    sub: 'Skill · all clients',
    kind: 'SKILL',
  },
  {
    key: 5,
    icon: 'Building01',
    title: 'Shield AI',
    sub: 'Client workspace · 18 records',
    kind: 'CLIENT',
  },
  {
    key: 6,
    icon: 'ClockFastForward',
    title: 'What changed for Lockheed Martin this week',
    sub: 'Lockheed Martin · 8:05 AM',
    kind: 'THREAD',
  },
];

interface MeriCommandPaletteProps {
  controller: MeriChatController;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Optional navigation hooks — wired by the shell once routes exist. */
  onOpenSource?: () => void;
  onOpenThread?: (conversationId: string) => void;
  onRunSkill?: (skillLabel: string) => void;
}

export function MeriCommandPalette({
  controller,
  open,
  onOpenChange,
  onOpenSource,
  onOpenThread,
  onRunSkill,
}: MeriCommandPaletteProps) {
  const toast = useCapiroToast();
  const [query, setQuery] = useState('');
  const [hoveredKey, setHoveredKey] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // ⌘K / Ctrl+K opens; Escape closes. Registered for the whole workspace while
  // the palette is mounted.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        onOpenChange(!open);
        return;
      }
      if (event.key === 'Escape' && open) {
        event.preventDefault();
        onOpenChange(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onOpenChange]);

  // Autofocus + reset the query each time the palette opens.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setHoveredKey(null);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return PALETTE_RESULTS;
    return PALETTE_RESULTS.filter(
      (result) =>
        result.title.toLowerCase().includes(q) ||
        result.sub.toLowerCase().includes(q) ||
        result.kind.toLowerCase().includes(q),
    );
  }, [query]);

  if (!open) return null;

  const pick = (result: PaletteResult) => {
    onOpenChange(false);
    if (result.kind === 'SOURCE') {
      onOpenSource?.();
      return;
    }
    if (result.kind === 'THREAD') {
      // BACKEND GAP: no thread-search endpoint — the shell passes onOpenThread
      // once conversation routing lands.
      onOpenThread?.(String(result.key));
      if (!onOpenThread) toast.success('Opening the thread.');
      return;
    }
    if (result.kind === 'SKILL') {
      onRunSkill?.(result.title);
      return;
    }
    toast.success(`Opening ${result.title}.`);
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(12,17,29,.55)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: 96,
        zIndex: 80,
        animation: 'vnext-meri-rise .12s ease',
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onOpenChange(false);
      }}
    >
      <div
        role="dialog"
        aria-label="Command palette"
        style={{
          width: 640,
          maxWidth: 'calc(100% - 48px)',
          borderRadius: 14,
          background: '#ffffff',
          boxShadow: '0px 24px 48px -12px rgba(16,24,40,.3)',
          overflow: 'hidden',
          animation: 'vnext-meri-rise .16s ease',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 11,
            padding: '14px 16px',
            borderBottom: '1px solid #EAECF0',
          }}
        >
          <MeriIcon name="SearchLg" size={17} color="#98A2B3" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search threads, messages, context, sources and actions…"
            aria-label="Search threads, messages, context, sources and actions"
            style={{
              flex: 1,
              minWidth: 0,
              background: 'none',
              border: 0,
              outline: 'none',
              fontSize: 15,
              color: '#101828',
            }}
          />
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            style={{
              fontFamily: MONO,
              fontSize: 10,
              fontWeight: 500,
              letterSpacing: '.09em',
              color: '#667085',
            }}
          >
            ESC
          </button>
        </div>
        <div style={{ maxHeight: 400, overflowY: 'auto', padding: 8 }}>
          {results.map((result) => (
            <button
              type="button"
              key={result.key}
              onClick={() => pick(result)}
              onMouseEnter={() => setHoveredKey(result.key)}
              onMouseLeave={() => setHoveredKey(null)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 11,
                width: '100%',
                padding: '10px 12px',
                borderRadius: 8,
                background: hoveredKey === result.key ? '#F9FAFB' : 'transparent',
              }}
            >
              <span
                style={{
                  flex: '0 0 auto',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 26,
                  height: 26,
                  borderRadius: 7,
                  background: '#F2F4F7',
                }}
              >
                <MeriIcon name={result.icon} size={13} color="#101828" />
              </span>
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                }}
              >
                <span
                  style={{
                    fontSize: 13.5,
                    lineHeight: '19px',
                    color: '#101828',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {result.title}
                </span>
                <span
                  style={{
                    fontSize: 12,
                    lineHeight: '17px',
                    color: '#667085',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {result.sub}
                </span>
              </span>
              <span
                style={{
                  flex: '0 0 auto',
                  fontFamily: MONO,
                  fontSize: 9,
                  fontWeight: 500,
                  letterSpacing: '.08em',
                  color: '#667085',
                }}
              >
                {result.kind}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
