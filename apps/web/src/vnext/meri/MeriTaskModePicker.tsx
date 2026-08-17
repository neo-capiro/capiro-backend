import type { MeriChatController } from '../../components/chat/useMeriChatController.js';
import { MeriIcon, type MeriIconName } from './meri-icons.js';

/**
 * MeriTaskModePicker — STANDARD / RESEARCH / WRITE segmented control from the
 * composer toolbar. Pixel-parity port of the prototype's `taskModes` group.
 *
 * The selection maps onto the controller's existing writeMode / researchMode
 * flags: STANDARD clears both, RESEARCH sets researchMode, WRITE sets
 * writeMode. An optional controlled override (value + onChange) lets the
 * prototype surface drive it without a live session.
 */

const MONO = "var(--meri-font-mono, 'IBM Plex Mono', monospace)";

export type MeriTaskMode = 'standard' | 'research' | 'write';

const TASK_MODES: Array<{ key: MeriTaskMode; label: string; icon: MeriIconName; desc: string }> = [
  { key: 'standard', label: 'STANDARD', icon: 'MessageTextSquare01', desc: 'Normal conversation and analysis.' },
  { key: 'research', label: 'RESEARCH', icon: 'SearchLg', desc: 'Cited deep research workflows.' },
  { key: 'write', label: 'WRITE', icon: 'Edit01', desc: 'Draft or update the current page or document.' },
];

interface MeriTaskModePickerProps {
  controller: MeriChatController;
  /** Controlled override. When provided, the controller flags are not read. */
  value?: MeriTaskMode;
  onChange?: (mode: MeriTaskMode) => void;
  disabled?: boolean;
}

export function MeriTaskModePicker({
  controller,
  value,
  onChange,
  disabled = false,
}: MeriTaskModePickerProps) {
  const controllerMode: MeriTaskMode = controller.writeMode
    ? 'write'
    : controller.researchMode
      ? 'research'
      : 'standard';
  const active = value ?? controllerMode;

  const pick = (mode: MeriTaskMode) => {
    if (disabled) return;
    onChange?.(mode);
    if (value === undefined) {
      controller.setWriteMode(mode === 'write');
      controller.setResearchMode(mode === 'research');
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label="Task mode"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 2,
        padding: 2,
        borderRadius: 9,
        background: '#F9FAFB',
        boxShadow: 'inset 0 0 0 1px #EAECF0',
      }}
    >
      {TASK_MODES.map((mode) => {
        const on = mode.key === active;
        return (
          <button
            type="button"
            key={mode.key}
            role="radio"
            aria-checked={on}
            title={mode.desc}
            disabled={disabled}
            onClick={() => pick(mode.key)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 24,
              padding: '0 9px',
              borderRadius: 7,
              background: on ? '#ffffff' : 'transparent',
              boxShadow: on
                ? 'inset 0 0 0 1px #D0D5DD,0px 1px 2px rgba(16,24,40,.05)'
                : 'none',
            }}
          >
            <MeriIcon name={mode.icon} size={12} color={on ? '#101828' : '#667085'} />
            <span
              style={{
                fontFamily: MONO,
                fontSize: 9.5,
                fontWeight: 500,
                letterSpacing: '.08em',
                color: on ? '#101828' : '#667085',
              }}
            >
              {mode.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
