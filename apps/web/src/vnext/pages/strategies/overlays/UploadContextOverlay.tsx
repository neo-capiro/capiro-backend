/*
 * §7.10e — Upload context overlay. Route: /strategies/context/upload (over the
 * context library).
 *
 * Paste (or drop) a markdown document with its YAML front-matter block; an
 * optional client picker scopes the upload. The checklist under the editor
 * MIRRORS the server validator (apps/api-strategy/src/context/frontmatter.ts):
 * fences, flat `key: value` scalars, the 14 document types, schema_version
 * '1.0', state / scope / authority / confidentiality vocabularies,
 * source_of_truth boolean, real as_of date, scope→id consistency and the
 * shipped placeholder ids. A failed check names the key AND blocks the
 * upload — the server stays the final authority (400s land as field errors
 * via parseUploadError).
 *
 * Supersession preview: the parsed document_type is matched against existing
 * documents (templateKey "NN_<type>") so the user sees what this upload
 * supersedes BEFORE submitting. On success the overlay routes to the new
 * document. Focus trap / Escape / dirty guard / route sync live in the shell.
 */
import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CapiroIconButton } from '../../../components/actions/index.js';
import { CapiroSelect } from '../../../components/fields/index.js';
import { CapiroDownloadIcon } from '../../../components/icons/index.js';
import { parseUploadError } from '../../../../pages/strategy/context/context-utils.js';
import { clientName, useClientsLite, useContextDocuments, useUploadContextDocument } from '../strategies-api.js';
import { StrategiesModalShell } from './StrategiesModalShell.js';

/** Real server limit (apps/api-strategy/src/main.ts: `json({ limit: '8mb' })`)
 * — the whole upload body (content + clientId) is capped here, so this is
 * the one true "maximum size" number for the dropzone copy in item 14. */
const MAX_UPLOAD_MB = 8;

/** Local `XClose` glyph for the file-chip remove button — same convention as
 * StrategiesModalShell.tsx / FirmPhasesOverlay.tsx's own copies of this
 * glyph (the shared icon set has no close/X entry). */
function CloseGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/* ------------------------------------------------------------------------ */
/* Server-validator mirror (apps/api-strategy/src/context/frontmatter.ts).   */
/* Keep the vocabularies and messages aligned with that file.                */
/* ------------------------------------------------------------------------ */

const DOCUMENT_TYPES = [
  'context_manifest',
  'strategy_brief',
  'client_constraints',
  'ask_and_options',
  'stakeholder_map',
  'calendar_and_deadlines',
  'decision_rules',
  'current_plan',
  'evidence_register',
  'meeting_intelligence',
  'decision_log',
  'agent_mission',
  'execution_playbook',
  'agent_permissions',
] as const;

const CONTEXT_STATES = ['draft', 'active', 'superseded', 'archived'] as const;
const CONTEXT_SCOPES = ['once', 'node', 'strategy', 'client', 'firm'] as const;
const AUTHORITIES = [
  'firm_approved',
  'client_approved',
  'working_draft',
  'external_authoritative',
  'meeting_intelligence',
] as const;
const CONFIDENTIALITIES = ['client_confidential', 'firm_internal'] as const;
const DATE_PLACEHOLDER = 'YYYY-MM-DD';
const ID_PLACEHOLDERS = ['client_123', 'strategy_456', 'user_123', 'meeting_789'] as const;
const ID_FIELDS = ['client_id', 'strategy_id', 'node_id', 'meeting_id', 'owner'] as const;

type FrontmatterValue = string | boolean | null;
type Frontmatter = Record<string, FrontmatterValue>;

interface FieldProblem {
  field: string;
  message: string;
}

const FENCE = /^---\s*$/;
const KEY_VALUE = /^([A-Za-z_][A-Za-z0-9_]*):\s?(.*)$/;
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

