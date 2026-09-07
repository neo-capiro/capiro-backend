import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useApi } from '../../../../lib/use-api.js';
import { useClientsLite, useStrategies } from '../strategies-api.js';
import { CONTEXT_CATEGORIES, contextCategoryLabel } from '../context/context-categories.js';
import {
  CONTEXT_IMPORT_MAX_FILES, analyzeContextImport, contextFileProblem,
  contextImportError, contextImportNeedsRefresh, contextSourceLabel, resolveContextImport, saveContextImport, uploadContextSource,
  type AnalyzedContextImport, type ResolvedContextImport,
} from '../context/context-import-api.js';
import { StrategiesModalShell } from './StrategiesModalShell.js';
import './upload-context.css';

interface ImportPart {
  chunkToken: string;
  preview?: AnalyzedContextImport;
  selectedIds: string[];
  savedIds: string[];
  error?: string;
  saveError?: string;
}

interface ImportFile {
  id: number;
  file: File;
  attachmentId?: string;
  resolved?: ResolvedContextImport;
  parts: ImportPart[];
  status: string;
  error?: string;
  warnings: string[];
  refreshRequired?: boolean;
  requireSelection?: boolean;
}

const CLOSE_TO = '/strategies/context';

/** Ordinary source files go through the existing attachment store, then the
 * server-resolved source is analyzed. Only signed previews can be saved. */
