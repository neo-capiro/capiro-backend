import { meriPacketScopeLabel } from '../../components/chat/meri-turn-scope.js';
import { useEffect } from 'react';
import { MeriIcon, type MeriIconName } from './meri-icons.js';
import type { MeriContextPacket, MeriContextPacketItem } from './meri-vnext-api.js';

interface MeriContextSheetProps {
  open: boolean;
  packet: MeriContextPacket | null;
  loading: boolean;
  error: boolean;
  onClose: () => void;
  /**
   * When set (a click on an ACTIVE CONTEXT row in the rail), the sheet opens
   * focused on that single item — the prototype's click-to-preview behavior —
   * instead of listing every compiled item.
   */
  focusItemId?: string | null;
}

/**
 * A semicolon-joined list of bare internal codes (e.g.
 * "coverage_manifest_incomplete; source_unavailable:clients") turned into
 * plain words, or null if `text` doesn't actually look like one — every
 * semicolon-separated part must have no whitespace before its optional
 * ":qualifier", which real prose (spaces throughout) never satisfies.
 */
function codeListItems(text: string): string[] | null {
  const parts = text
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
  const looksLikeCodeList =
    parts.length > 0 && parts.every((part) => !/\s/.test(part.split(':')[0] ?? ''));
  if (!looksLikeCodeList) return null;
  return parts.map((part) => {
    const [code, qualifier] = part.split(':');
    const words = (code ?? '').replace(/[_-]/g, ' ').trim();
    const label = words.charAt(0).toUpperCase() + words.slice(1);
    return qualifier ? `${label} (${qualifier.replace(/[_-]/g, ' ').trim()})` : label;
  });
}

/**
 * The server's degradedReason is sometimes a plain sentence (a real string a
 * person wrote), sometimes a bare code list, and sometimes a hybrid — a
 * human-written label, then ": ", then a code list (e.g. "Missing required
 * layers: firm-identity; coverage_manifest_incomplete; source_unavailable:
 * clients", confirmed live) — shipped straight to users unreadable. The
 * label's colon is followed by a space; each code's own qualifier colon
 * (":clients") is not, which is what tells them apart.
 */
export function readableDegradedReasons(raw: string): string[] {
  const prefixMatch = raw.match(/^([^:;]+):\s+([\s\S]+)$/);
  const label = prefixMatch?.[1];
  const rest = prefixMatch?.[2];
  if (label !== undefined && rest !== undefined) {
    const items = codeListItems(rest);
    if (items) return [`${label.trim()}:`, ...items];
  }
  return codeListItems(raw) ?? [raw];
}

const CONTEXT_ITEM_ICONS: Record<string, MeriIconName> = {
  client_record: 'Building01',
  program_element: 'Coins01',
  public_document: 'File04',
  memory: 'Scales02',
  matter: 'ClockRewind',
};

function contextItemIcon(item: MeriContextPacketItem): MeriIconName {
  const key = item.type.toLowerCase().replace(/\s+/g, '_');
  return CONTEXT_ITEM_ICONS[key] ?? 'File04';
}

function exclusionIcon(reason: string): MeriIconName {
  const lower = reason.toLowerCase();
  if (lower.includes('permission') || lower.includes('denied')) return 'Lock01';
  if (lower.includes('scope')) return 'SlashCircle01';
  return 'AlertCircle';
}

/**
 * "Behind the answer" · CONTEXT — a right-side sliding Sheet (v6 prototype's
 * `sheetOpen` shadcn `Sheet`), pixel-parity port of `state-context-sheet.html`:
 * a header (eyebrow + packet title + close), a compiled-projection note, an
 * INCLUDED item grid (2-column key/value rows + rationale), an EXCLUDED list,
 * and a read-only footer note. Context is compiled server-side; this sheet
 * never pretends a browser toggle can change what the next model turn
 * receives — there is no add, remove, or apply here.
 */
