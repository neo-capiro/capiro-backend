import { useEffect, useMemo, useState } from 'react';
import { Alert, App, Button, Empty, Input, Select, Space, Spin, Tag, Typography } from 'antd';
import { SaveOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../lib/use-api.js';
import {
  PendingMemoryReviewPanel,
  type MemoryReviewSection,
  type PendingMemoryReviewState,
} from './PendingMemoryReviewPanel.js';

const { Text, Paragraph } = Typography;

/**
 * Shared editor for a scoped memory file (firm / client / user). Renders a file
 * picker for the scope and the section editors (with greyed catalog help), plus
 * Save buttons at the top and bottom. All content is entered manually. Used by
 * both the Settings Memory tab (firm + user) and the client profile Overview
 * (client).
 *
 * The caller supplies the scope + slug (firm -> 'firm'; user -> 'me'; client ->
 * clientId) and whether the caller may edit (client/firm require admin).
 */

interface SectionDef {
  key: string;
  heading: string;
  prompt: string;
  example: string;
}
interface FileDef {
  type: string;
  scope: 'firm' | 'client' | 'user';
  label: string;
  blurb: string;
  sections: SectionDef[];
}
interface ItemSection extends MemoryReviewSection {
  prompt: string;
  example: string;
}
interface ItemSectionsResp {
  type: string;
  slug: string;
  title: string;
  visibility: string;
  clientId: string | null;
  updatedAt: string | null;
  exists: boolean;
  pendingReview: PendingMemoryReviewState | null;
  sections: ItemSection[];
}
interface SaveSectionsResp {
  ok?: true;
  updatedAt?: string;
  status?: 'pending_review';
  candidateId?: string;
  activeItemUnchanged?: true;
}

export function settingsMemorySuccessMessage(result: SaveSectionsResp): string {
  return result.status === 'pending_review' ? 'Submitted for independent review' : 'Saved';
}

export function memorySaveErrorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const response = (error as { response?: { data?: { message?: unknown } } }).response;
    if (typeof response?.data?.message === 'string') return response.data.message;
    if (Array.isArray(response?.data?.message)) {
      return response.data.message
        .filter((value): value is string => typeof value === 'string')
        .join(' ');
    }
  }
  return error instanceof Error ? error.message : 'Save failed';
}

function defaultFileType(scope: 'firm' | 'client' | 'user'): string {
  return scope === 'firm' ? 'firm-soul' : scope === 'user' ? 'user-profile' : 'client-soul';
}

export function MemoryFileEditor({
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
  const { message } = App.useApp();

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

  // Reset the file picker to the scope's default when the scope changes (e.g. the
  // settings page toggles firm<->user), and clear drafts when the scope or the
  // target entity (slug) changes so edits never bleed across files/clients.
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
      message.success(settingsMemorySuccessMessage(result));
      setDrafts({});
      qc.invalidateQueries({ queryKey: ['memory-item', fileType, slug] });
      qc.invalidateQueries({ queryKey: ['memory-review-summary'] });
      qc.invalidateQueries({ queryKey: ['memory-own-proposals'] });
      qc.invalidateQueries({ queryKey: ['memory-review-candidates'] });
    },
    onError: (error: unknown) => message.error(memorySaveErrorMessage(error)),
  });

  const bodyFor = (section: ItemSection): string => drafts[section.key] ?? section.body;

  // Save persists the CURRENT value of every human-editable section (the server
  // ignores engine-owned sections). We don't gate on "dirty" so the Save button
  // is always actionable when you can edit — a no-op save is harmless.
  const onSave = () => {
    const human = (itemQuery.data?.sections ?? []).filter((section) => section.owner === 'human');
    saveMutation.mutate(human.map((section) => ({ key: section.key, body: bodyFor(section) })));
  };

  const sharedPending = scope !== 'user' && !!itemQuery.data?.pendingReview;
  const canSave = canEdit && !!itemQuery.data && !saveMutation.isPending && !sharedPending;

  const saveButton = (
    <Button
      type="primary"
      icon={<SaveOutlined />}
      onClick={onSave}
      loading={saveMutation.isPending}
      disabled={!canSave}
    >
      {sharedPending
        ? 'Waiting for review'
        : scope === 'user'
          ? 'Save changes'
          : 'Submit for review'}
    </Button>
  );

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Space wrap>
        <Select
          style={{ width: 200 }}
          value={fileType}
          onChange={(value) => {
            setFileType(value);
            setDrafts({});
          }}
          options={filesForScope.map((file) => ({ label: file.label, value: file.type }))}
        />
        {saveButton}
      </Space>

      {!canEdit && (
        <Alert
          type="info"
          showIcon
          message="You can view this file. Editing requires an admin role."
        />
      )}

      {ready && itemQuery.isLoading && <Spin />}
      {ready && itemQuery.isError && <Empty description="Couldn't load this file. Try again." />}

      {ready && itemQuery.data && (
        <>
          {itemQuery.data.pendingReview && (
            <PendingMemoryReviewPanel
              activeExists={itemQuery.data.exists}
              activeSections={itemQuery.data.sections}
              pending={itemQuery.data.pendingReview}
            />
          )}

          {!sharedPending && (
            <>
              <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                {itemQuery.data.sections.map((section) => (
                  <div key={section.key}>
                    <Space>
                      <Text strong>{section.heading}</Text>
                      {section.owner === 'engine' && <Tag color="default">Auto-generated</Tag>}
                    </Space>
                    <Paragraph type="secondary" style={{ margin: '2px 0', fontSize: 12 }}>
                      {section.prompt}{' '}
                      {section.example && (
                        <Text type="secondary" italic>
                          e.g. “{section.example}”
                        </Text>
                      )}
                    </Paragraph>
                    <Input.TextArea
                      value={bodyFor(section)}
                      autoSize={{ minRows: section.key === 'samples' ? 6 : 2, maxRows: 16 }}
                      readOnly={section.owner === 'engine' || !canEdit}
                      onChange={(event) =>
                        setDrafts((current) => ({
                          ...current,
                          [section.key]: event.target.value,
                        }))
                      }
                      style={section.owner === 'engine' ? { background: '#f5f5f5' } : undefined}
                    />
                  </div>
                ))}
              </Space>
              {/* Bottom save so it's reachable after a long form. */}
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>{saveButton}</div>
            </>
          )}
        </>
      )}
    </Space>
  );
}