export function UploadContextOverlay() {
  const api = useApi();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const clients = useClientsLite();
  const strategies = useStrategies();
  const [clientId, setClientId] = useState(searchParams.get('clientId') ?? '');
  const [strategyId, setStrategyId] = useState(searchParams.get('strategyId') ?? '');
  const [files, setFiles] = useState<ImportFile[]>([]);
  const filesRef = useRef(files);
  const nextId = useRef(0);
  const generation = useRef(0);
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<'files' | 'review'>('files');
  const [notice, setNotice] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current += 1; };
  }, []);

  function changeFiles(next: ImportFile[] | ((current: ImportFile[]) => ImportFile[])) {
    const updated = typeof next === 'function' ? next(filesRef.current) : next;
    filesRef.current = updated;
    setFiles(updated);
  }

  function updateFile(id: number, patch: Partial<ImportFile>) {
    changeFiles((current) => current.map((entry) => entry.id === id ? { ...entry, ...patch } : entry));
  }

  const validScope = !!clientId && !!clients.data?.some((client) => client.id === clientId)
    && (!strategyId || !!strategies.data?.some((strategy) => strategy.id === strategyId && strategy.clientId === clientId));
  const clientStrategies = strategies.data?.filter((strategy) => strategy.clientId === clientId) ?? [];
  const allParts = files.flatMap((entry) => entry.parts);
  const selectedCount = files.reduce((count, entry) => count + (entry.refreshRequired ? 0 : entry.parts.reduce((total, part) =>
    total + (part.preview?.token ? part.selectedIds.filter((id) => !part.savedIds.includes(id)).length : 0), 0)), 0);
  const savedCount = allParts.reduce((count, part) => count + part.savedIds.length, 0);
  const failures = files.some((entry) => entry.error || entry.parts.some((part) => part.error || part.saveError));
  const unsaved = files.length > 0 && (savedCount === 0 || selectedCount > 0 || failures);
  const complete = savedCount > 0 && selectedCount === 0 && !failures;

  function resetReview(nextClientId = clientId, nextStrategyId = strategyId) {
    if (busyRef.current || savedCount > 0) return;
    const changedClient = nextClientId !== clientId;
    const changedScope = changedClient || nextStrategyId !== strategyId;
    if (changedScope) generation.current += 1;
    setClientId(nextClientId);
    setStrategyId(nextStrategyId);
    if (changedScope) changeFiles((current) => current.map((entry) => ({
      id: entry.id, file: entry.file,
      attachmentId: changedClient ? undefined : entry.attachmentId,
      parts: [], status: 'Ready to read', warnings: [], error: contextFileProblem(entry.file) ?? undefined,
    })));
    setStep('files');
    setNotice('');
  }

  function addFiles(incoming: FileList | File[]) {
    if (busyRef.current || step !== 'files') return;
    const current = filesRef.current;
    const unique = Array.from(incoming).filter((file) => !current.some((entry) =>
      entry.file.name === file.name && entry.file.size === file.size && entry.file.lastModified === file.lastModified));
    const available = CONTEXT_IMPORT_MAX_FILES - current.length;
    setNotice(unique.length > available ? 'You can add up to 10 files at a time. The first available files were added; add the others in your next upload.' : '');
    changeFiles([...current, ...unique.slice(0, available).map((file) => ({
      id: ++nextId.current, file, parts: [], status: 'Ready to read',
      error: contextFileProblem(file) ?? undefined, warnings: [],
    }))]);
  }

  async function readFiles(onlyId?: number) {
    if (busyRef.current || !validScope) return;
    busyRef.current = true;
    setBusy(true);
    setNotice('');
    const attempt = generation.current;
    const currentAttempt = () => mounted.current && generation.current === attempt;
    const pending = filesRef.current.filter((entry) => onlyId === undefined || entry.id === onlyId);
    try {
      for (const entry of pending) {
        if (!currentAttempt()) return;
        const problem = contextFileProblem(entry.file);
        if (problem) { updateFile(entry.id, { error: problem }); continue; }
        let attachmentId = entry.attachmentId;
        let resolved = entry.resolved;
        let parts = entry.parts;
        try {
          updateFile(entry.id, { error: undefined, status: attachmentId ? 'Reading your file…' : 'Uploading original file…' });
          if (!attachmentId) {
            const attachment = await uploadContextSource(api, entry.file, clientId);
            if (!currentAttempt()) return;
            attachmentId = attachment.id;
            updateFile(entry.id, { attachmentId, status: 'Reading your file…' });
          }
          if (!resolved) {
            resolved = await resolveContextImport(api, { attachmentId, clientId, ...(strategyId ? { strategyId } : {}) });
            if (!currentAttempt()) return;
            if (!resolved.chunks.length) throw new Error('We could not find readable content. Try a searchable PDF, a clearer scan, or a text copy.');
            parts = [...parts.filter((part) => part.savedIds.length), ...resolved.chunks.map((chunk) => ({ chunkToken: chunk.token, selectedIds: [], savedIds: [] }))];
            updateFile(entry.id, { resolved, parts, warnings: resolved.warnings ?? [] });
          }
          for (let index = 0; index < parts.length; index += 1) {
            const part = parts[index]!;
            if (part.preview) continue;
            updateFile(entry.id, { status: `Meri is organizing information (${index + 1} of ${parts.length})…` });
            try {
              const preview = await analyzeContextImport(api, part.chunkToken);
              if (!currentAttempt()) return;
              const previouslySaved = new Set(parts.flatMap((item) => item.savedIds));
              const freshPreview = { ...preview, documents: preview.documents.filter((document) => !previouslySaved.has(document.id)) };
              parts = parts.map((item, position) => position === index ? {
                ...item, preview: freshPreview, selectedIds: entry.requireSelection ? [] : freshPreview.documents.map((document) => document.id), error: undefined,
              } : item);
            } catch (error) {
              if (!currentAttempt()) return;
              parts = parts.map((item, position) => position === index ? { ...item, error: contextImportError(error) } : item);
              if (contextImportNeedsRefresh(error)) updateFile(entry.id, { refreshRequired: true });
            }
            updateFile(entry.id, { parts });
          }
          const hasFailure = parts.some((part) => part.error);
          const found = parts.reduce((count, part) => count + (part.preview?.documents.length ?? 0), 0);
          updateFile(entry.id, { status: hasFailure ? 'Some information still needs to be read' : found ? 'Ready for your review' : 'No relevant strategy information found' });
        } catch (error) {
          if (!currentAttempt()) return;
          updateFile(entry.id, { attachmentId, error: contextImportError(error), status: 'Needs attention' });
        }
      }
      if (currentAttempt()) setStep('review');
    } finally {
      if (currentAttempt()) { busyRef.current = false; setBusy(false); }
    }
  }

  function toggleDocument(fileId: number, partIndex: number, documentId: string) {
    if (busyRef.current) return;
    changeFiles((current) => current.map((entry) => entry.id !== fileId ? entry : {
      ...entry, parts: entry.parts.map((part, index) => index !== partIndex || part.savedIds.includes(documentId) ? part : {
        ...part, saveError: undefined,
        selectedIds: part.selectedIds.includes(documentId) ? part.selectedIds.filter((id) => id !== documentId) : [...part.selectedIds, documentId],
      }),
    }));
  }

  async function saveSelected() {
    if (busyRef.current || !selectedCount || !validScope) return;
    busyRef.current = true;
    setBusy(true);
    setNotice('');
    const attempt = generation.current;
    const currentAttempt = () => mounted.current && generation.current === attempt;
    let savedThisTime = 0;
    let saveFailed = false;
    try {
      for (const entry of filesRef.current) {
        for (let index = 0; index < entry.parts.length; index += 1) {
          if (!currentAttempt()) return;
          const part = entry.parts[index]!;
          const ids = part.selectedIds.filter((id) => !part.savedIds.includes(id));
          if (!part.preview?.token || !ids.length || entry.refreshRequired) continue;
          try {
            const saved = await saveContextImport(api, part.preview.token, ids);
            if (!currentAttempt()) return;
            if (saved.documents.length !== ids.length) throw new Error('The server did not confirm all selected information was saved. Retry to check and finish this save.');
            savedThisTime += saved.documents.length;
            changeFiles((current) => current.map((item) => item.id !== entry.id ? item : {
              ...item, warnings: [...item.warnings, ...(saved.warnings ?? [])],
              parts: item.parts.map((value, position) => position !== index ? value : {
                ...value, savedIds: [...value.savedIds, ...ids], saveError: undefined,
              }),
            }));
            await Promise.allSettled(['context-documents', 'context-health', 'context-facts', 'context-conflicts'].map((key) =>
              queryClient.invalidateQueries({ queryKey: ['strategy', key] })));
          } catch (error) {
            if (!currentAttempt()) return;
            saveFailed = true;
            changeFiles((current) => current.map((item) => item.id !== entry.id ? item : {
              ...item, refreshRequired: item.refreshRequired || contextImportNeedsRefresh(error),
              parts: item.parts.map((value, position) => position !== index ? value : { ...value, saveError: contextImportError(error) }),
            }));
          }
        }
      }
      if (currentAttempt()) setNotice(saveFailed
        ? `${savedThisTime} ${savedThisTime === 1 ? 'item was' : 'items were'} saved. Some information could not be saved. Review the messages below and retry the remaining items.`
        : `${savedThisTime} ${savedThisTime === 1 ? 'item was' : 'items were'} added to your context. Your original files are preserved.`);
    } finally {
      if (currentAttempt()) { busyRef.current = false; setBusy(false); }
    }
  }

  function refreshFile(fileId: number) {
    if (busyRef.current) return;
    changeFiles((current) => current.map((entry) => entry.id !== fileId ? entry : {
      ...entry, resolved: undefined, error: undefined, refreshRequired: false, requireSelection: true,
      parts: entry.parts.filter((part) => part.savedIds.length).map((part) => ({
        ...part, selectedIds: [...part.savedIds], error: undefined, saveError: undefined,
        preview: part.preview ? { ...part.preview, documents: part.preview.documents.filter((document) => part.savedIds.includes(document.id)) } : undefined,
      })),
    }));
    void readFiles(fileId);
  }

  return (
    <StrategiesModalShell
      eyebrow="Strategy context" title={step === 'review' ? 'Review what Meri found' : 'Add files to your context'}
      subtitle={step === 'review' ? 'Check the information and its sources, then choose what to add to your library.' : 'Upload the materials your team already uses. Meri will read them and organize the information for your strategy.'}
      closeTo={CLOSE_TO} maxWidth={960} dirty={unsaved} primaryBusy={busy}
      primaryLabel={busy ? (step === 'files' ? 'Reading files…' : 'Working…') : complete ? 'Back to library' : step === 'files' ? 'Read and organize files' : `Add ${selectedCount} selected ${selectedCount === 1 ? 'item' : 'items'}`}
      primaryDisabled={busy || (complete ? false : step === 'files' ? !validScope || !files.length || files.every((entry) => !!contextFileProblem(entry.file)) : !selectedCount)}
      onPrimary={() => { if (complete) navigate(CLOSE_TO); else if (step === 'files') void readFiles(); else void saveSelected(); }}
      cancelLabel={complete ? 'Close' : 'Cancel'}
      footerNote={step === 'files' ? 'Up to 10 files · 25 MB per file' : 'New information is added without replacing your existing context.'}
    >
      <div className="st-context-import">
        {notice && <p className="st-context-import__notice" role="status">{notice}</p>}
        {step === 'files' && <>
          <div className="st-context-import__scope">
            <label>Client <span aria-hidden="true">*</span>
              <select aria-label="Client" value={clientId} disabled={busy || clients.isLoading} onChange={(event) => resetReview(event.target.value, '')}>
                <option value="">{clients.isLoading ? 'Loading clients…' : 'Choose a client'}</option>
                {clients.data?.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}
              </select>
            </label>
            <label>Use this information for
              <select aria-label="Use this information for" value={strategyId} disabled={busy || !clientId || strategies.isLoading} onChange={(event) => resetReview(clientId, event.target.value)}>
                <option value="">All strategies for this client</option>
                {clientStrategies.map((strategy) => <option key={strategy.id} value={strategy.id}>{strategy.title}</option>)}
              </select>
            </label>
          </div>
          <p className="st-context-import__hint">Choose a strategy for information specific to that plan. Adding context for the whole client requires administrator access.</p>
          {(clients.isError || strategies.isError) && <div role="alert" className="st-context-import__error">We could not load your clients or strategies. <button type="button" onClick={() => { void clients.refetch(); void strategies.refetch(); }}>Try loading again</button></div>}
          <div className={`st-context-import__dropzone${dragOver ? ' is-dragging' : ''}`}
            onDragOver={(event) => { event.preventDefault(); if (!busy) setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(event) => { event.preventDefault(); setDragOver(false); addFiles(event.dataTransfer.files); }}>
            <strong>Bring your existing documents</strong>
            <p>Drop a client briefing, PowerPoint presentation, firm blueprint, spreadsheet, meeting notes, or other supporting material here.</p>
            <button className="st-context-import__button" type="button" disabled={busy || files.length >= CONTEXT_IMPORT_MAX_FILES} onClick={() => inputRef.current?.click()}>Choose files</button>
            <input ref={inputRef} className="st-context-import__file-input" type="file" multiple aria-label="Choose context files" disabled={busy}
              onChange={(event) => { if (event.target.files) addFiles(event.target.files); event.target.value = ''; }} />
            <small>PDF, Word (.doc/.docx), PowerPoint (.pptx), Excel (.xlsx), CSV, TXT, MD, JSON, and PNG/JPG images. Export older .ppt or .xls files to .pptx, .xlsx, or PDF for reading.</small>
          </div>
          <p className="st-context-import__hint"><strong>One file can cover several areas.</strong> You do not need a separate document for each topic or any special formatting. Meri only extracts information supported by your files; you review it before adding it.</p>
          <p className="st-context-import__hint">Original files are saved with this client as soon as they are uploaded. You choose which extracted information to add to the Context Library after Meri reads them.</p>
          <details className="st-context-import__guide">
            <summary>What can these files contain?</summary>
            <div className="st-context-import__categories">{CONTEXT_CATEGORIES.map((category) => <section key={category.key}>
              <h3>{category.label}</h3><p><strong>{category.question}</strong></p><p>{category.description}</p>
            </section>)}</div>
          </details>
        </>}
        {step === 'review' && <>
          <p className="st-context-import__hint">Meri grouped the information into the areas it found. Review names, requests, amounts, and dates against the source excerpts. Written approval policies and assignments provide context; they do not grant permissions or activate automated work.</p>
          {!savedCount && <button type="button" className="st-context-import__text-button" disabled={busy} onClick={() => resetReview()}>Back to files and client selection</button>}
          {failures && <p role="alert" className="st-context-import__error">Some files or sections need attention. You can save the information already reviewed and retry the rest. Nothing with an error is marked complete.</p>}
        </>}
        {files.length > 0 && <ul className="st-context-import__files" aria-label="Files to organize">{files.map((entry) => <li key={entry.id}>
          <div className="st-context-import__file-heading"><div><strong>{entry.file.name}</strong><span>{(entry.file.size / 1024 / 1024).toFixed(1)} MB · {entry.status}</span></div>
            {step === 'files' && <button type="button" disabled={busy} aria-label={`Remove ${entry.file.name}`} onClick={() => changeFiles((current) => current.filter((file) => file.id !== entry.id))}>Remove</button>}
            {step === 'review' && entry.refreshRequired && <button type="button" disabled={busy} onClick={() => refreshFile(entry.id)}>Read this file again</button>}
            {step === 'review' && !entry.refreshRequired && (entry.error || entry.parts.some((part) => part.error)) && <button type="button" disabled={busy || !!contextFileProblem(entry.file)} onClick={() => void readFiles(entry.id)}>Retry file</button>}
          </div>
          {entry.attachmentId && <p className="st-context-import__hint">Original file preserved.</p>}
          {entry.error && <p role="alert" className="st-context-import__error">{entry.error}</p>}
          {entry.refreshRequired && <p className="st-context-import__warning">This review expired or the source changed. Read this file again, then select the information you want from the refreshed review. Information already saved stays in your library.</p>}
          {entry.requireSelection && !entry.refreshRequired && <p className="st-context-import__hint">This file was read again. Select the information you want to add from this updated review.</p>}
          {[...new Set(entry.warnings)].map((warning) => <p className="st-context-import__warning" key={warning}>{warning}</p>)}
          {step === 'review' && entry.parts.map((part, partIndex) => <div key={`${partIndex}:${part.chunkToken}`}>
            {part.error && <p role="alert" className="st-context-import__error">Section {partIndex + 1}: {part.error}</p>}
            {part.saveError && <p role="alert" className="st-context-import__error">Could not save this information: {part.saveError} {entry.refreshRequired ? 'Use “Read this file again” to continue.' : 'Use “Add selected items” to retry.'}</p>}
            {part.preview?.warnings?.map((warning, index) => <p className="st-context-import__warning" key={index}>{warning}</p>)}
            {part.preview?.documents.map((document) => <article className="st-context-import__document" key={document.id}>
              <label className="st-context-import__selection"><input type="checkbox" checked={part.selectedIds.includes(document.id)} disabled={busy || entry.refreshRequired || part.savedIds.includes(document.id)} onChange={() => toggleDocument(entry.id, partIndex, document.id)} />
                <span><strong>{document.title}</strong><small>{contextCategoryLabel(document.documentType)}{part.savedIds.includes(document.id) ? ' · Added to context' : ''}</small></span>
              </label>
              {document.sections.map((section, sectionIndex) => <section className="st-context-import__section" key={sectionIndex}>
                <h4>{section.heading}</h4><p className="st-context-import__content">{section.content}</p>
                {section.evidence.length > 0 && <details className="st-context-import__evidence"><summary>View source {section.evidence.length === 1 ? 'excerpt' : 'excerpts'}</summary>{section.evidence.map((evidence, evidenceIndex) => <blockquote key={evidenceIndex}><p>{evidence.quote}</p><cite>{part.preview?.source.fileName} · {contextSourceLabel(evidence.sourceRef)}</cite></blockquote>)}</details>}
              </section>)}
            </article>)}
          </div>)}
        </li>)}</ul>}
        {busy && <p className="st-context-import__hint" role="status">Keep this window open while Meri finishes. Larger files are read in sections, and each file’s progress appears above.</p>}
      </div>
    </StrategiesModalShell>
  );
}
