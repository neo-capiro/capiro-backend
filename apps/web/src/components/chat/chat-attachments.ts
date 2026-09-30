/**
 * chat-attachments — UI-free staged-attachment contract shared by BOTH chat
 * surfaces.
 *
 * The legacy composer (ChatInput.tsx, antd) and the vNext Meri composer
 * (vnext/meri/VNextMeriComposer.tsx, Untitled-UI tokens) stage the same
 * attachment records and apply the same usability/filename rules. Those rules
 * used to live in ChatInput.tsx, which meant every vNext module that needed
 * them (directly or through useMeriChatController) pulled the antd-heavy
 * composer — and its managed-mcp-apps.css — into the os.capiro.ai runtime
 * module graph. This module holds the pure parts only: no react, no antd, no
 * CSS. ChatInput re-exports them so legacy consumers are unchanged.
 *
 * Icon rendering intentionally does NOT live here: each surface maps
 * `StagedAttachment['kind']` to its own icon set (antd file icons in
 * ChatInput/ChatMessage, MeriIcon names in the vNext composer — see
 * vnext/meri/MeriAttachmentChip.tsx for the vNext kind→icon convention).
 */

/** A file staged in the composer: uploading, ready to send, or failed. */
export interface StagedAttachment {
  /** Client-side key, stable across the upload lifecycle. */
  localId: string;
  /** Server attachment id once uploaded; null while uploading or when unusable. */
  id: string | null;
  filename: string;
  kind: 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'image' | 'text' | 'unsupported';
  status:
    | 'uploading'
    | 'parsed'
    | 'truncated'
    | 'image_ready'
    | 'scanned'
    | 'unsupported'
    | 'error';
  reason: string | null;
  /**
   * POST /api/clio/attachments already returns these; kept optional (absent
   * while uploading) so the v4 attachment chip can show real page/character
   * counts instead of only the status.
   */
  pages?: number | null;
  chars?: number;
}

/** True when a staged file can be referenced by a send (has a server id). */
export function isUsableAttachment(att: StagedAttachment): boolean {
  return (
    att.id !== null &&
    (att.status === 'parsed' || att.status === 'truncated' || att.status === 'image_ready')
  );
}

/** Middle-ellipsis truncation so the start AND the extension stay visible. */
export function truncateFilenameMiddle(name: string, max = 28): string {
  if (name.length <= max) return name;
  const head = Math.ceil((max - 1) * 0.6);
  const tail = max - 1 - head;
  return `${name.slice(0, head)}…${name.slice(name.length - tail)}`;
}
