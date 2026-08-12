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
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CapiroSelect } from '../../../components/fields/index.js';
import { parseUploadError } from '../../../../pages/strategy/context/context-utils.js';
import { clientName, useClientsLite, useContextDocuments, useUploadContextDocument } from '../strategies-api.js';
import { StrategiesModalShell } from './StrategiesModalShell.js';

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

export function UploadContextOverlay() {
  const navigate = useNavigate();
  const clients = useClientsLite();
  const documents = useContextDocuments();
  const upload = useUploadContextDocument();

  const [content, setContent] = useState('');
  const [clientId, setClientId] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const { checks, parsed } = useMemo(() => buildChecks(content), [content]);
  const failed = checks.filter((c) => c.status === 'fail');
  const documentType = parsed?.frontmatter?.document_type;
  const canUpload =
    content.trim().length > 0 && checks.length > 0 && failed.length === 0 && !upload.isPending;

  /* Supersession preview: existing documents of the same template type
   * (templateKey is "NN_<document_type>"). */
  const superseded = useMemo(() => {
    if (typeof documentType !== 'string' || !DOCUMENT_TYPES.includes(documentType as never)) return [];
    return (documents.data ?? []).filter(
      (doc) => doc.templateKey.slice(3) === documentType && doc.state !== 'archived',
    );
  }, [documents.data, documentType]);

  const serverError = useMemo(() => {
    if (!upload.isError) return null;
    return parseUploadError(upload.error);
  }, [upload.isError, upload.error]);

  const readFile = (file: File | undefined) => {
    if (!file) return;
    setFileName(file.name);
    void file.text().then(setContent);
  };

  const submit = () => {
    if (!canUpload) return;
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
      size="lg"
      dirty={content.trim().length > 0 && !upload.isPending}
      primaryLabel="Upload document"
      onPrimary={submit}
      primaryDisabled={!canUpload}
      primaryBusy={upload.isPending}
      footerNote="The server re-validates on upload; a document that fails is not saved."
    >
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
        <p className="st-dropzone__title">Drop a .md file, or paste below</p>
        <p className="st-dropzone__sub">
          {fileName
            ? `Loaded ${fileName} — the editor below holds its text.`
            : 'The document must start with a --- front-matter block.'}
        </p>
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

      <div className="st-field-stack" style={{ marginTop: 16 }}>
        <label className="capiro-field">
          <span className="capiro-field__label">Document · Required</span>
          <textarea
            className="st-textarea st-mono"
            style={{ minHeight: 180 }}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder={'---\ndocument_type: strategy_brief\nschema_version: "1.0"\n…\n---\n'}
            spellCheck={false}
          />
        </label>
        <CapiroSelect
          label="Client · Optional"
          value={clientId}
          onChange={(event) => setClientId(event.target.value)}
          options={clientOptions}
        />
      </div>

      {content.trim() ? (
        <div style={{ marginTop: 16 }}>
          <p className="st-panel__label">Validation</p>
          {checks.map((checkResult) => (
            <div className="st-check" key={checkResult.key}>
              <span className={`st-check__icon st-check__icon--${checkResult.status}`} aria-hidden="true">
                {checkResult.status === 'pass' ? '✓' : checkResult.status === 'fail' ? '!' : '·'}
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
        <div style={{ marginTop: 16 }}>
          <p className="st-panel__label">Validation</p>
          <div className="st-check">
            <span className="st-check__icon st-check__icon--idle" aria-hidden="true">
              ·
            </span>
            <span className="st-check__desc">Paste a document to run the checks.</span>
          </div>
        </div>
      )}

      {typeof documentType === 'string' && DOCUMENT_TYPES.includes(documentType as never) ? (
        <div className="st-panel" style={{ marginTop: 16 }}>
          <p className="st-panel__label">Supersession preview</p>
          {documents.isLoading ? (
            <span className="st-check__desc">Checking existing documents…</span>
          ) : superseded.length === 0 ? (
            <span className="st-check__desc">
              No existing <span className="st-mono">{documentType}</span> document — this upload adds
              the first one.
            </span>
          ) : (
            <>
              <span className="st-check__desc" style={{ display: 'block', marginBottom: 8 }}>
                This upload supersedes {superseded.length} existing{' '}
                <span className="st-mono">{documentType}</span> document
                {superseded.length === 1 ? '' : 's'}:
              </span>
              {superseded.map((doc) => (
                <div className="st-change-row" key={doc.id}>
                  <span className="st-change-row__field st-mono">{doc.templateKey}</span>
                  <span>{doc.title}</span>
                  <span style={{ fontSize: 12, color: 'var(--st-gray-500)' }}>
                    {clientName(clients.data, doc.clientId)} · {doc.state}
                  </span>
                  <span />
                </div>
              ))}
            </>
          )}
        </div>
      ) : null}
    </StrategiesModalShell>
  );
}
