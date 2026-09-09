/**
 * The content type to presign an engagement attachment upload with.
 *
 * `file.type` when the browser reported one; otherwise inferred from the file
 * extension, because `'application/octet-stream'` is the one value the
 * server's allowlist (`isAllowedAttachmentContentType`,
 * apps/api/src/engagement/engagement.service.ts) explicitly REJECTS — it is
 * reserved for the "we couldn't identify this" case, and letting an
 * identifiable file fall through to it makes an otherwise-supported upload
 * 400 for no visible reason.
 *
 * The browser reports `file.type` as `''` for several common types — .csv,
 * .txt and .docx most often, varying by OS file picker — so the old
 * `file.type || 'application/octet-stream'` fallback picked exactly the
 * value the server rejects. First observed and fixed in the client Mail
 * compose attachment flow (EmailComposeModal.tsx); the capability Documents
 * tab upload (CapabilityDrawer.tsx / CapabilityDrawerVNext.tsx) hit the same
 * failure independently — an empty-MIME .txt selected there 400'd with no
 * toast because the mutation's own onError never fired: the request never
 * left the presign step with a content type the allowlist would accept.
 * Centralized here so any future upload call site gets the same fix instead
 * of re-deriving (or re-missing) it.
 *
 * An unrecognized extension still falls back to 'application/octet-stream'
 * and still fails loudly server-side with the allowlist's own message — this
 * keeps the allowlist itself single-sourced on the API rather than mirrored
 * (and risking drift) on every client.
 */
const EXTENSION_CONTENT_TYPE: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  txt: 'text/plain',
};

export function attachmentContentType(file: File): string {
  if (file.type) return file.type;
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_CONTENT_TYPE[extension] ?? 'application/octet-stream';
}
