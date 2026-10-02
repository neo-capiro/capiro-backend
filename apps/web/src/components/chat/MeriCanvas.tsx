import { useState, type CSSProperties } from 'react';
import { saveMeriDownloadBlob } from './meri-artifact-download.js';
import { useMeriArtifactDownload } from './useMeriArtifactDownload.js';
import type { MeriCitation } from './chat-store.js';

export interface CanvasArtifact {
  id?: string;
  title?: string;
  kind?: string;
  bodyText?: string;
  citations?: MeriCitation[];
  evidenceAccuracy?: 'enforce';
}

interface MeriCanvasProps {
  artifact: CanvasArtifact;
  onClose: () => void;
  /** Base API URL for authenticated document downloads. */
  apiBaseUrl?: string;
  /** Returns auth headers (e.g. Bearer token) for the download request. */
  getAuthHeaders?: () => Promise<Record<string, string>>;
}

const DOC_KINDS: Record<string, { ext: string }> = {
  word_document: { ext: 'docx' },
  text_document: { ext: 'txt' },
  pdf_document: { ext: 'pdf' },
  excel_workbook: { ext: 'xlsx' },
  powerpoint_deck: { ext: 'pptx' },
};

/**
 * Side "canvas" panel for Meri deliverables (P1-4): briefings / memos / drafts
 * open here with copy + download, separate from the chat transcript. Streamed in
 * via the `artifact` SSE event. Self-contained styling so it has no CSS deps.
 *
 * Office documents (Word/Excel/PowerPoint) are downloaded as real binaries from
 * the authenticated /api/clio/artifacts/:id/download endpoint; markdown
 * deliverables fall back to a client-side .md blob.
 */
export function MeriCanvas({ artifact, onClose, apiBaseUrl, getAuthHeaders }: MeriCanvasProps) {
  const [copied, setCopied] = useState(false);
  const title = artifact.title?.trim() || 'Document';
  const body = artifact.bodyText ?? '';
  const docKind = artifact.kind ? DOC_KINDS[artifact.kind] : undefined;
  const isOfficeDoc = Boolean(docKind);
  const isWordOrPdf = artifact.kind === 'word_document' || artifact.kind === 'pdf_document';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  const slugify = () =>
    title
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'document';

  const downloadMarkdown = () => {
    const blob = new Blob([body], { type: 'text/markdown;charset=utf-8' });
    saveMeriDownloadBlob(blob, `${slugify()}.md`);
  };

  const { downloading, downloadingFormat, downloadError, downloadOfficeDoc, downloadDocument } = useMeriArtifactDownload({
    artifactId: artifact.id, apiBaseUrl, getAuthHeaders, expectedFormat: docKind?.ext,
    fallbackFilename: docKind ? `${slugify()}.${docKind.ext}` : undefined,
  });

  const download = isOfficeDoc ? downloadOfficeDoc : downloadMarkdown;

  const layout: CSSProperties = {
    position: 'fixed',
    top: 0,
    right: 0,
    height: '100vh',
    width: 'min(460px, 92vw)',
    display: 'flex',
    flexDirection: 'column',
    zIndex: 1100,
  };

  return (
    <aside aria-label="Document canvas" className="meri-canvas" style={layout}>
      <header
        className="meri-canvas-header"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '12px 14px',
        }}
      >
        <span
          className="meri-canvas-title"
          style={{
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {title}
        </span>
        <button type="button" onClick={copy} className="meri-canvas-btn" aria-label="Copy document">
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button
          type="button"
          onClick={download}
          className="meri-canvas-btn meri-canvas-btn--primary"
          aria-label="Download document"
          disabled={downloading}
        >
          {downloading && downloadingFormat === docKind?.ext ? 'Downloading…' : isOfficeDoc ? `Download .${docKind!.ext}` : 'Download'}
        </button>
        {isWordOrPdf ? (
          <button type="button" className="meri-canvas-btn" disabled={downloading}
            onClick={() => void downloadDocument({
              format: artifact.kind === 'pdf_document' ? 'docx' : 'pdf',
              fallbackFilename: `${slugify()}.${artifact.kind === 'pdf_document' ? 'docx' : 'pdf'}`,
            })}>
            {downloading && downloadingFormat !== docKind?.ext ? 'Downloading…' : `Download .${artifact.kind === 'pdf_document' ? 'docx' : 'pdf'}`}
          </button>
        ) : null}
        <button type="button" onClick={onClose} className="meri-canvas-btn" aria-label="Close canvas">
          ✕
        </button>
      </header>
      {downloadError && (
        <div
          role="alert"
          className="meri-canvas-error"
          style={{
            padding: '8px 14px',
            fontSize: 12.5,
            color: 'var(--danger-fg, #b42318)',
            background: 'var(--danger-bg, #fef3f2)',
            borderBottom: '1px solid var(--border-2)',
          }}
        >
          {downloadError}
        </div>
      )}
      <div
        className="meri-canvas-body"
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '16px 18px',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          fontSize: 14,
          lineHeight: 1.55,
        }}
      >
        {body}
      </div>
    </aside>
  );
}
