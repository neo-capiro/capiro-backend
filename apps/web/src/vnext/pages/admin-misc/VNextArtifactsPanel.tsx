/**
 * vNext re-skin of pages/actions/ArtifactsPanel.tsx — the Step 3.3 "Artifacts"
 * sub-section hosted inside an action card (plan §18). Identical hooks
 * (artifacts-api.js reused verbatim): Generate menu over the 6 ArtifactTypes
 * with the card's suggestion as default, the artifact list (title + type badge
 * + version + dropped count), and the viewer drawer with copy / .docx download
 * / inline edit (PATCH bodyText, "edited" indicator on version > 1). Lazy
 * fetch gating is owned by the parent via `enabled`, exactly like canonical.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  useActionArtifacts,
  useExportArtifactDocx,
  useGenerateArtifact,
  useUpdateArtifact,
  type GeneratedArtifact,
} from '../../../pages/actions/artifacts-api.js';
import { ARTIFACT_TYPE_LABELS, type ArtifactType } from '../../../pages/actions/types.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { CapiroSkeleton } from '../../components/feedback/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { CapiroMenu, CapiroPopover } from '../../components/menus/index.js';
import { CapiroDrawer } from '../../components/overlays/index.js';
import { SvTextArea } from '../settings/settings-ui.js';

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
 * The viewer/editor drawer for a single artifact. Renders bodyText (monospace,
 * line breaks preserved), a copy button, and an inline edit mode that PATCHes
 * bodyText.
 */
function VNextArtifactViewer({
  artifact,
  actionId,
  onClose,
}: {
  artifact: GeneratedArtifact;
  actionId: string;
  onClose: () => void;
}) {
  const toast = useCapiroToast();
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
      toast.success('Copied to clipboard');
    } catch {
      toast.error('Could not copy to clipboard');
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
          toast.success('Artifact updated');
          setEditing(false);
        },
        onError: (err) => toast.error(err.message || 'Could not save artifact'),
      },
    );
  }

  function handleDownload() {
    exportDocx.mutate(
      { artifactId: artifact.id, filenameHint: artifact.title || artifactTypeLabel(artifact) },
      { onError: (err) => toast.error(err.message || 'Could not download .docx') },
    );
  }

  return (
    <CapiroDrawer
      open
      title={artifact.title || artifactTypeLabel(artifact)}
      onClose={onClose}
    >
      <div className="stv-stack" data-testid="artifact-viewer">
        <div className="stv-row" style={{ gap: 6 }}>
          <CapiroBadge>{artifactTypeLabel(artifact)}</CapiroBadge>
          <CapiroBadge tone="info">v{version}</CapiroBadge>
          {isEdited ? <CapiroBadge tone="info">edited</CapiroBadge> : null}
        </div>

        <div className="stv-row">
          <CapiroButton size="compact" onClick={() => void handleCopy()}>
            Copy
          </CapiroButton>
          {editing ? (
            <>
              <CapiroButton size="compact" onClick={cancelEdit} disabled={updateArtifact.isPending}>
                Cancel
              </CapiroButton>
              <CapiroButton
                size="compact"
                variant="primary"
                onClick={saveEdit}
                loading={updateArtifact.isPending}
                disabled={!draft.trim() || updateArtifact.isPending}
              >
                Save
              </CapiroButton>
            </>
          ) : (
            <>
              <CapiroButton
                size="compact"
                onClick={handleDownload}
                loading={exportDocx.isPending}
              >
                Download .docx
              </CapiroButton>
              <CapiroButton size="compact" onClick={startEdit}>
                Edit
              </CapiroButton>
            </>
          )}
        </div>

        {dropped > 0 ? (
          <span className="stv-warning-text stv-small">
            {dropped} paragraph{dropped === 1 ? '' : 's'} dropped as unsourced
          </span>
        ) : null}

        {editing ? (
          <SvTextArea
            aria-label="Artifact body"
            rows={18}
            value={draft}
            onChange={setDraft}
          />
        ) : (
          <pre className="amx-artifact-body" data-testid="artifact-body">
            {artifact.bodyText ?? ''}
          </pre>
        )}
      </div>
    </CapiroDrawer>
  );
}

/**
 * The artifacts body — rendered ONLY when the parent has expanded the section (it owns the
 * lazy-fetch gate via the `enabled` prop on the query). Renders loading / error / empty / data,
 * the Generate menu, and the viewer drawer.
 */
export function VNextArtifactsPanel({
  actionId,
  suggestedArtifactType,
  enabled,
}: {
  actionId: string;
  suggestedArtifactType: ArtifactType | null;
  enabled: boolean;
}) {
  const toast = useCapiroToast();
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
          toast.success(`Generated ${ARTIFACT_TYPE_LABELS[type] ?? type}`);
          // Surface the freshly generated artifact straight into the viewer (held locally so
          // it shows even before the list query refetches it in).
          setJustGenerated(artifact);
          setOpenArtifactId(artifact.id);
        },
        onError: (err) => toast.error(err.message || 'Could not generate artifact'),
      },
    );
  }

  return (
    <div className="amx-subsection-body" data-testid="artifacts-panel">
      <div className="stv-row">
        <CapiroPopover
          label="Generate artifact"
          trigger={
            <span className="capiro-button capiro-button--primary capiro-button--compact">
              Generate…
            </span>
          }
        >
          <CapiroMenu
            label="Artifact type"
            items={ARTIFACT_TYPE_ORDER.map((t) => ({
              id: t,
              label:
                t === defaultType
                  ? `${ARTIFACT_TYPE_LABELS[t]} (suggested)`
                  : ARTIFACT_TYPE_LABELS[t],
              disabled: generate.isPending,
              onSelect: () => handleGenerate(t),
            }))}
          />
        </CapiroPopover>
        <CapiroButton
          size="compact"
          onClick={() => handleGenerate(defaultType)}
          loading={generate.isPending}
          disabled={generate.isPending}
        >
          Generate {ARTIFACT_TYPE_LABELS[defaultType]}
        </CapiroButton>
      </div>

      {isLoading ? (
        <div className="stv-stack stv-stack--tight" aria-label="Loading artifacts">
          <CapiroSkeleton height={14} width="50%" />
          <CapiroSkeleton height={14} width="30%" />
        </div>
      ) : isError ? (
        <span className="stv-danger-text">
          {(error as Error)?.message || 'Could not load artifacts.'}
        </span>
      ) : artifacts.length ? (
        <div className="stv-stack stv-stack--tight">
          {artifacts.map((artifact) => {
            const dropped = rejectedCount(artifact);
            return (
              <button
                type="button"
                key={artifact.id}
                className="amx-artifact-row"
                onClick={() => setOpenArtifactId(artifact.id)}
              >
                <span className="stv-row" style={{ gap: 6, minWidth: 0 }}>
                  <span className="stv-strong">{artifact.title || artifactTypeLabel(artifact)}</span>
                </span>
                <span className="stv-row" style={{ gap: 4 }}>
                  <CapiroBadge>{artifactTypeLabel(artifact)}</CapiroBadge>
                  <CapiroBadge tone="info">v{artifactVersion(artifact)}</CapiroBadge>
                  {dropped > 0 ? <CapiroBadge tone="warning">{dropped} dropped</CapiroBadge> : null}
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <span className="stv-muted">No artifacts generated yet — use Generate above.</span>
      )}

      {openArtifact ? (
        <VNextArtifactViewer
          artifact={openArtifact}
          actionId={actionId}
          onClose={() => setOpenArtifactId(null)}
        />
      ) : null}
    </div>
  );
}