function isRealIsoDate(value: string): boolean {
  if (!DATE_SHAPE.test(value)) return false;
  const d = new Date(value);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function parseScalar(rawValue: string): { value: FrontmatterValue } | { error: string } {
  if (rawValue === '') return { error: 'empty value (use null explicitly)' };
  if (rawValue === 'null') return { value: null };
  if (rawValue === 'true') return { value: true };
  if (rawValue === 'false') return { value: false };
  if (rawValue.startsWith('[') || rawValue.startsWith('{')) {
    return { error: 'arrays/objects are not allowed (flat scalars only)' };
  }
  if (rawValue.startsWith('"')) {
    if (rawValue.length < 2 || !rawValue.endsWith('"')) {
      return { error: 'unterminated double-quoted string' };
    }
    return { value: rawValue.slice(1, -1) };
  }
  return { value: rawValue };
}

interface ParsedDoc {
  frontmatter: Frontmatter | null;
  structureErrors: FieldProblem[];
  fieldErrors: FieldProblem[];
}

function parseAndValidate(raw: string): ParsedDoc {
  const lines = raw.split(/\r?\n/);
  const structureErrors: FieldProblem[] = [];

  if (lines.length === 0 || !FENCE.test(lines[0] ?? '')) {
    return {
      frontmatter: null,
      structureErrors: [
        { field: '_structure', message: "missing opening '---' frontmatter fence on line 1" },
      ],
      fieldErrors: [],
    };
  }
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (FENCE.test(lines[i] ?? '')) {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    return {
      frontmatter: null,
      structureErrors: [{ field: '_structure', message: "missing closing '---' frontmatter fence" }],
      fieldErrors: [],
    };
  }

  const fm: Frontmatter = {};
  for (let i = 1; i < closeIdx; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue;
    if (/^\s/.test(line)) {
      structureErrors.push({
        field: '_structure',
        message: `line ${i + 1}: nested/indented keys are not allowed (frontmatter is flat \`key: value\` only)`,
      });
      continue;
    }
    if (/^-\s/.test(line)) {
      structureErrors.push({
        field: '_structure',
        message: `line ${i + 1}: array items are not allowed (frontmatter is flat \`key: value\` only)`,
      });
      continue;
    }
    const match = KEY_VALUE.exec(line);
    if (!match) {
      structureErrors.push({ field: '_structure', message: `line ${i + 1}: not a flat \`key: value\` line` });
      continue;
    }
    const key = match[1]!;
    if (Object.prototype.hasOwnProperty.call(fm, key)) {
      structureErrors.push({ field: key, message: 'duplicate key' });
      continue;
    }
    const parsed = parseScalar((match[2] ?? '').trim());
    if ('error' in parsed) {
      structureErrors.push({ field: key, message: `line ${i + 1}: ${parsed.error}` });
      continue;
    }
    fm[key] = parsed.value;
  }

  if (structureErrors.some((e) => e.field === '_structure')) {
    return { frontmatter: null, structureErrors, fieldErrors: [] };
  }

  const fieldErrors: FieldProblem[] = [];
  const checkVocab = (field: string, vocab: readonly string[]) => {
    const value = fm[field];
    if (typeof value !== 'string' || !vocab.includes(value)) {
      fieldErrors.push({
        field,
        message: `must be one of: ${vocab.join(', ')}${value === undefined ? ' (missing)' : ''}`,
      });
    }
  };
  const checkDateOrNull = (field: string) => {
    const value = fm[field];
    if (value === null || value === undefined) {
      if (field === 'as_of') {
        fieldErrors.push({ field, message: 'as_of is required (a real YYYY-MM-DD date, not null)' });
      }
      return;
    }
    if (typeof value !== 'string') {
      fieldErrors.push({ field, message: 'must be a YYYY-MM-DD date string or null' });
      return;
    }
    if (value === DATE_PLACEHOLDER) {
      fieldErrors.push({ field, message: `placeholder date '${DATE_PLACEHOLDER}' — fill in a real date` });
      return;
    }
    if (!isRealIsoDate(value)) {
      fieldErrors.push({ field, message: 'not a valid YYYY-MM-DD calendar date' });
    }
  };

  checkVocab('document_type', DOCUMENT_TYPES);
  if (fm.schema_version !== '1.0') {
    fieldErrors.push({ field: 'schema_version', message: "must be '1.0'" });
  }
  checkVocab('state', CONTEXT_STATES);
  const scope = fm.scope;
  if (scope === 'meeting') {
    fieldErrors.push({
      field: 'scope',
      message: 'meeting scope is deferred (meetings association is a later phase) — re-scope to strategy',
    });
  } else {
    checkVocab('scope', CONTEXT_SCOPES);
  }
  checkVocab('authority', AUTHORITIES);
  checkVocab('confidentiality', CONFIDENTIALITIES);
  if (typeof fm.source_of_truth !== 'boolean') {
    fieldErrors.push({ field: 'source_of_truth', message: 'must be a boolean (true or false)' });
  }
  checkDateOrNull('as_of');
  checkDateOrNull('valid_until');
  for (const field of ID_FIELDS) {
    const value = fm[field];
    if (typeof value === 'string' && (ID_PLACEHOLDERS as readonly string[]).includes(value)) {
      fieldErrors.push({ field, message: `placeholder id '${value}' — fill in a real id` });
    }
  }
  const requireId = (idField: string) => {
    const value = fm[idField];
    if (typeof value !== 'string' || value.trim() === '') {
      fieldErrors.push({ field: idField, message: `${idField} is required when scope is '${String(scope)}'` });
    }
  };
  if (scope === 'client') requireId('client_id');
  if (scope === 'strategy') requireId('strategy_id');
  if (scope === 'node') requireId('node_id');
  const supersedes = fm.supersedes;
  if (supersedes !== undefined && supersedes !== null) {
    if (typeof supersedes !== 'string' || supersedes.trim() === '') {
      fieldErrors.push({ field: 'supersedes', message: 'must be null or a non-empty string' });
    }
  }

  return { frontmatter: fm, structureErrors, fieldErrors };
}

/* ------------------------------------------------------------ metadata grid */
/* Item 15 — GENERATE/PATCH the frontmatter lines the checklist above
 * validates from a 2-column dropdown/date grid, instead of requiring the
 * user to hand-type every `key: value` line. These mutate the SAME raw
 * `content` string the textarea and the checklist read, so the grid, the
 * textarea and the checklist can never drift out of sync with each other. */

/** Upsert a single flat `key: value` line inside the `---`-fenced frontmatter
 * block, creating the block (and preserving any existing text as the body
 * beneath it — never discarding what was already typed/pasted) if one
 * doesn't already parse. */
function upsertFrontmatterField(content: string, key: string, rawValue: string): string {
  const lines = content.length > 0 ? content.split(/\r?\n/) : [];
  const isFenced = lines.length > 0 && FENCE.test(lines[0] ?? '');
  let closeIdx = -1;
  if (isFenced) {
    for (let i = 1; i < lines.length; i++) {
      if (FENCE.test(lines[i] ?? '')) {
        closeIdx = i;
        break;
      }
    }
  }

  if (!isFenced || closeIdx === -1) {
    const body = content.replace(/^\r?\n+/, '');
    return `---\n${key}: ${rawValue}\n---\n${body ? `\n${body}` : '\n'}`;
  }

  for (let i = 1; i < closeIdx; i++) {
    const match = KEY_VALUE.exec(lines[i] ?? '');
    if (match && match[1] === key) {
      lines[i] = `${key}: ${rawValue}`;
      return lines.join('\n');
    }
  }
  lines.splice(closeIdx, 0, `${key}: ${rawValue}`);
  return lines.join('\n');
}

/** Remove a `key: value` line from the frontmatter block, if present —
 * reverting a grid field to its placeholder reverts the document too. */
function removeFrontmatterField(content: string, key: string): string {
  const lines = content.length > 0 ? content.split(/\r?\n/) : [];
  if (lines.length === 0 || !FENCE.test(lines[0] ?? '')) return content;
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (FENCE.test(lines[i] ?? '')) {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) return content;
  for (let i = 1; i < closeIdx; i++) {
    const match = KEY_VALUE.exec(lines[i] ?? '');
    if (match && match[1] === key) {
      lines.splice(i, 1);
      return lines.join('\n');
    }
  }
  return content;
}

/** 'strategy_brief' -> 'Strategy brief' — display label only; the value
 * written into the document is always the exact raw vocab token below. */
function humanizeToken(value: string): string {
  return value.length > 0 ? `${value[0]!.toUpperCase()}${value.slice(1).replace(/_/g, ' ')}` : value;
}

/** The five closed-vocabulary dropdowns in the grid; source_of_truth and the
 * two date fields are handled separately below (boolean / date shapes). */
const METADATA_ENUM_FIELDS: ReadonlyArray<{ key: string; label: string; vocab: readonly string[] }> = [
  { key: 'document_type', label: 'Document type', vocab: DOCUMENT_TYPES },
  { key: 'state', label: 'State', vocab: CONTEXT_STATES },
  { key: 'scope', label: 'Scope', vocab: CONTEXT_SCOPES },
  { key: 'authority', label: 'Authority', vocab: AUTHORITIES },
  { key: 'confidentiality', label: 'Confidentiality', vocab: CONFIDENTIALITIES },
];

/* ------------------------------------------------------------- file chip */
/* Item 13/14 helpers — real, computed-from-the-actual-file numbers only
 * (byte size from the File object, line count from the loaded text, a real
 * client-side SHA-256 of the actual bytes) — nothing here is a placeholder. */

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function sha256Hex(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** 'notes.markdown' -> 'MAR' — a short, real-derived-from-the-filename label
 * for the file-chip badge; never a fabricated file-type. */
function extLabel(name: string): string {
  const ext = name.split('.').pop() ?? '';
  return (ext || 'DOC').slice(0, 3).toUpperCase();
}

/* ---------------------------------------------------------------- checklist */

type CheckStatus = 'pass' | 'fail' | 'idle';

interface CheckResult {
  key: string;
  label: string;
  status: CheckStatus;
  problems: FieldProblem[];
}

function buildChecks(content: string): { checks: CheckResult[]; parsed: ParsedDoc | null } {
  if (!content.trim()) {
    return { checks: [], parsed: null };
  }
  const parsed = parseAndValidate(content);
  const structural = parsed.structureErrors;
  const fields = parsed.fieldErrors;
  const forField = (field: string) => fields.filter((e) => e.field === field);

  const check = (key: string, label: string, problems: FieldProblem[]): CheckResult => ({
    key,
    label,
    status: problems.length === 0 ? 'pass' : 'fail',
    problems,
  });

  const checks: CheckResult[] = [
    check('structure', "Frontmatter fences and flat 'key: value' lines", structural),
    check('document_type', 'document_type is one of the 14 template types', forField('document_type')),
    check('schema_version', "schema_version is '1.0'", forField('schema_version')),
    check('state', 'state is draft, active, superseded or archived', forField('state')),
    check('scope', 'scope is once, node, strategy, client or firm', forField('scope')),
    check('authority', 'authority is a known authority level', forField('authority')),
    check('confidentiality', 'confidentiality is client_confidential or firm_internal', forField('confidentiality')),
    check('source_of_truth', 'source_of_truth is true or false', forField('source_of_truth')),
    check('as_of', 'as_of is a real YYYY-MM-DD date', forField('as_of')),
    check('valid_until', 'valid_until is a real date or null', forField('valid_until')),
    check(
      'ids',
      'scope ids are present and real (no placeholders)',
      fields.filter((e) => ['client_id', 'strategy_id', 'node_id', 'meeting_id', 'owner', 'supersedes'].includes(e.field)),
    ),
  ];
  return { checks, parsed };
}

/* ------------------------------------------------------------------ overlay */

interface SelectedFileMeta {
  name: string;
  size: number;
  /** null while the real hash is still being computed (see sha256Hex). */
  hash: string | null;
}

export function UploadContextOverlay() {
  const navigate = useNavigate();
  const clients = useClientsLite();
  const documents = useContextDocuments();
  const upload = useUploadContextDocument();

  const [content, setContent] = useState('');
  const [fileMeta, setFileMeta] = useState<SelectedFileMeta | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileReadVersion = useRef(0);
  const [dragOver, setDragOver] = useState(false);
  /** Item 12 — File / Paste segmented toggle; both write the same `content`. */
  const [activeTab, setActiveTab] = useState<'file' | 'paste'>('file');

  const { checks, parsed } = useMemo(() => buildChecks(content), [content]);
  const failed = checks.filter((c) => c.status === 'fail');
  const documentType = parsed?.frontmatter?.document_type;
  const canUpload =
    content.trim().length > 0 && checks.length > 0 && failed.length === 0 && !upload.isPending && !fileLoading;
  const lineCount = content ? content.split(/\r?\n/).length : 0;

  /* Item 15 — read a field straight off the already-parsed frontmatter (the
   * same `parsed` the checklist uses), so the grid can never show a value
   * the checklist itself doesn't see. */
  const fm = parsed?.frontmatter ?? null;
  const fmString = (key: string): string => {
    const value = fm ? fm[key] : undefined;
    return typeof value === 'string' ? value : '';
  };
  const fmBoolString = (key: string): string => {
    const value = fm ? fm[key] : undefined;
    return typeof value === 'boolean' ? String(value) : '';
  };
  const patchField = (key: string, rawValue: string) => {
    fileReadVersion.current += 1;
    setFileLoading(false);
    setFileMeta(null);
    setContent((current) => {
      if (!rawValue) return removeFrontmatterField(current, key);
      const withField = upsertFrontmatterField(current, key, rawValue);
      // schema_version has exactly one valid value across all 14 templates
      // (validateFrontmatter: "must be '1.0'") — once the grid writes any
      // real field, keep it correct automatically rather than making the
      // user hand-type the one constant every document needs identically.
      return upsertFrontmatterField(withField, 'schema_version', '"1.0"');
    });
  };

  /* Headline for the dark Validation panel (README "Modals" → upload) —
   * grounded in the real check results, never a fabricated count. */
  const validationHeadline = !content.trim()
    ? 'Paste a document to begin'
    : failed.length > 0
      ? `${failed.length} check${failed.length === 1 ? '' : 's'} need attention`
      : 'Ready to upload';

  const clientId = fmString('client_id');
  const tooLarge = new Blob([JSON.stringify({ content, clientId: clientId || undefined })]).size > MAX_UPLOAD_MB * 1024 * 1024;

  /* Mirror the actual supersession identity: one active row, selected by an
   * explicit document_id pointer or the template/scope/client/scopeRef tuple. */
  const superseded = useMemo(() => {
    const frontmatter = parsed?.frontmatter;
    if (typeof documentType !== 'string' || frontmatter?.state !== 'active') return [];
    const scopeRef = frontmatter.scope === 'strategy' ? frontmatter.strategy_id ?? null
      : frontmatter.scope === 'node' ? frontmatter.node_id ?? null : null;
    const explicit = typeof frontmatter.supersedes === 'string' ? frontmatter.supersedes : null;
    return (documents.data ?? []).filter((doc) =>
      doc.templateKey.slice(3) === documentType && doc.state === 'active' &&
      (explicit ? doc.frontmatter?.document_id === explicit :
        doc.scope === frontmatter.scope && doc.clientId === (clientId || null) && doc.scopeRef === scopeRef),
    ).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 1);
  }, [documents.data, documentType, parsed, clientId]);

  const serverError = useMemo(() => {
    if (!upload.isError) return null;
    return parseUploadError(upload.error);
  }, [upload.isError, upload.error]);

  const readFile = (file: File | undefined) => {
    if (!file) return;
    const version = ++fileReadVersion.current;
    setFileError(null);
    setContent('');
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
      setFileMeta(null);
      setFileLoading(false);
      setFileError(`The upload must be smaller than ${MAX_UPLOAD_MB} MB.`);
      return;
    }
    setFileLoading(true);
    setFileMeta({ name: file.name, size: file.size, hash: null });
    void file.text().then((text) => {
      if (fileReadVersion.current !== version) return;
      setContent(text);
      setFileLoading(false);
    }).catch(() => {
      if (fileReadVersion.current !== version) return;
      setFileLoading(false);
      setFileMeta(null);
      setFileError('The selected file could not be read. Choose it again or paste its content.');
    });
    // Real client-side hash of the actual bytes, filled in once ready — the
    // chip shows "Hashing…" (item 13) until then rather than a fabricated
    // placeholder value.
    void sha256Hex(file).then((hash) => {
      if (fileReadVersion.current !== version) return;
      setFileMeta((current) => current ? { ...current, hash } : current);
    }).catch(() => {
      if (fileReadVersion.current !== version) return;
      setFileMeta((current) => current ? { ...current, hash: '' } : current);
    });
  };

  const clearFile = () => {
    fileReadVersion.current += 1;
    setFileLoading(false);
    setFileError(null);
    setFileMeta(null);
    setContent('');
  };

  const submit = () => {
    if (!canUpload || tooLarge) return;
    upload.mutate(
      { content, clientId: clientId || undefined },
      {
        onSuccess: (doc) => navigate(`/strategies/context/${doc.id}`),
      },
    );
  };

  const clientOptions = [
    { value: '', label: clients.isLoading ? 'Loading clients…' : 'Firm-wide (no client)' },
    ...(clients.data ?? []).map((client) => ({ value: client.id, label: client.name })),
  ];

  return (
    <StrategiesModalShell
      eyebrow="Upload context"
      title="Add a context document"
      subtitle="Markdown with its front-matter block. The checklist mirrors the server validator — every check must pass before upload."
      closeTo="/strategies/context"
      maxWidth={960}
      dirty={content.trim().length > 0 && !upload.isPending}
      primaryLabel="Upload document"
      onPrimary={submit}
      primaryDisabled={!canUpload || tooLarge}
      primaryBusy={upload.isPending}
      footerNote="The server re-validates on upload; a document that fails is not saved."
    >
      {fileError || tooLarge ? (
        <p className="st-modal__alert" role="alert">{tooLarge ? `The upload body must be smaller than ${MAX_UPLOAD_MB} MB.` : fileError}</p>
      ) : null}
      {serverError ? (
        <div className="st-modal__alert" role="alert">
          <p style={{ margin: 0 }}>{serverError.general}</p>
          {serverError.fields.length > 0 ? (
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {serverError.fields.map((field, index) => (
                <li key={`${field.field}-${index}`}>
                  <span className="st-mono">{field.field}</span>: {field.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="st-cols">
        <div style={{ minWidth: 0 }}>
          {/* Item 12: File / Paste — .st-seg was fully styled in modal-shell.css
           * but never wired to any state; the dropzone and the paste textarea
           * used to render stacked, always both visible. Now exactly one
           * shows, driven by this tab. */}
          <div className="st-seg" role="tablist" aria-label="Add content by">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'file'}
              onClick={() => setActiveTab('file')}
            >
              File
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'paste'}
              onClick={() => setActiveTab('paste')}
            >
              Paste
            </button>
          </div>

          {activeTab === 'file' ? (
            <div
              className={`st-dropzone${dragOver ? ' is-over' : ''}`}
              onDragOver={(event) => {
                event.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragOver(false);
                readFile(event.dataTransfer.files?.[0]);
              }}
            >
              <span aria-hidden="true" style={{ display: 'flex', justifyContent: 'center', color: 'var(--st-gray-400)', marginBottom: 8 }}>
                <CapiroDownloadIcon style={{ width: 22, height: 22 }} />
              </span>
              <p className="st-dropzone__title">Drop a .md file, or paste below</p>
              {fileMeta ? (
                /* Item 13: the selected-file chip — replaces the plain helper
                 * sentence once a file is chosen. */
                <div className="st-filechip" style={{ textAlign: 'left' }}>
                  <span className="st-filechip__badge" aria-hidden="true">
                    {extLabel(fileMeta.name)}
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span
                      className="st-filechip__name st-mono"
                      style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      {fileMeta.name}
                    </span>
                    <span className="st-filechip__meta st-mono" style={{ display: 'block' }}>
                      {formatBytes(fileMeta.size)} · {lineCount} line{lineCount === 1 ? '' : 's'} ·{' '}
                      {fileMeta.hash ? `sha256:${fileMeta.hash.slice(0, 10)}…` : fileMeta.hash === null ? 'Hashing…' : 'Hash unavailable'}
                    </span>
                  </span>
                  <CapiroIconButton label="Remove selected file" icon={<CloseGlyph size={14} />} onClick={clearFile} />
                </div>
              ) : (
                <p className="st-dropzone__sub">
                  The document must start with a --- front-matter block. Maximum size {MAX_UPLOAD_MB} MB.
                </p>
              )}
              <label className="capiro-button capiro-button--secondary capiro-button--compact capiro-elevation-control" style={{ cursor: 'pointer' }}>
                Choose file
                <input
                  type="file"
                  accept=".md,.markdown,.txt,text/markdown,text/plain"
                  style={{ display: 'none' }}
                  onChange={(event) => readFile(event.target.files?.[0])}
                />
              </label>
            </div>
          ) : (
            <label className="capiro-field">
              <span className="capiro-field__label">Document · Required</span>
              <textarea
                className="st-textarea st-mono"
                style={{ minHeight: 220 }}
                value={content}
                onChange={(event) => {
                  fileReadVersion.current += 1;
                  setFileLoading(false);
                  setFileMeta(null);
                  setFileError(null);
                  setContent(event.target.value);
                }}
                placeholder={'---\ndocument_type: strategy_brief\nschema_version: "1.0"\n…\n---\n'}
                spellCheck={false}
              />
            </label>
          )}

          <div className="st-field-stack" style={{ marginTop: 16 }}>
            <div>
              <p className="st-panel__label" style={{ marginBottom: 8 }}>
                Document metadata
              </p>
              <div className="st-field-row">
                {METADATA_ENUM_FIELDS.map((field) => (
                  <CapiroSelect
                    key={field.key}
                    label={field.label}
                    value={fmString(field.key)}
                    onChange={(event) => patchField(field.key, event.target.value)}
                    options={[
                      { value: '', label: `Select ${field.label.toLowerCase()}` },
                      ...field.vocab.map((v) => ({ value: v, label: humanizeToken(v) })),
                    ]}
                  />
                ))}
                <CapiroSelect
                  label="Source of truth"
                  value={fmBoolString('source_of_truth')}
                  onChange={(event) => patchField('source_of_truth', event.target.value)}
                  options={[
                    { value: '', label: 'Select source of truth' },
                    { value: 'true', label: 'True' },
                    { value: 'false', label: 'False' },
                  ]}
                />
                <label className="capiro-field">
                  <span className="capiro-field__label">as_of</span>
                  <input
                    className="capiro-input"
                    type="date"
                    value={fmString('as_of')}
                    onChange={(event) => patchField('as_of', event.target.value)}
                  />
                </label>
                <label className="capiro-field">
                  <span className="capiro-field__label">valid_until</span>
                  <input
                    className="capiro-input"
                    type="date"
                    value={fmString('valid_until')}
                    onChange={(event) => patchField('valid_until', event.target.value)}
                  />
                </label>
              </div>
              <p className="st-ns__note">Selecting a value writes the matching line directly into the document.</p>
            </div>
            <CapiroSelect
              label="Client · Optional"
              value={clientId}
              onChange={(event) => patchField('client_id', event.target.value || 'null')}
              options={clientOptions}
            />
          </div>
        </div>

        <aside className="st-dark-panel" style={{ minWidth: 0 }}>
          <p className="st-dark-panel__label">Validation</p>
          <p className="st-dark-panel__title">{validationHeadline}</p>
          {content.trim() ? (
            /* Literal `uploadChecks` wrapper: `gap:12px` between rows (the
               rows themselves carry no padding — see `.st-check`). */
            <div style={{ display: 'grid', gap: 12, marginTop: 12 }}>
              {checks.map((checkResult) => (
                <div className="st-check" key={checkResult.key}>
                  <span className={`st-check__icon st-check__icon--${checkResult.status}`} aria-hidden="true">
                    {checkResult.status === 'pass' ? '✓' : '!'}
                  </span>
                  <span>
                    <span className="st-check__label">{checkResult.label}</span>
                    {checkResult.problems.length > 0 ? (
                      <span className="st-check__desc is-fail" style={{ display: 'block' }}>
                        {checkResult.problems.map((p) => `${p.field}: ${p.message}`).join(' · ')}
                      </span>
                    ) : null}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="st-dark-panel__text" style={{ marginTop: 12 }}>
              Paste a document to run the checks.
            </p>
          )}
        </aside>
      </div>

      {typeof documentType === 'string' && DOCUMENT_TYPES.includes(documentType as never) ? (
        <div className="st-panel" style={{ marginTop: 16 }}>
          <p className="st-panel__label">Supersession preview</p>
          {documents.isLoading ? (
            <span className="st-check__desc">Checking existing documents…</span>
          ) : documents.isError ? (
            <span className="st-check__desc">Existing documents could not be checked. The server will validate supersession on upload.</span>
          ) : fmString('state') !== 'active' ? (
            <span className="st-check__desc">This upload is not active and will not supersede an existing document.</span>
          ) : superseded.length === 0 ? (
            <span className="st-check__desc">
              {fmString('supersedes')
                ? 'The explicit supersedes target was not found among the loaded active documents. The server will validate it on upload.'
                : 'No active document matching this scope was found in the loaded library.'}
            </span>
          ) : (
            <>
              <span className="st-check__desc" style={{ display: 'block', marginBottom: 8 }}>
                If its content has changed, this active upload supersedes {superseded.length} existing{' '}
                <span className="st-mono">{documentType}</span> document
                {superseded.length === 1 ? '' : 's'}:
              </span>
              {/* Item 16: spec wants "vN · active → vN+1 · active" with an
               * arrow between the current and new version. Context documents
               * carry no version-counter field anywhere in the API (the same
               * gap ContextDocumentVNext.tsx documents for its own metastrip:
               * "there is no version counter... so this shows the one real
               * [value] instead of a fabricated one") — so this shows the one
               * real state transition instead: the existing document's actual
               * state -> this upload's actual state (from the metadata grid
               * above), with the same arrow treatment and using the
               * pre-existing bare-arrow convention this module already uses
               * for a before/after pair (see the FY·Q range a few rows up in
               * FirmPhasesOverlay.tsx) rather than a new icon import. */}
              {superseded.map((doc) => (
                <div className="st-change-row" key={doc.id}>
                  <span className="st-change-row__field st-mono">{doc.templateKey}</span>
                  <span>{doc.title}</span>
                  <span className="st-mono" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--st-gray-600)' }}>
                    {doc.state}
                    <span aria-hidden="true">→</span>
                    superseded
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--st-gray-500)' }}>
                    {clientName(clients.data, doc.clientId)}
                  </span>
                </div>
              ))}
            </>
          )}
        </div>
      ) : null}
    </StrategiesModalShell>
  );
}
