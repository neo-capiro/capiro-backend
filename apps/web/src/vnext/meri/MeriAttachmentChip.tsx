import type { MeriChatController } from '../../components/chat/useMeriChatController.js';
import { MeriIcon, type MeriIconName } from './meri-icons.js';

/**
 * MeriAttachmentChip — staged-attachment chip in its nine display states.
 * Pixel-parity port of the prototype's `attachStates` gallery (screen Q),
 * plus the many-attachments advisory.
 *
 * The composer's live staged attachments (controller.stagedAttachments) map
 * onto a subset of these states; the full set is exported as
 * MERI_ATTACHMENT_STATES for the state gallery.
 */

const MONO = "var(--meri-font-mono, 'IBM Plex Mono', monospace)";

export type MeriAttachmentStateKey =
  | 'uploading'
  | 'ready'
  | 'parsed_pages'
  | 'parsed_rows'
  | 'image_ready'
  | 'truncated'
  | 'scanned'
  | 'unsupported'
  | 'failed';

export interface MeriAttachmentChipSpec {
  name: string;
  state: string;
  icon: MeriIconName;
  ring: string;
  fg: string;
}

/** Prototype fixture — screen Q, nine states. */
export const MERI_ATTACHMENT_STATES: MeriAttachmentChipSpec[] = [
  { name: 'FY27-position.pdf', state: 'UPLOADING · 62%', icon: 'UploadCloud02', ring: '#D0D5DD', fg: '#667085' },
  { name: 'HASC-report.pdf', state: 'READY', icon: 'File05', ring: '#ABEFC6', fg: '#027A48' },
  { name: 'client-brief.docx', state: 'PARSED · 14 PAGES', icon: 'File04', ring: '#ABEFC6', fg: '#027A48' },
  { name: 'exposure.csv', state: 'PARSED · 412 ROWS', icon: 'Rows03', ring: '#ABEFC6', fg: '#027A48' },
  { name: 'mark-table.png', state: 'IMAGE READY', icon: 'Eye', ring: '#ABEFC6', fg: '#027A48' },
  { name: 'appendix.pdf', state: 'TRUNCATED · 40 OF 210 PAGES READ', icon: 'AlertTriangle', ring: '#FEDF89', fg: '#B54708' },
  { name: 'scan-1994.pdf', state: 'SCANNED · NO READABLE TEXT', icon: 'EyeOff', ring: '#FEDF89', fg: '#B54708' },
  { name: 'model.xlsm', state: 'UNSUPPORTED TYPE', icon: 'SlashCircle01', ring: '#FECDCA', fg: '#B42318' },
  { name: 'notes.pdf', state: 'FAILED · RETRY', icon: 'XCircle', ring: '#FECDCA', fg: '#B42318' },
];

interface MeriAttachmentChipProps {
  /** Reserved for wiring to live staged attachments. */
  controller?: MeriChatController;
  name: string;
  state: string;
  icon: MeriIconName;
  ring: string;
  fg: string;
  onRemove?: () => void;
}

export function MeriAttachmentChip({ name, state, icon, ring, fg, onRemove }: MeriAttachmentChipProps) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 9,
        height: 34,
        padding: '0 12px',
        borderRadius: 9,
        background: '#ffffff',
        boxShadow: `inset 0 0 0 1px ${ring}`,
      }}
    >
      <MeriIcon name={icon} size={14} color={fg} />
      <span style={{ fontSize: 12.5, fontWeight: 500, color: '#101828' }}>{name}</span>
      <span
        style={{
          fontFamily: MONO,
          fontSize: 9,
          fontWeight: 500,
          letterSpacing: '.07em',
          color: fg,
        }}
      >
        {state}
      </span>
      <button
        type="button"
        aria-label={`Remove ${name}`}
        onClick={() => onRemove?.()}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 18,
          height: 18,
          borderRadius: 5,
          color: '#98A2B3',
        }}
      >
        <MeriIcon name="XClose" size={11} />
      </button>
    </span>
  );
}

/**
 * MeriAttachmentManyAdvisory — warning shown when a thread accumulates many
 * files. Meri reads the most relevant first and says which ones it used.
 */
export function MeriAttachmentManyAdvisory({ count }: { count: number }) {
  return (
    <div
      role="status"
      style={{
        marginTop: 11,
        padding: '11px 13px',
        borderRadius: 9,
        background: '#FFFAEB',
        boxShadow: 'inset 0 0 0 1px #FEDF89',
        fontSize: 12.5,
        lineHeight: '19px',
        color: '#B54708',
      }}
    >
      You have attached {count} files to this thread. Meri reads the most relevant first and will
      tell you which ones it used. Remove what is not needed for a sharper answer.
    </div>
  );
}
