import { useEffect, useMemo, useState } from 'react';
import { Alert, App, Button, Empty, Input, Select, Space, Spin, Tag, Typography } from 'antd';
import { SaveOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../lib/use-api.js';

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
interface ItemSection {
  key: string;
  heading: string;
  owner: 'engine' | 'human';
  body: string;
  prompt: string;
  example: string;
}
interface PendingReviewState {
  candidateId: string;
  status: 'pending_review';
  submittedAt: string;
}
interface ItemSectionsResp {
  type: string;
  slug: string;
  title: string;
  visibility: string;
  clientId: string | null;
  updatedAt: string | null;
  pendingReview: PendingReviewState | null;
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
    },
    onError: (e: unknown) => message.error(e instanceof Error ? e.message : 'Save failed'),
  });

  const bodyFor = (s: ItemSection): string => drafts[s.key] ?? s.body;

  // Save persists the CURRENT value of every human-editable section (the server
  // ignores engine-owned sections). We don't gate on "dirty" so the Save button
  // is always actionable when you can edit — a no-op save is harmless.
  const onSave = () => {
    const human = (itemQuery.data?.sections ?? []).filter((s) => s.owner === 'human');
    saveMutation.mutate(human.map((s) => ({ key: s.key, body: bodyFor(s) })));
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
      {scope === 'user' ? 'Save changes' : 'Submit for review'}
    </Button>
  );

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Space wrap>
        <Select
          style={{ width: 200 }}
          value={fileType}
          onChange={(v) => {
            setFileType(v);
            setDrafts({});
          }}
          options={filesForScope.map((f) => ({ label: f.label, value: f.type }))}
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
      {itemQuery.data?.pendingReview && (
        <Alert
          type="success"
          showIcon
          message="Submitted for independent review"
          description={`Candidate ${itemQuery.data.pendingReview.candidateId}. Active content remains unchanged until approval.`}
        />
      )}

      {ready && itemQuery.isLoading && <Spin />}
      {ready && itemQuery.isError && <Empty description="Couldn't load this file. Try again." />}

      {ready && itemQuery.data && (
        <>
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            {itemQuery.data.sections.map((s) => (
              <div key={s.key}>
                <Space>
                  <Text strong>{s.heading}</Text>
                  {s.owner === 'engine' && <Tag color="default">auto-generated</Tag>}
                </Space>
                <Paragraph type="secondary" style={{ margin: '2px 0', fontSize: 12 }}>
                  {s.prompt}{' '}
                  {s.example && (
                    <Text type="secondary" italic>
                      e.g. “{s.example}”
                    </Text>
                  )}
                </Paragraph>
                <Input.TextArea
                  value={bodyFor(s)}
                  autoSize={{ minRows: s.key === 'samples' ? 6 : 2, maxRows: 16 }}
                  readOnly={s.owner === 'engine' || !canEdit}
                  onChange={(e) => setDrafts((d) => ({ ...d, [s.key]: e.target.value }))}
                  style={s.owner === 'engine' ? { background: '#f5f5f5' } : undefined}
                />
              </div>
            ))}
          </Space>
          {/* Bottom save so it's reachable after a long form. */}
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>{saveButton}</div>
        </>
      )}
    </Space>
  );
}
