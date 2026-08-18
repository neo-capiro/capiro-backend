import { useState } from 'react';
import type { CanvasArtifact } from '../../components/chat/MeriCanvas.js';
import { MeriIcon } from './meri-icons.js';

/**
 * MeriArtifactCanvas — the in-rail "ARTIFACT" panel content, replacing the
 * legacy fixed-overlay MeriCanvas for the vNext workspace. A CanvasArtifact
 * only ever carries { id, title, kind, bodyText } — no figures grid, next-steps
 * list, citation count, or sheet/deck table data exists on it, and there is no
 * "open as page" route — so unlike the v4 prototype's `panelIsArtifact` block,
 * this renders the real body text plus copy/download and drops the rest
 * rather than fabricating it.
 */

const MONO = "var(--meri-font-mono, 'IBM Plex Mono', monospace)";

const DOC_KINDS: Record<string, { ext: string; label: string }> = {
  word_document: { ext: 'docx', label: 'WORD DOCUMENT' },
  excel_workbook: { ext: 'xlsx', label: 'EXCEL WORKBOOK' },
  powerpoint_deck: { ext: 'pptx', label: 'POWERPOINT DECK' },
};

interface MeriArtifactCanvasProps {
  artifact: CanvasArtifact;
  onClose: () => void;
  apiBaseUrl?: string;
  getAuthHeaders?: () => Promise<Record<string, string>>;
}

export function MeriArtifactCanvas({ artifact, onClose, apiBaseUrl, getAuthHeaders }: MeriArtifactCanvasProps) {
  const [copied, setCopied] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const title = artifact.title?.trim() || 'Document';
  const body = artifact.bodyText ?? '';
  const docKind = artifact.kind ? DOC_KINDS[artifact.kind] : undefined;
  const isOfficeDoc = Boolean(docKind && artifact.id);
  const metaLabel = docKind?.label ?? 'MARKDOWN DOCUMENT';

  const slugify = () =>
    title
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'document';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  const downloadMarkdown = () => {
    const blob = new Blob([body], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${slugify()}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const downloadOfficeDoc = async () => {
    if (!artifact.id || !apiBaseUrl) {
      setDownloadError('This document is not available for download yet — try regenerating it in chat.');
      return;
    }
    setDownloading(true);
    setDownloadError(null);
    try {
      const headers = getAuthHeaders ? await getAuthHeaders() : {};
      const res = await fetch(`${apiBaseUrl}/api/clio/artifacts/${artifact.id}/download`, { headers });
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${slugify()}.${docKind!.ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'Download failed — please retry.');
    } finally {
      setDownloading(false);
    }
  };

  const download = isOfficeDoc ? downloadOfficeDoc : downloadMarkdown;

  return (
    <div style={{ animation: 'vnext-meri-rise .2s cubic-bezier(.2,0,0,1)', display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '14px 20px 0' }}>
        <button
          type="button"
          onClick={onClose}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            border: 0,
            background: 'transparent',
            fontFamily: MONO,
            fontSize: 9.5,
            fontWeight: 500,
            letterSpacing: '.08em',
            color: '#667085',
            cursor: 'pointer',
          }}
        >
          <MeriIcon name="ChevronLeft" size={13} color="#98A2B3" />
          BACK TO CONTEXT
        </button>
      </div>
      <div style={{ padding: '12px 20px 14px', borderBottom: '1px solid #EAECF0' }}>
        <div style={{ fontFamily: MONO, fontSize: 9.5, fontWeight: 500, letterSpacing: '.08em', color: '#667085' }}>
          {metaLabel}
        </div>
        <div style={{ marginTop: 7, fontSize: 16, lineHeight: '23px', fontWeight: 600, color: '#101828', textWrap: 'pretty' }}>
          {title}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginTop: 12 }}>
          <button
            type="button"
            onClick={copy}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              height: 30,
              padding: '0 11px',
              borderRadius: 8,
              boxShadow: 'inset 0 0 0 1px #D0D5DD',
              background: 'transparent',
              cursor: 'pointer',
            }}
          >
            <MeriIcon name="Copy01" size={13} color="#344054" />
            <span style={{ fontSize: 12.5, fontWeight: 600, color: '#344054' }}>{copied ? 'Copied' : 'Copy'}</span>
          </button>
          <button
            type="button"
            onClick={download}
            disabled={downloading}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              height: 30,
              padding: '0 12px',
              borderRadius: 8,
              border: 0,
              background: 'var(--m-metal-bg, linear-gradient(180deg,#39424F 0%,#1B2430 46%,#0E141C 100%))',
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,.14)',
              cursor: downloading ? 'default' : 'pointer',
              opacity: downloading ? 0.7 : 1,
            }}
          >
            <MeriIcon name="DownloadCloud01" size={13} color="#ffffff" />
            <span style={{ fontSize: 12.5, fontWeight: 600, color: '#ffffff' }}>
              {downloading ? 'Downloading…' : isOfficeDoc ? `Download .${docKind!.ext}` : 'Download'}
            </span>
          </button>
        </div>
        {downloadError ? (
          <div
            role="alert"
            style={{
              marginTop: 11,
              padding: '10px 12px',
              borderRadius: 8,
              background: '#FEF3F2',
              boxShadow: 'inset 0 0 0 1px #FECDCA',
              fontSize: 12.5,
              lineHeight: '18px',
              color: '#B42318',
            }}
          >
            {downloadError}
          </div>
        ) : null}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '18px 20px' }}>
        <div
          style={{
            padding: '22px 20px',
            borderRadius: 8,
            background: '#ffffff',
            boxShadow: '0 0 0 1px #EAECF0, 0px 2px 6px rgba(16,24,40,.06)',
            fontSize: 13,
            lineHeight: '20px',
            color: '#344054',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {body || 'This document has no content yet.'}
        </div>
      </div>
    </div>
  );
}
