import { useMemo, useState } from 'react';
import type { CanvasArtifact } from '../../components/chat/MeriCanvas.js';
import { MeriIcon } from './meri-icons.js';
import { MeriWordArtifactPreview, meriWordArtifactText, readMeriWordArtifact } from './MeriWordArtifactPreview.js';
import { saveMeriDownloadBlob } from '../../components/chat/meri-artifact-download.js';
import { useMeriArtifactDownload } from '../../components/chat/useMeriArtifactDownload.js';
import { splitCitationMarkers } from '../../components/chat/citation-rendering.js';

/**
 * MeriArtifactCanvas — the in-rail "ARTIFACT" panel content, replacing the
 * legacy fixed-overlay MeriCanvas for the vNext workspace. A CanvasArtifact
 * carries { id, title, kind, bodyText }. Word bodyText is the API's persisted
 * document spec; preview its actual content while downloads continue through
 * the canonical authenticated document renderer.
 */

const MONO = "var(--meri-font-mono, Inter, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif)";

const DOC_KINDS: Record<string, { ext: string; label: string }> = {
  word_document: { ext: 'docx', label: 'WORD DOCUMENT' },
  text_document: { ext: 'txt', label: 'TEXT DOCUMENT' },
  pdf_document: { ext: 'pdf', label: 'PDF DOCUMENT' },
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
  const [activeCitationTitle, setActiveCitationTitle] = useState<string | null>(null);

  const title = artifact.title?.trim() || 'Document';
  const body = artifact.bodyText ?? '';
  const isWordOrPdf = artifact.kind === 'word_document' || artifact.kind === 'pdf_document';
  const isStructuredWord = isWordOrPdf && /^\s*[\[{]/.test(body);
  const wordDocument = useMemo(() => isStructuredWord ? readMeriWordArtifact(body) : null, [body, isStructuredWord]);
  const previewUnavailable = isStructuredWord && !wordDocument;
  const copyText = useMemo(() => wordDocument ? meriWordArtifactText(wordDocument) : body, [wordDocument, body]);
  const docKind = artifact.kind ? DOC_KINDS[artifact.kind] : undefined;
  const isOfficeDoc = Boolean(docKind);
  const metaLabel = docKind?.label ?? 'MARKDOWN DOCUMENT';
  const citationMap = useMemo(() => new Map((artifact.citations ?? []).map((citation) => [citation.n, citation])), [artifact.citations]);
  const renderText = (text: string) => splitCitationMarkers(
    text,
    citationMap,
    (citation) => setActiveCitationTitle(citation.title),
    artifact.evidenceAccuracy,
  );

  const slugify = () =>
    title
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'document';

  const { downloading, downloadingFormat, downloadError, downloadOfficeDoc, downloadDocument } = useMeriArtifactDownload({
    artifactId: artifact.id, apiBaseUrl, getAuthHeaders,
    expectedFormat: docKind?.ext,
    fallbackFilename: docKind ? `${slugify()}.${docKind.ext}` : undefined,
  });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  const downloadMarkdown = () => {
    const blob = new Blob([body], { type: 'text/markdown;charset=utf-8' });
    saveMeriDownloadBlob(blob, `${slugify()}.md`);
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
            disabled={previewUnavailable}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              height: 30,
              padding: '0 11px',
              borderRadius: 8,
              border: '1px solid #D0D5DD',
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
            aria-busy={downloading && downloadingFormat === docKind?.ext}
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
              {downloading && downloadingFormat === docKind?.ext ? 'Downloading…' : isOfficeDoc ? `Download .${docKind!.ext}` : 'Download'}
            </span>
          </button>
          {isWordOrPdf ? (
            <button
              type="button"
              onClick={() => void downloadDocument({
                format: artifact.kind === 'pdf_document' ? 'docx' : 'pdf',
                fallbackFilename: `${slugify()}.${artifact.kind === 'pdf_document' ? 'docx' : 'pdf'}`,
              })}
              disabled={downloading}
              aria-busy={downloading && downloadingFormat !== docKind?.ext}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 30, padding: '0 11px', borderRadius: 8, border: '1px solid #D0D5DD', background: 'transparent', cursor: downloading ? 'default' : 'pointer', opacity: downloading ? 0.7 : 1 }}
            >
              <MeriIcon name="DownloadCloud01" size={13} color="#344054" />
              <span style={{ fontSize: 12.5, fontWeight: 600, color: '#344054' }}>
                {downloading && downloadingFormat !== docKind?.ext ? 'Downloading…' : `Download .${artifact.kind === 'pdf_document' ? 'docx' : 'pdf'}`}
              </span>
            </button>
          ) : null}
        </div>
        {downloadError ? (
          <div
            role="alert"
            style={{
              marginTop: 11,
              padding: '10px 12px',
              borderRadius: 8,
              background: '#FEF3F2',
              border: '1px solid #FECDCA',
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
        {activeCitationTitle ? <p role="status" style={{ overflowWrap: 'anywhere' }}>Source: {activeCitationTitle}</p> : null}
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
            ...(artifact.evidenceAccuracy === 'enforce' ? { overflowWrap: 'anywhere' as const } : {}),
          }}
        >
          {wordDocument ? <MeriWordArtifactPreview document={wordDocument} format={artifact.kind === 'pdf_document' ? 'PDF' : 'Word'} renderText={renderText} /> : previewUnavailable ? (
            <p role="status">This document preview is unavailable. Download the Word or PDF file to view its content.</p>
          ) : body ? renderText(body) : 'This document has no content yet.'}
        </div>
      </div>
    </div>
  );
}
