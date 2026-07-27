import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { App as AntApp, Button, Input, Modal, Space, Tag, Tooltip, Typography } from 'antd';
import { useApi } from '../../../lib/use-api.js';
import { markdownishToHtml } from '../../engagement/outreach/v2/richtext.js';
import type { FeedItem } from './intel-feed-api.js';
import { intelTrackerPaths } from './intel-tracker-api.js';
import {
  feedItemToMemoAlert,
  useGenerateAlertMemo,
  useGetMemoLink,
  useRecordMemoLink,
  useSaveAlertMemo,
  withClaimAnchors,
  type AlertMemoResult,
} from './alert-actions-api.js';

const { Text, Paragraph } = Typography;

/**
 * §4.10 (Gate E phase f, f-5): how much `b` differs from `a`, as a fraction of
 * the longer string's length. A common-prefix/suffix trim, not a full edit
 * distance — cheap (O(n)) and good enough to gate a >20% threshold without
 * risking jank on a multi-KB memo in a click handler.
 */
export function textDiffRatio(a: string, b: string): number {
  if (a === b) return 0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 0;
  const minLen = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < minLen && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < minLen - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  return (maxLen - prefix - suffix) / maxLen;
}
/** f-5 / edge case 16: a real computed ratio, not `dirty` alone (`dirty` is
 *  true after one keystroke). */
