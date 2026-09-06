import { useCallback, useEffect, useRef, useState } from 'react';
import {
  MERI_REASONING_MODES,
  useMeriReasoningMode,
  type MeriReasoningMode,
} from './meri-reasoning-state.js';
import { MeriIcon } from './meri-icons.js';

/**
 * Reasoning Depth — the durable per-thread setting in the conversation header.
 *
 * Descriptions are verbatim from the v4 handoff (README §3 `MeriDepthPicker`);
 * they are product copy and must not be reworded. Note this is deliberately a
 * different concept from the composer's Task Mode (README §Task Mode vs
 * Reasoning Depth): depth is durable and per-thread, task mode is per-message.
 */
export {
  MERI_REASONING_MODES,
  applyReasoningModeToConversation,
  isMeriReasoningMode,
  readDraftReasoningMode,
  writeDraftReasoningMode,
} from './meri-reasoning-state.js';
export type { MeriReasoningMode } from './meri-reasoning-state.js';

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
  const { mode, saving, error, chooseMode: saveMode } = useMeriReasoningMode(conversationId);
  const [open, setOpen] = useState(false);
  const controlRef = useRef<HTMLDivElement>(null);
  const onModeChangeRef = useRef(onModeChange);
  onModeChangeRef.current = onModeChange;

  useEffect(() => {
    setOpen(false);
  }, [conversationId]);
  useEffect(() => {
    onModeChangeRef.current?.(mode);
  }, [mode]);

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
    (next: MeriReasoningMode) => {
      setOpen(false);
      void saveMode(next);
    },
    [saveMode],
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
