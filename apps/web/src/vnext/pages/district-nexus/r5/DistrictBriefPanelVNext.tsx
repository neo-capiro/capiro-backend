/**
 * R5 District Brief — collapsible drawer panel content.
 *
 * Rendered INSIDE a DnxSection wrapper in DistrictNexusDrawerVNext.
 * Preview → edit (per-section textareas, reset to draft) → Export .docx →
 * Save to client. Mounted only when district_nexus_r5_brief is enabled
 * AND a client is selected.
 */

import { useState, useCallback } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import { CapiroSkeleton, CapiroErrorState } from '../../components/feedback/index.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge } from '../../components/badges/index.js';
import {
  getDistrictBrief,
  exportDistrictBriefDocx,
  saveDistrictBrief,
  type R5Brief,
  type R5BriefSection,
  type R5Fact,
  type R5BriefSaveInput,
  type R5BriefSaveResult,
} from './r5-api.js';

// ── Chip helpers ────────────────────────────────────────────────────────────

function sourceLabel(f: R5Fact): string {
  const parts: string[] = [f.source.label];
  if (f.asOf.date) parts.push(f.asOf.date.slice(0, 10));
  else if (f.asOf.fiscalYear) parts.push(`FY${f.asOf.fiscalYear}`);
  return parts.join(' \u00b7 ');
}

function basisTone(basis: string): 'info' | 'neutral' {
  return basis === 'verified_client_nexus' ? 'info' : 'neutral';
}

// ── Component ───────────────────────────────────────────────────────────────

interface Props {
  clientId: string;
  state: string;
  district: string;
}

