import { useEffect, useMemo, useState } from 'react';
import {
  Alert, App, Button, Drawer, Empty, Input, Select, Space, Spin, Tag, Typography,
} from 'antd';
import { RobotOutlined, SaveOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../lib/use-api.js';

const { Text, Paragraph } = Typography;

/**
 * Shared editor for a scoped memory file (firm / client / user). Renders a file
 * picker for the scope, the section editors (with greyed catalog help), a save
 * button, and a "Fill with Meri" interview drawer. Used by both the Settings
 * Memory tab (firm + user) and the client profile Overview (client).
 *
 * The caller supplies the scope + slug (firm -> 'firm'; user -> 'me'; client ->
 * clientId) and whether the caller may edit (client/firm require admin).
 */

interface SectionDef { key: string; heading: string; prompt: string; example: string }
interface FileDef { type: string; scope: 'firm' | 'client' | 'user'; label: string; blurb: string; sections: SectionDef[] }
interface ItemSection { key: string; heading: string; owner: 'engine' | 'human'; body: string; prompt: string; example: string }
interface ItemSectionsResp {
  type: string; slug: string; title: string; visibility: string;
  clientId: string | null; updatedAt: string; sections: ItemSection[];
}

function defaultFileType(scope: 'firm' | 'client' | 'user'): string {
  return scope === 'firm' ? 'firm-soul' : scope === 'user' ? 'user-profile' : 'client-soul';
}

export function MemoryFileEditor({ scope, slug, ready, canEdit }: {
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
  const [interviewOpen, setInterviewOpen] = useState(false);

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
  useEffect(() => { setFileType(defaultFileType(scope)); setDrafts({}); }, [scope]);
  useEffect(() => { setDrafts({}); }, [slug]);

  const itemQuery = useQuery<ItemSectionsResp>({
    queryKey: ['memory-item', fileType, slug],
    queryFn: async () => (await api.get<ItemSectionsResp>(`/api/memory/items/${fileType}/${slug}/sections`)).data,
    enabled: ready && !!fileType && !!slug,
    retry: 1,
  });

  const saveMutation = useMutation({
    mutationFn: async (sections: { key: string; body: string }[]) =>
      (await api.put(`/api/memory/items/${fileType}/${slug}/sections`, { sections })).data,
    onSuccess: () => {
      message.success('Saved');
      setDrafts({});
      qc.invalidateQueries({ queryKey: ['memory-item', fileType, slug] });
    },
    onError: (e: unknown) => message.error(e instanceof Error ? e.message : 'Save failed'),
  });

  const bodyFor = (s: ItemSection): string => drafts[s.key] ?? s.body;
  const dirty = Object.keys(drafts).length > 0;
  const onSave = () => saveMutation.mutate(Object.entries(drafts).map(([key, body]) => ({ key, body })));

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Space wrap>
        <Select
          style={{ width: 200 }}
          value={fileType}
          onChange={(v) => { setFileType(v); setDrafts({}); }}
          options={filesForScope.map((f) => ({ label: f.label, value: f.type }))}
        />
        <Button icon={<RobotOutlined />} onClick={() => setInterviewOpen(true)} disabled={!ready}>
          Fill with Meri
        </Button>
        <Button
          type="primary" icon={<SaveOutlined />} onClick={onSave}
          loading={saveMutation.isPending} disabled={!dirty || !canEdit}
        >
          Save changes
        </Button>
      </Space>

      {!canEdit && (
        <Alert type="info" showIcon message="You can view this file. Editing requires an admin role." />
      )}

      {ready && itemQuery.isLoading && <Spin />}
      {ready && itemQuery.isError && <Empty description="Couldn't load this file. Try again." />}

      {ready && itemQuery.data && (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {itemQuery.data.sections.map((s) => (
            <div key={s.key}>
              <Space>
                <Text strong>{s.heading}</Text>
                {s.owner === 'engine' && <Tag color="default">auto-generated</Tag>}
              </Space>
              <Paragraph type="secondary" style={{ margin: '2px 0', fontSize: 12 }}>
                {s.prompt} {s.example && <Text type="secondary" italic>e.g. “{s.example}”</Text>}
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
      )}

      <InterviewDrawer
        open={interviewOpen}
        onClose={() => setInterviewOpen(false)}
        fileType={fileType}
        fileLabel={filesForScope.find((f) => f.type === fileType)?.label ?? fileType}
        onApply={(sections) => {
          setDrafts((d) => {
            const next = { ...d };
            for (const s of sections) next[s.key] = s.body;
            return next;
          });
          setInterviewOpen(false);
          message.info('Draft applied — review and Save changes.');
        }}
      />
    </Space>
  );
}

interface InterviewQuestion { sectionKey: string; heading: string; question: string; example: string }

function InterviewDrawer(props: {
  open: boolean; onClose: () => void; fileType: string; fileLabel: string;
  onApply: (sections: { key: string; body: string }[]) => void;
}) {
  const api = useApi();
  const { message } = App.useApp();
  const [answers, setAnswers] = useState<Record<string, string>>({});

  const questionsQuery = useQuery<{ questions: InterviewQuestion[] }>({
    queryKey: ['memory-interview-q', props.fileType],
    queryFn: async () => (await api.get(`/api/memory/interview/${props.fileType}/questions`)).data,
    enabled: props.open,
  });

  const draftMutation = useMutation({
    mutationFn: async () => {
      const payload = Object.entries(answers)
        .filter(([, v]) => v.trim())
        .map(([sectionKey, answer]) => ({ sectionKey, answer }));
      return (await api.post(`/api/memory/interview/${props.fileType}/draft`, { answers: payload })).data as {
        sections: { key: string; body: string }[];
      };
    },
    onSuccess: (data) => props.onApply(data.sections ?? []),
    onError: (e: unknown) => message.error(e instanceof Error ? e.message : 'Draft failed'),
  });

  return (
    <Drawer
      title={<Space><RobotOutlined /> Fill “{props.fileLabel}” with Meri</Space>}
      width={520} open={props.open} onClose={props.onClose}
      extra={
        <Button type="primary" loading={draftMutation.isPending}
          onClick={() => draftMutation.mutate()}
          disabled={!Object.values(answers).some((v) => v.trim())}>
          Generate draft
        </Button>
      }
    >
      <Paragraph type="secondary">
        Answer in plain language — Meri turns your answers into the file. You can edit everything before saving.
      </Paragraph>
      {questionsQuery.isLoading && <Spin />}
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {(questionsQuery.data?.questions ?? []).map((q) => (
          <div key={q.sectionKey}>
            <Text strong>{q.question}</Text>
            <Paragraph type="secondary" italic style={{ margin: '2px 0', fontSize: 12 }}>e.g. “{q.example}”</Paragraph>
            <Input.TextArea
              autoSize={{ minRows: 2, maxRows: 6 }}
              value={answers[q.sectionKey] ?? ''}
              onChange={(e) => setAnswers((a) => ({ ...a, [q.sectionKey]: e.target.value }))}
            />
          </div>
        ))}
      </Space>
    </Drawer>
  );
}
