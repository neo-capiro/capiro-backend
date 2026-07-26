import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { App as AntApp, Button, Input, Modal, Space, Tag, Tooltip, Typography } from 'antd';
import { useApi } from '../../../lib/use-api.js';
import { markdownishToHtml } from '../../engagement/outreach/v2/richtext.js';
import type { FeedItem } from './intel-feed-api.js';
import {
  feedItemToMemoAlert,
  useGenerateAlertMemo,
  useRecordMemoLink,
  useSaveAlertMemo,
  withClaimAnchors,
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
  const api = useApi();
  const navigate = useNavigate();
  const generate = useGenerateAlertMemo();
  const save = useSaveAlertMemo();
  const recordLink = useRecordMemoLink();

  // P10: "Open in Workspace" — create an EDITABLE Workspace draft from the
  // in-memory memo content (never the auto-filed .docx; Documents/EngagementAttachment
  // and Workspace/WsDraft are disjoint stores). POST /workspace-api/drafts to mint
  // the draft, then PATCH config.sections/sectionContent so the editor renders the
  // memo's headings + HTML bodies, then navigate to the editor. Prefers the memo's
  // structured `sections`; falls back to a single "Memo" section from the markdown.
  const openInWorkspace = useMutation({
    mutationFn: async (m: AlertMemoResult) => {
      const sections: string[] = [];
      const sectionContent: Record<string, string> = {};
      if (m.sections?.length) {
        for (const s of m.sections) {
          // Workspace keys content by heading, so duplicate/empty headings would
          // overwrite each other's body — disambiguate with a numeric suffix so
          // every section's content survives (review finding).
          const base = s.heading?.trim() || 'Section';
          let heading = base;
          let n = 2;
          while (Object.prototype.hasOwnProperty.call(sectionContent, heading)) heading = `${base} (${n++})`;
          // P1-15: carry the paragraph claim anchors into the Workspace draft too, in
          // the SAME format apps/api's withClaimAnchors defines (alert-memo.service.ts).
          const md = s.paragraphs.map((p) => withClaimAnchors(p.text, p.claimIds)).join('\n\n');
          sections.push(heading);
          sectionContent[heading] = markdownishToHtml(md);
        }
      } else {
        const heading = 'Memo';
        sections.push(heading);
        sectionContent[heading] = markdownishToHtml(markdown || m.markdown || '');
      }
      const created = await api.post<{ id: string }>('/workspace-api/drafts', {
        docTitle: m.title,
        client: clientName,
      });
      const draftId = created.data.id;
      await api.patch(`/workspace-api/drafts/${encodeURIComponent(draftId)}`, {
        config: { sections, sectionContent },
      });
      return draftId;
    },
    onSuccess: (draftId) => {
      message.success('Opened in Workspace');
      navigate(`/workspace/draft/${encodeURIComponent(draftId)}`);
    },
    onError: (e: unknown) => message.error(`Could not open in Workspace: ${(e as Error).message}`),
  });

  const [memo, setMemo] = useState<AlertMemoResult | null>(null);
  const [markdown, setMarkdown] = useState('');
  const [attachmentId, setAttachmentId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  // P1-14: the document is filed but the alert↔document link is a SECOND durable write.
  // When it fails we hold what a retry needs instead of dropping it on the floor.
  const [linkFailed, setLinkFailed] = useState<{ attachmentId: string; title: string } | null>(null);
  const startedFor = useRef<string | null>(null);

  // P0-01: a memo the grounding auditor HELD for review — governance state, not
  // a failure. Keep editing available (audit requirement); disable filing.
  const held = memo?.held === true;

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
      if (res.held) {
        message.warning('Held for review — not filed. A reviewer must approve it before it can be filed.');
      } else if (res.document) {
        // P1-14: swallowing this failure told the user "drafted and filed" while the
        // Feed had NO association — so reopening the composer saw no
        // documentAttachmentId and generated a SECOND document. Report the partial
        // state and offer a retry instead.
        try {
          await recordLink.mutateAsync({
            clientId,
            alertId: item.id,
            documentAttachmentId: res.document.attachmentId,
            title: res.title,
          });
          setLinkFailed(null);
          message.success('Memo drafted and filed in Documents');
        } catch {
          setLinkFailed({ attachmentId: res.document.attachmentId, title: res.title });
          message.warning(
            'Memo filed in Documents, but it is not yet linked to this alert. Use Link to alert to finish.',
          );
        }
      } else {
        message.warning('Memo drafted (auto-file to Documents failed — use Save to retry)');
      }
    } catch (e) {
      message.error(`Could not draft memo: ${(e as Error).message}`);
    }
  };

  // Auto-generate once when the drawer opens for an item. If the alert already
  // has a memo, seed its Document id so this (re)generation REPLACES that
  // Document instead of filing a duplicate.
  useEffect(() => {
    if (open && item && startedFor.current !== item.id) {
      startedFor.current = item.id;
      const existing = item.actions?.memo?.documentAttachmentId ?? null;
      setMemo(null);
      setMarkdown('');
      setAttachmentId(existing);
      void runGenerate(existing ?? undefined);
    }
    if (!open) startedFor.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item?.id]);

  const onSave = async () => {
    if (!item) return;
    if (held) {
      // Client-side bail is UX only; phase b's server-side locks are the enforcement.
      message.warning('This memo is held for review and cannot be filed until a reviewer approves it.');
      return;
    }
    try {
      const res = await save.mutateAsync({
        clientId,
        title: memo?.title ?? `Client memo — ${item.title}`,
        markdown,
        clientName,
        alertId: item.id,
        actionDate: item.evidence?.bill?.actionDate ?? undefined,
        replaceAttachmentId: attachmentId ?? undefined,
      });
      if (res.document) {
        setAttachmentId(res.document.attachmentId);
        // P1-14 (e-5): identical treatment on the save path — a swallowed link failure
        // here left the same orphaned document behind.
        try {
          await recordLink.mutateAsync({
            clientId,
            alertId: item.id,
            documentAttachmentId: res.document.attachmentId,
            title: res.title,
          });
          setLinkFailed(null);
        } catch {
          setLinkFailed({ attachmentId: res.document.attachmentId, title: res.title });
          setDirty(false);
          message.warning(
            'Memo filed in Documents, but it is not yet linked to this alert. Use Link to alert to finish.',
          );
          return;
        }
      }
      setDirty(false);
      message.success('Saved to Documents');
    } catch (e) {
      message.error(`Save failed: ${(e as Error).message}`);
    }
  };

  /** P1-14 (e-4): finish the alert↔document link after a failed first attempt. */
  const retryLink = async () => {
    if (!item || !linkFailed) return;
    try {
      await recordLink.mutateAsync({
        clientId,
        alertId: item.id,
        documentAttachmentId: linkFailed.attachmentId,
        title: linkFailed.title,
      });
      setLinkFailed(null);
      message.success('Linked to this alert');
    } catch (e) {
      message.error(`Could not link the memo to this alert: ${(e as Error).message}`);
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
        <Button
          key="workspace"
          onClick={() => memo && openInWorkspace.mutate(memo)}
          loading={openInWorkspace.isPending}
          disabled={!memo || !markdown}
        >
          Open in Workspace
        </Button>,
        ...(held
          ? [
              <Button key="review" onClick={() => navigate('/reviews')}>
                View review request
              </Button>,
            ]
          : []),
        // P1-14 (e-4): the retry the swallowed failure never offered. Re-runs the link
        // write with the stored ids; recordMemo is idempotent on
        // (tenantId, alertId, kind:'memo'), so pressing it twice cannot double-write.
        ...(linkFailed
          ? [
              <Button
                key="relink"
                onClick={() => void retryLink()}
                loading={recordLink.isPending}
              >
                Link to alert
              </Button>,
            ]
          : []),
        <Button key="close" onClick={onClose}>
          Close
        </Button>,
        <Button
          key="save"
          type="primary"
          onClick={() => void onSave()}
          loading={save.isPending}
          disabled={!markdown || held}
          title={held ? 'Held for review — a reviewer must approve this memo before it can be filed' : undefined}
        >
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
            {held ? (
              <Tooltip title={memo?.heldReason || 'The grounding auditor held this memo for review.'}>
                <Tag color="red">Held for review — unapproved draft</Tag>
              </Tooltip>
            ) : attachmentId ? (
              <Tag color="green">Saved to Documents ✓</Tag>
            ) : (
              <Tag>Not yet filed</Tag>
            )}
            {memo?.lowConfidence && (
              <Tooltip title="Generation was thin or fell back to a scaffold — review carefully.">
                <Tag color="orange">Low confidence</Tag>
              </Tooltip>
            )}
            {/* P1-14: the partial state has to be visible after the toast fades, or the
                analyst has no way to know the alert is still unlinked. */}
            {linkFailed && (
              <Tooltip title="The memo is in the client's Documents, but the alert has no durable link to it yet. Use Link to alert.">
                <Tag color="orange">Filed, not linked to this alert</Tag>
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
          {held && (
            <Text type="warning" style={{ fontSize: 11 }}>
              Unapproved draft — edits are local only until a reviewer approves this memo.
            </Text>
          )}

          {/* §4.6: what steered this memo, and what the compiler withheld and why.
              "Context used" was only a tag before; the exclusion trace was computed by
              the Context Compiler on every generate and then discarded. */}
          {memo?.memoryFilesUsed?.length ? (
            <div>
              <Text strong style={{ fontSize: 12 }}>Context used</Text>
              <Paragraph style={{ margin: '2px 0', fontSize: 11.5 }} type="secondary">
                {memo.memoryFilesUsed.join(', ')}
              </Paragraph>
            </div>
          ) : null}
          {memo?.contextExcluded?.length ? (
            <div>
              <Text strong style={{ fontSize: 12 }}>Context excluded</Text>
              {memo.contextExcluded.map((x, i) => (
                <Paragraph
                  key={`${x.title}-${x.reason}-${i}`}
                  style={{ margin: '2px 0', fontSize: 11.5 }}
                  type="secondary"
                >
                  {x.title} — {x.reason}
                </Paragraph>
              ))}
            </div>
          ) : null}

          {memo?.sources?.length ? (
            <div>
              <Text strong style={{ fontSize: 12 }}>Sources</Text>
              {memo.sources.map((s) => (
                <Paragraph key={s.claimId} style={{ margin: '2px 0', fontSize: 11.5 }} type="secondary">
                  {/* The claim id is what the paragraph anchors point at ("… [c2]"), so
                      it has to be visible for an anchor to be auditable. */}
                  <Text code style={{ fontSize: 10.5 }}>
                    [{s.claimId}]
                  </Text>{' '}
                  {s.label}
                  {s.url ? (
                    <>
                      {' — '}
                      <a href={s.url} target="_blank" rel="noreferrer">
                        source
                      </a>
                    </>
                  ) : null}
                  {s.retrievedAt ? ` · retrieved ${s.retrievedAt}` : null}
                  {s.verification ? ` · ${s.verification}` : null}
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
