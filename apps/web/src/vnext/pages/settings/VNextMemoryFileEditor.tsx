/**
 * vNext re-skin of components/MemoryFileEditor.tsx — identical endpoints,
 * query keys, invalidations, save semantics (human-owned sections only) and
 * copy, via the shared memory-file-editor-shared.ts types/helpers.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import {
  defaultMemoryFileType as defaultFileType,
  memorySaveErrorMessage,
  settingsMemorySuccessMessage,
  type MemoryFileDef as FileDef,
  type MemoryItemSection as ItemSection,
  type MemoryItemSectionsResp as ItemSectionsResp,
  type MemorySaveSectionsResp as SaveSectionsResp,
} from '../../../components/memory-file-editor-shared.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { CapiroSelect } from '../../components/fields/index.js';
import { CapiroEmptyState, CapiroSkeleton } from '../../components/feedback/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { SvCallout, SvTextArea } from './settings-ui.js';
import { VNextPendingMemoryReviewPanel } from './VNextPendingMemoryReviewPanel.js';

export function VNextMemoryFileEditor({
  scope,
  slug,
  ready,
  canEdit,
}: {
  scope: 'firm' | 'client' | 'user';
  slug: string;
  ready: boolean;
  canEdit: boolean;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useCapiroToast();
  const [fileType, setFileType] = useState<string>(() => defaultFileType(scope));
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const catalogQuery = useQuery<FileDef[]>({
    queryKey: ['memory-catalog'],
    queryFn: async () => (await api.get<FileDef[]>('/api/memory/catalog')).data,
    staleTime: 60 * 60 * 1000,
  });
  const filesForScope = useMemo(
    () => (catalogQuery.data ?? []).filter((f) => f.scope === scope),
    [catalogQuery.data, scope],
  );

  useEffect(() => {
    setFileType(defaultFileType(scope));
    setDrafts({});
  }, [scope]);
  useEffect(() => {
    setDrafts({});
  }, [slug]);

  const itemQuery = useQuery<ItemSectionsResp>({
    queryKey: ['memory-item', fileType, slug],
    queryFn: async () =>
      (await api.get<ItemSectionsResp>(`/api/memory/items/${fileType}/${slug}/sections`)).data,
    enabled: ready && !!fileType && !!slug,
    retry: 1,
  });

  const saveMutation = useMutation({
    mutationFn: async (sections: { key: string; body: string }[]) =>
      (
        await api.put<SaveSectionsResp>(`/api/memory/items/${fileType}/${slug}/sections`, {
          sections,
        })
      ).data,
    onSuccess: (result) => {
      toast.success(settingsMemorySuccessMessage(result));
      setDrafts({});
      qc.invalidateQueries({ queryKey: ['memory-item', fileType, slug] });
      qc.invalidateQueries({ queryKey: ['memory-review-summary'] });
      qc.invalidateQueries({ queryKey: ['memory-own-proposals'] });
      qc.invalidateQueries({ queryKey: ['memory-review-candidates'] });
    },
    onError: (error: unknown) => toast.error(memorySaveErrorMessage(error)),
  });

  const bodyFor = (section: ItemSection): string => drafts[section.key] ?? section.body;
  const onSave = () => {
    const human = (itemQuery.data?.sections ?? []).filter((section) => section.owner === 'human');
    saveMutation.mutate(human.map((section) => ({ key: section.key, body: bodyFor(section) })));
  };

  const sharedPending = scope !== 'user' && !!itemQuery.data?.pendingReview;
  const canSave = canEdit && !!itemQuery.data && !saveMutation.isPending && !sharedPending;

  const saveButton = (
    <CapiroButton
      variant="primary"
      onClick={onSave}
      loading={saveMutation.isPending}
      disabled={!canSave}
    >
      {sharedPending ? 'Waiting for review' : scope === 'user' ? 'Save changes' : 'Submit for review'}
    </CapiroButton>
  );

  return (
    <div className="stv-stack">
      <div className="stv-row">
        <span style={{ width: 200 }}>
          <CapiroSelect
            label="Memory file"
            value={fileType}
            onChange={(event) => {
              setFileType(event.target.value);
              setDrafts({});
            }}
            options={filesForScope.map((file) => ({ label: file.label, value: file.type }))}
          />
        </span>
        <span style={{ marginTop: 24 }}>{saveButton}</span>
      </div>

      {!canEdit && (
        <SvCallout kind="info" title="You can view this file. Editing requires an admin role." />
      )}

      {ready && itemQuery.isLoading && (
        <div className="stv-stack" aria-label="Loading memory file">
          <CapiroSkeleton height={16} />
          <CapiroSkeleton height={16} width="70%" />
        </div>
      )}
      {ready && itemQuery.isError && (
        <CapiroEmptyState title="Couldn't load this file. Try again." />
      )}

      {ready && itemQuery.data && (
        <>
          {itemQuery.data.pendingReview && (
            <VNextPendingMemoryReviewPanel
              activeExists={itemQuery.data.exists}
              activeSections={itemQuery.data.sections}
              pending={itemQuery.data.pendingReview}
            />
          )}

          {!sharedPending && (
            <>
              <div className="stv-stack">
                {itemQuery.data.sections.map((section) => (
                  <div key={section.key}>
                    <div className="stv-row" style={{ gap: 8 }}>
                      <span className="stv-strong">{section.heading}</span>
                      {section.owner === 'engine' && <CapiroBadge>Auto-generated</CapiroBadge>}
                    </div>
                    <p className="stv-muted stv-small" style={{ margin: '2px 0' }}>
                      {section.prompt}{' '}
                      {section.example && <em className="stv-muted">e.g. “{section.example}”</em>}
                    </p>
                    <SvTextArea
                      aria-label={section.heading}
                      value={bodyFor(section)}
                      rows={section.key === 'samples' ? 6 : 3}
                      readOnly={section.owner === 'engine' || !canEdit}
                      onChange={(value) =>
                        setDrafts((current) => ({
                          ...current,
                          [section.key]: value,
                        }))
                      }
                    />
                  </div>
                ))}
              </div>
              <div className="stv-row stv-row--end">{saveButton}</div>
            </>
          )}
        </>
      )}
    </div>
  );
}
