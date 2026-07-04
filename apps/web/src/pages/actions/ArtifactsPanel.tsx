/**
 * ArtifactsPanel — the Step 3.3 "Artifacts" sub-section hosted inside an ActionCard (plan §18).
 *
 * Renders:
 *   - a "Generate" dropdown over the 6 ArtifactTypes (the card's suggestedArtifactType is the
 *     highlighted default) -> POSTs and, on success, surfaces the new artifact + a success toast.
 *   - the list of existing artifacts for the action (title + type badge + version). Clicking a
 *     row opens the viewer Drawer.
 *
 * The viewer Drawer renders the artifact bodyText verbatim (monospace, line breaks preserved),
 * a copy-to-clipboard button, and an EDIT mode (textarea -> PATCH bodyText) with an "edited"
 * indicator + version. If metadata.verification.rejected is non-empty, a subtle note reports
 * how many paragraph(s) were dropped as unsourced.
 *
 * Lazily fetched: the parent only mounts/enables this once the user expands the section, so the
 * board never fires one artifacts request per card. Every nested read is Array.isArray / null
 * guarded — a thin or malformed payload renders an honest empty state, never a crash.
 */
import { useEffect, useMemo, useState } from 'react';
import { App as AntApp, Button, Drawer, Dropdown, Input, Space, Spin, Tag, Typography } from 'antd';
import {
  CopyOutlined,
  DownloadOutlined,
  EditOutlined,
  FileTextOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import {
  useActionArtifacts,
  useExportArtifactDocx,
  useGenerateArtifact,
  useUpdateArtifact,
  type GeneratedArtifact,
} from './artifacts-api.js';
import { ARTIFACT_TYPE_LABELS, type ArtifactType } from './types.js';

const { Text, Title } = Typography;

/** The full generation menu — superset of the card's suggestion (includes client_email). */
const ARTIFACT_TYPE_ORDER: ArtifactType[] = [
  'internal_brief',
  'client_email',
  'member_one_pager',
  'committee_staff_memo',
  'talking_points',
  'procurement_watch_note',
];

/** A human label for an artifact's type, derived from metadata (falls back to the kind string). */
function artifactTypeLabel(artifact: GeneratedArtifact): string {
  const t = artifact.metadata?.artifactType;
  if (t && ARTIFACT_TYPE_LABELS[t]) return ARTIFACT_TYPE_LABELS[t];
  // kind is `artifact_<type>` — strip the prefix as a last resort.
  return artifact.kind?.replace(/^artifact_/, '') || 'Artifact';
}

function artifactVersion(artifact: GeneratedArtifact): number {
  const v = artifact.metadata?.version;
  return typeof v === 'number' && Number.isFinite(v) ? v : 1;
}

function rejectedCount(artifact: GeneratedArtifact): number {
  const rejected = artifact.metadata?.verification?.rejected;
  return Array.isArray(rejected) ? rejected.length : 0;
}

/**
 * The viewer/editor Drawer for a single artifact. Renders bodyText (monospace, line breaks
 * preserved), a copy button, and an inline edit mode that PATCHes bodyText.
 */
function ArtifactViewer({
  artifact,
  actionId,
  onClose,
}: {
  artifact: GeneratedArtifact;
  actionId: string;
  onClose: () => void;
}) {
  const { message } = AntApp.useApp();
  const updateArtifact = useUpdateArtifact();
  const exportDocx = useExportArtifactDocx();

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(artifact.bodyText ?? '');

  // When the upstream artifact changes (e.g. the list refetched after a save bumped the
  // version), resync the read view's draft so an unopened editor reflects the latest body.
  useEffect(() => {
    if (!editing) setDraft(artifact.bodyText ?? '');
  }, [artifact.bodyText, editing]);

  const version = artifactVersion(artifact);
  const dropped = rejectedCount(artifact);
  // version > 1 means a human has saved at least one edit over the generated v1.
  const isEdited = version > 1;

  async function handleCopy() {
    const text = editing ? draft : (artifact.bodyText ?? '');
    try {
      await navigator.clipboard?.writeText(text);
      message.success('Copied to clipboard');
    } catch {
      message.error('Could not copy to clipboard');
    }
  }

  function startEdit() {
    setDraft(artifact.bodyText ?? '');
    setEditing(true);
  }

  function cancelEdit() {
    setDraft(artifact.bodyText ?? '');
    setEditing(false);
  }

  function saveEdit() {
    const next = draft;
    if (!next.trim()) return; // guarded; the server requires a non-empty body
    updateArtifact.mutate(
      { actionId, artifactId: artifact.id, bodyText: next },
      {
        onSuccess: () => {
          message.success('Artifact updated');
          setEditing(false);
        },
        onError: (err) => message.error(err.message || 'Could not save artifact'),
      },
    );
  }

  function handleDownload() {
    exportDocx.mutate(
      { artifactId: artifact.id, filenameHint: artifact.title || artifactTypeLabel(artifact) },
      { onError: (err) => message.error(err.message || 'Could not download .docx') },
    );
  }

  return (
    <Drawer
      title={
        <div className="artifact-viewer-title">
          <Title level={5} style={{ margin: 0 }}>
            {artifact.title || artifactTypeLabel(artifact)}
          </Title>
          <Space size={6} wrap>
            <Tag>{artifactTypeLabel(artifact)}</Tag>
            <Tag color="blue">v{version}</Tag>
            {isEdited ? (
              <Tag color="purple" icon={<EditOutlined />}>
                edited
              </Tag>
            ) : null}
          </Space>
        </div>
      }
      open
      width={640}
      onClose={onClose}
      data-testid="artifact-viewer"
      extra={
        <Space>
          <Button icon={<CopyOutlined />} onClick={handleCopy}>
            Copy
          </Button>
          {editing ? (
            <>
              <Button onClick={cancelEdit} disabled={updateArtifact.isPending}>
                Cancel
              </Button>
              <Button
                type="primary"
                onClick={saveEdit}
                loading={updateArtifact.isPending}
                disabled={!draft.trim() || updateArtifact.isPending}
              >
                Save
              </Button>
            </>
          ) : (
            <>
              <Button
                icon={<DownloadOutlined />}
                onClick={handleDownload}
                loading={exportDocx.isPending}
              >
                Download .docx
              </Button>
              <Button icon={<EditOutlined />} onClick={startEdit}>
                Edit
              </Button>
            </>
          )}
        </Space>
      }
    >
      {dropped > 0 ? (
        <div className="artifact-dropped-note">
          <Space size={6} align="start">
            <WarningOutlined style={{ color: '#faad14', marginTop: 2 }} />
            <Text type="secondary" style={{ fontSize: 12 }}>
              {dropped} paragraph{dropped === 1 ? '' : 's'} dropped as unsourced
            </Text>
          </Space>
        </div>
      ) : null}

      {editing ? (
        <Input.TextArea
          aria-label="Artifact body"
          className="artifact-body-editor"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoSize={{ minRows: 18 }}
        />
      ) : (
        <pre className="artifact-body" data-testid="artifact-body">
          {artifact.bodyText ?? ''}
        </pre>
      )}
    </Drawer>
  );
}

/**
 * The artifacts body — rendered ONLY when the parent has expanded the section (it owns the
 * lazy-fetch gate via the `enabled` prop on the query). Renders loading / error / empty / data,
 * the Generate dropdown, and the viewer Drawer.
 */
export function ArtifactsPanel({
  actionId,
  suggestedArtifactType,
  enabled,
}: {
  actionId: string;
  suggestedArtifactType: ArtifactType | null;
  enabled: boolean;
}) {
  const { message } = AntApp.useApp();
  const { data, isLoading, isError, error } = useActionArtifacts(actionId, enabled);
  const generate = useGenerateArtifact();

  // Which artifact is open in the viewer (by id) — re-resolved from the live list so an edit
  // that bumps the version is reflected while the drawer stays open.
  const [openArtifactId, setOpenArtifactId] = useState<string | null>(null);
  // The just-generated artifact, held so the viewer can open it immediately even before the
  // list query refetches it in (the POST returns the full artifact; the GET may lag).
  const [justGenerated, setJustGenerated] = useState<GeneratedArtifact | null>(null);

  const artifacts = Array.isArray(data) ? data : [];
  const openArtifact = useMemo(() => {
    if (!openArtifactId) return null;
    // Prefer the live list (reflects edits/version bumps); fall back to the freshly generated
    // artifact when the list hasn't caught up yet.
    return (
      artifacts.find((a) => a.id === openArtifactId) ??
      (justGenerated?.id === openArtifactId ? justGenerated : null)
    );
  }, [artifacts, openArtifactId, justGenerated]);

  // The card's suggestion is the default; otherwise fall back to internal_brief so the
  // primary action always has a sensible target.
  const defaultType: ArtifactType =
    suggestedArtifactType && ARTIFACT_TYPE_ORDER.includes(suggestedArtifactType)
      ? suggestedArtifactType
      : 'internal_brief';

  function handleGenerate(type: ArtifactType) {
    generate.mutate(
      { actionId, type },
      {
        onSuccess: (artifact) => {
          message.success(`Generated ${ARTIFACT_TYPE_LABELS[type] ?? type}`);
          // Surface the freshly generated artifact straight into the viewer (held locally so
          // it shows even before the list query refetches it in).
          setJustGenerated(artifact);
          setOpenArtifactId(artifact.id);
        },
        onError: (err) => message.error(err.message || 'Could not generate artifact'),
      },
    );
  }

  const menuItems = ARTIFACT_TYPE_ORDER.map((t) => ({
    key: t,
    label:
      t === defaultType ? (
        <span>
          {ARTIFACT_TYPE_LABELS[t]} <Text type="secondary">(suggested)</Text>
        </span>
      ) : (
        ARTIFACT_TYPE_LABELS[t]
      ),
  }));

  return (
    <div className="artifacts-panel" data-testid="artifacts-panel">
      <div className="artifacts-panel-toolbar">
        <Dropdown
          menu={{
            items: menuItems,
            onClick: ({ key }) => handleGenerate(key as ArtifactType),
          }}
          disabled={generate.isPending}
        >
          <Button
            size="small"
            type="primary"
            icon={<FileTextOutlined />}
            loading={generate.isPending}
          >
            Generate
          </Button>
        </Dropdown>
        <Button
          size="small"
          onClick={() => handleGenerate(defaultType)}
          loading={generate.isPending}
          disabled={generate.isPending}
        >
          Generate {ARTIFACT_TYPE_LABELS[defaultType]}
        </Button>
      </div>

      {isLoading ? (
        <div className="artifacts-loading">
          <Spin size="small" /> <Text type="secondary">Loading artifacts…</Text>
        </div>
      ) : isError ? (
        <Text type="danger">{(error as Error)?.message || 'Could not load artifacts.'}</Text>
      ) : artifacts.length ? (
        <div className="artifacts-list">
          {artifacts.map((artifact) => {
            const dropped = rejectedCount(artifact);
            return (
              <button
                type="button"
                key={artifact.id}
                className="artifact-row"
                onClick={() => setOpenArtifactId(artifact.id)}
              >
                <span className="artifact-row-main">
                  <FileTextOutlined />
                  <Text strong>{artifact.title || artifactTypeLabel(artifact)}</Text>
                </span>
                <span className="artifact-row-badges">
                  <Tag>{artifactTypeLabel(artifact)}</Tag>
                  <Tag color="blue">v{artifactVersion(artifact)}</Tag>
                  {dropped > 0 ? <Tag color="warning">{dropped} dropped</Tag> : null}
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <Text type="secondary">No artifacts generated yet — use Generate above.</Text>
      )}

      {openArtifact ? (
        <ArtifactViewer
          artifact={openArtifact}
          actionId={actionId}
          onClose={() => setOpenArtifactId(null)}
        />
      ) : null}
    </div>
  );
}
