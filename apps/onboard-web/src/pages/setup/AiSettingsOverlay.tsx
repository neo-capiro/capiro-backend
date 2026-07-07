// 2A — Firm AI settings (Memory Files: Firm Soul / Compass / Playbook), the
// prototype AiSettingsOverlay firm variant wired to the real memory catalog +
// /api/memory/items/:type/firm/sections GET/PUT.
import React from 'react';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { Btn, Modal, SelectInput, Spinner, obInputStyle } from '../../ui/primitives';
import { ErrorText, errorMessage } from '../funnel/shared';
import {
  useCapiroApi,
  type CapiroApi,
  type MemoryFileDef,
  type MemorySectionsFile,
} from '../../lib/capiro-api';

// The three firm-scope memory files, in prototype order. The catalog labels
// the third file 'Playbook' — the dashboard displays 'Firm Playbook' (prototype).
const FIRM_FILES = [
  { type: 'firm-soul', display: 'Firm Soul' },
  { type: 'firm-compass', display: 'Firm Compass' },
  { type: 'playbook', display: 'Firm Playbook' },
] as const;

type FirmFileType = (typeof FIRM_FILES)[number]['type'];

const sectionsKey = (type: string) => ['capiro', 'memory-sections', type] as const;

function useFirmSections(api: CapiroApi, type: FirmFileType) {
  return useQuery({
    queryKey: sectionsKey(type),
    queryFn: () => api.getFirmMemorySections(type),
    retry: false,
  });
}

/** A file counts as covered when it already holds any saved section content. */
function hasSavedContent(data: MemorySectionsFile | undefined): boolean {
  return !!data && data.exists && data.sections.some((s) => s.body.trim().length > 0);
}

export function AiSettingsOverlay({
  orgName,
  onClose,
  onComplete,
}: {
  orgName: string;
  onClose: () => void;
  /** All three files covered (saved this session or already had content). */
  onComplete: () => void;
}) {
  const api = useCapiroApi();
  const queryClient = useQueryClient();

  const catalog = useQuery({
    queryKey: ['capiro', 'memory-catalog'],
    queryFn: () => api.getMemoryCatalog(),
    staleTime: 5 * 60_000,
    retry: false,
  });

  const soul = useFirmSections(api, 'firm-soul');
  const compass = useFirmSections(api, 'firm-compass');
  const playbook = useFirmSections(api, 'playbook');
  const queriesByType: Record<FirmFileType, UseQueryResult<MemorySectionsFile>> = {
    'firm-soul': soul,
    'firm-compass': compass,
    playbook,
  };

  const [type, setType] = React.useState<FirmFileType>('firm-soul');
  // Local edits, keyed type → section key. Unedited fields fall back to the
  // fetched body, so prefill needs no effect and refetches never clobber edits.
  const [drafts, setDrafts] = React.useState<Record<string, Record<string, string>>>({});
  const [savedTypes, setSavedTypes] = React.useState<ReadonlySet<string>>(new Set());
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const current = queriesByType[type];
  const def: MemoryFileDef | undefined = catalog.data?.find((f) => f.type === type);
  const bodyByKey = new Map((current.data?.sections ?? []).map((s) => [s.key, s.body]));
  const fieldValue = (key: string) => drafts[type]?.[key] ?? bodyByKey.get(key) ?? '';

  const isCovered = (t: FirmFileType, saved: ReadonlySet<string>) =>
    saved.has(t) || hasSavedContent(queriesByType[t].data);

  const save = async () => {
    if (saving || !def) return;
    setSaving(true);
    setError(null);
    try {
      await api.putFirmMemorySections(
        type,
        def.sections.map((s) => ({ key: s.key, body: fieldValue(s.key) })),
      );
      await queryClient.invalidateQueries({ queryKey: sectionsKey(type) });
      const nextSaved = new Set(savedTypes).add(type);
      setSavedTypes(nextSaved);
      if (FIRM_FILES.every((f) => isCovered(f.type, nextSaved))) {
        onComplete();
        return;
      }
      // Auto-advance to the next file that still needs content.
      const next = FIRM_FILES.find((f) => !isCovered(f.type, nextSaved));
      if (next) setType(next.type);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const displayFor = (t: FirmFileType) => FIRM_FILES.find((f) => f.type === t)!.display;
  const index = FIRM_FILES.findIndex((f) => f.type === type);
  const loading = catalog.isLoading || current.isLoading;
  const loadError = catalog.error ?? current.error;

  return (
    <Modal title="Configure firm AI settings" onClose={onClose} width={660}>
      <div
        style={{
          fontSize: 12.5,
          color: 'var(--ink-2)',
          lineHeight: 1.55,
          margin: '-2px 0 14px',
          textWrap: 'pretty',
        }}
      >
        Firm knowledge that grounds Meri and the knowledge graph for everyone in {orgName}. Write in
        your own voice — the greyed hints show what belongs in each section. Individuals can layer
        personal preferences on top later.
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <div style={{ maxWidth: 240, flex: 1 }}>
          <SelectInput
            options={FIRM_FILES.map((f) => f.display)}
            value={displayFor(type)}
            onChange={(display) => {
              const file = FIRM_FILES.find((f) => f.display === display);
              if (file) setType(file.type);
            }}
          />
        </div>
        <span
          style={{
            fontSize: 11.5,
            color: 'var(--ink-3)',
            fontFamily: 'var(--font-mono)',
            letterSpacing: 0,
          }}
        >
          {index + 1} / {FIRM_FILES.length}
        </span>
      </div>
      <div
        style={{ display: 'grid', gap: 18, maxHeight: '46vh', overflowY: 'auto', paddingRight: 4 }}
      >
        {loading && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 9,
              fontSize: 12.5,
              color: 'var(--ink-2)',
            }}
          >
            <Spinner />
            Loading {displayFor(type)}…
          </div>
        )}
        {!loading && loadError != null && <ErrorText>{errorMessage(loadError)}</ErrorText>}
        {!loading &&
          (def?.sections ?? []).map((s) => (
            <div key={s.key} style={{ display: 'grid', gap: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink-1)' }}>
                {s.heading}
              </span>
              <span style={{ fontSize: 11.5, color: 'var(--ink-3)', lineHeight: 1.45 }}>
                {s.prompt} <span style={{ fontStyle: 'italic' }}>e.g. "{s.example}"</span>
              </span>
              <textarea
                rows={2}
                style={{ ...obInputStyle, resize: 'vertical' }}
                placeholder="Write in your own voice…"
                value={fieldValue(s.key)}
                onChange={(e) =>
                  setDrafts((d) => ({
                    ...d,
                    [type]: { ...d[type], [s.key]: e.target.value },
                  }))
                }
              ></textarea>
            </div>
          ))}
      </div>
      {error && <ErrorText>{error}</ErrorText>}
      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 10,
          borderTop: '1px solid var(--border-1)',
          paddingTop: 14,
          marginTop: 16,
        }}
      >
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn
          variant="primary"
          disabled={saving || loading || !def}
          onClick={() => void save()}
          icon="Save"
        >
          {saving ? 'Saving…' : 'Save changes'}
        </Btn>
      </div>
    </Modal>
  );
}