export const MEMO_HEAVY_EDIT_THRESHOLD = 0.2;

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
  const getMemoLink = useGetMemoLink();

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
  // RB-04 / Gate H a-2: true while `markdown` holds previously-SAVED content
  // rather than a fresh generation — gates whether Regenerate needs a confirm
  // and tells the analyst what they're looking at.
  const [existingLoaded, setExistingLoaded] = useState(false);
  // The saved title for loaded content — `memo` (the generator's rich result)
  // is never populated on this path, so onSave's title fallback needs it
  // separately or a save-without-regenerating would re-file under a fresh
  // `Client memo — {item.title}` instead of the name it was actually filed as.
  const [loadedTitle, setLoadedTitle] = useState<string | null>(null);
  const startedFor = useRef<string | null>(null);

  // P0-01: a memo the grounding auditor HELD for review — governance state, not
  // a failure. Keep editing available (audit requirement); disable filing.
  const held = memo?.held === true;
  // Gate I (CG-01) phase c: `held` alone doesn't say whether a reviewer will
  // ever see this — apps/api's reviews.createSystem() is fail-open and can
  // return null (I_GOVERNANCE.md §1.4's S1-S4). When that happens filing is
  // blocked (the server-owned AlertGenerationRecord enforces it) but there is
  // no review row to link to, so this must read as "filing is blocked" — never
  // as "auto-file failed", which implies a retry would help. It won't.
  const blockedNoReviewer = held && !memo?.reviewRequestId;

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
      setExistingLoaded(false);
      setLoadedTitle(null);
      // §4.10 (f-5): fired on generation itself, independent of the filing
      // outcome below — a held-for-review memo was still generated.
      void api
        .post(intelTrackerPaths.feedback(clientId), {
          targetRef: item.id,
          targetType: 'alert',
          signal: 'memo_generated',
        })
        .catch(() => {});
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

  /**
   * RB-04 / Gate H a-2, a-4: loads the SAVED memo (a-5's content field) instead
   * of generating over it. A null documentAttachmentId (memo present but never
   * successfully filed) is a real, surfaced state here — not silently treated
   * as "nothing exists yet" — so Save below files it exactly once instead of a
   * generate silently producing a second, unlinked document.
   */
  const loadExisting = async (
    alertId: string,
    existingMemo: { documentAttachmentId: string | null; title: string | null },
  ) => {
    setAttachmentId(existingMemo.documentAttachmentId ?? null);
    setLoadedTitle(existingMemo.title ?? null);
    let saved: { text: string | null } | null = null;
    try {
      saved = await getMemoLink.mutateAsync({ clientId, alertId });
    } catch {
      saved = null;
    }
    if (saved?.text) {
      setMemo(null);
      setMarkdown(saved.text);
      setDirty(false);
      setExistingLoaded(true);
    } else {
      // A memo-link row exists but has no saved content (drafted before Gate H
      // a-5, or the read failed) — surface it rather than quietly regenerating.
      setMemo(null);
      setMarkdown('');
      setExistingLoaded(true);
      message.warning('No saved memo content on record — use Regenerate to draft a new one.');
    }
  };

  // Auto-generate on open ONLY when there is no existing memo (a-2). When one
  // exists, load its saved content instead — generating (and so replacing the
  // filed document) now requires the explicit, confirm-gated Regenerate action
  // below, on both this open path and the footer button (a-3).
  useEffect(() => {
    if (open && item && startedFor.current !== item.id) {
      startedFor.current = item.id;
      const existingMemo = item.actions?.memo;
      if (existingMemo) {
        setMemo(null);
        setMarkdown('');
        setExistingLoaded(false);
        void loadExisting(item.id, existingMemo);
      } else {
        setMemo(null);
        setMarkdown('');
        setAttachmentId(null);
        setExistingLoaded(false);
        setLoadedTitle(null);
        void runGenerate();
      }
    }
    if (!open) startedFor.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item?.id]);

  /** a-3 / H-2: every regenerate that would replace a filed document — the open
   *  path above never auto-fires this; only an explicit click does. */
  const confirmAndRegenerate = () => {
    if (attachmentId) {
      Modal.confirm({
        title: 'Regenerate this memo?',
        content:
          'This drafts a brand-new memo and files it in place of the current one — the version in Documents today will no longer appear once this finishes. Any unsaved edits here will be lost.',
        okText: 'Regenerate',
        okButtonProps: { danger: true },
        onOk: () => void runGenerate(attachmentId),
      });
    } else {
      void runGenerate();
    }
  };

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
        title: memo?.title ?? loadedTitle ?? `Client memo — ${item.title}`,
        markdown,
        clientName,
        alertId: item.id,
        actionDate: item.evidence?.bill?.actionDate ?? undefined,
        replaceAttachmentId: attachmentId ?? undefined,
        // Gate I (CG-01): only present after a fresh generate() this session —
        // a loaded-not-regenerated memo has no known id, and falls back to the
        // pre-Gate-I compatibility checks (b-5), same as an older client build.
        generationId: memo?.generationId ?? undefined,
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
      // §4.10 (f-5): `dirty` alone is true after one keystroke (edge case 16) —
      // gate on the ACTUAL character-diff ratio between what was generated and
      // what is being saved, computed here, not guessed from `dirty`.
      if (dirty && memo && textDiffRatio(memo.markdown, markdown) > MEMO_HEAVY_EDIT_THRESHOLD) {
        void api
          .post(intelTrackerPaths.feedback(clientId), {
            targetRef: item.id,
            targetType: 'alert',
            signal: 'memo_heavily_edited',
          })
          .catch(() => {});
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

  const busy = generate.isPending || (getMemoLink.isPending && !existingLoaded);

  return (
    <Modal
      title="Draft client memo"
      open={open}
      onCancel={onClose}
      width={760}
      footer={[
        <Button key="regen" onClick={confirmAndRegenerate} loading={busy} disabled={!item}>
          Regenerate
        </Button>,
        <Button
          key="copy"
          // P2-06: the write was un-awaited AND optional-chained, so on an
          // insecure origin (navigator.clipboard undefined) or a rejected
          // permission it copied nothing and still said "Copied".
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(markdown);
              message.success('Copied');
            } catch {
              message.warning('Could not copy automatically — select the text and copy manually.');
            }
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
        // Gate I (CG-01) phase c: only offer this when there is a review row to
        // land on — sending the analyst to the general /reviews queue for a
        // hold nothing was ever filed under is a dead end dressed up as a link.
        ...(held && memo?.reviewRequestId
          ? [
              <Button
                key="review"
                onClick={() => navigate(`/reviews?id=${encodeURIComponent(memo.reviewRequestId!)}`)}
              >
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
          title={
            blockedNoReviewer
              ? 'This draft could not be filed for review — filing is blocked until a reviewer releases it'
              : held
                ? 'Held for review — a reviewer must approve this memo before it can be filed'
                : undefined
          }
        >
          Save to Documents
        </Button>,
      ]}
    >
      {busy && !memo ? (
        <div style={{ padding: '32px 0', textAlign: 'center', color: 'var(--muted,#8a8a96)' }}>
          {generate.isPending
            ? <>Generating a memo grounded in {clientName}&apos;s profile…</>
            : 'Loading the saved memo…'}
        </div>
      ) : (
        <Space direction="vertical" style={{ width: '100%' }} size={10}>
          <Space size={6} wrap>
            {blockedNoReviewer ? (
              <Tooltip
                title={`${memo?.heldReason || 'This memo was held for review.'} No reviewer has been notified — filing is blocked until a reviewer releases it.`}
              >
                <Tag color="volcano">Filing blocked — no reviewer notified</Tag>
              </Tooltip>
            ) : held ? (
              <Tooltip title={memo?.heldReason || 'The grounding auditor held this memo for review.'}>
                <Tag color="red">Held for review — unapproved draft</Tag>
              </Tooltip>
            ) : attachmentId ? (
              <Tag color="green">Saved to Documents ✓</Tag>
            ) : (
              <Tag>Not yet filed</Tag>
            )}
            {existingLoaded && !memo && (
              <Tooltip title="This is the previously saved memo, not a new AI draft. Use Regenerate for a brand-new version.">
                <Tag>Loaded from Documents</Tag>
              </Tooltip>
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
          {blockedNoReviewer ? (
            <Text type="danger" style={{ fontSize: 11 }}>
              This draft could not be filed for review — filing is blocked until a reviewer releases
              it. You can keep editing; Save will stay disabled until then.
            </Text>
          ) : (
            held && (
              <Text type="warning" style={{ fontSize: 11 }}>
                Unapproved draft — edits are local only until a reviewer approves this memo.
              </Text>
            )
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

          {/* §4.7 (g-4): show the analyst which sentences the entailment gate judged
              unsupported. Under shadow these are STILL in the memo above — this list is
              what would have been withheld, which is how the gate gets evaluated before
              it is trusted to remove text. */}
          {memo?.entailmentDropped?.length ? (
            <div>
              <Text strong style={{ fontSize: 12 }} type="warning">
                Withheld as unsupported ({memo.entailmentDropped.length})
              </Text>
              {memo.entailmentDropped.map((d, i) => (
                <Paragraph
                  key={`${d.heading}-${i}`}
                  style={{ margin: '2px 0', fontSize: 11.5 }}
                  type="secondary"
                >
                  <Text strong style={{ fontSize: 11 }}>
                    {d.heading}:
                  </Text>{' '}
                  {d.text}
                  {d.reason ? ` — ${d.reason}` : null}
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
