import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi } from '../../lib/use-api.js';
import { MeriIcon } from './meri-icons.js';

/**
 * Reasoning Depth — the durable per-thread setting in the conversation header.
 *
 * Descriptions are verbatim from the v4 handoff (README §3 `MeriDepthPicker`);
 * they are product copy and must not be reworded. Note this is deliberately a
 * different concept from the composer's Task Mode (README §Task Mode vs
 * Reasoning Depth): depth is durable and per-thread, task mode is per-message.
 */
export const MERI_REASONING_MODES = [
  {
    mode: 'fast',
    label: 'Fast',
    description: 'Quick answers and direct lookups.',
  },
  {
    mode: 'standard',
    label: 'Standard',
    description: 'Balanced everyday reasoning.',
  },
  {
    mode: 'deep',
    label: 'Deep',
    description: 'More investigation for strategic work.',
  },
  {
    mode: 'max',
    label: 'Max',
    description: 'Highest configured reasoning tier.',
  },
] as const;

export type MeriReasoningMode = (typeof MERI_REASONING_MODES)[number]['mode'];

const DRAFT_REASONING_MODE_KEY = 'meri.vnext.draftReasoningMode';

export function isMeriReasoningMode(value: unknown): value is MeriReasoningMode {
  return MERI_REASONING_MODES.some((option) => option.mode === value);
}

export function readDraftReasoningMode(): MeriReasoningMode {
  try {
    const raw = window.sessionStorage.getItem(DRAFT_REASONING_MODE_KEY);
    if (isMeriReasoningMode(raw)) return raw;
  } catch {
    // sessionStorage can throw in private mode; fall through to default.
  }
  return 'standard';
}

export function writeDraftReasoningMode(mode: MeriReasoningMode): void {
  try {
    window.sessionStorage.setItem(DRAFT_REASONING_MODE_KEY, mode);
  } catch {
    // Best-effort only — the in-memory control state still works for this page.
  }
}

export async function applyReasoningModeToConversation(
  api: { patch: (url: string, body: unknown) => Promise<unknown> },
  conversationId: string,
  mode: MeriReasoningMode,
): Promise<void> {
  if (!conversationId || mode === 'standard') return;
  await api.patch(`/api/clio/v3/conversations/${encodeURIComponent(conversationId)}/reasoning-mode`, {
    reasoningMode: mode,
  });
}

interface VNextMeriReasoningControlProps {
  /**
   * When set, load/save against that conversation.
   * When omitted (new-thread landing), keep a draft choice and apply it once
   * the first durable conversation is created.
   */
  conversationId?: string | null;
  /** Optional external notification when the user picks a mode. */
  onModeChange?: (mode: MeriReasoningMode) => void;
  className?: string;
}

export function VNextMeriReasoningControl({
  conversationId = null,
  onModeChange,
  className,
}: VNextMeriReasoningControlProps) {
  const api = useApi();
  const [mode, setMode] = useState<MeriReasoningMode>(() =>
    conversationId ? 'standard' : readDraftReasoningMode(),
  );
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controlRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setOpen(false);
    setSaving(false);
    setError(null);

    if (!conversationId) {
      const draft = readDraftReasoningMode();
      setMode(draft);
      onModeChange?.(draft);
      return () => {
        cancelled = true;
      };
    }

    setMode('standard');
    void api
      .get<{ reasoningMode?: unknown }>(
        `/api/clio/v3/conversations/${encodeURIComponent(conversationId)}/reasoning-mode`,
      )
      .then(({ data }) => {
        if (!cancelled && isMeriReasoningMode(data.reasoningMode)) {
          setMode(data.reasoningMode);
          onModeChange?.(data.reasoningMode);
        }
      })
      .catch(() => {
        // Standard is the established safe default when the saved preference
        // cannot be read. A later choice remains explicit and is persisted.
      });

    return () => {
      cancelled = true;
    };
    // onModeChange is intentionally excluded — parents pass inline lambdas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, conversationId]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!controlRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const chooseMode = useCallback(
    async (next: MeriReasoningMode) => {
      if (saving || next === mode) {
        setOpen(false);
        return;
      }
      const previous = mode;
      setMode(next);
      setSaving(true);
      setError(null);
      setOpen(false);

      if (!conversationId) {
        writeDraftReasoningMode(next);
        onModeChange?.(next);
        setSaving(false);
        return;
      }

      try {
        await api.patch(
          `/api/clio/v3/conversations/${encodeURIComponent(conversationId)}/reasoning-mode`,
          { reasoningMode: next },
        );
        onModeChange?.(next);
      } catch {
        setMode(previous);
        setError('The reasoning mode could not be saved.');
      } finally {
        setSaving(false);
      }
    },
    [api, conversationId, mode, onModeChange, saving],
  );

  const selected =
    MERI_REASONING_MODES.find((option) => option.mode === mode) ?? MERI_REASONING_MODES[1];
  const rootClass = ['vnext-meri__reasoning-chip', className].filter(Boolean).join(' ');

  return (
    <div className={rootClass} ref={controlRef}>
      <button
        type="button"
        className="vnext-meri__reasoning-trigger"
        disabled={saving}
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Reasoning depth: ${selected.label}`}
      >
        <MeriIcon name="Speedometer03" size={12} color="#667085" />
        <span className="vnext-meri__reasoning-label">DEPTH · {selected.label.toUpperCase()}</span>
        <MeriIcon name="ChevronDown" size={12} color="#98A2B3" />
      </button>
      {open ? (
        <div className="vnext-meri__reasoning-menu" role="menu" aria-label="Reasoning depth">
          <div className="vnext-meri__reasoning-menu-eyebrow">
            {conversationId ? 'REASONING DEPTH · THIS THREAD' : 'REASONING DEPTH · THIS NEW THREAD'}
          </div>
          {MERI_REASONING_MODES.map((option) => (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={option.mode === mode}
              key={option.mode}
              className={`vnext-meri__reasoning-menu-item${option.mode === mode ? ' is-selected' : ''}`}
              disabled={saving}
              onClick={() => void chooseMode(option.mode)}
            >
              <span className="vnext-meri__reasoning-menu-item-body">
                <strong className="vnext-meri__reasoning-menu-item-label">{option.label}</strong>
                <span className="vnext-meri__reasoning-menu-item-desc">{option.description}</span>
              </span>
              <span className="vnext-meri__reasoning-menu-item-check" aria-hidden="true">
                {option.mode === mode ? <MeriIcon name="Check" size={14} color="#101828" /> : null}
              </span>
            </button>
          ))}
          {!conversationId ? (
            <div className="vnext-meri__reasoning-menu-footnote">
              Applied when you send the first message
            </div>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <div className="vnext-meri__reasoning-error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}