export function MeriContextSheet({
  open,
  packet,
  loading,
  error,
  onClose,
  focusItemId = null,
}: MeriContextSheetProps) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose, open]);

  if (!open) return null;

  const unavailable = !loading && !error && !packet;
  const focusedItem =
    focusItemId && packet ? (packet.items.find((item) => item.id === focusItemId) ?? null) : null;
  const visibleItems = focusItemId ? (focusedItem ? [focusedItem] : []) : (packet?.items ?? []);
  const sheetTitle = focusedItem
    ? focusedItem.label
    : packet?.packetId
      ? `Context packet · ${packet.packetId}`
      : 'Context packet';
  const sheetEyebrow = focusedItem ? 'CONTEXT PREVIEW' : 'CONTEXT USED FOR THIS TURN';
  const sheetMeta = focusedItem
    ? `${focusedItem.type.replace(/_/g, ' ')} · ${focusedItem.scope} scope · included by the server-side context compiler.`
    : packet
      ? `Compiled server-side for this turn. ${packet.items.length} item${
          packet.items.length === 1 ? '' : 's'
        } included, ${packet.exclusions.length} excluded, ${packet.unauthorizedCount} unauthorized. ` +
        `Scope and contents come from this stored packet; changing the client picker does not change them.`
      : '';

  return (
    <div
      className="vnext-meri__sheet-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="vnext-meri__sheet-content"
        role="dialog"
        aria-modal="true"
        aria-labelledby="meri-sheet-title"
        aria-describedby="meri-sheet-desc"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="vnext-meri__sheet-header">
          <span className="vnext-meri__sheet-header-copy">
            <span id="meri-sheet-desc" className="vnext-meri__sheet-eyebrow">
              {sheetEyebrow} · {meriPacketScopeLabel(packet)}
            </span>
            <span id="meri-sheet-title" className="vnext-meri__sheet-title">
              {sheetTitle}
            </span>
          </span>
          <button
            type="button"
            className="vnext-meri__sheet-close"
            aria-label="Close"
            onClick={onClose}
          >
            <MeriIcon name="XClose" size={17} />
          </button>
        </div>
        <div className="vnext-meri__sheet-body">
          {loading ? (
            <div className="vnext-meri__ctx-empty">Loading the context packet…</div>
          ) : null}
          {error ? (
            <div className="vnext-meri__sheet-error" role="alert">
              The context packet could not be loaded.
            </div>
          ) : null}
          {unavailable ? (
            <div className="vnext-meri__sheet-unavailable">
              <div className="vnext-meri__sheet-unavailable-title">
                Provenance unavailable for this turn
              </div>
              <div className="vnext-meri__sheet-unavailable-body">
                No packet id was persisted with this message. The conversation's latest packet
                belongs to a later turn, so showing it here would misattribute the answer.
              </div>
            </div>
          ) : null}
          {packet && !loading && !error ? (
            <>
              {packet.degraded ? (
                <div className="vnext-meri__context-sheet-degraded" role="alert">
                  {readableDegradedReasons(packet.degradedReason ?? 'The context packet is degraded.').map(
                    (reason) => (
                      <div key={reason} className="vnext-meri__context-sheet-degraded-item">
                        {reason}
                      </div>
                    ),
                  )}
                </div>
              ) : null}
              <div className="vnext-meri__sheet-meta">{sheetMeta}</div>
              <div className="vnext-meri__sheet-item-list">
                {visibleItems.map((item) => (
                  <article key={item.id} className="vnext-meri__sheet-item">
                    <div className="vnext-meri__sheet-item-head">
                      <MeriIcon name={contextItemIcon(item)} size={15} color="#98A2B3" />
                      <span className="vnext-meri__sheet-item-label">{item.label}</span>
                      <span
                        className="vnext-meri__sheet-item-selection"
                        style={{ color: item.selection === 'explicit' ? '#363F72' : '#98A2B3' }}
                      >
                        {item.selection.toUpperCase()}
                      </span>
                    </div>
                    <div className="vnext-meri__sheet-item-grid">
                      <div className="vnext-meri__sheet-item-row">
                        <span>Type</span>
                        <span>{item.type}</span>
                      </div>
                      <div className="vnext-meri__sheet-item-row">
                        <span>Scope</span>
                        <span>{item.scope.toLowerCase()}</span>
                      </div>
                      <div className="vnext-meri__sheet-item-row">
                        <span>Authority</span>
                        <span>{item.authority}</span>
                      </div>
                      <div className="vnext-meri__sheet-item-row">
                        <span>Client</span>
                        <span>{item.clientName ?? '—'}</span>
                      </div>
                      <div className="vnext-meri__sheet-item-row">
                        <span>As of</span>
                        <span>{item.asOf ?? '—'}</span>
                      </div>
                      <div className="vnext-meri__sheet-item-row">
                        <span>Confirmed</span>
                        <span>{item.lastConfirmedAt ?? '—'}</span>
                      </div>
                      <div className="vnext-meri__sheet-item-row">
                        <span>User-scoped</span>
                        <span>{item.userScoped ? 'yes' : 'no'}</span>
                      </div>
                      <div className="vnext-meri__sheet-item-row">
                        <span>Selection</span>
                        <span>{item.selection}</span>
                      </div>
                    </div>
                    {item.rationale ? (
                      <div className="vnext-meri__sheet-item-rationale">{item.rationale}</div>
                    ) : null}
                  </article>
                ))}
              </div>
              {focusedItem ? null : (
                <>
                  <div className="vnext-meri__sheet-excluded-label">
                    EXCLUDED · {packet.exclusions.length}
                  </div>
              <div className="vnext-meri__sheet-excluded-list">
                {packet.exclusions.map((exclusion, index) => (
                  <div
                    key={`${exclusion.id ?? exclusion.label}-${index}`}
                    className="vnext-meri__sheet-excluded-item"
                  >
                    <MeriIcon name={exclusionIcon(exclusion.reason)} size={14} color="#98A2B3" />
                    <span className="vnext-meri__sheet-excluded-copy">
                      <span className="vnext-meri__sheet-excluded-title">{exclusion.label}</span>
                      <span className="vnext-meri__sheet-excluded-reason">{exclusion.reason}</span>
                    </span>
                  </div>
                ))}
              </div>
              <div className="vnext-meri__sheet-footnote">
                This is a server-compiled projection. There is no add, remove or apply — membership
                is read-only.
              </div>
                </>
              )}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
