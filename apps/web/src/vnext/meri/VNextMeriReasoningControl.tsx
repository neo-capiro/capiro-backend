import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi } from '../../lib/use-api.js';
import { MeriIcon } from './meri-icons.js';

const REASONING_MODES = [
  { mode: 'fast', label: 'Fast', description: 'Quick answers and direct lookups.' },
  { mode: 'standard', label: 'Standard', description: 'Balanced everyday reasoning.' },
  { mode: 'deep', label: 'Deep', description: 'More investigation for strategic work.' },
  { mode: 'max', label: 'Max', description: 'Highest configured reasoning tier.' },
] as const;

type ReasoningMode = (typeof REASONING_MODES)[number]['mode'];

function isReasoningMode(value: unknown): value is ReasoningMode {
  return REASONING_MODES.some((option) => option.mode === value);
}

interface VNextMeriReasoningControlProps {
  conversationId: string;
}

export function VNextMeriReasoningControl({
  conversationId,
}: VNextMeriReasoningControlProps) {
  const api = useApi();
  const [mode, setMode] = useState<ReasoningMode>('standard');
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controlRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setOpen(false);
    setSaving(false);
    setError(null);
    setMode('standard');

    void api
      .get<{ reasoningMode?: unknown }>(
        `/api/clio/v3/conversations/${encodeURIComponent(conversationId)}/reasoning-mode`,
      )
      .then(({ data }) => {
        if (!cancelled && isReasoningMode(data.reasoningMode)) setMode(data.reasoningMode);
      })
      .catch(() => {
        // Standard is the established safe default when the saved preference
        // cannot be read. A later choice remains explicit and is persisted.
      });

    return () => {
      cancelled = true;
    };
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
    async (next: ReasoningMode) => {
      if (saving || next === mode) {
        setOpen(false);
        return;
      }
      const previous = mode;
      setMode(next);
      setSaving(true);
      setError(null);
      setOpen(false);
      try {
        await api.patch(`/api/clio/v3/conversations/${encodeURIComponent(conversationId)}/reasoning-mode`, {
          reasoningMode: next,
        });
      } catch {
        setMode(previous);
        setError('The reasoning mode could not be saved.');
      } finally {
        setSaving(false);
      }
    },
    [api, conversationId, mode, saving],
  );

  const selected = REASONING_MODES.find((option) => option.mode === mode) ?? REASONING_MODES[1];

  return (
    <div className="vnext-meri__reasoning-chip" ref={controlRef}>
      <button
        type="button"
        className="vnext-meri__reasoning-trigger"
        disabled={saving}
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Reasoning mode: ${selected.label}`}
      >
        <span className="vnext-meri__reasoning-label">MODE · {selected.label.toUpperCase()}</span>
        <MeriIcon name="ChevronDown" size={12} color="#98A2B3" />
      </button>
      {open ? (
        <div className="vnext-meri__reasoning-menu" role="menu" aria-label="Reasoning mode">
          {REASONING_MODES.map((option) => (
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
        </div>
      ) : null}
      {error ? <div className="vnext-meri__reasoning-error" role="alert">{error}</div> : null}
    </div>
  );
}
