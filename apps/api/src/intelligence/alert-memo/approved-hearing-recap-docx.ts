import JSZip from 'jszip';
import { markdownToMemoDocInput, renderMemoDocx } from './alert-memo-docx.js';

/** Freeze document metadata too, so repeat export/save of an approved version
 * produces identical bytes and uses the existing writer's retry identity. */
export async function renderApprovedHearingRecap(
  input: { markdown: string; title: string; approvedAt: string },
  clientName: string,
) {
  const approved = new Date(input.approvedAt);
  if (!Number.isFinite(approved.getTime())) throw Error('Approved recap timestamp is invalid');
  const bytes = await renderMemoDocx(
    markdownToMemoDocInput(
      input.markdown.replace(
        /^\*\*(Unofficial transcript-based hearing (?:recap|update))\*\*$/gm,
        '$1',
      ),
      clientName,
      input.title,
      input.approvedAt.slice(0, 10),
    ),
  );
  const zip = await JSZip.loadAsync(bytes);
  const core = zip.file('docProps/core.xml');
  if (core) {
    const xml = await core.async('string');
    zip.file(
      'docProps/core.xml',
      xml.replace(
        /(<dcterms:(?:created|modified)\b[^>]*>)[^<]*(<\/dcterms:(?:created|modified)>)/g,
        (_match, open: string, close: string) => open + approved.toISOString() + close,
      ),
    );
  }
  for (const file of Object.values(zip.files)) file.date = approved;
  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}