export function DistrictBriefPanelVNext({ clientId, state, district }: Props) {
  const api = useApi();
  const [editing, setEditing] = useState(false);
  const [editedSections, setEditedSections] = useState<R5BriefSection[] | null>(null);
  const [saveResult, setSaveResult] = useState<R5BriefSaveResult | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const brief = useQuery<R5Brief>({
    queryKey: ['district-nexus', 'r5', 'brief', clientId, state, district],
    queryFn: () => getDistrictBrief(api, clientId, state, district),
    enabled: Boolean(clientId && state && district),
    retry: false,
    staleTime: 60_000,
  });

  const exportMut = useMutation({
    mutationFn: (sections: R5BriefSection[]) => {
      const factIds = sections.flatMap((s) => s.factIds);
      const input: R5BriefSaveInput = {
        clientId,
        state,
        district,
        sections: sections.map((s) => ({ key: s.key, title: s.title, paragraphs: s.paragraphs })),
        factIds: [...new Set(factIds)],
      };
      return exportDistrictBriefDocx(api, input);
    },
    onSuccess: (blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `district-brief-${state}-${district}.docx`;
      a.click();
      URL.revokeObjectURL(url);
    },
  });

  const saveMut = useMutation({
    mutationFn: (sections: R5BriefSection[]) => {
      const factIds = sections.flatMap((s) => s.factIds);
      const input: R5BriefSaveInput = {
        clientId,
        state,
        district,
        sections: sections.map((s) => ({ key: s.key, title: s.title, paragraphs: s.paragraphs })),
        factIds: [...new Set(factIds)],
      };
      return saveDistrictBrief(api, input);
    },
    onSuccess: (result) => {
      setSaveResult(result);
      setSaveError(null);
    },
    onError: (err: Error) => {
      setSaveError(err.message);
    },
  });

  const resetEdits = useCallback(() => {
    if (brief.data) {
      setEditedSections(structuredClone(brief.data.sections));
    }
  }, [brief.data]);

  const sections = editedSections ?? brief.data?.sections ?? [];

  // ── Loading ──────────────────────────────────────────────────────────────

  if (brief.isPending) {
    return (
      <>
        <CapiroSkeleton height={14} width="55%" />
        <CapiroSkeleton height={14} width="80%" />
        <CapiroSkeleton height={14} width="68%" />
        <CapiroSkeleton height={14} />
      </>
    );
  }

  // ── Error ────────────────────────────────────────────────────────────────

  if (brief.isError) {
    const status = (brief.error as { response?: { status?: number } })?.response?.status;
    if (status === 404) {
      return (
        <div className="dnx-hint dnx-info">
          District brief is not enabled for this tenant.
        </div>
      );
    }
    return (
      <CapiroErrorState
        title="District Brief could not load"
        description="This is an error, not an empty result."
      />
    );
  }

  const d = brief.data;
  if (!d) return null;

  return (
    <div className="dnx-brief">
      {/* ── Toolbar ──────────────────────────────────────────────────────── */}
      <div className="dnx-brief-toolbar">
        {editing ? (
          <>
            <CapiroButton
              size="xs"
              tone="primary"
              onClick={() => setEditing(false)}
            >
              Done editing
            </CapiroButton>
            <CapiroButton size="xs" tone="neutral" onClick={resetEdits}>
              Reset to draft
            </CapiroButton>
          </>
        ) : (
          <CapiroButton
            size="xs"
            tone="neutral"
            onClick={() => {
              setEditedSections(structuredClone(d.sections));
              setEditing(true);
            }}
          >
            Edit
          </CapiroButton>
        )}
        <CapiroButton
          size="xs"
          tone="neutral"
          disabled={exportMut.isPending}
          onClick={() => exportMut.mutate(sections)}
        >
          {exportMut.isPending ? 'Exporting...' : 'Export .docx'}
        </CapiroButton>
        <CapiroButton
          size="xs"
          tone="primary"
          disabled={saveMut.isPending}
          onClick={() => saveMut.mutate(sections)}
        >
          {saveMut.isPending ? 'Saving...' : 'Save to client'}
        </CapiroButton>
      </div>

      {/* ── Save result ──────────────────────────────────────────────────── */}
      {saveResult ? (
        <div className="dnx-hint dnx-info" style={{ marginBottom: 10 }}>
          Saved as <strong>{saveResult.fileName}</strong> (ID: {saveResult.attachmentId.slice(0, 8)}...)
        </div>
      ) : null}
      {saveError ? (
        <div className="dnx-hint dnx-warning" style={{ marginBottom: 10 }}>
          Save failed: {saveError}
        </div>
      ) : null}

      {/* ── Sections ─────────────────────────────────────────────────────── */}
      {sections.map((section) => {
        const sectionFacts = d.facts.filter((f) => section.factIds.includes(f.id));
        return (
          <div key={section.key} className="dnx-brief-section">
            <h5>{section.title}</h5>

            {editing ? (
              <textarea
                className="dnx-brief-textarea"
                rows={Math.max(3, section.paragraphs.length + 1)}
                value={section.paragraphs.join('\n')}
                onChange={(e) => {
                  const next = sections.map((s) =>
                    s.key === section.key
                      ? { ...s, paragraphs: e.target.value.split('\n').filter(Boolean) }
                      : s,
                  );
                  setEditedSections(next);
                }}
              />
            ) : (
              section.paragraphs.map((p, i) => (
                <p key={i}>{p}</p>
              ))
            )}

            {/* Source chips */}
            {sectionFacts.length > 0 ? (
              <div className="dnx-brief-chips">
                {sectionFacts.map((f) => (
                  <CapiroBadge key={f.id} tone={basisTone(f.basis)}>
                    {sourceLabel(f)}
                    {f.coverage === 'partial' ? ' · partial' : ''}
                    {f.basis === 'verified_client_nexus' ? ' · verified' : ' · public context'}
                  </CapiroBadge>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}

      {/* ── Source health ────────────────────────────────────────────────── */}
      {d.sourceHealth.length > 0 ? (
        <div className="dnx-prov" style={{ marginTop: 12 }}>
          {d.sourceHealth.map((f) => (
            <span key={f.source}>
              <b>{f.label}</b>{' '}
              {f.freshnessUnavailable
                ? 'unknown'
                : f.neverSynced
                  ? 'never synced'
                  : f.lastSyncedAt
                    ? new Date(f.lastSyncedAt).toLocaleDateString('en-US')
                    : 'unknown'}
            </span>
          ))}
        </div>
      ) : null}

      {/* ── Generated at ─────────────────────────────────────────────────── */}
      <div className="dnx-muted" style={{ fontSize: 11, marginTop: 8 }}>
        Generated {new Date(d.generatedAt).toLocaleString('en-US')}
      </div>
    </div>
  );
}