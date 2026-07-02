import { useEffect, useRef, useState } from 'react';
import { App as AntApp, Button, Input, Modal, Space, Tag, Tooltip, Typography } from 'antd';
import type { FeedItem } from './intel-feed-api.js';
import {
  feedItemToMemoAlert,
  useGenerateAlertMemo,
  useRecordMemoLink,
  useSaveAlertMemo,
  type AlertMemoResult,
} from './alert-actions-api.js';

const { Text, Paragraph } = Typography;

/**
 * One-click memo composer. On open it generates a Memory-grounded, source-cited
 * memo (apps/api), auto-files it in the client's Documents, and records the link
 * (intel-api) so the Feed shows "memo drafted". The analyst can edit, regenerate,
 * copy, and re-save (updates the same Document).
 */
export function MemoComposerDrawer({
  open,
  onClose,
  clientId,
  clientName,
  item,
}: {
  open: boolean;
  onClose: () => void;
  clientId: string;
  clientName: string;
  item: FeedItem | null;
}) {
  const { message } = AntApp.useApp();
  const generate = useGenerateAlertMemo();
  const save = useSaveAlertMemo();
  const recordLink = useRecordMemoLink();

  const [memo, setMemo] = useState<AlertMemoResult | null>(null);
  const [markdown, setMarkdown] = useState('');
  const [attachmentId, setAttachmentId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const startedFor = useRef<string | null>(null);

  const runGenerate = async (replaceAttachmentId?: string) => {
    if (!item) return;
    try {
      const res = await generate.mutateAsync({
        clientId,
        clientName,
        alert: feedItemToMemoAlert(item),
        replaceAttachmentId,
      });
      setMemo(res);
      setMarkdown(res.markdown);
      setAttachmentId(res.document?.attachmentId ?? null);
      setDirty(false);
      if (res.document) {
        await recordLink
          .mutateAsync({ clientId, alertId: item.id, documentAttachmentId: res.document.attachmentId, title: res.title })
          .catch(() => undefined);
        message.success('Memo drafted and filed in Documents');
      } else {
        message.warning('Memo drafted (auto-file to Documents failed — use Save to retry)');
      }
    } catch (e) {
      message.error(`Could not draft memo: ${(e as Error).message}`);
    }
  };

  // Auto-generate once when the drawer opens for an item.
  useEffect(() => {
    if (open && item && startedFor.current !== item.id) {
      startedFor.current = item.id;
      setMemo(null);
      setMarkdown('');
      setAttachmentId(null);
      void runGenerate();
    }
    if (!open) startedFor.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item?.id]);

  const onSave = async () => {
    if (!item) return;
    try {
      const res = await save.mutateAsync({
        clientId,
        title: memo?.title ?? `Client memo — ${item.title}`,
        markdown,
        clientName,
        actionDate: item.evidence?.bill?.actionDate ?? undefined,
        replaceAttachmentId: attachmentId ?? undefined,
      });
      if (res.document) {
        setAttachmentId(res.document.attachmentId);
        await recordLink
          .mutateAsync({ clientId, alertId: item.id, documentAttachmentId: res.document.attachmentId, title: res.title })
          .catch(() => undefined);
      }
      setDirty(false);
      message.success('Saved to Documents');
    } catch (e) {
      message.error(`Save failed: ${(e as Error).message}`);
    }
  };

  const busy = generate.isPending;

  return (
    <Modal
      title="Draft client memo"
      open={open}
      onCancel={onClose}
      width={760}
      footer={[
        <Button key="regen" onClick={() => void runGenerate(attachmentId ?? undefined)} loading={busy} disabled={!item}>
          Regenerate
        </Button>,
        <Button
          key="copy"
          onClick={() => {
            void navigator.clipboard?.writeText(markdown);
            message.success('Copied');
          }}
          disabled={!markdown}
        >
          Copy
        </Button>,
        <Button key="close" onClick={onClose}>
          Close
        </Button>,
        <Button key="save" type="primary" onClick={() => void onSave()} loading={save.isPending} disabled={!markdown}>
          Save to Documents
        </Button>,
      ]}
    >
      {busy && !memo ? (
        <div style={{ padding: '32px 0', textAlign: 'center', color: 'var(--muted,#8a8a96)' }}>
          Generating a memo grounded in {clientName}&apos;s profile…
        </div>
      ) : (
        <Space direction="vertical" style={{ width: '100%' }} size={10}>
          <Space size={6} wrap>
            {attachmentId ? <Tag color="green">Saved to Documents ✓</Tag> : <Tag>Not yet filed</Tag>}
            {memo?.lowConfidence && (
              <Tooltip title="Generation was thin or fell back to a scaffold — review carefully.">
                <Tag color="orange">Low confidence</Tag>
              </Tooltip>
            )}
            {memo?.memoryFilesUsed?.length ? (
              <Tooltip title={`Voice/priorities steered by: ${memo.memoryFilesUsed.join(', ')}`}>
                <Tag color="blue">Context: {memo.memoryFilesUsed.join(', ')}</Tag>
              </Tooltip>
            ) : (
              <Tooltip title="No client Memory files on record — add them in Settings → Memory for sharper, on-voice memos.">
                <Tag>No client Memory files</Tag>
              </Tooltip>
            )}
            {memo && <Text type="secondary" style={{ fontSize: 11 }}>{memo.usedTenantKey ? 'tenant key' : 'shared key'}</Text>}
          </Space>

          <Input.TextArea
            value={markdown}
            onChange={(e) => {
              setMarkdown(e.target.value);
              setDirty(true);
            }}
            autoSize={{ minRows: 14, maxRows: 30 }}
            style={{ fontFamily: 'var(--mono, ui-monospace, monospace)', fontSize: 12.5 }}
          />
          {dirty && <Text type="secondary" style={{ fontSize: 11 }}>Unsaved edits — Save to update the Document.</Text>}

          {memo?.sources?.length ? (
            <div>
              <Text strong style={{ fontSize: 12 }}>Sources</Text>
              {memo.sources.map((s) => (
                <Paragraph key={s.claimId} style={{ margin: '2px 0', fontSize: 11.5 }} type="secondary">
                  {s.label}
                  {s.url ? (
                    <>
                      {' — '}
                      <a href={s.url} target="_blank" rel="noreferrer">
                        source
                      </a>
                    </>
                  ) : null}
                </Paragraph>
              ))}
            </div>
          ) : null}
        </Space>
      )}
    </Modal>
  );
}

export default MemoComposerDrawer;
