import { App as AntApp, Button, Input, Modal, Space, Tag, Tooltip, Typography } from 'antd';
import { useMemoComposerController, MEMO_REPLACEMENT_NOTICE } from './MemoComposerController.js';
import type { MemoComposerProps } from './MemoComposerController.js';
export { textDiffRatio, MEMO_HEAVY_EDIT_THRESHOLD } from './MemoComposerController.js';
const { Text, Paragraph } = Typography;
export function MemoComposerDrawer(props: MemoComposerProps) {
  const { open, onClose, clientId, clientName, item } = props;
  const { message } = AntApp.useApp();
  const confirmReplacement = (onOk: () => void) => {
    Modal.confirm({
      title: 'Regenerate this memo?',
      content: MEMO_REPLACEMENT_NOTICE,
      okText: 'Regenerate',
      okButtonProps: { danger: true },
      onOk,
    });
  };
  const {
    memo,
    markdown,
    setMarkdown,
    attachmentId,
    dirty,
    setDirty,
    linkFailed,
    existingLoaded,
    held,
    blockedNoReviewer,
    confirmAndRegenerate,
    onSave,
    retryLink,
    busy,
    generate,
    save,
    recordLink,
    openInWorkspace,
    navigate,
  } = useMemoComposerController(props, message, confirmReplacement);
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
              <Button key="relink" onClick={() => void retryLink()} loading={recordLink.isPending}>
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
          {generate.isPending ? (
            <>Generating a memo grounded in {clientName}&apos;s profile…</>
          ) : (
            'Loading the saved memo…'
          )}
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
              <Tooltip
                title={memo?.heldReason || 'The grounding auditor held this memo for review.'}
              >
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
            {memo && (
              <Text type="secondary" style={{ fontSize: 11 }}>
                {memo.usedTenantKey ? 'tenant key' : 'shared key'}
              </Text>
            )}
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
          {dirty && (
            <Text type="secondary" style={{ fontSize: 11 }}>
              Unsaved edits — Save to update the Document.
            </Text>
          )}
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
              <Text strong style={{ fontSize: 12 }}>
                Context used
              </Text>
              <Paragraph style={{ margin: '2px 0', fontSize: 11.5 }} type="secondary">
                {memo.memoryFilesUsed.join(', ')}
              </Paragraph>
            </div>
          ) : null}
          {memo?.contextExcluded?.length ? (
            <div>
              <Text strong style={{ fontSize: 12 }}>
                Context excluded
              </Text>
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
              <Text strong style={{ fontSize: 12 }}>
                Sources
              </Text>
              {memo.sources.map((s) => (
                <Paragraph
                  key={s.claimId}
                  style={{ margin: '2px 0', fontSize: 11.5 }}
                  type="secondary"
                >
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
